import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fenceSpans,
  gapAfter,
  gapBefore,
  linesSpan,
  planFenceExit,
  planInsert,
  planReplace,
  setFenceLanguage,
} from '../public/js/blocks.mjs';
import { renderMarkdown } from '../public/js/markdown.mjs';
import { toMarkdown } from '../public/js/serialize.mjs';
import { parse } from './dom-stub.mjs';

const at = (text, needle) => text.indexOf(needle);
/** What the browser holds after innerHTML = renderMarkdown(text): the round trip under test. */
const through = (markdown) => toMarkdown(parse(renderMarkdown(markdown)));

test('a block waits for the line to end instead of cutting it in half', () => {
  const text = '# Hello\n\nA *paragraph* here.\n';
  const plan = planInsert(text, at(text, '*paragraph*'), '```js\n\n```\n');
  assert.equal(plan.text, '# Hello\n\nA *paragraph* here.\n\n```js\n\n```');
});

test('what follows a block never becomes its continuation', () => {
  for (const caret of [5, 7]) assert.equal(planInsert('Alpha\n\nBeta', caret, '---\n').text, 'Alpha\n\n---\n\nBeta');
});

test('an existing seam is reused, not doubled', () => {
  assert.equal(planInsert('a\n\nb', 1, '---\n').text, 'a\n\n---\n\nb');
  assert.equal(planInsert('a\n\n\nb', 4, '---\n').text, 'a\n\n\n---\n\nb');
});

test('nothing is appended after a block that ends the document', () => {
  assert.equal(planInsert('a\n\n', 2, '---\n').text, 'a\n\n---\n');
  assert.equal(planInsert('', 0, '---\n').text, '---');
});

test('consecutive inserts stack cleanly', () => {
  const first = planInsert('Alpha\n\nBeta', 1, '---\n');
  const second = planInsert(first.text, first.end, '---\n');
  assert.equal(second.text, 'Alpha\n\n---\n\n---\n\nBeta');
});

test('the content offset points at the block itself', () => {
  const grid = '| a   |\n| --- |\n| 1   |\n';
  const plan = planInsert('Alpha', 5, grid);
  assert.equal(plan.text.slice(plan.content, plan.content + '| a   |'.length), '| a   |');
  assert.equal(plan.text.slice(plan.start, plan.content), '\n\n');
  assert.equal(plan.end, plan.content + grid.trimEnd().length);
});

test('gap helpers only ever produce a blank line', () => {
  assert.deepEqual(['', 'a', 'a\n', 'a\n\n'].map(gapBefore), ['', '\n\n', '\n', '']);
  assert.deepEqual(['', '   ', 'b', '\nb', '\n\nb'].map(gapAfter), ['', '', '\n\n', '\n', '']);
});

test('a block command owns every line the selection touches', () => {
  assert.deepEqual(linesSpan('one two\n\nthree\n', 2, 9), { start: 0, end: 14 });
  assert.deepEqual(linesSpan('aaa\nbbb\n', 0, 3), { start: 0, end: 3 }); // ends on a line break: no next line
  assert.deepEqual(linesSpan('aaa\nbbb\n', 4, 7), { start: 4, end: 7 });
  assert.deepEqual(linesSpan('aaa\nbbb', 4, 5), { start: 4, end: 7 });
});

test('replacing a span keeps the seams on both sides', () => {
  const text = 'line one\n\nline two\n';
  const plan = planReplace(text, 0, 18, '```js\nline one\n\nline two\n```');
  assert.equal(plan.text, '```js\nline one\n\nline two\n```\n');
  assert.equal(plan.content, 0);

  const middle = planReplace('top\n\nmid one\nmid two\n\nend\n', 5, 20, '```js\nmid one\nmid two\n```');
  assert.equal(middle.text, 'top\n\n```js\nmid one\nmid two\n```\n\nend\n');
  assert.equal(middle.content, 5);

  // A block always takes a blank line, even where the replaced line only had a single break.
  assert.equal(planReplace('a\nb\nc', 2, 3, 'X').text, 'a\n\nX\n\nc');
});

test('fences are found in the order the renderer paints them', () => {
  const text = '# Title\n\n```js\nconst a = 1;\n```\n\nText\n\n~~~python\ndef f():\n    return 1\n~~~\n';
  const spans = fenceSpans(text);
  assert.deepEqual(spans.map((s) => s.info), ['js', 'python']);
  assert.equal(text.slice(spans[0].start, spans[0].start + 3), '```');
  assert.equal(text.slice(spans[1].start, spans[1].start + 3), '~~~');
  assert.equal(spans[1].end, text.indexOf('~~~', text.indexOf('def f')) + 3);
  assert.deepEqual(fenceSpans('no fences here\n\n`just inline`'), []);
});

