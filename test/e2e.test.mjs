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
import { Client, openSocket } from './client.mjs';

test('two browsers editing at once converge and survive a restart', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'doc-e2e-'));
  const app = await createServer({ dataDir });
  const base = `http://127.0.0.1:${app.port}`;
  const wsBase = base.replace('http', 'ws');
  const sessions = [];
  const alice = new Client(base);
  const bob = new Client(base);

  try {
    await alice.signup('Alice');
    await bob.signup('Bob');
    const doc = await alice.createDoc({ title: 'Launch notes', text: 'day one' });
    assert.equal(doc.owner, (await alice.api('/api/me')).body.user.id);
    await alice.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public', grants: [{ user: (await bob.api('/api/me')).body.user.id, role: 'editor' }] }),
    });

    const a = await alice.open(`${wsBase}/ws?doc=${doc.id}&client=aaaa1111&name=Impostor`);
    const b = await bob.open(`${wsBase}/ws?doc=${doc.id}&client=bbbb2222&name=Bob`);
    sessions.push(a, b);

    const a0 = await a.waitFor((m) => m.type === 'doc');
    const b0 = await b.waitFor((m) => m.type === 'doc');
    assert.equal(a0.text, 'day one');
    assert.equal(a0.access.role, 'owner');
    assert.equal(b0.access.role, 'editor');
    // A socket is named by its account, never by the ?name= it typed.
    assert.deepEqual(
      b0.users.map((u) => u.name).sort(),
      ['Alice', 'Bob'],
    );
    assert.match(b0.users.find((u) => u.clientId === 'aaaa1111').color, /^#[0-9a-f]{6}$/);
    await a.waitFor((m) => m.type === 'users' && m.users.length === 2);

    // Alice types a suffix, Bob replaces a word from the same starting revision.
    a.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: a0.revision, op: makeEdit('day one', 'day one!') }));
    b.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: b0.revision, op: makeEdit('day one', 'DAY one') }));

    const ackA = await a.waitFor((m) => m.type === 'ack');
    const ackB = await b.waitFor((m) => m.type === 'ack');
    assert.notEqual(ackA.revision, ackB.revision);

    const opsForAlice = await a.waitFor((m) => m.type === 'op' && m.from === 'bbbb2222');
    const opsForBob = await b.waitFor((m) => m.type === 'op' && m.from === 'aaaa1111');
    assert.ok(opsForAlice.op.length);
    assert.ok(opsForBob.op.length);

    const final = app.hub.snapshot(doc.id);
    assert.equal(final.text, 'DAY one!');
    assert.equal(final.revision, 2);

    // Presence: Bob sees Alice's caret move, and both learn about the rename.
    a.send(JSON.stringify({ type: 'presence', selection: { start: 3, end: 3 }, typing: true }));
    const seen = await b.waitFor((m) => m.type === 'users' && m.users.find((u) => u.clientId === 'aaaa1111')?.typing);
    assert.deepEqual(seen.users.find((u) => u.clientId === 'aaaa1111').selection, { start: 3, end: 3 });

    a.send(JSON.stringify({ type: 'title', title: 'Launch notes v2' }));
    await b.waitFor((m) => m.type === 'title');

    // An anonymous peer on a public document can read, and nothing else.
    const carol = await openSocket(`${wsBase}/ws?doc=${doc.id}&client=cccc3333&mode=view`);
    sessions.push(carol);
    const c0 = await carol.waitFor((m) => m.type === 'doc');
    assert.equal(c0.access.role, 'reader');
    assert.equal(c0.access.canEdit, false);
    carol.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: c0.revision, op: makeEdit(c0.text, `${c0.text}!`) }));
    await carol.waitFor((m) => m.type === 'error' && /read-only|view-only/.test(m.message));

    // A garbage operation is refused and answered with a resync snapshot.
    b.send(JSON.stringify({ type: 'edit', seq: 9, baseRevision: final.revision, op: [{ retain: 999 }] }));
    const refused = await b.waitFor((m) => m.type === 'stale');
    assert.match(refused.reason, /rejected operation/);
    assert.equal(refused.text, 'DAY one!');

    await new Promise((resolve) => {
      b.addEventListener('close', resolve);
      b.close();
    });

    await app.store.flush();
    const persisted = new Store(dataDir);
    await persisted.init();
    const saved = persisted.get(doc.id);
    assert.equal(saved.text, 'DAY one!');
    assert.equal(saved.title, 'Launch notes v2');

    const listed = await alice.api('/api/docs');
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
    const alice = new Client(base);
    await alice.signup('Alice');
    const doc = await alice.createDoc({ title: 'guarded' });
    assert.equal((await alice.api('/api/docs/..%2F..%2Fetc')).status, 400);
    assert.equal((await alice.api('/api/docs/does-not-exist')).status, 404);
    assert.equal((await alice.api('/api/nope')).status, 404);
    assert.equal((await alice.api(`/api/docs/${doc.id}`, { method: 'DELETE' })).body.deleted, true);
    assert.equal((await alice.send('/../package.json')).status, 404);
    const health = await alice.api('/api/health');
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
  const dana = new Client(base);
  await dana.signup('Dana');
  let socket;

  try {
    const doc = await dana.createDoc({ title: 'Design review', text: 'see the sketch below' });

    socket = await dana.open(`${base.replace('http', 'ws')}/ws?doc=${doc.id}&client=dddd4444`);
    assert.deepEqual((await socket.waitFor((m) => m.type === 'doc')).files, []);

    const uploaded = await dana.api(
      `/api/docs/${doc.id}/files?name=${encodeURIComponent('sketch v2.png')}&type=image/png&who=Somebody Else`,
      { method: 'PUT', body: PNG },
    );
    assert.equal(uploaded.status, 201);
    const file = uploaded.body.file;
    assert.equal(file.name, 'sketch v2.png');
    assert.equal(file.size, PNG.length);

    const pushed = await socket.waitFor((m) => m.type === 'files' && m.files.length === 1);
    assert.equal(pushed.files[0].id, file.id);
    // The uploader is the account, whatever the query string claimed.
    assert.equal(pushed.files[0].by, 'Dana');
    assert.deepEqual((await dana.api(`/api/docs/${doc.id}/files`)).body.files, pushed.files);

    const served = await dana.send(`/files/${doc.id}/${file.id}/sketch.png`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('content-disposition'), /^inline; filename="sketch v2\.png"/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    // Anything outside the inline allowlist comes back as a download, never as a page.
    const hostile = await dana.api(`/api/docs/${doc.id}/files?name=page.html&type=text/html`, {
      method: 'PUT',
      body: Buffer.from('<script>alert(1)</script>'),
    });
    const hostileRes = await dana.send(`/files/${doc.id}/${hostile.body.file.id}`);
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

    assert.equal((await dana.api(`/api/docs/${doc.id}/files/..%2Fescape`, { method: 'DELETE' })).status, 400);
    assert.equal((await dana.api('/api/docs/no-such-doc/files', { method: 'PUT', body: PNG })).status, 404);
    // A signed-out browser cannot read the attachment of a private document.
    assert.equal((await fetch(`${base}/files/${doc.id}/${file.id}`)).status, 403);

    const afterDelete = await dana.api(`/api/docs/${doc.id}/files/${file.id}`, { method: 'DELETE' });
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.body.files.length, 1);
    await socket.waitFor((m) => m.type === 'files' && m.files.length === 1);
    assert.equal((await dana.send(`/files/${doc.id}/${file.id}`)).status, 404);
    assert.equal(await app.files.stat(doc.id, file.id), null);
    assert.ok(await app.files.stat(doc.id, hostile.body.file.id));

    assert.equal((await dana.api(`/api/docs/${doc.id}`, { method: 'DELETE' })).body.deleted, true);
    assert.equal(await app.files.stat(doc.id, hostile.body.file.id), null);
  } finally {
    socket?.close();
    await app.close();
  }
});

