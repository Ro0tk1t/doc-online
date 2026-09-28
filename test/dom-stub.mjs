/**
 * A DOM stub small enough to read, big enough to be honest about.
 *
 * Node has no DOM, so the serializer is tested against the markup `markdown.mjs` actually
 * emits: `parse(render(text))` gives the same tree shape the browser builds from innerHTML.
 * Only the properties `serialize.mjs` reads are implemented.
 */

const VOID = new Set(['br', 'img', 'input', 'hr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

const decode = (raw) =>
  raw.replace(/&(#?[a-z0-9]+);/gi, (whole, key) => ENTITIES[key.toLowerCase()] ?? whole);

export class Element {
  constructor(name, attrs = {}) {
    this.nodeType = 1;
    this.nodeName = String(name).toUpperCase();
    this.tagName = this.nodeName;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map(Object.entries(attrs));
    this.className = attrs.class ?? '';
  }

  getAttribute(name) {
    const value = this.attributes.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  get textContent() {
    return this.childNodes.map((child) => child.data ?? child.textContent).join('');
  }
}

export class Text {
  constructor(data) {
    this.nodeType = 3;
    this.nodeName = '#text';
    this.childNodes = [];
    this.parentNode = null;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }
}

const parseAttrs = (source) => {
  const attrs = {};
  for (const match of source.matchAll(/([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)) {
    attrs[match[1].toLowerCase()] = match[2] === undefined ? '' : decode(match[2]);
  }
  return attrs;
};

/** Parse the renderer's own output into an Element/Text tree wrapped in a root div. */
export function parse(html) {
  const root = new Element('div');
  const stack = [root];
  let cursor = 0;

  const emitText = (raw) => {
    if (!raw) return;
    stack[stack.length - 1].appendChild(new Text(decode(raw)));
  };

  while (cursor < html.length) {
    const next = html.indexOf('<', cursor);
    if (next > cursor) emitText(html.slice(cursor, next));
    if (next < 0) break;

    const close = /^<\/([a-z0-9]+)>/i.exec(html.slice(next));
    if (close) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === close[1].toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      cursor = next + close[0].length;
      continue;
    }

    const open = /^<([a-z0-9]+)((?:\s+[^<>]*?)?)(\s*\/?)>/i.exec(html.slice(next));
    if (!open) {
      emitText(html.slice(next, next + 1));
      cursor = next + 1;
      continue;
    }
    const element = new Element(open[1], parseAttrs(open[2]));
    if (open[1].toLowerCase() === 'input' && /(^|\s)checked(\s|$)/.test(open[2])) element.checked = true;
    stack[stack.length - 1].appendChild(element);
    if (!VOID.has(open[1].toLowerCase())) stack.push(element);
    cursor = next + open[0].length;
  }
  return root;
}

/** Build a tree by hand for shapes the renderer never emits, like a contenteditable div. */
export function el(name, attrs = {}, ...children) {
  const element = new Element(name, attrs);
  for (const child of children) element.appendChild(typeof child === 'string' ? new Text(child) : child);
  return element;
}

export const txt = (data) => new Text(data);

/** Every text node under `root`, in document order. */
export function textNodes(root, into = []) {
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 3) into.push(child);
    else textNodes(child, into);
  }
  return into;
}
