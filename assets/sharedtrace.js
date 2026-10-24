// Ortak kenarlı çokgen izleme. Etiketli (renk indeksli) görüntüde bölgeler arasındaki sınır, piksel kenarlarından
// oluşan bir çizgi ağıdır. Bu ağ kavşaklar (≥3 bölgenin buluştuğu köşeler) arasındaki zincirlere bölünür, her
// zincir BİR KEZ sadeleştirilir (Douglas–Peucker) ve her bölgenin çokgeni bu ortak zincirlerden kurulur. İki
// komşu şekil aynı zinciri paylaştığı için aralarında boşluk ya da bindirme oluşmaz; sapma toleransla sınırlıdır.
// Tarayıcıda ve Node'da (testler) çalışır.

const NONE = -1;

/**
 * @param {Int32Array} labels  piksel → bölge etiketi (≥0), saydam için -1
 * @param {number} w
 * @param {number} h
 * @param {{tolerance?: number, chainTolerance?: (left:number, right:number, len:number)=>number}} opts
 *   tolerance: sadeleştirme toleransı (piksel), 0 = sadeleştirme yok;
 *   chainTolerance: verilirse zincir başına tolerans (iki yanındaki etiketlere göre, örn. düşük kontrastta gevşek)
 * @returns {Map<number, Array<Array<[number, number]>>>} etiket → kapalı halkalar (bölge solda kalacak yönde)
 */
