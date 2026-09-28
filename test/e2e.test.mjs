import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { Store } from '../server/store.mjs';
import { apply, makeEdit } from '../shared/ot.mjs';
import { makeTable, serializeTable } from '../public/js/table.mjs';
import { MAX_FILES_PER_DOC } from '../server/files.mjs';

function open(url) {
  const ws = new WebSocket(url);
  ws.messages = [];
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const index = waiters.findIndex((w) => w.test(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else ws.messages.push(msg);
  };
  ws.waitFor = (test, timeout = 3000) =>
    new Promise((resolve, reject) => {
      const existing = ws.messages.findIndex(test);
      if (existing >= 0) return resolve(ws.messages.splice(existing, 1)[0]);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeout);
      waiters.push({ test, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
    });
  return new Promise((resolve) => ws.addEventListener('open', () => resolve(ws)));
}

async function api(base, url, options) {
  const res = await fetch(`${base}${url}`, options);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('two browsers editing at once converge and survive a restart', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'doc-e2e-'));
  const app = await createServer({ dataDir });
  const base = `http://127.0.0.1:${app.port}`;
  const wsBase = base.replace('http', 'ws');
  const sessions = [];

  try {
    const created = await api(base, '/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Launch notes', text: 'day one' }),
    });
    assert.equal(created.status, 201);
    const { doc } = created.body;

    const alice = await open(`${wsBase}/ws?doc=${doc.id}&client=aaaa1111&name=Alice`);
    const bob = await open(`${wsBase}/ws?doc=${doc.id}&client=bbbb2222&name=Bob`);
    sessions.push(alice, bob);

    const a0 = await alice.waitFor((m) => m.type === 'doc');
    const b0 = await bob.waitFor((m) => m.type === 'doc');
    assert.equal(a0.text, 'day one');
    assert.deepEqual(
      b0.users.map((u) => u.name).sort(),
      ['Alice', 'Bob'],
    );
    assert.match(b0.users.find((u) => u.clientId === 'aaaa1111').color, /^#[0-9a-f]{6}$/);
    await alice.waitFor((m) => m.type === 'users' && m.users.length === 2);

    // Alice types a suffix, Bob replaces a word from the same starting revision.
    alice.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: a0.revision, op: makeEdit('day one', 'day one!') }));
    bob.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: b0.revision, op: makeEdit('day one', 'DAY one') }));

    const ackA = await alice.waitFor((m) => m.type === 'ack');
    const ackB = await bob.waitFor((m) => m.type === 'ack');
    assert.notEqual(ackA.revision, ackB.revision);

    const opsForAlice = await alice.waitFor((m) => m.type === 'op' && m.from === 'bbbb2222');
    const opsForBob = await bob.waitFor((m) => m.type === 'op' && m.from === 'aaaa1111');
    assert.ok(opsForAlice.op.length);
    assert.ok(opsForBob.op.length);

    const final = app.hub.snapshot(doc.id);
    assert.equal(final.text, 'DAY one!');
    assert.equal(final.revision, 2);

    // Presence: Bob sees Alice's caret move, and both learn about the rename.
    alice.send(JSON.stringify({ type: 'presence', selection: { start: 3, end: 3 }, typing: true }));
    const seen = await bob.waitFor((m) => m.type === 'users' && m.users.find((u) => u.clientId === 'aaaa1111')?.typing);
    assert.deepEqual(seen.users.find((u) => u.clientId === 'aaaa1111').selection, { start: 3, end: 3 });

    alice.send(JSON.stringify({ type: 'title', title: 'Launch notes v2' }));
    await bob.waitFor((m) => m.type === 'title');

    // A view-only peer cannot edit.
    const carol = await open(`${wsBase}/ws?doc=${doc.id}&client=cccc3333&mode=view`);
    sessions.push(carol);
    const c0 = await carol.waitFor((m) => m.type === 'doc');
    carol.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: c0.revision, op: makeEdit(c0.text, `${c0.text}!`) }));
    await carol.waitFor((m) => m.type === 'error' && /view-only/.test(m.message));

    // A garbage operation is refused and answered with a resync snapshot.
    bob.send(JSON.stringify({ type: 'edit', seq: 9, baseRevision: final.revision, op: [{ retain: 999 }] }));
    const refused = await bob.waitFor((m) => m.type === 'stale');
    assert.match(refused.reason, /rejected operation/);
    assert.equal(refused.text, 'DAY one!');

    await new Promise((resolve) => {
      bob.addEventListener('close', resolve);
      bob.close();
    });

    await app.store.flush();
    const persisted = new Store(dataDir);
    await persisted.init();
    const saved = persisted.get(doc.id);
    assert.equal(saved.text, 'DAY one!');
    assert.equal(saved.title, 'Launch notes v2');

    const listed = await api(base, '/api/docs');
    assert.equal(listed.body.docs[0].revision, 2);
  } finally {
    for (const ws of sessions) ws.close();
    await app.close();
  }
});

