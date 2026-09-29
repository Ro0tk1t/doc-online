/**
 * Test-side stand-in for a browser: fetch with a cookie jar, plus a WebSocket that can
 * carry that cookie. Everything account-related needs a signed-in caller, and the socket
 * handshake authenticates through the cookie, so tests need the same two channels.
 */

import WebSocket from 'ws';

const PASSWORD = 'correct horse battery';

export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  get cookie() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #capture(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/(?:max-age=0|expires=thu, 01 jan 1970)/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(value));
    }
  }

  /** Raw request: returns the response, so callers can read headers or bytes. */
  async send(url, options = {}) {
    const res = await fetch(`${this.base}${url}`, {
      ...options,
      headers: { ...(options.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    this.#capture(res);
    return res;
  }

  /** Request that answers with parsed JSON, the shape most routes take. */
  async api(url, options = {}) {
    const res = await this.send(url, options);
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  }

  post(url, payload) {
    return this.api(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async signup(name = `user${Math.random().toString(36).slice(2, 8)}`) {
    const { status, body } = await this.post('/api/signup', { name, password: PASSWORD });
    if (status !== 201) throw new Error(`signup failed (${status}): ${body.error}`);
    return body.user;
  }

  async createDoc({ title = 'Untitled document', text = '' } = {}) {
    const { status, body } = await this.post('/api/docs', { title, text });
    if (status !== 201) throw new Error(`create failed (${status}): ${body.error}`);
    return body.doc;
  }

  /** A socket carrying this client's cookie; the server reads the session from it. */
  open(url) {
    return openSocket(url, this.cookie);
  }
}

/** Handshake without a cookie: who public documents call. */
export function openSocket(url, cookie = '') {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  ws.messages = [];
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data.toString());
    const index = waiters.findIndex((waiter) => waiter.test(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else ws.messages.push(msg);
  };
  ws.waitFor = (test, timeout = 3000) =>
    new Promise((resolve, reject) => {
      const existing = ws.messages.findIndex(test);
      if (existing >= 0) return resolve(ws.messages.splice(existing, 1)[0]);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeout);
      waiters.push({ test, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
    });
  ws.closed = new Promise((resolve) => ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws));
    // 4003 on a private document is sent before the handshake completes, so the failure
    // surfaces as a close, not as an error. Resolving on either keeps the helper usable
    // for the refused-connection tests.
    ws.addEventListener('error', () => resolve(ws));
  });
}
