// Vector paths (stage "Vectors"): contours of points with optional Bézier
// handles. Handles are absolute positions in the same space as the points, so
// transforming a path is transforming every coordinate.

import type { VectorPath, VectorPoint } from '#core';
import { apply, type Matrix } from './matrix.ts';
import { polygonPoints, starPoints } from './shapes.ts';
import type { Point, Rect } from './rect.ts';

const KAPPA = 0.5522847498;

/** Cubic segment from point a to point b (straight when both handles are absent). */
export interface Segment {
  p0: Point;
  c1: Point;
  c2: Point;
  p3: Point;
  line: boolean;
}

export function segmentsOf(path: VectorPath): Segment[] {
  const pts = path.points;
  const out: Segment[] = [];
  const n = pts.length;
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const c1 = a.out ?? { x: a.x, y: a.y };
    const c2 = b.in ?? { x: b.x, y: b.y };
    out.push({ p0: { x: a.x, y: a.y }, c1, c2, p3: { x: b.x, y: b.y }, line: !a.out && !b.in });
  }
  return out;
}

export function cubicAt(s: Segment, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p3.x, y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p3.y };
}

/** Splits a segment at t into two (de Casteljau). */
export function splitSegment(s: Segment, t: number): [Segment, Segment] {
  const lerp = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const ab = lerp(s.p0, s.c1);
  const bc = lerp(s.c1, s.c2);
  const cd = lerp(s.c2, s.p3);
  const abc = lerp(ab, bc);
  const bcd = lerp(bc, cd);
  const m = lerp(abc, bcd);
  return [
    { p0: s.p0, c1: ab, c2: abc, p3: m, line: s.line },
    { p0: m, c1: bcd, c2: cd, p3: s.p3, line: s.line },
  ];
}

/** Polyline approximation of a segment within `tolerance` px. */
function flattenSegment(s: Segment, tolerance: number, out: Point[]): void {
  if (s.line) {
    out.push(s.p3);
    return;
  }
  // Number of steps from the control polygon length (simple, stable, good enough for UI shapes).
  const len = dist(s.p0, s.c1) + dist(s.c1, s.c2) + dist(s.c2, s.p3);
  const steps = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / Math.max(0.01, tolerance)) * 1.5)));
  for (let i = 1; i <= steps; i++) out.push(cubicAt(s, i / steps));
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface Polyline {
  points: Point[];
  closed: boolean;
}

export function flattenPaths(paths: readonly VectorPath[], tolerance = 0.25): Polyline[] {
  return paths
    .filter((p) => p.points.length > 0)
    .map((p) => {
      const pts: Point[] = [{ x: p.points[0]!.x, y: p.points[0]!.y }];
      for (const s of segmentsOf(p)) flattenSegment(s, tolerance, pts);
      if (p.closed && pts.length > 1) pts.pop(); // last point repeats the first
      return { points: pts, closed: p.closed };
    });
}