test('the per-document attachment count is capped', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-e2e-')) });
  const dana = new Client(`http://127.0.0.1:${app.port}`);
  try {
    await dana.signup('Dana');
    const doc = await dana.createDoc({ title: 'Crowded', text: 'x' });
    app.store.update(doc.id, (target) => {
      target.files = Array.from({ length: MAX_FILES_PER_DOC }, (_, i) => ({
        id: `f${i}`,
        name: `f${i}.txt`,
        type: 'text/plain',
        size: 1,
        at: 0,
      }));
    });
    const rejected = await dana.api(`/api/docs/${doc.id}/files?name=one-more.txt&type=text/plain`, {
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
  const alice = new Client(base);
  const bob = new Client(base);

  try {
    await alice.signup('Alice');
    await bob.signup('Bob');
    const doc = await alice.createDoc({ title: 'Inventory', text: '## stock\n' });
    const bobId = (await bob.api('/api/me')).body.user.id;
    await alice.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'editor' }] }),
    });

    const a = await alice.open(`${wsBase}/ws?doc=${doc.id}&client=eeee5555`);
    const b = await bob.open(`${wsBase}/ws?doc=${doc.id}&client=ffff6666`);
    sessions.push(a, b);
    const a0 = await a.waitFor((m) => m.type === 'doc');
    await b.waitFor((m) => m.type === 'doc');

    // Alice picks 3x2 in the picker: insertTable() drops the block in and sends one edit.
    const state = makeTable(3, 2);
    const withTable = `${a0.text}\n${serializeTable(state)}\n`;
    a.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: a0.revision, op: makeEdit(a0.text, withTable) }));
    const inserted = await b.waitFor((m) => m.type === 'op');
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
    b.send(JSON.stringify({ type: 'edit', seq: 2, baseRevision: inserted.revision, op: makeEdit(withTable, typed) }));
    const echoed = await a.waitFor((m) => m.type === 'op' && m.from === 'ffff6666');

    assert.equal(apply(withTable, echoed.op), typed);
    assert.equal(app.hub.snapshot(doc.id).text, typed);
    assert.equal(typed.split('\n')[0].split('|').length - 2, 4);
  } finally {
    for (const ws of sessions) ws.close();
    await app.close();
  }
});
