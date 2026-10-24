import * as account from './account.js';
import { initTouchup, openTouchup } from './touchup.js';

const $ = (sel) => document.querySelector(sel);

const settings = {
  bg: 'white',
  color: '#f4efe6',
  size: '1080x1080',
  padding: 8,
  shadow: false,
  sharpen: false, // AI netleştirme (upscale-worker.js)
  format: 'png',
  logo: null, // HTMLImageElement
  logoPos: 'br',
  logoSize: 18, // görselin kısa kenarına göre yüzde
};

const LOGO_KEY = 'photoroot-logo';

const items = new Map(); // id -> { file, name, el, cutout, sharp, bbox, status }
const queue = [];
let nextId = 1;
let busy = false;
let modelReady = false;

// ---------- Worker ----------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const fileProgress = new Map(); // dosya adı -> { loaded, total }

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case 'progress': return onModelProgress(data.data);
    case 'ready':
      modelReady = true;
      setStatus(data.quality === 'high'
        ? 'Hazır · yüksek kalite modu'
        : 'Hazır · standart mod (en iyi kalite için güncel Chrome veya Edge kullan)', 1);
      return pump();
    case 'load-error':
      return setStatus('Model yüklenemedi: ' + data.message, 0, true);
    case 'result': return onResult(data);
    case 'error': return onItemError(data.id, data.message);
  }
};
worker.postMessage({ type: 'load', forceWasm: new URLSearchParams(location.search).has('wasm') });

function onModelProgress(p) {
  if (modelReady || p.status !== 'progress' || !p.total) return;
  fileProgress.set(p.file, { loaded: p.loaded, total: p.total });
  let loaded = 0, total = 0;
  for (const f of fileProgress.values()) { loaded += f.loaded; total += f.total; }
  // Önce küçük ayar dosyaları gelir; model dosyası başlamadan "0 / 0 MB" göstermeyelim.
  if (total < 1048576) return setStatus('Yapay zekâ modeli hazırlanıyor…', 0);
  const mb = (n) => (n / 1048576).toFixed(0);
  setStatus(`Yapay zekâ modeli indiriliyor (yalnızca ilk sefer) · ${mb(loaded)} / ${mb(total)} MB`, loaded / total);
}

function setStatus(text, fraction = 0, isError = false) {
  $('#status-text').textContent = text;
  $('#status-bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  $('#status').classList.toggle('error', isError);
}

// ---------- Kuyruk ----------

function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const id = nextId++;
    const el = $('#item-tpl').content.firstElementChild.cloneNode(true);
    el.querySelector('.name').textContent = file.name;
    el.querySelector('[data-action="remove"]').onclick = () => removeItem(id);
    el.querySelector('[data-action="download"]').onclick = () => downloadOne(id);
    el.querySelector('[data-action="edit"]').onclick = () => editItem(id);
    const thumb = new Image();
    thumb.src = URL.createObjectURL(file);
    thumb.style.opacity = '.45';
    el.querySelector('.preview').prepend(thumb);
    $('#results').append(el);
    items.set(id, { file, name: file.name, el, thumb, status: 'queued' });
    queue.push(id);
  }
  updateToolbar();
  pump();
}

async function pump() {
  if (busy || !modelReady) return;
  const id = queue.shift();
  if (id === undefined) return updateToolbar();
  const item = items.get(id);
  if (!item) return pump();
  busy = true;

  // Günlük haktan düş; limit dolduysa sıradaki görselleri de beklet.
  const quota = await account.consume(1);
  if (!items.has(id)) { busy = false; return pump(); }
  if (!quota.ok && !quota.limit) {
    // Limit dışı bir hata (ağ, sunucu): bu görseli hatalı işaretle, sıradakilerle devam et.
    busy = false;
    item.status = 'error';
    setOverlay(item, quota.message);
    return pump();
  }
  if (!quota.ok) {
    busy = false;
    item.status = 'limit';
    setOverlay(item, 'Günlük hak doldu');
    for (const qid of queue.splice(0)) {
      const q = items.get(qid);
      if (q) { q.status = 'limit'; setOverlay(q, 'Günlük hak doldu'); }
    }
    setStatus(quota.message, 1);
    account.openUpgrade(quota.message);
    return updateToolbar();
  }
  item.status = 'working';
  setOverlay(item, 'Arka plan siliniyor…');
  const left = queue.length;
  setStatus(left ? `İşleniyor · sırada ${left} görsel` : 'İşleniyor…', 1);
  worker.postMessage({ type: 'run', id, blob: item.file });
}

