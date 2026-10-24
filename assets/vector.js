// Görselden vektöre (SVG) çevirme. VTracer (MIT) kaynaktan WASM'a derlenmiştir: tools/vtracer-wasm.
// Tarayıcıda ve Node'da (testler) çalışır. Her çıktı kullanıcıya verilmeden önce validateSvg ile denetlenir.
import { analyzeRegions, gradientDef, regionMask } from './gradients.js';

// Hazır ayarlar kullanıcı birimleriyle (derece, renk biti, piksel); iç birimlere VTracer kendisi çevirir.
// Logo ayarı ölçümle seçildi (4 logo/ikon, renk 5–7 bit × katman 8–32 × kırıntı 4–8): ortalama ΔE 1,96.
// Eski ayar (renk 4 bit, katman 48) renkleri fazla birleştiriyordu (bulanık logoda ΔE 22).
// paletteColors: çevirmeden önce baskın renk sayısı üst sınırı (geçiş tonları ayrıca temizlenir).
// Ölçüm: logolarda gerçek renk sayısına iner (test logoları 3 renk, 18 yol); bulanık kenar halkaları kaybolur.
// smooth: çoğunluk filtresi yarıçapı (orijinal görsel pikseli). Eğri ayarları 8 kat büyütmede göz kontrolüyle
// seçildi: köşe eşiği 90 dik çizgileri en düz tutuyor (30'da harf gövdeleri dalgalı eğriye dönüşüyor).
export const PRESETS = {
  logo: { binary: false, paletteColors: 8, regions: true, smooth: 0.67, colorPrecision: 7, filterSpeckle: 8, layerDifference: 8, cornerThreshold: 90, lengthThreshold: 10, spliceThreshold: 60 },
  cizim: { binary: false, paletteColors: 16, regions: true, smooth: 0.67, colorPrecision: 7, filterSpeckle: 4, layerDifference: 8, cornerThreshold: 90, lengthThreshold: 10, spliceThreshold: 60 },
  // Çok renkli, gölgeli çizimler için paletsiz: renk doğruluğu en yüksek, dosya daha büyük.
  detayli: { binary: false, colorPrecision: 6, filterSpeckle: 2, layerDifference: 24, cornerThreshold: 45, lengthThreshold: 3.5, spliceThreshold: 45 },
  siyahBeyaz: { binary: true, colorPrecision: 8, filterSpeckle: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, spliceThreshold: 45 },
};

// Çıktı sınırları: Cricut Design Space en fazla 5000 yol kabul eder; çok büyük dosyalar tarayıcıyı yorar.
export const LIMITS = { cuttingPaths: 5000, maxPaths: 60000, maxBytes: 15_000_000, maxPixels: 4_000_000, maxGradients: 24 };

// Çevirme ölçeği: kısa kenarı 600 px'ten küçük görseller (ince çizgiler korunsun diye) 4 kata kadar büyütülür,
// büyükler küçültülür; her durumda toplam piksel 4 MP'yi geçmez (visioncortex'te çok büyük görselde renk toplamı taşabiliyor).
export function planScale(width, height) {
  let k = Math.min(4, Math.max(1, Math.ceil(600 / Math.min(width, height))));
  const fit = Math.sqrt(LIMITS.maxPixels / (width * height));
  if (width * height * k * k > LIMITS.maxPixels) k = Math.min(k, fit);
  return { scale: k, width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

let wasm = null;

// WASM modülünü yükler. Node'da `bytes` verilir; tarayıcıda dosya adresinden indirilir.
// `glue`: wasm-bindgen yapıştırma kodu önceden yüklenmişse (tek dosyalık sürüm) doğrudan verilir.
export async function initVectorizer(bytes, glue) {
  if (wasm) return wasm;
  const mod = glue ?? await import('./vendor/vtracer/vtracer.js');
  if (bytes) mod.initSync({ module: bytes });
  else await mod.default({ module_or_path: new URL('./vendor/vtracer/vtracer_bg.wasm', import.meta.url) });
  wasm = mod;
  return wasm;
}

// ---------- Palet çıkarma ----------
// JPEG ve bulanık görsellerde şekil kenarlarındaki geçiş tonları, vektörde şeklin etrafında ayrı renk
// halkalarına dönüşür. Çevirmeden önce baskın renkler bulunur (Lab uzayında k-ortalamalar) ve her piksel
// en yakın baskın renge eşlenir; böylece her renk bölgesinin tek ve temiz bir sınırı olur.

function srgbToLab(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const X = t((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const Y = t(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = t((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Baskın renkleri bulur. maxColors: üst sınır; birbirine ΔE < mergeDelta olan renkler birleştirilir,
// piksellerin minShare'inden azını kaplayan renkler atılır (en yakın renge katılır).
export function findPalette(rgba, { maxColors = 8, mergeDelta = 12, minShare = 0.002, seed = 1 } = {}) {
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / 40000));
  const samples = [];
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (rgba[i + 3] >= 128) samples.push(srgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]));
  }
  if (!samples.length) return [];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  // k-means++ başlangıcı
  const centers = [samples[Math.floor(rnd() * samples.length)]];
  const d = samples.map((x) => dist2(x, centers[0]));
  while (centers.length < Math.min(maxColors, samples.length)) {
    const total = d.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rnd() * total, idx = 0;
    while (idx < d.length - 1 && (r -= d[idx]) > 0) idx++;
    centers.push(samples[idx]);
    for (let j = 0; j < samples.length; j++) d[j] = Math.min(d[j], dist2(samples[j], samples[idx]));
  }
  let counts = [];
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = centers.map(() => 0);
    for (const x of samples) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) { const dd = dist2(x, centers[c]); if (dd < bd) { bd = dd; best = c; } }
      sums[best][0] += x[0]; sums[best][1] += x[1]; sums[best][2] += x[2]; counts[best]++;
    }
    for (let c = 0; c < centers.length; c++) if (counts[c]) centers[c] = sums[c].map((v) => v / counts[c]);
  }
  // Yakın renkleri birleştir, çok az yer kaplayanları at.
  let pal = centers.map((c, i) => ({ lab: c, count: counts[i] })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
  const merged = [];
  for (const c of pal) {
    const near = merged.find((m) => Math.sqrt(dist2(m.lab, c.lab)) < mergeDelta);
    if (near) {
      const t = near.count + c.count;
      near.lab = near.lab.map((v, k) => (v * near.count + c.lab[k] * c.count) / t);
      near.count = t;
    } else merged.push({ ...c });
  }
  const total = merged.reduce((a, c) => a + c.count, 0);
  return merged.filter((c, i) => i === 0 || c.count / total >= minShare).map((c) => c.lab);
}

// Pikselleri palete eşler: her pikselin en yakın palet rengi sırası (saydamlar için 255).
function mapToPalette(rgba, palette) {
  const cache = new Map(); // 15 bit RGB → palet sırası
  const idx = new Uint8Array(rgba.length / 4).fill(255);
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let best = cache.get(key);
    if (best === undefined) {
      const lab = srgbToLab((rgba[i] & 0xf8) + 4, (rgba[i + 1] & 0xf8) + 4, (rgba[i + 2] & 0xf8) + 4);
      let bd = Infinity;
      for (let c = 0; c < palette.length; c++) { const dd = dist2(lab, palette[c]); if (dd < bd) { bd = dd; best = c; } }
      cache.set(key, best);
    }
    idx[p] = best;
  }
  return idx;
}

