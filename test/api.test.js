import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { signMockWebhook } from '../server/payments/mock.js';

let t;
beforeEach(async () => { t = await startTestServer(); });
afterEach(async () => { await t.close(); });

const DAY = 86400_000;

async function register(client, email = 'satici@ornek.com', password = 'gizli-sifre-1') {
  return client.post('/api/auth/register', { email, password });
}

// Oturumlar 30 gün geçerli; saati ileri alan testler tekrar giriş yapar.
async function relogin(client, email = 'satici@ornek.com', password = 'gizli-sifre-1') {
  const r = await client.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200);
}

async function subscribe(client, plan = 'pro', period = 'monthly') {
  const start = await client.post('/api/billing/checkout', { acceptTerms: true, plan, period });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const token = new URL(start.data.url).searchParams.get('token');
  const pay = await client.request('POST', '/api/billing/mock/pay', { form: { token, result: 'success' } });
  assert.equal(pay.status, 303);
  const cb = await client.get(pay.headers.get('location'));
  assert.equal(cb.status, 303);
  return { token, location: cb.headers.get('location') };
}

// ---------- Hesap ----------

test('anonim kullanıcı ücretsiz paketle başlar ve anonim çerez alır', async () => {
  const c = t.client();
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user, null);
  assert.equal(me.data.plan, 'free');
  assert.deepEqual(me.data.limits, { plan: 'free', dailyLimit: 3, maxSide: 1080, batch: false, brand: false });
  assert.ok(c.jar.has('pr_anon'));
});

test('kayıt, çıkış ve tekrar giriş çalışır', async () => {
  const c = t.client();
  const reg = await register(c);
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.email, 'satici@ornek.com');
  assert.ok(c.jar.has('pr_session'));

  assert.equal((await c.get('/api/me')).data.user.email, 'satici@ornek.com');

  assert.equal((await c.post('/api/auth/logout', {})).status, 200);
  assert.equal(c.jar.has('pr_session'), false);
  assert.equal((await c.get('/api/me')).data.user, null);

  const login = await c.post('/api/auth/login', { email: 'SATICI@ornek.com', password: 'gizli-sifre-1' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.email, 'satici@ornek.com');
});

test('çıkış yapılan oturum çerezi tekrar kullanılamaz', async () => {
  const c = t.client();
  await register(c);
  const stolen = c.jar.get('pr_session');
  await c.post('/api/auth/logout', {});
  const other = t.client();
  other.jar.set('pr_session', stolen);
  assert.equal((await other.get('/api/me')).data.user, null);
});

test('hatalı kayıt ve giriş istekleri reddedilir', async () => {
  const c = t.client();
  assert.equal((await c.post('/api/auth/register', { email: 'gecersiz', password: 'gizli-sifre-1' })).data.error, 'bad_email');
  assert.equal((await c.post('/api/auth/register', { email: 'a@b.co', password: 'kisa' })).data.error, 'weak_password');
  await register(c);
  assert.equal((await t.client().post('/api/auth/register', { email: 'satici@ornek.com', password: 'baska-sifre-1' })).status, 409);
  const bad = await t.client().post('/api/auth/login', { email: 'satici@ornek.com', password: 'yanlis-sifre' });
  assert.equal(bad.status, 401);
  const unknown = await t.client().post('/api/auth/login', { email: 'yok@ornek.com', password: 'yanlis-sifre' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.message, bad.data.message, 'hesap var mı yok mu belli olmamalı');
});

test('çok fazla hatalı giriş denemesi sınırlanır', async () => {
  const c = t.client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { email: 'kurban@ornek.com', password: 'tahmin-' + i });
  assert.equal(last.status, 429);
});

test('JSON olmayan ve başka siteden gelen POST istekleri reddedilir (CSRF)', async () => {
  const c = t.client();
  const form = await c.request('POST', '/api/auth/login', { form: { email: 'a@b.co', password: 'x' } });
  assert.equal(form.status, 415);
  const cross = await c.post('/api/usage', { count: 1 }, { headers: { origin: 'https://kotu-site.example' } });
  assert.equal(cross.status, 403);
});

// ---------- Günlük limit ----------

