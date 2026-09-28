import test from 'node:test';
import assert from 'node:assert/strict';
import { gapAfter, gapBefore, planInsert } from '../public/js/blocks.mjs';

const at = (text, needle) => text.indexOf(needle);

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
