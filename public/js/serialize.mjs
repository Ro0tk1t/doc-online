/**
 * The editable surface <-> Markdown bridge.
 *
 * Markdown text stays the document model -- it is what OT transforms and what the server
 * stores -- while the user edits a contenteditable tree. This module turns that tree back
 * into text, and maps caret positions between the two representations so a remote operation
 * can re-render the surface without losing the local caret.
 *
 * Two rules keep the bridge honest:
 *
 * 1. `serialize(render(text))` reaches a fixed point on the second pass, so re-rendering on
 *    a peer edit never rewrites the document.
 * 2. Table rows are laid out with the same padding helpers `serializeTable` uses, so a table
 *    typed into the grid is byte-identical to one built from the model.
 *
 * Text nodes are copied verbatim: `markdown.mjs` honours no backslash escapes outside table
 * cells, so escaping `*` here would print a literal backslash. Only `|` inside a cell is
 * escaped, which is the one place the parser understands it.
 */

import { ROW_JOIN, ROW_LEAD, ROW_TAIL, delimiterCell, padWidths } from './table.mjs';

const HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const WRAP = { STRONG: '**', B: '**', EM: '*', I: '*', DEL: '~~', S: '~~', STRIKE: '~~', MARK: '==' };
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'HR', 'TABLE']);
const CELL = new Set(['TD', 'TH']);
/** A root that holds blocks rather than being one: it is walked, never marked. */
const CONTAINER = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'MAIN', 'BODY']);

const tag = (node) => (node.nodeType === 1 ? String(node.nodeName).toUpperCase() : '');
const kids = (node) => Array.from(node.childNodes ?? []);
const isText = (node) => node.nodeType === 3;
const isElement = (node) => node.nodeType === 1;
const textOf = (node) =>
  kids(node).reduce((acc, child) => acc + (isText(child) ? String(child.data ?? '') : isElement(child) && tag(child) !== 'BR' ? textOf(child) : tag(child) === 'BR' ? '\n' : ''), '');

/** Placeholders and decorations are not content: they must never reach the model. */
function dropped(node) {
  if (!isElement(node)) return false;
  const cls = String(node.className ?? '');
  return node.hasAttribute?.('data-placeholder') || /(^|\s)empty(\s|$)/.test(cls);
}

/**
 * One writer owns the whole output, so every mark it records is a global offset. Block
 * prefixes live on a stack: a line break inside any block writes '\n' plus the active
 * prefixes, which is what keeps '> ' on every line of a quote and indents continuation
 * lines of a list item.
 */
class Writer {
  constructor(marks) {
    this.marks = marks ?? null;
    this.parts = [];
    this.len = 0;
    this.order = [];
    this.prefix = [];
    this.mode = 'flow'; // 'flow' | 'code' | 'cell'
    this.gap = 2; // blank lines between sibling blocks
    this.fresh = true; // nothing but a line break has been written yet
    this.edge = 0; // where the current block's content starts
    this.skip = 0; // leading whitespace the surrounding markup already supplies
  }

  raw(text) {
    if (!text) return;
    this.parts.push(text);
    this.len += text.length;
    this.fresh = false;
  }

  breakLine() {
    const line = '\n' + this.prefix.join('');
    this.parts.push(line);
    this.len += line.length;
    this.fresh = true;
  }

  get tail() {
    const last = this.parts[this.parts.length - 1];
    return last ? last.slice(-1) : '';
  }

  atLineStart() {
    return this.fresh;
  }

  /** Break the current line. Outside fenced code a break never doubles up. */
  nl(breaks = 1) {
    if (this.mode === 'cell') {
      if (breaks > 0 && this.tail !== ' ' && !this.fresh) this.raw(' ');
      return;
    }
    let count = breaks;
    if (this.mode !== 'code' && this.fresh) count -= 1; // an absorbed break, e.g. <br> then '\n'
    for (let i = 0; i < count; i += 1) this.breakLine();
  }

  gapLine() {
    this.nl(this.gap);
  }

