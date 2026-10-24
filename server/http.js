import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Aynı alan adındaki başka bir uygulamanın bozuk çerezi isteği düşürmemeli.
    }
  }
  return out;
}

export function cookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'İstek çok büyük.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const type = req.headers['content-type'] || '';
  // Yalnızca JSON kabul etmek, başka sitelerden gönderilen formlarla yapılan CSRF'i engeller.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'json_required', 'İstek JSON olmalı.');
  const raw = await readBody(req);
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'bad_json', 'Geçersiz JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_json', 'İstek bir JSON nesnesi olmalı.');
  return data;
}

// Kotada aynı kişiyi tek IP saymak için: IPv6 adresleri /64 bloğuna indirgenir
// (bir ev ya da cihaz genelde koca bir /64 alır).
export function ipBucket(ip) {
  const addr = String(ip).replace(/^::ffff:(?=\d+\.)/, '');
  if (!addr.includes(':')) return addr;
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function serveStatic(req, res, dir) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return false;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(dir, pathname);
  if (!file.startsWith(dir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
