import crypto from 'node:crypto';
import {
  ANON_COOKIE, SESSION_COOKIE, createRateLimiter, createSession, destroySession,
  hashPassword, normalizeEmail, userFromSession, validPassword, verifyPassword,
} from './auth.js';
import {
  activateSubscription, applySubscriptionEvent, currentSubscription, limitsFor, planFor, subscriptionView,
} from './billing.js';
import { HttpError, cookie, parseCookies, readBody, readJson, redirect, sendJson, serveStatic } from './http.js';
import { PERIODS, isPaidPlan } from './plans.js';
import { consume, today, usageStatus } from './usage.js';

export function createApp({ db, config, payments, now = () => Date.now() }) {
  const secure = config.publicUrl.startsWith('https://');
  const loginLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const routes = new Map();
  const route = (method, path, handler) => routes.set(`${method} ${path}`, handler);

  // ---------- Yardımcılar ----------

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '';
  }

  function context(req, sessionToken) {
    const cookies = parseCookies(req.headers.cookie);
    const user = userFromSession(db, sessionToken ?? cookies[SESSION_COOKIE], now());
    const setCookies = [];
    let anon = cookies[ANON_COOKIE];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(anon || '')) {
      anon = crypto.randomBytes(16).toString('base64url');
      setCookies.push(cookie(ANON_COOKIE, anon, { maxAge: 400 * 86400, secure }));
    }
    const ipHash = crypto.createHmac('sha256', config.ipSalt).update(clientIp(req)).digest('hex').slice(0, 32);
    const plan = planFor(db, user, now());
    const limits = limitsFor(plan, { freeDailyLimit: config.freeDailyLimit });
    const subjects = user
      ? { primary: `u:${user.id}`, ip: plan === 'free' ? `ip:${ipHash}` : null }
      : { primary: `a:${anon}`, ip: `ip:${ipHash}` };
    return { cookies, user, plan, limits, subjects, setCookies };
  }

  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, 'login_required', 'Bu işlem için giriş yapmalısın.');
    return ctx.user;
  }

  // Başka bir siteden gelen istekleri reddet (JSON zorunluluğuna ek bir katman).
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = new Set([config.publicUrl, `http://${req.headers.host}`, `https://${req.headers.host}`]);
    if (!allowed.has(origin)) throw new HttpError(403, 'bad_origin', 'İzin verilmeyen kaynak.');
  }

  function meBody(ctx) {
    const day = today(config.timeZone, now());
    const usage = usageStatus(db, ctx.subjects, ctx.limits.dailyLimit, day);
    const sub = ctx.user ? currentSubscription(db, ctx.user.id, now()) : null;
    return {
      user: ctx.user ? { email: ctx.user.email } : null,
      plan: ctx.plan,
      limits: ctx.limits,
      usage,
      subscription: subscriptionView(sub, now()),
      billing: { provider: payments.name, needsCustomer: Boolean(payments.needsCustomer) },
    };
  }

  function sessionCookie(token, maxAge) {
    return cookie(SESSION_COOKIE, token, { maxAge, secure });
  }

  // ---------- Hesap ----------

  route('GET', '/api/me', (req, res, ctx) => sendJson(res, 200, meBody(ctx)));

  route('POST', '/api/auth/register', async (req, res, ctx) => {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'bad_email', 'Geçerli bir e-posta adresi gir.');
    if (!validPassword(body.password)) throw new HttpError(400, 'weak_password', 'Şifre en az 8 karakter olmalı.');
    if (!loginLimiter.take(`reg:${clientIp(req)}`)) throw new HttpError(429, 'too_many', 'Çok fazla deneme. Biraz sonra tekrar dene.');
    const hash = await hashPassword(body.password);
    let userId;
    try {
      userId = Number(db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email, hash, now()).lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'email_taken', 'Bu e-posta ile zaten bir hesap var.');
      throw err;
    }
    const s = createSession(db, userId, now());
    ctx.setCookies.push(sessionCookie(s.token, s.maxAge));
    sendJson(res, 201, meBody(context(req, s.token)));
  });

  route('POST', '/api/auth/login', async (req, res, ctx) => {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!loginLimiter.take(`login:${clientIp(req)}`) || (email && !loginLimiter.take(`login:${email}`))) {
      throw new HttpError(429, 'too_many', 'Çok fazla deneme. Biraz sonra tekrar dene.');
    }
    const row = email && db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    // Kullanıcı yoksa da aynı süreyi harcamak için sahte bir doğrulama yapılır.
    const ok = await verifyPassword(String(body.password ?? ''), row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!row || !ok) throw new HttpError(401, 'bad_credentials', 'E-posta ya da şifre hatalı.');
    const s = createSession(db, row.id, now());
    ctx.setCookies.push(sessionCookie(s.token, s.maxAge));
    sendJson(res, 200, meBody(context(req, s.token)));
  });

  route('POST', '/api/auth/logout', async (req, res, ctx) => {
    await readJson(req);
    destroySession(db, ctx.cookies[SESSION_COOKIE]);
    ctx.setCookies.push(sessionCookie('', 0));
    sendJson(res, 200, { ok: true });
  });

  // ---------- Kullanım hakkı ----------

  route('POST', '/api/usage', async (req, res, ctx) => {
    const body = await readJson(req);
    const count = Number.isInteger(body.count) && body.count > 0 && body.count <= 100 ? body.count : 1;
    const day = today(config.timeZone, now());
    const result = consume(db, ctx.subjects, ctx.limits.dailyLimit, day, count);
    if (!result.ok) {
      return sendJson(res, 429, {
        error: 'daily_limit',
        message: `Günlük ${ctx.limits.dailyLimit} görsel hakkın doldu. Sınırsız kullanım için Pro'ya geç.`,
        usage: { used: result.used, remaining: result.remaining },
        limits: ctx.limits,
      });
    }
    sendJson(res, 200, { ok: true, usage: { used: result.used, remaining: result.remaining }, limits: ctx.limits });
  });

  // ---------- Ödeme ----------

  route('POST', '/api/billing/checkout', async (req, res, ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(req);
    if (!isPaidPlan(body.plan) || !PERIODS.includes(body.period)) {
      throw new HttpError(400, 'bad_plan', 'Geçersiz paket.');
    }
    if (ctx.plan !== 'free') throw new HttpError(409, 'already_subscribed', 'Zaten ücretli bir paketin var.');
    let checkout;
    try {
      checkout = await payments.startCheckout({
        user,
        plan: body.plan,
        period: body.period,
        customer: body.customer,
        callbackUrl: `${config.publicUrl}/api/billing/callback`,
      });
    } catch (err) {
      const status = { bad_customer: 400, plan_not_configured: 503, provider_error: 502 }[err.code];
      if (status) throw new HttpError(status, err.code, err.message);
      throw err;
    }
    db.prepare('INSERT INTO checkouts (token, user_id, plan, period, form_html, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(checkout.token, user.id, body.plan, body.period, checkout.formHtml ?? null, now());
    sendJson(res, 200, { url: checkout.url });
  });

  // iyzico ödeme formunu (checkoutFormContent) kendi sayfamızda gösterir.
  route('GET', '/api/billing/pay', (req, res, ctx) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const checkout = ctx.user && token && db.prepare("SELECT * FROM checkouts WHERE token = ? AND status = 'pending'").get(token);
    if (!checkout || checkout.user_id !== ctx.user.id || !checkout.form_html) return redirect(res, '/app.html?odeme=gecersiz');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Photoroot Ödeme</title>
<link rel="stylesheet" href="/assets/style.css"></head><body><main class="wrap" style="padding:32px 16px">
<a class="logo" href="/app.html">← Photoroot</a><h1 style="font-size:24px">Ödeme</h1>
<p style="color:var(--muted)">Kart bilgilerin iyzico'nun güvenli formunda işlenir, Photoroot'a ulaşmaz.</p>
<div id="iyzipay-checkout-form" class="responsive"></div>
${checkout.form_html}</main></body></html>`);
  });

  // Ödeme sağlayıcısı kullanıcıyı buraya geri yollar (iyzico form POST'u ile).
  // Başka siteden gelen POST'ta oturum çerezi gönderilmez; kullanıcıyı ödeme kaydından buluruz.
  async function callback(req, res) {
    const url = new URL(req.url, 'http://x');
    let token = url.searchParams.get('token');
    if (req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      token = form.get('token') || token;
    }
    const checkout = token && db.prepare("SELECT * FROM checkouts WHERE token = ? AND status = 'pending'").get(token);
    if (!checkout) return redirect(res, '/app.html?odeme=gecersiz');
    const result = await payments.completeCheckout(token, { plan: checkout.plan, period: checkout.period });
    if (!result.ok) {
      db.prepare("UPDATE checkouts SET status = 'failed' WHERE token = ?").run(token);
      return redirect(res, '/app.html?odeme=basarisiz');
    }
    activateSubscription(db, {
      userId: checkout.user_id,
      provider: payments.name,
      providerRef: result.subscriptionRef,
      customerRef: result.customerRef,
      plan: checkout.plan,
      period: checkout.period,
    }, now());
    db.prepare("UPDATE checkouts SET status = 'completed' WHERE token = ?").run(token);
    redirect(res, '/app.html?odeme=basarili');
  }
  route('GET', '/api/billing/callback', callback);
  route('POST', '/api/billing/callback', callback);

  route('POST', '/api/billing/webhook', async (req, res) => {
    const rawBody = await readBody(req);
    let event;
    try {
      event = payments.parseWebhook({ headers: req.headers, rawBody });
    } catch {
      event = null;
    }
    if (!event) throw new HttpError(401, 'bad_signature', 'Geçersiz imza.');
    if (event.id && db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(event.id)) {
      return sendJson(res, 200, { ok: true, duplicate: true });
    }
    if (payments.fetchSubscription) {
      // Okuma başarısız olursa hata döner; iyzico bildirimi daha sonra tekrar gönderir.
      const remote = await payments.fetchSubscription(event.subscriptionRef);
      if (!remote) throw new HttpError(502, 'provider_error', 'Abonelik durumu okunamadı.');
      event.remote = remote;
    }
    applySubscriptionEvent(db, payments.name, event, now());
    if (event.id) db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(event.id, now());
    sendJson(res, 200, { ok: true });
  });

  route('POST', '/api/billing/cancel', async (req, res, ctx) => {
    const user = requireUser(ctx);
    await readJson(req);
    const sub = currentSubscription(db, user.id, now());
    if (!sub || sub.status !== 'active') throw new HttpError(404, 'no_subscription', 'İptal edilecek aktif abonelik yok.');
    const result = await payments.cancel(sub.provider_ref);
    if (!result.ok) throw new HttpError(502, 'provider_error', result.message || 'Ödeme sağlayıcısı iptali onaylamadı.');
    applySubscriptionEvent(db, sub.provider, { type: 'canceled', subscriptionRef: sub.provider_ref }, now());
    sendJson(res, 200, meBody(context(req)));
  });

  if (payments.name === 'mock') {
    route('GET', '/api/billing/mock/pay', (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const esc = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sahte ödeme</title><body style="font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px">
<h1>Sahte ödeme sayfası</h1><p>Geliştirme modu: gerçek kart çekilmez.</p>
<p>Paket: <b>${esc(q.get('plan'))}</b> · ${esc(q.get('period'))}</p>
<form method="post" action="/api/billing/mock/pay"><input type="hidden" name="token" value="${esc(q.get('token'))}">
<button name="result" value="success" id="pay-ok">Ödemeyi onayla</button>
<button name="result" value="failure" id="pay-fail">Kartı reddet</button></form></body>`);
    });
    route('POST', '/api/billing/mock/pay', async (req, res) => {
      const form = new URLSearchParams(await readBody(req));
      const token = form.get('token') || '';
      payments.setResult(token, form.get('result') === 'success' ? 'success' : 'failure');
      redirect(res, `/api/billing/callback?token=${encodeURIComponent(token)}`);
    });
  }

  // ---------- İstek işleyici ----------

  return async function handler(req, res) {
    const { pathname } = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const handlerFn = routes.get(`${req.method} ${pathname}`);
      if (handlerFn) {
        const external = pathname === '/api/billing/webhook' || pathname === '/api/billing/callback';
        if (req.method === 'POST' && !external && !pathname.startsWith('/api/billing/mock/')) checkOrigin(req);
        const ctx = context(req);
        const originalWriteHead = res.writeHead.bind(res);
        res.writeHead = (status, headers = {}) => {
          if (ctx.setCookies.length) res.setHeader('Set-Cookie', ctx.setCookies);
          return originalWriteHead(status, headers);
        };
        return await handlerFn(req, res, ctx);
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Bulunamadı.');
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, config.publicDir)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sayfa bulunamadı');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'internal', message: 'Beklenmeyen bir hata oluştu.' });
    }
  };
}
