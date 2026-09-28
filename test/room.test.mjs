import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { Room, Rejected } from '../server/room.mjs';
import { apply, makeEdit, transformPair } from '../shared/ot.mjs';

async function roomFor(text = 'hello world') {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'doc-room-')));
  await store.init();
  store.create({ title: 'Test', text });
  return new Room(store, store.list()[0].id);
}

test('a committed edit bumps the revision and answers an ack', async () => {
  const room = await roomFor();
  const entry = room.commit('alice', 1, 0, makeEdit('hello world', 'hello brave world'));
  assert.equal(entry.revision, 1);
  assert.equal(room.text, 'hello brave world');
  assert.equal(room.revision, 1);
});

test('concurrent edits from two peers land in the same order for both', async () => {
  const room = await roomFor('alpha beta');
  const alice = makeEdit('alpha beta', 'ALPHA beta');
  const bob = makeEdit('alpha beta', 'alpha BETA');
  const fromAlice = room.commit('alice', 1, 0, alice);
  const fromBob = room.commit('bob', 1, 0, bob);

  // Bob's client sees Alice's op first and must rebase its own pending edit.
  const [bobPrime, alicePrime] = transformPair(bob, alice);
  assert.equal(room.text, apply(apply('alpha beta', alice), bobPrime));
  assert.equal(apply(apply('alpha beta', bob), alicePrime), room.text);
  assert.equal(fromBob.revision, 2);
});

test('an edit built on an old revision is rebased instead of dropped', async () => {
  const room = await roomFor('one two three');
  room.commit('a', 1, 0, makeEdit('one two three', 'one 2 three'));
  // Stale op: built against the original text, wants "one two 3".
  const stale = makeEdit('one two three', 'one two 3');
  const entry = room.commit('b', 2, 0, stale);
  assert.equal(room.text, 'one 2 3');
  assert.equal(entry.revision, 2);
});

test('edits older than the operation log ask the client to resync', async () => {
  const room = await roomFor('seed');
  room.doc.revision = 5000;
  assert.throws(() => room.commit('a', 1, 1, [{ retain: 0 }, { insert: 'x' }]), (err) => {
    assert.ok(err instanceof Rejected);
    assert.equal(err.resync, true);
    return true;
  });
});

test('malformed operations are rejected without touching the document', async () => {
  const room = await roomFor('unchanged');
  const cases = [
    ['wrong length', [{ retain: 99 }]],
    ['garbage shape', [{ nope: 1 }]],
    ['negative count', [{ retain: -3 }]],
    ['too many components', Array.from({ length: 600 }, () => ({ retain: 0 }))],
  ];
  for (const [label, op] of cases) {
    assert.throws(() => room.commit('a', 1, 0, op), Rejected, label);
  }
  assert.equal(room.text, 'unchanged');
  assert.equal(room.revision, 0);
});

test('peer cursors follow remote edits instead of drifting', async () => {
  const room = await roomFor('hello world');
  room.join({ clientId: 'alice', name: 'Alice', color: '#fff', selection: { start: 3, end: 3 } });
  room.join({ clientId: 'bob', name: 'Bob', color: '#000', selection: { start: 9, end: 9 } });
  room.commit('alice', 1, 0, makeEdit('hello world', 'XY hello world'));
  assert.deepEqual(room.clients.get('bob').selection, { start: 12, end: 12 });
  assert.deepEqual(room.clients.get('alice').selection, { start: 3, end: 3 });
});

test('renaming persists through the store', async () => {
  const room = await roomFor('x');
  assert.equal(room.setTitle('  Fresh title  '), true);
  assert.equal(room.title, 'Fresh title');
  assert.equal(room.setTitle('Fresh title'), false);
  await room.store.flush();
  assert.equal(room.store.get(room.id).title, 'Fresh title');
});

test('a room refuses to materialise an unknown document by default', async () => {
  const store = new Store(await mkdtemp(path.join(tmpdir(), 'doc-room-')));
  await store.init();
  assert.throws(() => new Room(store, 'missing'), /does not exist/);
  const created = new Room(store, 'made-now', 'Draft');
  assert.equal(created.title, 'Draft');
});