// ---------- AI netleştirme ----------
// Kesilmiş ürün görseli (cutout) isteğe bağlı olarak 4× büyütülüp netleştirilir; sonuç item.sharp'ta tutulur,
// kompozisyon varsa onu kullanır. Rötuş yapılınca geçersiz olur ve yeniden üretilir.
let sharpenWorker = null;
let sharpenJob = 0;
const sharpenJobs = new Map(); // job id -> item id
function getSharpenWorker() {
  if (!sharpenWorker) {
    sharpenWorker = new Worker(new URL('./upscale-worker.js', import.meta.url), { type: 'module' });
    sharpenWorker.onmessage = ({ data }) => {
      const itemId = sharpenJobs.get(data.id);
      const item = items.get(itemId);
      if (!item || item.sharpenJob !== data.id) { if (data.type !== 'progress') sharpenJobs.delete(data.id); return; }
      if (data.type === 'progress') { setOverlay(item, `AI netleştiriliyor… ${data.done}/${data.total}`); return; }
      sharpenJobs.delete(data.id);
      item.sharpenJob = null;
      if (data.type === 'done') {
        const c = document.createElement('canvas');
        c.width = data.width; c.height = data.height;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.rgba.buffer), data.width, data.height), 0, 0);
        item.sharp = c;
      } else {
        setStatus(data.message, 1, true);
      }
      renderPreview(item);
      updateToolbar();
    };
    sharpenWorker.onerror = (e) => setStatus('AI netleştirme başlatılamadı: ' + (e.message || 'bilinmeyen hata'), 1, true);
  }
  return sharpenWorker;
}
function sharpenItem(item) {
  if (item.status !== 'done' || !settings.sharpen || item.sharp || item.sharpenJob) return;
  const { width, height } = item.cutout;
  if (width * height > 1024 * 1024) return; // yeterince büyük; netleştirme gerekmez
  const id = ++sharpenJob;
  item.sharpenJob = id;
  sharpenJobs.set(id, [...items.entries()].find(([, v]) => v === item)[0]);
  setOverlay(item, 'AI netleştiriliyor… (ilk seferde 21 MB model iner)');
  const rgba = item.cutout.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  getSharpenWorker().postMessage({ type: 'run', id, rgba, width, height });
}
/** Kompozisyonun çizeceği kaynak: netleştirilmiş varsa o. */
function sourceOf(item) {
  return settings.sharpen && item.sharp ? item.sharp : item.cutout;
}

function onResult({ id, width, height, buffer }) {
  busy = false;
  const item = items.get(id);
  if (item) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const data = new Uint8ClampedArray(buffer);
    // Modelin çıktısında renkler orijinal, yalnızca saydamlık değişmiş. Saydamlığı tam yaparak
    // "Geri getir" fırçası için orijinal fotoğrafı birebir aynı boyut ve yönde elde ederiz.
    const opaque = data.slice();
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    item.original = document.createElement('canvas');
    item.original.width = width;
    item.original.height = height;
    item.original.getContext('2d').putImageData(new ImageData(opaque, width, height), 0, 0);
    canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(data, width, height), 0, 0);
    item.cutout = canvas;
    item.bbox = alphaBounds(data, width, height);
    item.status = 'done';
    URL.revokeObjectURL(item.thumb.src);
    item.thumb.remove();
    renderPreview(item);
    item.el.querySelector('[data-action="download"]').disabled = false;
    item.el.querySelector('[data-action="edit"]').disabled = false;
    sharpenItem(item);
  }
  if (!queue.length) setStatus('Hazır', 1);
  updateToolbar();
  pump();
}

