import crypto from 'node:crypto';

// iyzico abonelik API'si (SDK'sız, fetch + node:crypto).
// Kaynak: docs.iyzico.com ve resmi iyzipay-node SDK'sı (lib/utils.js, lib/resources/Subscription*.js).

// IYZWSv2 imzası: HMAC-SHA256(randomKey + yol + gövde, secretKey) → hex,
// ardından base64("apiKey:..&randomKey:..&signature:..").
// Yol sorgu dizesini içermez; gövdesiz isteklerde yalnızca randomKey + yol imzalanır.
export function authorizationHeader({ apiKey, secretKey, path, body = '', randomKey }) {
  const signature = crypto.createHmac('sha256', secretKey).update(randomKey + path + body).digest('hex');
  const params = `apiKey:${apiKey}&randomKey:${randomKey}&signature:${signature}`;
  return `IYZWSv2 ${Buffer.from(params).toString('base64')}`;
}

// Abonelik webhook imzası (X-IYZ-SIGNATURE-V3). Dokümandaki tüm kod örnekleri bu sırayı kullanır:
// merchantId + secretKey + eventType + subscriptionReferenceCode + orderReferenceCode + customerReferenceCode
export function webhookSignature({ merchantId, secretKey, eventType, subscriptionReferenceCode, orderReferenceCode, customerReferenceCode }) {
  const message = `${merchantId}${secretKey}${eventType}${subscriptionReferenceCode}${orderReferenceCode}${customerReferenceCode}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const REMOTE_STATUS = {
  ACTIVE: 'active',
  CANCELED: 'canceled',
  UPGRADED: 'canceled',
  UNPAID: 'unpaid',
  PENDING: 'unpaid',
  EXPIRED: 'expired',
};

// iyzico'nun istediği müşteri bilgilerini doğrular ve API biçimine çevirir.
export function customerPayload(input, email) {
  const c = input ?? {};
  const s = (v) => String(v ?? '').trim();
  const errors = [];
  const name = s(c.name), surname = s(c.surname), city = s(c.city), address = s(c.address);
  const identityNumber = s(c.identityNumber).replace(/\D/g, '');
  let gsm = s(c.gsmNumber).replace(/[\s()-]/g, '');
  if (/^0?5\d{9}$/.test(gsm)) gsm = '+90' + gsm.replace(/^0/, '');
  if (!name) errors.push('Ad');
  if (!surname) errors.push('Soyad');
  if (!/^\+905\d{9}$/.test(gsm)) errors.push('Cep telefonu');
  if (!/^\d{11}$/.test(identityNumber)) errors.push('TC kimlik no');
  if (!city) errors.push('Şehir');
  if (!address) errors.push('Adres');
  if (errors.length) return { errors };
  const billingAddress = { contactName: `${name} ${surname}`, city, country: 'Turkey', address };
  return {
    customer: { name, surname, email, gsmNumber: gsm, identityNumber, billingAddress, shippingAddress: billingAddress },
  };
}

export function createIyzicoProvider({ apiKey, secretKey, merchantId, baseUrl, plans, publicUrl, fetch: fetchFn = fetch }) {
  if (!apiKey || !secretKey || !merchantId) {
    // merchantId olmadan webhook imzaları doğrulanamaz ve yenilemeler sessizce kaybolur.
    throw new Error('IYZICO_API_KEY, IYZICO_SECRET_KEY ve IYZICO_MERCHANT_ID ayarlanmalı.');
  }

  async function call(method, path, bodyObj) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const randomKey = Date.now() + crypto.randomBytes(8).toString('hex');
    const res = await fetchFn(baseUrl + path, {
      method,
      headers: {
        Authorization: authorizationHeader({ apiKey, secretKey, path, body, randomKey }),
        'x-iyzi-rnd': randomKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body || undefined,
      signal: AbortSignal.timeout(15_000),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { status: 'failure', errorMessage: `HTTP ${res.status}` };
    }
    // HTTP koduna değil, iyzico'nun status alanına bakılır.
    return data;
  }

  const planCode = (plan, period) => plans[`${plan}:${period}`];

  return {
    name: 'iyzico',
    needsCustomer: true,

    async startCheckout({ user, plan, period, customer, callbackUrl }) {
      const pricingPlanReferenceCode = planCode(plan, period);
      if (!pricingPlanReferenceCode) throw Object.assign(new Error('Bu paket için iyzico planı tanımlı değil.'), { code: 'plan_not_configured' });
      const parsed = customerPayload(customer, user.email);
      if (parsed.errors) {
        throw Object.assign(new Error(`Eksik ya da hatalı bilgi: ${parsed.errors.join(', ')}`), { code: 'bad_customer' });
      }
      const data = await call('POST', '/v2/subscription/checkoutform/initialize', {
        locale: 'tr',
        conversationId: `u${user.id}-${Date.now()}`,
        callbackUrl,
        pricingPlanReferenceCode,
        subscriptionInitialStatus: 'ACTIVE',
        customer: parsed.customer,
      });
      if (data.status !== 'success' || !data.token) {
        throw Object.assign(new Error(data.errorMessage || 'iyzico ödeme formu oluşturulamadı.'), { code: 'provider_error' });
      }
      return {
        token: data.token,
        url: `${publicUrl}/api/billing/pay?token=${encodeURIComponent(data.token)}`,
        formHtml: data.checkoutFormContent,
      };
    },

    async completeCheckout(token, expected) {
      const data = await call('GET', `/v2/subscription/checkoutform/${encodeURIComponent(token)}`);
      const d = data.data;
      if (data.status !== 'success' || !d?.referenceCode) {
        return { ok: false, message: data.errorMessage || 'Ödeme doğrulanamadı.' };
      }
      if (d.subscriptionStatus !== 'ACTIVE') return { ok: false, message: `Abonelik durumu: ${d.subscriptionStatus}` };
      if (expected && d.pricingPlanReferenceCode !== planCode(expected.plan, expected.period)) {
        return { ok: false, final: true, message: 'Ödenen plan beklenen planla eşleşmiyor.' };
      }
      return { ok: true, subscriptionRef: d.referenceCode, customerRef: d.customerReferenceCode };
    },

    parseWebhook({ headers, rawBody }) {
      const body = JSON.parse(rawBody);
      const eventType = body.iyziEventType;
      if (!['subscription.order.success', 'subscription.order.failure'].includes(eventType)) return null;
      const expected = webhookSignature({
        merchantId, secretKey, eventType,
        subscriptionReferenceCode: body.subscriptionReferenceCode,
        orderReferenceCode: body.orderReferenceCode,
        customerReferenceCode: body.customerReferenceCode,
      });
      if (!safeEqual(headers['x-iyz-signature-v3'] || '', expected)) return null;
      return {
        id: `iyzico:${body.orderReferenceCode}:${eventType}`,
        type: eventType === 'subscription.order.success' ? 'renewed' : 'payment_failed',
        subscriptionRef: body.subscriptionReferenceCode,
      };
    },

    // Webhook'tan sonra aboneliğin gerçek durumunu iyzico'dan okur; böylece aynı ödeme
    // iki kez gelse ya da ilk ödemenin bildirimi gelse bile süre yanlış uzamaz.
    async fetchSubscription(ref) {
      const data = await call('GET', `/v2/subscription/subscriptions/${encodeURIComponent(ref)}`);
      const item = data.data?.items?.[0];
      if (data.status !== 'success' || !item) return null;
      const paidUntil = (item.orders ?? [])
        .filter((o) => o.orderStatus === 'SUCCESS' && o.endPeriod)
        .reduce((max, o) => Math.max(max, Number(o.endPeriod)), 0);
      return {
        status: REMOTE_STATUS[item.subscriptionStatus] ?? 'unpaid',
        currentPeriodEnd: paidUntil || null,
        customerEmail: item.customerEmail ?? null,
      };
    },

    async cancel(ref) {
      const data = await call('POST', `/v2/subscription/subscriptions/${encodeURIComponent(ref)}/cancel`, {});
      return data.status === 'success' ? { ok: true } : { ok: false, message: data.errorMessage };
    },

    // Kurulum betiği için: ürün ve ödeme planlarını oluşturur.
    async createProduct(name, description) {
      return call('POST', '/v2/subscription/products', { locale: 'tr', name, description });
    },
    async createPricingPlan(productRef, { name, price, interval }) {
      return call('POST', `/v2/subscription/products/${encodeURIComponent(productRef)}/pricing-plans`, {
        locale: 'tr', name, price, currencyCode: 'TRY', paymentInterval: interval, paymentIntervalCount: 1, planPaymentType: 'RECURRING',
      });
    },
  };
}
