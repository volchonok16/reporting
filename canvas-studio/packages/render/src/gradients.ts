// Angular and diamond gradients, which neither SVG nor PDF (nor, for the
// diamond, the canvas) can draw: the colour at any point of the layer, and
// a grid of pixels for exports and the canvas to use as a picture.

import type { Color, GradientPaint } from '#core';

/** Where a point (layer units, w × h box) falls on the gradient: 0 at the start, 1 at the end. */
export function gradientT(p: GradientPaint, x: number, y: number, w: number, h: number): number {
  const cx = p.from.x * w;
  const cy = p.from.y * h;
  const dx = p.to.x * w - cx;
  const dy = p.to.y * h - cy;
  const len = Math.hypot(dx, dy) || 1e-6;
  const px = x - cx;
  const py = y - cy;
  switch (p.type) {
    case 'GRADIENT_LINEAR':
      return (px * dx + py * dy) / (len * len);
    case 'GRADIENT_RADIAL':
      return Math.hypot(px, py) / len;
    case 'GRADIENT_ANGULAR': {
      // Clockwise on screen (y down) from the direction toward `to`.
      const a = Math.atan2(py, px) - Math.atan2(dy, dx);
      return (((a / (Math.PI * 2)) % 1) + 1) % 1;
    }
    case 'GRADIENT_DIAMOND': {
      const ux = dx / len;
      const uy = dy / len;
      return (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
    }
  }
}

/** The colour at `t` between the stops (straight alpha), the paint's opacity applied. */
export function colorAt(p: GradientPaint, t: number): Color {
  const stops = [...p.stops].sort((a, b) => a.position - b.position);
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  let c: Color;
  if (t <= stops[0]!.position) c = stops[0]!.color;
  else if (t >= stops[stops.length - 1]!.position) c = stops[stops.length - 1]!.color;
  else {
    let i = 1;
    while (stops[i]!.position < t) i++;
    const a = stops[i - 1]!;
    const b = stops[i]!;
    const k = (t - a.position) / Math.max(1e-9, b.position - a.position);
    c = { r: a.color.r + (b.color.r - a.color.r) * k, g: a.color.g + (b.color.g - a.color.g) * k, b: a.color.b + (b.color.b - a.color.b) * k, a: a.color.a + (b.color.a - a.color.a) * k };
  }
  return { ...c, a: c.a * p.opacity };
}

/**
 * RGBA pixels of a gradient over a w × h box, `cols × rows` of them (each pixel
 * samples its centre). An angular gradient's seam stays sharp; everything else
 * is smooth, so a modest grid scaled up looks right.
 */
export function gradientPixels(p: GradientPaint, w: number, h: number, cols: number, rows: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let j = 0; j < rows; j++) {
    const y = ((j + 0.5) / rows) * h;
    for (let i = 0; i < cols; i++) {
      const c = colorAt(p, gradientT(p, ((i + 0.5) / cols) * w, y, w, h));
      const o = (j * cols + i) * 4;
      out[o] = c.r * 255;
      out[o + 1] = c.g * 255;
      out[o + 2] = c.b * 255;
      out[o + 3] = c.a * 255;
    }
  }
  return out;
}

/** A grid size for a picture of a w × h gradient: about `max` pixels on the long side. */
export function gradientGrid(w: number, h: number, max = 256): { cols: number; rows: number } {
  const k = max / Math.max(1, w, h);
  return { cols: Math.max(2, Math.round(Math.max(1, w) * k)), rows: Math.max(2, Math.round(Math.max(1, h) * k)) };
}
