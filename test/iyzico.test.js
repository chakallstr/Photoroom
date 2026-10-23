import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer } from './helpers.js';
import { startFakeIyzico } from './fake-iyzico.js';
import { authorizationHeader, createIyzicoProvider, customerPayload, webhookSignature } from '../server/payments/iyzico.js';

const KEYS = { apiKey: 'sandbox-api-key', secretKey: 'sandbox-secret-key', merchantId: '123456' };
const PLANS = {
  'pro:monthly': 'plan-pro-m', 'pro:yearly': 'plan-pro-y',
  'business:monthly': 'plan-biz-m', 'business:yearly': 'plan-biz-y',
};
const CUSTOMER = {
  name: 'Ayşe', surname: 'Yılmaz', gsmNumber: '0532 123 45 67', identityNumber: '11111111111',
  city: 'İstanbul', address: 'Kadıköy Moda Cad. No:1',
};

let fake, t;
beforeEach(async () => {
  fake = await startFakeIyzico(KEYS);
  const provider = createIyzicoProvider({ ...KEYS, baseUrl: fake.url, plans: PLANS, publicUrl: 'http://placeholder' });
  t = await startTestServer({ payments: provider });
  // Test sunucusunun adresi başlatıldıktan sonra belli olduğu için sağlayıcıyı yeniden oluşturuyoruz.
  Object.assign(provider, createIyzicoProvider({ ...KEYS, baseUrl: fake.url, plans: PLANS, publicUrl: t.base }));
});
afterEach(async () => { await t.close(); await fake.close(); });

async function registered() {
  const c = t.client();
  const r = await c.post('/api/auth/register', { email: 'ayse@ornek.com', password: 'gizli-sifre-1' });
  assert.equal(r.status, 201);
  return c;
}

async function subscribe(c, plan = 'pro', period = 'monthly') {
  const start = await c.post('/api/billing/checkout', { plan, period, customer: CUSTOMER });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const token = new URL(start.data.url).searchParams.get('token');
  return { token, start };
}

// ---------- İmza ----------

test('IYZWSv2 başlığı dokümandaki formülle birebir aynı', () => {
  const header = authorizationHeader({ ...KEYS, path: '/v2/subscription/checkoutform/initialize', body: '{"a":1}', randomKey: '123456789' });
  const sig = crypto.createHmac('sha256', KEYS.secretKey).update('123456789/v2/subscription/checkoutform/initialize{"a":1}').digest('hex');
  const expected = 'IYZWSv2 ' + Buffer.from(`apiKey:${KEYS.apiKey}&randomKey:123456789&signature:${sig}`).toString('base64');
  assert.equal(header, expected);
});

test('webhook imzası doküman örneğindeki sırayla hesaplanır', () => {
  const fields = { eventType: 'subscription.order.success', subscriptionReferenceCode: 'S', orderReferenceCode: 'O', customerReferenceCode: 'C' };
  const expected = crypto.createHmac('sha256', KEYS.secretKey).update(`${KEYS.merchantId}${KEYS.secretKey}subscription.order.successSOC`).digest('hex');
  assert.equal(webhookSignature({ ...KEYS, ...fields }), expected);
});

test('müşteri bilgileri doğrulanır ve telefon +90 biçimine çevrilir', () => {
  const ok = customerPayload(CUSTOMER, 'ayse@ornek.com');
  assert.equal(ok.customer.gsmNumber, '+905321234567');
  assert.equal(ok.customer.billingAddress.contactName, 'Ayşe Yılmaz');
  const bad = customerPayload({ name: 'A' }, 'a@b.co');
  assert.deepEqual(bad.errors, ['Soyad', 'Cep telefonu', 'TC kimlik no', 'Şehir', 'Adres']);
});

// ---------- Uçtan uca akış (sahte iyzico sunucusuyla) ----------

