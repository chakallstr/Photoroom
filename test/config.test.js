import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { ipBucket } from '../server/http.js';
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
