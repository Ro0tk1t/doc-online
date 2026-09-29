/**
 * Client-side collaboration session.
 *
 * The server is authoritative and orders every operation. Locally we keep the text
 * the server has confirmed (`revision`) plus the queue of our own edits that are
 * still in flight, and rebase that queue against every peer operation that lands in
 * the meantime. An `ack` carries the resulting document length so a drift caused by
 * a bug or a missed message turns into a resync instead of silent corruption.
 */

import { apply, makeEdit, transformPair } from '/shared/ot.mjs';

const PRESENCE_INTERVAL = 80;

export class Session extends EventTarget {
  constructor({ docId, clientId, linkViewOnly = false }) {
    super();
    this.docId = docId;
    this.clientId = clientId;
    // `?mode=view` only ever narrows what this tab may do; the server's `access` block is
    // what decides the rest, and it arrives with the first snapshot.
    this.linkViewOnly = linkViewOnly;
    this.viewOnly = linkViewOnly;
    this.access = null;
    this.revision = 0;
    this.text = '';
    this.files = [];
    this.pending = [];
    this.seq = 0;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.lastPresence = 0;
    this.selection = null;
  }

  get connected() {
    return this.ws?.readyState === 1;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ doc: this.docId, client: this.clientId });
    if (this.linkViewOnly) params.set('mode', 'view');
    this.ws = new WebSocket(`${scheme}://${location.host}/ws?${params}`);
    this.ws.onopen = () => {
      this.retry = 0;
      this.emit('status', { status: 'online' });
    };
    this.ws.onmessage = (event) => this.#onMessage(JSON.parse(event.data));
    this.ws.onclose = (event) => {
      // 4003 is "your rights do not cover this": a reconnect would be refused again.
      if (event.code === 4003) this.closed = true;
      this.emit('status', { status: 'offline' });
      if (!this.closed) this.#scheduleReconnect();
    };
    this.ws.onerror = () => this.emit('status', { status: 'error' });
  }

  #scheduleReconnect() {
    this.retry = Math.min(this.retry + 1, 6);
    const delay = 400 * 2 ** this.retry;
    setTimeout(() => {
      if (this.closed) return;
      this.pending = [];
      this.emit('status', { status: 'reconnecting' });
      this.connect();
    }, delay);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  send(payload) {
    if (this.connected) this.ws.send(JSON.stringify(payload));
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'doc':
      case 'stale':
        return this.#snapshot(msg, msg.type === 'stale');
      case 'op':
        return this.#remoteOp(msg);
      case 'ack':
        return this.#ack(msg);
      case 'files':
        this.files = msg.files ?? [];
        return this.emit('files', { files: this.files });
      case 'users':
        return this.emit('users', { users: msg.users });
      case 'title':
        return this.emit('title', { title: msg.title });
      case 'kicked':
        this.closed = true;
        return this.emit('kicked', {});
      case 'error':
        // An access refusal is final, so stop the reconnect loop and let the page show the way out.
        if (msg.code === 'need_login' || msg.code === 'forbidden') this.closed = true;
        return this.emit('error', { message: msg.message, code: msg.code });
      default:
        return undefined;
    }
  }

  #snapshot(msg, isStale) {
    const local = this.text;
    this.revision = msg.revision;
    this.pending = [];
    this.text = msg.text;
    this.files = msg.files ?? this.files;
    const moved = this.#applyAccess(msg.access);
    this.emit('doc', {
      title: msg.title,
      text: msg.text,
      revision: msg.revision,
      files: this.files,
      users: msg.users,
      isStale,
      reason: msg.reason,
      accessChanged: moved,
      carried: isStale && local && local !== msg.text ? makeEdit(msg.text, local) : null,
    });
  }

  /**
   * The server sends its answer about my rights with every snapshot, so a share change that
   * happens while I am typing reaches the surface instead of turning into refused edits.
   */
  #applyAccess(access) {
    if (!access) return false;
    const before = this.access;
    this.access = access;
    this.viewOnly = !access.canEdit;
    if (!before) return true;
    return before.role !== access.role || before.canEdit !== access.canEdit || before.canManage !== access.canManage;
  }

  #remoteOp(msg) {
    let op = msg.op;
    if (this.pending.length) {
      this.pending = this.pending.map((entry) => {
        const [mine, theirs] = transformPair(entry.op, op);
        op = theirs;
        return { ...entry, op: mine };
      });
    }
    try {
      this.text = apply(this.text, op);
    } catch (err) {
      this.send({ type: 'resync' });
      return;
    }
    this.revision = msg.revision;
    this.emit('text', { op, origin: msg.from, revision: msg.revision });
  }

  #ack(msg) {
    const index = this.pending.findIndex((entry) => entry.seq === msg.seq);
    if (index >= 0) this.pending.splice(0, index + 1);
    this.revision = Math.max(this.revision, msg.revision);
    if (!this.pending.length && this.text.length !== msg.length) {
      this.send({ type: 'resync' });
    }
    this.emit('ack', { revision: this.revision, pending: this.pending.length });
  }

  /** Record an edit the caller already applied to their own view of the text. */
  localEdit(before, after) {
    if (this.viewOnly || before === after) return null;
    const op = makeEdit(before, after);
    this.pending.push({ seq: ++this.seq, op });
    this.text = after;
    this.send({ type: 'edit', seq: this.seq, baseRevision: this.revision + this.pending.length - 1, op });
    return op;
  }

  setSelection(selection, typing = false) {
    this.selection = selection;
    const now = Date.now();
    if (!typing && now - this.lastPresence < PRESENCE_INTERVAL) return;
    this.lastPresence = now;
    this.send({ type: 'presence', selection, typing });
  }

  /** Stable in-document reference to an attachment. Kept short: it lives in the source. */
  urlFor(file) {
    return `/files/${this.docId}/${file.id}`;
  }

  /** PUT raw bytes to the attachment endpoint; peers learn about it over the socket. */
  async upload(file) {
    const params = new URLSearchParams({ name: file.name, type: file.type });
    const url = `/api/docs/${this.docId}/files?${params}`;
    const res = await fetch(url, { method: 'PUT', body: file, credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `upload failed (HTTP ${res.status})`);
    return body.file;
  }

  async removeFile(fileId) {
    const res = await fetch(
      `/api/docs/${this.docId}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', credentials: 'same-origin' },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `delete failed (HTTP ${res.status})`);
    return body.files;
  }

  rename(title) {
    this.send({ type: 'title', title });
  }
}
