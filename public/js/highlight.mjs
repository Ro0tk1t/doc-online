/**
 * A small syntax highlighter: five token classes, no dependencies.
 *
 * It reads a fenced block's text and returns pieces of that same text, tagged. Nothing here
 * touches the DOM and nothing invents characters -- `tokens(text, lang)` joined back together is
 * exactly `text`, which is what lets the WYSIWYG bridge keep reading the highlighted markup as the
 * document it came from. The caller supplies the escaping function, so the renderer keeps owning
 * its escape-first policy.
 */

const TOKEN_COLORS = { cmt: '#8b96a5', str: '#a5d6a7', num: '#ffab70', kw: '#82aaff', lit: '#c792ea' };

const JS_KEYWORDS =
  'async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of return set static super switch this throw try typeof var void while with yield type namespace declare readonly optional public private protected'.split(
    ' ',
  );
const JS_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];

const PYTHON_KEYWORDS =
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal pass raise return try while with yield match case self cls'.split(
    ' ',
  );
const PYTHON_LITERALS = ['True', 'False', 'None', 'NotImplemented'];

const BASH_KEYWORDS =
  'if then elif else fi for while until do done case esac function in select time coproc return break continue export local readonly declare unset shift eval exec source set trap'.split(
    ' ',
  );

const CSS_KEYWORDS =
  'important and not only or media supports import keyframes font-face charset page root hover focus active before after first last nth-child'.split(
    ' ',
  );

/** One entry per language: which markers open and close what, and which words mean something. */
const LANGS = {
  js: { line: '//', block: ['/*', '*/'], quotes: ['`', '"', "'"], keywords: JS_KEYWORDS, literals: JS_LITERALS },
  json: { quotes: ['"', "'"], literals: ['true', 'false', 'null'] },
  python: { line: '#', quotes: ['"', "'"], triple: true, keywords: PYTHON_KEYWORDS, literals: PYTHON_LITERALS },
  bash: { line: '#', quotes: ['"', "'"], keywords: BASH_KEYWORDS },
  css: { block: ['/*', '*/'], quotes: ['"', "'"], keywords: CSS_KEYWORDS },
  html: { block: ['<!--', '-->'], quotes: ['"', "'"] },
};

/** What the table knows, in the order a picker should list it. */
export const KNOWN_LANGS = Object.keys(LANGS);

const ALIASES = {
  javascript: 'js',
  node: 'js',
  jsx: 'js',
  ts: 'js',
  typescript: 'js',
  tsx: 'js',
  mjs: 'js',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  scss: 'css',
  less: 'css',
};

const ID_START = /[A-Za-z_$]/;
const ID_BODY = /[A-Za-z0-9_$-]/;
const DIGIT = /[0-9]/;

/** The spellings the language chip offers: every language in the table, plus TypeScript by name. */
export const CHOICES = ['js', 'ts', 'json', 'python', 'bash', 'css', 'html'];

const lower = (lang) => String(lang ?? '').trim().toLowerCase();

export const languageFor = (lang) => ALIASES[lower(lang)] ?? lower(lang);

/** A number runs to its exponent, plus the unit letters CSS writes after it. */
function numberLength(text, at) {
  const rest = text.slice(at);
  const radix = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|[\d_]+(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0] ?? '';
  if (!radix) return 0;
  const unit = /^[a-zA-Z%]{1,4}/.exec(rest.slice(radix.length))?.[0] ?? ''; // css writes 42px, 1.5rem
  return radix.length + unit.length;
}

/** Where a quoted run ends, escapes honoured, and a plain quote never crossing a line. */
function stringLength(text, at, quote, spec) {
  if (spec.triple && text.startsWith(quote.repeat(3), at)) {
    const close = text.indexOf(quote.repeat(3), at + 3);
    return close < 0 ? text.length - at : close + 3 - at;
  }
  let i = at + 1;
  const multiline = quote === '`';
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') i += 2;
    else if (char === quote) return i + 1 - at;
    else if (char === '\n' && !multiline) return i - at; // an unterminated string stops with the line
    else i += 1;
  }
  return text.length - at;
}

/**
 * Split `text` into tagged pieces of itself. An unknown or missing language returns the whole
 * thing untagged, which is the same answer as "render it in one flat colour", and the honest one.
 */
export function tokens(text, lang) {
  const spec = LANGS[languageFor(lang)];
  const source = String(text ?? '');
  if (!spec) return [{ cls: null, text: source }];

  const out = [];
  const push = (cls, value) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += value;
    else out.push({ cls, text: value });
  };

  let at = 0;
  while (at < source.length) {
    if (spec.line && source.startsWith(spec.line, at)) {
      const end = source.indexOf('\n', at);
      const stop = end < 0 ? source.length : end;
      push('cmt', source.slice(at, stop));
      at = stop;
      continue;
    }
    if (spec.block && source.startsWith(spec.block[0], at)) {
      const close = source.indexOf(spec.block[1], at + spec.block[0].length);
      const stop = close < 0 ? source.length : close + spec.block[1].length;
      push('cmt', source.slice(at, stop));
      at = stop;
      continue;
    }
    const quote = spec.quotes?.find((candidate) => source[at] === candidate);
    if (quote) {
      const length = stringLength(source, at, quote, spec);
      push('str', source.slice(at, at + length));
      at += length;
      continue;
    }
    if (DIGIT.test(source[at]) && !/[A-Za-z0-9_.$]/.test(source[at - 1] ?? ' ')) {
      const length = numberLength(source, at);
      if (length) {
        push('num', source.slice(at, at + length));
        at += length;
        continue;
      }
    }
    if (ID_START.test(source[at])) {
      let end = at + 1;
      while (end < source.length && ID_BODY.test(source[end])) end += 1;
      const word = source.slice(at, end);
      const cls = spec.keywords?.includes(word) ? 'kw' : spec.literals?.includes(word) ? 'lit' : null;
      push(cls, word);
      at = end;
      continue;
    }
    push(null, source[at]);
    at += 1;
  }
  return out;
}

/**
 * The HTML for a fence body: escaped text, wrapped in a span per token class. `escape` comes from
 * the caller so this module never decides how a quote or an angle bracket is made safe.
 *
 * The colour travels inline because the `.doc` export shares this renderer, and Word is not
 * obliged to honour a class selector. The page still gets the class, which is where an italic
 * comment belongs.
 */
export function renderCode(text, lang, escape) {
  return tokens(text, lang)
    .map((token) =>
      token.cls ? `<span class="tok-${token.cls}" style="color:${TOKEN_COLORS[token.cls]}">${escape(token.text)}</span>` : escape(token.text),
    )
    .join('');
}
