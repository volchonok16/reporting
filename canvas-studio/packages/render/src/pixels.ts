// Pixel work the 2D canvas cannot do with its own operations: Figma's Plus darker,
// vector and luminance masks, photo adjustments, roughened edges (texture), glass and
// coloured noise. Everything works on RGBA bytes (ImageData), straight alpha.

import type { Color, ImageFilters } from '#core';

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Plus darker of `src` over `base` (both the same size): base + blend − 1, mixed by the source's alpha. */
export function plusDarker(base: ImageData, src: ImageData): void {
  const b = base.data;
  const s = src.data;
  for (let i = 0; i < b.length; i += 4) {
    const a = s[i + 3]! / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      const mixed = Math.max(0, b[i + c]! + s[i + c]! - 255);
      b[i + c] = b[i + c]! * (1 - a) + mixed * a;
    }
    b[i + 3] = Math.min(255, b[i + 3]! + s[i + 3]! * (1 - b[i + 3]! / 255));
  }
}

/** A mask by its outline: any opacity above zero counts as full. */
export function vectorMask(img: ImageData): void {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) d[i] = 255;
}

/** A mask by its brightness: white shows everything, black nothing. */
export function luminanceMask(img: ImageData): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
    d[i + 3] = d[i + 3]! * lum;
  }
}

export function hasFilters(f: ImageFilters | undefined): f is ImageFilters {
  return !!f && (f.exposure !== 0 || f.contrast !== 0 || f.saturation !== 0 || f.temperature !== 0 || f.tint !== 0 || f.highlights !== 0 || f.shadows !== 0);
}

export const NO_FILTERS: ImageFilters = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };

/**
 * Photo adjustments, each −1..1 as Figma's sliders: exposure in stops (±1.5), contrast
 * round the middle grey, saturation from grey, white balance (temperature: blue ↔ amber,
 * tint: green ↔ magenta), highlights and shadows lifting or lowering only the light or
 * only the dark tones.
 */
export function adjustPixels(img: ImageData, f: ImageFilters): void {
  const d = img.data;
  const gain = Math.pow(2, f.exposure * 1.5);
  const contrast = f.contrast >= 0 ? 1 + f.contrast : 1 + f.contrast * 0.8;
  const sat = 1 + f.saturation;
  const warm = f.temperature * 0.12;
  const tint = f.tint * 0.1;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]! / 255;
    let g = d[i + 1]! / 255;
    let b = d[i + 2]! / 255;
    r *= gain;
    g *= gain;
    b *= gain;
    r *= 1 + warm;
    b *= 1 - warm;
    g *= 1 - tint;
    r *= 1 + tint / 2;
    b *= 1 + tint / 2;
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (f.highlights !== 0 || f.shadows !== 0) {
      const t = Math.min(1, Math.max(0, lum));
      // Smooth weights: highlights act above the middle, shadows below it.
      const hi = t * t * (3 - 2 * t);
      const lift = f.highlights * 0.35 * hi * hi + f.shadows * 0.35 * (1 - hi) * (1 - hi);
      r += lift;
      g += lift;
      b += lift;
      lum += lift;
    }
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;
    d[i] = clamp(r * 255);
    d[i + 1] = clamp(g * 255);
    d[i + 2] = clamp(b * 255);
  }
}

/** Smooth value noise in 0..1 on a grid of `cell` px (deterministic: exports match the canvas). */
function valueNoise(seed: number): (x: number, y: number) => number {
  const hash = (ix: number, iy: number) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const e = hash(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy;
  };
}

/**
 * Texture: every pixel is taken from a little way off, by two smooth noises — the edge
 * frays by up to `radius` px with grain `size` px (both in device px). `ox`, `oy` place
 * the box on the canvas so the grain stays put while panning.
 */
export function roughen(src: ImageData, size: number, radius: number, ox: number, oy: number): ImageData {
  const { width: W, height: H } = src;
  const out = new ImageData(W, H);
  const s = src.data;
  const o = out.data;
  const nx = valueNoise(0x51ed27);
  const ny = valueNoise(0x2c1b3c6d);
  const nf = valueNoise(0x7f4a7c15);
  const cell = Math.max(0.5, size);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (x + ox) / cell;
      const gy = (y + oy) / cell;
      // Two octaves: a broad wobble and a fine grain.
      const dx = (nx(gx, gy) - 0.5) * 2 * radius + (nf(gx * 3.1, gy * 3.1) - 0.5) * radius;
      const dy = (ny(gx, gy) - 0.5) * 2 * radius + (nf(gx * 3.1 + 17, gy * 3.1 + 5) - 0.5) * radius;
      const sx = Math.round(x + dx);
      const sy = Math.round(y + dy);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const si = (sy * W + sx) * 4;
      const oi = (y * W + x) * 4;
      o[oi] = s[si]!;
      o[oi + 1] = s[si + 1]!;
      o[oi + 2] = s[si + 2]!;
      o[oi + 3] = s[si + 3]!;
    }
  }
  return out;
}

/**
 * A noise tile: pixels of one colour (MONO), of two (DUO) or of any (MULTI, at `alpha`),
 * each pixel present with probability `density`.
 */
