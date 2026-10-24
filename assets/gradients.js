// Gölgeli bölge bulma ve gradyan sığdırma.
// Düz renkli izleme, yumuşak renk geçişlerini (gölge, ışık) üst üste renk bantlarına böler. Burada görseldeki
// yumuşak geçişli bölgeler bulunur ve her birine tek bir SVG gradyanı (doğrusal ya da dairesel) sığdırılır;
// sığan bölge tek yol olarak gradyanla boyanır. Yaklaşım: komşu pikseller renkleri çok az farklıysa aynı
// bölgeye girer (gerçek kenarlar renk sıçraması olduğu için bölgeyi böler); bölgenin renkleri konuma göre
// bir profile indirgenir; profil pikselleri yeterince iyi açıklıyorsa gradyan kabul edilir, yoksa bölge düz
// izlemeye bırakılır. Tarayıcıda ve Node'da (testler) çalışır.

/** Bulanık görüntüde komşular en fazla bu kadar (kanal başına) farklıysa aynı bölgeye girer. */
const STEP = 6;
/** 2d piksel aralıkta renk bu kadardan çok değişiyorsa kenardır (bkz. blurred). */
const EDGE = 14;
/** Gradyan adayı sayılmak için bölgenin ana renk ekseni en az bu kadar (sRGB) değişmeli. */
const MIN_RANGE = 28;
/** Kabul: artık hata (RMS, sRGB) en fazla bu kadar ve renk değişiminin en az bu payı açıklanmalı. */
const MAX_RMS = 7;
const MIN_EXPLAINED = 0.85;
/** Gradyan boyunca profil çözünürlüğü ve durak sadeleştirme toleransı. */
const BINS = 48;
const STOP_TOLERANCE = 4;
const MAX_STOPS = 8;
/** Sığmayan büyük bölge bu daha sıkı adımlarla yeniden bölünür; en az bu kadar piksellik parçalar denenir. */
const SPLIT_STEPS = [3, 2];
const SPLIT_MIN = 400;
const SPLIT_MIN_EXPLAINED = 0.5;

const LUMA = [0.299, 0.587, 0.114];

// 3×3 kutu bulanıklığı (yalnızca opak pikseller üzerinden). Gürültü ve JPEG kırıntısı bölgeleri parçalamasın.
// Ayrıca kenar maskesi: `d` piksel aralıklı merkezi fark (|C(p+d) − C(p−d)|) EDGE'i aşan piksel kenardır ve hiçbir
// bölgeye girmez. d = büyütme oranı: görsel 4× büyütülünce keskin kenar 4 piksellik rampaya döner, komşu farkı
// küçülür ve bölgeler kenardan sızarak birleşirdi; d aralıklı fark bunu ölçekten bağımsız yakalar. Yumuşak
// gradyan ise 2d piksellik aralıkta az değişir, kenar sayılmaz.
function blurred(rgba, w, h, d = 1) {
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), valid = new Uint8Array(n);
  for (let p = 0; p < n; p++) valid[p] = rgba[p * 4 + 3] >= 128 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!valid[p]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx; if (!valid[q]) continue;
          r += rgba[q * 4]; g += rgba[q * 4 + 1]; b += rgba[q * 4 + 2]; c++;
        }
      }
      R[p] = r / c; G[p] = g / c; B[p] = b / c;
    }
  }
  if (d >= 1) {
    const diff = (p, q) => Math.max(Math.abs(R[p] - R[q]), Math.abs(G[p] - G[q]), Math.abs(B[p] - B[q]));
    const opaque = valid.slice(); // kenar kararı özgün maskeye göre verilir (zincirleme aşınma olmasın)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!opaque[p]) continue;
        const xl = Math.max(0, x - d), xr = Math.min(w - 1, x + d), yu = Math.max(0, y - d), yd = Math.min(h - 1, y + d);
        const a = y * w + xl, b = y * w + xr, c = yu * w + x, e = yd * w + x;
        // Saydam komşu: kenar (nesne sınırı)
        if (!opaque[a] || !opaque[b] || !opaque[c] || !opaque[e] || diff(a, b) > EDGE || diff(c, e) > EDGE) valid[p] = 0;
      }
    }
  }
  return { R, G, B, valid };
}

