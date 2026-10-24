// Arka plan silme modeli bu worker'da çalışır, böylece arayüz donmaz.
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
import { refineMask } from './mask.js';

env.allowLocalModels = false;

// İki model de ticari kullanıma uygun lisanslı (MIT):
// - BiRefNet lite 1024: en ayrıntılı sonuç, WebGPU ister (WASM'de bellek yetmiyor).
// - BiRefNet lite 512: WebGPU olmayan tarayıcılar için. Ürün fotoğraflarıyla yapılan
//   karşılaştırmada ormbg ve MVANet'ten iyi/eşit sonuç verdi, görsel başına ~9 sn (MVANet ~46 sn).
const HQ_MODEL = 'onnx-community/BiRefNet_lite-ONNX';
const LITE_MODEL = 'studioludens/birefnet-lite-512';

let segmenterPromise = null;

async function gpuAdapter() {
  if (!('gpu' in navigator)) return null;
  try {
    return await navigator.gpu.requestAdapter();
  } catch {
    return null;
  }
}

function load(forceWasm) {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const progress_callback = (p) => postMessage({ type: 'progress', data: p });
    const adapter = forceWasm ? null : await gpuAdapter();
    const attempts = [];
    if (adapter) {
      attempts.push({ model: HQ_MODEL, device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32', quality: 'high' });
    }
    // fp16, fp32 ile aynı sonucu verir ve indirmesi yarı boyuttadır (98 MB).
    attempts.push({ model: LITE_MODEL, device: 'wasm', dtype: 'fp16', quality: 'standard' });
    let lastError;
    for (const { model, quality, ...opts } of attempts) {
      try {
        const segmenter = await pipeline('background-removal', model, { ...opts, progress_callback });
        postMessage({ type: 'ready', quality });
        return segmenter;
      } catch (err) {
        lastError = err;
      }
    }
    segmenterPromise = null;
    throw lastError;
  })();
  return segmenterPromise;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    try {
      await load(data.forceWasm);
    } catch (err) {
      postMessage({ type: 'load-error', message: String(err?.message || err) });
    }
    return;
  }

  if (data.type === 'run') {
    const { id, blob } = data;
    try {
      const segmenter = await load();
      const image = await RawImage.fromBlob(blob);
      const [result] = await segmenter(image);
      const rgba = result.channels === 4 ? result : result.rgba();
      // Sisli alanları ve ürüne bağlı olmayan kırıntıları temizle.
      refineMask(rgba.data, rgba.width, rgba.height);
      const buffer = rgba.data.buffer;
      postMessage({ type: 'result', id, width: rgba.width, height: rgba.height, buffer }, [buffer]);
    } catch (err) {
      postMessage({ type: 'error', id, message: String(err?.message || err) });
    }
  }
};
