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
  return rgba;
}
