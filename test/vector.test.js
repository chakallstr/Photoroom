import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyPalette, findPalette, initVectorizer, otsuThreshold, parsePathData, planScale, validateSvg, vectorizeExact, vectorizePixels, verifyExact,
} from '../public/assets/vector.js';

before(async () => {
  await initVectorizer(fs.readFileSync(new URL('../public/assets/vendor/vtracer/vtracer_bg.wasm', import.meta.url)));
});

const VALID = '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="10" height="10" viewBox="0 0 10 10">\n<path d="M1 1 L9 1 L9 9 Z" fill="#FF0000"/>\n</svg>\n';

// ---------- Doğrulayıcı: bozuk SVG'leri yakalıyor mu? ----------

test('geçerli SVG kabul edilir', () => {
  const r = validateSvg(VALID);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.paths, 1);
});

test('saf vektör olmayan ya da hatalı SVG reddedilir', () => {
  const cases = {
    'gömülü resim': VALID.replace('<path', '<image href="data:image/png;base64,AAAA"/><path'),
    'betik': VALID.replace('<path', '<script>alert(1)</script><path'),
    'olay özniteliği': VALID.replace('<path d=', '<path onload="x()" d='),
    'viewBox yok': VALID.replace(' viewBox="0 0 10 10"', ''),
    'transform': VALID.replace('fill=', 'transform="translate(1,1)" fill='),
    'NaN': VALID.replace('L9 1', 'L9 NaN'),
    'kapanmamış yol': VALID.replace(' Z"', '"'),
    'görsel dışında nokta': VALID.replace('L9 9', 'L900 9'),
    'geçersiz renk': VALID.replace('#FF0000', 'url(#g)'),
    'izin verilmeyen öğe': VALID.replace('<path', '<g><path').replace('</svg>', '</g></svg>'),
    'M ile başlamıyor': VALID.replace('M1 1 ', ''),
    'bilinmeyen komut': VALID.replace('L9 1', 'X9 1'),
    'eksik sayı': VALID.replace('L9 1', 'L9'),
    'DOCTYPE': '<!DOCTYPE svg [<!ENTITY x "y">]>' + VALID,
    'metin içeriği': VALID.replace('<path', 'merhaba<path'),
    'oran uyuşmazlığı': VALID.replace('width="10"', 'width="40"'),
    'bilinmeyen kök özniteliği': VALID.replace('version="1.1"', 'style="x"'),
    'bilinmeyen path özniteliği': VALID.replace('fill=', 'stroke="#000" fill='),
    'geçersiz fill-opacity': VALID.replace('fill=', 'fill-opacity="2" fill='),
    'farklı shape-rendering': VALID.replace('version="1.1"', 'shape-rendering="auto"'),
  };
  for (const [name, svg] of Object.entries(cases)) {
    assert.equal(validateSvg(svg).ok, false, `${name} yakalanmalıydı`);
  }
});

test('yol ayrıştırıcı standart sözdizimini tanır (örtük komutlar, üslü ve bitişik sayılar, yaylar)', () => {
  const sp = parsePathData('M0.5.5 10,10 l-1e1-2.5E+0z m1 1h2v2H1V1zM0 0C1 1 2 2 3 3s1 1 2 2Q1 1 2 2t3 3A5 5 0 0 1 9 9Z');
  assert.equal(sp.length, 3);
  assert.ok(sp.every((s) => s.closed));
  assert.deepEqual(sp[0].points, [[0.5, 0.5], [10, 10], [0, 7.5]]);
  assert.deepEqual(sp[1].points.at(-1), [1, 1]);
  assert.throws(() => parsePathData('M0 0 A5 5 0 2 1 9 9Z'), /bayrak/);
});

// ---------- Uçtan uca: gerçek motor her türde görselde geçerli SVG üretiyor mu? ----------

