/**
 * Editor screen wiring: one WYSIWYG surface, Markdown underneath.
 *
 * The contenteditable element is the only view -- there is no source pane to keep in step.
 * The shared document is still plain Markdown text, because that is what the OT engine
 * transforms and what the server stores, so every keystroke serializes the DOM back to text
 * (`serialize.mjs`) and goes out through the same edit path a textarea used to, and every
 * peer operation paints the surface again with the caret restored by offset.
 */

import { apply, makeEdit, transformPosition } from '/shared/ot.mjs';
import { Session } from './session.js';
import { CursorLayer } from './presence.js';
import { renderMarkdown } from './markdown.mjs';
import { Attachments } from './attachments.js';
import { makeTable, serializeTable, toTsv } from './table.mjs';
import { offsetOf, positionOf, serializeDocument, tableState } from './serialize.mjs';
import { linesSpan, planFenceExit, planInsert, planReplace, setFenceLanguage } from './blocks.mjs';
import { FenceChips } from './fence-chips.js';
import { Outline } from './outline.js';
import { Sharing } from './sharing.js';

const params = new URLSearchParams(location.search);
const docId = params.get('doc');

const el = (id) => document.getElementById(id);
const ui = {
  title: el('title'),
  doc: el('doc'),
  stage: el('stage'),
  peers: el('peers'),
  peerCount: el('peerCount'),
  status: el('status'),
  stats: el('stats'),
  banner: el('banner'),
  toolbar: el('toolbar'),
  editor: el('editor'),
  tableBar: el('tableBar'),
  tablePicker: el('table-picker'),
  role: el('role'),
  signIn: el('sign-in'),
};

if (!docId) {
  location.replace('/');
  throw new Error('no document id');
}

/** Just the tab's own id: who I am is the server's business, and it answers in `access`. */
function identity() {
  let clientId = localStorage.getItem('doc-online:client');
  if (!clientId) {
    clientId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    localStorage.setItem('doc-online:client', clientId);
  }
  return clientId;
}

const clientId = identity();
// A read-only link is a wish, not a right: it narrows what this tab does, the server decides the rest.
const session = new Session({ docId, clientId, linkViewOnly: params.get('mode') === 'view' });
const readOnly = () => session.viewOnly;
const cursors = new CursorLayer(ui.stage, ui.doc, clientId);
const chips = new FenceChips(ui.stage, ui.doc, { onPick: pickFenceLanguage, editable: () => !readOnly() });
const attachments = new Attachments({ session, source: ui.doc, insert: insertMarkdown, notify: notice });
const outline = new Outline({ docId, onJump: jumpToHeading });
const sharing = new Sharing({ docId, notify: notice });

let peers = [];
let typingUntil = 0;
let caret = { start: 0, end: 0 }; // Markdown offsets, the coordinate space operations travel in
let shown = ''; // text the surface currently renders
let cache = null; // serialized surface, rebuilt whenever the DOM moves
let composing = null; // { text } at compositionstart, so CJK input commits as one operation
let lostEdit = null;

/* ---------- surface <-> text ---------- */

function snapshot() {
  if (!cache) cache = serializeDocument(ui.doc);
  return cache;
}

function value() {
  return snapshot().text;
}

function invalidate() {
  cache = null;
}

/** Replace the surface with `text`, keeping the DOM the browser owns when it already matches. */
function paint(text) {
  shown = text;
  invalidate();
  const blank = readOnly() ? false : !text.trim();
  ui.doc.innerHTML = blank ? '<p><br></p>' : renderMarkdown(text);
  ui.doc.dataset.blank = String(blank);
  chips.render(text); // the blocks the surface just became are the blocks the chips hang on
}

/** Put the DOM caret at a Markdown offset pair. */
function placeCaret(start, end = start, { focus = true } = {}) {
  caret = { start, end };
  if (focus) ui.doc.focus({ preventScroll: true });
  const marks = snapshot().marks;
  const from = positionOf(marks, ui.doc, start);
  const to = positionOf(marks, ui.doc, end);
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return; // the tree moved under us; the next paint will place it again
  }
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Read the DOM caret back as Markdown offsets, falling back to the last known pair. */
function readCaret() {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || !ui.doc.contains(sel.anchorNode)) return caret;
  const marks = snapshot().marks;
  const start = offsetOf(marks, sel.anchorNode, sel.anchorOffset);
  const end = offsetOf(marks, sel.focusNode, sel.focusOffset);
  if (start == null && end == null) return caret;
  const a = start ?? caret.start;
  const b = end ?? start ?? caret.end;
  caret = { start: Math.min(a, b), end: Math.max(a, b) };
  return caret;
}

function focusSurface() {
  if (document.activeElement !== ui.doc) ui.doc.focus();
}

