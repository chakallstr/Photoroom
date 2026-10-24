// AI netleştirme işçisi: modeli (waifu2x swin_unet art 4×, MIT) onnxruntime-web ile çalıştırır.
// Mesajlar: { type:'run', id, rgba, width, height } → { type:'progress', id, done, total } … { type:'done', id, rgba, width, height, ms, device }
// ya da { type:'error', id, message }. Görsel hiçbir yere gönderilmez; model ve çalışma zamanı sabit sürümle yüklenir.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs';
import { SCALE, checkInput, fillTransparent, planTiles, tileTensor, placeTile, upscaleAlpha } from './upscale.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const MODEL = new URL('./vendor/waifu2x/swin_unet_art_scale4x.onnx', import.meta.url).href;

let session = null, device = null;
let webgpuFailed = false;
// onnxruntime (Emscripten) hataları bazen düz sayı olarak fırlatılır; okunur metne çevir.
const describe = (e) => (e && typeof e === 'object' && e.message) ? e.message : `motor hatası (kod ${String(e)})`;
async function getSession() {
  if (session) return session;
  const attempts = [];
  if (!webgpuFailed && typeof navigator !== 'undefined' && navigator.gpu) attempts.push('webgpu');
  attempts.push('wasm');
  let lastErr;
  for (const ep of attempts) {
    try {
      session = await ort.InferenceSession.create(MODEL, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      device = ep;
      return session;
    } catch (e) { lastErr = e; if (ep === 'webgpu') webgpuFailed = true; }
  }
  throw new Error('AI netleştirme motoru yüklenemedi: ' + describe(lastErr));
}
// Bir döşemeyi çalıştırır; WebGPU çalışma anında çökerse oturumu WASM ile yeniden kurup aynı döşemeyi dener.
async function runTile(feeds) {
  try {
    return await (await getSession()).run(feeds);
  } catch (e) {
    if (device === 'webgpu') {
      webgpuFailed = true;
      try { await session?.release?.(); } catch { /* yoksay */ }
      session = null; device = null;
      return await (await getSession()).run(feeds);
    }
    throw new Error('AI netleştirme başarısız: ' + describe(e));
  }
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const { id, rgba, width: w, height: h } = data;
  try {
    const bad = checkInput(w, h);
    if (bad) throw new Error(bad);
    const t0 = performance.now();
    await getSession();
    const filled = fillTransparent(rgba, w, h);
    const tiles = planTiles(w, h);
    const W = w * SCALE, H = h * SCALE;
    const out = new Uint8ClampedArray(W * H * 4);
    let done = 0;
    for (const t of tiles) {
      const { data: inp, dims } = tileTensor(filled, w, h, t);
      const res = await runTile({ x: new ort.Tensor('float32', inp, dims) });
      const y = res.y;
      placeTile(out, W, y.data, y.dims, t);
      y.dispose?.();
      self.postMessage({ type: 'progress', id, done: ++done, total: tiles.length });
    }
    upscaleAlpha(rgba, w, h, out);
    self.postMessage({ type: 'done', id, rgba: out, width: W, height: H, ms: Math.round(performance.now() - t0), device }, [out.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', id, message: describe(e) });
  }
};