// Bulanıklıktan doğan geçiş tonlarını bulur: renk uzayında iki başka palet renginin arasında kalan
// (C ≈ A + t·(B−A), 0.1 < t < 0.9) VE pikselleri çoğunlukla başka renklere komşu (ince şerit) renkler.
export function findTransitionColors(idx, width, height, palette, { maxDelta = 10, minEdgeShare = 0.3 } = {}) {
  const k = palette.length;
  const area = new Array(k).fill(0), edge = new Array(k).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = idx[y * width + x];
      if (c === 255) continue;
      area[c]++;
      if ((x > 0 && idx[y * width + x - 1] !== c) || (x < width - 1 && idx[y * width + x + 1] !== c) ||
          (y > 0 && idx[(y - 1) * width + x] !== c) || (y < height - 1 && idx[(y + 1) * width + x] !== c)) edge[c]++;
    }
  }
  const out = new Set();
  for (let c = 0; c < k; c++) {
    if (!area[c] || edge[c] / area[c] < minEdgeShare) continue;
    const C = palette[c];
    for (let a = 0; a < k && !out.has(c); a++) {
      for (let b = a + 1; b < k; b++) {
        if (a === c || b === c || out.has(a) || out.has(b)) continue;
        const A = palette[a], B = palette[b];
        const AB = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const len2 = AB[0] ** 2 + AB[1] ** 2 + AB[2] ** 2;
        if (!len2) continue;
        const t = ((C[0] - A[0]) * AB[0] + (C[1] - A[1]) * AB[1] + (C[2] - A[2]) * AB[2]) / len2;
        if (t <= 0.1 || t >= 0.9) continue;
        const P = [A[0] + t * AB[0], A[1] + t * AB[1], A[2] + t * AB[2]];
        if (Math.sqrt(dist2(C, P)) < maxDelta) { out.add(c); break; }
      }
    }
  }
  return out;
}

