// «Удалить фон» by a small neural network (1 November: the one exception to
// «everything by algorithms»): IS-Net, made for cutting an object from its
// background, runs in this browser — on the video card through WebGPU, else on
// the processor (WebAssembly). The picture never leaves the computer and the
// server pays for nothing. The model and its runtime (70 MB) come from /heavy/
// once and stay in the browser's cache; without them (offline, an old browser)
// the cut is GrabCut, as before. Licenses: apps/web/heavy/NOTICE.md.

import { tr } from '#core';

const HEAVY = '/heavy/';
const RUNTIME = `${HEAVY}ort-1.20.1/`;
export const MODEL_URL = `${HEAVY}isnet-u8-ff42d260.onnx`;
/** The model's input and output: a square picture of this side. */
export const MODEL_SIDE = 1024;

/** The few parts of ONNX Runtime Web used here. */
interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  env: { wasm: { wasmPaths: string; numThreads: number }; logLevel: string };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(url: string, options: { executionProviders: string[]; graphOptimizationLevel: string }): Promise<OrtSession> };
}

let loading: Promise<{ ort: Ort; session: OrtSession } | null> | null = null;
let failed = false;

/** Loads the runtime and the model once (null — not available here: GrabCut then). */
function load(onLoad?: () => void): Promise<{ ort: Ort; session: OrtSession } | null> {
  if (failed) return Promise.resolve(null);
  loading ??= (async () => {
    onLoad?.();
    try {
      const ort = (await import(/* the runtime from /heavy/, outside the build */ `${RUNTIME}ort.webgpu.min.mjs`)) as Ort;
      ort.env.wasm.wasmPaths = RUNTIME;
      // Threads need a cross-origin isolated page; the app is not one (its sandboxes would break).
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const gpu = 'gpu' in navigator;
      for (const providers of gpu ? [['webgpu'], ['wasm']] : [['wasm']]) {
        try {
          const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: providers, graphOptimizationLevel: 'all' });
          return { ort, session };
        } catch {
          // WebGPU there but not usable (a blocked adapter): the processor
        }
      }
    } catch {
      // the runtime did not load (offline, no WebAssembly)
    }
    failed = true;
    loading = null;
    return null;
  })();
  return loading;
}

/** Whether the network was already loaded in this tab (no wait to warn about). */
export function aiReady(): boolean {
  return loading !== null && !failed;
}

/**
 * How much of each pixel is the object (0..1), MODEL_SIDE × MODEL_SIDE over the
 * whole picture (stretched as the model sees it). Null — no network here.
 */
export async function objectMask(picture: CanvasImageSource, width: number, height: number, onLoad?: () => void): Promise<Float32Array | null> {
  const net = await load(onLoad);
  if (!net) return null;
  const side = MODEL_SIDE;
  const canvas = new OffscreenCanvas(side, side);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || width <= 0 || height <= 0) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(picture, 0, 0, side, side);
  const rgba = ctx.getImageData(0, 0, side, side).data;
  const n = side * side;
  // RGB planes, 0..1 less a half (as the model was trained).
  const input = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) {
    // Transparent pixels count as white (a PNG with a hole).
    const a = rgba[p * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) input[c * n + p] = (rgba[p * 4 + c]! * a + 255 * (1 - a)) / 255 - 0.5;
  }
  try {
    const out = await net.session.run({ [net.session.inputNames[0]!]: new net.ort.Tensor('float32', input, [1, 3, side, side]) });
    const raw = out[net.session.outputNames[0]!]!.data;
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < n; p++) {
      const v = raw[p]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const mask = new Float32Array(n);
    const span = hi - lo || 1;
    for (let p = 0; p < n; p++) mask[p] = (raw[p]! - lo) / span;
    return mask;
  } catch {
    return null;
  }
}

/** The square mask sampled at another size (nearest of the bilinear four). */
export function maskAt(mask: Float32Array, w: number, h: number): Float32Array {
  const side = MODEL_SIDE;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(side - 1, Math.max(0, ((y + 0.5) * side) / h - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(side - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(side - 1, Math.max(0, ((x + 0.5) * side) / w - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(side - 1, x0 + 1);
      const tx = fx - x0;
      const top = mask[y0 * side + x0]! * (1 - tx) + mask[y0 * side + x1]! * tx;
      const bottom = mask[y1 * side + x0]! * (1 - tx) + mask[y1 * side + x1]! * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** What the person sees while the network loads the first time. */
export const LOADING_NOTE = (): string => tr('Загружаю нейросеть для удаления фона — один раз, около 70 МБ…');
