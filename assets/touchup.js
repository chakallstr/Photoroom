// Elle rötuş: yapay zekânın bıraktığı arka planı silme ya da yanlışlıkla silinen ürün
// kısımlarını orijinal fotoğraftan geri getirme. Değişiklikler item.cutout tuvaline yazılır.
const $ = (sel) => document.querySelector(sel);
const MAX_UNDO = 15;

let state = null; // { item, work, ctx, tool, size, undo, aiResult, resolve, scale, pointer }

export function openTouchup(item) {
  const work = document.createElement('canvas');
  work.width = item.cutout.width;
  work.height = item.cutout.height;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(item.cutout, 0, 0);
  state = {
    item, work, ctx,
    tool: 'erase',
    size: Number($('#touchup-size').value),
    undo: [],
    pointer: null,
    drawing: false,
    last: null,
  };
  setTool('erase');
  $('#touchup-undo').disabled = true;
  $('#touchup-reset').disabled = !item.aiCutout;
  const dialog = $('#touchup-dialog');
  dialog.showModal();
  layout();
  return new Promise((resolve) => { state.resolve = resolve; });
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('#touchup-tool button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === tool)));
  render();
}

// Görüntüyü sahneye sığdırır; ekran pikseli → görsel pikseli oranı state.scale'de tutulur.
function layout() {
  const stage = $('#touchup-stage');
  const canvas = $('#touchup-canvas');
  const { width: w, height: h } = state.work;
  const maxW = stage.clientWidth;
  const maxH = stage.clientHeight;
  // Küçük görseller hassas çalışmak için en fazla 3 kat büyütülür.
  const fit = Math.min(maxW / w, maxH / h, 3);
  const cssW = Math.max(1, Math.floor(w * fit));
  const cssH = Math.max(1, Math.floor(h * fit));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  state.scale = w / cssW; // 1 CSS pikseli kaç görsel pikseli
  render();
}

let frame = 0;
function render() {
  if (!state || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!state) return; // pencere bu kare çizilmeden kapandı
    const canvas = $('#touchup-canvas');
    const c = canvas.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.imageSmoothingQuality = 'high';
    // Geri getirirken silinmiş alanlar soluk görünür; nereyi boyayacağın belli olsun.
    if (state.tool === 'restore') {
      c.globalAlpha = 0.3;
      c.drawImage(state.item.original, 0, 0, canvas.width, canvas.height);
      c.globalAlpha = 1;
    }
    c.drawImage(state.work, 0, 0, canvas.width, canvas.height);
    if (state.pointer) {
      const k = canvas.width / state.work.width;
      c.beginPath();
      c.arc(state.pointer.x * k, state.pointer.y * k, (state.size / 2) * k, 0, Math.PI * 2);
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(255,255,255,.95)';
      c.stroke();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(0,0,0,.8)';
      c.stroke();
    }
  });
}

function toImage(e) {
  const rect = $('#touchup-canvas').getBoundingClientRect();
  return { x: (e.clientX - rect.left) * state.scale, y: (e.clientY - rect.top) * state.scale };
}

// Tek bir fırça damgası.
function stamp(x, y) {
  const { ctx, item, tool } = state;
  const r = state.size / 2;
  if (tool === 'erase') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    // Yalnızca fırçanın kapladığı kare çizilir; büyük görsellerde de akıcı kalır.
    const sx = Math.max(0, Math.floor(x - r));
    const sy = Math.max(0, Math.floor(y - r));
    const sw = Math.min(item.original.width - sx, Math.ceil(2 * r) + 1);
    const sh = Math.min(item.original.height - sy, Math.ceil(2 * r) + 1);
    if (sw > 0 && sh > 0) ctx.drawImage(item.original, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }
}

// İki nokta arasını aralıklı damgalarla doldurur (hızlı fare hareketinde boşluk kalmasın).
function strokeTo(p) {
  const from = state.last ?? p;
  const dist = Math.hypot(p.x - from.x, p.y - from.y);
  const step = Math.max(1, state.size / 4);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) stamp(from.x + ((p.x - from.x) * i) / n, from.y + ((p.y - from.y) * i) / n);
  state.last = p;
}

function pushUndo() {
  const { work, ctx } = state;
  state.undo.push(ctx.getImageData(0, 0, work.width, work.height));
  if (state.undo.length > MAX_UNDO) state.undo.shift();
  $('#touchup-undo').disabled = false;
}

function close(saved) {
  const { item, work, resolve } = state;
  if (saved) {
    // İlk kaydetmede yapay zekâ sonucunu sakla; "Yapay zekâ sonucuna dön" bununla çalışır.
    if (!item.aiCutout) {
      item.aiCutout = document.createElement('canvas');
      item.aiCutout.width = item.cutout.width;
      item.aiCutout.height = item.cutout.height;
      item.aiCutout.getContext('2d').drawImage(item.cutout, 0, 0);
    }
    const c = item.cutout.getContext('2d');
    c.clearRect(0, 0, work.width, work.height);
    c.drawImage(work, 0, 0);
  }
  state = null;
  $('#touchup-dialog').close();
  resolve(saved);
}

export function initTouchup() {
  const canvas = $('#touchup-canvas');
  canvas.addEventListener('pointerdown', (e) => {
    if (!state || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    state.drawing = true;
    state.last = null;
    const p = toImage(e);
    state.pointer = p;
    strokeTo(p);
    render();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state) return;
    const p = toImage(e);
    state.pointer = p;
    if (state.drawing) strokeTo(p);
    render();
  });
  const end = () => {
    if (!state) return;
    state.drawing = false;
    state.last = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => {
    if (!state) return;
    if (!state.drawing) state.pointer = null;
    render();
  });

  $('#touchup-tool').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b && state) setTool(b.dataset.value);
  });
  $('#touchup-size').addEventListener('input', (e) => {
    $('#touchup-size-out').textContent = `${e.target.value} px`;
    if (state) { state.size = Number(e.target.value); render(); }
  });
  $('#touchup-undo').addEventListener('click', () => {
    if (!state?.undo.length) return;
    state.ctx.putImageData(state.undo.pop(), 0, 0);
    $('#touchup-undo').disabled = !state.undo.length;
    render();
  });
  $('#touchup-reset').addEventListener('click', () => {
    if (!state?.item.aiCutout) return;
    pushUndo();
    state.ctx.clearRect(0, 0, state.work.width, state.work.height);
    state.ctx.drawImage(state.item.aiCutout, 0, 0);
    render();
  });
  $('#touchup-cancel').addEventListener('click', () => state && close(false));
  $('#touchup-save').addEventListener('click', () => state && close(true));
  $('#touchup-dialog').addEventListener('cancel', (e) => {
    // Esc: kaydetmeden kapat.
    e.preventDefault();
    if (state) close(false);
  });
  window.addEventListener('resize', () => state && layout());
  document.addEventListener('keydown', (e) => {
    if (!state) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('#touchup-undo').click(); }
    else if (e.key === '[') $('#touchup-size').stepDown(5), $('#touchup-size').dispatchEvent(new Event('input'));
    else if (e.key === ']') $('#touchup-size').stepUp(5), $('#touchup-size').dispatchEvent(new Event('input'));
    else if (e.key.toLowerCase() === 'e') setTool('erase');
    else if (e.key.toLowerCase() === 'r') setTool('restore');
  });
}
