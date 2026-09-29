/**
 * Where a block lands in the text.
 *
 * The toolbar, the table grid and an attachment upload all hand a Markdown block to the
 * caret, and the caret is never on a convenient boundary. This is the whole of that
 * arithmetic, kept away from the DOM so it can be tested against real documents:
 * a block finishes the line it was dropped on, and owns a blank line on each side.
 * Fences are here too: where they are, how their language is rewritten, and which line break
 * finally gets the caret out of one.
 */

import { FENCE, fenceCloser } from './markdown.mjs';

/** Blank line before the block, unless one is already there. */
export function gapBefore(before) {
  if (!before) return '';
  if (before.endsWith('\n\n')) return '';
  return before.endsWith('\n') ? '\n' : '\n\n';
}

/** Blank line after the block, so what follows never reads as its continuation. */
export function gapAfter(rest) {
  if (!rest.trim()) return '';
  if (rest.startsWith('\n\n')) return '';
  return rest.startsWith('\n') ? '\n' : '\n\n';
}

/**
 * Splice `md` in at offset `at`. A caret in the middle of a sentence is not an invitation to
 * cut it in half: the block waits for the line to end, which is what the surface shows too.
 */
export function planInsert(text, at, md) {
  const lineEnd = text.indexOf('\n', at);
  const where = lineEnd > at ? lineEnd + 1 : at; // finish the current line first
  const rest = text.slice(where);
  const head = gapBefore(text.slice(0, where));
  const body = `${head}${md.trimEnd()}`;
  const tail = gapAfter(rest);
  return {
    text: `${text.slice(0, where)}${body}${tail}${rest}`,
    start: where,
    end: where + body.length + tail.length, // caret: after the block, before the seam
    content: where + head.length, // first character of the block itself
  };
}

/**
 * The whole lines a span touches. A block command owns the lines it is applied to: replacing
 * only the selected characters would leave the unselected halves stranded on either side.
 */
export function linesSpan(text, from, to) {
  const start = from <= 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  const end = text.indexOf('\n', Math.max(start, to));
  return { start, end: end < 0 ? text.length : end };
}

/** Swap a span for a block, mending the blank-line seams the removed lines were part of. */
export function planReplace(text, from, to, md) {
  const rest = text.slice(to);
  const head = gapBefore(text.slice(0, from));
  const body = `${head}${md.trimEnd()}`;
  const tail = gapAfter(rest);
  return {
    text: `${text.slice(0, from)}${body}${tail}${rest}`,
    start: from,
    end: from + body.length + tail.length,
    content: from + head.length,
  };
}

/**
 * Every fence in the text, in the order the renderer puts a `<pre>` down for it -- which is what
 * lets a control float over each block without the DOM having to say how many there are.
 */
export function fenceSpans(text) {
  const out = [];
  const lines = text.split('\n');
  let at = 0;
  let open = null;
  for (const line of lines) {
    if (open) {
      if (fenceCloser(open.marker).test(line)) {
        open.end = at + line.length;
        open = null;
      }
    } else {
      const head = FENCE.exec(line);
      if (head) out.push((open = { start: at, marker: head[1], info: head[2] ?? '', end: at + line.length }));
    }
    at += line.length + 1;
  }
  if (open) open.end = text.length; // an unclosed fence runs to the end, exactly as it renders
  return out.map(({ start, info, end }) => ({ start, info, end }));
}

/**
 * Rewrite a fence's info string and nothing else. The language is part of the document, so it
 * travels as text: this is the only writer, and the marker keeps its own length.
 */
export function setFenceLanguage(text, at, info) {
  const lineEnd = text.indexOf('\n', at);
  const head = text.slice(at, lineEnd < 0 ? text.length : lineEnd);
  const fence = FENCE.exec(head);
  if (!fence) return text;
  const clean = String(info ?? '').replace(/[^\w.+-]/g, ''); // only what the renderer accepts
  return `${text.slice(0, at)}${fence[1]}${clean}${text.slice(lineEnd < 0 ? text.length : lineEnd)}`;
}

/**
 * The line break that leaves a fence. Inside a block an Enter belongs to the code, with two
 * exceptions: the caret's own line has to be empty, and it has to be the last thing in the block,
 * because a break under a caret that still has code below it would push that code out of the fence
 * rather than out of the block. A body of one empty line is not that exit either -- it is the state
 * the code block button leaves behind, where the first Enter means "start writing code".
 *
 * A fence that never held any code goes with the exit: it was abandoned, not finished.
 */
export function planFenceExit(text, at) {
  const fence = fenceSpans(text).find(({ start, end }) => at > start && at < end);
  if (!fence) return null;
  const headEnd = text.indexOf('\n', fence.start);
  const head = FENCE.exec(text.slice(fence.start, headEnd < 0 ? text.length : headEnd));
  if (!head) return null;
  const closer = text.lastIndexOf('\n', fence.end - 1) + 1; // the closing marker owns its own line
  if (!fenceCloser(head[1]).test(text.slice(closer, fence.end))) return null; // unclosed: nothing to leave

  const lines = text.split('\n');
  const starts = [];
  lines.reduce((off, line, i) => (starts[i] = off, off + line.length + 1), 0);
  const where = (offset) => starts.findLastIndex((start) => start <= offset);
  const headLine = where(fence.start);
  const lastLine = where(closer); // the closing marker's own line
  const caret = where(at);
  if (caret <= headLine || caret >= lastLine) return null;
  if (lines[caret] !== '') return null; // its line holds code
  if (lines.slice(caret + 1, lastLine).some((line) => line !== '')) return null; // code below
  if (lastLine - headLine - 1 < 2) return null; // one empty line is not an exit

  // Everything blank from the caret down is the run of Enters that wanted out, so all of it goes.
  let cut = caret;
  while (cut - 1 > headLine && lines[cut - 1] === '') cut -= 1;

  if (!lines.slice(headLine + 1, cut).join('\n').trim()) {
    // The block never held code, so it goes with the exit rather than staying behind as a husk.
    const before = text.slice(0, fence.start).replace(/\n+$/, '');
    const after = text.slice(fence.end).replace(/^\n+/, '');
    const joined = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    return { text: joined, end: before ? before.length + (after ? 2 : 0) : 0 };
  }
  const rest = text.slice(closer);
  const next = `${text.slice(0, starts[cut])}${rest}`;
  const past = starts[cut] + (fence.end - closer); // just past the closing marker
  const seam = /^\n+/.exec(next.slice(past))?.[0].length ?? 0; // land on the block below, not in the gap
  return { text: next, end: past + seam };
}