/** Follow an outline row: the heading's own offset, then the block comes into view. */
function jumpToHeading(start) {
  const marks = snapshot().marks;
  // A rail row points at the `#` of its line; the surface's mark for that heading starts at its
  // text. Resolve through the marks, so the caret position is one the offset mapping agrees on.
  const target = [...ui.doc.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .map((node) => ({ node, at: marks.get(node)?.start }))
    .filter((entry) => entry.at >= start)
    .sort((a, b) => a.at - b.at)[0];
  const at = target?.at ?? start;
  placeCaret(at, at);
  target?.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ---------- edits ---------- */

/** Take a text the caller already put in the DOM into the model, and tell everybody. */
function publish({ kind = 'edit' } = {}) {
  invalidate();
  const after = value();
  if (!readOnly()) ui.doc.dataset.blank = String(!after.trim());
  if (after !== session.text) {
    session.localEdit(session.text, after);
    shown = after;
    noteFenceEdit(); // the browser's own DOM stands in; a pause in the keystrokes repaints it
    pushHistory(after, kind);
  }
  renderStats();
  announcePresence();
  refreshPresence();
}

/** Write `next` into the model and repaint the surface from it. */
function commitText(next, selection, { kind = 'edit' } = {}) {
  if (next === session.text && selection == null) return;
  if (next !== session.text) session.localEdit(session.text, next);
  paint(next);
  if (selection) placeCaret(selection.start, selection.end);
  else placeCaret(Math.min(caret.start, next.length), Math.min(caret.end, next.length), { focus: false });
  pushHistory(next, kind);
  renderStats();
  announcePresence();
  refreshPresence();
}

/** Never drop a block inside a table or a code fence: those own the caret until it leaves. */
function blockEndForCaret() {
  const node = document.getSelection()?.anchorNode;
  const element = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
  const block = element?.closest?.('pre, table');
  return (block && snapshot().marks.get(block)?.end) || null;
}

/** Drop a block at the caret: never spliced into a sentence, never into a table row. */
function insertMarkdown(md, settle = null) {
  readCaret(); // the selection can have moved without an input event reaching us
  const plan = planInsert(session.text, blockEndForCaret() ?? caret.end, md);
  commitText(plan.text, { start: plan.end, end: plan.end });
  settle?.(plan.content);
}

/**
 * A chip chose a language. The info string is the only place a fence can keep one, so the write goes
 * through the model: it travels as an ordinary operation, and every other tab repaints from it.
 */
function pickFenceLanguage(at, info) {
  const next = setFenceLanguage(session.text, at, info);
  if (next === session.text) return;
  readCaret();
  const delta = next.length - session.text.length;
  const shift = (position) => (position > at ? position + delta : position);
  commitText(next, { start: shift(caret.start), end: shift(caret.end) });
}

const FENCE_HEAD = '```js\n';

/**
 * The code block button. With selected text it takes the whole lines the selection touches and
 * puts them inside the fence; with the caret resting on a line it adds an empty block below,
 * because swallowing the sentence the caret happens to sit in would be a destructive surprise.
 * Either way the caret ends up inside the fence, so the next keystroke is code.
 */
function toCodeBlock() {
  const host = blockHost();
  if (host) return notice(`Code blocks do not apply inside ${host}.`, 'warn');
  readCaret();
  const inside = (content, body) => placeCaret(content + FENCE_HEAD.length + body.length, content + FENCE_HEAD.length + body.length);
  if (caret.end <= caret.start) {
    return insertMarkdown(`${FENCE_HEAD}\n\`\`\`\n`, (content) => inside(content, ''));
  }
  const span = linesSpan(session.text, caret.start, caret.end);
  const body = session.text.slice(span.start, span.end);
  const plan = planReplace(session.text, span.start, span.end, `${FENCE_HEAD}${body}\n\`\`\``);
  commitText(plan.text, { start: plan.end, end: plan.end });
  inside(plan.content, body);
  return null;
}

/* ---------- undo / redo ---------- */

const COALESCE = 700;
const history = { stack: [], index: -1 };

function pushHistory(text, kind) {
  const top = history.stack[history.index];
  const sameBreath =
    top && kind === 'typing' && top.kind === 'typing' && Date.now() - top.at < COALESCE && Math.abs(top.text.length - text.length) <= 4;
  const entry = { text, kind, caret: { ...caret }, at: Date.now() };
  if (top && top.text === text) return;
  if (sameBreath) history.stack[history.index] = entry;
  else {
    history.stack.splice(history.index + 1, history.stack.length, entry);
    history.index += 1;
  }
  if (history.stack.length > 200) {
    history.stack.splice(0, history.stack.length - 200);
    history.index -= 1;
  }
}

function stepHistory(delta) {
  const target = history.index + delta;
  const entry = history.stack[target];
  if (!entry) return;
  history.index = target;
  if (entry.text !== session.text) {
    session.localEdit(session.text, entry.text);
    paint(entry.text);
  }
  const at = entry.caret ?? { start: 0, end: 0 };
  placeCaret(Math.min(at.start, entry.text.length), Math.min(at.end, entry.text.length));
  renderStats();
  announcePresence();
}

function undo() {
  stepHistory(-1);
}

function redo() {
  stepHistory(1);
}

/* ---------- chrome ---------- */

function setStatus(status) {
  ui.status.dataset.state = status;
  ui.status.textContent = {
    connecting: 'connecting…',
    online: 'live',
    offline: 'offline',
    reconnecting: 'reconnecting…',
    error: 'connection error',
  }[status];
}

let noticeTimer = 0;

function banner(text, tone = 'warn') {
  clearTimeout(noticeTimer);
  if (!text) {
    ui.banner.hidden = true;
    return;
  }
  ui.banner.hidden = false;
  ui.banner.dataset.tone = tone;
  ui.banner.textContent = text;
}

/** A banner that gets out of the way on its own. */
function notice(text, tone = 'info') {
  banner(text, tone);
  if (text) noticeTimer = setTimeout(() => banner(''), 2600);
}

function renderStats() {
  const text = session.text;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text.split('\n').length;
  ui.stats.textContent = `${words} words · ${text.length} chars · ${lines} lines · rev ${session.revision}`;
  // The readout and the rail are both derived from the text, so they refresh on the same tick.
  outline.render(text);
  outline.setActive(caret.start);
}

function renderPeers() {
  // My own chip carries the name the server answered with -- for a signed-in peer that is the
  // account name, and nothing this tab could type reaches anybody else.
  const self = peers.find((peer) => peer.clientId === clientId);
  const others = peers.filter((peer) => peer.clientId !== clientId);
  ui.peers.innerHTML = '';
  const mineChip = document.createElement('span');
  mineChip.className = 'chip';
  mineChip.style.setProperty('--c', self?.color ?? '#3e63dd');
  mineChip.textContent = self?.name ?? 'You';
  ui.peers.appendChild(mineChip);
  for (const peer of others) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.setProperty('--c', peer.color);
    chip.dataset.typing = peer.typing ? 'true' : 'false';
    chip.title = readOnly() ? `${peer.name} is editing` : peer.name;
    chip.textContent = peer.name + (peer.typing ? ' ✎' : '');
    ui.peers.appendChild(chip);
  }
  ui.peerCount.textContent = others.length ? `${others.length + 1} editing` : 'only you here';
}

function announcePresence() {
  session.setSelection({ ...caret }, Date.now() < typingUntil);
  outline.setActive(caret.start);
  renderTableBar();
}

/** Hand the overlay a fresh serialization, so its offset -> DOM mapping is never stale. */
function refreshPresence() {
  cursors.render(snapshot(), peers);
}

/* ---------- local input ---------- */

ui.doc.addEventListener('beforeinput', () => invalidate());

ui.doc.addEventListener('input', (event) => {
  if (event.isComposing || composing) {
    invalidate();
    return; // CJK input arrives whole when composition ends
  }
  invalidate();
  readCaret();
  typingUntil = Date.now() + 1400;
  publish({ kind: 'typing' });
});

ui.doc.addEventListener('compositionstart', () => {
  invalidate();
  composing = { text: value() };
});

ui.doc.addEventListener('compositionend', () => {
  const base = composing?.text ?? session.text;
  composing = null;
  invalidate();
  readCaret();
  const after = value();
  const op = makeEdit(base, after);
  let next;
  try {
    next = apply(session.text, op);
  } catch {
    session.send({ type: 'resync' });
    return;
  }
  typingUntil = Date.now() + 1400;
  if (next === after) publish({ kind: 'typing' });
  else commitText(next, caret, { kind: 'typing' }); // a peer edit landed mid-composition
});

/**
 * Highlighting belongs to the renderer, so a line that was just typed is flat until the surface is
 * read back as Markdown. Waiting for the caret to leave the fence made a whole block of code stay
 * colourless while somebody was writing it, so the pause after a keystroke settles it instead. The
 * repaint is scoped to a fence having been edited: prose the caret rests in is left alone.
 */
const QUIET_MS = 450;
let fenceEdited = false;
let quietTimer = null;

/** Called for every edit that reaches the model: a fence owns the colours to catch up. */
function noteFenceEdit() {
  const node = document.getSelection()?.anchorNode;
  const element = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
  if (!element?.closest?.('pre')) return;
  fenceEdited = true;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(settleFence, QUIET_MS);
}

/** Repaint the fenced text from the model, and put the caret back where it was. */
function settleFence() {
  if (!fenceEdited || composing) return;
  fenceEdited = false;
  const sel = document.getSelection();
  const inside = Boolean(sel && ui.doc.contains(sel.anchorNode));
  paint(session.text);
  // Only restore a caret that is still ours; a click outside the surface is the user's business.
  if (inside) placeCaret(Math.min(caret.start, session.text.length), Math.min(caret.end, session.text.length), { focus: false });
}

/**
 * The line break that leaves a code block. Inside a fence Enter belongs to the code, so it is the
 * second Enter on an empty line that gets out -- `planFenceExit` owns that arithmetic and says no
 * until the caret is on a blank line with nothing below it.
 *
 * Leaving the last block asks for a caret position Markdown cannot hold: an empty paragraph after
 * the final block does not survive a round trip, and one written into the model would be a line the
 * document never asked for. So the surface keeps it instead -- a `<p>` with nothing in it, which the
 * serializer drops while it stays empty and turns into prose the moment it is typed into.
 */
function exitFence() {
  const sel = document.getSelection();
  const node = sel?.anchorNode;
  if (!node || !sel.isCollapsed || !ui.doc.contains(node)) return false;
  const element = node.nodeType === 3 ? node.parentElement : node;
  if (!element?.closest?.('pre')) return false;
  const at = offsetOf(snapshot().marks, node, sel.anchorOffset);
  if (at == null) return false;
  const plan = planFenceExit(session.text, at);
  if (!plan) return false;

  clearTimeout(quietTimer); // the block that was settling is not the one under the caret now
  fenceEdited = false;
  commitText(plan.text, { start: plan.end, end: plan.end });
  if (plan.end < plan.text.length) return true;

  let room = ui.doc.lastElementChild;
  if (room?.nodeName !== 'P' || room.textContent) {
    room = document.createElement('p');
    room.appendChild(document.createElement('br'));
    ui.doc.appendChild(room);
  }
  const spot = document.createRange();
  spot.setStart(room, 0);
  spot.collapse(true);
  sel.removeAllRanges();
  sel.addRange(spot);
  return true;
}

document.addEventListener('selectionchange', () => {
  if (!ui.doc.contains(document.getSelection()?.anchorNode)) return;
  readCaret();
  announcePresence();
  refreshPresence();
});

/* ---------- markdown toolbar ---------- */

/** Commands that rewrite whole blocks: destructive while the caret sits inside a fence or a cell. */
const BLOCK_COMMANDS = new Set(['formatBlock', 'insertOrderedList', 'insertUnorderedList']);

function blockHost() {
  const node = document.getSelection()?.anchorNode;
  const element = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
  const host = element?.closest?.('pre, td, th');
  if (!host) return null;
  return host.tagName === 'PRE' ? 'a code block' : 'a table cell';
}

/**
 * A line break ends an inline code span, because Markdown gives one no delimiter that survives
 * going around it: left to the browser, Enter dragged the `<code>` element onto the new line, so
 * prose typed there came out formatted as code, and breaking an empty span left stray backticks.
 * Close the span at the caret instead, and let whatever follows carry on as plain text.
 */
function endInlineCodeAtCaret() {
  const sel = document.getSelection();
  const node = sel?.anchorNode;
  if (!node || !ui.doc.contains(node)) return false;
  const code = (node.nodeType === 3 ? node.parentElement : node)?.closest?.('code');
  if (!code || code.closest('pre')) return false;

  const marks = snapshot().marks;
  const span = marks.get(code);
  const at = offsetOf(marks, node, sel.anchorOffset);
  const inside = Boolean(span) && at != null && at > span.start && at < span.end;

  const parent = code.parentNode;
  const index = [...parent.childNodes].indexOf(code);
  let moved = null;

  if (inside) {
    const rest = document.createRange();
    rest.selectNodeContents(code);
    rest.setStart(node, sel.anchorOffset);
    const tail = rest.extractContents();
    // Read the reference before the fragment moves into the document: once it lands, `tail` is empty
    // and its first child belongs to the paragraph now.
    moved = tail.firstChild;
    if (moved) code.after(tail);
    if (!code.textContent) code.remove(); // an emptied span would only write backticks for nothing
  }

  const spot = document.createRange();
  const past = Boolean(span) && at != null && at >= span.end;
  if (moved) spot.setStartBefore(moved); // the break lands between the closed span and its tail
  else if (code.isConnected && (inside || past)) spot.setStartAfter(code);
  else if (code.isConnected) spot.setStartBefore(code); // a caret on either seam: break around the span
  else spot.setStart(parent, Math.min(index, parent.childNodes.length));
  spot.collapse(true);
  sel.removeAllRanges();
  sel.addRange(spot);
  return true;
}

function exec(command, arg) {
  if (BLOCK_COMMANDS.has(command)) {
    const host = blockHost();
    if (host) return notice(`Headings, quotes and lists do not apply inside ${host}.`, 'warn');
  }
  focusSurface();
  document.execCommand(command, false, arg);
  readCaret();
  typingUntil = Date.now() + 1400;
  publish({ kind: 'edit' });
}

/**
 * Inline code is written into the model, not into the DOM. `execCommand('insertHTML')` hands back
 * a `<span>` with the colours folded into inline style, which the serializer reads as plain text:
 * the span looked like code for one repaint and then was gone. Markdown decides what a code span
 * is, so Markdown is where it belongs -- and pressing the command again takes it back off.
 */
function wrapCode() {
  readCaret(); // the model's own offsets, not the browser's rendering of the selection
  const { start, end } = caret;
  const text = session.text;
  if (start === end) {
    return commitText(`${text.slice(0, start)}\`code\`${text.slice(end)}`, { start: start + 1, end: start + 5 });
  }
  const selected = text.slice(start, end);
  // A code span has no line break in it: more than one line is a code block asking to happen.
  if (selected.includes('\n')) return toCodeBlock();
  if (selected.includes('`')) return notice('A code span cannot hold a backtick.', 'warn');
  if (text[start - 1] === '`' && text[end] === '`') {
    return commitText(`${text.slice(0, start - 1)}${selected}${text.slice(end + 1)}`, { start: start - 1, end: end - 1 });
  }
  return commitText(`${text.slice(0, start)}\`${selected}\`${text.slice(end)}`, { start: start + 1, end: end + 1 });
}

function makeLink() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return notice('Select the text to link first.', 'warn');
  const url = window.prompt('Link address', 'https://');
  if (!url) return null;
  exec('createLink', url);
  return null;
}

