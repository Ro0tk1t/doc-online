import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorLayer, peerCursors } from '../public/js/presence.js';

const peer = (clientId, selection, color = '#e5a48d', name = 'Ada') => ({ clientId, selection, color, name });

test('only remote peers with a selection get a caret', () => {
  const list = peerCursors([peer('me', { start: 1, end: 2 }), peer('ada', { start: 3, end: 3 }), { clientId: 'bob' }], 20, 'me');
  assert.deepEqual(list, [{ clientId: 'ada', name: 'Ada', color: '#e5a48d', start: 3, end: 3 }]);
});

test('offsets are clamped into the document and ordered', () => {
  const [only] = peerCursors([peer('ada', { start: 40, end: 90 })], 12, 'me');
  assert.deepEqual([only.start, only.end], [12, 12]);
  const [flipped] = peerCursors([peer('ada', { start: 9, end: 2 })], 12, 'me');
  assert.deepEqual([flipped.start, flipped.end], [2, 9]);
  const [junk] = peerCursors([peer('ada', { start: 'x', end: undefined })], 12, 'me');
  assert.deepEqual([junk.start, junk.end], [0, 0]);
});

test('a colour that is not a hex literal falls back, and a name is kept as text', () => {
  const [ada] = peerCursors([peer('ada', { start: 0, end: 0 }, 'javascript:alert(1)', '<b>Ada</b>')], 5, 'me');
  assert.equal(ada.color, '#888888');
  assert.equal(ada.name, '<b>Ada</b>');
});

/* ---------- the overlay, against a minimal DOM ---------- */

function spot(name) {
  const node = {
    name,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    style: { setProperty(key, value) { this[key] = value; } },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    setAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return node;
}

const textNode = (data) => ({ nodeType: 3, nodeName: '#text', data, parentElement: spot('p') });

/** A stage at (10, 20) holding one line of text, whose ranges report one fixed rectangle. */
function withLayer(rects) {
  const stage = spot('stage');
  stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 600, height: 400 });
  const root = spot('doc');
  globalThis.document = {
    createElement: (tag) => spot(tag),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getClientRects: () => rects,
      getBoundingClientRect: () => (rects[0] ?? { left: 0, top: 0, width: 0, height: 0 }),
    }),
  };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 0;
  };
  const layer = new CursorLayer(stage, root, 'me');
  const node = textNode('hello world');
  return { layer, spots: () => layer.layer.children, marks: new Map([[node, { node, start: 0, end: 11 }]]) };
}

const painted = (node) => ({
  className: node.className,
  left: node.style.left,
  top: node.style.top,
  width: node.style.width,
  height: node.style.height,
  color: node.style['--c'],
  text: node.textContent,
});

test('a collapsed remote selection paints one caret and one name tag', () => {
  const { layer, spots, marks } = withLayer([{ left: 110, top: 40, width: 0, height: 18 }]);
  layer.render({ text: 'hello world', marks }, [peer('ada', { start: 5, end: 5 })]);
  assert.deepEqual(
    spots().map(painted),
    [
      { className: 'peer-caret', left: '100px', top: '20px', width: '0px', height: '18px', color: '#e5a48d', text: '' },
      { className: 'peer-tag', left: '100px', top: '20px', width: undefined, height: undefined, color: '#e5a48d', text: 'Ada' },
    ],
  );
});

test('a remote range paints one fragment per rectangle, plus a single tag', () => {
  const { layer, spots, marks } = withLayer([
    { left: 100, top: 40, width: 200, height: 18 },
    { left: 10, top: 58, width: 80, height: 18 },
  ]);
  layer.render({ text: 'hello world', marks }, [peer('ada', { start: 2, end: 9 })]);
  const kinds = spots().map((node) => node.className);
  assert.deepEqual(kinds, ['peer-sel', 'peer-sel', 'peer-tag']);
  assert.equal(spots()[1].style.left, '0px');
  assert.equal(spots()[1].style.width, '80px');
});

test('zero-sized rectangles are skipped, and my own caret is never echoed', () => {
  const { layer, spots, marks } = withLayer([{ left: 0, top: 0, width: 0, height: 0 }]);
  layer.render({ text: 'abc', marks }, [peer('me', { start: 1, end: 2 }), peer('ada', { start: 1, end: 2 })]);
  // the only peer left standing has no visible rectangle, so nothing is painted at all
  assert.deepEqual(spots(), []);
  layer.render({ text: 'abc', marks }, [peer('me', { start: 1, end: 2 })]);
  assert.deepEqual(spots(), []);
});

test('nothing is painted before the surface has been serialized', () => {
  const { layer, spots } = withLayer([{ left: 100, top: 40, width: 20, height: 18 }]);
  layer.render({ text: 'abc', marks: null }, [peer('ada', { start: 1, end: 2 })]);
  assert.deepEqual(spots(), []);
});
