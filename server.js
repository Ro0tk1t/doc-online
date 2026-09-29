#!/usr/bin/env node
/**
 * doc-online server: static files, a small document REST API, and the WebSocket
 * collaboration endpoint. No framework on purpose -- everything here is readable
 * top to bottom.
 */

import { createServer as createHttpServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub } from './server/hub.mjs';
import { Store, assertDocId, assertText, assertTitle } from './server/store.mjs';
import { Files, MAX_FILE_BYTES, MAX_FILES_PER_DOC, assertFileId, disposition, serveType } from './server/files.mjs';
import { exportDocument, requestBaseUrl } from './server/export.mjs';
import { Users, publicUser } from './server/users.mjs';
import { Sessions } from './server/sessions.mjs';
import {
  COOKIE_NAME,
  Throttle,
  assertSameOrigin,
  cookieHeader,
  logoutHeader,
  parseCookies,
} from './server/auth.mjs';
import { accessOf, assertGrants, assertVisibility, requireRole, visibleTo } from './server/access.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 1024 * 1024;

const STATIC_ROOTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function httpError(res, err) {
  const status = err.statusCode ?? (err.code === 'ETOOLONG' ? 413 : 500);
  const body = { error: err.message ?? 'internal error' };
  // An access refusal carries a machine-readable code, so the page can react ("sign in")
  // without matching on the wording of a message.
  if (err.statusCode && err.code && err.code !== 'ETOOLONG') body.code = err.code;
  json(res, status, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('request body too large');
        err.code = 'ETOOLONG';
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const err = new Error('request body is not valid JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Read a binary request body, refusing anything past the limit before buffering it. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const fail = (message) => {
      const err = new Error(message);
      err.statusCode = 413;
      req.destroy();
      reject(err);
    };
    if (Number(req.headers['content-length'] ?? 0) > limit) return fail(`upload exceeds ${limit} bytes`);
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(`upload exceeds ${limit} bytes`);
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const route = STATIC_ROOTS.find((root) => pathname.startsWith(root.prefix));
  if (!route) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const rel = decodeURIComponent(pathname.slice(route.prefix.length));
  const target = path.join(route.dir, rel);
  if (!target.startsWith(route.dir + path.sep)) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error('not found'), { statusCode: 404 });
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

/** Stream an attachment. The path is built from two validated ids, never from the name. */
async function serveFile(req, res, pathname, { store, files, users, sessions }) {
  const bits = pathname.split('/').filter(Boolean); // ['files', docId, fileId, name?]
  if (bits.length < 3 || bits.length > 4) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const docId = assertDocId(bits[1]);
  const fileId = assertFileId(bits[2]);
  const doc = store.get(docId);
  if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 });
  requireRole(doc, viewerFor(req, { users, sessions }), 'read');
  const meta = (doc.files ?? []).find((entry) => entry.id === fileId);
  const info = meta && (await files.stat(docId, fileId));
  if (!meta || !info) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const { type, inline } = serveType(meta.type);
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'content-disposition': disposition(meta.name, inline),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  createReadStream(files.pathOf(docId, fileId)).pipe(res);
}

/** Login state for the response: one cookie header, built from the token the session store just minted. */
function setSession(res, req, token) {
  res.setHeader('set-cookie', cookieHeader(token, req));
  return token;
}

export async function createServer({ dataDir = path.join(ROOT, 'data'), port = 0 } = {}) {
  const store = new Store(dataDir);
  await store.init();
  const users = new Users(store.root);
  const sessions = new Sessions(store.root);
  await Promise.all([users.init(), sessions.init()]);
  const files = new Files(path.join(store.root, 'attachments'));
  const hub = new Hub(store);
  const deps = { store, hub, files, users, sessions, throttle: new Throttle() };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        return await routeApi(req, res, url, deps);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method not allowed' });
      }
      if (pathname.startsWith('/files/')) {
        return await serveFile(req, res, pathname, deps);
      }
      return await serveStatic(pathname === '/' ? '/index.html' : pathname, res);
    } catch (err) {
      return httpError(res, err);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // The cookie is read here, not inside the hub: the hub takes an identity, it does not parse credentials.
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, url.searchParams, viewerFor(req, deps)));
  });

  await new Promise((resolve) => server.listen(port, resolve));

  return {
    server,
    store,
    files,
    hub,
    users,
    sessions,
    port: server.address().port,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([store.flush(), users.flush(), sessions.flush()]);
    },
  };
}

/**
 * Cookie -> who is asking. A disabled account stops resolving here, which is what logs it
 * out of every tab at once; nothing else has to be told.
 */
