// Arka plan silme modeli bu worker'da çalışır, böylece arayüz donmaz.
import { pipeline, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

env.allowLocalModels = false;

// İki model de ticari kullanıma uygun lisanslı:
// - BiRefNet lite (MIT): yüksek kalite, WebGPU ister (WASM'de bellek yetmiyor).
// - ormbg (Apache 2.0): hafif yedek, WebGPU olmayan tarayıcılar için.
const HQ_MODEL = 'onnx-community/BiRefNet_lite-ONNX';
const LITE_MODEL = 'onnx-community/ormbg-ONNX';

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
    attempts.push({ model: LITE_MODEL, device: 'wasm', dtype: 'uint8', quality: 'standard' });
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
      const buffer = rgba.data.buffer;
      postMessage({ type: 'result', id, width: rgba.width, height: rgba.height, buffer }, [buffer]);
    } catch (err) {
      postMessage({ type: 'error', id, message: String(err?.message || err) });
    }
  }
};