async function editItem(id) {
  const item = items.get(id);
  if (item?.status !== 'done') return;
  if (!(await openTouchup(item))) return;
  const { width, height } = item.cutout;
  item.bbox = alphaBounds(item.cutout.getContext('2d').getImageData(0, 0, width, height).data, width, height);
  item.sharp = null; // rötuş yapıldı; netleştirme yeniden üretilir
  renderPreview(item);
  sharpenItem(item);
}

function onItemError(id, message) {
  busy = false;
  const item = items.get(id);
  if (item) {
    item.status = 'error';
    setOverlay(item, 'Hata: ' + message);
  }
  updateToolbar();
  pump();
}

function setOverlay(item, text) {
  let ov = item.el.querySelector('.overlay');
  if (!text) return ov?.remove();
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'overlay';
    item.el.querySelector('.preview').append(ov);
  }
  ov.textContent = text;
}

function removeItem(id) {
  const item = items.get(id);
  if (!item) return;
  if (item.thumb?.src.startsWith('blob:')) URL.revokeObjectURL(item.thumb.src);
  item.el.remove();
  items.delete(id);
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  updateToolbar();
}

function updateToolbar() {
  const done = [...items.values()].filter((i) => i.status === 'done').length;
  $('#download-all').disabled = done === 0;
  $('#download-all').textContent = done > 1 ? `Tümünü indir (ZIP · ${done})` : 'Tümünü indir (ZIP)';
  $('#clear-all').disabled = items.size === 0;
  $('#dropzone').classList.toggle('compact', items.size > 0);
}

// ---------- Kompozisyon ----------

// Ürünün (alfa > eşik) kapladığı dikdörtgen.
function alphaBounds(data, w, h, threshold = 16) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function backgroundFill() {
  if (settings.bg === 'white') return '#ffffff';
  if (settings.bg === 'color') return settings.color;
  return settings.format === 'jpg' ? '#ffffff' : null; // JPG şeffaflık desteklemez
}

// Seçili ayarlarla tam çözünürlüklü çıktı üretir. maxSide verilirse önizleme için küçültür.
function compose(item, maxSide = Infinity) {
  const cutout = sourceOf(item);
  // bbox kesilmiş görselin koordinatlarında; netleştirilmiş kaynak 4× ise ölçeklenir
  const f = cutout.width / item.cutout.width;
  const bbox = { x: item.bbox.x * f, y: item.bbox.y * f, w: item.bbox.w * f, h: item.bbox.h * f };
  const pad = settings.padding / 100;
  let W, H, dx, dy, dw, dh, sx = 0, sy = 0, sw = cutout.width, sh = cutout.height;

  if (settings.size === 'original') {
    W = cutout.width; H = cutout.height;
    dx = 0; dy = 0; dw = W; dh = H;
  } else {
    ({ x: sx, y: sy, w: sw, h: sh } = bbox);
    if (settings.size === 'crop') {
      const m = Math.round(Math.max(sw, sh) * pad);
      W = sw + 2 * m; H = sh + 2 * m;
    } else {
      [W, H] = settings.size.split('x').map(Number);
    }
    const availW = W * (1 - 2 * pad), availH = H * (1 - 2 * pad);
    const scale = settings.size === 'crop' ? 1 : Math.min(availW / sw, availH / sh);
    dw = sw * scale; dh = sh * scale;
    dx = (W - dw) / 2; dy = (H - dh) / 2;
  }

  const k = Math.min(1, maxSide / Math.max(W, H));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * k);
  canvas.height = Math.round(H * k);
  const ctx = canvas.getContext('2d');
  ctx.scale(k, k);
  ctx.imageSmoothingQuality = 'high';

  const fill = backgroundFill();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, W, H);
  }
  if (settings.shadow) {
    const s = Math.max(dw, dh);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
    ctx.shadowBlur = s * 0.04 * k;
    ctx.shadowOffsetY = s * 0.02 * k;
  }
  ctx.drawImage(cutout, sx, sy, sw, sh, dx, dy, dw, dh);
  if (settings.logo && account.limits()?.brand) drawLogo(ctx, W, H);
  return canvas;
}