function draw(w, h, fn) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x, y), (y * w + x) * 4);
  return px;
}
const WHITE = [255, 255, 255, 255], RED = [230, 57, 70, 255], NAVY = [29, 53, 87, 255], NONE = [0, 0, 0, 0];

const IMAGES = {
  daire: [120, 120, (x, y) => ((x - 60) ** 2 + (y - 60) ** 2 < 40 ** 2 ? RED : WHITE)],
  'delikli halka': [120, 120, (x, y) => { const r = (x - 60) ** 2 + (y - 60) ** 2; return r < 45 ** 2 && r > 20 ** 2 ? NAVY : WHITE; }],
  'iki renkli logo': [240, 100, (x, y) => ((x - 50) ** 2 + (y - 50) ** 2 < 35 ** 2 ? RED : x > 100 && x < 220 && (y % 30) < 18 && y > 20 && y < 80 ? NAVY : WHITE)],
  'saydam zeminde ürün': [150, 100, (x, y) => (Math.abs(x - 75) + Math.abs(y - 50) < 35 ? RED : NONE)],
  gradyan: [64, 64, (x, y) => [x * 4, y * 4, 128, 255]],
  'tamamen saydam': [50, 50, () => NONE],
  'tek piksel': [1, 1, () => RED],
  'ince çizgiler': [100, 100, (x, y) => (x % 10 === 0 || y % 10 === 0 ? NAVY : WHITE)],
};

for (const preset of ['logo', 'cizim', 'detayli', 'siyahBeyaz']) {
  for (const cutout of [false, true]) {
    test(`${preset}${cutout ? ' (kesim katmanı)' : ''}: her görsel türünde geçerli, saf vektör SVG`, () => {
      for (const [name, [w, h, fn]] of Object.entries(IMAGES)) {
        const { svg, stats } = vectorizePixels(draw(w, h, fn), w, h, { preset, cutout });
        const check = validateSvg(svg);
        assert.deepEqual(check.errors, [], `${name}: ${check.errors.join('; ')}`);
        assert.match(svg, new RegExp(`viewBox="0 0 ${w} ${h}"`), name);
        assert.ok(stats.bytes < 200_000, `${name}: ${stats.bytes} bayt`);
      }
    });
  }
}

test('kesim katmanında delik gerçek bir delik olarak yolda bulunur (Cricut/lazer için şart)', () => {
  const [w, h, fn] = IMAGES['delikli halka'];
  const navyPaths = (svg) => [...svg.matchAll(/<path d="([^"]+)" fill="#1D3557"/g)].map((m) => parsePathData(m[1]));
  // Kesim katmanı: lacivert şeklin içinde delik var (dış kenar + delik = 2 alt yol).
  const cut = navyPaths(vectorizePixels(draw(w, h, fn), w, h, { preset: 'logo', cutout: true }).svg);
  assert.equal(cut.length, 1);
  assert.equal(cut[0].length, 2, 'dış kenar + delik');
  // Üst üste katman: delik, üstüne çizilen beyaz şekille gösterilir (ekranda aynı görünür, kesimde uygun değil).
  const stacked = navyPaths(vectorizePixels(draw(w, h, fn), w, h, { preset: 'logo' }).svg);
  assert.equal(stacked[0].length, 1);
});

test('saydam zemin vektöre girmez; tamamen saydam görsel boş ama geçerli SVG verir', () => {
  const [w, h, fn] = IMAGES['saydam zeminde ürün'];
  const { svg } = vectorizePixels(draw(w, h, fn), w, h, { preset: 'logo' });
  assert.equal((svg.match(/<path/g) || []).length, 1, 'yalnızca ürün');
  const empty = vectorizePixels(new Uint8Array(40 * 40 * 4), 40, 40, { preset: 'logo' });
  assert.equal(empty.stats.paths, 0);
});

test('büyütülerek çevrilen görsel, istenen boyutta ve aynı viewBox ile verilir', () => {
  const [w, h, fn] = IMAGES.daire;
  const { svg } = vectorizePixels(draw(w, h, fn), w, h, { preset: 'logo', outWidth: 40, outHeight: 40 });
  assert.match(svg, /width="40" height="40" viewBox="0 0 120 120"/);
});