// Çoğunluk filtresi: her opak piksel, (2r+1)² penceresinde en sık görülen palet rengini alır.
// JPEG gürültüsünden doğan kenar dalgalarını ve basamakları siler; büyük bölgeler ve köşeler korunur.
// Saydam pikseller (255) oy vermez ve değişmez.
export function modeFilter(idx, width, height, radius, colors) {
  if (radius < 1) return idx;
  const out = idx.slice();
  const counts = new Int32Array(colors);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const c = idx[y * width + x];
      if (c === 255) continue;
      const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
      counts.fill(0);
      let best = c, bestN = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const v = idx[row + xx];
          if (v === 255) continue;
          const n = ++counts[v];
          if (n > bestN || (n === bestN && v === c)) { bestN = n; best = v; }
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

// Her opak pikseli paletteki en yakın renge eşler; geçiş tonları (width/height verilirse) çıkarılır.
// Renk, o renge eşlenen piksellerin ortalamasıdır (Lab'den geri çevirmek yerine gerçek piksel ortalaması).
export function applyPalette(rgba, palette, width, height, { smooth = 0 } = {}) {
  if (!palette.length) return rgba;
  let idx = mapToPalette(rgba, palette);
  if (width && height && palette.length > 2) {
    const drop = findTransitionColors(idx, width, height, palette);
    if (drop.size) {
      palette = palette.filter((_, c) => !drop.has(c));
      idx = mapToPalette(rgba, palette);
    }
  }
  if (smooth > 0 && width && height) idx = modeFilter(idx, width, height, smooth, palette.length);
  return paintIndexed(rgba, idx, palette.length, width, height);
}

// İndeksli görüntüyü düz renklerle boyar. Renk, bölgenin İÇ piksellerinin ortalamasıdır (4 komşusu da aynı
// bölgede olanlar). Kenar pikselleri bulanıklıktan komşu rengi taşır; ortalamaya katılsalar düz alanların
// rengi kayar (ölçülen ΔE ~3 → ~1). Saydam pikseller (255) saydam kalır.
function paintIndexed(rgba, idx, k, width, height) {
  const out = new Uint8Array(rgba.length);
  const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
  const all = Array.from({ length: k }, () => [0, 0, 0, 0]);
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
    const c = idx[p];
    if (c === 255) continue;
    const a = all[c];
    a[0] += rgba[i]; a[1] += rgba[i + 1]; a[2] += rgba[i + 2]; a[3]++;
    if (width && height) {
      const x = p % width, y = (p - x) / width;
      const interior = (x === 0 || idx[p - 1] === c) && (x === width - 1 || idx[p + 1] === c)
        && (y === 0 || idx[p - width] === c) && (y === height - 1 || idx[p + width] === c);
      if (!interior) continue;
    }
    const sm = sums[c];
    sm[0] += rgba[i]; sm[1] += rgba[i + 1]; sm[2] += rgba[i + 2]; sm[3]++;
  }
  const colors = [];
  for (let c = 0; c < k; c++) {
    const sm = sums[c][3] ? sums[c] : all[c]; // iç piksel yoksa (çok ince şekil) tüm pikseller
    colors.push(sm[3] ? [Math.round(sm[0] / sm[3]), Math.round(sm[1] / sm[3]), Math.round(sm[2] / sm[3])] : [0, 0, 0]);
  }
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
    if (idx[p] === 255) continue; // saydam kalır (out sıfırla başlar)
    const c = colors[idx[p]];
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return out;
}

// Bölgeye duyarlı palet. Görsel önce renk-sürekli bölgelere ayrılır (gradients.js). Gradyana sığan bölge tek
// renge (ortalama) boyanır; üstüne sonradan gradyanlı yol çizilir. Sığmayan büyük bölge kendi içinde en fazla
// `localColors` tona ayrılır (çizgi film gölgelemesi: ana ton + gölge + ışık). Bölge dışı pikseller (kontur,
// küçük ayrıntılar) ortak paletle boyanır; bölge kenarındaki geçiş pikselleri bölge tonlarına da eşlenebilir.
// Tek paletle (16 renk) tüm görseli boyamaya göre tonlar bölgelere ait kalır, komşu bölgelerin tonları karışmaz.
// Bir bölgenin tonları: en az sayıda tonla bölge pikselleri ortalama ΔE ≤ target olacak şekilde (1'den
// maxColors'a kadar denenir). Böylece düz bölge tek ton kalır (gürültü parçalanmaz), gölgeli bölge gerektiği
// kadar tona ayrılır.
export function regionTones(rgba, pixels, { maxColors = 4, mergeDelta = 6, target = 4 } = {}) {
  const sub = new Uint8Array(rgba.length);
  for (const p of pixels) { const i = p * 4; sub[i] = rgba[i]; sub[i + 1] = rgba[i + 1]; sub[i + 2] = rgba[i + 2]; sub[i + 3] = 255; }
  const stride = Math.max(1, Math.floor(pixels.length / 4000));
  const labs = [];
  for (let t = 0; t < pixels.length; t += stride) { const i = pixels[t] * 4; labs.push(srgbToLab(rgba[i], rgba[i + 1], rgba[i + 2])); }
  let best = null;
  for (let k = 1; k <= maxColors; k++) {
    const pal = findPalette(sub, { maxColors: k, mergeDelta, minShare: 0.005 });
    if (!pal.length) break;
    let err = 0;
    for (const lab of labs) { let bd = Infinity; for (const c of pal) { const dd = dist2(lab, c); if (dd < bd) bd = dd; } err += Math.sqrt(bd); }
    err /= labs.length;
    if (!best || err < best.err - 0.5) best = { pal, err };
    if (err <= target) break;
  }
  return best ? best.pal : [[50, 0, 0]];
}