test('eksik fatura bilgisiyle ödeme başlatılamaz', async () => {
  const c = await registered();
  const r = await c.post('/api/billing/checkout', { plan: 'pro', period: 'monthly', customer: { name: 'Ayşe' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'bad_customer');
  assert.match(r.data.message, /TC kimlik no/);
  assert.equal(fake.state.requests.length, 0, 'iyzico\'ya hiç istek gitmemeli');
});

test('ödeme formu oluşturulur, imzalı istek doğru alanlarla gider ve sayfada gösterilir', async () => {
  const c = await registered();
  const { token, start } = await subscribe(c);
  assert.match(start.data.url, /\/api\/billing\/pay\?token=/);

  const req = fake.state.requests.at(-1);
  assert.equal(req.path, '/v2/subscription/checkoutform/initialize');
  assert.equal(req.body.pricingPlanReferenceCode, 'plan-pro-m');
  assert.equal(req.body.subscriptionInitialStatus, 'ACTIVE');
  assert.equal(req.body.callbackUrl, `${t.base}/api/billing/callback`);
  assert.equal(req.body.customer.email, 'ayse@ornek.com');

  const page = await c.get(start.data.url.replace(t.base, ''));
  assert.equal(page.status, 200);
  assert.match(page.data, /id="iyzipay-checkout-form"/);
  assert.ok(page.data.includes(token));

  // Başka bir kullanıcı bu ödeme sayfasını göremez.
  const other = t.client();
  await other.post('/api/auth/register', { email: 'baska@ornek.com', password: 'gizli-sifre-2' });
  const stolen = await other.get(start.data.url.replace(t.base, ''));
  assert.equal(stolen.headers.get('location'), '/app.html?odeme=gecersiz');
});

test('iyzico dönüşü doğrulanınca Pro açılır', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  const cb = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(cb.headers.get('location'), '/app.html?odeme=basarili');
  const retrieve = fake.state.requests.at(-1);
  assert.equal(retrieve.method, 'GET');
  assert.equal(retrieve.path, `/v2/subscription/checkoutform/${token}`);
  const me = (await c.get('/api/me')).data;
  assert.equal(me.plan, 'pro');
  assert.deepEqual(me.billing, { provider: 'iyzico', needsCustomer: true });
});

test('kart reddedilirse abonelik açılmaz', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  fake.state.checkouts.get(token).result = 'FAILED';
  const cb = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(cb.headers.get('location'), '/app.html?odeme=basarisiz');
  assert.equal((await c.get('/api/me')).data.plan, 'free');
});

test('ödenen plan beklenenle eşleşmezse reddedilir', async () => {
  const c = await registered();
  const { token } = await subscribe(c, 'business', 'yearly');
  fake.state.checkouts.get(token).pricingPlanReferenceCode = 'plan-pro-m';
  const cb = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(cb.headers.get('location'), '/app.html?odeme=basarisiz');
});

test('iyzico hata dönerse kullanıcıya anlaşılır hata verilir', async () => {
  const c = await registered();
  fake.state.failInitialize = true;
  const r = await c.post('/api/billing/checkout', { plan: 'pro', period: 'monthly', customer: CUSTOMER });
  assert.equal(r.status, 502);
  assert.equal(r.data.message, 'Sistem hatası');
});

test('yanlış anahtarla imzalanan istekler iyzico tarafından reddedilir', async () => {
  const wrong = createIyzicoProvider({ ...KEYS, secretKey: 'yanlis', baseUrl: fake.url, plans: PLANS, publicUrl: t.base });
  await assert.rejects(
    wrong.startCheckout({ user: { id: 1, email: 'a@b.co' }, plan: 'pro', period: 'monthly', customer: CUSTOMER, callbackUrl: 'x' }),
    /Invalid signature/,
  );
});

function iyzicoWebhook(body, signature) {
  const raw = JSON.stringify(body);
  const sig = signature ?? webhookSignature({ ...KEYS, eventType: body.iyziEventType, ...body });
  return t.client().request('POST', '/api/billing/webhook', { raw, headers: { 'content-type': 'application/json', 'x-iyz-signature-v3': sig } });
}

