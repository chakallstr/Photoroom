import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { signMockWebhook } from '../server/payments/mock.js';
import { createMailer } from '../server/email.js';

let t;
beforeEach(async () => { t = await startTestServer(); });
afterEach(async () => { await t.close(); });

const EMAIL = 'satici@ornek.com';
const PASSWORD = 'gizli-sifre-1';

async function registered() {
  const c = t.client();
  assert.equal((await c.post('/api/auth/register', { email: EMAIL, password: PASSWORD })).status, 201);
  return c;
}

async function subscribe(c, plan = 'pro', period = 'monthly') {
  const start = await c.post('/api/billing/checkout', { acceptTerms: true, plan, period });
  const token = new URL(start.data.url).searchParams.get('token');
  t.payments.setResult(token, 'success');
  await t.client().get(`/api/billing/callback?token=${token}`);
}

const resetToken = (mail) => mail.text.match(/#sifre-sifirla=([A-Za-z0-9_-]+)/)[1];

// ---------- Şifre sıfırlama ----------

test('şifremi unuttum: e-postaya tek kullanımlık bağlantı gider, yeni şifreyle giriş yapılır', async () => {
  await registered();
  const r = await t.client().post('/api/auth/forgot', { email: 'SATICI@ornek.com' });
  assert.equal(r.status, 200);
  const mail = t.emails().at(-1);
  assert.equal(mail.to, EMAIL);
  assert.match(mail.subject, /şifre sıfırlama/);
  assert.ok(mail.text.includes(`${t.base}/app.html#sifre-sifirla=`), 'bağlantı # ile verilmeli (sunucu günlüklerine düşmesin)');

  const c = t.client();
  const reset = await c.post('/api/auth/reset', { token: resetToken(mail), password: 'yepyeni-sifre-1' });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.user.email, EMAIL, 'sıfırlama sonrası otomatik giriş');
  assert.equal((await t.client().post('/api/auth/login', { email: EMAIL, password: PASSWORD })).status, 401);
  assert.equal((await t.client().post('/api/auth/login', { email: EMAIL, password: 'yepyeni-sifre-1' })).status, 200);

  const again = await t.client().post('/api/auth/reset', { token: resetToken(mail), password: 'baska-sifre-12' });
  assert.equal(again.status, 400, 'bağlantı ikinci kez kullanılamaz');
});

test('olmayan e-posta için de aynı yanıt döner, e-posta gönderilmez', async () => {
  await registered();
  const before = t.emails().length;
  const known = await t.client().post('/api/auth/forgot', { email: EMAIL });
  const unknown = await t.client().post('/api/auth/forgot', { email: 'yok@ornek.com' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, known.data);
  assert.equal(t.emails().length, before + 1);
});

test('sıfırlama bağlantısı 1 saat sonra geçersiz olur; sıfırlama diğer oturumları kapatır', async () => {
  const c = await registered();
  await t.client().post('/api/auth/forgot', { email: EMAIL });
  const token = resetToken(t.emails().at(-1));
  t.clock.now += 61 * 60_000;
  assert.equal((await t.client().post('/api/auth/reset', { token, password: 'yepyeni-sifre-1' })).status, 400);

  await t.client().post('/api/auth/forgot', { email: EMAIL });
  const fresh = resetToken(t.emails().at(-1));
  assert.equal((await t.client().post('/api/auth/reset', { token: fresh, password: 'yepyeni-sifre-1' })).status, 200);
  assert.equal((await c.get('/api/me')).data.user, null, 'eski oturum kapanmalı');
});

test('uydurma ya da boş token reddedilir', async () => {
  for (const token of ['uydurma', '', undefined]) {
    assert.equal((await t.client().post('/api/auth/reset', { token, password: 'yepyeni-sifre-1' })).status, 400);
  }
});

// ---------- İşlem e-postaları ----------

test('satın alınca sipariş özeti ve mesafeli satış sözleşmesi e-postayla gider', async () => {
  const c = await registered();
  await subscribe(c, 'pro', 'yearly');
  const mail = t.emails().at(-1);
  assert.equal(mail.to, EMAIL);
  assert.match(mail.subject, /Pro aboneliğin başladı/);
  assert.match(mail.text, /Tutar: 990 ₺ \(KDV dahil\)/);
  assert.match(mail.text, /Yıllık/);
  assert.match(mail.text, /Mesafeli Satış Sözleşmesi/);
  assert.match(mail.text, /Cayma hakkı/, 'sözleşmenin tam metni e-postada olmalı');
  assert.doesNotMatch(mail.text, /<[a-z]+[ >]/, 'HTML etiketi kalmamalı');
});

test('iptal edilince e-posta gider', async () => {
  const c = await registered();
  await subscribe(c);
  await c.post('/api/billing/cancel', {});
  const mail = t.emails().at(-1);
  assert.match(mail.subject, /iptal edildi/);
  assert.match(mail.text, /tarihine kadar kullanmaya devam/);
});

test('yenileme ödemesi alınamayınca bir kez e-posta gider', async () => {
  const c = await registered();
  await subscribe(c);
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  const send = (id) => {
    const raw = JSON.stringify({ id, type: 'payment_failed', subscriptionRef: ref });
    return t.client().request('POST', '/api/billing/webhook', { raw, headers: { 'content-type': 'application/json', 'x-mock-signature': signMockWebhook(raw) } });
  };
  const before = t.emails().length;
  await send('f1');
  await send('f2'); // ikinci başarısız deneme: tekrar e-posta yok
  assert.equal(t.emails().length, before + 1);
  assert.match(t.emails().at(-1).subject, /ödemen alınamadı/);
});

test('hesap silinince onay e-postası gider', async () => {
  const c = await registered();
  await c.post('/api/account/delete', { password: PASSWORD });
  const mail = t.emails().at(-1);
  assert.equal(mail.to, EMAIL);
  assert.match(mail.subject, /hesabın silindi/);
});

test('e-posta gönderilemezse ödeme yine tamamlanır', async () => {
  const c = await registered();
  t.mailer.send = async () => { throw new Error('servis kapalı'); };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await subscribe(c);
  } finally {
    console.error = orig;
  }
  assert.equal((await c.get('/api/me')).data.plan, 'pro');
  assert.match(errors.join('\n'), /E-posta gönderilemedi/);
});

// ---------- Resend sağlayıcısı ----------

test('Resend sağlayıcısı doğru isteği gönderir, hata durumunu bildirir', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 422, text: async () => 'hata' };
  };
  const mailer = createMailer({ email: { provider: 'resend', from: 'Photoroot <merhaba@photoroot.app>', resendApiKey: 're_test' } }, { fetch: fakeFetch });
  await mailer.send({ to: 'a@b.co', subject: 'Konu', text: 'Metin' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { from: 'Photoroot <merhaba@photoroot.app>', to: ['a@b.co'], subject: 'Konu', text: 'Metin' });
  await assert.rejects(mailer.send({ to: 'a@b.co', subject: 'x', text: 'y' }), /Resend HTTP 422/);
  assert.throws(() => createMailer({ email: { provider: 'resend', from: '', resendApiKey: '' } }), /RESEND_API_KEY/);
});