export function applyRegionPalette(rgba, width, height, { gradients, flats }, { maxColors = 16, smooth = 0, localColors = 4, localMerge = 6, localTarget = 4, mergeDelta = 5 } = {}) {
  const n = width * height;
  const owner = new Int32Array(n).fill(-1); // piksel → bölge sırası (gradients sonra flats)
  const regions = [...gradients.map((g) => ({ pixels: g.pixels, gradient: true })), ...flats.map((f) => ({ pixels: f.pixels, gradient: false }))];
  regions.forEach((r, i) => { for (const p of r.pixels) owner[p] = i; });
  // Ortak palet: yalnızca bölge dışı piksellerden
  const rest = new Uint8Array(rgba.length);
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) if (owner[p] < 0) { rest[i] = rgba[i]; rest[i + 1] = rgba[i + 1]; rest[i + 2] = rgba[i + 2]; rest[i + 3] = rgba[i + 3]; }
  const palette = findPalette(rest, { maxColors });
  const globalCount = palette.length;
  // Bölge paletleri
  const local = regions.map((r) => {
    if (r.gradient) {
      const m = [0, 0, 0];
      for (const p of r.pixels) { m[0] += rgba[p * 4]; m[1] += rgba[p * 4 + 1]; m[2] += rgba[p * 4 + 2]; }
      return [srgbToLab(m[0] / r.pixels.length, m[1] / r.pixels.length, m[2] / r.pixels.length)];
    }
    return regionTones(rgba, r.pixels, { maxColors: localColors, mergeDelta: localMerge, target: localTarget });
  });
  // Bölge tonları ortak palete eklenir; birbirine çok yakın tonlar (ΔE < mergeDelta) tek renge indirgenir ki
  // aynı mavi on ayrı harfte on ayrı renk olmasın (yoksa kenarlarda ince şeritler ve gereksiz yollar doğar).
  const offsets = [];
  const alias = []; // birleşik palet sırası → gerçek palet sırası
  const addColor = (lab) => {
    for (let c = 0; c < palette.length; c++) if (Math.sqrt(dist2(lab, palette[c])) < mergeDelta) return c;
    palette.push(lab);
    return palette.length - 1;
  };
  for (let c = 0; c < globalCount; c++) alias.push(c);
  for (const pal of local) { offsets.push(alias.length); for (const lab of pal) alias.push(addColor(lab)); }
  // Eşleme: bölge pikseli kendi tonlarından en yakını; dışarısı tüm paletten en yakını
  const idx = mapToPalette(rgba, palette);
  const labCache = new Map();
  for (let p = 0; p < n; p++) {
    const r = owner[p];
    if (r < 0 || idx[p] === 255) continue;
    const pal = local[r];
    if (pal.length === 1) { idx[p] = alias[offsets[r]]; continue; }
    const i = p * 4, key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let lab = labCache.get(key);
    if (!lab) { lab = srgbToLab((rgba[i] & 0xf8) + 4, (rgba[i + 1] & 0xf8) + 4, (rgba[i + 2] & 0xf8) + 4); labCache.set(key, lab); }
    let best = 0, bd = Infinity;
    for (let c = 0; c < pal.length; c++) { const dd = dist2(lab, pal[c]); if (dd < bd) { bd = dd; best = c; } }
    idx[p] = alias[offsets[r] + best];
  }
  // Ortak paletteki geçiş tonları (bulanık kenar karışımları) atılır; bölge tonlarına dokunulmaz
  if (palette.length > 2) {
    const drop = new Set([...findTransitionColors(idx, width, height, palette)].filter((c) => c < globalCount));
    if (drop.size) {
      const keep = palette.map((_, c) => c).filter((c) => !drop.has(c));
      const remap = new Map();
      for (let p = 0; p < n; p++) {
        if (idx[p] === 255 || !drop.has(idx[p])) continue;
        const i = p * 4, key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
        let best = remap.get(key);
        if (best === undefined) {
          const lab = srgbToLab((rgba[i] & 0xf8) + 4, (rgba[i + 1] & 0xf8) + 4, (rgba[i + 2] & 0xf8) + 4);
          let bd = Infinity;
          for (const c of keep) { const dd = dist2(lab, palette[c]); if (dd < bd) { bd = dd; best = c; } }
          remap.set(key, best);
        }
        idx[p] = best;
      }
    }
  }
  const smoothed = smooth > 0 ? modeFilter(idx, width, height, smooth, palette.length) : idx;
  return paintIndexed(rgba, smoothed, palette.length, width, height);
}

// Otsu yöntemiyle siyah-beyaz eşiği (gri tonlu histogramda iki sınıfı en iyi ayıran değer).
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// Siyah-beyaz mod için: saydam alanı beyaz say, parlaklığa göre eşikle (koyu = şekil).
export function toBlackAndWhite(rgba, threshold) {
  const n = rgba.length / 4;
  const gray = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    gray[p] = Math.round((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a));
  }
  const t = threshold ?? otsuThreshold(gray);
  const out = new Uint8Array(rgba.length);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = gray[p] <= t ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

