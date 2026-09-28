/**
 * Operational transformation over a plain-text (Markdown source) document.
 *
 * An operation is a list of components, each one of:
 *   { retain: n }   keep n characters of the document
 *   { insert: "s" } emit a string, consuming nothing
 *   { delete: n }   drop n characters, emitting nothing
 *
 * Components carry no position; position is implied by the running count of
 * retain/delete units, which keeps transform local and allocation-light.
 * Well-formed operations consume the whole base document.
 */

export class OtError extends Error {}

const kindOf = (c) => (c.insert !== undefined ? 'insert' : c.retain !== undefined ? 'retain' : 'delete');
const sizeOf = (c) => (c.insert !== undefined ? c.insert.length : c.retain !== undefined ? c.retain : c.delete);
const headOf = (c, n) =>
  c.insert !== undefined ? { insert: c.insert.slice(0, n) } : { [kindOf(c)]: n };
const tailOf = (c, n) =>
  c.insert !== undefined ? { insert: c.insert.slice(n) } : { [kindOf(c)]: sizeOf(c) - n };

const insert = (s) => ({ insert: s });
const retain = (n) => ({ retain: n });
const drop = (n) => ({ delete: n });

const baseLen = (cs) => cs.reduce((n, c) => (c.insert === undefined ? n + sizeOf(c) : n), 0);
const resultLen = (cs) => cs.reduce((n, c) => n + (c.insert !== undefined ? c.insert.length : (c.retain ?? 0)), 0);

/** Extend an operation with the trailing retain it did not spell out. */
function cover(components, docLength) {
  const need = docLength - baseLen(components);
  if (need < 0) throw new OtError('operation reads more characters than its document holds');
  return need === 0 ? components : normalize([...components, retain(need)]);
}

class Pusher {
  constructor() {
    this.out = [];
  }

  add(c) {
    const last = this.out[this.out.length - 1];
    if (last && kindOf(last) === kindOf(c)) {
      this.out[this.out.length - 1] =
        kindOf(c) === 'insert' ? insert(last.insert + c.insert) : { [kindOf(c)]: sizeOf(last) + sizeOf(c) };
    } else this.out.push(c);
  }
}

class Iter {
  constructor(components) {
    this.cs = components;
    this.i = 0;
    this.rem = null;
  }

  hasNext() {
    return this.rem !== null || this.i < this.cs.length;
  }

  current() {
    return this.rem ?? (this.i < this.cs.length ? this.cs[this.i] : null);
  }

  kind() {
    const c = this.current();
    return c === null ? null : kindOf(c);
  }

  size() {
    const c = this.current();
    return c === null ? 0 : sizeOf(c);
  }

  /** Drop the unit currently under the cursor, honouring a partial remainder. */
  advance() {
    if (this.rem) this.rem = null;
    else this.i += 1;
  }

  next() {
    const c = this.current();
    this.advance();
    return c;
  }

  /** Consume the first `n` units, leaving the remainder for the next read. */
  take(n) {
    const c = this.current();
    if (n >= sizeOf(c)) {
      this.advance();
      return c;
    }
    // A live remainder means `i` already points past its parent component.
    if (!this.rem) this.i += 1;
    this.rem = tailOf(c, n);
    return headOf(c, n);
  }

  pushBack(c) {
    this.rem = c;
  }
}

export function normalize(components) {
  const p = new Pusher();
  for (const c of components) if (sizeOf(c) > 0) p.add(c);
  return p.out;
}

export function validate(components) {
  if (!Array.isArray(components)) throw new OtError('operation must be an array of components');
  for (const c of components) {
    if (c === null || typeof c !== 'object') throw new OtError('component must be an object');
    const keys = Object.keys(c).filter((k) => c[k] !== undefined);
    if (keys.length !== 1 || !['retain', 'insert', 'delete'].includes(keys[0])) {
      throw new OtError('component must have exactly one of retain/insert/delete');
    }
    const kind = keys[0];
    if (kind === 'insert') {
      if (typeof c.insert !== 'string') throw new OtError('insert must be a string');
    } else if (!Number.isInteger(c[kind]) || c[kind] < 0) {
      throw new OtError(`${kind} must be a non-negative integer`);
    }
  }
  return normalize(components);
}

export function apply(text, components) {
  const ops = validate(components);
  let out = '';
  let pos = 0;
  for (const c of ops) {
    if (c.insert !== undefined) {
      out += c.insert;
      continue;
    }
    const size = sizeOf(c);
    if (pos + size > text.length) throw new OtError('operation runs past the end of the document');
    if (c.retain !== undefined) out += text.slice(pos, pos + size);
    pos += size;
  }
  if (pos !== text.length) throw new OtError('operation must consume the whole document');
  return out;
}

/** Canonical single-edit operation turning `before` into `after`. */
export function makeEdit(before, after) {
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const p = new Pusher();
  if (start > 0) p.add(retain(start));
  if (endBefore > start) p.add(drop(endBefore - start));
  if (endAfter > start) p.add(insert(after.slice(start, endAfter)));
  if (endBefore < before.length) p.add(retain(before.length - endBefore));
  return cover(p.out, before.length);
}

