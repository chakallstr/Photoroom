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
  logo: { binary: false, paletteColors: 8, regions: true, localColors: 4, localTarget: 4, smooth: 0.67, colorPrecision: 7, filterSpeckle: 8, layerDifference: 8, cornerThreshold: 90, lengthThreshold: 10, spliceThreshold: 60 },
  cizim: { binary: false, paletteColors: 32, regions: true, tones: 'cel', localColors: 4, smooth: 0.67, colorPrecision: 7, filterSpeckle: 4, layerDifference: 8, cornerThreshold: 90, lengthThreshold: 10, spliceThreshold: 60 },
  // Çok renkli, gölgeli çizimler için paletsiz: renk doğruluğu en yüksek, dosya daha büyük.
  detayli: { binary: false, colorPrecision: 6, filterSpeckle: 2, layerDifference: 24, cornerThreshold: 45, lengthThreshold: 3.5, spliceThreshold: 45 },
  siyahBeyaz: { binary: true, colorPrecision: 8, filterSpeckle: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, spliceThreshold: 45 },
};

// Çıktı sınırları: Cricut Design Space en fazla 5000 yol kabul eder; çok büyük dosyalar tarayıcıyı yorar.
// Deneysel: bant başına gradyan (fills 'fit'). Netleştirilmiş gölgeli çizimde ΔE 6,5 → 5,3; düz çizim ve
// logolarda yol sayısını artırıp hatayı yükseltiyor, o yüzden varsayılan değil. Laboratuvarda seçenek.
export const BAND_GRADIENT_OVERRIDES = {
  fills: 'fit', localColors: 60, celStep: 1, blurRadius: 0, filterSpeckle: 1, snapRadius: 6,
  cornerThreshold: 30, lengthThreshold: 2, spliceThreshold: 30, // eğriler kaynağa sıkı sıkıya sadık
};
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
export function findTransitionColors(idx, width, height, palette, { maxDelta = 10, minEdgeShare = 0.3, colorOf = null } = {}) {
  const k = palette.length;
  const NONE = idx instanceof Uint8Array ? 255 : -1;
  const col = (l) => (colorOf ? colorOf[l] : l);
  const area = new Array(k).fill(0), edge = new Array(k).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = idx[y * width + x];
      if (l === NONE) continue;
      const c = col(l);
      area[c]++;
      // Kenar kararı renge göre (farklı etiket, aynı renk kenar değildir)
      const other = (q) => { const m = idx[q]; return m !== NONE ? col(m) !== c : true; };
      if ((x > 0 && other(y * width + x - 1)) || (x < width - 1 && other(y * width + x + 1)) ||
          (y > 0 && other((y - 1) * width + x)) || (y < height - 1 && other((y + 1) * width + x))) edge[c]++;
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
  const NONE = idx instanceof Uint8Array ? 255 : -1;
  const out = idx.slice();
  const counts = new Int32Array(colors);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const c = idx[y * width + x];
      if (c === NONE) continue;
      const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
      counts.fill(0);
      let best = c, bestN = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const v = idx[row + xx];
          if (v === NONE) continue;
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
  const NONE = idx instanceof Uint8Array ? 255 : -1;
  const out = new Uint8Array(rgba.length);
  const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
  const all = Array.from({ length: k }, () => [0, 0, 0, 0]);
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
    const c = idx[p];
    if (c === NONE) continue;
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
    if (idx[p] === NONE) continue; // saydam kalır (out sıfırla başlar)
    const c = colors[idx[p]];
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return out;
}

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

// Çizgi film tonlaması: bölge, bulanıklaştırılmış parlaklığın (Lab L) eşit aralıklı seviyelerine bölünür
// (gölge / ana ton / ışık). Sınırlar eş-ışık eğrileri olduğu için pürüzsüzdür; küçük ama parlak ışık alanları
// k-means'te olduğu gibi ana tona yutulmaz. Dönüş: { labs: ton renkleri (Lab), thresholds: L eşikleri }.
export function celTones(rgba, soft, pixels, { maxTones = 4, minRange = 12, step = 15 } = {}) {
  const n = pixels.length;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) { const q = pixels[i] * 4; L[i] = srgbToLab(soft[q], soft[q + 1], soft[q + 2])[0]; }
  const sorted = Float32Array.from(L).sort();
  const pct = (f) => sorted[Math.min(n - 1, Math.floor(f * n))];
  const lo = pct(0.05), hi = pct(0.95), range = hi - lo;
  const k = range < minRange ? 1 : Math.max(1, Math.min(maxTones, Math.round(range / step)));
  const thresholds = [];
  for (let i = 1; i < k; i++) thresholds.push(lo + range * i / k);
  const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
  const bandOf = (l) => { let b = 0; while (b < thresholds.length && l >= thresholds[b]) b++; return b; };
  for (let i = 0; i < n; i++) { const b = bandOf(L[i]), q = pixels[i] * 4, sm = sums[b]; sm[0] += rgba[q]; sm[1] += rgba[q + 1]; sm[2] += rgba[q + 2]; sm[3]++; }
  const labs = [], keep = [];
  sums.forEach((sm, b) => { if (sm[3] >= Math.max(20, n * 0.01)) { labs.push(srgbToLab(sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3])); keep.push(b); } });
  if (!labs.length) { const sm = sums.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2], a[3] + c[3]]); return { labs: [srgbToLab(sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3])], thresholds: [], bandMap: [0] }; }
  // Elenen (çok küçük) bantlar en yakın komşu banda eşlenir
  const bandMap = sums.map((_, b) => { let best = 0, bd = Infinity; keep.forEach((kb, i) => { const d = Math.abs(kb - b); if (d < bd) { bd = d; best = i; } }); return best; });
  return { labs, thresholds, bandMap };
}