// RGBA pikselleri SVG'ye çevirir. `outWidth/outHeight` verilirse (görsel önce büyütüldüyse)
// SVG o boyutta görünür; viewBox büyütülmüş koordinatlarda kalır, vektör olduğu için kayıp olmaz.
// `scale`: görsel planScale ile büyütüldüyse oranı. Kırıntı filtresi orijinal görsel pikseline göre
// tanımlıdır; büyütülmüş görselde aynı oranda büyütülür (yoksa JPEG gürültüsü ayrı şekiller olur).
export function vectorizePixels(rgba, width, height, { preset = 'logo', cutout = false, threshold, outWidth, outHeight, scale = 1, ...overrides } = {}) {
  if (!wasm) throw new Error('Vektör motoru yüklenmedi (initVectorizer).');
  if (!(width > 0 && height > 0) || rgba.length !== width * height * 4) throw new Error(`Piksel verisi boyutla uyuşmuyor: ${rgba.length} bayt, beklenen ${width * height * 4}.`);
  const o = { ...PRESETS[preset], ...overrides };
  o.filterSpeckle = Math.round(o.filterSpeckle * Math.max(1, scale));
  let pixels;
  let gradients = [];
  if (o.binary) pixels = toBlackAndWhite(rgba, threshold);
  else if (o.paletteColors) {
    // Pürüzsüzleştirme yarıçapı büyütme oranıyla ölçeklenir (orijinal görselde ~1 piksel).
    const smooth = o.smooth ? Math.max(1, Math.round(o.smooth * Math.max(1, scale))) : 0;
    if (o.regions) {
      const analysis = analyzeRegions(rgba, width, height, { max: LIMITS.maxGradients, scale });
      gradients = analysis.gradients;
      pixels = applyRegionPalette(rgba, width, height, analysis, { maxColors: o.paletteColors, smooth });
    } else {
      pixels = applyPalette(rgba, findPalette(rgba, { maxColors: o.paletteColors }), width, height, { smooth });
    }
  }
  else pixels = rgba;
  const asBytes = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  let svg = wasm.vectorize(
    asBytes(pixels), width, height, Boolean(o.binary), Boolean(cutout), o.filterSpeckle, o.colorPrecision,
    o.layerDifference, o.cornerThreshold, o.lengthThreshold, o.spliceThreshold, 2,
  );
  if (gradients.length) {
    // Her gradyan bölgesi ikili maske olarak ayrıca izlenir ve düz çizimin üstüne gradyan dolgulu yol eklenir.
    const defs = [], paths = [];
    gradients.forEach((g, i) => {
      const traced = wasm.vectorize(regionMask(g, width, height), width, height, true, false, o.filterSpeckle, 8, 16,
        o.cornerThreshold, o.lengthThreshold, o.spliceThreshold, 2);
      const ds = [...traced.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
      if (!ds.length) return;
      const id = `g${i + 1}`;
      defs.push(gradientDef(id, g.fill));
      for (const d of ds) paths.push(`<path d="${d}" fill="url(#${id})"/>`);
    });
    if (defs.length) {
      svg = svg.replace(/(<svg\b[^>]*>)/, `$1\n<defs>${defs.join('')}</defs>`).replace(/\n<\/svg>\s*$/, `\n${paths.join('\n')}\n</svg>\n`);
    }
  }
  if (outWidth && outHeight) {
    svg = svg.replace(/ width="\d+" height="\d+"/, ` width="${outWidth}" height="${outHeight}"`);
  }
  const check = validateSvg(svg);
  if (!check.ok) throw new Error('Vektör çıktısı doğrulanamadı: ' + check.errors.slice(0, 3).join('; '));
  if (check.stats.paths > LIMITS.maxPaths || check.stats.bytes > LIMITS.maxBytes) {
    throw new Error('Görsel vektör için fazla ayrıntılı (fotoğraf olabilir). "Logo" ya da "Siyah-beyaz" ayarını dene.');
  }
  const warnings = [];
  if (check.stats.paths > LIMITS.cuttingPaths) warnings.push(`${check.stats.paths} yol: kesim makineleri (Cricut) en fazla ${LIMITS.cuttingPaths} yol kabul eder.`);
  if (check.stats.gradients) warnings.push(`${check.stats.gradients} gradyan: kesim makineleri gradyanı yok sayar, tek renk keser.`);
  return { svg, stats: check.stats, warnings };
}

// Kayıpsız (piksel kusursuz) vektör: her renk bölgesi piksel kenarları boyunca tam sayı koordinatlarla
// izlenir. Orijinal boyutta çizildiğinde her piksel orijinalle aynıdır (Chromium ve resvg ile doğrulandı:
// docs/vektor-kanit.md). Büyütüldüğünde kenarlar piksel basamaklıdır; pürüzsüz eğri istenirse diğer ayarlar.
export function vectorizeExact(rgba, width, height) {
  if (!wasm) throw new Error('Vektör motoru yüklenmedi (initVectorizer).');
  const pixels = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const svg = wasm.vectorize_exact(pixels, width, height);
  const check = validateSvg(svg);
  if (!check.ok) throw new Error('Vektör çıktısı doğrulanamadı: ' + check.errors.slice(0, 3).join('; '));
  if (check.stats.paths > LIMITS.maxPaths || check.stats.bytes > LIMITS.maxBytes) {
    throw new Error('Görselde çok fazla farklı renk var (fotoğraf olabilir); kayıpsız vektör çok büyük olur. "Logo" ya da "Çizim" ayarını dene.');
  }
  // Garanti: SVG'yi geri çizip orijinalle piksel piksel karşılaştır; tek fark bile varsa çıktı verilmez.
  const diff = verifyExact(svg, pixels, width, height);
  if (diff) throw new Error(`Kayıpsız vektör doğrulanamadı: ${diff}`);
  return { svg, stats: check.stats, warnings: [] };
}

// Kayıpsız SVG'yi (yalnızca tam sayı H/V kenarlı yollar) piksel merkezlerinde, nonzero kuralıyla geri çizer ve
// kaynakla karşılaştırır. Fark yoksa null, varsa ilk farkı anlatan metin döner. İki yolun aynı pikseli
// boyaması da hata sayılır (bölgeler örtüşmemeli).
export function verifyExact(svg, rgba, width, height) {
  const out = new Uint8Array(width * height * 4);
  const painted = new Uint8Array(width * height);
  for (const m of svg.matchAll(/<path d="([^"]+)" fill="#([0-9A-F]{6})"(?: fill-opacity="([0-9.]+)")?\/>/g)) {
    const r = parseInt(m[2].slice(0, 2), 16), g = parseInt(m[2].slice(2, 4), 16), b = parseInt(m[2].slice(4, 6), 16);
    const a = m[3] === undefined ? 255 : Math.round(Number(m[3]) * 255);
    // Dikey kenarlar: [x, yÜst, yAlt, yön]
    const edges = [];
    let x = 0, y = 0, sx = 0, sy = 0;
    for (const t of m[1].matchAll(/([MHVZ])(?:(-?\d+)(?: (-?\d+))?)?/g)) {
      if (t[1] === 'M') { x = sx = Number(t[2]); y = sy = Number(t[3]); }
      else if (t[1] === 'H') x = Number(t[2]);
      else if (t[1] === 'V') { const ny = Number(t[2]); if (ny !== y) edges.push([x, Math.min(y, ny), Math.max(y, ny), ny > y ? 1 : -1]); y = ny; }
      else { if (y !== sy) edges.push([x, Math.min(y, sy), Math.max(y, sy), sy > y ? 1 : -1]); x = sx; y = sy; }
      // Kayıpsız modda hiçbir köşe görselin dışına taşamaz (taşan kısım görünmez ama dosya yanlış olur).
      if (x < 0 || y < 0 || x > width || y > height) return `köşe (${x}, ${y}) görselin dışında`;
    }
    edges.sort((p, q) => p[1] - q[1]);
    let next = 0, active = [];
    const y0 = edges.length ? edges[0][1] : 0, y1 = edges.reduce((mx, e) => Math.max(mx, e[2]), 0);
    for (let row = Math.max(0, y0); row < Math.min(height, y1); row++) {
      while (next < edges.length && edges[next][1] <= row) active.push(edges[next++]);
      active = active.filter((e) => e[2] > row);
      active.sort((p, q) => p[0] - q[0]);
      let winding = 0;
      for (let k = 0; k < active.length - 1; k++) {
        winding += active[k][3];
        if (!winding) continue;
        for (let px = Math.max(0, active[k][0]); px < Math.min(width, active[k + 1][0]); px++) {
          const p = row * width + px;
          if (painted[p]) return `piksel (${px}, ${row}) iki kez boyanıyor`;
          painted[p] = 1;
          out.set([r, g, b, a], p * 4);
        }
      }
    }
  }
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (rgba[i + 3] === 0) { if (painted[p]) return `saydam piksel (${p % width}, ${Math.floor(p / width)}) boyanmış`; continue; }
    if (out[i] !== rgba[i] || out[i + 1] !== rgba[i + 1] || out[i + 2] !== rgba[i + 2] || out[i + 3] !== rgba[i + 3]) {
      return `piksel (${p % width}, ${Math.floor(p / width)}) farklı: beklenen ${Array.from(rgba.slice(i, i + 4))}, bulunan ${Array.from(out.slice(i, i + 4))}`;
    }
  }
  return null;
}