test('ücretsiz paket günlük limitte durur, ertesi gün sıfırlanır', async () => {
  const c = t.client();
  for (let i = 1; i <= 3; i++) {
    const r = await c.post('/api/usage', { count: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.usage.remaining, 3 - i);
  }
  const over = await c.post('/api/usage', { count: 1 });
  assert.equal(over.status, 429);
  assert.equal(over.data.error, 'daily_limit');

  t.clock.now += DAY;
  assert.equal((await c.post('/api/usage', { count: 1 })).status, 200);
});

test('limit aşan toplu istek hiç hak düşürmez', async () => {
  const c = t.client();
  await c.post('/api/usage', { count: 2 });
  const over = await c.post('/api/usage', { count: 2 });
  assert.equal(over.status, 429);
  assert.equal(over.data.usage.remaining, 1);
  assert.equal((await c.post('/api/usage', { count: 1 })).status, 200);
});

test('gün sınırı İstanbul saatine göre hesaplanır', async () => {
  const c = t.client();
  t.clock.now = Date.parse('2026-10-23T20:00:00Z'); // İstanbul'da 23:00
  for (let i = 0; i < 3; i++) await c.post('/api/usage', { count: 1 });
  assert.equal((await c.post('/api/usage', { count: 1 })).status, 429);
  t.clock.now = Date.parse('2026-10-23T21:30:00Z'); // İstanbul'da ertesi gün 00:30
  assert.equal((await c.post('/api/usage', { count: 1 })).status, 200);
});

test('çerezi silmek limiti sıfırlamaz (IP sınırı)', async () => {
  // IP sınırı = günlük limit × 3 = 9
  let blocked = false;
  for (let i = 0; i < 4 && !blocked; i++) {
    const c = t.client(); // her seferinde yeni, çerezsiz istemci
    for (let j = 0; j < 3; j++) {
      const r = await c.post('/api/usage', { count: 1 });
      if (r.status === 429) { blocked = true; break; }
    }
  }
  assert.ok(blocked, 'yeni çerezlerle sınırsız hak alınabilmemeli');
});

// ---------- Ödeme ve abonelik ----------

test('giriş yapmadan ödeme başlatılamaz, geçersiz paket reddedilir', async () => {
  const c = t.client();
  assert.equal((await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' })).status, 401);
  await register(c);
  assert.equal((await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'free', period: 'monthly' })).status, 400);
  assert.equal((await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'haftalik' })).status, 400);
});

test('Pro aboneliği sınırsız kullanım ve tam çözünürlük açar', async () => {
  const c = t.client();
  await register(c);
  const { location } = await subscribe(c);
  assert.equal(location, '/app.html?odeme=basarili');

  const me = (await c.get('/api/me')).data;
  assert.equal(me.plan, 'pro');
  assert.deepEqual(me.limits, { plan: 'pro', dailyLimit: null, maxSide: null, batch: true, brand: false });
  assert.equal(me.subscription.status, 'active');

  for (let i = 0; i < 20; i++) assert.equal((await c.post('/api/usage', { count: 1 })).status, 200);
});

test('reddedilen kartta abonelik açılmaz', async () => {
  const c = t.client();
  await register(c);
  const start = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' });
  const token = new URL(start.data.url).searchParams.get('token');
  const pay = await c.request('POST', '/api/billing/mock/pay', { form: { token, result: 'failure' } });
  const cb = await c.get(pay.headers.get('location'));
  assert.equal(cb.headers.get('location'), '/app.html?odeme=basarisiz');
  assert.equal((await c.get('/api/me')).data.plan, 'free');
});

test('aynı ödeme dönüşü iki kez kullanılamaz, bilinmeyen token reddedilir', async () => {
  const c = t.client();
  await register(c);
  const { token } = await subscribe(c);
  const again = await c.get(`/api/billing/callback?token=${token}`);
  assert.equal(again.headers.get('location'), '/app.html?odeme=gecersiz');
  const unknown = await c.request('POST', '/api/billing/callback', { form: { token: 'uydurma' } });
  assert.equal(unknown.headers.get('location'), '/app.html?odeme=gecersiz');
});

test('ödeme dönüşü oturum çerezi olmadan da doğru kullanıcıya işlenir', async () => {
  const c = t.client();
  await register(c);
  const start = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'business', period: 'yearly' });
  const token = new URL(start.data.url).searchParams.get('token');
  t.payments.setResult(token, 'success');
  // iyzico dönüşü başka siteden gelen bir form POST'udur; SameSite=Lax çerez gönderilmez.
  const cb = await t.client().request('POST', '/api/billing/callback', { form: { token } });
  assert.equal(cb.headers.get('location'), '/app.html?odeme=basarili');
  const me = (await c.get('/api/me')).data;
  assert.equal(me.plan, 'business');
  assert.equal(me.subscription.period, 'yearly');
});

test('zaten abone olan kullanıcı ikinci kez ödeme başlatamaz', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  assert.equal((await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'yearly' })).status, 409);
});

function webhook(c, body, signature) {
  const raw = JSON.stringify(body);
  return c.request('POST', '/api/billing/webhook', {
    raw, headers: { 'content-type': 'application/json', 'x-mock-signature': signature ?? signMockWebhook(raw) },
  });
}

