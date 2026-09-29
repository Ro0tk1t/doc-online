import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { Users } from '../server/users.mjs';
import { Sessions } from '../server/sessions.mjs';
import {
  COOKIE_NAME,
  Throttle,
  assertName,
  assertPassword,
  assertSameOrigin,
  cookieHeader,
  hashPassword,
  logoutHeader,
  parseCookies,
  verifyPassword,
} from '../server/auth.mjs';
import { accessOf, requireRole, roleFor, visibleTo } from '../server/access.mjs';
import { makeEdit } from '../shared/ot.mjs';
import { Client, openSocket } from './client.mjs';

const PASSWORD = 'correct horse battery';

/* ------------------------------------------------------------------ primitives */

test('names and passwords are cleaned, not guessed at', () => {
  assert.equal(assertName(' Ada L. '), 'Ada L.');
  assert.equal(assertName('张三'), '张三');
  assert.throws(() => assertName('a'), /at least 2/);
  assert.throws(() => assertName('  '), /at least 2/);
  assert.throws(() => assertName('<script>'), /letters, numbers/);
  assert.equal(assertName(`x${'y'.repeat(60)}`).length, 32);

  assert.equal(assertPassword('12345678'), '12345678');
  assert.throws(() => assertPassword('short'), /at least 8/);
  assert.throws(() => assertPassword('   '), /at least 8/);
  assert.throws(() => assertPassword(undefined), /password is required/);
});

test('a password hash verifies, and a wrong one does not', async () => {
  const record = await hashPassword(PASSWORD);
  assert.notEqual(record.pass, '');
  assert.equal(await verifyPassword(PASSWORD, record), true);
  assert.equal(await verifyPassword(`${PASSWORD}!`, record), false);
  // Two hashes of the same password differ: the salt is per user.
  assert.notEqual((await hashPassword(PASSWORD)).pass, record.pass);
  // Junk records read as "wrong password", never as a crash.
  assert.equal(await verifyPassword(PASSWORD, null), false);
  assert.equal(await verifyPassword(PASSWORD, { salt: 'zz', pass: 'nope' }), false);
});