const asBlock = (tag) => exec('formatBlock', `<${tag}>`);

const ACTIONS = {
  bold: () => exec('bold'),
  italic: () => exec('italic'),
  strike: () => exec('strikeThrough'),
  code: wrapCode,
  link: makeLink,
  h1: () => asBlock('h1'),
  h2: () => asBlock('h2'),
  h3: () => asBlock('h3'),
  h4: () => asBlock('h4'),
  h5: () => asBlock('h5'),
  quote: () => asBlock('blockquote'),
  plain: () => asBlock('p'),
  bullet: () => exec('insertUnorderedList'),
  numbered: () => exec('insertOrderedList'),
  divider: () => insertMarkdown('---\n'),
  codeblock: toCodeBlock,
  table: toggleTablePicker,
  image: () => el('image').click(),
  attach: () => el('attach').click(),
};

/* ---------- tables ---------- */

const PICKER = { cols: 6, rows: 5 };
const cellsOf = (row) => [...row.children].filter((cell) => ['TD', 'TH'].includes(cell.tagName));
const rowsOf = (table) =>
  [...table.querySelectorAll('tr')].filter((row) => row.closest('table') === table);

function cellAtCaret() {
  const sel = document.getSelection();
  const node = sel?.anchorNode;
  if (!node || !ui.doc.contains(node)) return null;
  const element = node.nodeType === 3 ? node.parentElement : node;
  const cell = element?.closest?.('td, th');
  if (!cell || !ui.doc.contains(cell)) return null;
  const tr = cell.closest('tr');
  const table = cell.closest('table');
  return { table, tr, cell, row: rowsOf(table).indexOf(tr), col: cellsOf(tr).indexOf(cell) };
}

