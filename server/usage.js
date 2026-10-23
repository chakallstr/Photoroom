import { transaction } from './db.js';

export function today(timeZone, now = Date.now()) {
  // en-CA biçimi YYYY-MM-DD verir.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Paylaşılan IP'lerde (ofis, mobil operatör) birden fazla kişi olabileceği için IP sınırı daha geniş tutulur.
export const IP_MULTIPLIER = 3;

function checks(subjects, dailyLimit) {
  return [
    { subject: subjects.primary, limit: dailyLimit },
    ...(subjects.ip ? [{ subject: subjects.ip, limit: dailyLimit * IP_MULTIPLIER }] : []),
  ];
}

export function usageStatus(db, subjects, dailyLimit, day) {
  const get = db.prepare('SELECT count FROM usage WHERE subject = ? AND day = ?');
  const used = get.get(subjects.primary, day)?.count ?? 0;
  if (dailyLimit == null) return { used, remaining: null };
  let remaining = Infinity;
  for (const c of checks(subjects, dailyLimit)) {
    remaining = Math.min(remaining, c.limit - (get.get(c.subject, day)?.count ?? 0));
  }
  return { used, remaining: Math.max(0, remaining) };
}

// count kadar hak düşer. Limit aşılacaksa hiçbir şey yazmadan reddeder.
export function consume(db, subjects, dailyLimit, day, count) {
  return transaction(db, () => {
    const status = usageStatus(db, subjects, dailyLimit, day);
    if (dailyLimit != null && status.remaining < count) return { ok: false, ...status };
    const inc = db.prepare(`
      INSERT INTO usage (subject, day, count) VALUES (?, ?, ?)
      ON CONFLICT (subject, day) DO UPDATE SET count = count + excluded.count`);
    inc.run(subjects.primary, day, count);
    if (dailyLimit != null && subjects.ip) inc.run(subjects.ip, day, count);
    return { ok: true, ...usageStatus(db, subjects, dailyLimit, day) };
  });
}
