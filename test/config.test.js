import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { ipBucket } from '../server/http.js';
import { cleanup, openDb } from '../server/db.js';
import { createIyzicoProvider } from '../server/payments/iyzico.js';
import { startTestServer } from './helpers.js';

test('sahte ödeme yalnızca localhost için açılır', () => {
  assert.equal(loadConfig({}).payments.provider, 'mock');
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://photoroot.app' }), /Sahte ödeme/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock' }), /Sahte ödeme|Üretim/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'iyzico' }), /IP_SALT/);
});

test('iyzico merchantId olmadan başlamaz', () => {
  assert.throws(() => createIyzicoProvider({ apiKey: 'a', secretKey: 'b', merchantId: '' }), /MERCHANT_ID/);
});

test('IPv6 adresleri /64 bloğuna indirgenir', () => {
  assert.equal(ipBucket('203.0.113.5'), '203.0.113.5');
  assert.equal(ipBucket('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(ipBucket('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8:aa:bb::9'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
});

test('proxy arkasında X-Forwarded-For başını değiştirmek limiti aşmaz', async () => {
  const t = await startTestServer({ env: { TRUST_PROXY: '1' } });
  try {
    let granted = 0;
    for (let i = 0; i < 30; i++) {
      // İstemcinin uydurduğu adres başta, proxy'nin eklediği gerçek adres sonda.
      const r = await t.client().post('/api/usage', { count: 1 }, { headers: { 'x-forwarded-for': `10.0.${i}.1, 198.51.100.7` } });
      if (r.status === 200) granted++;
    }
    assert.equal(granted, 9, 'IP sınırı (3 × günlük limit) uygulanmalı');
  } finally {
    await t.close();
  }
});

test('saklama süreleri: eski kullanım kayıtları ve süresi dolmuş oturumlar silinir', () => {
  const db = openDb(':memory:');
  const now = Date.parse('2026-10-24T12:00:00Z');
  db.prepare("INSERT INTO usage (subject, day, count) VALUES ('ip:a', '2026-09-01', 5), ('ip:b', '2026-10-20', 2)").run();
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1, 'a@b.co', 'x', 0)").run();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?), (?, 1, ?)').run('eski', now - 1, 'yeni', now + 1000);
  const removed = cleanup(db, now);
  assert.equal(removed.usage, 1);
  assert.equal(removed.sessions, 1);
  assert.deepEqual(db.prepare('SELECT subject FROM usage').all().map((r) => r.subject), ['ip:b']);
});
