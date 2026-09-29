/**
 * The share panel: one document's visibility and its list of people.
 *
 * The server owns this answer, so the panel is a thin editor for `PUT /api/docs/:id/access`:
 * it loads the current list, sends a whole new one back, and re-renders from the response.
 * Nothing here decides whether the buttons get shown -- the page asks `canManage`.
 */

const el = (id) => document.getElementById(id);

async function call(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `request failed (HTTP ${res.status})`);
    err.code = body.code;
    throw err;
  }
  return body;
}

export class Sharing {
  constructor({ docId, notify }) {
    this.docId = docId;
    this.notify = notify;
    this.panel = el('share-panel');
    this.grants = el('share-grants');
    this.visibility = el('share-visibility');
    this.note = el('share-note');
    this.access = null;

    el('share-open').addEventListener('click', () => this.toggle());
    el('share-close').addEventListener('click', () => this.open(false));
    this.visibility.addEventListener('change', () => this.save({ visibility: this.visibility.value }));
    el('share-add').addEventListener('click', () => this.#add());
    el('share-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.#add();
    });
    this.grants.addEventListener('change', (event) => {
      const entry = this.#entryFor(event.target);
      if (entry) this.save({ grants: this.grantsList().map((g) => (g.user === entry.user ? { ...g, role: event.target.value } : g)) });
    });
    this.grants.addEventListener('click', (event) => {
      const entry = this.#entryFor(event.target);
      if (event.target.dataset.act === 'remove' && entry) {
        this.save({ grants: this.grantsList().filter((g) => g.user !== entry.user) });
      }
    });
    document.addEventListener('click', (event) => {
      if (this.panel.hidden) return;
      if (this.panel.contains(event.target) || event.target.closest('#share-open')) return;
      this.open(false);
    });
  }

  /** Grants live in the access block; the panel never keeps its own copy of the list. */
  grantsList() {
    return this.access?.grants ?? [];
  }

  #entryFor(node) {
    const row = node.closest?.('li');
    const id = row?.dataset.user;
    return id ? this.grantsList().find((entry) => entry.user === id) : null;
  }

  open(on = true) {
    this.panel.hidden = !on;
    if (on) this.refresh();
  }

  toggle() {
    this.open(this.panel.hidden);
  }

  /** Called whenever the server's answer about my rights changes. */
  setAccess(access) {
    this.access = access;
    el('share-open').hidden = !access?.canManage;
    if (this.panel.hidden) return;
    this.render();
  }

  async refresh() {
    try {
      this.setAccess((await call(`/api/docs/${this.docId}/access`)).access);
    } catch (err) {
      this.say(err.message);
    }
  }

  async save(patch) {
    const body = { visibility: this.visibility.value, grants: this.grantsList(), ...patch };
    try {
      const { access } = await call(`/api/docs/${this.docId}/access`, { method: 'PUT', body: JSON.stringify(body) });
      // The socket answer is the one that matters for my own surface, so this call only needs
      // to keep the panel honest; peers hear about it through `accessChanged`.
      this.setAccess(access);
      this.say(access.visibility === 'public' ? 'Public: anyone can read it, signing in is needed to edit.' : 'Private: only the people on this list.');
    } catch (err) {
      this.notify(err.message, 'warn');
      this.refresh();
    }
  }

  async #add() {
    const input = el('share-name');
    const wanted = input.value.trim();
    if (!wanted) return;
    const { users } = await call(`/api/users?q=${encodeURIComponent(wanted)}`).catch((err) => {
      this.notify(err.message, 'warn');
      return { users: [] };
    });
    const match = users.find((user) => user.name.toLowerCase() === wanted.toLowerCase());
    if (!match) return this.notify(`No account named “${wanted}”. Names must match exactly.`, 'warn');
    if (this.grantsList().some((entry) => entry.user === match.id)) return this.notify(`${match.name} is already on the list.`, 'info');
    input.value = '';
    await this.save({ grants: [...this.grantsList(), { user: match.id, role: el('share-role').value }] });
  }

  say(text) {
    this.note.textContent = text ?? '';
    this.note.hidden = !text;
  }

  render() {
    if (!this.access) return;
    this.visibility.value = this.access.visibility;
    const rows = [];

    const owner = document.createElement('li');
    owner.className = 'grant owner';
    owner.append(
      Object.assign(document.createElement('span'), { className: 'grant-name', textContent: this.access.ownerName ?? '(unknown)' }),
      Object.assign(document.createElement('span'), { className: 'muted', textContent: 'owner' }),
    );
    rows.push(owner);

    for (const entry of this.grantsList()) {
      const li = document.createElement('li');
      li.dataset.user = entry.user;
      const name = Object.assign(document.createElement('span'), { className: 'grant-name', textContent: entry.name ?? '(removed account)' });
      const role = document.createElement('select');
      for (const value of ['editor', 'viewer']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'editor' ? 'can edit' : 'can read';
        option.selected = entry.role === value;
        role.append(option);
      }
      const remove = Object.assign(document.createElement('button'), { className: 'tiny danger', textContent: 'remove' });
      remove.dataset.act = 'remove';
      li.append(name, role, remove);
      rows.push(li);
    }

    const none = document.createElement('li');
    none.className = 'muted';
    none.textContent = this.grantsList().length ? '' : 'Nobody else yet.';
    this.grants.replaceChildren(...rows, ...(this.grantsList().length ? [] : [none]));
  }
}