// ---------- Bant başına dolgu uydurma ("fit" modu) ----------
// Etiket → eşsiz sahte renk (VTracer tek geçişte her etiketi ayrı katman yapsın; kanal başına ≥ 8 adım aralık).
export function encodeLabel(l) { return [((l & 31) << 3) + 4, (((l >> 5) & 31) << 3) + 4, (((l >> 10) & 31) << 3) + 4]; }
export function decodeLabel(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

// Her etiketin pikselleri için renk modeli: düz (ortalama) ya da doğrusal gradyan (renk ≈ a + b·x + c·y, kanal
// başına). İnce eş-ışık bandında gölge neredeyse doğrusaldır; bant bant gradyan, parça parça sürekli gölge verir.
// Dönüş: etiket → { kind:'flat', color:[r,g,b] } | { kind:'linear', x1,y1,x2,y2, stops }.
export function fitLabelFills(rgba, labels, labelCount, width, height, { minPixels = 60, minGain = 0.2, minRms = 3 } = {}) {
  const K = labelCount;
  const n = new Float64Array(K), Sx = new Float64Array(K), Sy = new Float64Array(K), Sxx = new Float64Array(K), Syy = new Float64Array(K), Sxy = new Float64Array(K);
  const Sc = new Float64Array(K * 3), Scx = new Float64Array(K * 3), Scy = new Float64Array(K * 3), Scc = new Float64Array(K * 3);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p]; if (l < 0) continue;
    const x = (p % width) + 0.5, y = Math.floor(p / width) + 0.5, i = p * 4;
    n[l]++; Sx[l] += x; Sy[l] += y; Sxx[l] += x * x; Syy[l] += y * y; Sxy[l] += x * y;
    for (let k = 0; k < 3; k++) { const v = rgba[i + k]; Sc[l * 3 + k] += v; Scx[l * 3 + k] += v * x; Scy[l * 3 + k] += v * y; Scc[l * 3 + k] += v * v; }
  }
  const solve3 = (A, b) => {
    const m = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      [m[c], m[piv]] = [m[piv], m[c]]; if (Math.abs(m[c][c]) < 1e-9) return null;
      for (let r = 0; r < 3; r++) { if (r === c) continue; const f = m[r][c] / m[c][c]; for (let j = c; j < 4; j++) m[r][j] -= f * m[c][j]; }
    }
    return m.map((r, i) => r[3] / r[i]);
  };
  const fills = new Array(K).fill(null);
  const coefs = new Array(K).fill(null);
  for (let l = 0; l < K; l++) {
    if (!n[l]) continue;
    const mean = [0, 1, 2].map((k) => Sc[l * 3 + k] / n[l]);
    fills[l] = { kind: 'flat', color: mean.map((v) => Math.round(Math.min(255, Math.max(0, v)))) };
    if (n[l] < minPixels) continue;
    const A = [[n[l], Sx[l], Sy[l]], [Sx[l], Sxx[l], Sxy[l]], [Sy[l], Sxy[l], Syy[l]]];
    const cs = []; let flatSse = 0, planeSse = 0;
    for (let k = 0; k < 3; k++) {
      const s = solve3(A, [Sc[l * 3 + k], Scx[l * 3 + k], Scy[l * 3 + k]]); if (!s) { cs.length = 0; break; }
      cs.push(s);
      // SSE kapalı biçim: Σ(v − (a+bx+cy))² = Σv² − 2Σv·pred + Σpred²; Σpred² = aΣv... normal denklemlerde Σ pred·v = Σ pred²
      const predDotV = s[0] * Sc[l * 3 + k] + s[1] * Scx[l * 3 + k] + s[2] * Scy[l * 3 + k];
      planeSse += Scc[l * 3 + k] - predDotV;
      flatSse += Scc[l * 3 + k] - Sc[l * 3 + k] * Sc[l * 3 + k] / n[l];
    }
    if (cs.length !== 3) continue;
    const flatRms = Math.sqrt(Math.max(0, flatSse) / (n[l] * 3)), planeRms = Math.sqrt(Math.max(0, planeSse) / (n[l] * 3));
    if (flatRms < minRms || (flatRms - planeRms) / flatRms < minGain) continue;
    coefs[l] = cs;
  }
  // Gradyan yönü ve uçları: parlaklık eğimi yönünde piksel izdüşümlerinin sınırları (ikinci geçiş)
  const tmin = new Float64Array(K).fill(Infinity), tmax = new Float64Array(K).fill(-Infinity), ux = new Float64Array(K), uy = new Float64Array(K);
  for (let l = 0; l < K; l++) {
    if (!coefs[l]) continue;
    const gx = 0.299 * coefs[l][0][1] + 0.587 * coefs[l][1][1] + 0.114 * coefs[l][2][1];
    const gy = 0.299 * coefs[l][0][2] + 0.587 * coefs[l][1][2] + 0.114 * coefs[l][2][2];
    const L = Math.hypot(gx, gy); if (L < 1e-6) { coefs[l] = null; continue; }
    ux[l] = gx / L; uy[l] = gy / L;
  }
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p]; if (l < 0 || !coefs[l]) continue;
    const t = ((p % width) + 0.5) * ux[l] + (Math.floor(p / width) + 0.5) * uy[l];
    if (t < tmin[l]) tmin[l] = t; if (t > tmax[l]) tmax[l] = t;
  }
  // Üçüncü geçiş: uç renkleri düzlemden dışa taşırarak değil, bandın gerçek uç piksellerinden (izdüşümün ilk ve
  // son %15'i) al; ortadaki %30'da piksel yoksa bant halka biçimlidir (ışık çevresi), doğrusal gradyan uymaz → düz.
  const lo = new Float64Array(K * 4), hi = new Float64Array(K * 4), mid = new Float64Array(K);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p]; if (l < 0 || !coefs[l]) continue;
    const t = ((p % width) + 0.5) * ux[l] + (Math.floor(p / width) + 0.5) * uy[l];
    const f = (t - tmin[l]) / (tmax[l] - tmin[l] || 1), i = p * 4;
    if (f <= 0.15) { lo[l * 4] += rgba[i]; lo[l * 4 + 1] += rgba[i + 1]; lo[l * 4 + 2] += rgba[i + 2]; lo[l * 4 + 3]++; }
    else if (f >= 0.85) { hi[l * 4] += rgba[i]; hi[l * 4 + 1] += rgba[i + 1]; hi[l * 4 + 2] += rgba[i + 2]; hi[l * 4 + 3]++; }
    if (f > 0.35 && f < 0.65) mid[l]++;
  }
  for (let l = 0; l < K; l++) {
    if (!coefs[l]) continue;
    if (!lo[l * 4 + 3] || !hi[l * 4 + 3] || mid[l] < n[l] * 0.1) continue; // uç ya da orta boş: düz kalsın
    const c1 = [0, 1, 2].map((k) => Math.round(lo[l * 4 + k] / lo[l * 4 + 3])), c2 = [0, 1, 2].map((k) => Math.round(hi[l * 4 + k] / hi[l * 4 + 3]));
    if (Math.sqrt(dist2(srgbToLab(...c1), srgbToLab(...c2))) < 4) continue; // uçlar aynı renk: düz
    const cx = Sx[l] / n[l], cy = Sy[l] / n[l], c0 = cx * ux[l] + cy * uy[l];
    // Uç noktalar görsel içinde kalsın (eğri/uzun bantta ağırlık merkezinden geçen doğru dışarı taşabilir)
    const pt = (t) => [Math.min(width, Math.max(0, cx + (t - c0) * ux[l])), Math.min(height, Math.max(0, cy + (t - c0) * uy[l]))];
    const [x1, y1] = pt(tmin[l] + 0.075 * (tmax[l] - tmin[l])), [x2, y2] = pt(tmax[l] - 0.075 * (tmax[l] - tmin[l]));
    if (Math.hypot(x2 - x1, y2 - y1) < 1) continue;
    fills[l] = { kind: 'linear', x1, y1, x2, y2, stops: [{ offset: 0, color: c1 }, { offset: 1, color: c2 }] };
  }
  return fills;
}

