/**
 * A Room is one open document plus the peers editing it.
 *
 * The server is the single point of ordering: clients send operations tagged with
 * the revision they were built against, and the room rebases each one onto every
 * operation that landed in the meantime. That keeps the OT engine in one place and
 * means a client only has to reconcile its own unacknowledged edits.
 */

import { apply, baseLength, transform, transformPosition } from '../shared/ot.mjs';

const OP_LOG_LIMIT = 512;
const MAX_OPS_PER_EDIT = 512;
const MAX_INSERT_PER_EDIT = 100_000;

export class Rejected extends Error {
  constructor(message, { resync = false } = {}) {
    super(message);
    this.resync = resync;
  }
}

export class NotFound extends Error {}

export class Room {
  /**
   * @param titleForNewDoc title to give the document when it does not exist yet,
   *   or nothing to fail instead of creating.
   */
  constructor(store, id, titleForNewDoc) {
    this.store = store;
    this.id = id;
    this.clients = new Map();
    this.opLog = [];
    this.doc = store.get(id);
    if (!this.doc) {
      if (!titleForNewDoc) throw new NotFound(`document ${id} does not exist`);
      this.doc = store.create({ id, title: titleForNewDoc, text: '' });
    }
  }

  get title() {
    return this.doc.title;
  }

  get text() {
    return this.doc.text;
  }

  get revision() {
    return this.doc.revision;
  }

  join(client) {
    this.clients.set(client.clientId, client);
    return client;
  }

  leave(clientId) {
    this.clients.delete(clientId);
  }

  snapshot() {
    return {
      id: this.id,
      title: this.doc.title,
      text: this.doc.text,
      revision: this.doc.revision,
      files: this.doc.files ?? [],
      updatedAt: this.doc.updatedAt,
      owner: this.doc.owner ?? null,
      visibility: this.doc.visibility === 'public' ? 'public' : 'private',
    };
  }

  presence() {
    return [...this.clients.values()].map(({ clientId, name, color, selection, typing, role }) => ({
      clientId,
      name,
      color,
      selection,
      typing,
      role,
    }));
  }

  /**
   * Rebase `op` onto the room's current revision and commit it.
   * Returns the committed entry, or throws Rejected when the client is too far
   * behind for the server to repair the operation on its own.
   */
  commit(clientId, seq, baseRevision, op) {
    if (baseRevision == null || typeof baseRevision !== 'number') {
      throw new Rejected('baseRevision must be a number');
    }
    if (baseRevision > this.revision) throw new Rejected('baseRevision is in the future');
    if (baseRevision < this.revision - this.opLog.length) {
      throw new Rejected('edit is older than the server operation log', { resync: true });
    }
    if (!Array.isArray(op) || op.length > MAX_OPS_PER_EDIT) {
      throw new Rejected(`op must be an array of at most ${MAX_OPS_PER_EDIT} components`);
    }
    if (op.reduce((n, c) => n + (typeof c?.insert === 'string' ? c.insert.length : 0), 0) > MAX_INSERT_PER_EDIT) {
      throw new Rejected('op inserts too much text at once');
    }

    let rebased;
    try {
      rebased = op;
      for (let i = baseRevision - (this.revision - this.opLog.length); i < this.opLog.length; i += 1) {
        rebased = transform(rebased, this.opLog[i].op, false);
      }
      if (baseLength(rebased) !== this.text.length) {
        throw new Error(`operation covers ${baseLength(rebased)} chars, document has ${this.text.length}`);
      }
      this.doc.text = apply(this.doc.text, rebased);
    } catch (err) {
      if (err instanceof Rejected) throw err;
      throw new Rejected(`rejected operation: ${err.message}`, { resync: true });
    }

    this.doc.revision += 1;
    const entry = { clientId, seq, op: rebased, revision: this.doc.revision };
    this.opLog.push(entry);
    if (this.opLog.length > OP_LOG_LIMIT) this.opLog.splice(0, this.opLog.length - OP_LOG_LIMIT);
    this.#followCursors(clientId, rebased);
    this.store.update(this.id, (doc) => {
      doc.text = this.doc.text;
      doc.revision = this.doc.revision;
    });
    return entry;
  }

  setTitle(title) {
    const changed = this.doc.title !== title;
    this.doc.title = title;
    if (changed) this.store.update(this.id, (doc) => (doc.title = title));
    return changed;
  }

  #followCursors(authorId, op) {
    for (const client of this.clients.values()) {
      if (client.clientId === authorId || !client.selection) continue;
      const { start, end } = client.selection;
      client.selection = {
        start: transformPosition(op, start),
        end: transformPosition(op, end),
      };
    }
  }
}
