import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  baseLength,
  compose,
  makeEdit,
  normalize,
  resultLength,
  transform,
  transformPair,
  transformPosition,
  validate,
} from './ot.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = 'ab cde\n*#-';

function randomText(rand, maxLen = 40) {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

/** A random well-formed operation that consumes the whole document. */
function randomOp(rand, textLen) {
  const parts = [];
  let left = textLen;
  while (left > 0) {
    const roll = rand();
    if (roll < 0.45) {
      const n = 1 + Math.floor(rand() * Math.min(left, 6));
      parts.push({ retain: n });
      left -= n;
    } else if (roll < 0.75) {
      const n = 1 + Math.floor(rand() * Math.min(left, 5));
      parts.push({ delete: n });
      left -= n;
    } else {
      const word = randomText(rand, 5);
      if (word) parts.push({ insert: word });
    }
  }
  if (rand() < 0.2) {
    const word = randomText(rand, 5);
    if (word) parts.push({ insert: word });
  }
  return validate(parts);
}

function randomEdit(rand, text) {
  const after =
    rand() < 0.5
      ? text.slice(0, Math.floor(rand() * text.length)) + randomText(rand, 6) + text.slice(Math.floor(rand() * text.length))
      : text.replace(/[a-z]/, () => randomText(rand, 3));
  return makeEdit(text, after);
}

test('apply rejects operations that do not cover the document', () => {
  assert.throws(() => apply('abc', [{ retain: 1 }]), /whole document/);
  assert.throws(() => apply('abc', [{ retain: 2 }, { delete: 2 }]), /past the end/);
  assert.throws(() => validate([{ retain: -1 }]), /non-negative/);
  assert.throws(() => validate([{ retain: 1.5 }]), /non-negative/);
  assert.throws(() => validate([{ retain: 1, insert: 'x' }]), /exactly one/);
});

test('makeEdit round-trips every single-region change', () => {
  const cases = [
    ['', 'hello'],
    ['hello', ''],
    ['hello', 'hello'],
    ['hello', 'hallo'],
    ['a b c', 'a b c d'],
    ['# Title\nbody', '# Title\n\nbody edited'],
    ['xxabcxx', 'xxABCxx'],
  ];
  for (const [before, after] of cases) {
    const op = makeEdit(before, after);
    assert.equal(apply(before, op), after, `${before} -> ${after}`);
    assert.equal(baseLength(op), before.length);
    assert.equal(resultLength(op), after.length);
  }
});

test('makeEdit produces a minimal diff', () => {
  const op = makeEdit('aaaXbbb', 'aaaYbbb');
  assert.deepEqual(op, [{ retain: 3 }, { delete: 1 }, { insert: 'Y' }, { retain: 3 }]);
});

test('compose matches sequential apply (fuzz)', () => {
  const rand = rng(1);
  for (let i = 0; i < 4000; i += 1) {
    const text = randomText(rand);
    const a = rand() < 0.5 ? randomOp(rand, text.length) : randomEdit(rand, text);
    const mid = apply(text, a);
    const b = rand() < 0.5 ? randomOp(rand, mid.length) : randomEdit(rand, mid);
    const viaSteps = apply(mid, b);
    const viaCompose = apply(text, compose(a, b));
    assert.equal(viaCompose, viaSteps, `compose mismatch on ${JSON.stringify({ text, a, b })}`);
  }
});

test('transform keeps concurrent peers converged (fuzz)', () => {
  const rand = rng(7);
  for (let i = 0; i < 4000; i += 1) {
    const text = randomText(rand);
    const a = randomOp(rand, text.length);
    const b = randomOp(rand, text.length);
    const [aPrime, bPrime] = transformPair(a, b);
    const left = apply(apply(text, a), bPrime);
    const right = apply(apply(text, b), aPrime);
    assert.equal(left, right, `divergence on ${JSON.stringify({ text, a, b })}`);
    assert.equal(baseLength(aPrime), resultLength(b));
    assert.equal(baseLength(bPrime), resultLength(a));
  }
});

test('an identity op rebases onto a real edit without changing text', () => {
  const text = 'hello world';
  const identity = [{ retain: text.length }];
  const op = makeEdit(text, 'hello brave world');
  assert.equal(apply(apply(text, op), transform(identity, op, true)), 'hello brave world');
  assert.equal(apply(text, transform(op, identity, true)), 'hello brave world');
});

test('transformPosition follows concurrent edits', () => {
  const text = 'hello';
  const at = (n) => [{ retain: n }];
  // insert before the caret pushes it right
  assert.equal(transformPosition([...at(2), { insert: 'XY' }, ...at(3)], 4), 6);
  // delete before the caret pulls it left
  assert.equal(transformPosition([...at(1), { delete: 2 }, ...at(2)], 4), 2);
  // deleting across the caret clamps to the deletion start
  assert.equal(transformPosition([...at(2), { delete: 2 }, ...at(1)], 3), 2);
  // edits after the caret leave it alone
  assert.equal(transformPosition([...at(3), { insert: '!!' }, ...at(2)], 2), 2);
  assert.equal(transformPosition([...at(3), { delete: 2 }, ...at(0)], 2), 2);
  // insert exactly at the caret: shifts by default, optional bias keeps it put
  assert.equal(transformPosition([...at(2), { insert: 'Z' }, ...at(3)], 2), 3);
  assert.equal(transformPosition([...at(2), { insert: 'Z' }, ...at(3)], 2, true), 2);
});

test('operations survive a JSON round-trip', () => {
  const op = makeEdit('# a\nbody', '# ab\nbody more');
  assert.deepEqual(validate(JSON.parse(JSON.stringify(op))), op);
});