test('yenileme webhook\'u süreyi uzatır; imzasız webhook reddedilir; tekrar gelen olay bir kez işlenir', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  const end0 = Date.parse((await c.get('/api/me')).data.subscription.currentPeriodEnd);

  assert.equal((await webhook(c, { id: 'evt1', type: 'renewed', subscriptionRef: ref }, 'sahte')).status, 401);
  assert.equal((await webhook(c, { id: 'evt1', type: 'renewed', subscriptionRef: ref })).status, 200);
  const dup = await webhook(c, { id: 'evt1', type: 'renewed', subscriptionRef: ref });
  assert.equal(dup.data.duplicate, true);

  const end1 = Date.parse((await c.get('/api/me')).data.subscription.currentPeriodEnd);
  assert.ok(end1 > end0 + 27 * DAY && end1 < end0 + 32 * DAY, 'bir ay uzamalı (yalnızca bir kez)');
});

test('ödeme alınamazsa ödenen dönem + ek süre sonunda ücretsize düşer', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  await webhook(c, { id: 'evt2', type: 'payment_failed', subscriptionRef: ref });
  const me = (await c.get('/api/me')).data;
  assert.equal(me.plan, 'pro', 'ödenmiş dönem bitmeden Pro kalmalı');
  assert.equal(me.subscription.status, 'unpaid');
  t.clock.now += 35 * DAY;
  await relogin(c);
  assert.equal((await c.get('/api/me')).data.plan, 'free');
});

test('ödemesi alınamayan abonelik iptal edilebilir', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  const ref = t.db.prepare('SELECT provider_ref FROM subscriptions').get().provider_ref;
  await webhook(c, { id: 'evt3', type: 'payment_failed', subscriptionRef: ref });
  const r = await c.post('/api/billing/cancel', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.subscription.status, 'canceled');
});

test('iki sekmeden iki ödeme: yeni abonelik açılır, eskisi sağlayıcıda iptal edilir', async () => {
  const c = t.client();
  await register(c);
  const a = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' });
  const b = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'business', period: 'monthly' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  for (const start of [a, b]) {
    const token = new URL(start.data.url).searchParams.get('token');
    t.payments.setResult(token, 'success');
    await t.client().get(`/api/billing/callback?token=${token}`);
  }
  const subs = t.db.prepare('SELECT plan, status FROM subscriptions ORDER BY id').all().map((s) => `${s.plan}:${s.status}`);
  assert.deepEqual(subs, ['pro:canceled', 'business:active']);
  assert.equal((await c.post('/api/billing/cancel', {})).status, 200);
  assert.equal((await c.post('/api/billing/cancel', {})).status, 404, 'açık abonelik kalmamalı');
});

test('ödeme yapıp dönüş sayfasına gelmeyen kullanıcının aboneliği sonradan açılır', async () => {
  const c = t.client();
  await register(c);
  const start = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' });
  const token = new URL(start.data.url).searchParams.get('token');
  t.payments.setResult(token, 'success'); // ödendi ama sekme kapandı, dönüş hiç gelmedi
  assert.equal((await c.get('/api/me')).data.plan, 'free', 'hemen kontrol edilmez');
  t.clock.now += 20_000;
  assert.equal((await c.get('/api/me')).data.plan, 'pro');
});

test('aynı ödeme dönüşü eşzamanlı iki istekle iki kez işlenmez', async () => {
  const c = t.client();
  await register(c);
  const start = await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' });
  const token = new URL(start.data.url).searchParams.get('token');
  t.payments.setResult(token, 'success');
  const results = await Promise.all([1, 2].map(() => t.client().get(`/api/billing/callback?token=${token}`)));
  const locations = results.map((r) => r.headers.get('location')).sort();
  assert.deepEqual(locations, ['/app.html?odeme=basarili', '/app.html?odeme=gecersiz']);
});

test('süresi biten ve yenilenmeyen abonelik (ek süre sonrası) ücretsize döner', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  t.clock.now += 32 * DAY;
  await relogin(c);
  assert.equal((await c.get('/api/me')).data.plan, 'pro', 'ek süre içinde Pro kalmalı');
  t.clock.now += 3 * DAY;
  assert.equal((await c.get('/api/me')).data.plan, 'free');
});

test('iptal edilen abonelik dönem sonuna kadar geçerli kalır', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  const cancel = await c.post('/api/billing/cancel', {});
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.plan, 'pro');
  assert.equal(cancel.data.subscription.status, 'canceled');
  t.clock.now += 31 * DAY;
  await relogin(c);
  assert.equal((await c.get('/api/me')).data.plan, 'free');
  assert.equal((await c.post('/api/billing/cancel', {})).status, 404);
});

