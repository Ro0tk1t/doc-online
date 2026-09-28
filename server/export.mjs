/**
 * Document export: Markdown source or a Word-openable .doc.
 *
 * The .doc branch does not fake a binary container -- it serves the preview pane's
 * own HTML (renderMarkdown is a pure string -> string module, so it runs unchanged
 * on the server) under the Word MIME type. This is Word-HTML, not OOXML: a real
 * .docx would need a zip writer, which a dependency-free server has no business
 * shipping. server.js stays thin by asking exportDocument() for body/type/filename.
 */

import { renderMarkdown } from '../public/js/markdown.mjs';
import { cleanName } from './files.mjs';

const FORMATS = {
  md: { ext: '.md', type: 'text/markdown; charset=utf-8' },
  doc: { ext: '.doc', type: 'application/msword; charset=utf-8' },
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Word ignores external CSS, so the elements the renderer emits get styled inline.
const WORD_CSS = [
  'body { font-family: Calibri, Carlito, sans-serif; font-size: 11pt; }',
  'h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }',
  'blockquote { margin-left: 24pt; padding-left: 12pt; border-left: 2.25pt solid #b8b8b8; color: #525252; }',
  'code { font-family: Consolas, "Courier New", monospace; background-color: #f2f2f2; }',
  'pre { font-family: Consolas, "Courier New", monospace; background-color: #f2f2f2; padding: 6pt; }',
  'table { border-collapse: collapse; }',
  'th, td { border: 0.5pt solid #767676; padding: 3pt 6pt; text-align: left; }',
].join('\n');

/** Usable absolute origin, or '' -- anything with a path, query or quote char is refused. */
export function safeBaseUrl(value) {
  const base = String(value ?? '').replace(/\/+$/, '');
  return /^https?:\/\/[^<>"'\\/?#\s]+$/.test(base) ? base : '';
}

/** Origin for asset URLs in an export, trusting the proxy headers when present. */
export function requestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().replace(/:$/, '');
  const host = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() || String(req.headers.host ?? '');
  return safeBaseUrl(`${proto === 'https' ? 'https' : 'http'}://${host}`);
}

/** Turn a document row into the bytes of a download. Throws a 400 on unknown formats. */
export function exportDocument(doc, { format = 'md', baseUrl = '' } = {}) {
  // hasOwn, because FORMATS.constructor would otherwise pass as a real format.
  const chosen = Object.hasOwn(FORMATS, format) ? FORMATS[format] : null;
  if (!chosen) throw Object.assign(new Error(`unknown export format: ${String(format).slice(0, 32)}`), { statusCode: 400 });
  const filename = `${cleanName(doc.title).slice(0, 100)}${chosen.ext}`;
  if (format === 'md') return { body: doc.text, type: chosen.type, filename };
  return { body: wordDocument(doc, safeBaseUrl(baseUrl)), type: chosen.type, filename };
}

function wordDocument(doc, base) {
  let html = renderMarkdown(doc.text);
  // Word has no page URL to resolve site-relative references against, so pin them here.
  if (base) html = html.replace(/\b(src|href)="\/(?!\/)/g, (match, attr) => `${attr}="${base}/`);
  return [
    '<!DOCTYPE html>',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="ProgId" content="Word.Document">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>\n${WORD_CSS}\n</style>`,
    '</head>',
    '<body>',
    html,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