test('the session cookie is HttpOnly, SameSite=Lax, and Secure only over https', () => {
  const plain = { socket: {}, headers: {} };
  assert.match(cookieHeader('tok', plain), new RegExp(`^${COOKIE_NAME}=tok;`));
  assert.match(cookieHeader('tok', plain), /HttpOnly/);
  assert.match(cookieHeader('tok', plain), /SameSite=Lax/);
  assert.match(cookieHeader('tok', plain), /Path=\//);
  assert.doesNotMatch(cookieHeader('tok', plain), /Secure/);
  assert.match(cookieHeader('tok', { socket: {}, headers: { 'x-forwarded-proto': 'https' } }), /Secure/);
  assert.match(cookieHeader('tok', { socket: { encrypted: true }, headers: {} }), /Secure/);
  assert.match(logoutHeader(plain), /Max-Age=0/);

  assert.deepEqual(parseCookies('a=1; doc_auth=t%2F1; b=2'), { a: '1', doc_auth: 't/1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('a mutating request from another site is refused, a same-origin one is not', () => {
  const host = 'docs.example.com';
  assert.equal(assertSameOrigin({ method: 'GET', headers: { host, origin: 'https://evil.example' } }), true);
  assert.equal(assertSameOrigin({ method: 'POST', headers: { host, origin: `https://${host}` } }), true);
  assert.equal(assertSameOrigin({ method: 'POST', headers: { host } }), true); // curl sends no Origin
  assert.throws(() => assertSameOrigin({ method: 'POST', headers: { host, origin: 'https://evil.example' } }), /cross-origin/);
  assert.throws(() => assertSameOrigin({ method: 'DELETE', headers: { host, referer: 'https://evil.example/page' } }), /cross-origin/);
  assert.equal(assertSameOrigin({ method: 'POST', headers: { host, referer: `https://${host}/x` } }), true);
});

test('the throttle counts failures per key, then waits them out', () => {
  const now = 1_000_000;
  const throttle = new Throttle({ window: 60_000, threshold: 3, step: 30_000 });
  assert.equal(throttle.check('k', now), 0);
  assert.equal(throttle.fail('k', now), 0); // 1
  assert.equal(throttle.fail('k', now), 0); // 2
  assert.equal(throttle.fail('k', now), 30); // 3: reaching the threshold costs a wait
  assert.equal(throttle.check('k', now), 30);
  assert.equal(throttle.fail('k', now), 60); // 4: every further failure adds a step
  assert.equal(throttle.check('other', now), 0); // another account is not held up
  throttle.clear('k');
  assert.equal(throttle.check('k', now), 0);

  // It is the window that resets the count: a slow guesser never builds up a block.
  const slow = new Throttle({ window: 60_000, threshold: 3, step: 30_000 });
  slow.fail('k', now);
  assert.equal(slow.fail('k', now + 40_000), 0);
  assert.equal(slow.fail('k', now + 80_000), 0); // the first entry has fallen out of the window
  assert.equal(slow.check('k', now + 80_000), 0);
});

/* ------------------------------------------------------------------ records */

async function userStore(prefix = 'doc-users-') {
  const users = new Users(await mkdtemp(path.join(tmpdir(), prefix)));
  await users.init();
  return users;
}

test('the first account to sign up runs the place', async () => {
  const users = await userStore();
  const first = await users.create({ name: 'Ada', password: PASSWORD });
  assert.equal(first.role, 'admin');
  const second = await users.create({ name: 'Bob', password: PASSWORD });
  assert.equal(second.role, 'user');
  assert.equal(users.size, 2);

  await assert.rejects(() => users.create({ name: 'bob', password: PASSWORD }), /taken/); // names are one key, any case
  assert.equal((await users.login({ name: 'Ada', password: PASSWORD })).id, first.id);
  assert.equal(await users.login({ name: 'Ada', password: 'wrong password' }), null);
  assert.equal(await users.login({ name: 'nobody', password: PASSWORD }), null);

  // The password hash is the part that must not be handed out.
  assert.deepEqual(Object.keys(users.list()[0]).sort(), ['createdAt', 'disabled', 'id', 'name', 'role']);

  const reloaded = new Users(path.dirname(users.path));
  await reloaded.init();
  assert.equal(reloaded.size, 2);
  assert.equal((await reloaded.login({ name: 'Bob', password: PASSWORD })).id, second.id);
});

test('the last admin cannot be disabled or demoted, and sessions die with an account', async () => {
  const users = await userStore();
  const admin = await users.create({ name: 'Ada', password: PASSWORD });
  await users.create({ name: 'Bob', password: PASSWORD });
  assert.throws(() => users.setDisabled(admin.id, true), /last admin/);
  assert.throws(() => users.setRole(admin.id, 'user'), /last admin/);

  const bob = users.byKey.get('bob');
  assert.equal(users.setDisabled(bob.id, true).disabled, true);
  assert.equal(await users.login({ name: 'Bob', password: PASSWORD }), null); // right password, closed account
  assert.equal(users.setRole(bob.id, 'admin').role, 'admin');
  assert.equal(users.setDisabled(bob.id, false).disabled, false);
  // With two live admins, switching either one off is allowed.
  assert.equal(users.setDisabled(bob.id, true).disabled, true);
  // A disabled admin does not count as cover: Ada is the last one who can still sign in.
  assert.throws(() => users.setRole(admin.id, 'user'), /last admin/);
  assert.equal(users.setDisabled(bob.id, false).disabled, false);
  assert.equal(users.setRole(admin.id, 'user').role, 'user');

  await assert.rejects(() => users.create({ name: 'Ada', password: PASSWORD }), /taken/);
});

test('sessions resolve, expire on an absolute clock, and can be dropped per account', async () => {
  let now = 1_000;
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-sessions-'));
  const sessions = new Sessions(dir, { ttl: 5_000, now: () => now });
  await sessions.init();
  const a = sessions.create('ada');
  const b = sessions.create('ada');
  sessions.create('bob');
  assert.equal(sessions.size, 3);
  assert.equal(sessions.resolve(a), 'ada');

  now = 4_000;
  assert.equal(sessions.resolve(a), 'ada');
  now = 6_000; // the record is 5s old: it is gone, and gone for the whole account
  assert.equal(sessions.resolve(a), null);
  assert.equal(sessions.dropForUser('bob'), 1);
  assert.equal(sessions.resolve(b), null);
  assert.equal(sessions.size, 0);

  const reloaded = new Sessions(dir, { ttl: 5_000, now: () => now });
  await sessions.flush(); // one writer at a time: two live ledgers on one file is not a real setup
  await reloaded.init();
  assert.equal(reloaded.size, 0); // expired rows are not read back in
  now = 1_000;
  const c = reloaded.create('ada');
  await reloaded.flush(); // the ledger is written on a queue, so a restart reads the file
  const third = new Sessions(dir, { ttl: 5_000, now: () => now });
  await third.init();
  assert.equal(third.resolve(c), 'ada');
});

/* ------------------------------------------------------------------ the rules */

const DOC = { id: 'd1', owner: 'ada', visibility: 'private', grants: [{ user: 'bob', role: 'editor' }] };
const as = (userId, admin = false) => ({ userId, admin });

test('a role comes out of ownership, grants, visibility and admin, in that order', () => {
  assert.equal(roleFor(DOC, as('ada')), 'owner');
  assert.equal(roleFor(DOC, as('bob')), 'editor');
  assert.equal(roleFor(DOC, as('carl')), null);
  assert.equal(roleFor(DOC, as('carl', true)), 'owner'); // an admin reads every document as its owner
  assert.equal(roleFor(DOC, null), null);
  assert.equal(roleFor({ ...DOC, grants: [{ user: 'dee', role: 'viewer' }] }, as('dee')), 'viewer');
  assert.equal(roleFor({ ...DOC, visibility: 'public' }, as('carl')), 'reader');
  assert.equal(roleFor({ ...DOC, visibility: 'public' }, null), 'reader');
  assert.equal(roleFor(null, as('ada')), null);

  assert.equal(requireRole(DOC, as('ada'), 'manage'), 'owner');
  assert.equal(requireRole(DOC, as('bob'), 'read'), 'editor');
  assert.throws(() => requireRole(DOC, as('bob'), 'manage'), (err) => err.statusCode === 403 && err.code === 'not_owner');
  assert.throws(() => requireRole(DOC, null, 'read'), (err) => err.statusCode === 403 && err.code === 'need_login');
  assert.throws(() => requireRole(DOC, as('carl'), 'read'), (err) => err.code === 'forbidden');
  const shared = { ...DOC, grants: [{ user: 'dee', role: 'viewer' }] };
  assert.equal(requireRole(shared, as('dee'), 'read'), 'viewer');
  assert.throws(() => requireRole(shared, as('dee'), 'edit'), (err) => err.statusCode === 403 && err.code === 'read_only');
  assert.equal(requireRole({ ...DOC, visibility: 'public' }, null, 'read'), 'reader');
  assert.throws(() => requireRole({ ...DOC, visibility: 'public' }, null, 'edit'), (err) => err.code === 'read_only');

  assert.equal(accessOf(DOC, as('bob')).canEdit, true);
  assert.equal(accessOf(DOC, as('bob')).canManage, false);
  assert.equal(accessOf({ ...DOC, visibility: 'public' }, null).role, 'reader');
  assert.equal(visibleTo(DOC, as('carl')), false);
  assert.equal(visibleTo({ ...DOC, visibility: 'public' }, as('carl')), true);
});

/* ------------------------------------------------------------------ over HTTP */

async function app() {
  const server = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'doc-auth-')) });
  const base = `http://127.0.0.1:${server.port}`;
  return { app: server, base, client: () => new Client(base) };
}

