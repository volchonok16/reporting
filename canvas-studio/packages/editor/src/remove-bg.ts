// Remove background (October list, "AI without AI"): for pictures on a plain
// or smoothly changing background — screenshots, products on white or on a
// studio gradient, logos — a flood fill from the edges is quick and exact (see
// removeUniformBackground). A busy background (a photo) is cut by a small neural
// network in the browser (ai-cutout.ts, 1 November), or by GrabCut where it cannot
// run (segment.ts); a guided filter makes the edge. Nothing leaves the browser.

import { tr } from '#core';
import { MODEL_SIDE } from './ai-cutout.ts';

export interface BgResult {
  /** Share of pixels made transparent, 0..1. */
  removed: number;
  /** Share of the edge in the background's colour: near 1 — a truly plain background (a logo, a screenshot, a product on white). */
  plain: number;
}

/** Colour distance (0..441). */
const dist = (d: Uint8ClampedArray, i: number, r: number, g: number, b: number) => Math.hypot(d[i]! - r, d[i + 1]! - g, d[i + 2]! - b);
const distPx = (d: Uint8ClampedArray, i: number, j: number) => Math.hypot(d[i]! - d[j]!, d[i + 1]! - d[j + 1]!, d[i + 2]! - d[j + 2]!);

/**
 * Clears a plain background in RGBA pixels in place. Returns null when the
 * edges are not one colour (a busy background this method cannot handle).
 *
 * 1. The background colour is the median of the edge; the tolerance follows
 *    the noise of the edge (JPEG, grain), unless given.
 * 2. A flood fill from the edges takes pixels close to that colour, and also
 *    pixels that change smoothly from a background neighbour (gradients,
 *    vignettes, soft shadows on the backdrop).
 * 3. Background shut inside the object (the hole of an "O", the gap between
 *    an arm and a body) is removed too when it is large enough; specks of
 *    noise left in the background are cleared.
 * 4. The boundary gets soft alpha over two pixels, and the background colour
 *    is taken out of those pixels, so no light or dark halo remains.
 */