// Birleşik-bul ile 4-komşuluk bölgeleme. `members` verilirse yalnızca o pikseller (1) bölgelenir.
function segment(members, w, h, R, G, B, valid, step, minSize) {
  const n = w * h;
  const parent = new Int32Array(n);
  for (let p = 0; p < n; p++) parent[p] = p;
  const find = (p) => { while (parent[p] !== p) p = parent[p] = parent[parent[p]]; return p; };
  const inside = (p) => valid[p] && (!members || members[p]);
  const near = (p, q) => inside(q) && Math.abs(R[p] - R[q]) <= step && Math.abs(G[p] - G[q]) <= step && Math.abs(B[p] - B[q]) <= step;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!inside(p)) continue;
      if (x + 1 < w && near(p, p + 1)) { const a = find(p), b = find(p + 1); if (a !== b) parent[a] = b; }
      if (y + 1 < h && near(p, p + w)) { const a = find(p), b = find(p + w); if (a !== b) parent[a] = b; }
    }
  }
  const size = new Int32Array(n);
  const root = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p++) if (inside(p)) { root[p] = find(p); size[root[p]]++; }
  const slot = new Int32Array(n).fill(-1);
  const lists = [];
  for (let p = 0; p < n; p++) if (root[p] === p && size[p] >= minSize) { slot[p] = lists.length; lists.push(new Uint32Array(size[p])); }
  const fill = new Int32Array(lists.length);
  for (let p = 0; p < n; p++) { const s = root[p] >= 0 ? slot[root[p]] : -1; if (s >= 0) lists[s][fill[s]++] = p; }
  return lists;
}

// Gauss eleme ile küçük doğrusal sistem (normal denklemler).
function solve(A, b) {
  const k = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-9) return null;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= k; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[k] / row[i]);
}

// Piksellerin t∈[0,1] konumuna göre renk profili (BINS kutu, boş kutular komşulardan doldurulur) ve bu profille
// yeniden üretimin hatası.
function profileFit(ts, cols, n, mean) {
  const sum = new Float64Array(BINS * 3), cnt = new Int32Array(BINS);
  for (let i = 0; i < n; i++) {
    const b = Math.min(BINS - 1, Math.floor(ts[i] * BINS));
    cnt[b]++; sum[b * 3] += cols[i * 3]; sum[b * 3 + 1] += cols[i * 3 + 1]; sum[b * 3 + 2] += cols[i * 3 + 2];
  }
  const prof = new Float64Array(BINS * 3);
  let last = -1;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b]) { for (let k = 0; k < 3; k++) prof[b * 3 + k] = sum[b * 3 + k] / cnt[b]; last = b; continue; }
    // Boş kutu: bir sonraki dolu kutuyla doğrusal ara değer (ya da en yakın dolu)
    let next = b + 1; while (next < BINS && !cnt[next]) next++;
    for (let k = 0; k < 3; k++) {
      const a = last >= 0 ? prof[last * 3 + k] : (next < BINS ? sum[next * 3 + k] / cnt[next] : mean[k]);
      const c = next < BINS ? sum[next * 3 + k] / cnt[next] : a;
      const f = last >= 0 && next < BINS ? (b - last) / (next - last) : 0;
      prof[b * 3 + k] = a + (c - a) * f;
    }
  }
  const at = (t, k) => {
    const x = Math.min(BINS - 1, Math.max(0, t * BINS - 0.5));
    const i = Math.floor(x), j = Math.min(BINS - 1, i + 1), f = x - i;
    return prof[i * 3 + k] * (1 - f) + prof[j * 3 + k] * f;
  };
  let sse = 0;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const e = cols[i * 3 + k] - at(ts[i], k); sse += e * e; }
  return { prof, rms: Math.sqrt(sse / (n * 3)), sse };
}