test('signup, login, me and logout over the wire', async () => {
  const { app: server, client: newClient } = await app();
  const anon = newClient();
  try {
    assert.equal((await anon.post('/api/login', { name: 'nobody', password: PASSWORD })).status, 401);
    assert.equal((await anon.post('/api/signup', { name: 'x', password: PASSWORD })).status, 400);
    assert.equal((await anon.post('/api/signup', { name: 'Ada', password: 'short' })).status, 400);

    const me = await anon.api('/api/me');
    assert.equal(me.body.user, null);
    assert.equal(me.body.firstUser, true);

    const signed = newClient();
    const created = await signed.post('/api/signup', { name: 'Ada', password: PASSWORD });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, 'admin');
    assert.match(signed.cookies.get(COOKIE_NAME), /.{16,}/);
    // The cookie is the whole session: the response body must not carry secrets.
    assert.equal(created.body.user.pass, undefined);
    assert.equal(created.body.user.salt, undefined);

    assert.equal((await newClient().post('/api/signup', { name: 'Ada', password: PASSWORD })).status, 409);

    const second = newClient();
    await second.signup('Bob');
    assert.equal((await second.api('/api/me')).body.user.role, 'user');
    assert.equal((await second.api('/api/me')).body.firstUser, false);

    const again = newClient();
    assert.equal((await again.post('/api/login', { name: 'Bob', password: PASSWORD })).status, 200);
    assert.equal((await again.post('/api/login', { name: 'Bob', password: 'not my password' })).status, 401);

    assert.equal((await again.post('/api/logout', {})).status, 200);
    assert.equal(again.cookies.size, 0);
    assert.equal((await again.api('/api/me')).body.user, null);
    assert.equal(server.users.size, 2);
    assert.equal(server.sessions.size, 2); // logging out dropped only this session
  } finally {
    await server.close();
  }
});

