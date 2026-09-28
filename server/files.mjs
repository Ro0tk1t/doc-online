/**
 * Attachment storage.
 *
 * A file is stored under data/attachments/<docId>/<fileId> with no extension: the id is
 * random, and the uploaded filename is kept only in the document's metadata. That means
 * user input never reaches a filesystem path -- the path is built exclusively from two
 * pattern-checked ids.
 *
 * Serving is deliberately conservative. Only a small allowlist of types may render inline
 * (images and PDF); everything else is downloaded as application/octet-stream, which keeps
 * an uploaded .html or .svg from executing on our own origin.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertDocId, newId, writeFileAtomic } from './store.mjs';

const FILE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_DOC = 50;

const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'application/pdf',
  'text/plain',
]);

function fail(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function assertFileId(id) {
  if (typeof id !== 'string' || !FILE_ID.test(id)) throw fail('invalid file id', 400);
  return id;
}

/** Strip anything path-like or markup-ish from an uploaded filename. */
export function cleanName(name) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>"']/g, '')
    .trim();
  return (base || 'file').slice(0, 120);
}

export function serveType(declared) {
  const type = String(declared ?? '').toLowerCase().split(';')[0].trim();
  return INLINE_TYPES.has(type) ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

export function disposition(name, inline) {
  const ascii = cleanName(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, "'");
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii || 'file'}"; filename*=UTF-8''${encodeURIComponent(cleanName(name))}`;
}

export class Files {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
  }

  docDir(docId) {
    return path.join(this.root, assertDocId(docId));
  }

  pathOf(docId, fileId) {
    return path.join(this.docDir(docId), assertFileId(fileId));
  }

  /** Write the bytes and return the metadata row to attach to the document. */
  async put(docId, { name, type, bytes, by = '' }) {
    if (!Buffer.isBuffer(bytes)) throw fail('file body must be read first', 400);
    if (!bytes.length) throw fail('refusing to store an empty file', 400);
    if (bytes.length > MAX_FILE_BYTES) throw fail(`file exceeds ${MAX_FILE_BYTES} bytes`, 413);
    const id = newId();
    const target = this.pathOf(docId, id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, bytes);
    return { id, name: cleanName(name), type: String(type ?? '').slice(0, 100), size: bytes.length, at: Date.now(), by };
  }

  async stat(docId, fileId) {
    const info = await fs.stat(this.pathOf(docId, fileId)).catch(() => null);
    return info?.isFile() ? info : null;
  }

  async remove(docId, fileId) {
    await fs.rm(this.pathOf(docId, fileId), { force: true });
  }

  async removeAll(docId) {
    await fs.rm(this.docDir(docId), { recursive: true, force: true });
  }
}