test('the HTTP API guards document ids and unknown routes', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-e2e-')) });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal((await api(base, '/api/docs/..%2F..%2Fetc', { method: 'GET' })).status, 400);
    assert.equal((await api(base, '/api/docs/does-not-exist', { method: 'GET' })).status, 404);
    assert.equal((await api(base, '/api/nope', { method: 'GET' })).status, 404);
    assert.equal((await api(base, '/../package.json', { method: 'GET' })).status, 404);
    const health = await api(base, '/api/health');
    assert.equal(health.body.ok, true);
  } finally {
    await app.close();
  }
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('an upload reaches every peer, serves back byte-exact, and disappears on delete', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'doc-e2e-'));
  const app = await createServer({ dataDir });
  const base = `http://127.0.0.1:${app.port}`;
  let socket;

  try {
    const created = await api(base, '/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Design review', text: 'see the sketch below' }),
    });
    const { doc } = created.body;

    socket = await open(`${base.replace('http', 'ws')}/ws?doc=${doc.id}&client=dddd4444&name=Dana`);
    assert.deepEqual((await socket.waitFor((m) => m.type === 'doc')).files, []);

    const uploaded = await api(
      base,
      `/api/docs/${doc.id}/files?name=${encodeURIComponent('sketch v2.png')}&type=image/png&who=Dana`,
      { method: 'PUT', body: PNG },
    );
    assert.equal(uploaded.status, 201);
    const file = uploaded.body.file;
    assert.equal(file.name, 'sketch v2.png');
    assert.equal(file.size, PNG.length);

    const pushed = await socket.waitFor((m) => m.type === 'files' && m.files.length === 1);
    assert.equal(pushed.files[0].id, file.id);
    assert.equal(pushed.files[0].by, 'Dana');
    assert.deepEqual((await api(base, `/api/docs/${doc.id}/files`)).body.files, pushed.files);

    const served = await fetch(`${base}/files/${doc.id}/${file.id}/sketch.png`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-disposition'), /^inline; filename="sketch v2\.png"/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    // Anything outside the inline allowlist comes back as a download, never as a page.
    const hostile = await api(base, `/api/docs/${doc.id}/files?name=page.html&type=text/html`, {
      method: 'PUT',
      body: Buffer.from('<script>alert(1)</script>'),
    });
    const hostileRes = await fetch(`${base}/files/${doc.id}/${hostile.body.file.id}`);
    assert.equal(hostileRes.headers.get('content-type'), 'application/octet-stream');
    assert.match(hostileRes.headers.get('content-disposition'), /^attachment/);

    // The reference in the document is what a peer needs; the name is decoration.
    const reference = `/files/${doc.id}/${file.id}`;
    socket.send(
      JSON.stringify({
        type: 'edit',
        seq: 1,
        baseRevision: doc.revision,
        op: makeEdit(doc.text, `${doc.text}\n\n![sketch](${reference})\n`),
      }),
    );
    await socket.waitFor((m) => m.type === 'ack');
    assert.ok(app.hub.snapshot(doc.id).text.includes(reference));

    assert.equal((await api(base, `/api/docs/${doc.id}/files/..%2Fescape`, { method: 'DELETE' })).status, 400);
    assert.equal((await api(base, '/api/docs/no-such-doc/files', { method: 'PUT', body: PNG })).status, 404);

    const afterDelete = await api(base, `/api/docs/${doc.id}/files/${file.id}`, { method: 'DELETE' });
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.files.length, 1);
    await socket.waitFor((m) => m.type === 'files' && m.files.length === 1);
    assert.equal((await fetch(`${base}/files/${doc.id}/${file.id}`)).status, 404);
    assert.equal(await app.files.stat(doc.id, file.id), null);
    assert.ok(await app.files.stat(doc.id, hostile.body.file.id));

    assert.equal((await api(base, `/api/docs/${doc.id}`, { method: 'DELETE' })).body.deleted, true);
    assert.equal(await app.files.stat(doc.id, hostile.body.file.id), null);
  } finally {
    socket?.close();
    await app.close();
  }
});