  /** Write text content, translating line breaks through the prefix stack. */
  text(src) {
    let value = String(src ?? '').replace(/\u00a0/g, ' ');
    if (this.len === this.edge) value = value.replace(/^ +/, ''); // a block does not start with blanks
    if (this.skip) {
      const run = /^ +/.exec(value)?.[0].length ?? 0;
      const cut = Math.min(this.skip, run);
      value = value.slice(cut);
      this.skip -= cut;
    }
    if (this.mode === 'cell') {
      this.raw(value.replace(/\s+/g, ' ').replace(/\|/g, '\\|'));
      return;
    }
    const lines = value.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (i) this.nl();
      this.raw(lines[i]);
    }
  }

  begin(node) {
    if (!this.marks || !node) return null;
    const entry = { node, start: this.len, end: this.len };
    this.marks.set(node, entry);
    this.order.push(entry);
    return entry;
  }

  close(entry) {
    if (entry) entry.end = this.len;
  }

  /** Drop trailing blanks from the line just written, never below `floor`. */
  trim(floor = 0) {
    for (;;) {
      const index = this.parts.length - 1;
      if (index < 0 || this.len <= floor) break;
      const part = this.parts[index];
      const cut = part.replace(/[ \t]+$/, '');
      if (cut === part) break;
      this.parts[index] = cut;
      this.len -= part.length - cut.length;
    }
    this.settled();
    for (let i = this.order.length - 1; i >= 0 && this.order[i].end > this.len; i -= 1) {
      const entry = this.order[i];
      entry.end = this.len;
      if (entry.start > this.len) entry.start = this.len;
    }
  }

  /** Recompute line state after output was cut back. */
  settled() {
    const last = this.parts[this.parts.length - 1];
    this.fresh = last === undefined || /\n[ \t]*$/.test(last);
  }

  /** Undo output back to `len`, dropping any marks written after it. */
  rewind(len) {
    while (this.parts.length && this.len > len) {
      const part = this.parts.pop();
      if (this.len - part.length >= len) this.len -= part.length;
      else {
        const keep = part.length - (this.len - len);
        this.parts.push(part.slice(0, keep));
        this.len = len;
      }
    }
    this.settled();
    while (this.order.length && this.order[this.order.length - 1].start >= len) {
      const entry = this.order.pop();
      this.marks?.delete(entry.node);
    }
  }

  toString() {
    return this.parts.join('');
  }
}

/* ---------- inline ---------- */

function inline(nodes, w) {
  for (const child of nodes) {
    if (dropped(child)) continue;
    if (isText(child)) {
      const entry = w.begin(child);
      w.text(child.data);
      w.close(entry);
      continue;
    }
    if (!isElement(child)) continue;
    const name = tag(child);

    if (name === 'BR') {
      w.nl();
      continue;
    }
    if (name === 'IMG') {
      const entry = w.begin(child);
      w.raw(`![${String(child.getAttribute('alt') ?? '')}](${String(child.getAttribute('src') ?? '')})`);
      w.close(entry);
      continue;
    }
    if (name === 'CODE') {
      w.raw('`');
      const entry = w.begin(child);
      plain(child, w);
      w.close(entry);
      w.raw('`');
      continue;
    }
    if (name === 'A') {
      const entry = w.begin(child);
      w.raw('[');
      inline(kids(child), w);
      w.raw(`](${String(child.getAttribute('href') ?? '')})`);
      w.close(entry);
      continue;
    }
    const fence = WRAP[name];
    if (fence) {
      if (!textOf(child).trim()) continue;
      w.raw(fence);
      const entry = w.begin(child);
      inline(kids(child), w);
      w.close(entry);
      w.raw(fence);
      continue;
    }
    if (name === 'INPUT') continue; // the list item writes its own marker
    inline(kids(child), w); // spans, fonts and stray blocks flatten into the line
  }
}

/** Text descendants, verbatim, each marked -- used for code spans and fenced blocks. */
function plain(node, w) {
  for (const child of kids(node)) {
    if (isText(child)) {
      const entry = w.begin(child);
      w.text(child.data);
      w.close(entry);
    } else if (isElement(child)) {
      if (tag(child) === 'BR') w.nl();
      else plain(child, w);
    }
  }
}

/* ---------- blocks ---------- */

