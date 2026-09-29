/**
 * JSON-file document store.
 *
 * Every document lives in its own file under `data/docs/<id>.json` plus a small
 * `data/index.json` catalogue, so a checkout stays reviewable in git. Writes are
 * serialised per document and go through a temp file + rename, which means a crash
 * mid-save can never leave a half-written document behind.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function assertDocId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    const err = new Error('invalid document id');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export function assertText(text, maxChars = 500_000) {
  if (typeof text !== 'string') {
    const err = new Error('text must be a string');
    err.statusCode = 400;
    throw err;
  }
  if (text.length > maxChars) {
    const err = new Error(`document exceeds ${maxChars} characters`);
    err.statusCode = 413;
    throw err;
  }
  return text;
}

export function assertTitle(title, maxChars = 200) {
  const cleaned = typeof title === 'string' ? title.replace(/[\r\n]+/g, ' ').trim() : '';
  if (!cleaned) {
    const err = new Error('title is required');
    err.statusCode = 400;
    throw err;
  }
  return cleaned.slice(0, maxChars);
}

/** An access record read off disk: anything malformed degrades to "private, nobody shared it". */
export function normalizeAccess(doc) {
  const grants = Array.isArray(doc.grants)
    ? doc.grants
        .filter((entry) => typeof entry?.user === 'string' && ['editor', 'viewer'].includes(entry.role))
        .map((entry) => ({ user: entry.user, role: entry.role }))
    : [];
  return {
    owner: typeof doc.owner === 'string' ? doc.owner : null,
    visibility: doc.visibility === 'public' ? 'public' : 'private',
    grants,
  };
}

/** Temp file in, rename after: a crash can never leave a half-written file behind. */
export async function writeFileAtomic(target, body) {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, target);
}

export class Store {
  constructor(dataDir) {
    this.root = path.resolve(dataDir);
    this.docsDir = path.join(this.root, 'docs');
    this.indexPath = path.join(this.root, 'index.json');
    this.docs = new Map();
    this.queue = new Map();
    this.loaded = null;
  }

  init() {
    if (!this.loaded) {
      this.loaded = this.#load();
    }
    return this.loaded;
  }

  async #load() {
    await fs.mkdir(this.docsDir, { recursive: true });
    let index = { docs: [] };
    try {
      index = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const entry of index.docs ?? []) {
      try {
        const raw = await fs.readFile(path.join(this.docsDir, `${entry.id}.json`), 'utf8');
        const doc = JSON.parse(raw);
        this.docs.set(doc.id, {
          ...doc,
          ...normalizeAccess(doc),
          files: Array.isArray(doc.files) ? doc.files : [],
          updatedAt: doc.updatedAt ?? Date.now(),
        });
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`doc-online: skipping unreadable document ${entry.id}:`, err.message);
      }
    }
    return this;
  }

  list() {
    return [...this.docs.values()]
      .map(({ id, title, revision, files, createdAt, updatedAt, owner, visibility, grants }) => ({
        id,
        title,
        revision,
        fileCount: (files ?? []).length,
        createdAt,
        updatedAt,
        owner,
        visibility,
        grants,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.docs.get(assertDocId(id)) ?? null;
  }

  create({ title, text = '', id = newId(), owner = null }) {
    const now = Date.now();
    const doc = {
      id: assertDocId(id),
      title: assertTitle(title),
      text: assertText(text),
      revision: 0,
      files: [],
      owner: typeof owner === 'string' ? owner : null,
      visibility: 'private',
      grants: [],
      createdAt: now,
      updatedAt: now,
    };
    this.docs.set(doc.id, doc);
    this.#persist(doc.id);
    return doc;
  }

  /** Replace a document's visibility and share list. The caller has already checked authority. */
  setAccess(id, { visibility, grants }) {
    const doc = this.get(id);
    if (!doc) return null;
    if (visibility !== undefined) doc.visibility = visibility;
    if (grants !== undefined) doc.grants = grants;
    doc.updatedAt = Date.now();
    this.#persist(doc.id);
    return doc;
  }

  remove(id) {
    assertDocId(id);
    const existed = this.docs.delete(id);
    this.queue.set(id, this.queue.get(id) ?? Promise.resolve());
    this.#enqueue(id, async () => {
      await fs.rm(path.join(this.docsDir, `${id}.json`), { force: true });
      await this.#writeIndex();
    });
    return existed;
  }

  /** Apply a mutation to a document and schedule its save. */
  update(id, mutate) {
    const doc = this.get(id);
    if (!doc) return null;
    const before = { text: doc.text, title: doc.title };
    mutate(doc);
    try {
      doc.text = assertText(doc.text);
      doc.title = assertTitle(doc.title);
    } catch (err) {
      Object.assign(doc, before);
      throw err;
    }
    doc.updatedAt = Date.now();
    this.#persist(doc.id);
    return doc;
  }

  /** Record an uploaded attachment; the bytes themselves live in the Files store. */
  addFile(id, meta) {
    const doc = this.get(id);
    if (!doc) return null;
    const files = [...(doc.files ?? []), meta];
    this.update(id, (target) => (target.files = files));
    return files;
  }

  /** Drop an attachment record and return what is left. */
  removeFile(id, fileId) {
    const doc = this.get(id);
    if (!doc) return null;
    const files = (doc.files ?? []).filter((entry) => entry.id !== fileId);
    this.update(id, (target) => (target.files = files));
    return files;
  }

  #persist(id) {
    this.#enqueue(id, async () => {
      const doc = this.docs.get(id);
      if (!doc) return this.#writeIndex();
      await writeFileAtomic(path.join(this.docsDir, `${id}.json`), JSON.stringify(doc, null, 2));
      await this.#writeIndex();
    });
    return this;
  }

  async #writeIndex() {
    const body = JSON.stringify({ docs: this.list() }, null, 2);
    await writeFileAtomic(this.indexPath, body);
  }

  #enqueue(id, task) {
    const prev = this.queue.get(id) ?? Promise.resolve();
    const next = prev.then(task, task).catch((err) => console.error('doc-online: save failed:', err));
    this.queue.set(id, next);
    return next;
  }

  /** Resolve every queued write; used by tests and graceful shutdown. */
  async flush() {
    while (this.queue.size) {
      const pending = [...this.queue.values()];
      this.queue.clear();
      await Promise.all(pending);
    }
  }
}
