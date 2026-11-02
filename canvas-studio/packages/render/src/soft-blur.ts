// Blur without `ctx.filter` (BUG-129): Safari's canvas has no filters, so a layer
// blur, a background blur and glass came out sharp there. The picture is shrunk
// (a strong blur needs no detail), blurred by three box passes — close to the
// Gaussian that CSS `blur()` is — and stretched back smoothly.

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = OffscreenCanvas | HTMLCanvasElement;

/** Whether this browser's canvas takes `filter: blur()`. */
export const canvasFilter: boolean = (() => {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  return !!ctx && 'filter' in ctx;
})();

/** Widths of three boxes whose passes make a Gaussian of `sigma`. */
function boxes(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  const hi = lo + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4));
  return [0, 1, 2].map((i) => (i < m ? lo : hi));
}

/** One box pass along rows (or columns), premultiplied RGBA in `src` → `dst`, edges clear. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const step = horizontal ? 4 : w * 4;
  const scale = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = 0; i <= r && i < len; i++) sum += src[base + i * step + c]!;
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum * scale;
        const add = i + r + 1;
        const drop = i - r;
        if (add < len) sum += src[base + add * step + c]!;
        if (drop >= 0) sum -= src[base + drop * step + c]!;
      }
    }
  }
}

/** `source` blurred by `radius` px (as CSS `blur()`), the same size. */
export function softBlurred(source: Source, radius: number): OffscreenCanvas {
  const W = source.width;
  const H = source.height;
  const out = new OffscreenCanvas(W, H);
  const octx = out.getContext('2d')!;
  if (radius <= 0.1) {
    octx.drawImage(source, 0, 0);
    return out;
  }
  // Shrunk so the blur left to do is about 6 px: its cost no longer grows with the radius,
  // and the grid is still fine enough not to show as bands when stretched back.
  const k = Math.max(1, radius / 6);
  const w = Math.max(1, Math.ceil(W / k));
  const h = Math.max(1, Math.ceil(H / k));
  const small = new OffscreenCanvas(w, h);
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(source, 0, 0, W / k, H / k);
  const img = sctx.getImageData(0, 0, w, h);
  const px = img.data;
  // Premultiplied, so clear pixels do not darken the colours they meet.
  const a = new Float32Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const alpha = px[i + 3]! / 255;
    a[i] = px[i]! * alpha;
    a[i + 1] = px[i + 1]! * alpha;
    a[i + 2] = px[i + 2]! * alpha;
    a[i + 3] = px[i + 3]!;
  }
  const b = new Float32Array(px.length);
  for (const size of boxes(radius / k)) {
    const r = (size - 1) / 2;
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  for (let i = 0; i < px.length; i += 4) {
    const alpha = a[i + 3]!;
    const inv = alpha > 0.01 ? 255 / alpha : 0;
    px[i] = a[i]! * inv;
    px[i + 1] = a[i + 1]! * inv;
    px[i + 2] = a[i + 2]! * inv;
    px[i + 3] = alpha;
  }
  sctx.putImageData(img, 0, 0);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, w, h, 0, 0, w * k, h * k);
  return out;
}

/** Draws `source` blurred by `radius` px at (dx, dy): through the canvas filter where there is one. */
export function drawBlurred(ctx: Ctx2D, source: Source, radius: number, dx = 0, dy = 0): void {
  if (radius <= 0.1) {
    ctx.drawImage(source, dx, dy);
    return;
  }
  if (canvasFilter) {
    const before = ctx.filter;
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(source, dx, dy);
    ctx.filter = before;
    return;
  }
  ctx.drawImage(softBlurred(source, radius), dx, dy);
}