// Profili en az durakla temsil et (Douglas–Peucker; hata toleransı aşılırsa durak eklenir, en fazla MAX_STOPS).
function simplifyStops(prof) {
  const pts = [];
  for (let b = 0; b < BINS; b++) pts.push([(b + 0.5) / BINS, prof[b * 3], prof[b * 3 + 1], prof[b * 3 + 2]]);
  pts[0][0] = 0; pts[BINS - 1][0] = 1;
  for (let tol = STOP_TOLERANCE; ; tol *= 1.5) {
    const keep = new Uint8Array(BINS); keep[0] = keep[BINS - 1] = 1;
    const stack = [[0, BINS - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let worst = 0, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const f = (pts[i][0] - pts[a][0]) / (pts[b][0] - pts[a][0]);
        let e = 0;
        for (let k = 1; k <= 3; k++) e = Math.max(e, Math.abs(pts[a][k] + (pts[b][k] - pts[a][k]) * f - pts[i][k]));
        if (e > worst) { worst = e; wi = i; }
      }
      if (worst > tol && wi >= 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
    }
    const stops = [];
    for (let i = 0; i < BINS; i++) if (keep[i]) stops.push({ offset: pts[i][0], color: pts[i].slice(1).map((v) => Math.round(Math.min(255, Math.max(0, v)))) });
    if (stops.length <= MAX_STOPS) return stops;
  }
}

// Bir bölgeye gradyan sığdır. Dönüş: bölge nesnesi ya da null (düz renk / sığmadı). diag.explained dolar.
function fitRegion(pixels, w, rgba, diag) {
  const n = pixels.length;
  const xs = new Float64Array(n), ys = new Float64Array(n), cols = new Float64Array(n * 3);
  const mean = [0, 0, 0];
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
  for (let i = 0; i < n; i++) {
    const p = pixels[i], x = p % w, y = (p - x) / w;
    xs[i] = x; ys[i] = y; Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
    for (let k = 0; k < 3; k++) { const v = rgba[p * 4 + k]; cols[i * 3 + k] = v; mean[k] += v; }
  }
  for (let k = 0; k < 3; k++) mean[k] /= n;
  let sst = 0;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sst += (cols[i * 3 + k] - mean[k]) ** 2;
  const avg = mean.map(Math.round);
  diag.n = n; diag.sd = Math.sqrt(sst / (n * 3));
  if (sst / (n * 3) < 1) return null; // zaten düz

  // Doğrusal: her kanal için düzlem c = a + b·x + c·y; yön = parlaklık eğimi
  const A = [[n, Sx, Sy], [Sx, Sxx, Sxy], [Sy, Sxy, Syy]];
  let gx = 0, gy = 0, span = 0;
  for (let k = 0; k < 3; k++) {
    let Sc = 0, Scx = 0, Scy = 0;
    for (let i = 0; i < n; i++) { const v = cols[i * 3 + k]; Sc += v; Scx += v * xs[i]; Scy += v * ys[i]; }
    const s = solve(A, [Sc, Scx, Scy]);
    if (!s) return null;
    gx += LUMA[k] * s[1]; gy += LUMA[k] * s[2];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = s[0] + s[1] * xs[i] + s[2] * ys[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    span = Math.max(span, hi - lo);
  }
  const L = Math.hypot(gx, gy);
  diag.span = span;
  if (span < MIN_RANGE || L < 1e-9) { diag.explained = 0; return null; }
  const ux = gx / L, uy = gy / L;
  let tmin = Infinity, tmax = -Infinity;
  const proj = new Float64Array(n);
  for (let i = 0; i < n; i++) { const t = xs[i] * ux + ys[i] * uy; proj[i] = t; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) ts[i] = (proj[i] - tmin) / (tmax - tmin || 1);
  const lin = profileFit(ts, cols, n, mean);
  let best = { kind: 'linear', fit: lin, ts };

  // Dairesel: parlaklık ≈ a + b·x + c·y + d·(x²+y²) paraboloidinin tepe noktası merkez olur
  {
    let Sr = 0, Srr = 0, Sxr = 0, Syr = 0, Sl = 0, Slx = 0, Sly = 0, Slr = 0;
    for (let i = 0; i < n; i++) {
      const r = xs[i] * xs[i] + ys[i] * ys[i];
      const l = LUMA[0] * cols[i * 3] + LUMA[1] * cols[i * 3 + 1] + LUMA[2] * cols[i * 3 + 2];
      Sr += r; Srr += r * r; Sxr += xs[i] * r; Syr += ys[i] * r; Sl += l; Slx += l * xs[i]; Sly += l * ys[i]; Slr += l * r;
    }
    const s = solve([[n, Sx, Sy, Sr], [Sx, Sxx, Sxy, Sxr], [Sy, Sxy, Syy, Syr], [Sr, Sxr, Syr, Srr]], [Sl, Slx, Sly, Slr]);
    if (s && Math.abs(s[3]) > 1e-6) {
      const cx = -s[1] / (2 * s[3]), cy = -s[2] / (2 * s[3]);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) { if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i]; if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
      const padX = (maxX - minX) * 0.5, padY = (maxY - minY) * 0.5;
      if (cx >= minX - padX && cx <= maxX + padX && cy >= minY - padY && cy <= maxY + padY) {
        let rmax = 0;
        const rs = new Float64Array(n);
        for (let i = 0; i < n; i++) { rs[i] = Math.hypot(xs[i] - cx, ys[i] - cy); if (rs[i] > rmax) rmax = rs[i]; }
        if (rmax > 1) {
          const rts = new Float64Array(n);
          for (let i = 0; i < n; i++) rts[i] = rs[i] / rmax;
          const rad = profileFit(rts, cols, n, mean);
          if (rad.rms < lin.rms * 0.85) best = { kind: 'radial', fit: rad, ts: rts, cx, cy, r: rmax };
        }
      }
    }
  }

  const explained = 1 - best.fit.sse / sst;
  diag.explained = explained; diag.rms = best.fit.rms; diag.kind = best.kind;
  if (best.fit.rms > MAX_RMS || explained < MIN_EXPLAINED) return null;
  const stops = simplifyStops(best.fit.prof);
  let fill;
  if (best.kind === 'linear') {
    // Uç noktalar: bölge ağırlık merkezinden geçen eksende izdüşüm sınırları. İzdüşüm tam sayı piksel
    // köşesiyle hesaplandı; piksel merkezine almak için 0,5 kaydırılır.
    const cx = Sx / n + 0.5, cy = Sy / n + 0.5, c0 = cx * ux + cy * uy, d = 0.5 * (ux + uy);
    fill = {
      kind: 'linear',
      x1: cx + (tmin + d - c0) * ux, y1: cy + (tmin + d - c0) * uy,
      x2: cx + (tmax + d - c0) * ux, y2: cy + (tmax + d - c0) * uy,
      stops,
    };
  } else {
    fill = { kind: 'radial', cx: best.cx + 0.5, cy: best.cy + 0.5, r: best.r, stops };
  }
  return { fill, color: avg, pixels, rms: best.fit.rms, explained };
}

/**
 * Görseli renk-sürekli bölgelere ayırır ve her birine gradyan sığdırmayı dener.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @returns {{gradients: {fill, color:number[], pixels:Uint32Array, rms:number, explained:number}[], flats: {pixels:Uint32Array}[]}}
 *   gradients: gradyanla boyanacak bölgeler (büyükten küçüğe, en fazla `max`);
 *   flats: gradyana sığmayan büyük bölgeler (kendi içinde az sayıda düz tonla boyanır).
 */
export function analyzeRegions(rgba, w, h, { minArea, max = 24, scale = 1, onReject } = {}) {
  const n = w * h;
  minArea ??= Math.max(150, Math.round(n * 0.003));
  if (n < minArea) return { gradients: [], flats: [] };
  const { R, G, B, valid } = blurred(rgba, w, h, Math.max(1, Math.round(scale)));
  const gradients = [];
  const flats = [];
  const tryFit = (pixels, step) => {
    const diag = { explained: 0 };
    const g = fitRegion(pixels, w, rgba, diag);
    if (g) { gradients.push(g); return true; }
    onReject?.(pixels, step, diag);
    // Birbirine akan birkaç gradyan tek bölgeye birleşmiş olabilir: daha sıkı adımla böl ve parçaları dene
    const nextStep = step === STEP ? SPLIT_STEPS[0] : SPLIT_STEPS[SPLIT_STEPS.indexOf(step) + 1];
    if (nextStep === undefined || diag.explained < SPLIT_MIN_EXPLAINED || pixels.length < SPLIT_MIN * 2) return false;
    const members = new Uint8Array(n);
    for (const p of pixels) members[p] = 1;
    let any = false;
    for (const piece of segment(members, w, h, R, G, B, valid, nextStep, SPLIT_MIN)) if (tryFit(piece, nextStep)) any = true;
    return any;
  };
  for (const region of segment(null, w, h, R, G, B, valid, STEP, minArea)) {
    const before = gradients.length;
    if (tryFit(region, STEP)) {
      // Parçaları gradyan olan bölgenin kalan pikselleri düz bölge olur
      const taken = new Uint8Array(n);
      for (let i = before; i < gradients.length; i++) for (const p of gradients[i].pixels) taken[p] = 1;
      const rest = region.filter((p) => !taken[p]);
      if (rest.length >= minArea) flats.push({ pixels: rest });
    } else flats.push({ pixels: region });
  }
  gradients.sort((a, b) => b.pixels.length - a.pixels.length);
  const kept = gradients.slice(0, max);
  for (const g of gradients.slice(max)) flats.push({ pixels: g.pixels });
  return { gradients: kept, flats };
}

/** Yalnızca gradyan bölgeleri (geriye dönük kısa yol). */
export function findGradientRegions(rgba, w, h, opts = {}) {
  return analyzeRegions(rgba, w, h, opts).gradients;
}

/** Bölge piksellerini ortalama renge boyanmış kopya (düz izleme adımı bölgeyi tek parça görsün). */
export function flattenRegions(rgba, regions) {
  const out = new Uint8Array(rgba.length);
  out.set(rgba);
  for (const g of regions) for (const p of g.pixels) { out[p * 4] = g.color[0]; out[p * 4 + 1] = g.color[1]; out[p * 4 + 2] = g.color[2]; out[p * 4 + 3] = 255; }
  return out;
}

/** Bölgenin ikili maskesi: bölge siyah, gerisi beyaz (VTracer ikili modu için). */
export function regionMask(region, w, h) {
  const mask = new Uint8Array(w * h * 4).fill(255);
  for (const p of region.pixels) { mask[p * 4] = 0; mask[p * 4 + 1] = 0; mask[p * 4 + 2] = 0; }
  return mask;
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const num = (v) => (Math.round(v * 100) / 100 + 0).toString();

/** Gradyanın SVG <defs> tanımı. */
export function gradientDef(id, fill) {
  const stops = fill.stops.map((s) => `<stop offset="${num(s.offset)}" stop-color="${hex(s.color)}"/>`).join('');
  if (fill.kind === 'linear') {
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(fill.x1)}" y1="${num(fill.y1)}" x2="${num(fill.x2)}" y2="${num(fill.y2)}">${stops}</linearGradient>`;
  }
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(fill.cx)}" cy="${num(fill.cy)}" r="${num(fill.r)}">${stops}</radialGradient>`;
}