function renderTableBar() {
  const here = readOnly() ? null : cellAtCaret();
  ui.tableBar.hidden = !here;
  for (const active of ui.doc.querySelectorAll('.cell-active')) active.classList.remove('cell-active');
  if (here) here.cell.classList.add('cell-active');
}

function blankRow(cols) {
  const tr = document.createElement('tr');
  for (let i = 0; i < cols; i += 1) {
    const cell = document.createElement('td');
    cell.appendChild(document.createElement('br'));
    tr.appendChild(cell);
  }
  return tr;
}

/** Put the caret in a cell. `all` highlights what is there, so typing replaces a default label. */
function selectCell(cell, all = false) {
  if (!cell) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (!all) range.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  focusSurface();
  readCaret();
}

/** Change the grid in place, then let the usual edit path carry it to every peer. */
function runTableAction(name) {
  const here = cellAtCaret();
  if (!here) return;
  const outcome = TABLE_EDITS[name]?.(here);
  if (outcome === undefined) return;
  if (outcome === false) return notice('A table keeps its header row and one column.', 'warn');
  if (outcome.cell) selectCell(outcome.cell);
  publish({ kind: 'edit' });
  renderTableBar();
  return undefined;
}

const TABLE_EDITS = {
  'row-above': (here) => {
    if (here.row < 1) return false; // row 0 is the header
    const tr = blankRow(cellsOf(here.tr).length);
    here.tr.parentNode.insertBefore(tr, here.tr);
    return { cell: tr.children[here.col] };
  },
  'row-below': (here) => {
    const tr = blankRow(cellsOf(here.tr).length);
    here.tr.parentNode.insertBefore(tr, here.tr.nextSibling);
    return { cell: tr.children[here.col] };
  },
  'col-before': (here) => {
    insertColumnAt(here.table, here.col);
    return { cell: cellsOf(here.tr)[here.col] };
  },
  'col-after': (here) => {
    insertColumnAt(here.table, here.col + 1);
    return { cell: cellsOf(here.tr)[here.col + 1] };
  },
  'row-delete': (here) => {
    if (here.row < 1 || rowsOf(here.table).length < 2) return false;
    const above = rowsOf(here.table)[here.row - 1];
    here.tr.remove();
    return { cell: lastCell(above, here.col) };
  },
  'col-delete': (here) => {
    if (cellsOf(rowsOf(here.table)[0]).length < 2) return false;
    const tr = here.tr;
    for (const row of rowsOf(here.table)) {
      const cell = cellsOf(row)[Math.min(here.col, cellsOf(row).length - 1)];
      if (cell) cell.remove();
    }
    return { cell: lastCell(tr, here.col) };
  },
  'align-left': (here) => alignColumn(here, ''),
  'align-center': (here) => alignColumn(here, 'center'),
  'align-right': (here) => alignColumn(here, 'right'),
  'copy-tsv': (here) => {
    const tsv = toTsv(tableState(here.table));
    notice('Table copied as tab-separated text.');
    navigator.clipboard?.writeText(tsv).catch(() => window.prompt('Copy the table', tsv));
    return {};
  },
};

