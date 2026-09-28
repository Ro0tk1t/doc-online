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
import { Hub, cleanName } from './server/hub.mjs';
import { Store, assertDocId, assertText, assertTitle } from './server/store.mjs';
import { Files, MAX_FILE_BYTES, MAX_FILES_PER_DOC, assertFileId, disposition, serveType } from './server/files.mjs';
import { exportDocument, requestBaseUrl } from './server/export.mjs';

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
  json(res, status, { error: err.message ?? 'internal error' });
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
async function serveFile(res, pathname, { store, files }) {
  const parts = pathname.split('/').filter(Boolean); // ['files', docId, fileId, name?]
  if (parts.length < 3 || parts.length > 4) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const docId = assertDocId(parts[1]);
  const fileId = assertFileId(parts[2]);
  const meta = (store.get(docId)?.files ?? []).find((entry) => entry.id === fileId);
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

export async function createServer({ dataDir = path.join(ROOT, 'data'), port = 0 } = {}) {
  const store = new Store(dataDir);
  await store.init();
  const files = new Files(path.join(store.root, 'attachments'));
  const hub = new Hub(store);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        return await routeApi(req, res, url, { store, hub, files });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method not allowed' });
      }
      if (pathname.startsWith('/files/')) {
        return await serveFile(res, pathname, { store, files });
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
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, url.searchParams));
  });

  await new Promise((resolve) => server.listen(port, resolve));

  return {
    server,
    store,
    files,
    hub,
    port: server.address().port,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      await store.flush();
    },
  };
}

async function routeApi(req, res, url, { store, hub, files }) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'docs', id?]
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, docs: store.list().length });
  }
  if (parts[1] !== 'docs') return json(res, 404, { error: 'not found' });

  if (parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, { docs: store.list() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      const doc = store.create({ title: assertTitle(body.title), text: assertText(body.text ?? '') });
      return json(res, 201, { doc });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const id = assertDocId(parts[2]);
  if (parts[3] === 'files') return await routeFiles(req, res, url, { store, hub, files }, id, parts[4]);
  if (parts[3] === 'export') return await routeExport(req, res, url, { store, hub }, id);
  if (req.method === 'GET') {
    const live = hub.state(id);
    const doc = store.get(id);
    if (!doc) return json(res, 404, { error: 'no such document' });
    return json(res, 200, {
      doc: { ...doc, text: live?.text ?? doc.text, revision: live?.revision ?? doc.revision },
      users: hub.peers(id),
    });
  }
  if (req.method === 'PATCH') {
    const body = await readBody(req);
    if (!hub.snapshot(id) && !store.get(id)) return json(res, 404, { error: 'no such document' });
    const title = assertTitle(body.title);
    const room = hub.getRoom(id);
    if (room) room.setTitle(title);
    else if (store.get(id)) store.update(id, (doc) => (doc.title = title));
    else return json(res, 404, { error: 'no such document' });
    return json(res, 200, { doc: store.get(id) });
  }
  if (req.method === 'DELETE') {
    hub.dropRoom(id, 4004, 'document deleted');
    const deleted = store.remove(id);
    await files.removeAll(id);
    return json(res, 200, { deleted });
  }
  return json(res, 405, { error: 'method not allowed' });
}

/** Send the document out as a .md or a Word-openable .doc download. */
async function routeExport(req, res, url, { store, hub }, docId) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const doc = store.get(docId);
  if (!doc) return json(res, 404, { error: 'no such document' });
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

async function routeFiles(req, res, url, { store, hub, files }, docId, fileId) {
  const doc = store.get(docId);
  if (!doc) return json(res, 404, { error: 'no such document' });

  if (fileId === undefined) {
    if (req.method === 'GET') return json(res, 200, { files: doc.files ?? [] });
    if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' });
    if ((doc.files ?? []).length >= MAX_FILES_PER_DOC) {
      return json(res, 409, { error: `at most ${MAX_FILES_PER_DOC} attachments per document` });
    }
    const bytes = await readRaw(req, MAX_FILE_BYTES);
    const meta = await files.put(docId, {
      name: url.searchParams.get('name'),
      type: url.searchParams.get('type'),
      bytes,
      by: cleanName(url.searchParams.get('who'), '').slice(0, 32),
    });
    const list = store.addFile(docId, meta);
    hub.filesChanged(docId, list);
    return json(res, 201, { file: meta, files: list });
  }

  assertFileId(fileId);
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