test('sözleşme onaylanmadan ödeme başlatılamaz; onay zamanı kaydedilir', async () => {
  const c = t.client();
  await register(c);
  const r = await c.post('/api/billing/checkout', { plan: 'pro', period: 'monthly' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'terms_required');
  await c.post('/api/billing/checkout', { acceptTerms: true, plan: 'pro', period: 'monthly' });
  assert.equal(t.db.prepare('SELECT terms_accepted_at FROM checkouts').get().terms_accepted_at, t.clock.now);
});

test('İşletme paketi logo özelliğini açar', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c, 'business', 'monthly');
  assert.equal((await c.get('/api/me')).data.limits.brand, true);
});

// ---------- Hesap ayarları ----------

test('şifre değiştirme: eski şifre gerekir, diğer oturumlar kapanır', async () => {
  const c = t.client();
  await register(c);
  const other = t.client();
  await relogin(other);
  assert.equal((await c.post('/api/account/password', { currentPassword: 'yanlis-sifre', newPassword: 'yeni-sifre-123' })).status, 401);
  assert.equal((await c.post('/api/account/password', { currentPassword: 'gizli-sifre-1', newPassword: 'kisa' })).status, 400);
  assert.equal((await c.post('/api/account/password', { currentPassword: 'gizli-sifre-1', newPassword: 'yeni-sifre-123' })).status, 200);
  assert.equal((await c.get('/api/me')).data.user.email, 'satici@ornek.com', 'bu cihaz açık kalmalı');
  assert.equal((await other.get('/api/me')).data.user, null, 'diğer cihaz kapanmalı');
  assert.equal((await t.client().post('/api/auth/login', { email: 'satici@ornek.com', password: 'gizli-sifre-1' })).status, 401);
  assert.equal((await t.client().post('/api/auth/login', { email: 'satici@ornek.com', password: 'yeni-sifre-123' })).status, 200);
});

test('hesap silme: şifre gerekir, abonelik iptal edilir, tüm veriler silinir', async () => {
  const c = t.client();
  await register(c);
  await subscribe(c);
  await c.post('/api/usage', { count: 1 });
  assert.equal((await c.post('/api/account/delete', { password: 'yanlis-sifre' })).status, 401);
  const r = await c.post('/api/account/delete', { password: 'gizli-sifre-1' });
  assert.equal(r.status, 200);
  assert.equal(c.jar.has('pr_session'), false);
  for (const table of ['users', 'sessions', 'subscriptions', 'checkouts']) {
    assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM usage WHERE subject LIKE 'u:%'").get().n, 0);
  assert.equal((await t.client().post('/api/auth/login', { email: 'satici@ornek.com', password: 'gizli-sifre-1' })).status, 401);
  // Aynı e-postayla yeniden kayıt olunabilir.
  assert.equal((await register(t.client())).status, 201);
});

test('sağlık kontrolü', async () => {
  assert.deepEqual((await t.client().get('/api/health')).data, { ok: true });
});

// ---------- Bozuk istekler ----------

test('bozuk istekler sunucuyu düşürmez ve 500 vermez', async () => {
  const net = await import('node:net');
  const port = new URL(t.base).port;
  const raw = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(data));
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  const c = t.client();
  assert.equal((await c.get('/api/me')).status, 200, 'sunucu ayakta kalmalı');
  for (const path of ['/api/usage', '/api/auth/login', '/api/auth/register']) {
    const r = await c.request('POST', path, { raw: 'null', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400, path);
  }
  const badCookie = await c.get('/api/me', { headers: { cookie: 'other=%E0%A4%A' } });
  assert.equal(badCookie.status, 200);
});

// ---------- Statik dosyalar ----------

test('statik sayfalar sunulur, klasör dışına çıkılamaz', async () => {
  const c = t.client();
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Photoroot/);
  assert.equal((await c.get('/app.html')).status, 200);
  assert.equal((await c.get('/assets/app.js')).status, 200);
  const wasm = await c.get('/assets/vendor/vtracer/vtracer_bg.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm', 'tarayıcı WASM akışlı derlemeyi ancak bu türle yapar');
  assert.equal((await c.get('/../package.json')).status, 404);
  assert.equal((await c.get('/%2e%2e/package.json')).status, 404);
  assert.equal((await c.get('/api/yok')).status, 404);
});

test('editörde SVG dışa aktarma seçenekleri var ve vektör motoru tembel yüklenir', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(html, /data-value="svg"/);
  for (const m of ["sadakat", "temiz", "birebir"]) assert.match(html, new RegExp(`id="svg-mode"[\\s\\S]*data-value="${m}"`));
  assert.doesNotMatch(html, /data-value="(cizim|logo|detayli)"/, 'eğri tabanlı eski stil türleri üründe sunulmaz');
  const js = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  assert.match(js, /import\('\.\/vector\.js'\)/);
  assert.match(js, /colorBits: 5/);
});

test('editörde "arka planı silme" seçeneği var ve seçilince model atlanır', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(html, /id="keep-bg"/);
  const js = fs.readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
  assert.match(js, /settings\.keepBg \? await decodePixels\(item\.file\)/);
});
