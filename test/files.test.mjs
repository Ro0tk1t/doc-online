import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Files, MAX_FILE_BYTES, cleanName, disposition, serveType } from '../server/files.mjs';
import { Store } from '../server/store.mjs';

async function tempFiles() {
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-files-'));
  return { files: new Files(path.join(dir, 'attachments')), dir };
}

test('writes bytes and reads back metadata', async () => {
  const { files, dir } = await tempFiles();
  const meta = await files.put('doc1', { name: 'diagram.png', type: 'image/png', bytes: Buffer.from('fake png'), by: 'Alice' });

  assert.equal(meta.name, 'diagram.png');
  assert.equal(meta.type, 'image/png');
  assert.equal(meta.size, 8);
  assert.equal(meta.by, 'Alice');
  assert.match(meta.id, /^[A-Za-z0-9_-]{1,40}$/);

  const onDisk = await readFile(files.pathOf('doc1', meta.id));
  assert.equal(onDisk.toString(), 'fake png');
  assert.deepEqual(await readdir(path.join(dir, 'attachments', 'doc1')), [meta.id]);
  assert.equal((await files.stat('doc1', meta.id)).size, 8);
});

test('refuses empty, oversized and non-byte bodies', async () => {
  const { files } = await tempFiles();
  await assert.rejects(() => files.put('doc1', { name: 'a.png', bytes: Buffer.alloc(0) }), /empty file/);
  await assert.rejects(() => files.put('doc1', { name: 'a.png', bytes: 'a string' }), /read first/);

  const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
  const err = await files.put('doc1', { name: 'a.png', bytes: huge }).catch((e) => e);
  assert.equal(err.statusCode, 413);
  assert.equal(await files.stat('doc1', 'anything'), null);
});

test('an id can never steer a path out of the attachment directory', async () => {
  const { files } = await tempFiles();
  for (const bad of ['../etc/passwd', 'a/b', '', '.', 'x'.repeat(41), 'has space']) {
    assert.throws(() => files.pathOf('doc1', bad), /invalid file id/, bad);
  }
  assert.throws(() => files.docDir('..'), /invalid document id/);
});

test('uploaded names lose paths, markup and control characters', () => {
  assert.equal(cleanName('C:\\Users\\me\\report (final).pdf'), 'report (final).pdf');
  assert.equal(cleanName('../../etc/passwd'), 'passwd');
  assert.equal(cleanName('<img src=x>.png'), 'img src=x.png');
  assert.equal(cleanName('tab\there.txt'), 'tabhere.txt');
  assert.equal(cleanName('   '), 'file');
  assert.equal(cleanName(undefined), 'file');
  assert.equal(cleanName('a'.repeat(400)).length, 120);
});

test('only images and plain documents render inline', () => {
  assert.deepEqual(serveType('image/png'), { type: 'image/png', inline: true });
  assert.deepEqual(serveType('Application/PDF'), { type: 'application/pdf', inline: true });
  assert.deepEqual(serveType('text/plain; charset=utf-8'), { type: 'text/plain', inline: true });

  for (const hostile of ['text/html', 'image/svg+xml', 'application/xhtml+xml', '', undefined]) {
    assert.deepEqual(serveType(hostile), { type: 'application/octet-stream', inline: false }, String(hostile));
  }
});

test('downloads carry a safe ASCII name plus a UTF-8 fallback', () => {
  const header = disposition('报表 Q3.xlsx', false);
  assert.equal(header, `attachment; filename="__ Q3.xlsx"; filename*=UTF-8''${encodeURIComponent('报表 Q3.xlsx')}`);
  assert.equal(disposition('back\\slash.png', true), "inline; filename=\"slash.png\"; filename*=UTF-8''slash.png");
  assert.equal(disposition('quote".txt', false).split(';')[1], ' filename="quote.txt"');
});

test('remove and removeAll leave nothing behind', async () => {
  const { files, dir } = await tempFiles();
  const a = await files.put('doc1', { name: 'a.txt', bytes: Buffer.from('a') });
  const b = await files.put('doc1', { name: 'b.txt', bytes: Buffer.from('b') });

  await files.remove('doc1', a.id);
  assert.equal(await files.stat('doc1', a.id), null);
  assert.ok(await files.stat('doc1', b.id));

  await files.removeAll('doc1');
  await files.remove('doc1', b.id);
  assert.deepEqual(await readdir(path.join(dir, 'attachments')), []);
});

test('attachment metadata rides on the document and survives a reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-files-store-'));
  const store = new Store(dir);
  await store.init();
  const doc = store.create({ title: 'Spec', text: 'body' });
  assert.deepEqual(doc.files, []);

  const files = new Files(path.join(store.root, 'attachments'));
  const one = await files.put(doc.id, { name: 'one.png', type: 'image/png', bytes: Buffer.from('one') });
  const two = await files.put(doc.id, { name: 'two.txt', type: 'text/plain', bytes: Buffer.from('two') });

  assert.equal(store.addFile(doc.id, one).length, 1);
  assert.equal(store.addFile(doc.id, two).length, 2);
  assert.equal(store.list()[0].fileCount, 2);

  assert.equal(store.removeFile(doc.id, one.id).length, 1);
  assert.equal(store.get(doc.id).files[0].name, 'two.txt');

  await store.flush();
  const reopened = new Store(dir);
  await reopened.init();
  assert.deepEqual(
    reopened.get(doc.id).files.map((entry) => entry.name),
    ['two.txt'],
  );
});
