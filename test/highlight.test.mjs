import test from 'node:test';
import assert from 'node:assert/strict';
import { languageFor, renderCode, tokens } from '../public/js/highlight.mjs';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Only the classes a reader needs, in the order they appear: the plain text is noise here. */
const tagged = (text, lang) => tokens(text, lang).filter((token) => token.cls).map((token) => [token.cls, token.text]);

const SAMPLES = {
  js: 'const re = /a|"g/;\n// done\n"not a comment /* nor one */"\n/* block */\nfoo(42, true, `a ${b}`);\n',
  json: '{"a": 1, "b": [true, null]}',
  python: 'def f(x):\n    """doc\n    line"""\n    # note\n    return x if x else None\n',
  bash: '#!/bin/sh\nif [ -f "a file" ]; then\n  echo $HOME\nfi\n',
  css: 'a:hover { color: #ff0000; margin: 0 4px } /* c */\n',
  html: '<!-- a comment -->\n<a href="x" title="y"><b>hi</b></a>\n',
  plaintext: 'anything at all: 1 "two"\n',
};

test('tagging never changes a single character', () => {
  for (const [lang, text] of Object.entries(SAMPLES)) {
    assert.equal(tokens(text, lang).map((token) => token.text).join(''), text, lang);
  }
});

test('an unknown language is left in one flat piece', () => {
  assert.deepEqual(tokens('const a = 1;', 'klingon'), [{ cls: null, text: 'const a = 1;' }]);
  assert.deepEqual(tokens('const a = 1;', ''), [{ cls: null, text: 'const a = 1;' }]);
});

test('comments, strings, numbers, keywords and literals each get their class', () => {
  assert.deepEqual(tagged('const a = 1; // note', 'js'), [
    ['kw', 'const'],
    ['num', '1'],
    ['cmt', '// note'],
  ]);
  assert.deepEqual(tagged('let t = true', 'js'), [
    ['kw', 'let'],
    ['lit', 'true'],
  ]);
  assert.deepEqual(tagged('let a = "x" + `y`', 'js'), [
    ['kw', 'let'],
    ['str', '"x"'],
    ['str', '`y`'],
  ]);
});

test('a stray quote cannot swallow the rest of the block', () => {
  // Unterminated on purpose: the string stops at the line, so the next line still reads as code.
  assert.deepEqual(tagged('let bad = "oops\nlet ok = 2', 'js'), [
    ['kw', 'let'],
    ['str', '"oops'],
    ['kw', 'let'],
    ['num', '2'],
  ]);
});

test('a run that spans lines stays one string', () => {
  assert.deepEqual(tagged('`a\nb`\n', 'js'), [['str', '`a\nb`']]);
  assert.deepEqual(tagged('"""doc\nline"""\n', 'python'), [['str', '"""doc\nline"""']]);
});

test('each language reads its own comment marker', () => {
  assert.deepEqual(tagged('# note\n', 'bash'), [['cmt', '# note']]);
  assert.deepEqual(tagged('# note\n', 'python'), [['cmt', '# note']]);
  assert.deepEqual(tagged('/* c */\n', 'css'), [['cmt', '/* c */']]);
  assert.deepEqual(tagged('<!-- c -->\n', 'html'), [['cmt', '<!-- c -->']]);
  assert.deepEqual(tagged('for x in y\n', 'js'), [['kw', 'for'], ['kw', 'in']]);
});

test('a number stops where the identifier does not begin', () => {
  assert.deepEqual(tagged('42px 0x1f 1e3 a1', 'css'), [
    ['num', '42px'],
    ['num', '0x1f'],
    ['num', '1e3'],
  ]);
  assert.deepEqual(tagged('a1 b2', 'js'), []); // inside an identifier, digits are not a number
});

test('the language on the fence is the language we highlight', () => {
  for (const [alias, expected] of [['TypeScript', 'js'], ['py', 'python'], ['SH', 'bash'], ['htm', 'html'], ['text', 'text']]) {
    assert.equal(languageFor(alias), expected);
  }
});

test('the html a fence gets is escaped, then wrapped', () => {
  assert.equal(
    renderCode('const a = "<b> & \'\\""', 'js', escapeHtml),
    '<span class="tok-kw" style="color:#82aaff">const</span> a = <span class="tok-str" style="color:#a5d6a7">&quot;&lt;b&gt; &amp; &#39;\\&quot;&quot;</span>',
  );
});

test('every language the tokenizer knows is offered by the chip', async () => {
  const { CHOICES, KNOWN_LANGS, languageFor } = await import('../public/js/highlight.mjs');
  for (const lang of KNOWN_LANGS) assert.ok(CHOICES.includes(lang), `${lang} is missing from the picker`);
  for (const choice of CHOICES) assert.ok(KNOWN_LANGS.includes(languageFor(choice)), `${choice} resolves to nothing`);
});
