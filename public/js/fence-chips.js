/**
 * One language selector per code block.
 *
 * A fence's info string is the whole of what its language is, so these chips only ever read that
 * and write it back. They live in a layer over the plate, never inside the contenteditable, so the
 * serializer cannot see one and no structure enters the document that Markdown could not carry.
 *
 * A selector is a control, not a label: a block of code reads better without one, so it floats up
 * only while the pointer is at the top of its own block -- and stays while the pointer is on it, so
 * reaching for the language never makes it disappear under the cursor. It rides the block's first
 * line, where a label would go, and nothing about that line is a constant here: it is found by
 * reading the padding the block keeps and the leading its own text carries.
 */

import { fenceSpans } from './blocks.mjs';
import { CHOICES } from './highlight.mjs';

/**
 * How tall one line of code is, for the two places the chip needs a line and no stylesheet can be
 * read (a Node test, say). Real blocks are measured, so this is only the fallback.
 */
const LEAD = 18;

const LABELS = {
  js: 'JavaScript',
  ts: 'TypeScript',
  json: 'JSON',
  python: 'Python',
  bash: 'Bash',
  css: 'CSS',
  html: 'HTML',
};

export class FenceChips {
  constructor(stage, root, { onPick, editable = () => true } = {}) {
    this.stage = stage;
    this.root = root;
    this.onPick = onPick;
    this.editable = editable;
    this.text = '';
    this.frame = 0;
    this.pairs = new Map(); // the block a chip hangs over, which is what a pointer lands on
    this.shown = null; // at most one chip is up at a time
    this.at = null; // where the pointer last reported itself: a fence, and how far down it
    this.layer = document.createElement('div');
    this.layer.className = 'fence-layer';
    stage.appendChild(this.layer);
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
    stage.addEventListener('pointermove', (event) => this.#track(event), { passive: true });
    stage.addEventListener('pointerleave', () => {
      this.at = null;
      this.#reveal();
    });
    this.layer.addEventListener('change', (event) => {
      const at = Number(event.target?.dataset?.at);
      if (Number.isInteger(at)) this.onPick(at, event.target.value);
    });
  }

  /** @param {string} text the model the surface was last painted from */
  render(text) {
    this.text = text;
    this.schedule();
  }

  resize() {
    this.schedule();
  }

  /** Geometry is only knowable after layout, so one pass per frame. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.#paint();
    });
  }

  #paint() {
    this.layer.replaceChildren();
    this.pairs.clear();
    this.shown = null; // the chip it was pointing at is no longer in the document
    const blocks = [...this.root.querySelectorAll('pre')];
    const spans = fenceSpans(this.text);
    // A repaint can leave the two lists briefly uneven; zip the ones that are certainly paired.
    const count = Math.min(blocks.length, spans.length);
    const box = this.stage.getBoundingClientRect();
    for (let i = 0; i < count; i += 1) {
      const rect = blocks[i].getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue; // no box yet: nothing to hang a chip on
      const { mid, depth } = this.#line(blocks[i]);
      const chip = this.#chip(spans[i], rect, box, mid);
      this.pairs.set(blocks[i], { block: blocks[i], at: spans[i].start, chip, band: depth });
      this.layer.appendChild(chip);
    }
    // A pick repaints the plate, and the pointer has not moved: the chip it was reaching for is a
    // brand new element now, so the frame that built it has to decide about it again.
    this.#reveal();
  }

  /** Where the pointer says it is, remembered against the fence rather than the node. */
  #track(event) {
    const raw = event.target;
    const node = raw?.nodeType === 3 ? raw.parentElement : raw;
    const fence = Number(node?.dataset?.at);
    if (node?.classList?.contains?.('fence-lang') && Number.isInteger(fence)) {
      // On the selector itself: it is already under the cursor, so no coordinate puts it away.
      this.at = { fence, y: null };
    } else {
      const pair = this.pairs.get(node?.closest?.('pre'));
      this.at = pair ? { fence: pair.at, y: event.clientY } : null;
    }
    this.#reveal();
  }

  /** Which chip the remembered pointer is asking for, found through the fence it belongs to. */
  #reveal() {
    const pair = this.at && this.#pairFor(this.at.fence);
    if (!pair) return this.#show(null);
    if (this.at.y === null) return this.#show(pair.chip);
    // The rectangle is read live: a repaint waits a frame, and a pointer should not be judged by
    // where the block was when that frame was laid out.
    this.#show(this.at.y <= pair.block.getBoundingClientRect().top + pair.band ? pair.chip : null);
  }

  #pairFor(fence) {
    for (const pair of this.pairs.values()) if (pair.at === fence) return pair;
    return null;
  }

  /**
   * Where the block's first line is, in the block's own terms: the depth its text sits at, and how
   * far down the pointer still counts as being at the top of the block. Both come from the
   * stylesheet -- the space above the text and one line of the text -- so moving either there moves
   * the chip here, and the chip cannot drift off the line it belongs to.
   */
  #line(block) {
    const pad = parseFloat(globalThis.getComputedStyle?.(block)?.paddingTop) || 0;
    const css = globalThis.getComputedStyle?.(block.querySelector?.('code') ?? block) ?? {};
    const lead = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.4 || LEAD;
    return { mid: pad + lead / 2, depth: pad + lead };
  }

  /** The class is the whole contract: `style.css` turns it into a chip the cursor can reach. */
  #show(chip) {
    if (this.shown === chip) return;
    this.shown?.classList?.remove?.('hot');
    this.shown = chip ?? null;
    chip?.classList?.add?.('hot');
  }

  #chip(span, rect, box, mid) {
    const select = document.createElement('select');
    select.className = 'fence-lang';
    select.dataset.at = String(span.start);
    select.title = 'Code block language';
    select.setAttribute('aria-label', 'Code block language');
    select.disabled = !this.editable();
    const options = [{ value: '', label: 'plain' }, ...CHOICES.map((value) => ({ value, label: LABELS[value] ?? value }))];
    // A fence that names something else keeps its own name: the chip must never claim it is plain.
    if (span.info && !options.some((option) => option.value === span.info)) options.push({ value: span.info, label: span.info });
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    select.value = span.info;
    // The line's middle, with `style.css` lifting the chip half its own height onto it.
    select.style.top = `${Math.max(rect.top - box.top + mid, 2)}px`;
    select.style.right = `${Math.max(box.left + box.width - (rect.left + rect.width) + 8, 8)}px`;
    return select;
  }
}