test('çevirme ölçeği: küçükler büyütülür, büyükler küçültülür, toplam 4 MP\'yi geçmez', () => {
  assert.equal(planScale(224, 224).scale, 3);
  assert.equal(planScale(1000, 800).scale, 1);
  const big = planScale(6000, 4000);
  assert.ok(big.width * big.height <= 4_000_000 && big.scale < 1);
  const thin = planScale(3000, 100); // ince uzun görsel: büyütme sınırla kısılır
  assert.ok(thin.width * thin.height <= 4_000_000);
});

// Bulanık kenarlı kırmızı daire: kenarda kırmızı→beyaz geçiş tonları var (JPEG/bulanıklık benzetimi).
function blurredCircle(w = 160, h = 160, r = 50) {
  return draw(w, h, (x, y) => {
    const d = Math.hypot(x - w / 2, y - h / 2);
    const t = Math.min(1, Math.max(0, (d - (r - 6)) / 12)); // 12 px'lik yumuşak geçiş
    return [Math.round(230 + 25 * t), Math.round(57 + 198 * t), Math.round(70 + 185 * t), 255];
  });
}

test('palet çıkarma geçiş tonlarını atar: bulanık kenarlı daire 2 renge iner', () => {
  const px = blurredCircle();
  const flat = applyPalette(px, findPalette(px, { maxColors: 8 }), 160, 160);
  const colors = new Set();
  for (let i = 0; i < flat.length; i += 4) colors.add(`${flat[i]},${flat[i + 1]},${flat[i + 2]}`);
  assert.equal(colors.size, 2, [...colors].join(' | '));
});

test('palet çıkarma ince ama gerçek renkleri korur (koyu dış çizgi)', () => {
  // Sarı dolgu, beyaz zemin ve aralarında 3 px'lik koyu kahverengi çizgi: kahverengi sarı-beyaz arasında değil.
  const px = draw(160, 160, (x, y) => {
    const d = Math.hypot(x - 80, y - 80);
    return d < 47 ? [240, 205, 50, 255] : d < 50 ? [90, 60, 20, 255] : WHITE;
  });
  const flat = applyPalette(px, findPalette(px, { maxColors: 8 }), 160, 160);
  const i = (80 * 160 + 80 + 48) * 4; // çizginin üstündeki piksel
  assert.deepEqual([flat[i], flat[i + 1], flat[i + 2]], [90, 60, 20]);
});

test('logo ayarında bulanık kenar halkası oluşmaz', () => {
  const { svg } = vectorizePixels(blurredCircle(), 160, 160, { preset: 'logo' });
  assert.equal(validateSvg(svg).stats.colors, 2, svg.slice(0, 400));
});

test('kayıpsız mod: her görsel türünde geçerli SVG, yalnızca tam sayı koordinat ve H/V kenarları', () => {
  for (const [name, [w, h, fn]] of Object.entries(IMAGES)) {
    const { svg } = vectorizeExact(draw(w, h, fn), w, h);
    assert.deepEqual(validateSvg(svg).errors, [], name);
    assert.match(svg, /shape-rendering="crispEdges"/);
    for (const m of svg.matchAll(/ d="([^"]+)"/g)) assert.match(m[1], /^(M\d+ \d+([HV]\d+)+Z)+$/, `${name}: ${m[1].slice(0, 60)}`);
  }
});

test('kayıpsız mod: yarı saydam ve rastgele görsellerde her çıktı piksel piksel doğrulanır', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let n = 0; n < 300; n++) {
    const w = 1 + Math.floor(rnd() * 30), h = 1 + Math.floor(rnd() * 30);
    const pal = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => [rnd() * 256, rnd() * 256, rnd() * 256, [0, 255, 255, Math.floor(1 + rnd() * 254)][Math.floor(rnd() * 4)]].map(Math.floor));
    const px = draw(w, h, () => pal[Math.floor(rnd() * pal.length)]);
    const { svg } = vectorizeExact(px, w, h); // içeride verifyExact çalışır; fark olsa hata fırlatırdı
    assert.equal(verifyExact(svg, px, w, h), null);
  }
});

