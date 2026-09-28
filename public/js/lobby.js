const el = (id) => document.getElementById(id);
const docs = el('docs');
const who = el('who');

who.value = localStorage.getItem('doc-online:name') ?? '';
who.addEventListener('change', () => {
  const name = who.value.trim().slice(0, 32);
  if (name) localStorage.setItem('doc-online:name', name);
  else who.value = localStorage.getItem('doc-online:name') ?? '';
});

const relative = (then) => {
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(then).toLocaleDateString();
};

function row(doc) {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'doc-link';
  link.href = `/editor.html?doc=${encodeURIComponent(doc.id)}`;
  link.textContent = doc.title;

  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = `rev ${doc.revision} · ${relative(doc.updatedAt)}`;

  const actions = document.createElement('span');
  actions.className = 'row-actions';

  const view = document.createElement('a');
  view.className = 'tiny';
  view.href = `/editor.html?doc=${encodeURIComponent(doc.id)}&mode=view`;
  view.textContent = 'read-only';

  const remove = document.createElement('button');
  remove.className = 'tiny danger';
  remove.textContent = 'delete';
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete “${doc.title}”? This cannot be undone.`)) return;
    await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
    load();
  });

  actions.append(view, remove);
  li.append(link, meta, actions);
  return li;
}

async function load() {
  const res = await fetch('/api/docs');
  const { docs: list } = await res.json();
  el('count').textContent = list.length ? `(${list.length})` : '';
  docs.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No documents yet — create one above.';
    docs.append(li);
    return;
  }
  for (const doc of list) docs.append(row(doc));
}

el('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = el('new-title').value.trim() || 'Untitled document';
  const res = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text: '' }),
  });
  const { doc, error } = await res.json();
  if (error) return alert(error);
  location.href = `/editor.html?doc=${encodeURIComponent(doc.id)}`;
});

el('open-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = el('open-doc').value.trim();
  if (!raw) return;
  const fromUrl = /[*&?]doc=([\w-]+)/.exec(raw)?.[1] ?? (/^\/editor\.html\?doc=([\w-]+)/.exec(raw)?.[1] ?? null);
  const id = fromUrl ?? raw.split('/').pop();
  location.href = `/editor.html?doc=${encodeURIComponent(id)}`;
});

load();
