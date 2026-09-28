/**
 * Where a block lands in the text.
 *
 * The toolbar, the table grid and an attachment upload all hand a Markdown block to the
 * caret, and the caret is never on a convenient boundary. This is the whole of that
 * arithmetic, kept away from the DOM so it can be tested against real documents:
 * a block finishes the line it was dropped on, and owns a blank line on each side.
 */

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