// Logoyu seçilen köşeye, kenardan biraz içeride çizer.
function drawLogo(ctx, W, H) {
  const img = settings.logo;
  const short = Math.min(W, H);
  const lw = short * settings.logoSize / 100;
  // Boyutsuz SVG'lerde naturalWidth 0 olabilir; o zaman kare kabul edilir.
  const lh = img.naturalWidth && img.naturalHeight ? lw * img.naturalHeight / img.naturalWidth : lw;
  const m = short * 0.04;
  const x = settings.logoPos.endsWith('l') ? m : W - m - lw;
  const y = settings.logoPos.startsWith('t') ? m : H - m - lh;
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.drawImage(img, x, y, lw, lh);
  ctx.restore();
}

function renderPreview(item) {
  if (item.status !== 'done') return;
  const preview = item.el.querySelector('.preview');
  preview.querySelector('canvas')?.remove();
  setOverlay(item, null);
  preview.append(compose(item, 600));
}

function rerenderAll() {
  for (const item of items.values()) renderPreview(item);
}

// ---------- İndirme ----------

function outputName(item) {
  const base = item.name.replace(/\.[^.]+$/, '');
  return `${base}-photoroot.${settings.format}`;
}

function toBlob(canvas) {
  const type = settings.format === 'jpg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Ücretsiz pakette çıktının uzun kenarı sınırlıdır.
const exportMaxSide = () => account.limits()?.maxSide ?? Infinity;

async function downloadOne(id) {
  const item = items.get(id);
  if (item?.status !== 'done') return;
  saveBlob(await toBlob(compose(item, exportMaxSide())), outputName(item));
}

async function downloadAll() {
  const done = [...items.values()].filter((i) => i.status === 'done');
  if (!done.length) return;
  if (done.length === 1) return downloadOne([...items].find(([, i]) => i === done[0])[0]);
  const limits = account.limits();
  if (limits && !limits.batch) {
    return account.openUpgrade('Toplu ZIP indirme Pro pakette. Ücretsiz pakette görselleri tek tek indirebilirsin.');
  }
  const btn = $('#download-all');
  btn.disabled = true;
  btn.textContent = 'ZIP hazırlanıyor…';
  const zip = new JSZip();
  const used = new Set();
  for (const item of done) {
    let name = outputName(item);
    for (let n = 2; used.has(name); n++) name = outputName(item).replace(/(\.\w+)$/, `-${n}$1`);
    used.add(name);
    zip.file(name, await toBlob(compose(item, exportMaxSide())));
  }
  saveBlob(await zip.generateAsync({ type: 'blob' }), 'photoroot.zip');
  updateToolbar();
}

// ---------- Arayüz bağlantıları ----------

function bindSeg(id, key, after) {
  const group = $(id);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    settings[key] = btn.dataset.value;
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    after?.();
    rerenderAll();
  });
}

bindSeg('#bg-mode', 'bg', () => { $('#swatches').hidden = settings.bg !== 'color'; markSwatch(); });
bindSeg('#format', 'format', () => {
  // JPG'de şeffaflık olmaz; kullanıcıyı şaşırtmamak için beyaza geç.
  if (settings.format === 'jpg' && settings.bg === 'transparent') {
    $('#bg-mode [data-value="white"]').click();
  }
});

function markSwatch() {
  document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.color === settings.color)));
}
$('#swatches').addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  settings.color = sw.dataset.color;
  $('#custom-color').value = sw.dataset.color;
  markSwatch();
  rerenderAll();
});
$('#custom-color').addEventListener('input', (e) => {
  settings.color = e.target.value;
  markSwatch();
  rerenderAll();
});

$('#size').addEventListener('change', (e) => {
  settings.size = e.target.value;
  $('#padding-field').hidden = settings.size === 'original';
  updateSizeHint();
  rerenderAll();
});

