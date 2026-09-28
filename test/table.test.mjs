import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROW_JOIN,
  ROW_LEAD,
  ROW_TAIL,
  columnWidths,
  delimiterCell,
  makeTable,
  padWidths,
  serializeTable,
  tableRow,
  toTsv,
} from '../public/js/table.mjs';

test('a fresh table is a header, a delimiter and the asked-for body rows', () => {
  assert.deepEqual(serializeTable(makeTable(3, 2)).split('\n'), [
    '| Column 1 | Column 2 | Column 3 |',
    '| -------- | -------- | -------- |',
    '|          |          |          |',
    '|          |          |          |',
  ]);
});

test('columns pad to their widest cell, three dashes at least', () => {
  const text = serializeTable({
    header: ['name', 'qty', 'note'],
    rows: [
      ['apples', '3', 'crisp'],
      ['pears', '12', 'a | b'],
    ],
    aligns: ['', 'right', 'center'],
  });
  assert.deepEqual(text.split('\n'), [
    '| name   | qty | note   |',
    '| ------ | --: | :----: |',
    '| apples | 3   | crisp  |',
    '| pears  | 12  | a \\| b |',
  ]);
  assert.deepEqual(padWidths([['x'], ['longer value']]), [12]);
  assert.deepEqual(columnWidths(['a'], [['bb']]), [3]);
});

test('alignment markers follow the delimiter rule', () => {
  assert.equal(delimiterCell(8, ''), '--------');
  assert.equal(delimiterCell(8, 'right'), '-------:');
  assert.equal(delimiterCell(8, 'center'), ':------:');
  assert.equal(delimiterCell(8, 'left'), '--------'); // left is the default, so unmarked
  assert.equal(delimiterCell(3, 'center'), ':-:');
});

test('a row writes exactly the separators the DOM serializer uses', () => {
  const widths = columnWidths(['a', 'b'], [['c', 'd']]);
  assert.equal(tableRow(['a', 'b'], widths), `${ROW_LEAD}a  ${ROW_JOIN}b  ${ROW_TAIL}`);
});

test('pipes inside cells are escaped so the grid cannot gain a column', () => {
  assert.equal(tableRow(['a|b', 'c'], [8, 3]), `${ROW_LEAD}a\\|b${' '.repeat(4)}${ROW_JOIN}c  ${ROW_TAIL}`);
});

test('a header-only table still writes its delimiter row', () => {
  assert.deepEqual(serializeTable({ header: ['a'], rows: [], aligns: [] }).split('\n'), [
    '| a   |',
    '| --- |',
  ]);
});

test('copies out as tab-separated values', () => {
  assert.equal(
    toTsv({
      header: ['name', 'qty'],
      rows: [['apples', '3'], ['pears', '12']],
    }),
    'name\tqty\napples\t3\npears\t12',
  );
});