test('guessing a password gets throttled, and the good login still works afterwards', async () => {
  const { app: server, client: newClient } = await app();
  const victim = newClient();
  await victim.signup('Ada');
  const attacker = newClient();
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attacker.post('/api/login', { name: 'Ada', password: 'wrong password' })).status, 401);
    }
    const blocked = await attacker.post('/api/login', { name: 'Ada', password: 'wrong password' });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body.retryAfter >= 30);
    // The throttle counts per name, so another account is unaffected.
    const other = newClient();
    assert.equal((await other.post('/api/login', { name: 'nobody', password: 'wrong password' })).status, 401);
    // A cross-origin form cannot use the endpoint at all, throttled or not.
    assert.equal(
      (await other.api('/api/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status,
      403,
    );
    assert.match((await victim.api('/api/me')).body.user.name, /Ada/);
  } finally {
    await server.close();
  }
});

test('a private document is invisible, a public one is anonymously readable', async () => {
  const { app: server, client: newClient } = await app();
  const ada = newClient();
  await ada.signup('Ada');
  const bob = newClient();
  await bob.signup('Bob');
  const anon = newClient();
  try {
    const doc = await ada.createDoc({ title: 'Diary', text: 'not for you' });

    assert.equal((await ada.api(`/api/docs/${doc.id}`)).status, 200);
    assert.equal((await ada.api(`/api/docs/${doc.id}`)).body.access.ownerName, 'Ada');
    const stranger = await bob.api(`/api/docs/${doc.id}`);
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.code, 'forbidden');
    const anonymous = await anon.api(`/api/docs/${doc.id}`);
    assert.equal(anonymous.status, 403);
    assert.equal(anonymous.body.code, 'need_login');

    assert.deepEqual((await bob.api('/api/docs')).body.docs.map((entry) => entry.id), []);
    assert.deepEqual((await ada.api('/api/docs')).body.docs.map((entry) => entry.id), [doc.id]);
    assert.deepEqual((await anon.api('/api/docs')).body.docs, []);

    // Creating takes an account: the anonymous library stays empty.
    assert.equal((await anon.post('/api/docs', { title: 'mine' })).status, 401);
    assert.equal((await anon.api(`/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"title":"hijack"}' })).status, 403);
    assert.equal((await anon.api(`/api/docs/${doc.id}`, { method: 'DELETE' })).status, 403);

    // Share it with Bob as an editor, and nothing changes for anyone else.
    const bobId = (await bob.api('/api/me')).body.user.id;
    const shared = await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'editor' }] }),
    });
    assert.equal(shared.status, 200);
    assert.deepEqual(shared.body.access.grants, [{ user: bobId, role: 'editor', name: 'Bob' }]);
    assert.equal((await bob.api(`/api/docs/${doc.id}`)).body.access.role, 'editor');
    assert.equal((await bob.api('/api/docs')).body.docs.length, 1);

    // Bob may edit, but not decide who else gets in, and not delete it.
    assert.equal(
      (await bob.api(`/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"title":"renamed"}' })).status,
      200,
    );
    assert.equal((await bob.api(`/api/docs/${doc.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await bob.api(`/api/docs/${doc.id}/access`)).body.access.role, 'editor');
    const carl = newClient();
    await carl.signup('Carl');
    assert.equal((await carl.api(`/api/docs/${doc.id}/access`)).status, 403);

    // A viewer is read-only on every door: REST and the attachment list alike.
    const dee = newClient();
    await dee.signup('Dee');
    const deeId = (await dee.api('/api/me')).body.user.id;
    await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'editor' }, { user: deeId, role: 'viewer' }] }),
    });
    assert.equal((await dee.api(`/api/docs/${doc.id}`)).body.access.canEdit, false);
    assert.equal((await dee.api(`/api/docs/${doc.id}/files`)).status, 200);
    assert.equal((await dee.api(`/api/docs/${doc.id}/files?name=a.txt&type=text/plain`, { method: 'PUT', body: Buffer.from('x') })).status, 403);

    // Now the world can read it, and still nobody but the owner can manage it.
    await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    const open = await anon.api(`/api/docs/${doc.id}`);
    assert.equal(open.status, 200);
    assert.equal(open.body.access.role, 'reader');
    assert.equal((await anon.api('/api/docs')).body.docs.length, 1);
    assert.equal((await anon.api(`/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"title":"nope"}' })).status, 403);
    // The share list is not part of the public text: reading it takes an account.
    const anonList = await anon.api(`/api/docs/${doc.id}/access`);
    assert.equal(anonList.status, 401);
    assert.equal(anonList.body.code, 'need_login');
    // Opening a public document says what you may do, not who else may do it.
    assert.deepEqual((await anon.api(`/api/docs/${doc.id}`)).body.access.grants, []);
    assert.equal((await anon.api('/api/docs')).body.docs[0].grants, undefined);
    assert.equal((await ada.api(`/api/docs/${doc.id}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"visibility":"sideways"}' })).status, 400);
    assert.equal((await ada.api(`/api/docs/${doc.id}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"grants":[{"user":"ghost","role":"editor"}]}' })).status, 400);
    assert.equal((await ada.api(`/api/docs/${doc.id}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"grants":[{"user":123,"role":"boss"}]}' })).status, 400);

    // Only an owner can put it back to private.
    assert.equal((await bob.api(`/api/docs/${doc.id}/access`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"visibility":"private"}' })).status, 403);
  } finally {
    await server.close();
  }
});

test('an admin reaches every document and can shut an account down', async () => {
  const { app: server, client: newClient } = await app();
  const ada = newClient();
  await ada.signup('Ada'); // first: admin
  const bob = newClient();
  const bobUser = await bob.signup('Bob');
  try {
    const doc = await bob.createDoc({ title: 'Bob private', text: 'hidden' });
    assert.equal((await ada.api(`/api/docs/${doc.id}`)).body.access.role, 'owner');
    assert.equal(
      (await ada.api(`/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"title":"taken over"}' })).status,
      200,
    );

    assert.equal((await bob.api('/api/admin/users')).status, 403);
    const listed = await ada.api('/api/admin/users');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.users.map((u) => u.name), ['Ada', 'Bob']);

    // The share panel may look people up, but only while signed in.
    assert.equal((await newClient().api('/api/users?q=bo')).status, 401);
    assert.deepEqual((await ada.api('/api/users?q=bo')).body.users.map((u) => u.name), ['Bob']);
    assert.deepEqual((await ada.api('/api/users')).body.users, []);

    assert.equal((await ada.api(`/api/admin/users/${doc.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"role":"admin"}' })).status, 404);
    const promoted = await ada.api(`/api/admin/users/${bobUser.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"role":"admin"}' });
    assert.equal(promoted.body.user.role, 'admin');

    const disabled = await ada.api(`/api/admin/users/${bobUser.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"disabled":true}' });
    assert.equal(disabled.body.user.disabled, true);
    // Every tab of a disabled account stops working at once: its cookie no longer resolves.
    assert.equal((await bob.api('/api/me')).body.user, null);
    assert.equal((await bob.api(`/api/docs/${doc.id}`)).status, 403);
    assert.equal((await bob.post('/api/login', { name: 'Bob', password: PASSWORD })).status, 401);
    assert.equal(server.sessions.resolve(bob.cookies.get(COOKIE_NAME)), null);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ over the socket */

test('the socket authorizes at the door, and a sharing change lands live', async () => {
  const { app: server, base, client: newClient } = await app();
  const wsBase = base.replace('http', 'ws');
  const ada = newClient();
  await ada.signup('Ada');
  const bob = newClient();
  await bob.signup('Bob');
  const dee = newClient();
  await dee.signup('Dee');
  const sockets = [];
  try {
    const doc = await ada.createDoc({ title: 'Private', text: 'secret' });
    const bobId = (await bob.api('/api/me')).body.user.id;
    const deeId = (await dee.api('/api/me')).body.user.id;

    // An anonymous peer cannot even open a private room.
    const refused = await openSocket(`${wsBase}/ws?doc=${doc.id}&client=anon1111`);
    sockets.push(refused);
    assert.equal((await refused.waitFor((m) => m.type === 'error')).code, 'need_login');
    assert.equal((await refused.closed).code, 4003);

    // Neither can a signed-in stranger.
    const stranger = await dee.open(`${wsBase}/ws?doc=${doc.id}&client=dee00001`);
    sockets.push(stranger);
    assert.equal((await stranger.waitFor((m) => m.type === 'error')).code, 'forbidden');
    assert.equal((await stranger.closed).code, 4003);

    await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'editor' }, { user: deeId, role: 'viewer' }] }),
    });

    const editor = await bob.open(`${wsBase}/ws?doc=${doc.id}&client=bob00001`);
    const viewer = await dee.open(`${wsBase}/ws?doc=${doc.id}&client=dee00002`);
    sockets.push(editor, viewer);
    const e0 = await editor.waitFor((m) => m.type === 'doc');
    const v0 = await viewer.waitFor((m) => m.type === 'doc');
    assert.equal(e0.access.role, 'editor');
    assert.equal(v0.access.role, 'viewer');
    assert.equal(v0.access.canEdit, false);
    assert.equal(v0.visibility, 'private');
    assert.equal(v0.owner, (await ada.api('/api/me')).body.user.id);

    editor.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: e0.revision, op: makeEdit(e0.text, 'shared edit') }));
    assert.equal((await editor.waitFor((m) => m.type === 'ack')).length, 'shared edit'.length);
    assert.equal((await viewer.waitFor((m) => m.type === 'op')).from, 'bob00001');

    // A viewer who types anyway is refused, and the text does not move.
    viewer.send(JSON.stringify({ type: 'edit', seq: 1, baseRevision: v0.revision, op: makeEdit(v0.text, 'nope') }));
    assert.match((await viewer.waitFor((m) => m.type === 'error')).message, /read-only/);

    // A read-only link stays read-only even for an editor.
    const asView = await bob.open(`${wsBase}/ws?doc=${doc.id}&client=bob00002&mode=view`);
    sockets.push(asView);
    assert.equal((await asView.waitFor((m) => m.type === 'doc')).access.canEdit, false);

    // Take Dee's access away: her socket learns it, then leaves. Bob keeps his rights.
    await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'editor' }] }),
    });
    assert.equal((await editor.waitFor((m) => m.type === 'stale')).access.role, 'editor');
    assert.equal((await viewer.closed).code, 4003);
    assert.equal(server.hub.peers(doc.id).some((peer) => peer.clientId === 'dee00002'), false);

    // Downgrade Bob to viewer: his open socket is told, without a reload.
    await ada.api(`/api/docs/${doc.id}/access`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ user: bobId, role: 'viewer' }] }),
    });
    const changed = await editor.waitFor((m) => m.type === 'stale' && m.access.role === 'viewer');
    assert.equal(changed.access.role, 'viewer');
    assert.equal(changed.reason, 'sharing changed');
    editor.send(JSON.stringify({ type: 'edit', seq: 2, baseRevision: changed.revision, op: makeEdit(changed.text, 'still mine') }));
    assert.match((await editor.waitFor((m) => m.type === 'error')).message, /read-only/);
  } finally {
    for (const ws of sockets) ws.close();
    await server.close();
  }
});

test('a document survives a restart with its access intact', async () => {
  const { app: first, client: newClient } = await app();
  const dataDir = first.store.root;
  const ada = newClient();
  const adaUser = await ada.signup('Ada');
  const doc = await ada.createDoc({ title: 'Kept', text: 'still mine' });
  const bob = newClient();
  const bobUser = await bob.signup('Bob');
  await ada.api(`/api/docs/${doc.id}/access`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'public', grants: [{ user: bobUser.id, role: 'viewer' }] }),
  });
  const cookie = ada.cookies.get(COOKIE_NAME);
  await first.close();

  const restarted = await createServer({ dataDir });
  try {
    const client = new Client(`http://127.0.0.1:${restarted.port}`);
    client.cookies.set(COOKIE_NAME, cookie); // the same browser comes back
    assert.equal((await client.api('/api/me')).body.user.id, adaUser.id);
    const reopened = await client.api(`/api/docs/${doc.id}`);
    assert.equal(reopened.body.doc.text, 'still mine');
    assert.equal(reopened.body.access.role, 'owner');
    assert.equal(reopened.body.access.visibility, 'public');
    assert.deepEqual(reopened.body.access.grants, [{ user: bobUser.id, role: 'viewer', name: 'Bob' }]);
    assert.equal(restarted.users.size, 2);
    assert.equal((await client.api(`/api/docs/${doc.id}`, { method: 'DELETE' })).body.deleted, true);
  } finally {
    await restarted.close();
  }
});
