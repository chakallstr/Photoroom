import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFF, SCALE, checkInput, fillTransparent, placeTile, planTiles, tileTensor, upscaleAlpha } from '../public/assets/upscale.js';

test('döşeme planı görseli tam kaplar, taşmaz', () => {
  const tiles = planTiles(300, 130, 128);
  assert.equal(tiles.length, 3 * 2);
  const covered = new Set();
  for (const t of tiles) for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) covered.add(y * 300 + x);
  assert.equal(covered.size, 300 * 130);
  assert.ok(tiles.every((t) => t.x + t.w <= 300 && t.y + t.h <= 130));
});

test('döşeme tensörü: boyutlar 4\'ün katı, kenarlar yansımalı, ortası görselin aynısı', () => {
  const w = 10, h = 6, rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { rgba[p * 4] = p % w * 20; rgba[p * 4 + 1] = Math.floor(p / w) * 40; rgba[p * 4 + 2] = 7; rgba[p * 4 + 3] = 255; }
  const t = { x: 0, y: 0, w, h };
  const { data, dims } = tileTensor(rgba, w, h, t);
  const [, c, H, W] = dims;
  assert.equal(c, 3); assert.equal(H % 4, 0); assert.equal(W % 4, 0);
  assert.ok(H >= h + 2 * OFF && W >= w + 2 * OFF);
  // (OFF+3, OFF+2) → kaynak (3,2)
  assert.ok(Math.abs(data[(OFF + 2) * W + OFF + 3] - 60 / 255) < 1e-6);
  assert.ok(Math.abs(data[H * W + (OFF + 2) * W + OFF + 3] - 80 / 255) < 1e-6);
  // sol dolgu yansıma: x=OFF-1 → kaynak x=1
  assert.ok(Math.abs(data[(OFF + 2) * W + OFF - 1] - 20 / 255) < 1e-6);
});

test('çıktı döşemesi kenar payı düşülerek doğru yere yazılır', () => {
  const t = { x: 2, y: 1, w: 3, h: 2 };
  const OW = (t.w + 2 * OFF) * SCALE, OH = (t.h + 2 * OFF) * SCALE; // model çıktısı: 4·(w+2·OFF) − 64 değil, test için pay 4·OFF−32 varsayımı yeterli
  const m = SCALE * OFF - 32;
  const y = new Float32Array(3 * OH * OW).fill(0.25);
  // (m, m) noktasına özel değer: çıktıda (t.x·4, t.y·4) konumuna gelmeli
  y[m * OW + m] = 1;
  const Wt = 40 * SCALE, Ht = 20 * SCALE, out = new Uint8ClampedArray(Wt * Ht * 4);
  placeTile(out, Wt, y, [1, 3, OH, OW], t);
  const dst = ((t.y * SCALE) * Wt + t.x * SCALE) * 4;
  assert.equal(out[dst], 255); assert.equal(out[dst + 1], 64); assert.equal(out[dst + 3], 255);
  // Döşeme dışı dokunulmamış
  assert.equal(out[((t.y * SCALE + t.h * SCALE) * Wt + t.x * SCALE) * 4 + 3], 0);
});

test('saydam pikseller komşu renkle dolar, alfa değişmez', () => {
  const w = 4, h = 1, rgba = new Uint8Array([200, 10, 10, 255, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10, 200, 255]);
  const f = fillTransparent(rgba, w, h);
  assert.deepEqual([...f.slice(4, 7)], [200, 10, 10]);
  assert.deepEqual([...f.slice(8, 11)], [10, 10, 200]);
  assert.equal(f[7], 0); assert.equal(f[11], 0);
  assert.deepEqual([...fillTransparent(new Uint8Array(8), 2, 1)], [0, 0, 0, 0, 0, 0, 0, 0], 'tamamen saydam görsel aynen kalır');
});

test('alfa çift doğrusal büyütülür: opak içte 255, dışta 0, kenarda ara değer', () => {
  const w = 4, h = 4, rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) rgba[p * 4 + 3] = p % w < 2 ? 255 : 0;
  const out = new Uint8ClampedArray(w * h * SCALE * SCALE * 4);
  upscaleAlpha(rgba, w, h, out);
  const W = w * SCALE;
  assert.equal(out[(5 * W + 2) * 4 + 3], 255);
  assert.equal(out[(5 * W + 13) * 4 + 3], 0);
  const mid = out[(5 * W + 7) * 4 + 3];
  assert.ok(mid > 0 && mid < 255, `kenar ara değer olmalı: ${mid}`);
});

test('çok büyük girdi anlaşılır hata verir', () => {
  assert.equal(checkInput(500, 500), null);
  assert.match(checkInput(2000, 2000), /çok büyük/);
  assert.match(checkInput(0, 5), /boş/);
});
