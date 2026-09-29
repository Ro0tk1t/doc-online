import test from 'node:test';
import assert from 'node:assert/strict';
import { FenceChips } from '../public/js/fence-chips.js';

/**
 * The chips are positioned from layout, which Node does not have, so the stub hands back the
 * rectangles a browser would: one per `<pre>`, in document order, plus the stage box they are
 * measured against. Everything else the class touches is here.
 */
function node(name) {
  const self = {
    name,
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    title: '',
    dataset: {},
    style: {},
    children: [],
    handlers: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    setAttribute(key, value) {
      this[key] = value;
    },
    addEventListener(type, handler) {
      this.handlers[type] = handler;
    },
    // A node answers for its own name, which is all the pointer tests need: the target they pass is
    // the block itself, the way `closest('pre')` resolves for text inside one.
    closest(asked) {
      return this.name === asked ? this : null;
    },
    classList: {
      add(name) {
        if (!this.contains(name)) self.className = `${self.className} ${name}`.trim();
      },
      remove(name) {
        self.className = self.className
          .split(/\s+/)
          .filter((one) => one && one !== name)
          .join(' ');
      },
      contains(name) {
        return self.className.split(/\s+/).includes(name);
      },
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    querySelector(asked) {
      return this.children.find((kid) => kid.name === asked) ?? null;
    },
  };
  return self;
}

function withChips({ boxes, text, editable = () => true, onPick = () => {} }) {
  const stage = node('stage');
  stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 600, height: 400 });
  const pres = boxes.map((box) => {
    const pre = node('pre'); // named for what `closest('pre')` is asked for
    pre.getBoundingClientRect = () => box;
    return pre;
  });
  const root = node('doc');
  root.querySelectorAll = (selector) => (selector === 'pre' ? pres : []);
  globalThis.document = { createElement: (tag) => node(tag) };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 0;
  };
  const chips = new FenceChips(stage, root, { onPick, editable });
  chips.render(text);
  return { chips, stage, pres, picks: [], layer: chips.layer };
}

const PLATE = { left: 20, top: 40, width: 500, height: 120 };
const FLAT = { left: 0, top: 0, width: 0, height: 0 };

test('one chip per fence, reading the language the info string carries', () => {
  const text = '```js\nlet a = 1;\n```\n\nplain text\n\n```\nno language\n```\n\n~~~python\ndef f():\n    pass\n~~~\n';
  const { chips } = withChips({ text, boxes: [PLATE, PLATE, PLATE] });
  assert.deepEqual(chips.layer.children.map((chip) => chip.value), ['js', '', 'python']);
  assert.deepEqual(chips.layer.children.map((chip) => chip.className), ['fence-lang', 'fence-lang', 'fence-lang'], 'a chip waits for the pointer');
  // the offsets the chip will write back to are the fence heads themselves
  assert.deepEqual(chips.layer.children.map((chip) => Number(chip.dataset.at)), [0, text.indexOf('```', 20), text.indexOf('~~~')]);
});

test('a language the list does not know keeps its own name', () => {
  const { chips } = withChips({ text: '```c++\nint x;\n```\n', boxes: [PLATE] });
  const [chip] = chips.layer.children;
  assert.equal(chip.value, 'c++');
  const offered = chip.children.map((option) => option.value);
  assert.ok(offered.includes('c++'), 'the fence would have been shown as plain');
});

test('a chip sits on the first line of its block, at the top-right of the plate', () => {
  const { chips } = withChips({ text: '```js\nx\n```\n', boxes: [PLATE] });
  const [chip] = chips.layer.children;
  // stage spans x 10..610, the plate x 20..520 and starts at y 40; with no stylesheet to read,
  // the line is the fallback leading, and `style.css` lifts the chip half its own height onto it
  assert.equal(chip.style.top, '29px'); // 40 - 20 + 18/2
  assert.equal(chip.style.right, '98px'); // (610 - 520) + 8
});

test('a block with no box yet gets no chip', () => {
  const { chips } = withChips({ text: '```js\nx\n```\n\n```js\ny\n```\n', boxes: [FLAT, PLATE] });
  assert.equal(chips.layer.children.length, 1);
});

test('choosing a language reports the fence it belongs to', () => {
  const picks = [];
  const text = 'intro\n\n```js\nx\n```\n';
  const { chips } = withChips({ text, boxes: [PLATE], onPick: (at, info) => picks.push([at, info]) });
  const [chip] = chips.layer.children;
  chip.value = 'bash';
  chips.layer.handlers.change({ target: chip });
  assert.deepEqual(picks, [[text.indexOf('```js'), 'bash']]);
});

test('a visitor who cannot edit sees the language but cannot change it', () => {
  const { chips } = withChips({ text: '```python\nx\n```\n', boxes: [PLATE], editable: () => false });
  assert.equal(chips.layer.children[0].disabled, true);
});

test('repainting clears chips for fences that are gone', () => {
  const { chips } = withChips({ text: '```js\nx\n```\n\n```js\ny\n```\n', boxes: [PLATE, PLATE] });
  assert.equal(chips.layer.children.length, 2);
  chips.render('just text now');
  assert.equal(chips.layer.children.length, 0);
});

