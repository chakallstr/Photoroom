import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;

export const SESSION_COOKIE = 'pr_session';
export const ANON_COOKIE = 'pr_anon';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(key, expected);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + SESSION_DAYS * 86400_000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expiresAt);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function userFromSession(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { id: row.id, email: row.email };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

// Basit, bellekte tutulan deneme sınırlayıcı (kaba kuvvet girişlerini yavaşlatmak için).
export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        if (hits.size > 10000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
        return true;
      }
      entry.count++;
      return entry.count <= max;
    },
  };
}