function viewerFor(req, { users, sessions }) {
  const userId = sessions.resolve(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  const user = userId ? users.get(userId) : null;
  if (!user || user.disabled) return null;
  return { userId: user.id, name: user.name, admin: user.role === 'admin', user };
}

const parts = (pathname) => pathname.split('/').filter(Boolean);

/** Owner names for the lobby and the share panel, resolved from ids on the way out. */
function named(access, users) {
  const name = (id) => (id ? users.get(id)?.name ?? '(removed account)' : null);
  return {
    ...access,
    ownerName: name(access.owner),
    grants: access.grants.map((entry) => ({ ...entry, name: name(entry.user) })),
  };
}

async function routeApi(req, res, url, deps) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, docs: deps.store.list().length, users: deps.users.size });
  }
  assertSameOrigin(req);
  if (url.pathname.startsWith('/api/docs')) return await routeDocs(req, res, url, deps);
  return await routeAccount(req, res, url, deps);
}

async function routeAccount(req, res, url, { users, sessions, throttle }) {
  if (url.pathname === '/api/signup' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `signup:${String(body.name ?? '').toLowerCase()}`;
    const wait = throttle.check(key);
    if (wait) return json(res, 429, { error: `too many attempts, try again in ${wait}s`, retryAfter: wait });
    const user = await users.create({ name: body.name, password: body.password });
    setSession(res, req, sessions.create(user.id));
    throttle.clear(key);
    return json(res, 201, { user: publicUser(user) });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `login:${String(body.name ?? '').toLowerCase()}`;
    const wait = throttle.check(key);
    if (wait) return json(res, 429, { error: `too many attempts, try again in ${wait}s`, retryAfter: wait });
    const user = await users.login({ name: body.name, password: body.password });
    if (!user) {
      const retry = throttle.fail(key);
      return json(res, 401, { error: retry ? `wrong name or password (${retry}s before the next try)` : 'wrong name or password' });
    }
    throttle.clear(key);
    setSession(res, req, sessions.create(user.id));
    return json(res, 200, { user: publicUser(user) });
  }

  const viewer = viewerFor(req, { users, sessions });

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) sessions.drop(token);
    res.setHeader('set-cookie', logoutHeader(req));
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/me') {
    return json(res, 200, {
      user: viewer ? publicUser(viewer.user) : null,
      firstUser: users.size === 0, // drives the "create the admin account" prompt
    });
  }

  // The share panel needs ids to grant, and only a signed-in reader may enumerate them.
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (!viewer) return json(res, 401, { error: 'sign in first', code: 'need_login' });
    return json(res, 200, { users: users.search(url.searchParams.get('q')) });
  }

  if (url.pathname.startsWith('/api/admin/users')) {
    if (!viewer) return json(res, 401, { error: 'sign in first', code: 'need_login' });
    if (!viewer.admin) return json(res, 403, { error: 'admin only', code: 'forbidden' });
    if (req.method === 'GET') return json(res, 200, { users: users.list() });
    const id = parts(url.pathname)[3];
    if (!id || req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    let updated = null;
    if (body.role !== undefined) updated = users.setRole(id, body.role);
    if (body.disabled !== undefined) {
      updated = users.setDisabled(id, Boolean(body.disabled));
      if (updated?.disabled) sessions.dropForUser(id); // a disabled account loses its sessions too
    }
    if (!updated) return json(res, 404, { error: 'no such user' });
    return json(res, 200, { user: updated });
  }

  return json(res, 404, { error: 'not found' });
}

async function routeDocs(req, res, url, { store, hub, files, users, sessions }) {
  const viewer = viewerFor(req, { users, sessions });
  const bits = parts(url.pathname); // ['api','docs',id?,sub?,fileId?]
  const id = bits[2] ? assertDocId(bits[2]) : null;

  if (!id) {
    if (req.method === 'GET') {
      // A list row is a badge, not the share panel: `grants: undefined` drops the list,
      // because JSON.stringify leaves undefined keys out.
      const docs = store
        .list()
        .filter((doc) => visibleTo(doc, viewer))
        .map((doc) => ({
          ...doc,
          ...accessOf(doc, viewer),
          grants: undefined,
          ownerName: doc.owner ? users.get(doc.owner)?.name ?? null : null,
        }));
      return json(res, 200, { docs, viewer: viewer ? publicUser(viewer.user) : null });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!viewer) return json(res, 401, { error: 'sign in to create a document', code: 'need_login' });
    const body = await readBody(req);
    const doc = store.create({ title: assertTitle(body.title), text: assertText(body.text ?? ''), owner: viewer.userId });
    return json(res, 201, { doc: { ...doc, ...accessOf(doc, viewer) } });
  }

  if (bits[3] === 'access') return await routeAccess(req, res, { store, hub, users }, id, viewer);
  if (bits[3] === 'files') return await routeFiles(req, res, url, { store, hub, files }, id, bits[4], viewer);
  if (bits[3] === 'export') return await routeExport(req, res, url, { store, hub }, id, viewer);

  const doc = store.get(id);
  if (!doc) return json(res, 404, { error: 'no such document' });

  if (req.method === 'GET') {
    requireRole(doc, viewer, 'read');
    const live = hub.state(id);
    const access = accessOf(doc, viewer);
    // The opening response says what I may do; who else is on the list is the share panel's business.
    if (!access.canManage) access.grants = [];
    return json(res, 200, {
      doc: { ...doc, text: live?.text ?? doc.text, revision: live?.revision ?? doc.revision },
      access: named(access, users),
      users: hub.peers(id),
    });
  }
  if (req.method === 'PATCH') {
    requireRole(doc, viewer, 'edit');
    const body = await readBody(req);
    const title = assertTitle(body.title);
    const room = hub.getRoom(id);
    if (room) room.setTitle(title);
    else store.update(id, (target) => (target.title = title));
    return json(res, 200, { doc: store.get(id) });
  }
  if (req.method === 'DELETE') {
    requireRole(doc, viewer, 'manage');
    hub.dropRoom(id, 4004, 'document deleted');
    const deleted = store.remove(id);
    await files.removeAll(id);
    return json(res, 200, { deleted });
  }
  return json(res, 405, { error: 'method not allowed' });
}