// Bölgeye duyarlı palet. Görsel önce renk-sürekli bölgelere ayrılır (gradients.js). Gradyana sığan bölge tek
// renge (ortalama) boyanır; üstüne sonradan gradyanlı yol çizilir. Sığmayan büyük bölge kendi içinde en fazla
// `localColors` tona ayrılır (çizgi film gölgelemesi: ana ton + gölge + ışık). Bölge dışı pikseller (kontur,
// küçük ayrıntılar) ortak paletle boyanır; bölge kenarındaki geçiş pikselleri bölge tonlarına da eşlenebilir.
// Tek paletle (16 renk) tüm görseli boyamaya göre tonlar bölgelere ait kalır, komşu bölgelerin tonları karışmaz.
//
// Sonuç bir "etiket planı": her piksel için etiket (Int32, -1 saydam), etiket → palet rengi, etiket → bölge.
export function buildRegionLabels(rgba, width, height, { gradients, flats }, { maxColors = 16, smooth = 0, localColors = 4, localMerge = 6, localTarget = 4, mergeDelta = 5, snapRadius = 0, blurRadius = 0, tones = 'kmeans', celStep = 15 } = {}) {
  const n = width * height;
  const owner = new Int32Array(n).fill(-1); // piksel → bölge sırası (gradients sonra flats)
  const regions = [...gradients.map((g) => ({ pixels: g.pixels, gradient: true })), ...flats.map((f) => ({ pixels: f.pixels, gradient: false }))];
  regions.forEach((r, i) => { for (const p of r.pixels) owner[p] = i; });
  // Ortak palet: yalnızca bölge dışı piksellerden
  const rest = new Uint8Array(rgba.length);
  for (let p = 0, i = 0; i < rgba.length; p++, i += 4) if (owner[p] < 0) { rest[i] = rgba[i]; rest[i + 1] = rgba[i + 1]; rest[i + 2] = rgba[i + 2]; rest[i + 3] = rgba[i + 3]; }
  // Küçük ayrıntıların rengi (göz akı gibi) atılmasın: pay eşiği düşük
  const palette = findPalette(rest, { maxColors, minShare: 0.0005 });
  const globalCount = palette.length;
  // Bölge piksellerinin bölgeyle sınırlı bulanık rengi: ton ataması bunun üzerinden yapılır (pürüzsüz bant sınırı)
  const softSrc = blurRadius > 0 ? maskedBlur(rgba, owner, width, height, blurRadius) : rgba;
  // Bölge paletleri
  const cel = []; // tones === 'cel' için bölge başına eşikler
  const local = regions.map((r, ri) => {
    if (r.gradient) {
      const m = [0, 0, 0];
      for (const p of r.pixels) { m[0] += rgba[p * 4]; m[1] += rgba[p * 4 + 1]; m[2] += rgba[p * 4 + 2]; }
      return [srgbToLab(m[0] / r.pixels.length, m[1] / r.pixels.length, m[2] / r.pixels.length)];
    }
    if (tones === 'cel') { const c = celTones(rgba, softSrc, r.pixels, { maxTones: localColors, step: celStep }); cel[ri] = c; return c.labs; }
    return regionTones(rgba, r.pixels, { maxColors: localColors, mergeDelta: localMerge, target: localTarget });
  });
  // Etiketler: ortak renkler + her bölgenin tonları. Birbirine çok yakın tonlar (ΔE < mergeDelta) aynı palet
  // rengine bağlanır ki aynı mavi on ayrı harfte on ayrı renk olmasın (kenarlarda ince şeritler ve gereksiz yollar).
  const labelColor = []; // etiket → palet sırası
  const labelOwner = []; // etiket → bölge (-1 ortak)
  const addColor = (lab) => {
    for (let c = 0; c < palette.length; c++) if (Math.sqrt(dist2(lab, palette[c])) < mergeDelta) return c;
    palette.push(lab);
    return palette.length - 1;
  };
  for (let c = 0; c < globalCount; c++) { labelColor.push(c); labelOwner.push(-1); }
  const offsets = [];
  local.forEach((pal, r) => { offsets.push(labelColor.length); for (const lab of pal) { labelColor.push(addColor(lab)); labelOwner.push(r); } });
  // Eşleme: bölge pikseli kendi tonlarından en yakını; dışarısı tüm paletten en yakını.
  // Bölge pikselleri ton atamasından önce bölgeyle sınırlı bulanıklaştırılır: yumuşak gölgede ton sınırı
  // piksel gürültüsüne değil, gölgenin eş-ışık eğrisine oturur (pürüzsüz bant kenarı).
  // Palet rengi → o rengi taşıyan ilk etiket (bölge dışı piksel bir bölge tonuna en yakınsa o tonun etiketini alır)
  const labelOfColor = new Map();
  labelColor.forEach((c, l) => { if (!labelOfColor.has(c)) labelOfColor.set(c, l); });
  const nearest = mapToPalette(rgba, palette);
  const labels = new Int32Array(n);
  for (let p = 0; p < n; p++) labels[p] = nearest[p] === 255 ? -1 : labelOfColor.get(nearest[p]);
  const labCache = new Map();
  for (let p = 0; p < n; p++) {
    const r = owner[p];
    if (r < 0 || labels[p] < 0) continue;
    const pal = local[r];
    if (pal.length === 1) { labels[p] = offsets[r]; continue; }
    if (cel[r]) {
      // Parlaklık seviyesine göre bant
      const i = p * 4, l = srgbToLab(softSrc[i], softSrc[i + 1], softSrc[i + 2])[0];
      let b = 0; while (b < cel[r].thresholds.length && l >= cel[r].thresholds[b]) b++;
      labels[p] = offsets[r] + cel[r].bandMap[b];
      continue;
    }
    const i = p * 4, key = ((softSrc[i] >> 3) << 10) | ((softSrc[i + 1] >> 3) << 5) | (softSrc[i + 2] >> 3);
    let lab = labCache.get(key);
    if (!lab) { lab = srgbToLab((softSrc[i] & 0xf8) + 4, (softSrc[i + 1] & 0xf8) + 4, (softSrc[i + 2] & 0xf8) + 4); labCache.set(key, lab); }
    let best = 0, bd = Infinity;
    for (let c = 0; c < pal.length; c++) { const dd = dist2(lab, pal[c]); if (dd < bd) { bd = dd; best = c; } }
    labels[p] = offsets[r] + best;
  }
  // Ortak paletteki geçiş tonları (bulanık kenar karışımları) atılır; bölge tonlarına dokunulmaz
  if (palette.length > 2) {
    const drop = new Set([...findTransitionColors(labels, width, height, palette.map((_, c) => palette[c]), { colorOf: labelColor })].filter((c) => c < globalCount));
    if (drop.size) {
      // Atılan rengin pikseli, kalan tüm renkler (ortak + bölge tonları) arasından en yakınını alır; ton ise o
      // tonun etiketine geçer (kontur dibindeki gölge pikseli komşu bölgenin koyu tonuna katılır).
      const keep = palette.map((_, c) => c).filter((c) => !drop.has(c));
      const remap = new Map();
      for (let p = 0; p < n; p++) {
        if (labels[p] < 0 || labelOwner[labels[p]] >= 0 || !drop.has(labelColor[labels[p]])) continue;
        const i = p * 4, key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
        let best = remap.get(key);
        if (best === undefined) {
          const lab = srgbToLab((rgba[i] & 0xf8) + 4, (rgba[i + 1] & 0xf8) + 4, (rgba[i + 2] & 0xf8) + 4);
          let bd = Infinity;
          for (const c of keep) { const dd = dist2(lab, palette[c]); if (dd < bd) { bd = dd; best = c; } }
          remap.set(key, best);
        }
        labels[p] = labelOfColor.get(best);
      }
    }
  }
  if (snapRadius > 0) snapBlends(rgba, labels, owner, palette, labelColor, labelOwner, width, height, snapRadius);
  const smoothed = smooth > 0 ? modeFilter(labels, width, height, smooth, labelColor.length) : labels;
  return { labels: smoothed, palette, labelColor, labelOwner, owner, regions, width, height };
}

