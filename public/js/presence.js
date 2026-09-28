/**
 * Remote caret overlay.
 *
 * Peer positions travel as Markdown offsets, so the layer asks the serializer where those
 * offsets live in the DOM (`positionOf`), builds a Range, and paints the rectangles the
 * browser hands back. A selection that wraps across lines or spans table cells therefore
 * shows one fragment per line without any bookkeeping here, and the overlay never needs to
 * mirror the document text itself.
 */

import { positionOf } from './serialize.mjs';

const FALLBACK = '#888888';
const clamp = (value, max) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, max));

/**
 * The pure half: which peers get a caret, where, in what colour. Offsets are clamped into
 * the document because a peer's view can lag an operation behind.
 */
export function peerCursors(peers, textLength, selfClientId) {
  const out = [];
  for (const peer of peers ?? []) {
    if (!peer.selection || peer.clientId === selfClientId) continue;
    const a = clamp(peer.selection.start, textLength);
    const b = clamp(peer.selection.end ?? peer.selection.start, textLength);
    out.push({
      clientId: peer.clientId,
      name: String(peer.name ?? 'Guest'),
      color: /^#[0-9a-f]{3,8}$/i.test(peer.color ?? '') ? peer.color : FALLBACK,
      start: Math.min(a, b),
      end: Math.max(a, b),
    });
  }
  return out;
}

const visible = (rect) => rect.width > 0 || rect.height > 0;

export class CursorLayer {
  constructor(stage, root, selfClientId) {
    this.stage = stage;
    this.root = root;
    this.self = selfClientId;
    this.layer = document.createElement('div');
    this.layer.className = 'cursor-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.marks = null;
    this.text = '';
    this.peers = [];
    this.frame = 0;
    stage.appendChild(this.layer);
    root.addEventListener('scroll', () => this.schedule(), { passive: true });
  }

  /** @param {{text: string, marks: Map}} snapshot current serialization of the surface */
  render(snapshot, peers) {
    this.text = snapshot.text;
    this.marks = snapshot.marks;
    this.peers = peerCursors(peers, snapshot.text.length, this.self);
    this.schedule();
  }

  resize() {
    this.schedule();
  }

  /** Layout is only knowable after the browser has painted, so one repaint per frame. */
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.#paint();
    });
  }

  #paint() {
    this.layer.replaceChildren();
    if (!this.marks) return;
    const box = this.stage.getBoundingClientRect();
    for (const peer of this.peers) {
      const range = this.#range(peer);
      if (!range) continue;
      const rects = [...range.getClientRects()].filter(visible);
      const anchor = rects[0] ?? this.#lineBox(range, peer);
      if (!anchor) continue; // the node is detached or has no box yet
      if (peer.start === peer.end) this.#spot('peer-caret', peer, anchor, box);
      else for (const rect of rects) this.#spot('peer-sel', peer, rect, box);
      this.#spot('peer-tag', peer, anchor, box, peer.name);
    }
  }

  #range(peer) {
    const from = positionOf(this.marks, this.root, peer.start);
    const to = positionOf(this.marks, this.root, peer.end);
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch {
      return null; // the surface was rebuilt under this snapshot
    }
    return range;
  }

  /** A collapsed range in an empty block reports no rectangle of its own: borrow its line box. */
  #lineBox(range, peer) {
    const box = range.getBoundingClientRect();
    if (visible(box)) return box;
    const { node } = positionOf(this.marks, this.root, peer.start);
    const element = node.nodeType === 3 ? node.parentElement : node;
    const line = element?.getBoundingClientRect?.();
    return line && visible(line) ? line : null;
  }

  #spot(kind, peer, rect, box, label = null) {
    const spot = document.createElement('span');
    spot.className = kind;
    spot.style.setProperty('--c', peer.color);
    spot.style.left = `${rect.left - box.left}px`;
    spot.style.top = `${rect.top - box.top}px`;
    if (kind !== 'peer-tag') {
      spot.style.width = `${rect.width}px`;
      spot.style.height = `${rect.height}px`;
    }
    if (label != null) spot.textContent = label;
    this.layer.appendChild(spot);
  }
}
