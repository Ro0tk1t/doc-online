import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.mjs';
import { serializeTable, makeTable } from '../public/js/table.mjs';
import { offsetOf, positionOf, serializeDocument, tableState, toMarkdown } from '../public/js/serialize.mjs';
import { el, parse, textNodes, txt } from './dom-stub.mjs';

/** What the browser holds after innerHTML = renderMarkdown(text): the round trip under test. */
const surface = (markdown) => parse(renderMarkdown(markdown));
const through = (markdown) => toMarkdown(surface(markdown));

test('a rendered document serializes back to itself', () => {
  const doc = [
    '# Heading one',
    '',
    'A paragraph with **bold**, *em*, `code`, ~~struck~~ and ==marked== words.',
    '',
    '## Second level',
    '',
    'Two soft-wrapped lines stay one paragraph.',
    '',
    '- first bullet',
    '- second bullet',
    '',
    '1. one',
    '2. two',
    '',
    '> a quote',
    '> with two lines',
    '',
    '---',
    '',
    '```js',
    'const a = 1;',
    '',
    'console.log(a);',
    '```',
    '',
    'A [link](https://example.com) and an ![image](/files/abc123.png).',
  ].join('\n');
  assert.equal(through(doc), doc);
});

test('adjacent paragraphs never merge', () => {
  assert.equal(through('first\n\nsecond'), 'first\n\nsecond');
});

test('nested lists and task items keep their markers', () => {
  const doc = ['- outer', '  - inner', '', '- [ ] todo', '- [x] done'].join('\n');
  // the renderer folds a blank line inside a list, so one list is the fixed point
  assert.equal(through(doc), ['- outer', '  - inner', '- [ ] todo', '- [x] done'].join('\n'));
  assert.equal(through(through(doc)), through(doc));
  assert.equal(through('- [ ] todo\n- [x] done'), '- [ ] todo\n- [x] done');
  assert.equal(through('1. one\n2. two'), '1. one\n2. two');
});

test('a quote keeps its prefix on every line', () => {
  assert.equal(through('> quoted\n> again'), '> quoted\n> again');
  assert.equal(through('> one\n\n> two'), '> one\n\n> two');
});

test('code fences keep blank lines and trailing spaces', () => {
  const fenced = '```\nlet x = 1;\n\nlet y = 2;   \n```';
  assert.equal(through(fenced), fenced);
});

test('a table in the grid is byte-identical to the model', () => {
  const grid = serializeTable(makeTable(3, 2));
  assert.equal(through(`${grid}\n\nAfter the table`), `${grid}\n\nAfter the table`);
});

test('column alignment travels through the delimiter row', () => {
  const doc = ['| name | qty |', '| ---- | --: |', '| a    | 1   |'].join('\n');
  assert.equal(through(doc), doc);
  const centered = ['| name | qty |', '| ---- | :-: |', '| a    | 1   |'].join('\n');
  assert.equal(through(centered), centered);
});

test('pipes and marks inside a cell stay readable', () => {
  const doc = ['| a \\| b | **c** |', '| ------ | ----- |', '| 1      | 2     |'].join('\n');
  assert.equal(through(doc), doc);
});

