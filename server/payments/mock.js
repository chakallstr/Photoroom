import crypto from 'node:crypto';

// Geliştirme ve testler için gerçek kart çekmeyen ödeme sağlayıcısı.
// Arayüzü iyzico sağlayıcısıyla aynıdır.
export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

export function signMockWebhook(rawBody) {
  return crypto.createHmac('sha256', MOCK_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

export function createMockProvider({ publicUrl }) {
  const results = new Map(); // token -> 'success' | 'failure'

  return {
    name: 'mock',

    async startCheckout({ plan, period }) {
      const token = 'mock_' + crypto.randomBytes(12).toString('hex');
      return { token, url: `${publicUrl}/api/billing/mock/pay?token=${token}&plan=${plan}&period=${period}` };
    },

    // Sahte ödeme sayfasındaki düğme bunu çağırır.
    setResult(token, result) {
      results.set(token, result);
    },

    async completeCheckout(token) {
      const result = results.get(token);
      results.delete(token);
      if (result !== 'success') return { ok: false, message: 'Ödeme onaylanmadı.' };
      return { ok: true, subscriptionRef: 'mocksub_' + token.slice(5), customerRef: 'mockcus_' + token.slice(5) };
    },

    parseWebhook({ headers, rawBody }) {
      const given = String(headers['x-mock-signature'] || '');
      const expected = signMockWebhook(rawBody);
      if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        return null;
      }
      const body = JSON.parse(rawBody);
      return { id: body.id, type: body.type, subscriptionRef: body.subscriptionRef };
    },

    async cancel() {
      return { ok: true };
    },
  };
}
