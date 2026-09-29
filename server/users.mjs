/**
 * User records.
 *
 * One JSON file, `data/users.json`, kept in the same temp-file + rename discipline as the
 * document store. A password hash never leaves this module: everything above it works with
 * the public projection (id, name, role, disabled, createdAt).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertName, assertPassword, hashPassword, nameKey, newUserId, verifyPassword } from './auth.mjs';
import { writeFileAtomic } from './store.mjs';

export const ROLE_USER = 'user';
export const ROLE_ADMIN = 'admin';

const PUBLIC_FIELDS = ['id', 'name', 'role', 'disabled', 'createdAt'];

export function publicUser(user) {
  if (!user) return null;
  const out = {};
  for (const field of PUBLIC_FIELDS) out[field] = user[field];
  return out;
}

export class Users {
  constructor(dataDir) {
    this.path = path.join(dataDir, 'users.json');
    this.byId = new Map();
    this.byKey = new Map();
    this.queue = Promise.resolve();
    this.loaded = null;
  }

  init() {
    if (!this.loaded) this.loaded = this.#load();
    return this.loaded;
  }

  async #load() {
    let body = { users: [] };
    try {
      body = JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const user of Array.isArray(body.users) ? body.users : []) {
      if (!user?.id || !user.name) continue;
      this.#index(user);
    }
    return this;
  }

  #index(user) {
    this.byId.set(user.id, user);
    this.byKey.set(nameKey(user.name), user);
  }

  get size() {
    return this.byId.size;
  }

  /** Open signup, with one exception: whoever walks in first runs the place. */
  async create({ name, password }) {
    const clean = assertName(name);
    if (this.byKey.has(nameKey(clean))) {
      const err = new Error('that name is taken');
      err.statusCode = 409;
      throw err;
    }
    assertPassword(password);
    const { salt, pass } = await hashPassword(password);
    const user = {
      id: newUserId(),
      name: clean,
      salt,
      pass,
      role: this.byId.size === 0 ? ROLE_ADMIN : ROLE_USER,
      disabled: false,
      createdAt: Date.now(),
    };
    this.#index(user);
    this.#save();
    return user;
  }

  /** Returns the user, or null. The caller cannot tell a wrong password from an unknown name. */
  async login({ name, password }) {
    const user = this.byKey.get(nameKey(String(name ?? '').trim()));
    if (!user) {
      await verifyPassword(String(password ?? ''), { salt: '00'.repeat(16), pass: '00'.repeat(64) }); // same shape of work either way
      return null;
    }
    return (await verifyPassword(String(password ?? ''), user)) && !user.disabled ? user : null;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  list() {
    return [...this.byId.values()]
      .map(publicUser)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /** Search for the share panel: only signed-in callers get here, and only by exact-ish name. */
  search(query, { limit = 10 } = {}) {
    const needle = nameKey(String(query ?? '').trim());
    if (!needle) return [];
    return [...this.byId.values()]
      .filter((user) => !user.disabled && nameKey(user.name).includes(needle))
      .slice(0, limit)
      .map(publicUser);
  }

  setRole(id, role) {
    const user = this.byId.get(id);
    if (!user) return null;
    if (![ROLE_USER, ROLE_ADMIN].includes(role)) {
      const err = new Error('unknown role');
      err.statusCode = 400;
      throw err;
    }
    // Demoting the last admin would leave the place with nobody who can promote anybody back.
    if (role === ROLE_USER && user.role === ROLE_ADMIN && this.#admins() <= 1) {
      const err = new Error('the last admin cannot be demoted');
      err.statusCode = 409;
      throw err;
    }
    user.role = role;
    this.#save();
    return publicUser(user);
  }

  setDisabled(id, disabled) {
    const user = this.byId.get(id);
    if (!user) return null;
    // An admin body is the only admin body: never let the last one be switched off.
    if (disabled && user.role === ROLE_ADMIN && this.#admins() <= 1) {
      const err = new Error('the last admin cannot be disabled');
      err.statusCode = 409;
      throw err;
    }
    user.disabled = Boolean(disabled);
    this.#save();
    return publicUser(user);
  }

  #admins() {
    return [...this.byId.values()].filter((user) => user.role === ROLE_ADMIN && !user.disabled).length;
  }

  #save() {
    const body = JSON.stringify({ users: [...this.byId.values()] }, null, 2);
    this.queue = this.queue.then(() => writeFileAtomic(this.path, body), () => writeFileAtomic(this.path, body));
    this.queue = this.queue.catch((err) => console.error('doc-online: user save failed:', err));
    return this.queue;
  }

  async flush() {
    await this.queue;
  }
}
