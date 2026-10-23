import { PLANS, limitsFor } from './plans.js';

const DAY = 86400_000;
// Yenileme ödemesi gecikir ya da alınamazsa (sağlayıcı tekrar dener) kullanıcı birkaç gün daha ücretli pakette kalır.
const GRACE_MS = 3 * DAY;
const RANK = { free: 0, pro: 1, business: 2 };

export function addPeriod(from, period) {
  const d = new Date(from);
  if (period === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

function isEffective(sub, now) {
  if (sub.status === 'active' || sub.status === 'unpaid') return sub.current_period_end + GRACE_MS > now;
  if (sub.status === 'canceled') return sub.current_period_end > now;
  return false;
}

export function currentSubscription(db, userId, now = Date.now()) {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  const effective = subs.filter((s) => isEffective(s, now)).sort((a, b) => RANK[b.plan] - RANK[a.plan]);
  return effective[0] ?? subs[0] ?? null;
}

export function planFor(db, user, now = Date.now()) {
  if (!user) return 'free';
  const sub = currentSubscription(db, user.id, now);
  return sub && isEffective(sub, now) && PLANS[sub.plan] ? sub.plan : 'free';
}

export function subscriptionView(sub, now = Date.now()) {
  if (!sub) return null;
  return {
    plan: sub.plan,
    period: sub.period,
    status: sub.status,
    effective: isEffective(sub, now),
    currentPeriodEnd: new Date(sub.current_period_end).toISOString(),
  };
}

export function activateSubscription(db, { userId, provider, providerRef, customerRef, plan, period }, now = Date.now()) {
  db.prepare(`
    INSERT INTO subscriptions (user_id, provider, provider_ref, customer_ref, plan, period, status, current_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT (provider, provider_ref) DO NOTHING`)
    .run(userId, provider, providerRef, customerRef ?? null, plan, period, addPeriod(now, period), now, now);
}

// Webhook olaylarını abonelik durumuna uygular. Bilinmeyen abonelikler sessizce yok sayılır.
export function applySubscriptionEvent(db, provider, event, now = Date.now()) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?').get(provider, event.subscriptionRef);
  if (!sub) return false;
  if (event.remote) {
    // Sağlayıcıdan okunan gerçek durum her zaman önceliklidir.
    const end = event.remote.currentPeriodEnd ?? sub.current_period_end;
    db.prepare('UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = ? WHERE id = ?')
      .run(event.remote.status, end, now, sub.id);
  } else if (event.type === 'renewed') {
    const end = addPeriod(Math.max(now, sub.current_period_end), sub.period);
    db.prepare("UPDATE subscriptions SET status = 'active', current_period_end = ?, updated_at = ? WHERE id = ?").run(end, now, sub.id);
  } else if (event.type === 'payment_failed') {
    db.prepare("UPDATE subscriptions SET status = 'unpaid', updated_at = ? WHERE id = ?").run(now, sub.id);
  } else if (event.type === 'canceled') {
    db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?").run(now, sub.id);
  } else {
    return false;
  }
  return true;
}

export { limitsFor };
