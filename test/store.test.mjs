import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { apply, makeEdit } from '../shared/ot.mjs';

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-online-'));
  const store = new Store(dir);
  await store.init();
  return { store, dir };
}

test('create, persist and reload a document', async () => {
  const { store, dir } = await tempStore();
  const doc = store.create({ title: 'Meeting notes', text: '# agenda\n' });
  store.update(doc.id, (d) => {
    d.text = '# agenda\n- ship it\n';
    d.revision = 1;
  });
  await store.flush();

  const reopened = new Store(dir);
  await reopened.init();
  const loaded = reopened.get(doc.id);
  assert.equal(loaded.title, 'Meeting notes');
  assert.equal(loaded.text, '# agenda\n- ship it\n');
  assert.equal(loaded.revision, 1);
  assert.deepEqual(reopened.list().map((d) => d.id), [doc.id]);
  assert.deepEqual((await readdir(path.join(dir, 'docs'))).length, 1);
});

test('index stays in sync with deletes and exposes summaries only', async () => {
  const { store, dir } = await tempStore();
  const a = store.create({ title: 'A' });
  const b = store.create({ title: 'B', text: 'body' });
  await store.flush();
  const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(
    index.docs.map((d) => d.title).sort(),
    ['A', 'B'],
  );
  assert.equal(index.docs[0].text, undefined);

  assert.equal(store.remove(b.id), true);
  await store.flush();
  const after = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(after.docs.map((d) => d.id), [a.id]);
  assert.equal(store.get(b.id), null);
});

test('rejects ids that could escape the data directory', async () => {
  const { store } = await tempStore();
  for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(50), 'with space']) {
    assert.throws(() => store.get(bad), /invalid document id/, bad);
  }
});

test('titles and oversized bodies are rejected', async () => {
  const { store } = await tempStore();
  const doc = store.create({ title: 'Scratch' });
  assert.throws(() => store.update(doc.id, (d) => (d.text = 'x'.repeat(500_001))), /exceeds/);
  assert.throws(() => store.create({ title: '   ' }), /title is required/);
});

test('reopening a store applies a stored edit made through makeEdit', async () => {
  const { store } = await tempStore();
  const doc = store.create({ title: 'Round trip', text: 'hello' });
  const op = makeEdit('hello', 'hello world');
  store.update(doc.id, (d) => {
    d.text = apply(d.text, op);
    d.revision += 1;
  });
  await store.flush();
  assert.equal(store.get(doc.id).text, 'hello world');
});
