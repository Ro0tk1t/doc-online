/**
 * Attachment panel.
 *
 * Bytes go to the REST endpoint through the session; the resulting list arrives back over
 * the WebSocket, so every peer's panel updates from the same event whether they uploaded
 * or somebody else did. Markdown references are handed to the editor for insertion so the
 * text still travels as an operation.
 */

const MAX_PREVIEW = 4 * 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function timeAgo(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const isImage = (file) => /^image\//.test(file.type ?? '');

export class Attachments {
  constructor({ session, source, insert, notify }) {
    this.session = session;
    this.source = source;
    this.insert = insert;
    this.notify = notify;
    this.files = [];
    this.pane = document.getElementById('filesPane');
    this.list = document.getElementById('files');
    this.empty = document.getElementById('filesEmpty');
    this.count = document.getElementById('files-count');
    this.pending = 0;

    // Both pickers are the same upload; `accept="image/*"` is only what the dialog offers, so the
    // image one checks the files it got as well -- a picker that says images must not store a .zip.
    for (const [picker, imagesOnly] of [
      [document.getElementById('attach'), false],
      [document.getElementById('image'), true],
    ]) {
      picker.addEventListener('change', () => {
        this.#pick([...picker.files], imagesOnly);
        picker.value = ''; // picking the same file twice must ask again
      });
    }

    document.getElementById('files-toggle').addEventListener('click', () => this.toggle());
    document.getElementById('files-close').addEventListener('click', () => this.open(false));
    this.list.addEventListener('click', (event) => this.#act(event));

    // Dropped and pasted files are refused by `upload`, not by leaving the handlers unwired:
    // whether this tab may write is an answer the server gives after construction.
    source.addEventListener('dragover', (event) => {
      event.preventDefault();
      source.closest('.pane').classList.add('dropping');
    });
    source.addEventListener('dragleave', () => source.closest('.pane').classList.remove('dropping'));
    source.addEventListener('drop', (event) => {
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (!dropped.length) return;
      event.preventDefault();
      source.closest('.pane').classList.remove('dropping');
      this.upload(dropped);
    });
    source.addEventListener('paste', (event) => {
      const pasted = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!pasted.length) return;
      event.preventDefault();
      this.upload(pasted);
    });
  }

  open(on = true) {
    this.pane.hidden = !on;
  }

  toggle() {
    this.open(this.pane.hidden);
  }

  /** Called for the initial snapshot and for every `files` broadcast. */
  setFiles(files) {
    this.files = files ?? [];
    this.render();
  }

  reference(file) {
    const url = this.session.urlFor(file);
    // Brackets and newlines would break the Markdown link the name is embedded in.
    const label = String(file.name ?? 'file').replace(/[[\]\n\r]/g, ' ').trim() || 'file';
    return isImage(file) ? `![${label}](${url})` : `[📎 ${label}](${url})`;
  }

  /** What a picker handed over. The image one keeps only images, and says when it dropped some. */
  #pick(chosen, imagesOnly) {
    if (!imagesOnly) return this.upload(chosen);
    const pictures = chosen.filter(isImage);
    if (pictures.length !== chosen.length) this.notify('Images only here — other files go through attach.', 'info');
    return pictures.length ? this.upload(pictures) : Promise.resolve([]);
  }

  async upload(list) {
    if (this.session.viewOnly) {
      return this.notify(this.session.access?.intent === 'view' ? 'View-only links cannot attach files.' : 'Attaching files needs editing rights.', 'warn');
    }
    const accepted = [];
    for (const file of list) {
      if (file.size > MAX_PREVIEW && isImage(file)) this.notify(`${file.name} is too large to preview, storing it as a file.`, 'info');
      this.pending += 1;
      this.render();
      try {
        accepted.push(await this.session.upload(file));
      } catch (err) {
        this.notify(err.message, 'warn');
      } finally {
        this.pending -= 1;
        this.render();
      }
    }
    if (accepted.length) this.insert(accepted.map((file) => this.reference(file)).join('\n') + '\n');
    return accepted;
  }

  async remove(file) {
    try {
      this.setFiles(await this.session.removeFile(file.id));
      this.notify(`${file.name} deleted. Links pointing at it will 404.`, 'info');
    } catch (err) {
      this.notify(err.message, 'warn');
    }
  }

  #act(event) {
    const button = event.target.closest('button[data-role]');
    if (!button) return;
    const id = button.closest('li')?.dataset.id;
    const file = this.files.find((entry) => entry.id === id);
    if (!file) return;
    if (button.dataset.role === 'copy') {
      const url = new URL(this.session.urlFor(file), location.href).toString();
      navigator.clipboard?.writeText(url).then(
        () => this.notify(`Link to ${file.name} copied.`, 'info'),
        () => window.prompt('Copy this link', url),
      );
    }
    if (button.dataset.role === 'delete') {
      if (button.dataset.confirm !== 'true') {
        button.dataset.confirm = 'true';
        button.textContent = 'sure?';
        setTimeout(() => {
          if (button.isConnected) {
            delete button.dataset.confirm;
            button.textContent = 'remove';
          }
        }, 4000);
        return;
      }
      this.remove(file);
    }
  }

  render() {
    this.count.textContent = this.files.length + (this.pending ? ` (+${this.pending})` : '');
    this.list.innerHTML = '';
    this.empty.hidden = this.files.length > 0;
    for (const file of [...this.files].sort((a, b) => b.at - a.at)) {
      const row = document.createElement('li');
      row.className = 'file';
      row.dataset.id = file.id;
      const preview = document.createElement(isImage(file) ? 'img' : 'span');
      preview.className = 'file-thumb';
      if (isImage(file)) {
        preview.src = this.session.urlFor(file);
        preview.alt = '';
        preview.loading = 'lazy';
      } else {
        preview.textContent = '📎';
      }
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      const link = document.createElement('a');
      link.href = this.session.urlFor(file);
      link.textContent = file.name;
      link.title = file.name;
      link.dataset.role = 'open';
      const stats = document.createElement('span');
      stats.className = 'muted';
      stats.textContent = [formatBytes(file.size), timeAgo(file.at), file.by].filter(Boolean).join(' · ');
      meta.append(link, stats);
      const actions = document.createElement('div');
      actions.className = 'file-actions';
      const copy = document.createElement('button');
      copy.className = 'ghost';
      copy.dataset.role = 'copy';
      copy.textContent = 'link';
      actions.append(copy);
      if (!this.session.viewOnly) {
        const drop = document.createElement('button');
        drop.className = 'ghost';
        drop.dataset.role = 'delete';
        drop.textContent = 'remove';
        actions.append(drop);
      }
      row.append(preview, meta, actions);
      this.list.appendChild(row);
    }
    if (this.pending) {
      const busy = document.createElement('li');
      busy.className = 'file uploading';
      busy.textContent = 'uploading…';
      this.list.prepend(busy);
    }
  }
}