/** Read the share list, or rewrite it. Changing it is an owner action, and it lands live. */
async function routeAccess(req, res, { store, hub, users }, id, viewer) {
  const doc = store.get(id);
  if (!doc) return json(res, 404, { error: 'no such document' });
  requireRole(doc, viewer, 'read');
  if (req.method === 'GET') {
    // Who a document is shared with is not part of its public text, so the list takes an account.
    if (!viewer) return json(res, 401, { error: 'sign in to see the share list', code: 'need_login' });
    return json(res, 200, { access: named(accessOf(doc, viewer), users) });
  }
  if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' });

  requireRole(doc, viewer, 'manage');
  const body = await readBody(req);
  const next = { grants: assertGrants(body.grants, { knownUser: (userId) => Boolean(users.get(userId)) }) };
  if (body.visibility !== undefined) next.visibility = assertVisibility(body.visibility);
  const updated = store.setAccess(id, next);
  hub.accessChanged(id); // open sockets re-derive their role from the record
  return json(res, 200, { access: named(accessOf(updated, viewer), users) });
}

/** Send the document out as a .md or a Word-openable .doc download. */
async function routeExport(req, res, url, { store, hub }, docId, viewer) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const doc = store.get(docId);
  if (!doc) return json(res, 404, { error: 'no such document' });
  requireRole(doc, viewer, 'read');
  // Same live-text precedence as GET /api/docs/:id, so an open room exports what it shows.
  const live = hub.state(docId);
  const { body, type, filename } = exportDocument(
    { ...doc, text: live?.text ?? doc.text },
    { format: url.searchParams.get('format') ?? 'md', baseUrl: requestBaseUrl(req) },
  );
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'content-type': type,
    'content-length': payload.byteLength,
    'content-disposition': disposition(filename, false),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  return req.method === 'HEAD' ? res.end() : res.end(payload);
}

async function routeFiles(req, res, url, { store, hub, files }, docId, fileId, viewer) {
  const doc = store.get(docId);
  if (!doc) return json(res, 404, { error: 'no such document' });

  if (fileId === undefined) {
    if (req.method === 'GET') {
      requireRole(doc, viewer, 'read');
      return json(res, 200, { files: doc.files ?? [] });
    }
    requireRole(doc, viewer, 'edit');
    if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' });
    if ((doc.files ?? []).length >= MAX_FILES_PER_DOC) {
      return json(res, 409, { error: `at most ${MAX_FILES_PER_DOC} attachments per document` });
    }
    const bytes = await readRaw(req, MAX_FILE_BYTES);
    const meta = await files.put(docId, {
      name: url.searchParams.get('name'),
      type: url.searchParams.get('type'),
      bytes,
      // The uploader is whoever the cookie says it is, not whatever the query string claims.
      by: viewer.name,
    });
    const list = store.addFile(docId, meta);
    hub.filesChanged(docId, list);
    return json(res, 201, { file: meta, files: list });
  }

  assertFileId(fileId);
  requireRole(doc, viewer, 'edit');
  if (req.method !== 'DELETE') return json(res, 405, { error: 'method not allowed' });
  await files.remove(docId, fileId);
  const list = store.removeFile(docId, fileId);
  hub.filesChanged(docId, list);
  return json(res, 200, { files: list });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server.js')) {
  const port = Number(process.env.PORT ?? 3000);
  const { close } = await createServer({ port });
  console.log(`doc-online listening on http://localhost:${port}`);
  const shutdown = () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
