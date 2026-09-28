/**
 * The document outline.
 *
 * Built from the model text, never from the DOM: the rail is a second view of the same string
 * every peer is editing, so it can only drift if the document itself does. Heading and fence
 * recognition mirrors `markdown.mjs` line for line, which is what keeps a row in the rail and
 * an `<hN>` on the page in agreement.
 *
 * Each row carries the Markdown offset of its line, so jumping is `placeCaret(start)` and the
 * caret ends up in the same coordinate space every operation already travels in.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*$/;
const HEAD = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** A row's identity: level plus text. Two headings of the same name fold together. */
const keyOf = (row) => `${row.level} ${row.text}`;

/** Best-effort plain text for a label: the markup is noise once you are navigating. */
export function label(raw) {
  return String(raw ?? '')
    .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+|)]\([^)]*\)/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ATX headings outside a fenced block, in document order, with their line offsets. */
export function headings(text) {
  const rows = [];
  let at = 0;
  let closer = null;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const opened = closer === null ? FENCE.exec(line) : null;
    if (opened) {
      closer = new RegExp(`^ {0,3}\\${opened[1][0]}{${opened[1].length},}[ \\t]*$`);
    } else if (closer) {
      if (closer.test(line)) closer = null; // a closing marker ends the block; nothing inside is a heading
    } else {
      const head = HEAD.exec(line);
      if (head) rows.push({ level: head[1].length, text: label(head[2]), start: at });
    }
    at += line.length + 1;
  }
  return rows;
}

/**
 * The rows to paint, each annotated with how deep it sits (`depth` strict ancestors) and
 * whether a folded ancestor hides it. `closed` is the set of keys the user folded shut.
 */
export function outline(text, closed = []) {
  const shut = closed instanceof Set ? closed : new Set(closed);
  const rows = headings(text);
  const stack = [];
  return rows.map((row, index) => {
    while (stack.length && stack[stack.length - 1].level >= row.level) stack.pop();
    const next = rows[index + 1];
    const entry = {
      ...row,
      key: keyOf(row),
      depth: stack.length,
      foldable: Boolean(next && next.level > row.level),
      closed: shut.has(keyOf(row)),
      hidden: stack.some((ancestor) => shut.has(ancestor.key)),
    };
    stack.push(entry);
    return entry;
  });
}

/** The row a caret belongs to: the closest visible heading at or above it. */
export function activeRow(rows, offset) {
  let best = null;
  for (const row of rows) {
    if (row.hidden || row.start > offset) continue;
    if (!best || row.start >= best.start) best = row;
  }
  return best?.key ?? null;
}