// Etiketli görüntüyü boyar: renk, etiketin palet rengine bağlı tüm piksellerin iç ortalamasıdır (paintIndexed).
export function paintLabels(rgba, labels, plan, width, height) {
  const idx = new Int32Array(labels.length);
  for (let p = 0; p < labels.length; p++) idx[p] = labels[p] < 0 ? -1 : plan.labelColor[labels[p]];
  return paintIndexed(rgba, idx, plan.palette.length, width, height);
}

// Eski arayüz: planı aynı çözünürlükte boyar (testler ve tek ölçekli kullanım).
export function applyRegionPalette(rgba, width, height, analysis, opts = {}) {
  const plan = buildRegionLabels(rgba, width, height, analysis, opts);
  return paintLabels(rgba, plan.labels, plan, width, height);
}

// Yumuşak bölgeler: birden çok tonlu düz bölgeler. Boyalı görüntüde tek (en yaygın) tona indirilir; ton bantları
// ayrı katman olarak döndürülür (çağıran bunları bulanıklaştırıp bölgeye kırparak üstüne çizer). Boyalı görüntü
// yerinde değiştirilir. Dönüş: [{ pixels (bölgenin piksel sıraları, bu çözünürlükte), bands (rgba), tones }].
export function extractSoftRegions(painted, labels, plan, width, height) {
  // Üyelik uzamsal `owner` haritasından (bölgeleme + kenara yapışan pikseller); etiket rengi aynı olan uzak
  // pikseller bölgeye girmez.
  const { owner, regions } = plan;
  const members = regions.map(() => []);
  for (let p = 0; p < labels.length; p++) { const r = owner[p]; if (r >= 0 && labels[p] >= 0) members[r].push(p); }
  const soft = [];
  regions.forEach((r, ri) => {
    if (r.gradient || !members[ri].length) return;
    const count = new Map();
    for (const p of members[ri]) count.set(labels[p], (count.get(labels[p]) ?? 0) + 1);
    if (count.size < 2) return;
    const baseLabel = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const bands = new Uint8Array(painted.length);
    let base = null;
    for (const p of members[ri]) { const i = p * 4; bands[i] = painted[i]; bands[i + 1] = painted[i + 1]; bands[i + 2] = painted[i + 2]; bands[i + 3] = 255; if (!base && labels[p] === baseLabel) base = [painted[i], painted[i + 1], painted[i + 2]]; }
    for (const p of members[ri]) { const i = p * 4; painted[i] = base[0]; painted[i + 1] = base[1]; painted[i + 2] = base[2]; }
    soft.push({ pixels: Uint32Array.from(members[ri]), bands, tones: count.size });
  });
  return { soft, members };
}