function updateSizeHint() {
  const max = account.limits()?.maxSide;
  const fits = settings.size !== 'original' && settings.size !== 'crop' && Math.max(...settings.size.split('x').map(Number)) <= (max ?? 0);
  $('#size-hint').hidden = !max || fits;
}

function updateUsage() {
  const limits = account.limits();
  const el = $('#usage');
  if (!limits || limits.dailyLimit == null) { el.hidden = true; return; }
  const remaining = account.usage()?.remaining ?? limits.dailyLimit;
  el.hidden = false;
  el.innerHTML = '';
  el.append(`Bugün kalan: ${remaining} / ${limits.dailyLimit} görsel · `);
  const a = Object.assign(document.createElement('a'), { href: '#', textContent: 'Sınırsız için Pro' });
  a.dataset.upgrade = 'limit';
  el.append(a);
}

let lastPlan = null;
account.onChange(() => {
  updateSizeHint();
  updateUsage();
  const plan = account.limits()?.plan ?? null;
  if (plan !== lastPlan) {
    lastPlan = plan;
    rerenderAll(); // paket değişince logo görünürlüğü değişebilir
  }
  // Hak açıldıysa (ör. Pro'ya geçildi ya da yeni gün) bekleyen görselleri tekrar sıraya al.
  const limits = account.limits();
  const usage = account.usage();
  if (limits && (limits.dailyLimit == null || usage?.remaining > 0)) {
    for (const [id, item] of items) {
      if (item.status === 'limit') { item.status = 'queued'; setOverlay(item, 'Sırada…'); queue.push(id); }
    }
    pump();
  }
});
account.init();
initTouchup();
$('#padding').addEventListener('input', (e) => {
  settings.padding = Number(e.target.value);
  $('#padding-out').textContent = `%${settings.padding}`;
  rerenderAll();
});
$('#sharpen').addEventListener('change', (e) => {
  settings.sharpen = e.target.checked;
  $('#sharpen-hint').hidden = !settings.sharpen;
  for (const item of items.values()) { if (settings.sharpen) sharpenItem(item); renderPreview(item); }
});
$('#shadow').addEventListener('change', (e) => {
  settings.shadow = e.target.checked;
  rerenderAll();
});

// ---------- Logo (İşletme paketi) ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function showLogo(img) {
  settings.logo = img;
  $('#logo-preview').src = img?.src ?? '';
  $('#logo-preview').hidden = !img;
  $('#logo-clear').hidden = !img;
  $('#logo-options').hidden = !img;
  rerenderAll();
}

$('#logo-pick').addEventListener('click', (e) => {
  if (account.limits()?.brand) return;
  e.preventDefault();
  account.openUpgrade('Görsellere logo eklemek İşletme paketinde.', { plan: 'business' });
});
$('#logo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  try {
    showLogo(await loadImage(dataUrl));
  } catch {
    return account.toast('Logo okunamadı.');
  }
  // Bir sonraki ziyaret için hatırla (tarayıcı izin vermezse sorun değil).
  try { localStorage.setItem(LOGO_KEY, dataUrl); } catch {}
});
$('#logo-clear').addEventListener('click', () => {
  showLogo(null);
  try { localStorage.removeItem(LOGO_KEY); } catch {}
});
$('#logo-pos').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (!btn) return;
  settings.logoPos = btn.dataset.value;
  $('#logo-pos').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  rerenderAll();
});
$('#logo-size').addEventListener('input', (e) => {
  settings.logoSize = Number(e.target.value);
  $('#logo-size-out').textContent = `%${settings.logoSize}`;
  rerenderAll();
});
try {
  const saved = localStorage.getItem(LOGO_KEY);
  if (saved) loadImage(saved).then(showLogo, () => {});
} catch {}

$('#download-all').addEventListener('click', downloadAll);
$('#clear-all').addEventListener('click', () => [...items.keys()].forEach(removeItem));

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
document.addEventListener('paste', (e) => addFiles([...e.clipboardData.files]));