const lastCell = (row, col) => {
  const cells = cellsOf(row);
  return cells[Math.max(0, Math.min(col, cells.length - 1))];
};

/** New column at index `at`, inheriting the alignment of the column it lands in front of. */
function insertColumnAt(table, at) {
  const rows = rowsOf(table);
  const headerCells = cellsOf(rows[0]);
  const align = alignOfCell(headerCells[Math.min(at, headerCells.length - 1)]);
  rows.forEach((row, index) => {
    const cell = document.createElement(index === 0 ? 'th' : 'td');
    // Blank, like an inserted row: the grid asks the user for the label instead of inventing one.
    cell.appendChild(document.createElement('br'));
    if (align) cell.classList.add(alignClass(align));
    const existing = cellsOf(row);
    row.insertBefore(cell, existing[Math.min(at, existing.length)] ?? null);
  });
}

const ALIGN_CLASS = { center: 'a-center', right: 'a-right' };
const alignClass = (align) => ALIGN_CLASS[align] ?? '';

const alignOfCell = (cell) => {
  const classes = String(cell?.className ?? '').split(/\s+/);
  return classes.includes('a-center') ? 'center' : classes.includes('a-right') ? 'right' : '';
};

/** The rendered markdown only ever marks centred and right-aligned cells; plain is the default. */
function setColumnClass(table, at, align) {
  for (const row of rowsOf(table)) {
    const cell = cellsOf(row)[at];
    if (!cell) continue;
    cell.classList.remove('a-center', 'a-right');
    const cls = alignClass(align);
    if (cls) cell.classList.add(cls);
  }
}