/** Exact bounds, including curve extrema. */
export function pathsBounds(paths: readonly VectorPath[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Point) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const path of paths) {
    for (const p of path.points) add(p);
    for (const s of segmentsOf(path)) {
      if (s.line) continue;
      for (const t of cubicExtrema(s)) add(cubicAt(s, t));
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

function cubicExtrema(s: Segment): number[] {
  const ts: number[] = [];
  for (const k of ['x', 'y'] as const) {
    const a = -s.p0[k] + 3 * s.c1[k] - 3 * s.c2[k] + s.p3[k];
    const b = 2 * (s.p0[k] - 2 * s.c1[k] + s.c2[k]);
    const c = s.c1[k] - s.p0[k];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-c / b);
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const r = Math.sqrt(disc);
    ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
  }
  return ts.filter((t) => t > 0 && t < 1);
}

export function mapPaths(paths: readonly VectorPath[], fn: (p: Point) => Point): VectorPath[] {
  const map = (v: { x: number; y: number }) => fn(v);
  return paths.map((path) => ({
    closed: path.closed,
    points: path.points.map((pt) => {
      const q: VectorPoint = { ...map(pt) };
      if (pt.in) q.in = map(pt.in);
      if (pt.out) q.out = map(pt.out);
      return q;
    }),
  }));
}

export function transformPaths(paths: readonly VectorPath[], m: Matrix): VectorPath[] {
  return mapPaths(paths, (p) => apply(m, p));
}

/**
 * Rounds the sharp corners of a path (as Figma's corner radius on polygons, stars and
 * vector points): a corner between two straight segments becomes an arc of `radius`,
 * smaller where the segments are too short for it (arcs never pass the middle of a
 * segment). Curved joins and open ends stay as they are.
 */
export function roundCorners(path: VectorPath, radius: number): VectorPath {
  const pts = path.points;
  const n = pts.length;
  if (radius <= 0 || n < 3) return path;
  const out: VectorPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[(i + 1) % n]!;
    const end = !path.closed && (i === 0 || i === n - 1);
    const straight = !p.in && !p.out && !a.out && !b.in;
    const la = Math.hypot(a.x - p.x, a.y - p.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    if (end || !straight || la < 1e-9 || lb < 1e-9) {
      out.push({ ...p });
      continue;
    }
    const u = { x: (a.x - p.x) / la, y: (a.y - p.y) / la };
    const v = { x: (b.x - p.x) / lb, y: (b.y - p.y) / lb };
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    // Nearly straight on: nothing to round.
    if (angle > Math.PI - 1e-3 || angle < 1e-6) {
      out.push({ ...p });
      continue;
    }
    const half = Math.tan(angle / 2);
    const t = Math.min(radius / half, la / 2, lb / 2);
    const r = t * half;
    const k = (4 / 3) * Math.tan((Math.PI - angle) / 4) * r;
    const s = { x: p.x + u.x * t, y: p.y + u.y * t };
    const e = { x: p.x + v.x * t, y: p.y + v.y * t };
    out.push({ x: s.x, y: s.y, out: { x: s.x - u.x * k, y: s.y - u.y * k } });
    out.push({ x: e.x, y: e.y, in: { x: e.x - v.x * k, y: e.y - v.y * k } });
  }
  return { closed: path.closed, points: out };
}

/** Points of an elliptical arc from angle a0 to a1 (radians, clockwise on the screen), as cubic pieces of at most 90°. */
function ellipseArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): VectorPoint[] {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const da = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(da / 4);
  const out: VectorPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + da * i;
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    const dx = -rx * Math.sin(t) * k;
    const dy = ry * Math.cos(t) * k;
    const pt: VectorPoint = { x, y };
    if (i > 0) pt.in = { x: x - dx, y: y - dy };
    if (i < n) pt.out = { x: x + dx, y: y + dy };
    out.push(pt);
  }
  return out;
}

/**
 * An ellipse cut as Figma's arc tool cuts it: a ring (full sweep with a hole), an arc
 * band (part of the ring) or a pie (part to the centre).
 */
export function arcPaths(w: number, h: number, arc: { start: number; sweep: number; inner: number }): VectorPath[] {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const inner = Math.max(0, Math.min(0.999, arc.inner));
  const sweep = Math.max(-360, Math.min(360, arc.sweep));
  const a0 = (arc.start * Math.PI) / 180;
  if (Math.abs(sweep) >= 360) {
    // Whole: an ellipse, with the hole going the other way round (a ring under non-zero filling).
    const outer = ellipseArc(cx, cy, rx, ry, a0, a0 + Math.PI * 2);
    const first = outer[0]!;
    const last = outer.pop()!;
    first.in = last.in;
    const paths: VectorPath[] = [{ closed: true, points: outer }];
    if (inner > 0) {
      const hole = ellipseArc(cx, cy, rx * inner, ry * inner, a0 + Math.PI * 2, a0);
      const hFirst = hole[0]!;
      const hLast = hole.pop()!;
      hFirst.in = hLast.in;
      paths.push({ closed: true, points: hole });
    }
    return paths;
  }
  const a1 = a0 + (sweep * Math.PI) / 180;
  const points = ellipseArc(cx, cy, rx, ry, a0, a1);
  if (inner > 0) points.push(...ellipseArc(cx, cy, rx * inner, ry * inner, a1, a0));
  else points.push({ x: cx, y: cy });
  return [{ closed: true, points }];
}

