/**
 * A tiny, dependency-free Markdown renderer for the preview pane.
 *
 * Text is HTML-escaped before any markup is generated, and link targets pass a URL
 * allowlist, so untrusted collaborator text cannot inject script here.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Placeholder marker for code spans, built at runtime so no control character has to
// be written literally into this source file.
const GUARD = String.fromCodePoint(2);
const SAFE_HREF = /^(?:https?:|mailto:|ftp:|#|\/|\.\/|\.\.\/)/i;
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])[ )]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*$/;

function href(raw) {
  const url = String(raw).trim();
  return SAFE_HREF.test(url) ? url : '#';
}

function inline(src) {
  const codes = [];
  let out = escapeHtml(src);
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return GUARD + (codes.length - 1) + GUARD;
  });
  out = out.replace(/!\[([^\]]*)]\(((?:[^()\s]|\((?:[^()\s]*)\))+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, url, title) =>
    `<img src="${href(url)}" alt="${alt}" loading="lazy"${title ? ` title="${title}"` : ''}>`,
  );
  out = out.replace(/\[([^\]]+|)\]\(((?:[^()\s]|\((?:[^()\s]*)\))+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, label, url, title) =>
    `<a href="${href(url)}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`,
  );
  out = out.replace(/(^|[\s(])(https?:\/\/|www\.)[^\s<>()\]]+/g, (match, lead) => {
    const url = match.slice(lead.length);
    return `${lead}<a href="${href(url.startsWith('www.') ? 'http://' + url : url)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
  });
  out = out.replace(/\*\*\*(?!\s)([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(?!\s)(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])__(?!\s)([^_\n]+?)__(?![\w_])/g, '$1<strong>$2</strong>');
  out = out.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>');
  out = out.replace(/~~(?!\s)(.+?)~~/g, '<del>$1</del>');
  out = out.replace(/==(?!\s)([^=\n]+?)==/g, '<mark>$1</mark>');
  out = out.replace(new RegExp(GUARD + '(\\d+)' + GUARD, 'g'), (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

function taskBox(raw) {
  const m = /^\[( |x|X)\]\s+(.*)$/.exec(raw);
  if (!m) return { text: raw, cls: '' };
  return { text: m[2], cls: ' task', box: `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> ` };
}

function renderList(lines, start) {
  const first = ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(lines[start].slice(base).trim()[0]);
  const items = [];
  let i = start;
  let loose = false;

  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m) {
      const indent = m[1].length;
      if (indent < base) break;
      if (indent > base) {
        if (!items.length) break;
        items[items.length - 1].nested.push(line.slice(base + 2));
        i += 1;
        continue;
      }
      if (/^\d/.test(m[0].trim()[0]) !== ordered) break;
      items.push({ text: m[2], nested: [] });
      i += 1;
      continue;
    }
    if (!line.trim()) {
      const next = lines[i + 1];
      const nextItem = next ? ITEM.exec(next) : null;
      const nextIndent = next ? (nextItem ? nextItem[1].length : /^\s*/.exec(next)[0].length) : -1;
      if (items.length && (nextItem ? nextItem[1].length === base : nextIndent > base)) {
        loose = true;
        i += 1;
        continue;
      }
      break;
    }
    if (!items.length || isBlockStart(line)) break;
    const indent = /^\s*/.exec(line)[0].length;
    if (indent <= base) break;
    items[items.length - 1].nested.push(line.slice(Math.min(base + 2, indent)));
    i += 1;
  }

  const body = items
    .map((item) => {
      const { text, cls, box } = taskBox(item.text);
      return `<li class="li${cls}">${box ?? ''}${inline(text)}${item.nested.length ? renderBlocks(item.nested) : ''}</li>`;
    })
    .join('');
  return { html: `<${ordered ? 'ol' : 'ul'}>${body}</${ordered ? 'ol' : 'ul'}>`, next: i };
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff -]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const splitRow = (line) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

function renderTable(lines, start) {
  const header = splitRow(lines[start]);
  const delim = splitRow(lines[start + 1]);
  if (!header.length || !delim.length || delim.some((c) => !/^:?-{1,}:?$/.test(c))) return null;
  const align = delim.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }
  const cell = (list) =>
    `<tr>${list
      .map((value, idx) => `<td${align[idx] ? ` class="a-${align[idx]}"` : ''}>${inline(value)}</td>`)
      .join('')}</tr>`;
  return {
    html:
      '<table><thead><tr>' +
      header.map((value, idx) => `<th${align[idx] ? ` class="a-${align[idx]}"` : ''}>${inline(value)}</th>`).join('') +
      `</tr></thead><tbody>${rows.map(cell).join('')}</tbody></table>`,
    next: i,
  };
}

const isBlockStart = (line) =>
  FENCE.test(line) ||
  /^ {0,3}#{1,6}\s/.test(line) ||
  /^ {0,3}>/.test(line) ||
  /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line) ||
  ITEM.test(line);

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const closer = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    const head = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (head) {
      const level = head[1].length;
      out.push(`<h${level} id="${slugify(head[2])}">${inline(head[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (lines[i].trim() && !isBlockStart(lines[i])))) {
        quote.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      continue;
    }

    if (ITEM.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (line.includes('|') && lines[i + 1] && lines[i + 1].includes('-')) {
      const table = renderTable(lines, i);
      if (table) {
        out.push(table.html);
        i = table.next;
        continue;
      }
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !/^ {0,3}(#{1,6}\s|>|([-*_])\s*(?:\2\s*){2,}$)/.test(lines[i]) &&
      !ITEM.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) {
      const html = para
        .map((l) => inline(l.replace(/\s+$/, '')))
        .join(para.length > 1 && /  $/.test(para[0]) ? '<br>\n' : '\n');
      out.push(`<p>${html}</p>`);
    } else {
      i += 1;
    }
  }
  return out.join('\n');
}

export function renderMarkdown(source) {
  const text = String(source).replace(/\r\n?/g, '\n');
  if (!text.trim()) return '<p class="empty">This document is empty.</p>';
  return renderBlocks(text.split('\n'));
}