export function removeUniformBackground(data: Uint8ClampedArray, width: number, height: number, tolerance?: number): BgResult | null {
  const n = width * height;
  if (n === 0) return null;
  // 1. Background colour and noise, from the edge (walked as a loop, for smoothness).
  const edge: number[] = [];
  for (let x = 0; x < width; x++) edge.push(x * 4);
  for (let y = 1; y < height; y++) edge.push((y * width + width - 1) * 4);
  for (let x = width - 2; x >= 0; x--) edge.push(((height - 1) * width + x) * 4);
  for (let y = height - 2; y > 0; y--) edge.push(y * width * 4);
  const opaque = edge.filter((i) => data[i + 3]! > 8);
  if (opaque.length === 0) return { removed: 0, plain: 1 }; // already cut out
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!;
  const r = median(opaque.map((i) => data[i]!));
  const g = median(opaque.map((i) => data[i + 1]!));
  const b = median(opaque.map((i) => data[i + 2]!));
  const spread = median(opaque.map((i) => dist(data, i, r, g, b)));
  const tol = tolerance ?? Math.min(60, Math.max(22, 18 + spread * 3));
  const step = Math.max(6, tol / 3);
  const far = tol * 2.5;
  // 2. Plain background? Most of the edge is that colour, or it changes smoothly (a gradient).
  const close = opaque.filter((i) => dist(data, i, r, g, b) <= tol).length / opaque.length;
  let smooth = 0;
  for (let k = 0; k < opaque.length; k++) if (distPx(data, opaque[k]!, opaque[(k + 1) % opaque.length]!) <= step) smooth++;
  const within = opaque.filter((i) => dist(data, i, r, g, b) <= far).length / opaque.length;
  if (close < 0.6 && !(smooth / opaque.length >= 0.9 && within >= 0.8)) return null;

  // 3. Flood fill from the edges.
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const near = (i: number) => data[i + 3]! <= 8 || dist(data, i, r, g, b) <= tol;
  for (const i of edge) {
    const p = i / 4;
    if (!bg[p] && near(i)) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  }
  const grow = (from: number, p: number) => {
    if (bg[p]) return;
    const i = p * 4;
    if (near(i) || (distPx(data, i, from * 4) <= step && dist(data, i, r, g, b) <= far)) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  };
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % width;
    if (x > 0) grow(p, p - 1);
    if (x < width - 1) grow(p, p + 1);
    if (p >= width) grow(p, p - width);
    if (p < n - width) grow(p, p + width);
  }

  // 4. Connected regions not reached from the edge: background shut inside (removed when
  // large and very close to the background colour), and specks of the object kind left in the background.
  const seen = new Uint8Array(n);
  const minHole = Math.max(48, n * 0.0008);
  const maxSpeck = Math.max(3, Math.min(64, n * 0.00004));
  const region = (start: number, inside: (p: number) => boolean): number => {
    head = 0;
    tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      const next = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p < n - width ? p + width : -1];
      for (const q of next) {
        if (q < 0 || seen[q] || !inside(q)) continue;
        seen[q] = 1;
        queue[tail++] = q;
      }
    }
    return tail;
  };
  const holeLike = (p: number) => !bg[p] && dist(data, p * 4, r, g, b) <= tol * 0.6;
  for (let p = 0; p < n; p++) {
    if (seen[p] || !holeLike(p)) continue;
    if (region(p, holeLike) >= minHole) for (let k = 0; k < tail; k++) bg[queue[k]!] = 1;
  }
  seen.fill(0);
  for (let p = 0; p < n; p++) {
    if (seen[p] || bg[p]) continue;
    if (region(p, (q) => !bg[q]) <= maxSpeck) for (let k = 0; k < tail; k++) bg[queue[k]!] = 1;
  }

  // 5. Soft boundary without a halo: within two pixels of the background, alpha follows how far the
  // colour is from the local background, and that background is taken out of the colour.
  const original = data.slice();
  const out = data;
  let removed = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (bg[p]) {
      out[i + 3] = 0;
      removed++;
      continue;
    }
    const x = p % width;
    const y = (p - x) / width;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let count = 0;
    let ring = 0;
    for (let radius = 1; radius <= 2 && count === 0; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (!bg[q]) continue;
          const j = q * 4;
          if (original[j + 3]! <= 8) continue;
          sr += original[j]!;
          sg += original[j + 1]!;
          sb += original[j + 2]!;
          count++;
        }
      }
      ring = radius;
    }
    if (count === 0) continue;
    const lr = sr / count;
    const lg = sg / count;
    const lb = sb / count;
    // How much of the pixel is the object: its distance from the background against that of the
    // solid object next to it (the most different pixel around that is not background).
    const d = dist(original, i, lr, lg, lb);
    let solid = d;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width || bg[yy * width + xx]) continue;
        solid = Math.max(solid, dist(original, (yy * width + xx) * 4, lr, lg, lb));
      }
    }
    let a = d <= tol * 0.4 ? 0 : solid > 0 ? d / solid : 1;
    if (a > 0.9) a = 1;
    // Two pixels from the background a pixel is most likely the object itself.
    if (ring === 2) a = Math.max(a, 0.5);
    if (a >= 1) continue;
    if (a <= 0.03) {
      out[i + 3] = 0;
      continue;
    }
    out[i] = Math.round(Math.min(255, Math.max(0, (original[i]! - (1 - a) * lr) / a)));
    out[i + 1] = Math.round(Math.min(255, Math.max(0, (original[i + 1]! - (1 - a) * lg) / a)));
    out[i + 2] = Math.round(Math.min(255, Math.max(0, (original[i + 2]! - (1 - a) * lb) / a)));
    out[i + 3] = Math.round(original[i + 3]! * a);
  }
  return { removed: removed / n, plain: close };
}

/** Lets the page draw between the heavy steps. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

/** Side of the small copy the object is cut on (and the brushes are drawn on). */
const CUT_SIDE = 400;

/**
 * A picture being cut out: the object is found by the neural network (or by GrabCut) on a small copy;
 * strokes of the "Keep" and "Remove" brushes (hints on that copy) cut it again; `finish`
 * makes the full-size picture with a soft edge.
 */
export class Cutout {
  /** The small copy (at most CUT_SIDE px) and its object mask (1 — object). */
  readonly small: ImageData;
  label: Uint8Array;
  /** The quick way found a plain background and agreed with the cut: its exact result. */
  private plainImage: ImageData | null;
  /** The cut found by itself, before any stroke (the start for every cut with strokes). */
  private first: Uint8Array | null = null;
  /** The network's mask (MODEL_SIDE square, 0..1) and its cut on the small copy: the soft edge comes from it. */
  private readonly net: { mask: Float32Array; label: Uint8Array } | null;

  private readonly canvas: OffscreenCanvas;

  private constructor(canvas: OffscreenCanvas, small: ImageData, label: Uint8Array, plainImage: ImageData | null, net: { mask: Float32Array; label: Uint8Array } | null = null) {
    this.canvas = canvas;
    this.small = small;
    this.label = label;
    this.plainImage = plainImage;
    this.net = net;
  }

  /** Cut by the neural network (not GrabCut). */
  get byNetwork(): boolean {
    return this.net !== null;
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }

  /** Decodes and cuts; null when the picture cannot be read. `onLoad` — the network is being loaded (the first time). */
  static async open(bytes: Uint8Array, mime: string, onLoad?: () => void): Promise<Cutout | null> {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime })).catch(() => null);
    if (!bitmap) return null;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const k = Math.min(1, CUT_SIDE / Math.max(img.width, img.height));
    const small = scaled(canvas, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    // A plain background goes the quick and exact way when the edge is one colour, or when the cut agrees with it.
    const plain = removeUniformBackground(img.data, img.width, img.height);
    if (plain && plain.plain >= 0.95) return new Cutout(canvas, small, maskOf(img, small.width, small.height), img);
    await breathe();
    // The neural network first; where it cannot run, GrabCut.
    const { objectMask, maskAt } = await import('./ai-cutout.ts');
    const mask = await objectMask(canvas, canvas.width, canvas.height, onLoad);
    let net: { mask: Float32Array; label: Uint8Array } | null = null;
    let label: Uint8Array;
    if (mask) {
      const soft = maskAt(mask, small.width, small.height);
      label = new Uint8Array(soft.length);
      for (let p = 0; p < soft.length; p++) label[p] = soft[p]! >= 0.5 ? 1 : 0;
      net = { mask, label };
    } else {
      const { grabCut } = await import('./segment.ts');
      label = grabCut(small.data, small.width, small.height);
    }
    if (plain) {
      const quick = maskOf(img, small.width, small.height);
      let both = 0;
      let either = 0;
      for (let p = 0; p < label.length; p++) {
        if (label[p] && quick[p]) both++;
        if (label[p] || quick[p]) either++;
      }
      if (either > 0 && both / either >= 0.9) return new Cutout(canvas, small, quick, img);
    }
    return new Cutout(canvas, small, label, null, net);
  }

  /** The background was plain and is cleared exactly (no need for the brushes). */
  get isPlain(): boolean {
    return this.plainImage !== null;
  }

  /** Share of the small copy that is object. */
  get objectShare(): number {
    let object = 0;
    for (const v of this.label) object += v;
    return object / this.label.length;
  }

  /** Cuts again with the brushes' strokes: 1 — keep, 2 — remove (on the small copy); none — the cut found by itself. */
  async recut(hints: Uint8Array): Promise<void> {
    const { grabCut } = await import('./segment.ts');
    this.first ??= this.label;
    const any = hints.some((v) => v !== 0);
    this.label = any ? grabCut(this.small.data, this.small.width, this.small.height, { hints, previous: this.first }) : this.first;
    this.plainImage = null;
  }

  /** The full-size picture without the background, as PNG; `removed` — share made transparent. */
  async finish(): Promise<{ png: Uint8Array; removed: number }> {
    const ctx = this.canvas.getContext('2d')!;
    let removed: number;
    if (this.plainImage) {
      ctx.putImageData(this.plainImage, 0, 0);
      let clear = 0;
      for (let p = 3; p < this.plainImage.data.length; p += 4) if (this.plainImage.data[p]! < 128) clear++;
      removed = clear / (this.width * this.height);
    } else {
      const img = ctx.getImageData(0, 0, this.width, this.height);
      removed = this.net ? await applyMask(this.canvas, img, this.netMask(this.net), MODEL_SIDE, MODEL_SIDE) : await applyMask(this.canvas, img, this.label, this.small.width, this.small.height);
      ctx.putImageData(img, 0, 0);
    }
    const png = new Uint8Array(await (await this.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    return { png, removed };
  }

  /**
   * The network's soft mask where the cut still agrees with it; where a brush changed the cut,
   * the cut itself (hard there — the guided filter softens it).
   */
  private netMask(net: { mask: Float32Array; label: Uint8Array }): Float32Array {
    const side = MODEL_SIDE;
    const { width: sw, height: sh } = this.small;
    const out = new Float32Array(side * side);
    for (let y = 0; y < side; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / side));
      for (let x = 0; x < side; x++) {
        const p = y * side + x;
        const q = sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / side));
        out[p] = this.label[q] === net.label[q] ? net.mask[p]! : this.label[q]!;
      }
    }
    return out;
  }
}

/** The picture drawn at another size. */
function scaled(source: OffscreenCanvas, w: number, h: number): ImageData {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

/** Object mask (alpha ≥ 50%) of a full-size cut-out, sampled at a small size. */
function maskOf(img: ImageData, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      out[y * w + x] = img.data[(sy * img.width + sx) * 4 + 3]! >= 128 ? 1 : 0;
    }
  }
  return out;
}

/**
 * The small mask onto the full-size picture: brought up to at most 2048 px (smoothly),
 * snapped to the picture's edges and made soft by a guided filter, then the background's
 * colour taken out of the soft edge. Writes alpha into `img`; returns the share made transparent.
 */
