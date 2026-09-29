/**
 * WebSocket hub: connection bookkeeping, the wire protocol, and fan-out.
 *
 * The wire format is a small JSON envelope, one message type per intent:
 *
 *   client -> server  edit {seq, baseRevision, op} | presence {selection, typing}
 *                     title {title} | resync | ping
 *   server -> client  doc (snapshot, incl. files and my access) | ack {seq, revision, length}
 *                     op (peer edit) | users | title | files | stale {…} | kicked | error
 *
 * Every snapshot carries the reading this socket has of the document, because two people can
 * look at the same room with different rights. The client never decides its own permissions.
 *
 * Attachments travel out of band: bytes go over the REST endpoint, and the hub only
 * fans out the resulting metadata list.
 */

import { canEdit, canManage, roleFor } from './access.mjs';
import { NotFound, Rejected, Room } from './room.mjs';
import { assertDocId, assertTitle } from './store.mjs';

const CLIENT_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const PALETTE = [
  '#e5484d',
  '#3e63dd',
  '#12a594',
  '#d97706',
  '#8e4ec6',
  '#00a2c7',
  '#e93d82',
  '#46a758',
];

export function colorFor(clientId) {
  let h = 0;
  for (const ch of clientId) h = (h * 31 + ch.codePointAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function cleanName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const trimmed = name.replace(/[\r\n]+/g, ' ').trim();
  return (trimmed || fallback).slice(0, 32);
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export class Hub {
  constructor(store, { createMissing = false } = {}) {
    this.store = store;
    this.createMissing = createMissing;
    this.rooms = new Map();
  }

  roomFor(docId) {
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Room(this.store, docId, this.createMissing ? 'Untitled document' : null);
      this.rooms.set(docId, room);
    }
    return room;
  }

  getRoom(docId) {
    return this.rooms.get(docId) ?? null;
  }

  dropRoom(docId, code = 1000, reason = '') {
    const room = this.rooms.get(docId);
    if (!room) return false;
    for (const client of room.clients.values()) {
      try {
        client.ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    this.rooms.delete(docId);
    return true;
  }

  snapshot(docId) {
    try {
      return this.roomFor(docId).snapshot();
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  /** Read-only view of the live text plus revision, used by the HTTP API. */
  state(docId) {
    const room = this.rooms.get(docId);
    return room ? { text: room.text, revision: room.revision } : null;
  }

  peers(docId) {
    return this.rooms.get(docId)?.presence() ?? [];
  }

  attach(ws, params, viewer = null) {
    const docId = params.get('doc');
    const clientId = params.get('client');
    if (!docId || !clientId || !CLIENT_ID.test(clientId)) {
      send(ws, { type: 'error', message: 'a ?doc= and ?client= id are required' });
      ws.close(1008, 'bad request');
      return;
    }
    let room;
    try {
      room = this.roomFor(docId);
    } catch (err) {
      send(ws, { type: 'error', code: 'not_found', message: err.message });
      ws.close(1008, 'no such document');
      return;
    }

    const role = roleFor(room.doc, viewer);
    if (!role) {
      // 4003 says "your rights do not cover this", which is a reason to stop reconnecting.
      send(ws, {
        type: 'error',
        code: viewer ? 'forbidden' : 'need_login',
        message: viewer ? 'you do not have access to this document' : 'sign in to open this document',
      });
      ws.close(4003, viewer ? 'forbidden' : 'login required');
      return;
    }

    const prior = room.clients.get(clientId);
    if (prior) {
      send(prior.ws, { type: 'kicked' });
      try {
        prior.ws.close(4000, 'replaced by a newer tab');
      } catch {
        /* already closing */
      }
    }
    const client = {
      clientId,
      // A signed-in peer is named by their account, never by the query string: an identity you
      // get to type is an identity you get to fake.
      name: viewer
        ? cleanName(viewer.name, 'Anonymous')
        : cleanName(params.get('name'), `Guest ${clientId.slice(0, 4)}`),
      color: colorFor(clientId),
      // ?mode=view is still honoured, so a read-only link stays read-only for an editor too.
      intent: params.get('mode') === 'view' ? 'view' : 'edit',
      viewer,
      docRole: role,
      role: canEdit(role) && params.get('mode') !== 'view' ? 'editor' : 'viewer',
      selection: null,
      typing: false,
      ws,
    };
    room.join(client);

    this.#snapshotTo(room, client, 'doc');
    this.#announce(room);

    ws.on('message', (raw) => this.#onMessage(ws, room, client, raw));
    ws.on('close', () => {
      if (room.clients.get(clientId) !== client) return;
      room.leave(clientId);
      this.#announce(room);
      if (room.clients.size === 0) this.rooms.delete(room.id);
    });
  }

  #onMessage(ws, room, client, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { type: 'error', message: 'expected a JSON message' });
    }
    if (!msg || typeof msg.type !== 'string') return;

    try {
      switch (msg.type) {
        case 'edit':
          return this.#edit(room, client, msg);
        case 'presence':
          return this.#presence(room, client, msg);
        case 'title':
          return this.#rename(room, client, msg.title);
        case 'resync':
          return this.#snapshotTo(room, client, 'doc');
        case 'ping':
          return send(ws, { type: 'pong', at: msg.at });
        default:
          return send(ws, { type: 'error', message: `unknown message type ${msg.type}` });
      }
    } catch (err) {
      if (err instanceof Rejected) {
        if (err.resync) return this.#snapshotTo(room, client, 'stale', err.message);
        return send(ws, { type: 'error', message: err.message });
      }
      console.error('doc-online: message handler failed:', err);
      return send(ws, { type: 'error', message: 'handler failed' });
    }
  }

  #edit(room, client, msg) {
    if (client.role === 'viewer') {
      throw new Rejected(client.intent === 'view' ? 'view-only links cannot edit' : 'this document is read-only for you');
    }
    const entry = room.commit(client.clientId, msg.seq, msg.baseRevision, msg.op);
    send(client.ws, { type: 'ack', seq: msg.seq, revision: entry.revision, length: room.text.length });
    this.#broadcast(room, client, { type: 'op', from: client.clientId, revision: entry.revision, op: entry.op });
  }

  #presence(room, client, msg) {
    const sel = msg.selection;
    const max = room.text.length;
    client.selection =
      sel && Number.isFinite(sel.start) && Number.isFinite(sel.end)
        ? { start: clamp(sel.start, 0, max), end: clamp(sel.end, 0, max) }
        : null;
    client.typing = Boolean(msg.typing);
    this.#announce(room);
  }

  #rename(room, client, title) {
    if (client.role === 'viewer') {
      throw new Rejected(client.intent === 'view' ? 'view-only links cannot rename' : 'only an editor can rename this document');
    }
    const next = assertTitle(title);
    if (!room.setTitle(next)) return;
    this.#broadcast(room, null, { type: 'title', title: next });
  }

  #announce(room) {
    this.#broadcast(room, null, { type: 'users', users: room.presence() });
  }

  #broadcast(room, except, payload) {
    for (const peer of room.clients.values()) {
      if (peer !== except) send(peer.ws, payload);
    }
  }

  /** Tell everyone in an open room that its attachment list changed. */
  filesChanged(docId, list) {
    const room = this.rooms.get(assertDocId(docId));
    if (room) this.#broadcast(room, null, { type: 'files', files: list ?? [] });
  }

  /**
   * The share list or the visibility changed: every open socket re-reads its own rights.
   * Someone who lost access is disconnected; everyone else gets a fresh snapshot, marked
   * `stale` so the client drops its unacknowledged edits and repaints with the new role.
   */
  accessChanged(docId) {
    const room = this.rooms.get(assertDocId(docId));
    if (!room) return;
    const doc = this.store.get(room.id);
    if (doc) room.doc = doc;
    for (const client of [...room.clients.values()]) {
      const role = roleFor(room.doc, client.viewer);
      if (!role) {
        room.leave(client.clientId);
        send(client.ws, { type: 'error', code: 'forbidden', message: 'you no longer have access to this document' });
        try {
          client.ws.close(4003, 'access revoked');
        } catch {
          /* already closing */
        }
        continue;
      }
      client.docRole = role;
      client.role = canEdit(role) && client.intent !== 'view' ? 'editor' : 'viewer';
      this.#snapshotTo(room, client, 'stale', 'sharing changed');
    }
    this.#announce(room);
  }

  /** A full snapshot for one socket: the document is shared, the reading of it is not. */
  #snapshotTo(room, client, type, reason) {
    send(client.ws, {
      type,
      ...room.snapshot(),
      access: rightsOf(client),
      users: room.presence(),
      ...(reason ? { reason } : {}),
    });
  }

  /** Push a snapshot-style change made through the HTTP API into open rooms. */
  refresh(docId) {
    const room = this.rooms.get(docId);
    if (!room) return;
    const doc = this.store.get(docId);
    room.doc = doc;
    room.opLog = [];
    for (const client of room.clients.values()) {
      const role = roleFor(doc, client.viewer);
      client.docRole = role;
      client.role = canEdit(role) && client.intent !== 'view' ? 'editor' : 'viewer';
      this.#snapshotTo(room, client, 'stale', 'document reloaded on the server');
    }
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(Math.trunc(n), max));
}

/** The access block one socket is allowed to know about itself. */
function rightsOf(client) {
  return {
    role: client.docRole,
    // `canEdit` is what this socket may do: a document role of editor plus a read-only link
    // still means no writes, and the client must not have to work that out itself.
    canEdit: client.role === 'editor',
    canManage: canManage(client.docRole),
    intent: client.intent,
  };
}
