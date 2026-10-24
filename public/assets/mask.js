// Model maskesinin temizlenmesi. Hem tarayıcıda (worker) hem testlerde (Node) çalışır.

// Sisli, yarı saydam alanları netleştirir: `low` altı tamamen saydam, `high` üstü tamamen opak,
// arası yumuşak geçiş (smoothstep). Ürün kenarlarındaki doğal yumuşaklık korunur.
export function sharpenAlpha(rgba, { low = 30, high = 200 } = {}) {
  const span = high - low;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a <= low) rgba[i] = 0;
    else if (a >= high) rgba[i] = 255;
    else {
      const t = (a - low) / span;
      rgba[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  return rgba;
}

// Ürüne bağlı olmayan küçük parçaları siler: en büyük parçanın `minRatio` katından küçük
// her bağlı bölge (8 komşuluk, alfa > threshold) saydam yapılır.
export function removeIslands(rgba, width, height, { threshold = 128, minRatio = 0.02 } = {}) {
  const n = width * height;
  const label = new Int32Array(n); // 0: işaretsiz / arka plan
  const sizes = [0];
  const stack = new Int32Array(n);
  let next = 1;
  for (let start = 0; start < n; start++) {
    if (label[start] || rgba[start * 4 + 3] <= threshold) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let size = 0;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (!label[q] && rgba[q * 4 + 3] > threshold) {
            label[q] = next;
            stack[top++] = q;
          }
        }
      }
    }
    sizes.push(size);
    next++;
  }
  if (next <= 2) return rgba; // tek parça ya da boş
  const largest = Math.max(...sizes);
  const keep = sizes.map((s) => s >= largest * minRatio);
  // Kopuk parçaları ve onlara yapışık zayıf (eşik altı) pikselleri temizle.
  for (let p = 0; p < n; p++) {
    const l = label[p];
    if (l && !keep[l]) rgba[p * 4 + 3] = 0;
  }
  // Eşik altı yarı saydam pikseller: komşusunda tutulan bir parça yoksa sil.
  for (let p = 0; p < n; p++) {
    const i = p * 4 + 3;
    if (label[p] || rgba[i] === 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const l = label[ny * width + nx];
        if (l && keep[l]) { near = true; break; }
      }
    }
    if (!near) rgba[i] = 0;
  }
  return rgba;
}

export function refineMask(rgba, width, height) {
  sharpenAlpha(rgba);
  removeIslands(rgba, width, height);
  defringe(rgba, width, height);
  return rgba;
}

// Kenar rengi temizliği: ürün kenarındaki pikseller çoğu zaman zeminin rengini taşır
// (sarı zeminde kulaklığın etrafında sarı hare gibi). Kenara `band` piksel yakın her görünür
// pikselin rengi, biraz daha içerideki ürün piksellerinin ortalamasıyla değiştirilir.
export function defringe(rgba, width, height, { band = 3, radius = 4 } = {}) {
  const n = width * height;
  const INF = 255;
  const dist = new Uint8Array(n).fill(INF);
  // Saydam piksellerden başlayan çok kaynaklı BFS ile "kenara uzaklık".
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let p = 0; p < n; p++) {
    if (rgba[p * 4 + 3] < 128) { dist[p] = 0; queue[tail++] = p; }
  }
  if (tail === 0 || tail === n) return rgba;
  const limit = band + radius + 1;
  while (head < tail) {
    const p = queue[head++];
    const d = dist[p];
    if (d >= limit) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (dist[q] > d + 1) { dist[q] = d + 1; queue[tail++] = q; }
    }
  }
  const src = rgba.slice();
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (src[i + 3] === 0 || (dist[p] > band && src[i + 3] >= 128)) continue;
    const x = p % width;
    const y = (p - x) / width;
    let r = 0, g = 0, b = 0, count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const q = ny * width + nx;
        if (dist[q] > band && src[q * 4 + 3] === 255) {
          const j = q * 4;
          r += src[j]; g += src[j + 1]; b += src[j + 2]; count++;
        }
      }
    }
    if (count) {
      rgba[i] = Math.round(r / count);
      rgba[i + 1] = Math.round(g / count);
      rgba[i + 2] = Math.round(b / count);
    }
  }
  return rgba;
}
