// AI netleştirme (büyütme): waifu2x swin_unet "art" 4× modeli (nunif, MIT) tarayıcıda onnxruntime-web ile çalışır.
// Çizim, logo ve küçük ürün görsellerinde kenarları netleştirir, ayrıntıyı toparlar; görsel hiçbir yere gönderilmez.
// Bu modül saf veri hazırlığı/birleştirme yapar (Node'da test edilir); modeli çalıştıran upscale-worker.js'dir.

export const SCALE = 4;
/** Model her kenardan bu kadar pikseli "bağlam" olarak ister; çıktıda 4·OFF − 32 piksel kenar payı düşer. */
export const OFF = 16;
/** Döşeme boyutu (giriş pikseli). Bellek sınırlı kalsın diye büyük görsel parçalara bölünür. */
export const TILE = 128;
/** En fazla bu kadar giriş pikseli işlenir (4× çıktı = 16 kat piksel). */
export const MAX_INPUT_PIXELS = 1024 * 1024;

const reflect = (v, n) => (v < 0 ? -v : v >= n ? Math.max(0, 2 * n - v - 2) : v);

/**
 * Saydam pikselleri komşu renklerle doldurur (model kenarda beyaz hale üretmesin). Alfa aynen kalır.
 * @returns {Uint8ClampedArray} yeni RGBA
 */
export function fillTransparent(rgba, w, h, maxIter = 64) {
  const out = new Uint8ClampedArray(rgba);
  let pending = [];
  for (let p = 0; p < w * h; p++) if (rgba[p * 4 + 3] < 128) pending.push(p);
  if (!pending.length || pending.length === w * h) return out;
  const filled = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) filled[p] = rgba[p * 4 + 3] >= 128 ? 1 : 0;
  for (let it = 0; it < maxIter && pending.length; it++) {
    const next = [], done = [];
    for (const p of pending) {
      const x = p % w, y = (p - x) / w;
      let r = 0, g = 0, b = 0, c = 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && filled[q]) { r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; c++; }
      }
      if (c) { out[p * 4] = Math.round(r / c); out[p * 4 + 1] = Math.round(g / c); out[p * 4 + 2] = Math.round(b / c); done.push(p); }
      else next.push(p);
    }
    for (const p of done) filled[p] = 1;
    pending = next;
  }
  return out;
}

/** Görseli döşemelere böler. Her döşeme: giriş koordinatları (x,y,w,h) ve OFF kadar yansımalı dolgulu tensör. */
export function planTiles(w, h, tile = TILE) {
  const tiles = [];
  for (let y = 0; y < h; y += tile) for (let x = 0; x < w; x += tile) {
    const tw = Math.min(tile, w - x), th = Math.min(tile, h - y);
    tiles.push({ x, y, w: tw, h: th });
  }
  return tiles;
}

/** Döşemenin modele girecek tensörünü (1×3×H×W, 0..1) üretir. H ve W 4'ün katı olacak şekilde sağ/alt dolgulanır. */
export function tileTensor(rgba, w, h, t) {
  const ph = (4 - (t.h % 4)) % 4, pw = (4 - (t.w % 4)) % 4; // JS'de (-n) % 4 eksi çıkar; 4'e tamamlama böyle
  const H = t.h + 2 * OFF + ph, W = t.w + 2 * OFF + pw;
  const data = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) {
    const sy = reflect(t.y + y - OFF, h);
    for (let x = 0; x < W; x++) {
      const sx = reflect(t.x + x - OFF, w);
      const i = (sy * w + sx) * 4;
      data[y * W + x] = rgba[i] / 255;
      data[H * W + y * W + x] = rgba[i + 1] / 255;
      data[2 * H * W + y * W + x] = rgba[i + 2] / 255;
    }
  }
  return { data, dims: [1, 3, H, W] };
}

/** Model çıktısını (3×OH×OW, 0..1) çıktı RGBA'sına yerleştirir (alfa 255). Kenar payı 4·OFF − 32. */
export function placeTile(out, OW_total, y, dims, t) {
  const [, , OH, OW] = dims;
  const m = SCALE * OFF - 32;
  for (let yy = 0; yy < t.h * SCALE; yy++) {
    for (let xx = 0; xx < t.w * SCALE; xx++) {
      const src = (yy + m) * OW + (xx + m);
      const dst = ((t.y * SCALE + yy) * OW_total + t.x * SCALE + xx) * 4;
      out[dst] = Math.round(Math.min(1, Math.max(0, y[src])) * 255);
      out[dst + 1] = Math.round(Math.min(1, Math.max(0, y[OH * OW + src])) * 255);
      out[dst + 2] = Math.round(Math.min(1, Math.max(0, y[2 * OH * OW + src])) * 255);
      out[dst + 3] = 255;
    }
  }
}

/** Alfayı çift doğrusal büyütüp çıktıya yazar (kesim kenarları zaten yumuşak; model çalıştırmaya değmez). */
export function upscaleAlpha(rgba, w, h, out, scale = SCALE) {
  const W = w * scale, H = h * scale;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a = rgba[(y0 * w + x0) * 4 + 3] * (1 - fx) + rgba[(y0 * w + x1) * 4 + 3] * fx;
      const b = rgba[(y1 * w + x0) * 4 + 3] * (1 - fx) + rgba[(y1 * w + x1) * 4 + 3] * fx;
      out[(y * W + x) * 4 + 3] = Math.round(a * (1 - fy) + b * fy);
    }
  }
}

/** Girişin işlenebilir olup olmadığı; büyükse anlaşılır hata metni. */
export function checkInput(w, h) {
  if (!(w > 0 && h > 0)) return 'Görsel boş.';
  if (w * h > MAX_INPUT_PIXELS) return `Görsel AI netleştirme için çok büyük (${w}×${h}); en fazla ${MAX_INPUT_PIXELS / 1024 / 1024} megapiksel. Zaten yeterince büyük görsellerde netleştirme gerekmez.`;
  return null;
}