export function traceShared(labels, w, h, { tolerance = 1, chainTolerance = null } = {}) {
  const V = (w + 1) * (h + 1); // köşe noktaları (x, y) → y*(w+1)+x
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? NONE : labels[y * w + x]);
  // Kenarlar: her kenar iki köşe arasında, solunda ve sağında birer etiket (yöne göre). Yön sabit: dikey kenar
  // yukarıdan aşağı (sol = x-1 pikseli, sağ = x pikseli); yatay kenar soldan sağa (sol = y pikseli, sağ = y-1 pikseli).
  const edges = []; // { a, b, left, right }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x <= w; x++) { const l = at(x - 1, y), r = at(x, y); if (l !== r) edges.push({ a: y * (w + 1) + x, b: (y + 1) * (w + 1) + x, left: l, right: r }); }
  }
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x < w; x++) { const up = at(x, y - 1), dn = at(x, y); if (up !== dn) edges.push({ a: y * (w + 1) + x, b: y * (w + 1) + x + 1, left: dn, right: up }); }
  }
  // Köşe → kenar listesi
  const deg = new Int32Array(V);
  for (const e of edges) { deg[e.a]++; deg[e.b]++; }
  const start = new Int32Array(V + 1);
  for (let v = 0; v < V; v++) start[v + 1] = start[v] + deg[v];
  const fill = new Int32Array(V), inc = new Int32Array(edges.length * 2);
  edges.forEach((e, i) => { inc[start[e.a] + fill[e.a]++] = i; inc[start[e.b] + fill[e.b]++] = i; });
  const junction = (v) => deg[v] !== 2;
  // Zincirler: kavşaktan kavşağa (ya da kavşaksız halka)
  const used = new Uint8Array(edges.length);
  const chains = []; // { verts: number[], edgeIds: number[] }
  const edgeChain = new Int32Array(edges.length).fill(-1); // kenar → zincir
  const walk = (e0, from) => {
    const verts = [from], ids = [];
    let e = e0, v = from;
    for (;;) {
      used[e] = 1; ids.push(e); edgeChain[e] = chains.length;
      v = edges[e].a === v ? edges[e].b : edges[e].a; verts.push(v);
      if (junction(v) || v === verts[0]) break;
      let next = -1;
      for (let k = start[v]; k < start[v + 1]; k++) if (inc[k] !== e && !used[inc[k]]) { next = inc[k]; break; }
      if (next < 0) break;
      e = next;
    }
    chains.push({ verts, ids });
  };
  for (let v = 0; v < V; v++) if (junction(v)) for (let k = start[v]; k < start[v + 1]; k++) if (!used[inc[k]]) walk(inc[k], v);
  for (let e = 0; e < edges.length; e++) if (!used[e]) walk(e, edges[e].a);
  // Her zinciri sadeleştir (uç noktalar sabit)
  const px = (v) => [v % (w + 1), Math.floor(v / (w + 1))];
  for (const c of chains) {
    const pts = c.verts.map(px);
    const e0 = edges[c.ids[0]];
    let tol = chainTolerance ? chainTolerance(e0.left, e0.right, c.ids.length) : tolerance;
    // Görsel çerçevesi üzerindeki sınır sadeleştirilmez (köşe kesilmesin; çerçeve zaten düz)
    if ((e0.left === NONE || e0.right === NONE) && pts.every(([x, y]) => x === 0 || y === 0 || x === w || y === h)) tol = 0;
    c.pts = tol > 0 ? simplify(pts, tol) : pts;
  }
  // Her bölge: sınırındaki zincirleri bölge hep aynı yanda kalacak yönde al (ekranda saat yönü), kavşaklarda
  // zincirleri birbirine ekleyerek halkalar kur. Kavşakta birden çok seçenek varsa bölgeye yapışık kalan (en keskin)
  // dönüş alınır; böylece çapraz değen parçalar ayrı halkalar olur, halkalar kendini kesmez. Kavşaksız zincir
  // (halka) tek başına bir halkadır.
  const byLabel = new Map(); // etiket → [zincirNo, ileri?]
  for (let ci = 0; ci < chains.length; ci++) {
    const e = edges[chains[ci].ids[0]];
    const fwdStartsAtV0 = e.a === chains[ci].verts[0]; // zincirin ilk kenarı a→b yönünde mi yürünüyor
    for (const [lab, edgeFwd] of [[e.left, true], [e.right, false]]) {
      if (lab === NONE) continue;
      if (!byLabel.has(lab)) byLabel.set(lab, []);
      byLabel.get(lab).push([ci, edgeFwd === fwdStartsAtV0]);
    }
  }
  const endpoints = (ci, fwd) => { const v = chains[ci].verts; return fwd ? [v[0], v[v.length - 1]] : [v[v.length - 1], v[0]]; };
  const dirAt = (ci, fwd, atStart) => { // zincirin başındaki çıkış yönü ya da sonundaki varış yönü
    const v = chains[ci].verts; let p, q;
    if (fwd) { p = atStart ? v[0] : v[v.length - 2]; q = atStart ? v[1] : v[v.length - 1]; }
    else { p = atStart ? v[v.length - 1] : v[1]; q = atStart ? v[v.length - 2] : v[0]; }
    const [px0, py0] = px(p), [qx, qy] = px(q); return Math.atan2(qy - py0, qx - px0);
  };
  const out = new Map();
  for (const [lab, list] of byLabel) {
    const outgoing = new Map();
    for (const item of list) { const [s0] = endpoints(item[0], item[1]); if (!outgoing.has(s0)) outgoing.set(s0, []); outgoing.get(s0).push(item); }
    const done = new Uint8Array(chains.length);
    const loops = [];
    for (const [c0, f0] of list) {
      if (done[c0]) continue;
      const loop = []; const startV = endpoints(c0, f0)[0];
      let ci = c0, fwd = f0, guard = 0;
      for (;;) {
        done[ci] = 1;
        const pts = fwd ? chains[ci].pts : chains[ci].pts.slice().reverse();
        for (let k = 0; k < pts.length - 1; k++) loop.push(pts[k]);
        const endV = endpoints(ci, fwd)[1];
        if (endV === startV) break;
        const cands = (outgoing.get(endV) ?? []).filter(([cj]) => !done[cj]);
        if (!cands.length) break; // olmamalı: her kenar tam bir kez kullanılır
        let pick = cands[0];
        if (cands.length > 1) {
          const inDir = dirAt(ci, fwd, false);
          const turn = ([cj, fj]) => { let t = dirAt(cj, fj, true) - inDir; while (t <= -Math.PI) t += 2 * Math.PI; while (t > Math.PI) t -= 2 * Math.PI; return t; };
          for (const c of cands) if (turn(c) > turn(pick)) pick = c; // bölge yürüyüş yönünün ekran sağında kalır; en büyük açı farkı = ona en yakın (sağa) dönüş
        }
        [ci, fwd] = pick;
        if (++guard > chains.length) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    out.set(lab, loops);
  }
  return out;
}

// Douglas–Peucker (uç noktalar sabit)
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let worst = 0, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = L ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps && wi > 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Halkaları SVG yol verisine çevirir (H/V kısaltmalı, tam sayılar). */
export function loopsToPath(loops) {
  const f = (v) => (Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString());
  let d = '';
  for (const loop of loops) {
    d += `M${f(loop[0][0])} ${f(loop[0][1])}`;
    for (let k = 1; k < loop.length; k++) { const [x, y] = loop[k], [px, py] = loop[k - 1]; d += y === py ? `H${f(x)}` : x === px ? `V${f(y)}` : `L${f(x)} ${f(y)}`; }
    d += 'Z';
  }
  return d;
}