// Bantları bölge dışına `radius` piksel genişletir (bulanıklaştırınca kenarda saydamlığa sönmesin; kırpma zaten
// bölge sınırında keser). Her turda boş piksel dolu 4-komşusunun rengini alır.
export function dilateBands(bands, width, height, radius) {
  let src = bands;
  for (let t = 0; t < radius; t++) {
    const out = src.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, i = p * 4;
        if (src[i + 3]) continue;
        const q = (x > 0 && src[i - 1]) ? p - 1 : (x < width - 1 && src[i + 7]) ? p + 1 : (y > 0 && src[i - width * 4 + 3]) ? p - width : (y < height - 1 && src[i + width * 4 + 3]) ? p + width : -1;
        if (q < 0) continue;
        out[i] = src[q * 4]; out[i + 1] = src[q * 4 + 1]; out[i + 2] = src[q * 4 + 2]; out[i + 3] = 255;
      }
    }
    src = out;
  }
  return src;
}

// Bölgeyle sınırlı kutu bulanıklığı (iki geçiş ≈ Gauss). Yalnızca aynı bölgedeki pikseller ortalamaya girer.
function maskedBlur(rgba, owner, width, height, radius) {
  const n = width * height;
  let src = rgba;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Uint8Array(rgba.length);
    // Yatay sonra dikey ayrılabilir geçiş
    const tmp = new Float32Array(n * 3), cnt = new Int32Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, o = owner[p];
        if (o < 0) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const q = y * width + xx;
          if (owner[q] !== o) continue;
          r += src[q * 4]; g += src[q * 4 + 1]; b += src[q * 4 + 2]; c++;
        }
        tmp[p * 3] = r / c; tmp[p * 3 + 1] = g / c; tmp[p * 3 + 2] = b / c; cnt[p] = c;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, o = owner[p];
        if (o < 0) { out[p * 4] = src[p * 4]; out[p * 4 + 1] = src[p * 4 + 1]; out[p * 4 + 2] = src[p * 4 + 2]; out[p * 4 + 3] = src[p * 4 + 3]; continue; }
        let r = 0, g = 0, b = 0, c = 0;
        for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
          const q = yy * width + x;
          if (owner[q] !== o) continue;
          r += tmp[q * 3]; g += tmp[q * 3 + 1]; b += tmp[q * 3 + 2]; c++;
        }
        out[p * 4] = Math.round(r / c); out[p * 4 + 1] = Math.round(g / c); out[p * 4 + 2] = Math.round(b / c); out[p * 4 + 3] = 255;
      }
    }
    src = out;
  }
  return src;
}