const hot = (chip) => chip.className.split(/\s+/).includes('hot');

/** Text inside a block reaches its block the way `closest` does in a browser. */
const textIn = (pre) => ({ nodeType: 3, parentElement: { closest: (asked) => (asked === 'pre' ? pre : null) } });

test('a chip lifts only while the pointer is in the band at the top of its block', () => {
  const { chips, stage, pres } = withChips({ text: '```js\nx\n```\n', boxes: [PLATE] });
  const [chip] = chips.layer.children;
  const move = (target, clientY) => stage.handlers.pointermove({ target, clientY });
  move(textIn(pres[0]), PLATE.top + 12); // typed text is inside the block too
  assert.equal(hot(chip), true);
  move(pres[0], PLATE.top + 28); // one past the band: the code is what the pointer is looking at
  assert.equal(hot(chip), false);
  move(pres[0], PLATE.top + 10);
  assert.equal(hot(chip), true, 'the chip comes back when the pointer does');
});

test('the pointer that reached for a chip keeps it, and only over its own block', () => {
  const text = '```js\none\n```\n\n```python\ntwo\n```\n';
  const lower = { ...PLATE, top: 200 };
  const { chips, stage, pres } = withChips({ text, boxes: [PLATE, lower] });
  const [first, second] = chips.layer.children;
  const move = (target, clientY) => stage.handlers.pointermove({ target, clientY });
  move(pres[1], lower.top + 6);
  assert.deepEqual([hot(first), hot(second)], [false, true], 'a block owns its own chip');
  move(first, 0); // the pointer is on the chip itself: it stays wherever the coordinate says
  assert.deepEqual([hot(first), hot(second)], [true, false]);
  stage.handlers.pointerleave();
  assert.equal(hot(first), false, 'leaving the plate puts it away');
});

test('a chip outside a block, or on a block with no selector, is put away', () => {
  const { chips, stage, pres } = withChips({ text: '```js\nx\n```\n', boxes: [PLATE] });
  const [chip] = chips.layer.children;
  stage.handlers.pointermove({ target: pres[0], clientY: PLATE.top + 12 });
  assert.equal(hot(chip), true);
  stage.handlers.pointermove({ target: node('p'), clientY: PLATE.top + 12 }); // prose
  assert.equal(hot(chip), false);
});

test('a repaint keeps the chip the pointer is reaching for, and loses one whose block is gone', () => {
  const text = '```js\nx\n```\n\n```python\ny\n```\n';
  const { chips, stage, pres } = withChips({ text, boxes: [PLATE, PLATE] });
  stage.handlers.pointermove({ target: pres[1], clientY: PLATE.top + 12 });
  assert.equal(hot(chips.layer.children[1]), true);
  chips.render(text); // a pick paints the plate again, with brand new chips
  assert.deepEqual(chips.layer.children.map(hot), [false, true], 'the pointer never left that block');
  chips.render('```js\nx\n```\n'); // and the block it was on may not survive the edit
  assert.equal(chips.layer.children.length, 1);
  assert.equal(hot(chips.layer.children[0]), false, 'a chip of another fence is not the one remembered');
});

test('a repaint without the pointer on the plate starts every chip hidden', () => {
  const { chips, stage, pres } = withChips({ text: '```js\nx\n```\n\n```js\ny\n```\n', boxes: [PLATE, PLATE] });
  stage.handlers.pointermove({ target: pres[0], clientY: PLATE.top + 12 });
  stage.handlers.pointerleave();
  chips.render('```js\nx\n```\n\n```js\nz\n```\n');
  assert.deepEqual(chips.layer.children.map((chip) => chip.className), ['fence-lang', 'fence-lang']);
});

test('the chip lands on the middle of the code\'s first line, and the pointer reaches it that deep', () => {
  globalThis.getComputedStyle = (el) => ({ paddingTop: el.paddingTop, lineHeight: el.lineHeight, fontSize: el.fontSize });
  const { chips, stage, pres } = withChips({ text: '```js\nx\n```\n', boxes: [PLATE] });
  const code = node('code');
  pres[0].appendChild(code);
  pres[0].paddingTop = '27px';
  pres[0].lineHeight = '26px'; // the block's own leading, which its text does not use
  code.lineHeight = '20px';
  chips.render('```js\nx\n```\n'); // repaint, so both numbers are read from the styles
  const [chip] = chips.layer.children;
  assert.equal(chip.style.top, '57px'); // 40 - 20 + 27 + 20/2
  stage.handlers.pointermove({ target: textIn(pres[0]), clientY: PLATE.top + 46 }); // still that line
  assert.equal(hot(chip), true);
  stage.handlers.pointermove({ target: textIn(pres[0]), clientY: PLATE.top + 48 }); // the next line is code, not the top
  assert.equal(hot(chip), false, 'the block decides where its own top stops');
  delete globalThis.getComputedStyle;
});
