import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeRegions, gradientDef } from '../public/assets/gradients.js';
import { initVectorizer, validateSvg, vectorizePixels, regionTones } from '../public/assets/vector.js';

before(async () => {
  await initVectorizer(fs.readFileSync(new URL('../public/assets/vendor/vtracer/vtracer_bg.wasm', import.meta.url)));
});

// Deterministik gürültü (JPEG kırıntısı taklidi)
function noise(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) >>> 0; return (s / 4294967296 - 0.5) * 4; }; }

// Görsel: 120×120; sol yarı soldan sağa koyu maviden açık maviye doğrusal geçiş, sağ yarı düz kırmızı,
// aralarında 4 piksel siyah çizgi; köşede saydam alan.
function sample() {
  const w = 120, h = 120, rgba = new Uint8Array(w * h * 4), rnd = noise(7);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x < 10 && y < 10) continue; // saydam
    let c;
    if (x < 58) c = [20 + rnd(), 40 + x * 2 + rnd(), 120 + x + rnd()];
    else if (x < 62) c = [10, 10, 10];
    else c = [200 + rnd(), 30 + rnd(), 30 + rnd()];
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
  }
  return { rgba, w, h };
}

test('doğrusal geçişli bölge gradyan olarak bulunur, düz bölge düz kalır', () => {
  const { rgba, w, h } = sample();
  const an = analyzeRegions(rgba, w, h);
  assert.equal(an.gradients.length, 1, 'tek gradyan bölgesi');
  const g = an.gradients[0];
  assert.equal(g.fill.kind, 'linear');
  assert.ok(g.rms < 4, `rms ${g.rms}`);
  assert.ok(g.explained > 0.95, `açıklanan ${g.explained}`);
  // Yön soldan sağa: x1 < x2, y1 ≈ y2
  assert.ok(g.fill.x2 - g.fill.x1 > 40, 'gradyan yatay uzanmalı');
  assert.ok(Math.abs(g.fill.y2 - g.fill.y1) < 5, 'gradyan dikey eğilmemeli');
  // Uçlardaki durak renkleri kaynağa yakın (sol: ~[20,40,120], sağ: ~[20,154,177])
  const first = g.fill.stops[0].color, last = g.fill.stops.at(-1).color;
  assert.ok(Math.abs(first[1] - 40) < 10 && Math.abs(last[1] - 154) < 10, `durak renkleri ${first} → ${last}`);
  assert.ok(an.flats.length >= 1, 'kırmızı alan düz bölge');
  assert.ok(an.flats.every((f) => !f.pixels.some((p) => p % w < 58)), 'düz bölge gradyan alanına taşmamalı');
});

test('büyütülmüş görselde kenar rampası bölgeleri birleştirmez (ölçek duyarlı kenar)', () => {
  // 2 renkli görsel 4× büyütülmüş gibi: aralarında 4 piksellik yumuşak rampa
  const w = 160, h = 40, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const t = Math.min(1, Math.max(0, (x - 78) / 4)); // 78..82 arası rampa
    rgba[i] = 60 + 20 * t; rgba[i + 1] = 60 + 20 * t; rgba[i + 2] = 200 - 100 * t; rgba[i + 3] = 255;
  }
  const an = analyzeRegions(rgba, w, h, { scale: 4, minArea: 100 });
  assert.equal(an.gradients.length, 0);
  assert.equal(an.flats.length, 2, 'iki ayrı düz bölge');
  const sides = an.flats.map((f) => (f.pixels[0] % w < 80 ? 'sol' : 'sağ')).sort();
  assert.deepEqual(sides, ['sağ', 'sol']);
});

test('tamamen saydam ya da çok küçük görselde bölge yok', () => {
  assert.deepEqual(analyzeRegions(new Uint8Array(4 * 4 * 4), 4, 4), { gradients: [], flats: [] });
  const rgba = new Uint8Array(20 * 20 * 4).fill(255);
  assert.equal(analyzeRegions(rgba, 20, 20).gradients.length, 0);
});

test('bölge tonları: düz bölge tek ton, iki tonlu bölge iki ton', () => {
  const w = 60, h = 20, rgba = new Uint8Array(w * h * 4);
  const px = [];
  for (let p = 0; p < w * h; p++) { const x = p % w; const v = x < 30 ? 200 : 120; rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; px.push(p); }
  assert.equal(regionTones(rgba, Uint32Array.from(px)).length, 2);
  assert.equal(regionTones(rgba, Uint32Array.from(px.filter((p) => p % w < 30))).length, 1);
});

test('gradyanlı vektör çıktısı doğrulanır ve gradyan içerir', () => {
  const { rgba, w, h } = sample();
  const r = vectorizePixels(rgba, w, h, { preset: 'cizim' });
  assert.equal(r.stats.gradients, 1, 'bir gradyan yolu');
  assert.match(r.svg, /<defs><linearGradient id="g1" gradientUnits="userSpaceOnUse"/);
  assert.match(r.svg, /fill="url\(#g1\)"/);
  assert.ok(r.warnings.some((t) => /gradyan/.test(t)), 'kesim uyarısı');
  assert.equal(validateSvg(r.svg).ok, true);
  // regions kapalıyken gradyan yok
  const flat = vectorizePixels(rgba, w, h, { preset: 'cizim', regions: false });
  assert.equal(flat.stats.gradients, 0);
});

