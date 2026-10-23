import http from 'node:http';
import crypto from 'node:crypto';

// iyzico abonelik API'sini taklit eden yerel sunucu. Her isteğin IYZWSv2 imzasını
// dokümandaki formülle (sunucunun yapacağı gibi) bağımsız olarak doğrular.
export async function startFakeIyzico({ apiKey, secretKey }) {
  const state = {
    requests: [],
    checkouts: new Map(), // token -> { pricingPlanReferenceCode, result }
    subscriptions: new Map(), // ref -> { status, orders }
    failInitialize: false,
    failRetrieveOnce: false,
  };

  function verifyAuth(req, path, body) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('IYZWSv2 ')) return '1008';
    const rnd = req.headers['x-iyzi-rnd'];
    if (!rnd) return '1004';
    const decoded = Buffer.from(header.slice(8), 'base64').toString('utf8');
    const m = decoded.match(/^apiKey:(.+)&randomKey:(.+)&signature:([0-9a-f]{64})$/);
    if (!m || m[1] !== apiKey || m[2] !== rnd) return '1000';
    const expected = crypto.createHmac('sha256', secretKey).update(rnd + path + body).digest('hex');
    return m[3] === expected ? null : '1000';
  }

  const fail = (errorCode, errorMessage) => ({ status: 'failure', errorCode, errorMessage, systemTime: Date.now() });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const { pathname } = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: pathname, body: raw ? JSON.parse(raw) : null });

    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const authError = verifyAuth(req, pathname, raw);
    if (authError) return send(401, fail(authError, 'Invalid signature'));
    const body = raw ? JSON.parse(raw) : {};

    let m;
    if (req.method === 'POST' && pathname === '/v2/subscription/checkoutform/initialize') {
      if (state.failInitialize) return send(400, fail('100001', 'Sistem hatası'));
      const c = body.customer ?? {};
      const missing = ['callbackUrl', 'pricingPlanReferenceCode', 'subscriptionInitialStatus'].filter((k) => !body[k])
        .concat(['name', 'surname', 'email', 'gsmNumber', 'identityNumber'].filter((k) => !c[k]))
        .concat(['contactName', 'city', 'country', 'address'].filter((k) => !c.billingAddress?.[k]));
      if (missing.length) return send(400, fail('5', `Eksik alan: ${missing.join(',')}`));
      const token = crypto.randomUUID();
      // Sahte sunucuda ödeme formu açılır açılmaz "ödenmiş" sayılır; abonelik iyzico tarafında oluşur.
      const ref = 'sub-' + token.slice(0, 8);
      state.checkouts.set(token, { pricingPlanReferenceCode: body.pricingPlanReferenceCode, result: 'ACTIVE', ref });
      state.subscriptions.set(ref, { status: 'ACTIVE', orders: [], customerEmail: c.email });
      return send(200, {
        status: 'success', systemTime: Date.now(), token, tokenExpireTime: 1800,
        checkoutFormContent: `<script>window.__iyzicoForm = ${JSON.stringify(token)}</script>`,
      });
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/v2\/subscription\/checkoutform\/([^/]+)$/))) {
      const co = state.checkouts.get(decodeURIComponent(m[1]));
      if (!co) return send(400, fail('201600', 'Token bulunamadı'));
      if (state.failRetrieveOnce) {
        state.failRetrieveOnce = false;
        return send(500, fail('100001', 'Sistem hatası'));
      }
      if (co.result !== 'ACTIVE') return send(400, fail('10051', 'Kart limiti yetersiz'));
      const ref = co.ref;
      return send(200, {
        status: 'success', systemTime: Date.now(),
        data: { referenceCode: ref, customerReferenceCode: 'cus-1', subscriptionStatus: 'ACTIVE', pricingPlanReferenceCode: co.pricingPlanReferenceCode },
      });
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/v2\/subscription\/subscriptions\/([^/]+)$/))) {
      const sub = state.subscriptions.get(decodeURIComponent(m[1]));
      if (!sub) return send(400, fail('201400', 'Abonelik bulunamadı'));
      return send(200, {
        status: 'success', systemTime: Date.now(),
        data: { totalCount: 1, currentPage: 1, pageCount: 1, items: [{ referenceCode: m[1], subscriptionStatus: sub.status, customerEmail: sub.customerEmail, orders: sub.orders }] },
      });
    }
    if (req.method === 'POST' && (m = pathname.match(/^\/v2\/subscription\/subscriptions\/([^/]+)\/cancel$/))) {
      const sub = state.subscriptions.get(decodeURIComponent(m[1]));
      if (!sub) return send(400, fail('201400', 'Abonelik bulunamadı'));
      sub.status = 'CANCELED';
      return send(200, { status: 'success', systemTime: Date.now() });
    }
    send(404, fail('404', 'Bilinmeyen uç nokta'));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