// ---------- Doğrulama ----------

const ALLOWED_ELEMENTS = new Set(['svg', 'path', 'defs', 'linearGradient', 'radialGradient', 'stop']);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// SVG yol verisini standarttaki sözdizimine göre katı biçimde ayrıştırır.
// Dönen değer: alt yollar (her biri { closed, points:[[x,y]...] }) ya da hata mesajı.
export function parsePathData(d) {
  let i = 0;
  const subpaths = [];
  let cur = null, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = () => {
    skip();
    const m = NUMBER.exec(d.slice(i));
    if (!m) throw new Error(`sayı bekleniyordu (konum ${i})`);
    i += m[0].length;
    const v = Number(m[0]);
    if (!Number.isFinite(v)) throw new Error(`geçersiz sayı ${m[0]}`);
    return v;
  };
  skip();
  if (!/[Mm]/.test(d[i] ?? '')) throw new Error('yol M komutuyla başlamalı');
  while (true) {
    skip();
    if (i >= d.length) break;
    if (/[A-Za-z]/.test(d[i])) {
      cmd = d[i++];
      if (!(cmd.toUpperCase() in ARG_COUNT)) throw new Error(`bilinmeyen komut ${cmd}`);
    } else if (!cmd || /[Zz]/.test(cmd)) {
      throw new Error(`komut bekleniyordu (konum ${i})`);
    }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    if (C === 'Z') {
      if (!cur) throw new Error('Z açık bir alt yol olmadan');
      cur.closed = true;
      x = sx; y = sy;
      cur = null;
      continue;
    }
    const args = [];
    for (let k = 0; k < ARG_COUNT[C]; k++) args.push(num());
    if (C === 'A' && (![0, 1].includes(args[3]) || ![0, 1].includes(args[4]))) throw new Error('yay bayrakları 0/1 olmalı');
    const pts = [];
    const abs = (px, py) => (rel ? [x + px, y + py] : [px, py]);
    if (C === 'M') {
      [x, y] = abs(args[0], args[1]);
      sx = x; sy = y;
      cur = { closed: false, points: [[x, y]] };
      subpaths.push(cur);
      cmd = rel ? 'l' : 'L'; // M'den sonraki çiftler satır komutudur
      continue;
    }
    if (!cur) { // Z'den sonra M'siz devam: alt yol son noktadan başlar
      cur = { closed: false, points: [[x, y]] };
      subpaths.push(cur);
      sx = x; sy = y;
    }
    if (C === 'H') { x = rel ? x + args[0] : args[0]; pts.push([x, y]); }
    else if (C === 'V') { y = rel ? y + args[0] : args[0]; pts.push([x, y]); }
    else {
      for (let k = 0; k + 1 < args.length; k += 2) {
        if (C === 'A' && k < 4) continue; // rx, ry, dönüş, bayraklar nokta değil
        pts.push(abs(args[k], args[k + 1]));
      }
      [x, y] = pts[pts.length - 1];
    }
    cur.points.push(...pts);
  }
  return subpaths;
}

