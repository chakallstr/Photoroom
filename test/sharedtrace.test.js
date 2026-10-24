import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { traceShared, simplify, loopsToPath } from '../public/assets/sharedtrace.js';
import { initVectorizer, mergeSpecks, parsePathData, validateSvg, vectorizeClean } from '../public/assets/vector.js';

before(async () => {
  await initVectorizer(fs.readFileSync(new URL('../public/assets/vendor/vtracer/vtracer_bg.wasm', import.meta.url)));
});

// Kapalı çokgenin işaretli alanı (ayakkabı bağı formülü); bölge solda yönüyle çizilen halkalar için pozitif beklenir
// (y aşağı koordinatta "bölge solda" = ekranda saat yönü = formülde pozitif).
const area = (loop) => { let a = 0; for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
const totalArea = (loops) => { let s = 0; for (const lp of loops.values()) for (const l of lp) s += area(l); return s; };

// Etiket haritası: metin satırları, '.' saydam, harf = etiket
const grid = (rows) => { const h = rows.length, w = rows[0].length; const labels = new Int32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = rows[y][x] === '.' ? -1 : rows[y][x].charCodeAt(0) - 97; return { labels, w, h }; };

test('ortak kenarlı izleme: tek kare, halka alanı piksel sayısına eşit', () => {
  const { labels, w, h } = grid(['....', '.aa.', '.aa.', '....']);
  const loops = traceShared(labels, w, h, { tolerance: 0 });
  assert.equal(loops.size, 1);
  assert.equal(loops.get(0).length, 1);
  assert.equal(Math.abs(area(loops.get(0)[0])), 4);
});

test('delikli bölge: dış halka ve iç halka zıt yönlü, net alan piksel sayısı', () => {
  const { labels, w, h } = grid(['aaaaa', 'abbba', 'abcba', 'abbba', 'aaaaa']);
  const loops = traceShared(labels, w, h, { tolerance: 0 });
  const a = loops.get(0), b = loops.get(1), c = loops.get(2);
  assert.equal(a.length, 2); // dış sınır + delik
  assert.equal(b.length, 2);
  assert.equal(c.length, 1);
  const sum = (lp) => lp.reduce((s, l) => s + area(l), 0);
  const sa = sum(a), sb = sum(b), sc = sum(c);
  assert.equal(Math.abs(sa), 16); assert.equal(Math.abs(sb), 8); assert.equal(Math.abs(sc), 1);
  assert.ok(Math.sign(sa) === Math.sign(sb) && Math.sign(sb) === Math.sign(sc), 'tüm bölgeler aynı yönde');
});

test('çapraz değen pikseller ayrı halkalar olarak çıkar, toplam alan korunur', () => {
  const { labels, w, h } = grid(['ab', 'ba']);
  const loops = traceShared(labels, w, h, { tolerance: 0 });
  assert.equal(loops.get(0).length, 2);
  assert.equal(loops.get(1).length, 2);
  assert.equal(Math.abs(totalArea(loops)), 4);
});

test('sadeleştirmede komşu bölgeler aynı sınırı paylaşır: toplam alan değişmez (boşluk/bindirme yok)', () => {
  // Tamamen opak rastgele harita: iç sınırlar iki komşu tarafından zıt yönde kullanılır; sadeleştirme ikisinde de
  // aynı noktaları verirse işaretli alanların toplamı her toleransta tam olarak w·h kalır.
  let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const w = 40, h = 30, labels = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = Math.floor((x / 9 + y / 7 + rnd() * 0.8)) % 4;
  const exact = traceShared(labels, w, h, { tolerance: 0 });
  assert.equal(Math.abs(totalArea(exact)), w * h);
  let ptsExact = 0; for (const lp of exact.values()) for (const l of lp) ptsExact += l.length;
  for (const tol of [0.5, 1, 2, 4]) {
    const loops = traceShared(labels, w, h, { tolerance: tol });
    assert.ok(Math.abs(Math.abs(totalArea(loops)) - w * h) < 1e-6, `tolerans ${tol}: alan ${totalArea(loops)} ≠ ${w * h}`);
    let pts = 0; for (const lp of loops.values()) for (const l of lp) pts += l.length;
    assert.ok(pts < ptsExact, 'sadeleştirme nokta sayısını azaltmalı');
  }
  // Saydam kenarlı haritada yalnızca dış sınır (silüet) sadeleşir: sapma en çok çevre × tolerans
  const withAlpha = labels.slice(); let opaque = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (Math.hypot(x - 20, y - 15) > 14) withAlpha[y * w + x] = -1; else opaque++; }
  const loops = traceShared(withAlpha, w, h, { tolerance: 1 });
  assert.ok(Math.abs(Math.abs(totalArea(loops)) - opaque) < 2 * Math.PI * 14 * 1, 'silüet sapması çevre × tolerans sınırında');
});