async function applyMask(source: OffscreenCanvas, img: ImageData, label: ArrayLike<number>, sw: number, sh: number): Promise<number> {
  const { refineMask, boxMeanOf } = await import('./segment.ts');
  const W = img.width;
  const H = img.height;
  const k = Math.min(1, 2048 / Math.max(W, H));
  const r = { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) };
  const maskTiny = new OffscreenCanvas(sw, sh);
  const mctx = maskTiny.getContext('2d')!;
  const md = mctx.createImageData(sw, sh);
  for (let p = 0; p < label.length; p++) {
    const v = Math.round(Math.min(1, Math.max(0, label[p]!)) * 255);
    md.data[p * 4] = v;
    md.data[p * 4 + 1] = v;
    md.data[p * 4 + 2] = v;
    md.data[p * 4 + 3] = 255;
  }
  mctx.putImageData(md, 0, 0);
  const maskMid = new OffscreenCanvas(r.w, r.h);
  const mm = maskMid.getContext('2d')!;
  mm.imageSmoothingQuality = 'high';
  mm.drawImage(maskTiny, 0, 0, r.w, r.h);
  const roughData = mm.getImageData(0, 0, r.w, r.h).data;
  const rough = new Float32Array(r.w * r.h);
  for (let p = 0; p < rough.length; p++) rough[p] = roughData[p * 4]! / 255;
  const mid = r.w === W && r.h === H ? img : scaled(source, r.w, r.h);
  await breathe();
  const radius = Math.max(2, Math.round(Math.max(r.w, r.h) / 160));
  const soft = refineMask(mid.data, r.w, r.h, rough, radius, 2e-3);
  // A soft edge, but no veil: a little contrast on alpha.
  for (let p = 0; p < soft.length; p++) {
    const a = Math.min(1, Math.max(0, (soft[p]! - 0.08) / 0.84));
    soft[p] = a * a * (3 - 2 * a);
  }
  await breathe();
  // Alpha onto the full-size picture (scaled up when it was refined smaller).
  let alpha: Float32Array = soft;
  if (r.w !== W || r.h !== H) {
    const ac = new OffscreenCanvas(r.w, r.h);
    const actx = ac.getContext('2d')!;
    const ad = actx.createImageData(r.w, r.h);
    for (let p = 0; p < soft.length; p++) {
      ad.data[p * 4] = 255;
      ad.data[p * 4 + 1] = 255;
      ad.data[p * 4 + 2] = 255;
      ad.data[p * 4 + 3] = Math.round(soft[p]! * 255);
    }
    actx.putImageData(ad, 0, 0);
    const full = new OffscreenCanvas(W, H);
    const fctx = full.getContext('2d')!;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(ac, 0, 0, W, H);
    const fd = fctx.getImageData(0, 0, W, H).data;
    alpha = new Float32Array(W * H);
    for (let p = 0; p < alpha.length; p++) alpha[p] = fd[p * 4 + 3]! / 255;
  }
  // The background's colour out of the soft edge: the local background is the average of the
  // nearly transparent pixels around (box sums), the pixel's own colour solved from the mix.
  const d = img.data;
  const n = W * H;
  const box = Math.max(3, Math.round(Math.max(W, H) / 120));
  if (n <= 16_000_000) {
    const weight = new Float32Array(n);
    for (let p = 0; p < n; p++) weight[p] = alpha[p]! < 0.05 ? 1 : 0;
    const wm = boxMeanOf(weight, W, H, box);
    const channels = [0, 1, 2].map((c) => {
      const v = new Float32Array(n);
      for (let p = 0; p < n; p++) v[p] = weight[p]! * d[p * 4 + c]!;
      return boxMeanOf(v, W, H, box);
    });
    for (let p = 0; p < n; p++) {
      const a = alpha[p]!;
      if (a <= 0.02 || a >= 0.98 || wm[p]! <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const bgc = channels[c]![p]! / wm[p]!;
        d[p * 4 + c] = Math.round(Math.min(255, Math.max(0, (d[p * 4 + c]! - (1 - a) * bgc) / a)));
      }
    }
  }
  let removed = 0;
  for (let p = 0; p < n; p++) {
    const a = alpha[p]!;
    d[p * 4 + 3] = Math.round(d[p * 4 + 3]! * a);
    if (a < 0.5) removed++;
  }
  return removed / n;
}

/** Decodes an image, removes its background and returns a PNG — or an explanation why not. */
export async function removeBackgroundFromBytes(bytes: Uint8Array, mime: string, onLoad?: () => void): Promise<{ png: Uint8Array; removed: number } | { error: string }> {
  const cut = await Cutout.open(bytes, mime, onLoad);
  if (!cut) return { error: tr('Не удалось прочитать картинку') };
  const share = cut.objectShare;
  if (share > 0.995) return { error: tr('Фон не найден: картинка уже без фона или он сливается с предметом.') };
  if (share < 0.01) return { error: tr('Не получилось отделить предмет от фона: попробуйте картинку, где предмет крупнее и не касается краёв.') };
  return cut.finish();
}
