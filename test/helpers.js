import http from 'node:http';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { createMockProvider } from '../server/payments/mock.js';
import { createMailer } from '../server/email.js';

// Testler için bellekte veritabanı, sahte ödeme ve elle ilerletilebilen saat ile sunucu başlatır.
export async function startTestServer({ env = {}, payments } = {}) {
  const config = loadConfig({ FREE_DAILY_LIMIT: '3', ...env });
  config.dbPath = ':memory:';
  const db = openDb(':memory:');
  const clock = { now: Date.parse('2026-10-23T09:00:00Z') };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
  const provider = payments ?? createMockProvider({ publicUrl: base });
  const mailer = createMailer({ email: { provider: 'log' } }, { log: () => {} });
  server.on('request', createApp({ db, config, payments: provider, mailer, now: () => clock.now }));
  return {
    base, db, clock, payments: provider, mailer,
    // Son gönderilen e-postalar (en yenisi sonda)
    emails: () => mailer.outbox,
    client: () => new Client(base),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

// Çerezleri hatırlayan basit bir HTTP istemcisi (tarayıcı gibi davranır).
export class Client {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method, path, { json, form, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.cookieHeader();
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (raw !== undefined) body = raw;
    const res = await fetch(this.base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, headers: res.headers, data };
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, json, opts = {}) { return this.request('POST', path, { json, ...opts }); }
}