test('inside a fence everything is body, including a marker of the other kind', () => {
  const text = '```js\n# heading\n~~~\nconst t = `a}`;\n```\n\ncode: `not a fence`\n';
  assert.deepEqual(fenceSpans(text).map((s) => s.info), ['js']);
});

test('an unclosed fence owns the rest of the document', () => {
  const text = 'a\n\n```json\n{"x": 1}\n';
  const spans = fenceSpans(text);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].end, text.length);
});

test('choosing a language rewrites the info string and nothing else', () => {
  const text = '```js\nconst a = 1;\n```\n';
  assert.equal(setFenceLanguage(text, 0, 'python'), '```python\nconst a = 1;\n```\n');
  assert.equal(setFenceLanguage(text, 0, ''), '```\nconst a = 1;\n```\n');
  assert.equal(setFenceLanguage('~~~bash\ncat a\n~~~', 0, 'js'), '~~~js\ncat a\n~~~');
  assert.equal(setFenceLanguage('````js\nx\n````', 0, 'sh'), '````sh\nx\n````');
});

test('a language write lands only on a fence head', () => {
  assert.equal(setFenceLanguage('plain text', 0, 'js'), 'plain text');
  assert.equal(setFenceLanguage('```js\nx\n```', 4, 'js'), '```js\nx\n```'); // mid-head is not a head
  assert.equal(setFenceLanguage('```js\nx\n```', 0, 'ja;va'), '```java\nx\n```'); // only what renders
});

test('one pre per fence, so a control can be zipped onto each block', () => {
  const docs = [
    '```js\na\n```',
    '```js\na\n```\n\n```\nb\n```',
    'a\n\n~~~\n#\n~~~',
    '```python\nx\n',
    '```js\nclose inside: ```not\n```',
    '```c++\nint x;\n```',
    'text\n\n```sh\n```\n\ntail',
  ];
  for (const text of docs) {
    assert.equal((renderMarkdown(text).match(/<pre>/g) ?? []).length, fenceSpans(text).length, text);
  }
});

test('the first Enter in a fresh block writes code, the second one leaves', () => {
  const fresh = '```js\n\n```';
  assert.equal(planFenceExit(fresh, 6), null); // one empty line is not an exit
  assert.deepEqual(planFenceExit('```js\n\n\n```', 7), { text: '', end: 0 }); // the block never held code
});

test('leaving a block that has code keeps the code and drops the blank line', () => {
  assert.deepEqual(planFenceExit('x\n\n```js\none\n\n```', 13), { text: 'x\n\n```js\none\n```', end: 16 });
  assert.deepEqual(planFenceExit('```python\ndef f():\n    pass\n\n\n```', 29), {
    text: '```python\ndef f():\n    pass\n```',
    end: 31,
  });
});

test('a break under a caret that still has code below it belongs to the block', () => {
  assert.equal(planFenceExit('```js\n\nx\n```', 6), null);
  for (const caret of [10, 11]) assert.equal(planFenceExit('```js\none\n\n\ntwo\n```', caret), null);
});

test('an exit never reaches across the fence it is in', () => {
  assert.deepEqual(planFenceExit('```js\na\n\n```\n\n```py\nb\n```', 8), { text: '```js\na\n```\n\n```py\nb\n```', end: 13 });
});

test('an abandoned block between two paragraphs closes the gap it leaves', () => {
  assert.deepEqual(planFenceExit('x\n\n```js\n\n\n```\n\nbody', 10), { text: 'x\n\nbody', end: 3 });
});

test('only a caret inside a fence can exit one', () => {
  assert.equal(planFenceExit('a\n\nb', 2), null);
  assert.equal(planFenceExit('```js\none\n```', 0), null); // on the opening marker
  assert.equal(planFenceExit('```js\none\n\n', 11), null); // no closer to leave through
});

test('every exit leaves a document the surface reads back unchanged', () => {
  const leaves = [
    ['```js\n\n\n```', 7],
    ['x\n\n```js\none\n\n```', 13],
    ['x\n\n```js\n\n\n```\n\nbody', 10],
    ['```js\na\n\n```\n\n```py\nb\n```', 8],
    ['```python\ndef f():\n    pass\n\n\n```', 29],
  ];
  for (const [text, caret] of leaves) {
    const plan = planFenceExit(text, caret);
    assert.ok(plan, `no exit planned for ${JSON.stringify(text)}`);
    assert.equal(through(plan.text), plan.text, JSON.stringify(text));
  }
});
