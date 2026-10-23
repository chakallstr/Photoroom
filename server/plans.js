// Paketlerin tek kaynağı: fiyat sayfası, limitler ve ödeme bu tanımları kullanır.
export const PLANS = {
  free: {
    name: 'Ücretsiz',
    dailyLimit: 10,
    maxSide: 1080,
    batch: false,
    seats: 1,
    prices: null,
  },
  pro: {
    name: 'Pro',
    dailyLimit: null,
    maxSide: null,
    batch: true,
    seats: 1,
    prices: { monthly: 99, yearly: 990 },
  },
  business: {
    name: 'İşletme',
    dailyLimit: null,
    maxSide: null,
    batch: true,
    seats: 5,
    prices: { monthly: 249, yearly: 2490 },
  },
};

export const PERIODS = ['monthly', 'yearly'];

export function isPaidPlan(plan) {
  return Boolean(PLANS[plan]?.prices);
}

export function limitsFor(plan, overrides = {}) {
  const p = PLANS[plan] ?? PLANS.free;
  return {
    plan: PLANS[plan] ? plan : 'free',
    dailyLimit: plan === 'free' && overrides.freeDailyLimit != null ? overrides.freeDailyLimit : p.dailyLimit,
    maxSide: p.maxSide,
    batch: p.batch,
  };
}