export function noiseTile(kind: 'MONO' | 'DUO' | 'MULTI', density: number, color: Color, second: Color, alpha: number, size = 128): ImageData {
  const img = new ImageData(size, size);
  const d = img.data;
  let seed = 0x6d2b79f5;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < d.length; i += 4) {
    if (rnd() >= density) {
      rnd();
      continue;
    }
    const pick = rnd();
    let c: Color;
    if (kind === 'MULTI') {
      // Any hue, fairly bright, as Figma's multicolour grain.
      const h = pick * 6;
      const k = h - Math.floor(h);
      const sector = Math.floor(h) % 6;
      const rgb = [[1, k, 0], [1 - k, 1, 0], [0, 1, k], [0, 1 - k, 1], [k, 0, 1], [1, 0, 1 - k]][sector]!;
      c = { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a: alpha };
    } else c = kind === 'DUO' && pick < 0.5 ? second : color;
    d[i] = c.r * 255;
    d[i + 1] = c.g * 255;
    d[i + 2] = c.b * 255;
    d[i + 3] = c.a * 255;
  }
  return img;
}

/**
 * Glass over what is already drawn. `backdrop` — the canvas under the layer (frosted),
 * `height` — the layer's mask blurred by half the glass depth (a dome: about 0.5 on the
 * edge, 1 deeper than `depth` inside), `mask` — the layer itself; all of the box size.
 * Near the edge the backdrop is taken from further out along the dome's slope
 * (refraction, up to `depth` px), its colours split (dispersion), and the rim facing the
 * light (`lightAngle`, degrees: 0 — from the left, −45 — from the top left) brightens.
 * The result keeps the mask's own alpha.
 */
export function glassPixels(
  backdrop: ImageData,
  height: ImageData,
  mask: ImageData,
  p: { refraction: number; depth: number; dispersion: number; lightAngle: number; lightIntensity: number; splay: number },
  /** Where the backdrop has pixels (the rest of the box lies past the canvas edge). */
  valid?: { x0: number; y0: number; x1: number; y1: number },
): ImageData {
  const { width: W, height: H } = backdrop;
  const vx0 = valid?.x0 ?? 0;
  const vy0 = valid?.y0 ?? 0;
  const vx1 = (valid?.x1 ?? W) - 1;
  const vy1 = (valid?.y1 ?? H) - 1;
  const out = new ImageData(W, H);
  const b = backdrop.data;
  const h = height.data;
  const m = mask.data;
  const o = out.data;
  const at = (x: number, y: number) => {
    const xi = x < 0 ? 0 : x >= W ? W - 1 : x;
    const yi = y < 0 ? 0 : y >= H ? H - 1 : y;
    return h[(yi * W + xi) * 4 + 3]! / 255;
  };
  const sample = (x: number, y: number, c: number) => {
    const xi = Math.min(vx1, Math.max(vx0, Math.round(x)));
    const yi = Math.min(vy1, Math.max(vy0, Math.round(y)));
    return b[(yi * W + xi) * 4 + c]!;
  };
  const rad = (p.lightAngle * Math.PI) / 180;
  // Towards the light, on the screen (y down).
  const lx = -Math.cos(rad);
  const ly = Math.sin(rad);
  const reach = p.refraction * p.depth;
  const split = p.dispersion * 0.5;
  const rimWidth = 0.15 + p.splay * 0.5;
  for (let y = vy0; y <= vy1; y++) {
    for (let x = vx0; x <= vx1; x++) {
      const i = (y * W + x) * 4;
      const alpha = m[i + 3]!;
      if (alpha === 0) continue;
      // The slope over a few pixels: the 8-bit height would ripple over one.
      const gx = (at(x + 2, y) + at(x + 1, y) - at(x - 1, y) - at(x - 2, y)) / 3;
      const gy = (at(x, y + 2) + at(x, y + 1) - at(x, y - 1) - at(x, y - 2)) / 3;
      const len = Math.hypot(gx, gy);
      // 1 on the edge, 0 where the dome is flat.
      const edge = Math.min(1, Math.max(0, (1 - at(x, y)) * 2));
      let ox = 0;
      let oy = 0;
      if (len > 1e-5) {
        // Taken from further out (against the slope, which climbs inwards).
        const k = (reach * edge * edge) / len;
        ox = -gx * k;
        oy = -gy * k;
      }
      o[i] = sample(x + ox * (1 + split), y + oy * (1 + split), 0);
      o[i + 1] = sample(x + ox, y + oy, 1);
      o[i + 2] = sample(x + ox * (1 - split), y + oy * (1 - split), 2);
      if (len > 1e-5 && p.lightIntensity > 0) {
        // The outward normal against the light: the lit rim, and a softer glint across.
        const facing = (-gx * lx - gy * ly) / len;
        const rim = Math.max(0, 1 - (1 - edge) / rimWidth);
        const light = (Math.max(0, facing) + Math.max(0, -facing) * 0.35) * rim * p.lightIntensity * 150;
        o[i] = clamp(o[i]! + light);
        o[i + 1] = clamp(o[i + 1]! + light);
        o[i + 2] = clamp(o[i + 2]! + light);
      }
      o[i + 3] = alpha;
    }
  }
  return out;
}