test('yenileme webhook\'u aboneliği iyzico\'daki gerçek duruma göre günceller', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  await t.client().request('POST', '/api/billing/callback', { form: { token } });
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;

  const paidUntil = Date.parse('2026-12-23T09:00:00Z');
  fake.state.subscriptions.get(ref).orders = [
    { orderStatus: 'SUCCESS', endPeriod: Date.parse('2026-11-23T09:00:00Z') },
    { orderStatus: 'SUCCESS', endPeriod: paidUntil },
  ];
  const body = { orderReferenceCode: 'ord-2', customerReferenceCode: 'cus-1', subscriptionReferenceCode: ref, iyziReferenceCode: 'x', iyziEventType: 'subscription.order.success', iyziEventTime: Date.now() };

  assert.equal((await iyzicoWebhook(body, 'deadbeef')).status, 401, 'sahte imza reddedilmeli');
  assert.equal((await iyzicoWebhook(body)).status, 200);
  assert.equal((await iyzicoWebhook(body)).data.duplicate, true);
  assert.equal(Date.parse((await c.get('/api/me')).data.subscription.currentPeriodEnd), paidUntil);
});

test('başarısız yenilemede abonelik "ödenmedi" olur, ödenen dönem + ek süre sonunda ücretsize düşer', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  await t.client().request('POST', '/api/billing/callback', { form: { token } });
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  const paidUntil = t.clock.now + 86400_000;
  fake.state.subscriptions.get(ref).status = 'UNPAID';
  fake.state.subscriptions.get(ref).orders = [{ orderStatus: 'SUCCESS', endPeriod: paidUntil }, { orderStatus: 'FAILED', endPeriod: paidUntil + 30 * 86400_000 }];
  const r = await iyzicoWebhook({ orderReferenceCode: 'ord-3', customerReferenceCode: 'cus-1', subscriptionReferenceCode: ref, iyziEventType: 'subscription.order.failure' });
  assert.equal(r.status, 200);
  const me = (await c.get('/api/me')).data;
  assert.equal(me.subscription.status, 'unpaid');
  assert.equal(Date.parse(me.subscription.currentPeriodEnd), paidUntil);
  t.clock.now = paidUntil + 4 * 86400_000;
  assert.equal((await c.get('/api/me')).data.plan, 'free');
});

test('iyzico geçici hata verirse ödeme kaybolmaz, tekrar denemede abonelik açılır', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  fake.state.failRetrieveOnce = true;
  const first = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(first.headers.get('location'), '/app.html?odeme=basarisiz');
  const retry = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(retry.headers.get('location'), '/app.html?odeme=basarili');
  assert.equal((await c.get('/api/me')).data.plan, 'pro');
});

test('dönüşü hiç gelmeyen ödeme, iyzico webhook\'u gelince kullanıcıya bağlanır', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  const ref = fake.state.checkouts.get(token).ref;
  const r = await iyzicoWebhook({ orderReferenceCode: 'ord-9', customerReferenceCode: 'cus-1', subscriptionReferenceCode: ref, iyziEventType: 'subscription.order.success' });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/me')).data.plan, 'pro');
});

test('hiçbir kullanıcıya ait olmayan abonelik webhook\'u işlendi sayılmaz', async () => {
  fake.state.subscriptions.set('sub-yabanci', { status: 'ACTIVE', orders: [], customerEmail: 'yok@ornek.com' });
  const body = { orderReferenceCode: 'o', customerReferenceCode: 'c', subscriptionReferenceCode: 'sub-yabanci', iyziEventType: 'subscription.order.success' };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal((await iyzicoWebhook(body)).status, 500, 'iyzico tekrar göndersin diye 2xx dönmemeli');
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /bilinmeyen aboneliğe/);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n, 0);
});

test('iptal isteği iyzico\'ya gider, dönem sonuna kadar Pro kalır', async () => {
  const c = await registered();
  const { token } = await subscribe(c);
  await t.client().request('POST', '/api/billing/callback', { form: { token } });
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  const r = await c.post('/api/billing/cancel', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.plan, 'pro');
  assert.equal(r.data.subscription.status, 'canceled');
  const req = fake.state.requests.at(-1);
  assert.equal(req.path, `/v2/subscription/subscriptions/${ref}/cancel`);
  assert.equal(fake.state.subscriptions.get(ref).status, 'CANCELED');
});
