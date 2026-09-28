import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRow, headings, label, outline } from '../public/js/outline.mjs';

const shape = (text) => headings(text).map((row) => `${'  '.repeat(0)}h${row.level} ${row.text}@${row.start}`);

test('headings come back with levels, labels and offsets', () => {
  const doc = '# Top\n\nbody\n\n## Second\n\n### Third\n';
  assert.deepEqual(shape(doc), ['h1 Top@0', 'h2 Second@13', 'h3 Third@24']);
  // the offset is the start of the line, which is what a jump needs
  for (const row of headings(doc)) {
    assert.equal(doc.slice(row.start, doc.indexOf('\n', row.start)), '#'.repeat(row.level) + ' ' + row.text);
  }
});

test('markup is stripped from a label but its words stay', () => {
  assert.equal(label('Ship **today** in *bold*'), 'Ship today in bold');
  assert.equal(label('See [the spec](https://example.com) and `flags`'), 'See the spec and flags');
  assert.equal(label('![diagram](/files/a/b) alt-free'), 'diagram alt-free');
});

test('only real ATX headings count, and their closing hashes are dropped', () => {
  assert.deepEqual(shape('#yes\n\n#\n\n####### seven\n\nTitle\n====='), []);
  assert.deepEqual(shape('   # indented three\n\n    # indented four'), ['h1 indented three@0']);
  assert.deepEqual(shape('# Trailing hashes ##'), ['h1 Trailing hashes@0']);
});

test('a # inside a fenced block is code, not a heading', () => {
  const doc = '# Real\n\n```sh\n# a comment\n```\n\n## Also real';
  assert.deepEqual(shape(doc), ['h1 Real@0', 'h2 Also real@31']);
  assert.deepEqual(shape('# A\n\n~~~\n## inside\n~~~\n# B'), ['h1 A@0', 'h1 B@23']);
});

test('rows know their depth, their children and who hides them', () => {
  const doc = '# One\n\n## One A\n\n### Deep\n\n## One B\n\n# Two';
  const rows = outline(doc);
  assert.deepEqual(rows.map((row) => [row.text, row.depth, row.foldable, row.hidden]), [
    ['One', 0, true, false],
    ['One A', 1, true, false],
    ['Deep', 2, false, false],
    ['One B', 1, false, false],
    ['Two', 0, false, false],
  ]);
});

test('folding a heading hides its subtree and nothing else', () => {
  const doc = '# One\n\n## One A\n\n### Deep\n\n## One B\n\n# Two';
  const rows = outline(doc, ['1 One']);
  assert.deepEqual(rows.filter((row) => !row.hidden).map((row) => row.text), ['One', 'Two']);
  assert.equal(rows[0].closed, true);
  // a mid-level fold hides only what is below it
  const mid = outline(doc, ['2 One A']);
  assert.deepEqual(mid.map((row) => row.hidden), [false, false, true, false, false]);
});

test('a document that starts at level three still indents from zero', () => {
  assert.deepEqual(outline('### A\n\n#### B\n\n### C').map((row) => row.depth), [0, 1, 0]);
});

test('the active row is the closest visible heading at or above the caret', () => {
  const doc = '# One\n\n## Two\n\nbody';
  const rows = outline(doc);
  assert.equal(activeRow(rows, 0), '1 One');
  assert.equal(activeRow(rows, 8), '2 Two');
  assert.equal(activeRow(rows, 20), '2 Two');
  assert.equal(activeRow(rows, 999), '2 Two');
  assert.equal(activeRow(rows, 1), '1 One');
  // a folded subtree never becomes active
  assert.equal(activeRow(outline(doc, ['1 One']), 8), '1 One');
});

test('an empty or headingless document has no rows', () => {
  assert.deepEqual(outline(''), []);
  assert.deepEqual(outline('just prose\n\n- and a list'), []);
});
