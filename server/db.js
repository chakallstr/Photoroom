import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- subject: 'u:<kullanıcı>', 'a:<anonim çerez>' ya da 'ip:<özet>'
CREATE TABLE IF NOT EXISTS usage (
  subject TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, day)
);

CREATE TABLE IF NOT EXISTS checkouts (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan       TEXT NOT NULL,
  period     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  form_html  TEXT,
  provider_ref TEXT,
  last_checked_at INTEGER,
  -- Mesafeli satış sözleşmesi ve ön bilgilendirme formunun onaylandığı an
  terms_accepted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  provider_ref       TEXT NOT NULL,
  customer_ref       TEXT,
  plan               TEXT NOT NULL,
  period             TEXT NOT NULL,
  status             TEXT NOT NULL,
  current_period_end INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);

-- Aynı webhook'un iki kez işlenmesini engeller.
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Eski veritabanlarına sonradan eklenen sütunları ekler.
function migrate(db) {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const checkouts = columns('checkouts');
  if (!checkouts.has('provider_ref')) db.exec('ALTER TABLE checkouts ADD COLUMN provider_ref TEXT');
  if (!checkouts.has('last_checked_at')) db.exec('ALTER TABLE checkouts ADD COLUMN last_checked_at INTEGER');
  if (!checkouts.has('terms_accepted_at')) db.exec('ALTER TABLE checkouts ADD COLUMN terms_accepted_at INTEGER');
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Gizlilik politikasında söz verilen saklama sürelerini uygular. Sunucu açılışında ve periyodik olarak çalışır.
export function cleanup(db, now = Date.now(), { usageDays = 30 } = {}) {
  const cutoffDay = new Date(now - usageDays * 86400_000).toISOString().slice(0, 10);
  return {
    usage: Number(db.prepare('DELETE FROM usage WHERE day < ?').run(cutoffDay).changes),
    sessions: Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes),
    webhookEvents: Number(db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(now - 90 * 86400_000).changes),
    // Tamamlanmamış ödeme denemeleri (iyzico form HTML'i dahil) 30 gün sonra silinir.
    checkouts: Number(db.prepare("DELETE FROM checkouts WHERE status != 'completed' AND created_at < ?").run(now - 30 * 86400_000).changes),
  };
}
