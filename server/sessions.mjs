/**
 * Server-side sessions.
 *
 * The cookie holds an opaque random token, nothing else, so a session cannot be forged or
 * read client-side, and revoking one is a delete rather than waiting for a signature to
 * expire. The ledger is `data/sessions.json`; a restart therefore keeps people signed in,
 * which is what a document tool should do.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SESSION_TTL, newToken } from './auth.mjs';
import { writeFileAtomic } from './store.mjs';

export class Sessions {
  constructor(dataDir, { ttl = SESSION_TTL, now = Date.now } = {}) {
    this.path = path.join(dataDir, 'sessions.json');
    this.ttl = ttl;
    this.now = now;
    this.byToken = new Map();
    this.queue = Promise.resolve();
    this.loaded = null;
  }

  init() {
    if (!this.loaded) this.loaded = this.#load();
    return this.loaded;
  }

  async #load() {
    let body = { sessions: [] };
    try {
      body = JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const now = this.now();
    for (const entry of Array.isArray(body.sessions) ? body.sessions : []) {
      if (!entry?.token || !entry.userId) continue;
      if (now - entry.createdAt >= this.ttl) continue; // expired records are dropped, not loaded
      this.byToken.set(entry.token, entry);
    }
    return this;
  }

  create(userId) {
    const token = newToken();
    this.byToken.set(token, { token, userId, createdAt: this.now() });
    this.#save();
    return token;
  }

  /** Token -> userId, or null when it never existed or has aged out. */
  resolve(token) {
    if (!token) return null;
    const entry = this.byToken.get(token);
    if (!entry) return null;
    if (this.now() - entry.createdAt >= this.ttl) {
      this.byToken.delete(token);
      this.#save();
      return null;
    }
    return entry.userId;
  }

  drop(token) {
    const existed = this.byToken.delete(token);
    if (existed) this.#save();
    return existed;
  }

  /** Every session of one account: used on logout-everywhere, disable and password change. */
  dropForUser(userId) {
    let count = 0;
    for (const [token, entry] of this.byToken) {
      if (entry.userId === userId) {
        this.byToken.delete(token);
        count += 1;
      }
    }
    if (count) this.#save();
    return count;
  }

  get size() {
    return this.byToken.size;
  }

  #save() {
    const body = JSON.stringify({ sessions: [...this.byToken.values()] }, null, 2);
    this.queue = this.queue.then(() => writeFileAtomic(this.path, body), () => writeFileAtomic(this.path, body));
    this.queue = this.queue.catch((err) => console.error('doc-online: session save failed:', err));
    return this.queue;
  }

  async flush() {
    await this.queue;
  }
}
