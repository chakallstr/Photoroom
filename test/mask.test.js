import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeIslands, sharpenAlpha } from '../public/assets/mask.js';

function image(w, h, fill = 0) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = fill;
  return rgba;
}
const setA = (rgba, w, x, y, a) => { rgba[(y * w + x) * 4 + 3] = a; };
const getA = (rgba, w, x, y) => rgba[(y * w + x) * 4 + 3];
function rect(rgba, w, x0, y0, x1, y1, a = 255) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setA(rgba, w, x, y, a);
}

test('sis temizliği: zayıf alfa sıfırlanır, güçlü alfa tam opak olur, ara değerler yumuşak kalır', () => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 20, 0, 0, 0, 230, 0, 0, 0, 115, 0, 0, 0, 0]);
  sharpenAlpha(rgba);
  assert.equal(rgba[3], 0);
  assert.equal(rgba[7], 255);
  assert.ok(rgba[11] > 100 && rgba[11] < 155, `ara değer ${rgba[11]}`);
  assert.equal(rgba[15], 0);
});

test('kopuk küçük parçalar silinir, ana ürün ve büyük ikinci ürün korunur', () => {
  const w = 100, h = 100;
  const rgba = image(w, h);
  rect(rgba, w, 10, 10, 49, 49);      // ana ürün: 1600 px
  rect(rgba, w, 60, 60, 79, 79);      // ikinci ürün: 400 px (korunmalı)
  rect(rgba, w, 90, 5, 92, 7);        // kırıntı: 9 px (silinmeli)
  setA(rgba, w, 95, 95, 90);           // zayıf, yalnız piksel (silinmeli)
  setA(rgba, w, 50, 30, 90);           // ana ürüne yapışık yumuşak kenar (korunmalı)
  removeIslands(rgba, w, h);
  assert.equal(getA(rgba, w, 30, 30), 255);
  assert.equal(getA(rgba, w, 70, 70), 255);
  assert.equal(getA(rgba, w, 91, 6), 0);
  assert.equal(getA(rgba, w, 95, 95), 0);
  assert.equal(getA(rgba, w, 50, 30), 90);
});

test('tek parçalı ve boş maskeye dokunulmaz', () => {
  const w = 20, h = 20;
  const one = image(w, h);
  rect(one, w, 2, 2, 5, 5);
  const before = one.slice();
  removeIslands(one, w, h);
  assert.deepEqual(one, before);
  const empty = image(w, h);
  removeIslands(empty, w, h);
  assert.ok(empty.every((v, i) => i % 4 !== 3 || v === 0));
});

test('büyük görselde makul sürede çalışır (4 MP)', () => {
  const w = 2000, h = 2000;
  const rgba = image(w, h);
  rect(rgba, w, 300, 300, 1700, 1700);
  for (let i = 0; i < 200; i++) setA(rgba, w, (i * 37) % w, 50 + ((i * 11) % 200), 255);
  const t0 = performance.now();
  removeIslands(rgba, w, h);
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
});