test('a hand-built table matches serializeTable output', () => {
  const built = el(
    'table',
    {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', { class: 'a-right' }, 'Qty'))),
    el('tbody', {}, el('tr', {}, el('td', {}, txt('Widget')), el('td', {}, txt('12')))),
  );
  const markdown = toMarkdown(built);
  const state = tableState(built);
  assert.deepEqual(state, { header: ['Name', 'Qty'], rows: [['Widget', '12']], aligns: ['', 'right'] });
  assert.equal(markdown, serializeTable(state));
});

test('an empty cell the editor built with a <br> reads as an empty cell', () => {
  const grid = el(
    'table',
    {},
    el('thead', {}, el('tr', {}, el('th', {}, txt('a'), el('br')), el('th', {}, el('br')))),
    el('tbody', {}, el('tr', {}, el('td', {}, el('br')), el('td', {}, txt('b'), el('br')))),
  );
  assert.equal(toMarkdown(grid), serializeTable({ header: ['a', ''], rows: [['', 'b']], aligns: ['', ''] }));
});

test('placeholders never reach the model', () => {
  const root = el('div', {}, el('p', { class: 'empty' }, 'Nothing yet — start typing.'), el('div', { 'data-placeholder': '' }, 'Start writing'), el('p', {}, txt('real')));
  assert.equal(toMarkdown(root), 'real');
});

test('browser spaces and trailing blanks normalize away', () => {
  const root = el('div', {}, el('p', {}, txt('\u00a0kept\u00a0')), el('p', {}, txt('trailing   ')));
  const text = toMarkdown(root);
  assert.equal(text.includes('\u00a0'), false);
  assert.equal(text, 'kept\n\ntrailing');
});

test('empty blocks left by the browser stay out of the document', () => {
  const root = el('div', {}, el('p', {}, el('br')), el('p', {}, txt('real')), el('div', {}, el('br')));
  assert.equal(toMarkdown(root), 'real');
});

test('a line break followed by a newline does not split the paragraph', () => {
  const root = el('div', {}, el('p', {}, txt('a'), el('br'), txt('\nb')));
  assert.equal(toMarkdown(root), 'a\nb');
});

test('serialization is a fixed point after one pass', () => {
  const messy = 'para *with* markup\n\n- item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
  const first = through(messy);
  assert.equal(through(first), first);
  assert.equal(toMarkdown(surface(first)), first);
});

test('caret offsets map to markdown and back', () => {
  const doc = '# Title\n\nBody **bold** tail\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |';
  const root = surface(doc);
  const { text, marks } = serializeDocument(root);
  assert.equal(text, doc);
  for (const node of textNodes(root)) {
    if (!/[^\s]/.test(node.data)) continue; // innerHTML's line breaks are not content
    for (let offset = 0; offset <= node.data.length; offset += 1) {
      const at = offsetOf(marks, node, offset);
      assert.notEqual(at, null, 'no offset for a text node');
      const back = positionOf(marks, root, at);
      assert.equal(back.node, node, `wanted the node holding offset ${at}`);
      assert.equal(back.offset, offset, `caret slid in "${node.data}"`);
    }
  }
});

test('element positions fall between their children', () => {
  const root = surface('# Title\n\nBody text');
  const { text, marks } = serializeDocument(root);
  const blocks = root.childNodes.filter((node) => node.nodeType === 1);
  const h1 = blocks[0];
  const para = blocks[1];
  assert.equal(offsetOf(marks, h1, 0), text.indexOf('Title'));
  assert.equal(offsetOf(marks, h1, 1), text.indexOf('Title') + 'Title'.length);
  assert.equal(offsetOf(marks, para, 0), text.indexOf('Body'));
  assert.equal(offsetOf(marks, root, root.childNodes.indexOf(para)), text.indexOf('Body'));
  assert.equal(offsetOf(marks, root, root.childNodes.length), text.length);
  // a caret dropped in the line break between blocks lands on the edge of a real one
  const gap = root.childNodes[1];
  assert.match(gap.data, /^\s+$/);
  assert.equal(offsetOf(marks, gap, 0), text.indexOf('Title') + 'Title'.length);
  assert.equal(offsetOf(marks, gap, 1), text.indexOf('Body'));
  assert.equal(offsetOf(marks, txt('unrelated'), 0), null);
});

test('a caret past the end of a clamped region stays inside it', () => {
  const root = el('div', {}, el('p', {}, txt('abc   ')));
  const { text, marks } = serializeDocument(root);
  assert.equal(text, 'abc');
  const node = root.childNodes[0].childNodes[0];
  assert.equal(offsetOf(marks, node, 99), text.length);
  assert.deepEqual(positionOf(marks, root, 999), { node, offset: 3 });
});

test('a block mark covers its closing marker, so inserts never split it', () => {
  for (const doc of ['lead\n\n```js\nconst a = 1;\n```', 'lead\n\n| a   |\n| --- |\n| 1   |']) {
    const root = surface(doc);
    const { text, marks } = serializeDocument(root);
    assert.equal(text, doc);
    const block = [...root.childNodes].find((node) => node.nodeType === 1 && ['PRE', 'TABLE'].includes(node.tagName));
    const end = marks.get(block).end;
    assert.equal(end, text.length, `${block.tagName} ends before its last marker`);
    assert.equal(offsetOf(marks, block, block.childNodes.length), text.length);
  }
});
