/**
 * The outline rail.
 *
 * Rows come from `outline.mjs`, which reads the shared Markdown text instead of the DOM, so
 * every peer sees the same list. Folding is per reader: which headings you have closed up is
 * your view of the document, not a part of it, so it lives in localStorage and never on the wire.
 */

import { activeRow, outline } from './outline.mjs';

const FOLDED_KEY = 'doc-online:outline-folded:';
const RAIL_KEY = 'doc-online:outline-collapsed';
const ARROW = { open: '▾', closed: '▸' };

const stored = (key) => {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return []; // a corrupted setting is a reset, not a broken editor
  }
};

const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export class Outline {
  constructor({ docId, onJump }) {
    this.pane = document.getElementById('outlinePane');
    this.list = document.getElementById('outline');
    this.empty = document.getElementById('outlineEmpty');
    this.toggle = document.getElementById('outlineCollapse');
    this.foldedKey = FOLDED_KEY + docId;
    this.folded = new Set(stored(this.foldedKey));
    this.rows = [];
    this.text = '';
    this.signature = null; // null forces the first paint, even for a document without headings
    this.onJump = onJump;

    // Pressing a row must not take the selection with it; the caret in the document stays put.
    this.list.addEventListener('mousedown', (event) => event.preventDefault());
    this.list.addEventListener('click', (event) => this.#click(event));
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed()));
    this.setCollapsed(localStorage.getItem(RAIL_KEY) === 'true');
  }

  collapsed() {
    return this.pane.dataset.collapsed === 'true';
  }

  setCollapsed(collapsed) {
    this.pane.dataset.collapsed = String(collapsed);
    this.toggle.textContent = collapsed ? '»' : '«';
    this.toggle.title = collapsed ? 'Show outline' : 'Hide outline';
    localStorage.setItem(RAIL_KEY, collapsed ? 'true' : 'false');
  }

  /** Rebuild the rail from the document. Cheap: a document is a few dozen headings at most. */
  render(text) {
    this.text = text;
    this.rows = outline(text, this.folded);
    // Typing inside a section leaves the heading list alone, so most keystrokes skip the rebuild.
    const signature = this.rows.map((row) => `${row.key} ${row.start} ${row.depth} ${row.foldable} ${row.closed} ${row.hidden}`).join('\n');
    if (signature === this.signature) return;
    this.signature = signature;
    this.list.replaceChildren(...this.rows.map((row) => this.rowNode(row)));
    this.empty.hidden = this.rows.length > 0;
  }

  /** Highlight the section the caret is in. */
  setActive(offset) {
    const key = activeRow(this.rows, offset);
    for (const li of this.list.children) li.classList.toggle('active', li.dataset.key === key);
  }

  rowNode(row) {
    const li = document.createElement('li');
    li.className = `lv${row.level}${row.hidden ? ' hidden' : ''}`;
    li.dataset.key = row.key;
    if (row.foldable) li.dataset.foldable = 'true';
    li.style.setProperty('--depth', String(row.depth));

    const fold = document.createElement('button');
    fold.className = 'fold';
    fold.dataset.role = 'fold';
    fold.tabIndex = -1;
    fold.textContent = ARROW[row.closed ? 'closed' : 'open'];
    fold.title = row.closed ? 'Expand this section' : 'Collapse this section';

    const jump = document.createElement('button');
    jump.className = 'row';
    jump.dataset.role = 'jump';
    jump.dataset.start = String(row.start);
    jump.title = row.text;
    jump.textContent = row.text;

    li.append(fold, jump);
    return li;
  }

  #click(event) {
    const button = event.target.closest('button[data-role]');
    if (!button) return;
    if (button.dataset.role !== 'fold') return this.onJump(Number(button.dataset.start));
    const key = button.closest('li').dataset.key;
    if (this.folded.has(key)) this.folded.delete(key);
    else this.folded.add(key);
    save(this.foldedKey, [...this.folded]);
    this.render(this.text);
  }
}