function alignColumn(here, align) {
  setColumnClass(here.table, here.col, align);
  return { cell: here.cell };
}

function buildPicker() {
  const grid = el('picker-grid');
  for (let row = 1; row <= PICKER.rows; row += 1) {
    for (let col = 1; col <= PICKER.cols; col += 1) {
      const dot = document.createElement('span');
      dot.className = 'pick';
      dot.dataset.r = String(row);
      dot.dataset.c = String(col);
      grid.appendChild(dot);
    }
  }
  grid.addEventListener('mousemove', (event) => {
    const dot = event.target.closest('.pick');
    if (!dot) return;
    const { r, c } = dot.dataset;
    el('picker-label').textContent = `${c} × ${r}`;
    for (const each of grid.children) {
      each.classList.toggle('on', Number(each.dataset.r) <= Number(r) && Number(each.dataset.c) <= Number(c));
    }
  });
  grid.addEventListener('click', (event) => {
    const dot = event.target.closest('.pick');
    if (!dot) return;
    ui.tablePicker.hidden = true;
    insertTable(Number(dot.dataset.c), Number(dot.dataset.r));
  });
}

function insertTable(cols, rows) {
  insertMarkdown(`${serializeTable(makeTable(cols, rows))}\n`, (start) => {
    const marks = snapshot().marks;
    // Each table's mark starts exactly where its Markdown text does, so that is how the new
    // block is found again after the repaint.
    const table = [...ui.doc.querySelectorAll('table')].find((node) => marks.get(node)?.start === start);
    const first = table ? cellsOf(rowsOf(table)[0])[0] : null;
    if (!first) return;
    selectCell(first, true); // the default header labels are a starting point, not text to delete
    publish({ kind: 'edit' });
  });
}