test('zincir toleransı: düşük kontrastlı iç sınır gevşek, dış sınır sıkı', () => {
  const { labels, w, h } = grid(['aaab', 'aabb', 'abbb', 'bbbb']); // merdiven sınırı
  const tight = traceShared(labels, w, h, { tolerance: 0 });
  const loose = traceShared(labels, w, h, { chainTolerance: (l, r) => (l < 0 || r < 0 ? 0 : 5) });
  const count = (m) => { let n = 0; for (const lp of m.values()) for (const l of lp) n += l.length; return n; };
  assert.ok(count(loose) < count(tight));
  assert.equal(Math.abs(totalArea(loose)), 16); // iç sınır ortak: toplam alan korunur
  assert.equal(Math.abs(area(loose.get(0)[0])), 4.5); // merdiven köşegene indi: a üçgen oldu
});

test('Douglas–Peucker uç noktaları korur ve toleransı aşmaz', () => {
  const pts = []; for (let i = 0; i <= 20; i++) pts.push([i, Math.sin(i / 3) * 3]);
  const out = simplify(pts, 0.5);
  assert.deepEqual(out[0], pts[0]); assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  assert.ok(out.length < pts.length);
  // her orijinal nokta sadeleştirilmiş çizgiye 0,5'ten yakın
  for (const [x, y] of pts) {
    let best = Infinity;
    for (let k = 0; k + 1 < out.length; k++) { const [ax, ay] = out[k], [bx, by] = out[k + 1]; const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy)); }
    assert.ok(best <= 0.5 + 1e-9);
  }
});

test('loopsToPath: M/H/V/L/Z ile kapalı yollar, parsePathData okur', () => {
  const d = loopsToPath([[[0, 0], [4, 0], [4, 3], [2, 5], [0, 3]]]);
  assert.equal(d, 'M0 0H4V3L2 5L0 3Z');
  const sub = parsePathData(d);
  assert.equal(sub.length, 1); assert.ok(sub[0].closed);
});

test('mergeSpecks: küçük benek komşuya katılır, katılan parça hedefle birlikte taşınır', () => {
  const palette = [[50, 0, 0], [52, 0, 0], [90, 0, 0]]; // a≈b (ΔE 2), c uzak
  const { labels, w, h } = grid(['cccccc', 'ccbacc', 'cccccc']);
  // 'a' (1 px) en benzer komşusu b'ye katılır; sonra 'b' (artık 2 px) tek komşusu c'ye katılır → her şey c
  mergeSpecks(labels, w, h, palette, 3);
  assert.ok(labels.every((l) => l === 2), 'yetim benek kalmamalı');
});

test('mergeSpecks: similarArea yalnızca benzer renge katar', () => {
  const palette = [[50, 0, 0], [52, 0, 0], [90, 0, 0]];
  const { labels, w, h } = grid(['bbbbbbbb', 'bbaabbcc', 'bbaabbcc', 'bbbbbbbb']);
  mergeSpecks(labels, w, h, palette, 2, { similarArea: 10, similarDelta: 6 });
  assert.ok(!labels.includes(0), 'a (4 px, b ile ΔE 2) katılmalı');
  assert.ok(labels.includes(2), 'c (4 px, b ile ΔE 38) kalmalı');
});

test('vectorizeClean: geçerli SVG, renk başına bir yol, piksel ızgarası yok', () => {
  // 64×64: iki renkli daire + arka plan + şeffaf köşe
  const w = 64, h = 64, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x < 8 && y < 8) continue; // şeffaf
    const d = Math.hypot(x - 32, y - 32);
    const c = d < 12 ? [200, 30, 30] : d < 22 ? [30, 30, 200] : [240, 240, 240];
    rgba.set([...c, 255], i);
  }
  const r = vectorizeClean(rgba, w, h, { tolerance: 1, minArea: 4 });
  const check = validateSvg(r.svg);
  assert.deepEqual(check.errors, []);
  assert.equal(check.stats.paths, 3);
  assert.equal(check.stats.colors, 3);
  assert.ok(r.svg.includes('viewBox="0 0 64 64"'));
  assert.ok(!r.svg.includes('crispEdges'));
  // dairelerin sınırı köşegen parçalarla (L) sadeleştirilmiş, salt piksel basamağı değil
  assert.ok(/L\d/.test(r.svg));
  const out = vectorizeClean(rgba, w, h, { outWidth: 16, outHeight: 16 });
  assert.ok(out.svg.includes('width="16" height="16"'));
});

test('vectorizeClean: tamamen saydam görsel hata verir', () => {
  assert.throws(() => vectorizeClean(new Uint8Array(16 * 16 * 4), 16, 16), /opak piksel yok/);
});
