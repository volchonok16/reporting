// Warps for mockups: where a point of a layer's flat picture lands once the
// picture is laid onto a surface. Everything is in the layer's unit space
// (0..1 of its width and height); the renderer draws the picture through a mesh
// of small triangles following `warpPoint`.

import type { Vec, Warp } from '#core';
import type { Point } from './rect.ts';

export const UNWARPED_CORNERS: [Vec, Vec, Vec, Vec] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export function defaultWarp(type: Warp['type']): Warp {
  return type === 'PERSPECTIVE'
    ? { type, corners: UNWARPED_CORNERS.map((c) => ({ ...c })) as [Vec, Vec, Vec, Vec] }
    : { type, axis: 'VERTICAL', bend: 140, tilt: 0.1, taper: 0, shade: 0.3 };
}

/** A projective map of the unit square onto four corners (top-left, top-right, bottom-right, bottom-left). */
export function squareToQuad(q: readonly [Vec, Vec, Vec, Vec]): (u: number, v: number) => Point {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    // A parallelogram: an affine map is enough.
    a = p1.x - p0.x;
    b = p3.x - p0.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p3.y - p0.y;
    f = p0.y;
    g = 0;
    h = 0;
  } else {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = den === 0 ? 0 : (sx * dy2 - dx2 * sy) / den;
    h = den === 0 ? 0 : (dx1 * sy - sx * dy1) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }
  return (u, v) => {
    const w = g * u + h * v + 1;
    // Behind the eye (a corner dragged across the opposite side): keep the point finite.
    const k = Math.abs(w) < 1e-6 ? 1e-6 : w;
    return { x: (a * u + b * v + c) / k, y: (d * u + e * v + f) / k };
  };
}

/** Where (u, v) of the flat picture lands, in unit space. */
export function warpMap(warp: Warp): (u: number, v: number) => Point {
  if (warp.type === 'PERSPECTIVE') return squareToQuad(warp.corners);
  const { bend, tilt, taper, axis } = warp;
  const half = (Math.min(179, Math.max(0, bend)) * Math.PI) / 360;
  // Across the axis: a point at angle θ on the round surface is seen at sin θ; along it the
  // edges follow the ellipse of the rim (cos θ), the front lowest when seen from above.
  const across = (s: number) => (half < 1e-3 ? s : 0.5 + (0.5 * Math.sin((s - 0.5) * 2 * half)) / Math.sin(half));
  const front = (s: number) => {
    if (half < 1e-3) return 1 - (2 * s - 1) ** 2;
    const edge = Math.cos(half);
    return (Math.cos((s - 0.5) * 2 * half) - edge) / (1 - edge);
  };
  const t = Math.max(-0.5, Math.min(0.5, tilt));
  const k = Math.max(-0.5, Math.min(0.5, taper));
  const map = (s: number, r: number): [number, number] => {
    const c = front(s);
    const along = r * (1 - Math.abs(t)) + (t > 0 ? t * c : -t * (1 - c));
    const width = 1 - Math.abs(k) * (k > 0 ? along : 1 - along);
    return [0.5 + (across(s) - 0.5) * width, along];
  };
  if (axis === 'HORIZONTAL') {
    return (u, v) => {
      const [y, x] = map(v, u);
      return { x, y };
    };
  }
  return (u, v) => {
    const [x, y] = map(u, v);
    return { x, y };
  };
}

/** How darker a cylinder is at `s` across its axis (0 — the front, 1 — the edge). */
export function cylinderShade(warp: Extract<Warp, { type: 'CYLINDER' }>, s: number): number {
  const half = (Math.min(179, Math.max(0, warp.bend)) * Math.PI) / 360;
  if (half < 1e-3) return 0;
  const edge = Math.cos(half);
  return Math.max(0, Math.min(1, (1 - Math.cos((s - 0.5) * 2 * half)) / (1 - edge)));
}

/** Mesh density: perspective bends lines everywhere; a cylinder only across its axis. */
export function warpGrid(warp: Warp): { cols: number; rows: number } {
  if (warp.type === 'PERSPECTIVE') return { cols: 12, rows: 12 };
  return warp.axis === 'VERTICAL' ? { cols: 36, rows: 4 } : { cols: 4, rows: 36 };
}

/** The outline of the warped box in unit space (for hit testing and bounds). */
export function warpOutline(warp: Warp, steps = 16): Point[] {
  const map = warpMap(warp);
  const out: Point[] = [];
  for (let i = 0; i < steps; i++) out.push(map(i / steps, 0));
  for (let i = 0; i < steps; i++) out.push(map(1, i / steps));
  for (let i = 0; i < steps; i++) out.push(map(1 - i / steps, 1));
  for (let i = 0; i < steps; i++) out.push(map(0, 1 - i / steps));
  return out;
}

/** The box of the warped layer in unit space. */
export function warpExtent(warp: Warp): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = warpOutline(warp);
  return {
    minX: Math.min(0, ...pts.map((p) => p.x)),
    minY: Math.min(0, ...pts.map((p) => p.y)),
    maxX: Math.max(1, ...pts.map((p) => p.x)),
    maxY: Math.max(1, ...pts.map((p) => p.y)),
  };
}

/** True when the warp changes nothing (corners in place, a flat cylinder). */
export function isIdentityWarp(warp: Warp): boolean {
  if (warp.type === 'PERSPECTIVE') return warp.corners.every((c, i) => Math.abs(c.x - UNWARPED_CORNERS[i]!.x) < 1e-6 && Math.abs(c.y - UNWARPED_CORNERS[i]!.y) < 1e-6);
  return warp.bend <= 0 && warp.tilt === 0 && warp.taper === 0;
}

/**
 * Corners of an isometric face for a layer of w × h (mockups): lying flat (a book on a
 * table), or a wall facing left or right (a box's side). The face keeps the layer's
 * proportions and is fitted into its box.
 */
export function isometricCorners(face: 'FLAT' | 'LEFT' | 'RIGHT', w: number, h: number): [Vec, Vec, Vec, Vec] {
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  // Where the layer's own axes go on the screen.
  const across = face === 'LEFT' ? { x: cos, y: sin } : { x: cos, y: -sin };
  const down = face === 'FLAT' ? { x: cos, y: sin } : { x: 0, y: 1 };
  const raw = [
    { x: 0, y: 0 },
    { x: across.x * w, y: across.y * w },
    { x: across.x * w + down.x * h, y: across.y * w + down.y * h },
    { x: down.x * h, y: down.y * h },
  ];
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const spanX = Math.max(...raw.map((p) => p.x)) - minX;
  const spanY = Math.max(...raw.map((p) => p.y)) - minY;
  const k = Math.min(w / spanX, h / spanY);
  const offX = (w - spanX * k) / 2;
  const offY = (h - spanY * k) / 2;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return raw.map((p) => ({ x: round((offX + (p.x - minX) * k) / w), y: round((offY + (p.y - minY) * k) / h) })) as [Vec, Vec, Vec, Vec];
}

/** Four corners that make a convex shape: a perspective of anything else turns inside out. */
export function isConvexQuad(q: readonly Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}