function toggleTablePicker() {
  ui.tablePicker.hidden = !ui.tablePicker.hidden;
}

buildPicker();
ui.tableBar.addEventListener('mousedown', (event) => event.preventDefault());
ui.tableBar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-cell]');
  if (button) runTableAction(button.dataset.cell);
});
document.addEventListener('click', (event) => {
  if (ui.tablePicker.hidden) return;
  if (ui.tablePicker.contains(event.target) || event.target.closest('[data-action="table"]')) return;
  ui.tablePicker.hidden = true;
});

ui.toolbar.addEventListener('mousedown', (event) => event.preventDefault());
ui.toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || readOnly()) return;
  ACTIONS[button.dataset.action]?.();
});

/* ---------- keys ---------- */

function walkCell(backwards) {
  const here = cellAtCaret();
  if (!here) return false;
  const rows = rowsOf(here.table);
  const cols = cellsOf(rows[0]).length;
  let index = here.row * cols + here.col + (backwards ? -1 : 1);
  if (index < 0) index = 0;
  if (index >= rows.length * cols) {
    if (backwards) return true;
    const tr = blankRow(cols);
    rows[rows.length - 1].parentNode.appendChild(tr);
    selectCell(tr.children[0]);
    publish({ kind: 'edit' });
    return true;
  }
  selectCell(cellsOf(rows[Math.floor(index / cols)])[index % cols]);
  announcePresence();
  return true;
}

ui.doc.addEventListener('keydown', (event) => {
  if (readOnly()) return;
  const mod= event.metaKey || event.ctrlKey;
  if (mod && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      (event.shiftKey ? redo : undo)();
      return;
    }
    if (key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    const shortcut = { b: 'bold', i: 'italic', k: 'link', e: 'code' }[key];
    if (shortcut) {
      event.preventDefault();
      ACTIONS[shortcut]();
      return;
    }
  }
  if (event.key === 'Tab') {
    if (cellAtCaret()) {
      event.preventDefault();
      walkCell(event.shiftKey);
      return;
    }
    event.preventDefault();
    exec('insertText', '  ');
    return;
  }
  if (event.key === 'Enter' && cellAtCaret()) {
    event.preventDefault();
    walkCell(false);
    return;
  }
  // A break inside a fence is code, except the one that gets out of it.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && exitFence()) {
    event.preventDefault();
    return;
  }
  // Enter inside an inline span goes through us, not the browser: a code element that survives the
  // break formats the next line as code. Composition is the input method's business, not ours.
  if (event.key === 'Enter' && !event.isComposing && !composing && endInlineCodeAtCaret()) {
    event.preventDefault();
    exec('insertParagraph');
  }
});

/** Plain text only: pasted markup would bring a stranger's structure into the document. */
ui.doc.addEventListener('paste', (event) => {
  if (readOnly()) return event.preventDefault();
  const text = event.clipboardData?.getData('text/plain');
  if (text == null) return;
  event.preventDefault();
  if (!text) return;
  exec('insertText', text);
});

/* ---------- session wiring ---------- */

session.addEventListener('doc', (event) => {
  const { title, text, users, files, isStale, carried, accessChanged, reason } = event.detail;
  if (files) attachments.setFiles(files);
  ui.title.value = title;
  document.title = `${title} · doc-online`;
  paint(text);
  caret = { start: Math.min(caret.start, text.length), end: Math.min(caret.end, text.length) };
  placeCaret(caret.start, caret.end, { focus: false });
  history.stack = [{ text, kind: 'snap', at: Date.now(), caret }];
  history.index = 0;
  peers = users ?? peers;
  lostEdit = carried && carried.length ? { before: text, after: apply(text, carried) } : null;
  // A share change reaches me as a re-sync with a reason, so the sentence explains itself.
  if (isStale && reason) banner(`${reason}. ${lostEdit ? 'Your unsent edit is waiting below.' : ''}`.trim(), 'info');
  else if (isStale) banner(lostEdit ? 'Re-synced with the server. Your unsent edit is waiting below.' : 'Re-synced with the server.', 'info');
  else banner('');
  if (accessChanged) applyAccess();
  renderPeers();
  renderStats();
  refreshPresence();
});