// Karışım piksellerini uçlara yapıştırır. Bölge dışı bir pikselin rengi, çevresindeki (yarıçap r) iki palet
// renginin arasındaysa (C ≈ A + t·(B−A)), yakın olduğu uca eşlenir. Kontur ile dolgu arasındaki bulanık kahverengi
// şerit böylece ya kontura ya dolguya katılır; ikinci bir "gölge kontur" oluşmaz. Yalnızca bölge piksellerinin
// renkleri uç olarak alınır (onlar güvenilir); kontur pikselleri kendi aralarında dokunulmadan kalır.
function snapBlends(rgba, labels, owner, palette, labelColor, labelOwner, width, height, r) {
  const out = labels.slice();
  const newOwner = owner.slice();
  const cache = new Map();
  const labOf = (p) => {
    const i = p * 4, key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let lab = cache.get(key);
    if (!lab) { lab = srgbToLab((rgba[i] & 0xf8) + 4, (rgba[i + 1] & 0xf8) + 4, (rgba[i + 2] & 0xf8) + 4); cache.set(key, lab); }
    return lab;
  };
  const near = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (owner[p] >= 0 || labels[p] < 0) continue;
      near.length = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx++) {
          const q = yy * width + xx;
          const l = labels[q];
          if (l < 0 || owner[q] < 0) continue;
          if (!near.includes(l)) near.push(l);
        }
      }
      if (!near.length) continue;
      // Uç adayları: komşu bölge tonları + pikselin kendi etiketi (kontur rengi olabilir). Penceredeki tüm
      // etiketleri uç almak denendi: ΔE 4,44 → 4,58, vazgeçildi.
      const ends = near.slice();
      if (!ends.includes(labels[p])) ends.push(labels[p]);
      const C = labOf(p);
      // Piksel komşu bir bölge tonuyla neredeyse aynı renkteyse doğrudan o tona katılır (kenar bölgesindeki saf
      // dolgu pikseli ortak paletin yakın ama farklı rengine gitmesin; kontur gerçek genişliğinde kalsın)
      let nearTone = -1, nearD = 5;
      for (const l of near) { const d = Math.sqrt(dist2(C, palette[labelColor[l]])); if (d < nearD) { nearD = d; nearTone = l; } }
      if (nearTone >= 0) { out[p] = nearTone; newOwner[p] = labelOwner[nearTone]; continue; }
      let best = -1, bestD = 12; // ΔE < 12: doğru parçasına yeterince yakın
      for (let a = 0; a < ends.length; a++) {
        for (let b = a + 1; b < ends.length; b++) {
          const A = palette[labelColor[ends[a]]], B = palette[labelColor[ends[b]]];
          const AB = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
          const len2 = AB[0] ** 2 + AB[1] ** 2 + AB[2] ** 2;
          if (len2 < 100) continue; // uçlar zaten aynı renk
          const t = ((C[0] - A[0]) * AB[0] + (C[1] - A[1]) * AB[1] + (C[2] - A[2]) * AB[2]) / len2;
          if (t <= 0.05 || t >= 0.95) continue;
          const P = [A[0] + t * AB[0], A[1] + t * AB[1], A[2] + t * AB[2]];
          const d = Math.sqrt(dist2(C, P));
          if (d < bestD) { bestD = d; best = t < 0.5 ? ends[a] : ends[b]; }
        }
      }
      if (best >= 0) { out[p] = best; newOwner[p] = labelOwner[best]; } // yapışan piksel o bölgeye katılır (maske ve bantlar için)
    }
  }
  labels.set(out);
  owner.set(newOwner);
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
  let labelFills = null; // fills === 'fit': etiket → dolgu modeli
  const softRegions = [];
  if (o.binary) pixels = toBlackAndWhite(rgba, threshold);
  else if (o.paletteColors) {
    // Pürüzsüzleştirme yarıçapı büyütme oranıyla ölçeklenir (orijinal görselde ~1 piksel).
    // Çoğunluk filtresi yarıçapı: ölçekle ama küçük ayrıntı (göz, diş) silinmesin diye en fazla 2
    const smooth = o.smooth ? Math.min(2, Math.max(1, Math.round(o.smooth * Math.max(1, scale)))) : 0;
    if (o.regions) {
      // Bölgeleme büyütülmüş görselde, ölçeğe duyarlı kenar maskesiyle (gradients.js). Kenar çevresindeki
      // pikseller (kontur ve konturun dibindeki koyu gölge) bölgeye girmez, ortak paletle boyanır: çizgi film
      // gölgelemesindeki "kontur dibi gölgesi" böyle korunur. Denendi ve vazgeçildi: bölgelemeyi özgün
      // çözünürlükte yapıp etiketleri büyütmek konturu inceltiyor ama bu gölgeyi siliyor (ΔE 6,8 → 10, görüntü
      // pastel ve düz kalıyor).
      // Küçük ama anlamlı alanlar (göz akı, diş) da bölge olsun: eşik görselin %0,05'i (en az 100 piksel)
      const analysis = analyzeRegions(rgba, width, height, { max: LIMITS.maxGradients, scale, edgeRadius: o.edgeRadius, minArea: Math.max(100, Math.round(width * height * (o.minAreaShare ?? 0.0005))) });
      const plan = buildRegionLabels(rgba, width, height, analysis, {
        maxColors: o.paletteColors, smooth, localColors: o.localColors, localTarget: o.localTarget, tones: o.tones ?? 'kmeans', celStep: o.celStep,
        // Yapıştırma yalnızca kenar rampası genişliğinde (≈ ölçek); daha genişi göz gibi küçük ayrıntıları eritir
        snapRadius: o.snapRadius ?? Math.max(1, Math.round(scale)), blurRadius: o.blurRadius ?? Math.max(1, Math.round((o.tones === 'cel' ? 3 : 1.5) * scale)),
      });
      if (o.fills === 'fit') {
        // Her etiket (bölge bandı, kontur, ortak renk) VTracer'a eşsiz sahte renkle verilir; yollar etikete geri
        // çözülüp dolgusu etiketin kendi modeliyle (düz ya da doğrusal gradyan) değiştirilir. Gradyan bölgeleri
        // (dairesel/doğrusal) kendi uydurmasını korur.
        labelFills = fitLabelFills(rgba, plan.labels, plan.labelColor.length, width, height);
        analysis.gradients.forEach((g, gi) => { const l = plan.labels[g.pixels[0]]; if (l >= 0 && plan.labelOwner[l] === gi) labelFills[l] = { kind: g.fill.kind, ...g.fill }; });
        pixels = new Uint8Array(rgba.length);
        for (let p = 0; p < plan.labels.length; p++) {
          const l = plan.labels[p]; if (l < 0) continue;
          const c = encodeLabel(l), i = p * 4; pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
        }
      } else {
        pixels = paintLabels(rgba, plan.labels, plan, width, height);
        // Bölge üyeliği son etiketlerden (kenara yapışan pikseller dahil): maskeler halkasız
        const { soft, members } = extractSoftRegions(o.soft ? pixels : pixels.slice(), plan.labels, plan, width, height);
        if (o.soft) softRegions.push(...soft);
        gradients = analysis.gradients.map((g, gi) => ({ ...g, pixels: Uint32Array.from(members[gi]) })).filter((g) => g.pixels.length);
      }
    } else {
      pixels = applyPalette(rgba, findPalette(rgba, { maxColors: o.paletteColors }), width, height, { smooth });
    }
  }
  else pixels = rgba;
  const asBytes = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  let svg = wasm.vectorize(
    asBytes(pixels), width, height, Boolean(o.binary), Boolean(cutout), o.filterSpeckle, labelFills ? 8 : o.colorPrecision,
    labelFills ? 0 : o.layerDifference, o.cornerThreshold, o.lengthThreshold, o.spliceThreshold, 2,
  );
  if (labelFills) {
    // Sahte renkleri etiket dolgularına çevir
    const defs = []; const defId = new Map();
    // VTracer kırıntı birleştirirken renkleri ortalar; sahte renk tam eşleşmezse en yakın gerçek etikete çözülür
    const encoded = labelFills.map((f, l) => (f ? encodeLabel(l) : null));
    const nearestLabel = (hex) => {
      const exact = decodeLabel(hex);
      if (labelFills[exact] && encoded[exact] && hex === '#' + encoded[exact].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()) return exact;
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      let best = -1, bd = Infinity;
      encoded.forEach((c, l) => { if (!c) return; const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (dd < bd) { bd = dd; best = l; } });
      return best;
    };
    svg = svg.replace(/<path d="([^"]+)" fill="(#[0-9A-F]{6})"\/>/g, (m, d, hex) => {
      const l = nearestLabel(hex); const f = l >= 0 ? labelFills[l] : null;
      if (!f) return `<path d="${d}" fill="${hex}"/>`;
      if (f.kind === 'flat') return `<path d="${d}" fill="${'#' + f.color.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}"/>`;
      let id = defId.get(l);
      if (!id) { id = `g${defId.size + 1}`; defId.set(l, id); defs.push(gradientDef(id, f)); }
      return `<path d="${d}" fill="url(#${id})"/>`;
    });
    if (defs.length) svg = svg.replace(/(<svg\b[^>]*>)/, `$1\n<defs>${defs.join('')}</defs>`);
  }
  if (gradients.length || softRegions.length) {
    const defs = [], paths = [];
    const traceMask = (region) => {
      const traced = wasm.vectorize(regionMask(region, width, height), width, height, true, false, o.filterSpeckle, 8, 16,
        o.cornerThreshold, o.lengthThreshold, o.spliceThreshold, 2);
      return [...traced.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    };
    // Yumuşak bölgeler: ton bantları bulanıklaştırılıp bölge şekline kırpılır (airbrush gölgesi; kenarlar keskin kalır).
    // Bulanıklık yarıçapı büyütme oranıyla ölçeklenir (orijinalde ~1 piksel).
    const blur = Math.round(10 * (o.softBlur ?? 1) * Math.max(1, scale)) / 10;
    const minSoft = Math.max(1500, Math.round(width * height * 0.005)); // küçük bölgede yumuşatma göze çarpmaz, yol şişirir
    softRegions.forEach((r, i) => {
      if (r.pixels.length < minSoft) return;
      const clip = traceMask(r);
      if (!clip.length) return;
      const bands = dilateBands(r.bands, width, height, Math.ceil(blur * 2));
      // Bantlar bulanıklaşacağı için küçük kırıntılar görünmez: kırıntı eşiği 4 kat (yol sayısı düşer)
      const traced = wasm.vectorize(bands, width, height, false, false, o.filterSpeckle * 4, 8, 4,
        o.cornerThreshold, o.lengthThreshold, o.spliceThreshold, 2);
      const bandPaths = [...traced.matchAll(/<path d="[^"]+" fill="#[0-9A-F]{6}"\/>/g)].map((m) => m[0]);
      if (bandPaths.length < 2) return;
      const id = i + 1;
      defs.push(`<clipPath id="c${id}">${clip.map((d) => `<path d="${d}"/>`).join('')}</clipPath>`);
      defs.push(`<filter id="f${id}"><feGaussianBlur stdDeviation="${blur}"/></filter>`);
      paths.push(`<g clip-path="url(#c${id})" filter="url(#f${id})">${bandPaths.join('')}</g>`);
    });
    // Her gradyan bölgesi ikili maske olarak ayrıca izlenir ve düz çizimin üstüne gradyan dolgulu yol eklenir.
    gradients.forEach((g, i) => {
      const ds = traceMask(g);
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
  if (check.stats.soft) warnings.push(`${check.stats.soft} yumuşak gölge katmanı (bulanıklık filtresi): kesim makineleri ve bazı eski programlar filtreyi yok sayar.`);
  return { svg, stats: check.stats, warnings };
}

// Yüksek sadakat için çalışma boyutu: netleştirilmiş 4× görsel maxPixels'i aşıyorsa 2× boyuta indirilir (kutu
// ortalaması). Ölçüm: 640×480 anime karesi 4×'te 5 bit sınırı aşıyor (4 bit %14,5), 2×'te 5 bit %0,1
// (docs/vektor-kanit.md). Dönüş: { rgba, width, height, scale } (scale: uygulanan küçültme, 1 ya da 2).
export const EXACT_MAX_PIXELS = 1_400_000;
export function shrinkForExact(rgba, width, height, maxPixels = EXACT_MAX_PIXELS) {
  if (width * height <= maxPixels) return { rgba, width, height, scale: 1 };
  const w = Math.floor(width / 2), h = Math.floor(height / 2), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0, g = 0, b = 0, a = 0, c = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((2 * y + dy) * width + 2 * x + dx) * 4;
        a += rgba[i + 3];
        if (rgba[i + 3] >= 128) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; c++; }
      }
      if (c) { out[o] = Math.round(r / c); out[o + 1] = Math.round(g / c); out[o + 2] = Math.round(b / c); }
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { rgba: out, width: w, height: h, scale: 2 };
}

// Renk seviyesi azaltma (posterize): her kanal 2^bits seviyeye yuvarlanır (seviye ortası). Kayıpsız izlemede yol
// sayısını sınırlar: AI ile netleştirilmiş 4× görselde 5 bit (32 seviye/kanal) → ~2.500 renk, orijinale göre
// belirgin fark %1,8 (ölçüm: docs/vektor-kanit.md). Saydam pikseller değişmez.
export function posterize(rgba, bits = 5) {
  const step = 256 >> bits, half = step >> 1;
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) { out[i + 3] = 0; continue; }
    out[i] = Math.min(255, (rgba[i] - rgba[i] % step) + half);
    out[i + 1] = Math.min(255, (rgba[i + 1] - rgba[i + 1] % step) + half);
    out[i + 2] = Math.min(255, (rgba[i + 2] - rgba[i + 2] % step) + half);
    out[i + 3] = 255;
  }
  return out;
}

