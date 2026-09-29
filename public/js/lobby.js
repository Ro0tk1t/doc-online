const el = (id) => document.getElementById(id);
const docs = el('docs');

let me = null;
let firstUser = false;

const relative = (then) => {
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(then).toLocaleDateString();
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (HTTP ${res.status})`);
  return body;
}

const showError = (message) => {
  const box = el('auth-error');
  box.textContent = message ?? '';
  box.hidden = !message;
};

function badge(text, kind) {
  const span = document.createElement('span');
  span.className = 'badge';
  span.dataset.kind = kind;
  span.textContent = text;
  return span;
}

function row(doc) {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'doc-link';
  link.href = `/editor.html?doc=${encodeURIComponent(doc.id)}`;
  link.textContent = doc.title;

  const badges = document.createElement('span');
  badges.className = 'row-actions';
  // The server decided `role` for this very visitor, so the badge is the same answer the
  // editor will get when the link is opened. A dashed badge is the read-only one.
  badges.append(badge(doc.role, doc.role === 'owner' ? 'owner' : doc.role === 'reader' ? 'weak' : 'role'));
  if (doc.visibility === 'public') badges.append(badge('public', 'public'));

  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = `${doc.ownerName ? `by ${doc.ownerName} · ` : ''}rev ${doc.revision} · ${relative(doc.updatedAt)}`;

  const actions = document.createElement('span');
  actions.className = 'row-actions';

  if (doc.canEdit) {
    const view = document.createElement('a');
    view.className = 'tiny';
    view.href = `/editor.html?doc=${encodeURIComponent(doc.id)}&mode=view`;
    view.textContent = 'read-only';
    actions.append(view);
  }
  if (doc.canManage) {
    const remove = document.createElement('button');
    remove.className = 'tiny danger';
    remove.textContent = 'delete';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${doc.title}”? This cannot be undone.`)) return;
      try {
        await api(`/api/docs/${doc.id}`, { method: 'DELETE' });
      } catch (err) {
        showError(err.message);
      }
      load();
    });
    actions.append(remove);
  }

  li.append(link, badges, meta, actions);
  return li;
}

function adminRow(user) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'doc-link';
  name.textContent = user.name;

  const badges = document.createElement('span');
  badges.className = 'row-actions';
  badges.append(badge(user.role, user.role === 'admin' ? 'owner' : 'role'));
  if (user.disabled) badges.append(badge('disabled', 'weak'));

  const actions = document.createElement('span');
  actions.className = 'row-actions';
  const toggle = async (payload) => {
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'POST', body: JSON.stringify(payload) });
      showError('');
    } catch (err) {
      showError(err.message); // "the last admin cannot be disabled" arrives here
    }
    load();
  };
  const role = document.createElement('button');
  role.className = 'tiny ghost';
  role.textContent = user.role === 'admin' ? 'make user' : 'make admin';
  role.addEventListener('click', () => toggle({ role: user.role === 'admin' ? 'user' : 'admin' }));
  const off = document.createElement('button');
  off.className = 'tiny danger';
  off.textContent = user.disabled ? 'enable' : 'disable';
  off.addEventListener('click', () => toggle({ disabled: !user.disabled }));
  actions.append(role, off);

  li.append(name, badges, actions);
  return li;
}

function paintAccount() {
  el('signed-in').hidden = !me;
  el('signed-out').hidden = Boolean(me);
  el('create-hint').hidden = Boolean(me);
  el('first-user').hidden = !firstUser || Boolean(me);
  el('new-title').disabled = !me;
  el('create').querySelector('button').disabled = !me;
  if (!me) return;
  el('me-name').textContent = me.name;
  el('me-role').textContent = me.role;
  el('me-role').dataset.kind = me.role === 'admin' ? 'owner' : 'role';
}

async function load() {
  const [list, who] = await Promise.all([api('/api/docs'), api('/api/me')]);
  me = who.user;
  firstUser = who.firstUser;
  paintAccount();

  el('count').textContent = list.docs.length ? `(${list.docs.length})` : '';
  docs.replaceChildren();
  if (!list.docs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = me ? 'No documents you can see — create one above.' : 'No public documents, and nothing is shared with you.';
    docs.append(li);
  }
  for (const doc of list.docs) docs.append(row(doc));

  const admin = el('admin');
  admin.hidden = me?.role !== 'admin';
  if (admin.hidden) return;
  const { users } = await api('/api/admin/users');
  el('admin-users').replaceChildren(...users.map(adminRow));
}

el('auth').addEventListener('submit', async (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.action ?? 'login';
  const name = el('auth-name').value.trim();
  const password = el('auth-password').value;
  if (!name || !password) return showError('A name and a password are both needed.');
  try {
    const body = await api(`/api/${action}`, { method: 'POST', body: JSON.stringify({ name, password }) });
    me = body.user;
    showError('');
    el('auth-password').value = '';
    await load();
  } catch (err) {
    showError(err.message);
  }
});

el('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  me = null;
  await load();
});

el('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = el('new-title').value.trim() || 'Untitled document';
  try {
    const { doc } = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title, text: '' }) });
    location.href = `/editor.html?doc=${encodeURIComponent(doc.id)}`;
  } catch (err) {
    showError(err.message);
  }
});

el('open-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = el('open-doc').value.trim();
  if (!raw) return;
  const fromUrl = /[*&?]doc=([\w-]+)/.exec(raw)?.[1] ?? (/^\/editor\.html\?doc=([\w-]+)/.exec(raw)?.[1] ?? null);
  location.href = `/editor.html?doc=${encodeURIComponent(fromUrl ?? raw.split('/').pop())}`;
});

// A refused editor page sends you here with the document it wanted.
const wanted = new URLSearchParams(location.search).get('doc');
if (wanted) el('open-doc').value = wanted;

const ready = load().catch((err) => showError(err.message));
if (wanted) ready.then(() => el('open-doc').focus());