test('kayıpsız doğrulama tek piksellik bozulmayı da yakalar', () => {
  const [w, h, fn] = IMAGES['iki renkli logo'];
  const px = draw(w, h, fn);
  const { svg } = vectorizeExact(px, w, h);
  // Kırmızı dairenin bir koordinatını 1 piksel kaydır: doğrulama yakalamalı.
  const broken = svg.replace(/(<path d="[^"]*?)H(\d+)([^"]*" fill="#E63946")/, (_, a, v, b) => `${a}H${Number(v) + 1}${b}`);
  assert.notEqual(broken, svg);
  assert.match(verifyExact(broken, px, w, h) ?? '', /piksel/);
  // Görselin dışına taşan köşe de hata sayılır.
  const outside = svg.replace(/H240/, 'H241');
  assert.notEqual(outside, svg);
  assert.match(verifyExact(outside, px, w, h) ?? '', /dışında/);
  // Kaynakta tek pikselin rengini değiştir: doğrulama yakalamalı.
  const changed = px.slice();
  changed[(50 * w + 50) * 4] ^= 1;
  assert.match(verifyExact(svg, changed, w, h) ?? '', /piksel \(50, 50\)/);
});

test('çoğunluk filtresi tek piksellik gürültüyü siler, büyük bölgeyi korur', async () => {
  const { modeFilter } = await import('../public/assets/vector.js');
  const w = 9, h = 9, idx = new Uint8Array(w * h);           // hepsi renk 0
  idx[4 * w + 4] = 1;                                         // ortada tek piksellik gürültü
  for (let y = 0; y < h; y++) for (let x = 6; x < w; x++) idx[y * w + x] = 2; // sağda geniş şerit
  const out = modeFilter(idx, w, h, 1, 3);
  assert.equal(out[4 * w + 4], 0, 'gürültü silinmeli');
  assert.equal(out[4 * w + 8], 2, 'şerit korunmalı');
});

test('Otsu eşiği iki tonlu görselde tonların arasına düşer', () => {
  const gray = new Uint8Array(1000).map((_, i) => (i < 600 ? 30 : 220));
  const t = otsuThreshold(gray);
  assert.ok(t >= 30 && t < 220, `eşik ${t}`);
});

test('hatalı girdi anlaşılır hata verir, çökmez', () => {
  assert.throws(() => vectorizePixels(new Uint8Array(10), 2, 2), /uyuşmuyor/);
});

test('renk seviyesi azaltma ve azaltılmış kayıpsız izleme', async () => {
  const { posterize } = await import('../public/assets/vector.js');
  const rgba = new Uint8Array([0, 7, 8, 255, 255, 128, 129, 255, 10, 20, 30, 0]);
  const q = posterize(rgba, 5); // adım 8, seviye ortası +4
  assert.deepEqual([...q], [4, 4, 12, 255, 252, 132, 132, 255, 0, 0, 0, 0]);
  // Yumuşak geçişli görsel: 5 bit ile kayıpsız izleme doğrulanır, uyarı verir
  const w = 24, h = 24, img = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { img[p * 4] = (p % w) * 10; img[p * 4 + 1] = 100; img[p * 4 + 2] = Math.floor(p / w) * 10; img[p * 4 + 3] = 255; }
  const r = vectorizeExact(img, w, h, { colorBits: 5 });
  assert.equal(validateSvg(r.svg).ok, true);
  assert.match(r.warnings[0], /32 seviye/);
  assert.equal(verifyExact(r.svg, posterize(img, 5), w, h), null);
});
