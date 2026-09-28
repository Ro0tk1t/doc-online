/**
 * Markdown table text.
 *
 * The grid the user edits lives in the DOM (see `serialize.mjs`); this module owns only the
 * GFM shape that goes in and comes out of it: a header row, a delimiter row that carries
 * alignment, and body rows, all padded to one width per column. `serialize.mjs` imports the
 * same row and padding helpers so a table typed into the grid is byte-identical to one built
 * here, which keeps a peer's repaint from rewriting the document.
 */

const escape = (value) => String(value ?? '').trim().replace(/\|/g, '\\|');
const range = (n) => Array.from({ length: n }, (_, i) => i);
const blanks = (n) => range(n).map(() => '');

/** Width each column is padded to: at least 3, and at least as wide as its widest cell. */
export function padWidths(rows) {
  const cols = Math.max(1, ...rows.map((row) => row.length));
  return range(cols).map((c) => Math.max(3, ...rows.map((row) => (row[c] ?? '').length)));
}

/** Same rule, from raw cell values, for callers that have not serialised them yet. */
export function columnWidths(header, rows) {
  return padWidths([header, ...rows].map((row) => row.map(escape)));
}

/** The `---`/`--:`/`:-:` marker that carries a column's alignment. Left is the default. */
export function delimiterCell(width, align) {
  const fill = '-'.repeat(Math.max(1, width - (align === 'center' ? 2 : align ? 1 : 0)));
  if (align === 'center') return `:${fill}:`;
  if (align === 'right') return `${fill}:`;
  return fill.padEnd(width, '-');
}

/** One `| a | b |` row; cells are always left-padded, alignment lives in the delimiter. */
export const ROW_LEAD = '| ';
export const ROW_JOIN = ' | ';
export const ROW_TAIL = ' |';

export function tableRow(cells, widths) {
  return ROW_LEAD + cells.map((cell, c) => escape(cell).padEnd(widths[c])).join(ROW_JOIN) + ROW_TAIL;
}

export function makeTable(cols = 3, bodyRows = 2) {
  return {
    header: range(cols).map((i) => `Column ${i + 1}`),
    rows: range(bodyRows).map(() => blanks(cols)),
    aligns: blanks(cols),
  };
}

/** Render the model back to aligned GFM text, without a trailing newline. */
export function serializeTable({ header, rows, aligns = [] }) {
  const cols = Math.max(1, header.length, ...rows.map((row) => row.length));
  const norm = (list) => range(cols).map((c) => list[c] ?? '');
  const head = norm(header);
  const body = rows.map(norm);
  const widths = columnWidths(head, body);
  const delim = range(cols).map((c) => delimiterCell(widths[c], aligns[c] ?? ''));
  return [tableRow(head, widths), tableRow(delim, widths), ...body.map((row) => tableRow(row, widths))].join('\n');
}

/** Cells of a row, tab-separated, for pasting into a spreadsheet. */
export function toTsv({ header, rows }) {
  return [header, ...rows].map((row) => row.join('\t')).join('\n');
}