/** Say with the surface what the server just said about my rights. */
function applyAccess() {
  const access = session.access;
  ui.doc.setAttribute('contenteditable', String(!readOnly()));
  ui.toolbar.hidden = readOnly();
  ui.title.readOnly = readOnly();
  sharing.setAccess(access);
  attachments.setFiles(session.files); // the remove buttons belong to editors only
  ui.role.textContent = access.role === 'reader' ? 'read-only' : access.role;
  ui.role.dataset.kind = access.role === 'owner' ? 'owner' : access.role === 'editor' ? 'role' : 'weak';
  ui.role.hidden = false;
  // Anonymous peers only ever land here on a public document, so the badge is the whole story.
  ui.signIn.hidden = access.role !== 'reader';
  ui.signIn.href = `/?doc=${encodeURIComponent(docId)}`;
}

let repaint = 0;

session.addEventListener('text', (event) => {
  const op = event.detail.op;
  caret = {
    start: transformPosition(op, caret.start, true),
    end: transformPosition(op, caret.end, true),
  };
  if (composing) return; // the surface belongs to the input method until composition ends
  clearTimeout(repaint);
  repaint = setTimeout(() => {
    if (session.text === shown) {
      readCaret();
      renderStats();
      return;
    }
    commitText(session.text, caret, { kind: 'remote' });
  }, 0);
});

session.addEventListener('files', (event) => attachments.setFiles(event.detail.files));

session.addEventListener('users', (event) => {
  peers = event.detail.users;
  renderPeers();
  refreshPresence();
});

session.addEventListener('title', (event) => {
  ui.title.value = event.detail.title;
  document.title = `${event.detail.title} · doc-online`;
});

session.addEventListener('ack', () => renderStats());

session.addEventListener('status', (event) => setStatus(event.detail.status));

session.addEventListener('error', (event) => {
  const { code, message } = event.detail;
  if (code === 'not_found') {
    banner('This document no longer exists.', 'warn');
    ui.editor.hidden = true;
    el('open-list').hidden = false;
    return;
  }
  // The socket is shut, so there is nothing to keep open: send the reader to the lobby,
  // which is where a name and a password can actually be typed.
  if (code === 'need_login' || code === 'forbidden') {
    banner(message, 'warn');
    ui.editor.hidden = true;
    const list = el('open-list');
    list.hidden = false;
    list.replaceChildren(
      Object.assign(document.createElement('a'), {
        className: 'cta',
        href: `/?doc=${encodeURIComponent(docId)}`,
        textContent: code === 'need_login' ? 'Sign in to open this document' : 'Back to the document list',
      }),
    );
    return;
  }
  banner(message, 'warn');
});

session.addEventListener('kicked', () => {
  banner('Another tab took over this session. Reload to continue here.', 'warn');
  ui.doc.setAttribute('contenteditable', 'false');
});

/* ---------- chrome wiring ---------- */

let renameTimer = 0;
ui.title.addEventListener('input', () => {
  document.title = `${ui.title.value} · doc-online`;
  clearTimeout(renameTimer);
  if (readOnly()) return;
  renameTimer = setTimeout(() => session.rename(ui.title.value), 500);
});

function shareUrl(mode) {
  const url = new URL(location.href);
  if (mode) url.searchParams.set('mode', mode);
  else url.searchParams.delete('mode');
  return url.toString();
}

async function copy(button, url) {
  try {
    await navigator.clipboard.writeText(url);
    button.dataset.copied = 'true';
    setTimeout(() => delete button.dataset.copied, 1600);
  } catch {
    window.prompt('Copy this link', url);
  }
}

el('copy-edit').addEventListener('click', (event) => copy(event.currentTarget, shareUrl(null)));
el('copy-view').addEventListener('click', (event) => copy(event.currentTarget, shareUrl('view')));
el('back').addEventListener('click', () => {
  window.onbeforeunload = null;
  location.href = '/';
});

el('banner').addEventListener('click', (event) => {
  if (event.target.dataset.role !== 'restore' || !lostEdit) return;
  commitText(lostEdit.after, { start: lostEdit.after.length, end: lostEdit.after.length });
  lostEdit = null;
  banner('');
});

for (const [id, format] of [
  ['export-md', 'md'],
  ['export-doc', 'doc'],
]) {
  const link = el(id);
  link.href = `/api/docs/${encodeURIComponent(docId)}/export?format=${format}`;
  link.addEventListener('click', (event) => {
    if (readOnly() || session.text.trim()) return;
    event.preventDefault();
    notice('Nothing to export yet.', 'info');
  });
}

// Until the first snapshot answers, the surface is a reader's: nothing here is editable.
ui.doc.setAttribute('contenteditable', 'false');
ui.toolbar.hidden = true;
ui.title.readOnly = true;

window.addEventListener('beforeunload', () => session.close());

setStatus('connecting');
session.connect();
new ResizeObserver(() => {
  cursors.resize();
  chips.resize();
}).observe(ui.doc);