/** Outline of a built-in shape as vector paths in its own box. */
export function shapePaths(
  type: string,
  p: { width: number; height: number; cornerRadius?: number; cornerRadii?: [number, number, number, number] | null; pointCount?: number; innerRadius?: number; arc?: { start: number; sweep: number; inner: number } | null },
): VectorPath[] {
  const w = p.width;
  const h = p.height;
  if (type === 'ELLIPSE' && p.arc) return arcPaths(w, h, p.arc);
  if (type === 'ELLIPSE') {
    const rx = w / 2;
    const ry = h / 2;
    const cx = rx;
    const cy = ry;
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return [
      {
        closed: true,
        points: [
          { x: cx, y: 0, in: { x: cx - kx, y: 0 }, out: { x: cx + kx, y: 0 } },
          { x: w, y: cy, in: { x: w, y: cy - ky }, out: { x: w, y: cy + ky } },
          { x: cx, y: h, in: { x: cx + kx, y: h }, out: { x: cx - kx, y: h } },
          { x: 0, y: cy, in: { x: 0, y: cy + ky }, out: { x: 0, y: cy - ky } },
        ],
      },
    ];
  }
  if (type === 'POLYGON' || type === 'STAR') {
    const pts = type === 'POLYGON' ? polygonPoints(w, h, p.pointCount ?? 3) : starPoints(w, h, p.pointCount ?? 5, p.innerRadius ?? 0.382);
    return [roundCorners({ closed: true, points: pts.map((q) => ({ x: q.x, y: q.y })) }, p.cornerRadius ?? 0)];
  }
  if (type === 'LINE') return [{ closed: false, points: [{ x: 0, y: 0 }, { x: w, y: 0 }] }];
  // Rectangle (and frames) with rounded corners as cubic arcs.
  const max = Math.min(w, h) / 2;
  const radii = (p.cornerRadii ?? [p.cornerRadius ?? 0, p.cornerRadius ?? 0, p.cornerRadius ?? 0, p.cornerRadius ?? 0]).map((r) => Math.max(0, Math.min(max, r)));
  const [tl, tr, br, bl] = radii as [number, number, number, number];
  if (tl + tr + br + bl === 0) {
    return [{ closed: true, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }];
  }
  const pts: VectorPoint[] = [];
  const corner = (r: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    // From point a (on the incoming edge) to point b (on the outgoing edge) around corner c.
    if (r === 0) {
      pts.push({ x: cx, y: cy });
      return;
    }
    pts.push({ x: ax, y: ay, out: { x: ax + (cx - ax) * KAPPA, y: ay + (cy - ay) * KAPPA } });
    pts.push({ x: bx, y: by, in: { x: bx + (cx - bx) * KAPPA, y: by + (cy - by) * KAPPA } });
  };
  corner(tl, 0, tl, tl, 0, 0, 0);
  corner(tr, w - tr, 0, w, tr, w, 0);
  corner(br, w, h - br, w - br, h, w, h);
  corner(bl, bl, h, 0, h - bl, 0, h);
  return [{ closed: true, points: pts }];
}

/** Nearest point on a path's segments: segment index, parameter and distance. */
export function nearestOnPath(path: VectorPath, p: Point): { index: number; t: number; point: Point; distance: number } | null {
  let best: { index: number; t: number; point: Point; distance: number } | null = null;
  segmentsOf(path).forEach((s, index) => {
    const steps = s.line ? 1 : 48;
    // Coarse search then local refinement.
    let bt = 0;
    let bd = Infinity;
    if (s.line) {
      const dx = s.p3.x - s.p0.x;
      const dy = s.p3.y - s.p0.y;
      const len2 = dx * dx + dy * dy;
      bt = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.p0.x) * dx + (p.y - s.p0.y) * dy) / len2));
      bd = dist(p, { x: s.p0.x + dx * bt, y: s.p0.y + dy * bt });
    } else {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const d = dist(p, cubicAt(s, t));
        if (d < bd) {
          bd = d;
          bt = t;
        }
      }
      let step = 1 / steps;
      for (let k = 0; k < 12; k++) {
        step /= 2;
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const d = dist(p, cubicAt(s, t));
          if (d < bd) {
            bd = d;
            bt = t;
          }
        }
      }
    }
    if (!best || bd < best.distance) best = { index, t: bt, point: cubicAt(s, bt), distance: bd };
  });
  return best;
}

/** Inserts a point on segment `index` at `t`, keeping the curve shape. */
export function insertPoint(path: VectorPath, index: number, t: number): VectorPath {
  const segs = segmentsOf(path);
  const s = segs[index];
  if (!s) return path;
  const pts = path.points.map((q) => ({ ...q }));
  const a = pts[index]!;
  const bIndex = (index + 1) % pts.length;
  const b = pts[bIndex]!;
  if (s.line) {
    const m = cubicAt(s, t);
    pts.splice(index + 1, 0, { x: m.x, y: m.y });
    return { closed: path.closed, points: pts };
  }
  const [left, right] = splitSegment(s, t);
  a.out = left.c1;
  const mid: VectorPoint = { x: left.p3.x, y: left.p3.y, in: left.c2, out: right.c1 };
  b.in = right.c2;
  pts.splice(index + 1, 0, mid);
  return { closed: path.closed, points: pts };
}

/** SVG path data (for export and copying as SVG). */
export function pathsToSvg(paths: readonly VectorPath[]): string {
  const f = (v: number) => String(Math.round(v * 1000) / 1000);
  return paths
    .filter((p) => p.points.length > 0)
    .map((path) => {
      const first = path.points[0]!;
      let d = `M${f(first.x)} ${f(first.y)}`;
      for (const s of segmentsOf(path)) d += s.line ? `L${f(s.p3.x)} ${f(s.p3.y)}` : `C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.p3.x)} ${f(s.p3.y)}`;
      return path.closed ? `${d}Z` : d;
    })
    .join('');
}