// SVG metnini denetler. { ok, errors, stats } döner.
export function validateSvg(svg) {
  const errors = [];
  const stats = { paths: 0, subpaths: 0, bytes: svg.length, colors: 0, gradients: 0 };
  const text = svg.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) errors.push('DOCTYPE/ENTITY içeremez');
  if (/data:|href=|<script|<style|<image|<foreignObject|on[a-z]+=/i.test(text)) errors.push('saf vektör değil: resim, bağlantı, betik ya da stil içeriyor');

  const root = /^<svg\b([^>]*)>/.exec(text);
  if (!root) return { ok: false, errors: ['kök öğe <svg> değil'], stats };
  if (!text.endsWith('</svg>')) errors.push('</svg> ile bitmiyor');
  const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1];
  if (attr(root[1], 'xmlns') !== 'http://www.w3.org/2000/svg') errors.push('xmlns eksik ya da hatalı');
  const rootAttrs = [...root[1].matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]);
  for (const a of rootAttrs) if (!['xmlns', 'version', 'width', 'height', 'viewBox', 'shape-rendering'].includes(a)) errors.push(`kökte izin verilmeyen öznitelik: ${a}`);
  const sr = attr(root[1], 'shape-rendering');
  if (sr !== undefined && sr !== 'crispEdges') errors.push('shape-rendering yalnızca crispEdges olabilir');
  const vb = (attr(root[1], 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const w = Number(attr(root[1], 'width')), h = Number(attr(root[1], 'height'));
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0) errors.push('viewBox eksik ya da hatalı');
  if (!(w > 0) || !(h > 0)) errors.push('width/height eksik ya da hatalı');
  else if (vb.length === 4 && Math.abs(w / h - vb[2] / vb[3]) > 0.01 * (w / h)) errors.push('viewBox en-boy oranı width/height ile uyuşmuyor');

  // Kök içinde yalnızca şunlar olabilir: en başta isteğe bağlı tek <defs> (içinde yalnızca gradyanlar, onların
  // içinde yalnızca <stop/>), ardından kendini kapatan <path .../> öğeleri. Başka hiçbir öğe, metin ya da
  // öznitelik kabul edilmez.
  const body = text.slice(root[0].length, -'</svg>'.length);
  const tags = body.match(/<[^>]*>/g) ?? [];
  const leftover = body.replace(/<[^>]*>/g, '').trim();
  if (leftover) errors.push('öğeler arasında metin var');
  const colors = new Set();
  const gradientIds = new Set();
  const [minX, minY, vw, vh] = vb.length === 4 ? vb : [0, 0, w, h];
  const tol = Math.max(vw, vh) * 0.01 + 1;
  const inBounds = (x, y) => x >= minX - tol && y >= minY - tol && x <= minX + vw + tol && y <= minY + vh + tol;
  const finite = (v) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(v ?? '') && Number.isFinite(Number(v));
  let state = 'start'; // start → defs → paths
  let gradient = null; // { id, stops, lastOffset }
  const checkAttrs = (tag, allowed, what) => {
    for (const a of [...tag.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1])) if (!allowed.includes(a)) errors.push(`${what} izin verilmeyen öznitelik: ${a}`);
  };
  for (const tag of tags) {
    const closing = tag.startsWith('</');
    const name = /^<\/?\s*([a-zA-Z]+)/.exec(tag)?.[1];
    if (!ALLOWED_ELEMENTS.has(name) || name === 'svg') { errors.push(`izin verilmeyen öğe: ${tag.slice(0, 40)}`); continue; }
    if (name === 'defs') {
      if (!closing) { if (state !== 'start') errors.push('<defs> yalnızca en başta ve bir kez olabilir'); state = 'defs'; }
      else { if (state !== 'defs' || gradient) errors.push('<defs> yanlış kapatıldı'); state = 'paths'; }
      continue;
    }
    if (name === 'linearGradient' || name === 'radialGradient') {
      if (state !== 'defs') { errors.push(`${name} yalnızca <defs> içinde olabilir`); continue; }
      if (closing) {
        if (!gradient) errors.push('gradyan yanlış kapatıldı');
        else if (gradient.stops < 2) errors.push(`${gradient.id}: en az 2 durak olmalı`);
        else if (gradient.lastOffset !== 1) errors.push(`${gradient.id}: son durak 1 olmalı`);
        gradient = null;
        continue;
      }
      if (gradient) { errors.push('iç içe gradyan'); continue; }
      const id = attr(tag, 'id');
      if (!/^g\d{1,4}$/.test(id ?? '')) errors.push(`geçersiz gradyan kimliği: ${id}`);
      else if (gradientIds.has(id)) errors.push(`yinelenen gradyan kimliği: ${id}`);
      else gradientIds.add(id);
      if (attr(tag, 'gradientUnits') !== 'userSpaceOnUse') errors.push(`${id}: gradientUnits userSpaceOnUse olmalı`);
      if (name === 'linearGradient') {
        checkAttrs(tag, ['id', 'gradientUnits', 'x1', 'y1', 'x2', 'y2'], 'linearGradient');
        const v = ['x1', 'y1', 'x2', 'y2'].map((a) => attr(tag, a));
        if (!v.every(finite)) errors.push(`${id}: x1/y1/x2/y2 eksik ya da sayı değil`);
        else if (!inBounds(+v[0], +v[1]) || !inBounds(+v[2], +v[3])) errors.push(`${id}: gradyan noktası görsel dışında`);
      } else {
        checkAttrs(tag, ['id', 'gradientUnits', 'cx', 'cy', 'r'], 'radialGradient');
        const v = ['cx', 'cy', 'r'].map((a) => attr(tag, a));
        if (!v.every(finite)) errors.push(`${id}: cx/cy/r eksik ya da sayı değil`);
        else if (!inBounds(+v[0], +v[1]) || !(+v[2] > 0) || +v[2] > Math.max(vw, vh) * 2) errors.push(`${id}: gradyan merkezi görsel dışında ya da yarıçap geçersiz`);
      }
      gradient = { id, stops: 0, lastOffset: -1 };
      continue;
    }
    if (name === 'stop') {
      if (!gradient) { errors.push('<stop> yalnızca gradyan içinde olabilir'); continue; }
      if (!tag.endsWith('/>')) { errors.push('stop kendini kapatmalı'); continue; }
      checkAttrs(tag, ['offset', 'stop-color'], 'stop');
      const off = attr(tag, 'offset'), sc = attr(tag, 'stop-color');
      if (!finite(off) || +off < 0 || +off > 1 || +off < gradient.lastOffset) errors.push(`${gradient.id}: durak sırası ya da değeri hatalı (${off})`);
      else { if (gradient.stops === 0 && +off !== 0) errors.push(`${gradient.id}: ilk durak 0 olmalı`); gradient.lastOffset = +off; }
      if (!/^#[0-9A-Fa-f]{6}$/.test(sc ?? '')) errors.push(`geçersiz durak rengi: ${sc}`);
      gradient.stops++;
      continue;
    }
    // path
    if (state === 'defs') { errors.push('<defs> kapanmadan path geldi'); continue; }
    state = 'paths';
    if (!tag.endsWith('/>')) { errors.push('path kendini kapatmalı'); continue; }
    if (/transform=/.test(tag)) errors.push('path transform içermemeli');
    checkAttrs(tag, ['d', 'fill', 'fill-opacity'], "path'te");
    const op = attr(tag, 'fill-opacity');
    if (op !== undefined && !(/^(0|1|0?\.\d+)$/.test(op) && Number(op) > 0 && Number(op) <= 1)) errors.push(`geçersiz fill-opacity: ${op}`);
    const d = attr(tag, 'd');
    const fill = attr(tag, 'fill');
    const ref = /^url\(#(g\d{1,4})\)$/.exec(fill ?? '');
    if (ref) { if (!gradientIds.has(ref[1])) errors.push(`tanımsız gradyan: ${ref[1]}`); else stats.gradients++; }
    else if (!/^#[0-9A-Fa-f]{6}$/.test(fill ?? '')) errors.push(`geçersiz renk: ${fill}`);
    else colors.add(fill.toUpperCase());
    if (!d) { errors.push('boş yol'); continue; }
    stats.paths++;
    let subpaths;
    try {
      subpaths = parsePathData(d);
    } catch (e) {
      errors.push(`yol #${stats.paths} ayrıştırılamadı: ${e.message}`);
      continue;
    }
    stats.subpaths += subpaths.length;
    for (const sp of subpaths) {
      if (!sp.closed) errors.push(`yol #${stats.paths}: kapanmamış alt yol`);
      for (const [px, py] of sp.points) {
        if (!inBounds(px, py)) {
          errors.push(`yol #${stats.paths}: görsel dışında nokta (${px.toFixed(1)}, ${py.toFixed(1)})`);
          break;
        }
      }
    }
  }
  if (state === 'defs' || gradient) errors.push('<defs> ya da gradyan kapatılmadı');
  const unused = [...gradientIds].length - new Set([...svg.matchAll(/url\(#(g\d{1,4})\)/g)].map((m) => m[1])).size;
  if (unused > 0) errors.push('kullanılmayan gradyan tanımı var');
  stats.colors = colors.size;
  return { ok: errors.length === 0, errors: [...new Set(errors)], stats };
}
