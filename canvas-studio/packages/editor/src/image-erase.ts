// Erasing a picture with a brush (the painted edge of book covers and posters): the
// picture keeps its pixels, only how much of each is shown (alpha) changes, so the
// "Restore" brush brings back what was erased — even later, from the picture as it
// was before erasing (kept in the fill as `eraseSource`). A common way of working is
// "hide all", then paint the picture back in with textured brushes.
//
// Brushes are our own: hard and soft round ones; torn (the edge follows value noise
// laid over the picture, flecks past it); dry (bristles along the stroke, broken where
// the brush runs dry, sparser at the sides); splatter (drops thrown round the stroke).
// A stroke has an opacity: inside one stroke it does not build up (each pixel keeps the
// most the brush gave it), as in raster editors; a new stroke adds to the last.

export type EraseBrush = 'hard' | 'soft' | 'torn' | 'dry' | 'splatter';
export type EraseMode = 'erase' | 'restore';

/** Value noise in 0..1 at a point (smooth between whole coordinates). */
function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Fractal noise (three octaves) in 0..1. */
function fbm(x: number, y: number, seed: number): number {
  return (noise(x, y, seed) * 4 + noise(x * 2.1, y * 2.1, seed + 1) * 2 + noise(x * 4.3, y * 4.3, seed + 2)) / 7;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface EraseState {
  width: number;
  height: number;
  /** How much of each pixel is shown, 0..255 (the picture's own alpha is under it). */
  shown: Uint8ClampedArray;
  /** The most each pixel can show: the alpha of the picture before erasing. */
  full: Uint8ClampedArray;
}

export interface BrushOptions {
  brush: EraseBrush;
  mode: EraseMode;
  /** Radius, pixels of the picture. */
  radius: number;
  /** 0..1: how far the solid middle reaches (round brushes). */
  hardness: number;
  /** 0..1: how much one stroke erases or brings back. */
  opacity: number;
  seed: number;
}

export type Box = { x: number; y: number; w: number; h: number };

/** One stroke: what was shown when it began and how much the brush has covered each pixel. */
export class Stroke {
  readonly state: EraseState;
  readonly options: BrushOptions;
  /** What was shown when the stroke began (also the undo step). */
  readonly base: Uint8ClampedArray;
  private readonly cover: Uint8Array;
  /** Distance along the stroke (the dry brush's bristles break along it). */
  private travelled = 0;
  private dabs = 0;
  last: { x: number; y: number } | null = null;

  constructor(state: EraseState, options: BrushOptions) {
    this.state = state;
    this.options = options;
    this.base = state.shown.slice();
    this.cover = new Uint8Array(state.width * state.height);
  }

  /** The stroke goes on to a point; returns the box touched. */
  to(p: { x: number; y: number }): Box | null {
    const a = this.last ?? p;
    this.last = p;
    const r = this.options.radius;
    const len = Math.hypot(p.x - a.x, p.y - a.y);
    const dir = len > 1e-6 ? { x: (p.x - a.x) / len, y: (p.y - a.y) / len } : (this.dir ?? { x: 1, y: 0 });
    this.dir = dir;
    const spacing = this.options.brush === 'splatter' ? Math.max(1, r * 0.6) : Math.max(0.5, r * 0.15);
    const steps = Math.max(1, Math.ceil(len / spacing));
    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (let i = len === 0 ? steps : 1; i <= steps; i++) {
      const t = i / steps;
      const got = this.dab(a.x + (p.x - a.x) * t, a.y + (p.y - a.y) * t, dir, this.travelled + len * t);
      if (!got) continue;
      box = box ? { x0: Math.min(box.x0, got.x), y0: Math.min(box.y0, got.y), x1: Math.max(box.x1, got.x + got.w), y1: Math.max(box.y1, got.y + got.h) } : { x0: got.x, y0: got.y, x1: got.x + got.w, y1: got.y + got.h };
    }
    this.travelled += len;
    return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } : null;
  }

  private dir: { x: number; y: number } | null = null;

  /** Coverage 0..1 of one dab at a pixel offset (dx, dy) from its centre; x, y — the pixel. */
  private coverage(dx: number, dy: number, x: number, y: number, dir: { x: number; y: number }, along: number): number {
    const { brush, radius: r, hardness, seed } = this.options;
    const d = Math.hypot(dx, dy);
    switch (brush) {
      case 'hard':
        return smooth(r + 0.5 - d);
      case 'soft': {
        const solid = r * Math.min(0.98, hardness);
        return d >= r ? 0 : d <= solid ? 1 : 1 - smooth((d - solid) / (r - solid));
      }
      case 'torn': {
        // The edge moves in and out with the noise; past it, flecks where the finer noise peaks.
        const grain = 3 / Math.max(1, r);
        const edge = r * (0.62 + 0.55 * fbm(x * grain, y * grain, seed));
        if (d <= edge - 1) return 1;
        if (d <= edge + 1) return (edge + 1 - d) / 2;
        const reach = r * 1.7;
        if (d >= reach) return 0;
        const fleck = noise(x * grain * 3.5, y * grain * 3.5, seed + 7);
        const fade = 1 - (d - edge) / (reach - edge);
        return fleck > 0.86 - 0.12 * fade ? Math.min(1, fade * 1.5) : 0;
      }
      case 'dry': {
        // Across the stroke (u) bristles of their own thickness; along it (s) each runs dry in places.
        const u = -dx * dir.y + dy * dir.x;
        const s = along + dx * dir.x + dy * dir.y;
        const side = Math.abs(u) / r;
        if (side >= 1) return 0;
        const bristle = noise(u * (9 / r) + 0.5, seed * 0.37, seed);
        const fibres = noise(u * (26 / r), 3.3, seed + 3);
        const present = smooth((bristle * 0.75 + fibres * 0.25 - (0.12 + 0.62 * side ** 3)) * 10);
        if (present <= 0) return 0;
        const dry = noise(u * (9 / r) + 0.5, s * (1.2 / r), seed + 5);
        const wet = smooth((dry - (0.04 + 0.5 * side * side)) * 6);
        // Each bristle touches down at its own place: the start of the stroke is ragged, not cut square.
        const touch = noise(u * (9 / r) + 7.5, 1.7, seed + 9) * r * 0.9;
        const start = smooth((s + r * 0.15 - touch) / Math.max(1, r * 0.12));
        return present * wet * start;
      }
      case 'splatter':
        return 0; // drops are laid in dab()
    }
  }

  private dab(cx: number, cy: number, dir: { x: number; y: number }, along: number): Box | null {
    const { width, height } = this.state;
    const r = this.options.radius;
    if (this.options.brush === 'splatter') return this.splatter(cx, cy);
    const reach = this.options.brush === 'torn' ? r * 1.7 : r + 1;
    const x0 = Math.max(0, Math.floor(cx - reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const x1 = Math.min(width - 1, Math.ceil(cx + reach));
    const y1 = Math.min(height - 1, Math.ceil(cy + reach));
    if (x0 > x1 || y0 > y1) return null;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = this.coverage(x + 0.5 - cx, y + 0.5 - cy, x, y, dir, along);
        if (k > 0) this.cover1(y * width + x, k);
      }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Drops thrown round the stroke: many small, a few large, more near the middle. */
  private splatter(cx: number, cy: number): Box | null {
    const { width } = this.state;
    const { radius: r, seed } = this.options;
    const n = this.dabs++;
    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    const count = 6 + Math.round(r / 6);
    for (let i = 0; i < count; i++) {
      const h1 = hash(n, i, seed);
      const h2 = hash(n, i, seed + 11);
      const h3 = hash(n, i, seed + 23);
      const angle = h1 * Math.PI * 2;
      const dist = r * 1.4 * Math.sqrt(h2) * h2;
      const size = Math.max(0.7, r * (0.02 + 0.16 * h3 ** 4));
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;
      const x0 = Math.max(0, Math.floor(px - size - 1));
      const y0 = Math.max(0, Math.floor(py - size - 1));
      const x1 = Math.min(width - 1, Math.ceil(px + size + 1));
      const y1 = Math.min(this.state.height - 1, Math.ceil(py + size + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const k = smooth(size + 0.5 - Math.hypot(x + 0.5 - px, y + 0.5 - py));
          if (k > 0) this.cover1(y * width + x, k);
        }
      }
      if (x0 <= x1 && y0 <= y1) box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1 + 1), y1: Math.max(box.y1, y1 + 1) } : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    }
    return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } : null;
  }

  /** A pixel covered by k (0..1): the most the stroke gave it, times the opacity, applied to what it began with. */
  private cover1(p: number, k: number): void {
    const v = Math.round(k * 255);
    if (v <= this.cover[p]!) return;
    this.cover[p] = v;
    const amount = (v / 255) * this.options.opacity;
    const base = this.base[p]!;
    this.state.shown[p] = this.options.mode === 'erase' ? base * (1 - amount) : base + (this.state.full[p]! - base) * amount;
  }
}
