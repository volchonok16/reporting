// Outlines of parametric shapes in a node's own box (0..w, 0..h).

import type { Point } from './rect.ts';

/** Regular polygon inscribed in the box, first vertex at the top. */
export function polygonPoints(w: number, h: number, sides: number): Point[] {
  const n = Math.max(3, Math.round(sides));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push({ x: w / 2 + (Math.cos(a) * w) / 2, y: h / 2 + (Math.sin(a) * h) / 2 });
  }
  return out;
}

/** Star with `points` tips; `inner` is the inner radius as a share of the outer one. */
export function starPoints(w: number, h: number, points: number, inner: number): Point[] {
  const n = Math.max(3, Math.round(points));
  const k = Math.min(1, Math.max(0.01, inner));
  const out: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : k;
    out.push({ x: w / 2 + (Math.cos(a) * w * r) / 2, y: h / 2 + (Math.sin(a) * h * r) / 2 });
  }
  return out;
}

/** Even-odd point-in-polygon test. */
export function polygonContains(points: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
