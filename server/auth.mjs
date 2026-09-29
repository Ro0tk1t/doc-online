/**
 * Accounts without a framework: passwords, session tokens, cookies and the small
 * anti-abuse pieces that belong to none of the layers above.
 *
 * scrypt and randomBytes come from `node:crypto`, comparisons are constant-time, and
 * nothing here touches the network -- so the whole module is testable in plain Node.
 */

import crypto from 'node:crypto';

export const COOKIE_NAME = 'doc_auth';
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days, absolute: no sliding writes to disk
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 512;
export const MIN_NAME = 2;
export const MAX_NAME = 32;

// N=16384 costs about 16 MB per hash, which fits node's default scrypt memory ceiling.
const SCRYPT = { N: 1 << 14, r: 8, p: 1 };

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;

function bad(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  throw err;
}

/** Login handle and display name are one field: what peers see is what you type at the door. */
export function assertName(name) {
  const cleaned = typeof name === 'string' ? name.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_NAME) : '';
  if (cleaned.length < MIN_NAME) bad(`name must be at least ${MIN_NAME} characters`);
  if (!NAME_PATTERN.test(cleaned)) bad('name may contain letters, numbers, spaces, dot, dash and underscore only');
  return cleaned;
}

export const nameKey = (name) => name.toLowerCase();

export function assertPassword(password) {
  if (typeof password !== 'string') bad('password is required');
  // Trimmed length is checked, but the raw bytes are hashed: leading spaces are nobody's business.
  if (password.trim().length < MIN_PASSWORD) bad(`password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) bad(`password must be at most ${MAX_PASSWORD} characters`);
  return password;
}

const toHex = (buffer) => buffer.toString('hex');

export async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = await scrypt(password, salt);
  return { salt: toHex(salt), pass: toHex(key) };
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Verify even when the record is junk: a malformed hash must read as a wrong password, not a 500. */
export async function verifyPassword(password, record) {
  const salt = Buffer.from(String(record?.salt ?? ''), 'hex');
  const expected = Buffer.from(String(record?.pass ?? ''), 'hex');
  if (salt.length < 8 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt);
  return crypto.timingSafeEqual(actual, expected);
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function newUserId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** `x-forwarded-proto` decides the Secure flag, the same way export.mjs decides the scheme. */
export function isSecure(req) {
  if (req?.socket?.encrypted) return true;
  const forwarded = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return forwarded === 'https';
}

export function cookieHeader(token, req) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (isSecure(req)) attributes.push('Secure');
  return attributes.join('; ');
}

export function logoutHeader(req) {
  const attributes = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (isSecure(req)) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Mutating requests must come from this page. Cookie auth without this check is a CSRF
 * hole even with SameSite=Lax, because top-level navigations are not covered by Lax.
 */
export function assertSameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return true; // a request with no Host cannot be a browser cross-site form
  const source = req.headers.origin ?? refererOrigin(req.headers.referer);
  if (!source) return true; // not a browser: curl, tests, another server
  if (source.toLowerCase() !== `https://${host}` && source.toLowerCase() !== `http://${host}`) {
    bad('cross-origin request refused', 403);
  }
  return true;
}

function refererOrigin(referer) {
  try {
    return new URL(String(referer)).origin;
  } catch {
    return null;
  }
}

/**
 * Per-account failure counter. It lives in memory on purpose: it is a speed bump for
 * password guessing, not a lockout ledger, and a restart should not punish anybody.
 */
export class Throttle {
  constructor({ window = 15 * 60 * 1000, threshold = 5, step = 30 * 1000 } = {}) {
    this.window = window;
    this.threshold = threshold;
    this.step = step;
    this.fails = new Map();
  }

  retryAfter(key, now = Date.now()) {
    const entry = this.fails.get(key);
    if (!entry || now - entry.first > this.window) return 0;
    return Math.max(0, Math.ceil((entry.first + this.blockedFor(entry) - now) / 1000));
  }

  blockedFor(entry) {
    return this.step * (entry.count - this.threshold + 1);
  }

  /** Returns the wait in seconds, or 0 when the attempt may proceed. */
  check(key, now = Date.now()) {
    const wait = this.retryAfter(key, now);
    if (wait) return wait;
    const entry = this.fails.get(key);
    if (entry && now - entry.first > this.window) this.fails.delete(key);
    return 0;
  }

  fail(key, now = Date.now()) {
    const entry = this.fails.get(key);
    if (!entry || now - entry.first > this.window) this.fails.set(key, { first: now, count: 1 });
    else entry.count += 1;
    return this.retryAfter(key, now);
  }

  clear(key) {
    this.fails.delete(key);
  }
}