test('the per-document attachment count is capped', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-e2e-')) });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const { doc } = (await api(base, '/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Crowded', text: 'x' }),
    })).body;
    app.store.update(doc.id, (target) => {
      target.files = Array.from({ length: MAX_FILES_PER_DOC }, (_, i) => ({
        id: `f${i}`,
        name: `f${i}.txt`,
        type: 'text/plain',
        size: 1,
        at: 0,
      }));
    });
    const rejected = await api(base, `/api/docs/${doc.id}/files?name=one-more.txt&type=text/plain`, {
      method: 'PUT',
      body: Buffer.from('bytes'),
    });
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /at most/);
    assert.equal(app.store.get(doc.id).files.length, MAX_FILES_PER_DOC);
  } finally {
    await app.close();
  }
});

test('a table built and widened in the grid reaches a peer as an ordinary edit', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-e2e-')) });
  const base = `http://127.0.0.1:${app.port}`;
  const wsBase = base.replace('http', 'ws');
  const sessions = [];

  try {
    const created = await api(base, '/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Inventory', text: '## stock\n' }),
    });
    const { doc } = created.body;

    const alice = await open(`${wsBase}/ws?doc=${doc.id}&client=eeee5555&name=Alice`);
    const bob = await open(`${wsBase}/ws?doc=${doc.id}&client=ffff6666&name=Bob`);
    sessions.push(alice, bob);
    const a0 = await alice.waitFor((m) => m.type === 'doc');
    await bob.waitFor((m) => m.type === 'doc');

    // Alice picks 3x2 in the picker: insertTable() drops the block in and sends one edit.
    const state = makeTable(3, 2);
    const withTable = `${a0.text}\n${serializeTable(state)}\n`;
    alice.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: a0.revision, op: makeEdit(a0.text, withTable) }));
    const inserted = await bob.waitFor((m) => m.type === 'op');
    assert.equal(apply(a0.text, inserted.op), withTable);

    // Bob clicks a header cell and presses "+col": the grid gains a cell per row, and what
    // the surface serializes back is the same text a model edit would have produced.
    const widened = {
      header: [...state.header, 'Column 4'],
      rows: state.rows.map((row) => [...row, '']),
      aligns: [...state.aligns, ''],
    };
    // He then types into the first header cell, which re-pads that column.
    const typed = serializeTable({ ...widened, header: ['item', ...widened.header.slice(1)] });
    bob.send(JSON.stringify({ type: 'edit', seq: 2, baseRevision: inserted.revision, op: makeEdit(withTable, typed) }));
    const echoed = await alice.waitFor((m) => m.type === 'op' && m.from === 'ffff6666');

    assert.equal(apply(withTable, echoed.op), typed);
    assert.equal(app.hub.snapshot(doc.id).text, typed);
    assert.equal(typed.split('\n')[0].split('|').length - 2, 4);
  } finally {
    for (const ws of sessions) ws.close();
    await app.close();
  }
});