/** Equivalent to applying `a` and then `b`. */
export function compose(a, b) {
  const av = validate(a);
  const A = new Iter(av);
  const B = new Iter(cover(validate(b), resultLen(av)));
  const p = new Pusher();

  while (A.hasNext() || B.hasNext()) {
    const ka = A.kind();
    const kb = B.kind();

    if (ka === 'delete') {
      p.add(A.next());
      continue;
    }
    if (kb === 'insert') {
      p.add(B.next());
      continue;
    }
    if (ka === 'insert' && kb === 'retain') {
      const n = Math.min(A.size(), B.size());
      p.add(insert(A.take(n).insert));
      B.take(n);
      continue;
    }
    if (ka === 'insert' && kb === 'delete') {
      const inserted = A.next().insert;
      const removed = B.next().delete;
      if (inserted.length > removed) A.pushBack(insert(inserted.slice(removed)));
      else if (inserted.length < removed) B.pushBack(drop(removed - inserted.length));
      continue;
    }
    if (ka === 'retain' && kb === 'delete') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      p.add(drop(n));
      continue;
    }
    if (ka === 'retain' && kb === 'retain') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      p.add(retain(n));
      continue;
    }
    // A has no component left, so it implicitly keeps the rest of the base text;
    // mirror whatever `b` does there.
    if (ka === null) {
      const c = B.next();
      p.add(c.delete !== undefined ? c : retain(sizeOf(c)));
      continue;
    }
    // Symmetrically, `b` implicitly keeps everything A says next.
    const c = A.next();
    p.add(c);
  }
  return cover(p.out, baseLen(av));
}

/**
 * Rebase a concurrent pair onto each other's result: returns `[a', b']` such that
 * `apply(apply(S, a), b') === apply(apply(S, b), a')`.
 * `aWins` breaks the tie when both insert at the same offset; callers must pass
 * complementary values for the two directions so all replicas converge.
 */
export function transformPair(a, b, aWins = true) {
  const av = validate(a);
  const bv = validate(b);
  const docLen = Math.max(baseLen(av), baseLen(bv));
  const A = new Iter(cover(av, docLen));
  const B = new Iter(cover(bv, docLen));
  const pa = new Pusher();
  const pb = new Pusher();

  while (A.hasNext() || B.hasNext()) {
    const ka = A.kind();
    const kb = B.kind();

    if (ka === 'insert' && (kb !== 'insert' || aWins)) {
      const c = A.next();
      pa.add(insert(c.insert));
      pb.add(retain(c.insert.length));
      continue;
    }
    if (kb === 'insert') {
      const c = B.next();
      pa.add(retain(c.insert.length));
      pb.add(insert(c.insert));
      continue;
    }
    if (ka === 'retain' && kb === 'retain') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      pa.add(retain(n));
      pb.add(retain(n));
      continue;
    }
    if (ka === 'retain' && kb === 'delete') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      pb.add(drop(n));
      continue;
    }
    if (ka === 'delete' && kb === 'retain') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      pa.add(drop(n));
      continue;
    }
    if (ka === 'delete' && kb === 'delete') {
      const n = Math.min(A.size(), B.size());
      A.take(n);
      B.take(n);
      continue;
    }
    throw new OtError(
      `transform: operations disagree at ${ka ?? 'end-of-a'}/${kb ?? 'end-of-b'} ` +
        `A=${JSON.stringify([A.i, A.rem, A.cs])} B=${JSON.stringify([B.i, B.rem, B.cs])}`,
    );
  }
  // a' reads the document `b` produced; b' reads the one `a` produced.
  return [cover(pa.out, resultLen(B.cs)), cover(pb.out, resultLen(A.cs))];
}

/** Rebase `a` onto the document produced by concurrent `b`. */
export function transform(a, b, aWins = true) {
  return transformPair(a, b, aWins)[0];
}

/**
 * Where an offset in the base document lands after `components` is applied.
 * Text inserted exactly at the offset pushes it unless `insertBefore` is set.
 */
export function transformPosition(components, pos, insertBefore = false) {
  const ops = validate(components);
  let doc = 0;
  let out = 0;
  for (const c of ops) {
    if (doc > pos) break;
    if (c.insert !== undefined) {
      if (doc < pos || !insertBefore) out += c.insert.length;
      continue;
    }
    const size = sizeOf(c);
    if (c.retain !== undefined) {
      if (pos >= doc + size) {
        out += size;
        doc += size;
        continue;
      }
      return out + (pos - doc);
    }
    if (pos >= doc + size) {
      doc += size;
      continue;
    }
    return out;
  }
  return out;
}

/** Number of base-document characters an operation reads. */
export function baseLength(components) {
  return baseLen(validate(components));
}

/** Number of characters an operation writes. */
export function resultLength(components) {
  return resultLen(validate(components));
}