const G = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="10" height="10" viewBox="0 0 10 10">\n'
  + '<defs><linearGradient id="g1" gradientUnits="userSpaceOnUse" x1="1" y1="1" x2="9" y2="1"><stop offset="0" stop-color="#FF0000"/><stop offset="1" stop-color="#0000FF"/></linearGradient>'
  + '<radialGradient id="g2" gradientUnits="userSpaceOnUse" cx="5" cy="5" r="4"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#888888"/><stop offset="1" stop-color="#000000"/></radialGradient></defs>\n'
  + '<path d="M1 1 L9 1 L9 9 Z" fill="url(#g1)"/>\n<path d="M1 1 L9 9 L1 9 Z" fill="url(#g2)"/>\n</svg>\n';

test('gradyanlı geçerli SVG kabul edilir', () => {
  const r = validateSvg(G);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.gradients, 2);
  assert.equal(r.stats.paths, 2);
});

test('hatalı gradyan kullanımı reddedilir', () => {
  const cases = {
    'tanımsız gradyan': G.replace('url(#g2)', 'url(#g9)'),
    'kullanılmayan tanım': G.replace('url(#g2)', '#00FF00'),
    'defs içinde path': G.replace('</defs>', '<path d="M1 1 L2 2 L1 2 Z" fill="#000000"/></defs>'),
    'defs dışında gradyan': G.replace('<defs>', '').replace('</defs>', '').replace('<path d="M1 1 L9 1', '<defs></defs><path d="M1 1 L9 1'),
    'durak sırası bozuk': G.replace('offset="0.5"', '0.9'.replace('0.9', 'offset="0.9"')).replace('offset="1" stop-color="#000000"', 'offset="0.7" stop-color="#000000"'),
    'ilk durak 0 değil': G.replace('offset="0" stop-color="#FF0000"', 'offset="0.2" stop-color="#FF0000"'),
    'tek durak': G.replace('<stop offset="1" stop-color="#0000FF"/>', ''),
    'nokta görsel dışında': G.replace('x2="9"', 'x2="900"'),
    'yarıçap geçersiz': G.replace('r="4"', 'r="-1"'),
    'gradientUnits yanlış': G.replace('gradientUnits="userSpaceOnUse" x1', 'gradientUnits="objectBoundingBox" x1'),
    'yabancı öznitelik': G.replace('<linearGradient id="g1"', '<linearGradient id="g1" gradientTransform="rotate(45)"'),
    'geçersiz kimlik': G.replaceAll('g1', 'x1'),
    'yinelenen kimlik': G.replace('id="g2"', 'id="g1"').replace('url(#g2)', 'url(#g1)'),
    'geçersiz durak rengi': G.replace('stop-color="#888888"', 'stop-color="red"'),
    'ikinci defs': G.replace('\n<path d="M1 1 L9 9', '<defs></defs>\n<path d="M1 1 L9 9'),
    'url ile fill-opacity dışı öznitelik': G.replace('fill="url(#g1)"', 'fill="url(#g1)" stroke="#000"'),
  };
  for (const [name, svg] of Object.entries(cases)) assert.equal(validateSvg(svg).ok, false, `${name} reddedilmeli`);
});

test('gradientDef sayıları yuvarlar ve eksi sıfır üretmez', () => {
  const d = gradientDef('g1', { kind: 'linear', x1: -0.0001, y1: 2.345678, x2: 10, y2: 0, stops: [{ offset: 0, color: [1, 2, 3] }, { offset: 1, color: [255, 255, 255] }] });
  assert.equal(d, '<linearGradient id="g1" gradientUnits="userSpaceOnUse" x1="0" y1="2.35" x2="10" y2="0"><stop offset="0" stop-color="#010203"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>');
});

test('bant dolgusu uydurma: doğrusal geçişe gradyan, düz alana düz renk, uçlar görsel içinde', async () => {
  const { fitLabelFills, encodeLabel, decodeLabel } = await import('../public/assets/vector.js');
  const w = 60, h = 20, rgba = new Uint8Array(w * h * 4), labels = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4;
    if (x < 30) { rgba[i] = 40 + x * 5; rgba[i + 1] = 80; rgba[i + 2] = 200 - x * 3; labels[p] = 0; } // soldan sağa geçiş
    else { rgba[i] = 200; rgba[i + 1] = 30; rgba[i + 2] = 30; labels[p] = 1; } // düz kırmızı
    rgba[i + 3] = 255;
  }
  const fills = fitLabelFills(rgba, labels, 2, w, h);
  assert.equal(fills[0].kind, 'linear');
  assert.ok(fills[0].x1 >= 0 && fills[0].x2 <= w && fills[0].y1 >= 0 && fills[0].y2 <= h, 'uçlar görsel içinde');
  assert.ok(fills[0].x2 > fills[0].x1, 'yön soldan sağa');
  assert.ok(Math.abs(fills[0].stops[0].color[0] - 40) < 8 && Math.abs(fills[0].stops[1].color[0] - 185) < 8, `uç renkleri ${fills[0].stops.map((s) => s.color)}`);
  assert.equal(fills[1].kind, 'flat');
  assert.deepEqual(fills[1].color, [200, 30, 30]);
  for (const l of [0, 1, 31, 32, 1023, 5000]) assert.equal(decodeLabel('#' + encodeLabel(l).map((v) => v.toString(16).padStart(2, '0')).join('')), l);
});

test('bant gradyanı (deneysel) çıktısı doğrulanır', async () => {
  const { BAND_GRADIENT_OVERRIDES } = await import('../public/assets/vector.js');
  const { rgba, w, h } = sample();
  const r = vectorizePixels(rgba, w, h, { preset: 'cizim', ...BAND_GRADIENT_OVERRIDES });
  assert.equal(validateSvg(r.svg).ok, true);
  assert.ok(r.stats.gradients >= 1);
});