/**
 * A text block holding nothing but the browser's own `<br>` is an editing artifact, not an
 * empty paragraph in the document: writing it would put stray markers into the shared text.
 * Structural blocks are always kept -- a table, list or fence is what the user asked for.
 */
/** Did this run of inline children put anything real on the line? */
function hasContent(run) {
  return run.some((child) => {
    if (isText(child)) return /[^\s ]/.test(String(child.data ?? ''));
    if (!isElement(child)) return false;
    const name = tag(child);
    return ['IMG', 'INPUT', 'CODE', 'TABLE', 'HR'].includes(name) || /[^\s ]/.test(textOf(child));
  });
}

function meaningful(node) {
  const name = tag(node);
  if (!['P', 'DIV', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(name)) return true;
  if (/[^\s\u00a0]/.test(textOf(node))) return true;
  if (name === 'BLOCKQUOTE') return kids(node).some((child) => meaningful(child) && !dropped(child));
  return kids(node).some((child) => isElement(child) && ['IMG', 'INPUT', 'CODE'].includes(tag(child)));
}

/** Sibling blocks of a container, plus any loose inline runs between them. */
function blockSequence(node, w) {
  let first = true;
  let para = null;

  const separate = () => {
    const before = w.len;
    if (!first) w.gapLine();
    first = false;
    return { before, start: w.len, run: [] };
  };
  /** Take the separator back when the run it introduced turned out to hold nothing. */
  const discard = (spot) => {
    if (w.len === spot.start) w.rewind(spot.before);
  };
  const closePara = () => {
    if (!para) return;
    w.trim(para.start);
    if (!hasContent(para.run)) w.rewind(para.before); // innerHTML leaves line-break text between block tags
    else discard(para);
    para = null;
  };

  for (const child of kids(node)) {
    if (dropped(child)) continue;
    if (isElement(child) && BLOCK.has(tag(child))) {
      closePara();
      if (!meaningful(child)) continue;
      const spot = separate();
      block(child, w);
      continue;
    }
    if (!para) para = separate();
    para.run.push(child);
    inline([child], w);
  }
  closePara();
}

/**
 * Each block writes its own marker first and then calls `begin`, so an entry's start is
 * always where that node's *content* begins -- which is what caret mapping needs, and it
 * keeps the blank line between blocks out of both neighbours.
 */
function block(node, w) {
  const name = tag(node);
  if (name === 'HR') {
    const entry = w.begin(node);
    w.raw('---');
    w.close(entry);
    return;
  }
  if (HEADINGS[name]) {
    w.raw('#'.repeat(HEADINGS[name]) + ' ');
    const entry = w.begin(node);
    const floor = w.len;
    w.edge = floor;
    inline(kids(node), w);
    w.trim(floor);
    w.close(entry);
    return;
  }
  if (name === 'BLOCKQUOTE') {
    w.raw('> ');
    const entry = w.begin(node);
    w.prefix.push('> ');
    const gap = w.gap;
    w.gap = 1; // the renderer closes a quote at a blank line
    blockSequence(node, w);
    w.gap = gap;
    w.prefix.pop();
    w.close(entry);
    return;
  }
  if (name === 'UL' || name === 'OL') {
    const entry = w.begin(node);
    list(node, w, name === 'OL');
    w.close(entry);
    return;
  }
  if (name === 'PRE') {
    fence(node, w);
    return;
  }
  if (name === 'TABLE') {
    const entry = w.begin(node);
    table(node, w);
    w.close(entry);
    return;
  }
  const entry = w.begin(node);
  const floor = w.len;
  w.edge = floor;
  inline(kids(node), w);
  w.trim(floor);
  w.close(entry);
}

function fence(node, w) {
  const code = kids(node).find((child) => tag(child) === 'CODE') ?? node;
  const lang = /(?:^|\s)language-([\w.+-]+)/.exec(String(code.className ?? ''))?.[1] ?? '';
  w.raw('```' + lang);
  const entry = w.begin(node);
  const mode = w.mode;
  w.mode = 'code'; // a fenced body keeps blank lines and trailing spaces verbatim
  w.edge = -1;
  w.nl();
  plain(code, w);
  w.mode = 'flow';
  w.edge = 0;
  w.nl();
  w.raw('```');
  w.close(entry); // the closing marker belongs to the block: a caret at its end is past the fence
  w.mode = mode;
}

function list(node, w, ordered) {
  let number = 1;
  for (const item of kids(node)) {
    if (tag(item) !== 'LI') continue;
    if (!w.atLineStart()) w.nl();
    const marker = ordered ? `${number}. ` : '- ';
    number += 1;
    w.raw(marker);
    let floor = w.len;
    const checked = kids(item).find((child) => tag(child) === 'INPUT');
    if (checked) {
      w.raw(checked.checked || checked.getAttribute('checked') != null ? '[x] ' : '[ ] ');
      floor = w.len; // the space closing the box marker belongs to it
      w.skip = 1; // the renderer already carries that space in the item's text
      w.edge = -1; // ...so it must not read as a stray leading blank
    } else {
      w.edge = floor;
    }
    const entry = w.begin(item);
    listItem(item, w, marker.length);
    w.trim(floor);
    w.close(entry);
  }
}

function listItem(item, w, markerWidth) {
  w.prefix.push(' '.repeat(markerWidth));
  for (const child of kids(item)) {
    const name = tag(child);
    if (name === 'UL' || name === 'OL') {
      if (!w.atLineStart()) w.nl();
      list(child, w, name === 'OL');
      continue;
    }
    if (isElement(child) && BLOCK.has(name)) {
      if (!w.atLineStart()) w.nl();
      block(child, w);
      continue;
    }
    if (name === 'INPUT') continue;
    inline([child], w);
  }
  w.prefix.pop();
}

/* ---------- tables ---------- */

const rowCells = (row) => kids(row).filter((cell) => CELL.has(tag(cell)));

/** Rows in reading order, whether the table uses sections or bare rows. */
const bodyRows = (node) => {
  const sections = kids(node).filter((child) => ['THEAD', 'TBODY', 'TFOOT'].includes(tag(child)));
  const nested = sections.flatMap((section) => kids(section).filter((row) => tag(row) === 'TR'));
  return nested.length ? nested : kids(node).filter((row) => tag(row) === 'TR');
};

/** The `{header, rows, aligns}` model a live table holds, for the grid's own UI. */
export function tableState(table) {
  const rows = bodyRows(table);
  if (!rows.length) return { header: ['Column 1'], rows: [[]], aligns: [''] };
  const header = rows[0] ? rowCells(rows[0]).map(cellText) : [];
  const aligns = rowCells(rows[0]).map(alignOf);
  const body = rows.slice(1).map((row) => {
    const cells = rowCells(row).map(cellText);
    return [...cells, ...Array.from({ length: Math.max(0, header.length - cells.length) }, () => '')];
  });
  if (!body.length) body.push(Array.from({ length: Math.max(1, header.length) }, () => ''));
  return { header: header.length ? header : ['Column 1'], rows: body, aligns: header.length ? aligns : [''] };
}

const cellText = (cell) => textOf(cell).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function alignOf(cell) {
  const cls = String(cell?.className ?? '');
  if (/a-center/.test(cls)) return 'center';
  if (/a-right/.test(cls)) return 'right';
  if (/a-left/.test(cls)) return 'left';
  return '';
}

/**
 * GFM rows, written cell by cell so each cell's text keeps a global offset even though the
 * row is padded. The padding comes from the same helpers `serializeTable` uses.
 */
function table(node, w) {
  const rows = bodyRows(node);
  if (!rows.length) {
    w.raw('| Column 1 | | --- | |');
    return;
  }
  const cells = rows.map(rowCells);
  const texts = cells.map((list) => list.map((cell) => dryRun(cell)));
  const cols = Math.max(1, ...texts.map((list) => list.length));
  const widths = padWidths(texts);
  const aligns = cells[0].map((cell) => alignOf(cell));

  for (let r = 0; r < rows.length; r += 1) {
    if (r) w.nl();
    writeRow(cells[r], widths, cols, w);
    if (r === 0) {
      w.nl();
      w.raw(ROW_LEAD + Array.from({ length: cols }, (unused, c) => delimiterCell(widths[c], aligns[c] ?? '')).join(ROW_JOIN) + ROW_TAIL);
    }
  }
}

/** A cell rendered to text with no marks, to size the columns before writing them. */
function dryRun(cell) {
  const probe = new Writer(null);
  probe.mode = 'cell';
  inline(kids(cell), probe);
  probe.trim(0);
  return probe.toString();
}

function writeRow(cells, widths, cols, w) {
  w.raw(ROW_LEAD);
  for (let c = 0; c < cols; c += 1) {
    if (c) w.raw(ROW_JOIN);
    const cell = cells[c];
    if (!cell) {
      w.raw(' '.repeat(widths[c]));
      continue;
    }
    const mode = w.mode;
    w.mode = 'cell';
    const entry = w.begin(cell);
    const floor = w.len;
    w.edge = floor;
    inline(kids(cell), w);
    w.trim(floor);
    w.close(entry);
    w.mode = mode;
    w.raw(' '.repeat(Math.max(0, widths[c] - (w.len - floor))));
  }
  w.raw(ROW_TAIL);
}

/* ---------- positions ---------- */

/**
 * Serialise the surface. Pass a Map to also receive, per node, the Markdown offsets where
 * its content starts and ends.
 */
export function toMarkdown(root, marks = null) {
  const w = new Writer(marks);
  const name = tag(root);
  if (isElement(root) && BLOCK.has(name) && !CONTAINER.has(name)) block(root, w);
  else blockSequence(root, w);
  return w.toString();
}

export function serializeDocument(root) {
  const marks = new Map();
  return { text: toMarkdown(root, marks), marks };
}

const childrenOf = (node) => kids(node);

/** Markdown offset for a DOM (node, offset) pair, or null when it is outside `marks`. */
export function offsetOf(marks, node, offset) {
  if (!marks || !node) return null;
  const list = childrenOf(node);
  if (!isText(node)) {
    // Prefer the child the caret sits in front of: it skips the separator between blocks, so
    // a caret at the start of a block never lands in the previous one. Unmarked children --
    // the line breaks innerHTML leaves between block tags -- are stepped over either way.
    for (let i = offset; i < list.length; i += 1) {
      const next = marks.get(list[i]);
      if (next) return next.start;
    }
    for (let i = offset - 1; i >= 0; i -= 1) {
      const before = marks.get(list[i]);
      if (before) return before.end;
    }
  }
  const entry = marks.get(node);
  if (entry) {
    if (!isText(node)) return offset > 0 ? entry.end : entry.start;
    const length = String(node.data ?? '').length;
    return Math.min(entry.start + Math.max(0, Math.min(offset, length)), entry.end);
  }
  // Nodes the model skips -- the line breaks innerHTML leaves between block tags -- resolve
  // against their siblings, so the caret stays on the side of the gap it sits in.
  const parent = node.parentNode ?? node.parentElement ?? null;
  if (!parent || parent === node) return null;
  const siblings = childrenOf(parent);
  const at = siblings.indexOf(node);
  if (at < 0) return null;
  const startOf = (index) => {
    for (let i = index; i < siblings.length; i += 1) {
      const mark = marks.get(siblings[i]);
      if (mark) return mark.start;
    }
    return null;
  };
  const endOf = (index) => {
    for (let i = index; i >= 0; i -= 1) {
      const mark = marks.get(siblings[i]);
      if (mark) return mark.end;
    }
    return null;
  };
  return offset > 0 ? (startOf(at + 1) ?? endOf(at - 1)) : (endOf(at - 1) ?? startOf(at + 1));
}

/** The DOM position a Markdown offset corresponds to, for restoring a caret after a re-render. */
export function positionOf(marks, root, wanted) {
  const texts = [...(marks?.values() ?? [])].filter((entry) => isText(entry.node));
  if (!texts.length) return { node: root, offset: 0 };
  let best = texts[0];
  for (const entry of texts) {
    if (entry.start > wanted) break;
    best = entry; // marks arrive in document order, so the last match is the innermost one
  }
  const length = String(best.node.data ?? '').length;
  const span = Math.max(0, best.end - best.start);
  return { node: best.node, offset: Math.max(0, Math.min(wanted - best.start, length, span)) };
}