// Kayıpsız (piksel kusursuz) vektör: her renk bölgesi piksel kenarları boyunca tam sayı koordinatlarla
// izlenir. Orijinal boyutta çizildiğinde her piksel orijinalle aynıdır (Chromium ve resvg ile doğrulandı:
// docs/vektor-kanit.md). Büyütüldüğünde kenarlar piksel basamaklıdır; pürüzsüz eğri istenirse diğer ayarlar.
// colorBits verilirse önce renk seviyeleri azaltılır (posterize) ve kayıpsızlık bu azaltılmış görsele göredir
// ("yüksek sadakat": netleştirilmiş 4× görsel için).
export function vectorizeExact(rgba, width, height, { colorBits } = {}) {
  if (!wasm) throw new Error('Vektör motoru yüklenmedi (initVectorizer).');
  let pixels = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (colorBits) pixels = posterize(pixels, colorBits);
  const svg = wasm.vectorize_exact(pixels, width, height);
  // crispEdges korunur: kenar yumuşatmalı çizimde komşu şekiller arasında çizgi boşlukları (resvg'de yarı boyutta
  // piksellerin %42'si) oluşuyor; crispEdges ile 1:1 ve tam sayı ölçeklerde birebir, küçültmede nokta örnekleme.
  const check = validateSvg(svg);
  if (!check.ok) throw new Error('Vektör çıktısı doğrulanamadı: ' + check.errors.slice(0, 3).join('; '));
  if (check.stats.paths > LIMITS.maxPaths || check.stats.bytes > LIMITS.maxBytes) {
    throw new Error('Görselde çok fazla farklı renk var (fotoğraf olabilir); kayıpsız vektör çok büyük olur. "Logo" ya da "Çizim" ayarını dene.');
  }
  // Garanti: SVG'yi geri çizip orijinalle piksel piksel karşılaştır; tek fark bile varsa çıktı verilmez.
  const diff = verifyExact(svg, pixels, width, height);
  if (diff) throw new Error(`Kayıpsız vektör doğrulanamadı: ${diff}`);
  const warnings = colorBits ? [`Renkler kanal başına ${1 << colorBits} seviyeye yuvarlandı; çıktı bu yuvarlanmış görselle piksel piksel aynı.`] : [];
  return { svg, stats: check.stats, warnings };
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

const ALLOWED_ELEMENTS = new Set(['svg', 'path', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'filter', 'feGaussianBlur', 'g']);
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
  const stats = { paths: 0, subpaths: 0, bytes: svg.length, colors: 0, gradients: 0, soft: 0 };
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
  let clip = null; // { id, paths }
  let filter = null; // { id, blurs }
  let group = null; // { paths }
  const clipIds = new Set(), filterIds = new Set();
  const usedIds = new Set();
  const checkAttrs = (tag, allowed, what) => {
    for (const a of [...tag.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1])) if (!allowed.includes(a)) errors.push(`${what} izin verilmeyen öznitelik: ${a}`);
  };
  for (const tag of tags) {
    const closing = tag.startsWith('</');
    const name = /^<\/?\s*([a-zA-Z]+)/.exec(tag)?.[1];
    if (!ALLOWED_ELEMENTS.has(name) || name === 'svg') { errors.push(`izin verilmeyen öğe: ${tag.slice(0, 40)}`); continue; }
    if (name === 'defs') {
      if (!closing) { if (state !== 'start') errors.push('<defs> yalnızca en başta ve bir kez olabilir'); state = 'defs'; }
      else { if (state !== 'defs' || gradient || clip || filter) errors.push('<defs> yanlış kapatıldı'); state = 'paths'; }
      continue;
    }
    if (name === 'clipPath') {
      if (state !== 'defs' || gradient || filter) { errors.push('clipPath yalnızca <defs> içinde olabilir'); continue; }
      if (closing) { if (!clip) errors.push('clipPath yanlış kapatıldı'); else if (!clip.paths) errors.push(`${clip.id}: boş clipPath`); clip = null; continue; }
      if (clip) { errors.push('iç içe clipPath'); continue; }
      const id = attr(tag, 'id');
      checkAttrs(tag, ['id'], 'clipPath');
      if (!/^c\d{1,4}$/.test(id ?? '')) errors.push(`geçersiz clipPath kimliği: ${id}`);
      else if (clipIds.has(id)) errors.push(`yinelenen kimlik: ${id}`);
      else clipIds.add(id);
      clip = { id, paths: 0 };
      continue;
    }
    if (name === 'filter') {
      if (state !== 'defs' || gradient || clip) { errors.push('filter yalnızca <defs> içinde olabilir'); continue; }
      if (closing) { if (!filter) errors.push('filter yanlış kapatıldı'); else if (filter.blurs !== 1) errors.push(`${filter.id}: filtre tam olarak bir feGaussianBlur içermeli`); filter = null; continue; }
      if (filter) { errors.push('iç içe filter'); continue; }
      const id = attr(tag, 'id');
      checkAttrs(tag, ['id'], 'filter');
      if (!/^f\d{1,4}$/.test(id ?? '')) errors.push(`geçersiz filter kimliği: ${id}`);
      else if (filterIds.has(id)) errors.push(`yinelenen kimlik: ${id}`);
      else filterIds.add(id);
      filter = { id, blurs: 0 };
      continue;
    }
    if (name === 'feGaussianBlur') {
      if (!filter) { errors.push('feGaussianBlur yalnızca filter içinde olabilir'); continue; }
      if (!tag.endsWith('/>')) { errors.push('feGaussianBlur kendini kapatmalı'); continue; }
      checkAttrs(tag, ['stdDeviation'], 'feGaussianBlur');
      const sd = attr(tag, 'stdDeviation');
      if (!finite(sd) || !(+sd > 0) || +sd > Math.max(vw, vh) * 0.05) errors.push(`${filter.id}: geçersiz bulanıklık (${sd})`);
      filter.blurs++;
      continue;
    }
    if (name === 'g') {
      if (state === 'defs') { errors.push('<g> defs içinde olamaz'); continue; }
      state = 'paths';
      if (closing) { if (!group) errors.push('<g> yanlış kapatıldı'); else if (group.paths < 1) errors.push('boş <g>'); group = null; continue; }
      if (group) { errors.push('iç içe <g>'); continue; }
      checkAttrs(tag, ['clip-path', 'filter'], '<g>');
      const c = /^url\(#(c\d{1,4})\)$/.exec(attr(tag, 'clip-path') ?? '')?.[1], f = /^url\(#(f\d{1,4})\)$/.exec(attr(tag, 'filter') ?? '')?.[1];
      if (!c || !clipIds.has(c)) errors.push('<g> geçerli bir clip-path kullanmalı');
      if (!f || !filterIds.has(f)) errors.push('<g> geçerli bir filter kullanmalı');
      if (c) usedIds.add(c); if (f) usedIds.add(f);
      group = { paths: 0 };
      stats.soft++;
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
    if (!tag.endsWith('/>')) { errors.push('path kendini kapatmalı'); continue; }
    if (/transform=/.test(tag)) errors.push('path transform içermemeli');
    const d = attr(tag, 'd');
    if (clip) {
      // Kırpma yolu: yalnızca d
      checkAttrs(tag, ['d'], 'kırpma yolunda');
      clip.paths++;
    } else {
      if (state === 'defs') { errors.push('<defs> kapanmadan path geldi'); continue; }
      state = 'paths';
      checkAttrs(tag, ['d', 'fill', 'fill-opacity'], "path'te");
      const op = attr(tag, 'fill-opacity');
      if (op !== undefined && !(/^(0|1|0?\.\d+)$/.test(op) && Number(op) > 0 && Number(op) <= 1)) errors.push(`geçersiz fill-opacity: ${op}`);
      const fill = attr(tag, 'fill');
      const ref = /^url\(#(g\d{1,4})\)$/.exec(fill ?? '');
      if (ref) { if (!gradientIds.has(ref[1])) errors.push(`tanımsız gradyan: ${ref[1]}`); else { stats.gradients++; usedIds.add(ref[1]); } }
      else if (!/^#[0-9A-Fa-f]{6}$/.test(fill ?? '')) errors.push(`geçersiz renk: ${fill}`);
      else colors.add(fill.toUpperCase());
      if (group) group.paths++;
    }
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
  if (state === 'defs' || gradient || clip || filter) errors.push('<defs> ya da içindeki bir tanım kapatılmadı');
  if (group) errors.push('<g> kapatılmadı');
  for (const id of [...gradientIds, ...clipIds, ...filterIds]) if (!usedIds.has(id)) errors.push(`kullanılmayan tanım: ${id}`);
  stats.colors = colors.size;
  return { ok: errors.length === 0, errors: [...new Set(errors)], stats };
}
