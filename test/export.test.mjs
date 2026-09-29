import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { makeEdit } from '../shared/ot.mjs';
import { Client } from './client.mjs';

/** Every export test needs somebody who can read the document. */
async function signIn(app, name = 'Author') {
  const client = new Client(`http://127.0.0.1:${app.port}`);
  await client.signup(name);
  return client;
}

async function raw(client, url, options) {
  const res = await client.send(url, options);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('a markdown export ships the source text as an attachment', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-export-')) });
  const author = await signIn(app);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const source = '# Launch\n\nShip notes for *Q3*.\n';
    const doc = await author.createDoc({ title: 'Q3 notes', text: source });

    const md = await raw(author, `/api/docs/${doc.id}/export?format=md`);
    assert.equal(md.status, 200);
    assert.equal(md.text, source);
    assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(md.headers.get('content-length'), String(Buffer.byteLength(source)));
    assert.equal(md.headers.get('content-disposition'), 'attachment; filename="Q3 notes.md"; filename*=UTF-8\'\'Q3%20notes.md');

    // A request without ?format= still gets the Markdown source.
    assert.equal((await raw(author, `/api/docs/${doc.id}/export`)).text, source);
    // A private document is not exported to a signed-out browser.
    assert.equal((await fetch(`${base}/api/docs/${doc.id}/export?format=md`)).status, 403);

    // Make it public and the same anonymous request works.
    await author.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    assert.equal((await fetch(`${base}/api/docs/${doc.id}/export?format=md`)).status, 200);
  } finally {
    await app.close();
  }
});

test('the doc export is a Word document with rendered markup and absolute urls', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-export-')) });
  const author = await signIn(app);
  try {
    const doc = await author.createDoc({
      title: 'R&D <weekly>',
      text: ['## stock', '', '| item | qty |', '| --- | ---: |', '| pen | 3 |', '', '[home](/)'].join('\n'),
    });
    app.store.update(doc.id, (target) => {
      target.text = `${target.text}\n\n![cover](/files/${doc.id}/cover01)\n`;
    });

    const file = await raw(author, `/api/docs/${doc.id}/export?format=doc`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/msword; charset=utf-8');
    assert.ok(file.headers.get('content-disposition').includes('filename="R&D weekly.doc"'));

    assert.match(file.text, /xmlns:o="urn:schemas-microsoft-com:office:office"/);
    assert.match(file.text, /xmlns:w="urn:schemas-microsoft-com:office:word"/);
    assert.match(file.text, /<meta charset="utf-8">/);
    assert.match(file.text, /<meta name="ProgId" content="Word\.Document">/);
    assert.ok(file.text.includes('<title>R&amp;D &lt;weekly&gt;</title>'), 'the title is html-escaped');
    assert.ok(file.text.includes('<table><thead><tr><th>item</th><th class="a-right">qty</th></tr></thead>'), file.text);
    assert.ok(file.text.includes('<td>pen</td><td class="a-right">3</td>'));

    // Relative asset links become absolute so Word can fetch them.
    const origin = `http://127.0.0.1:${app.port}`;
    assert.ok(file.text.includes(`src="${origin}/files/${doc.id}/cover01"`), 'image src is absolute');
    assert.ok(file.text.includes(`href="${origin}/"`), 'root link is absolute');

    const proxied = await raw(author, `/api/docs/${doc.id}/export?format=doc`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'docs.example.com' },
    });
    assert.ok(proxied.text.includes('src="https://docs.example.com/files/'));
  } finally {
    await app.close();
  }
});

test('exports refuse unknown formats, bad ids, missing documents and other methods', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-export-')) });
  const author = await signIn(app);
  try {
    const doc = await author.createDoc({ title: 'T', text: 'x' });

    const badFormat = await raw(author, `/api/docs/${doc.id}/export?format=rtf`);
    assert.equal(badFormat.status, 400);
    assert.match(JSON.parse(badFormat.text).error, /unknown export format/);

    assert.equal((await raw(author, '/api/docs/no-such-doc/export?format=md')).status, 404);
    assert.equal((await raw(author, '/api/docs/..%2Fescape/export?format=md')).status, 400);
    assert.equal((await raw(author, `/api/docs/${doc.id}/export?format=md`, { method: 'POST' })).status, 405);
  } finally {
    await app.close();
  }
});

test('a hostile title never reaches the filename unsanitised', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-export-')) });
  const author = await signIn(app);
  try {
    const doc = await author.createDoc({ title: 'We"ird\\sub/n\x01ame', text: 'x' });
    const md = await raw(author, `/api/docs/${doc.id}/export?format=md`);
    assert.equal(md.status, 200);
    // cleanName drops quotes and control chars; the last path segment is all that survives.
    assert.equal(md.headers.get('content-disposition'), 'attachment; filename="name.md"; filename*=UTF-8\'\'name.md');

    const long = await author.createDoc({ title: 'a'.repeat(300), text: 'y' });
    const file = await raw(author, `/api/docs/${long.id}/export?format=doc`);
    const ascii = /filename="([^"]*)"/.exec(file.headers.get('content-disposition'))[1];
    assert.equal(ascii, `${'a'.repeat(100)}.doc`);
  } finally {
    await app.close();
  }
});

test('an open room exports its live text, not a stale snapshot', async () => {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-export-')) });
  const author = await signIn(app);
  try {
    const doc = await author.createDoc({ title: 'Live', text: 'first draft' });

    // Editing through the hub (as a WebSocket peer would) updates the room state.
    const room = app.hub.roomFor(doc.id);
    room.commit('c1', 1, doc.revision, makeEdit('first draft', 'second draft'));
    assert.equal(app.hub.state(doc.id).text, 'second draft');

    const md = await raw(author, `/api/docs/${doc.id}/export?format=md`);
    assert.equal(md.status, 200);
    assert.equal(md.text, 'second draft');

    const file = await raw(author, `/api/docs/${doc.id}/export?format=doc`);
    assert.ok(file.text.includes('<p>second draft</p>'));
    assert.ok(!file.text.includes('first draft'));
  } finally {
    await app.close();
  }
});
