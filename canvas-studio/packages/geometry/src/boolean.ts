// Boolean operations on polygons (union, subtract, intersect, exclude).
//
// Method (planar arrangement): every edge of both operands is split at all
// intersections; each piece is kept when the regions on its two sides differ
// in the result, oriented so that the result lies on its left; kept pieces are
// chained into contours. It handles holes, several contours, touching and
// overlapping edges, and any fill rule of the operands, with plain arithmetic.

import type { Point } from './rect.ts';

export type BoolOp = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE';
export type FillRule = 'NONZERO' | 'EVENODD';

/** A region: closed contours and the rule that decides what is inside. */
export interface Region {
  contours: Point[][];
  rule: FillRule;
}

export function winding(contours: readonly Point[][], p: Point): number {
  let w = 0;
  for (const c of contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const a = c[j]!;
      const b = c[i]!;
      if (a.y <= p.y) {
        if (b.y > p.y && cross(a, b, p) > 0) w++;
      } else if (b.y <= p.y && cross(a, b, p) < 0) w--;
    }
  }
  return w;
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

export function insideRegion(r: Region, p: Point): boolean {
  const w = winding(r.contours, p);
  return r.rule === 'EVENODD' ? Math.abs(w) % 2 === 1 : w !== 0;
}

interface Edge {
  a: Point;
  b: Point;
  ts: number[];
}

const EPS = 1e-9;

function edgesOf(r: Region): Edge[] {
  const out: Edge[] = [];
  for (const c of r.contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i]!;
      const b = c[(i + 1) % c.length]!;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > EPS) out.push({ a, b, ts: [] });
    }
  }
  return out;
}

/** Records where two edges cross or overlap (parameters along each). */
function intersect(e: Edge, f: Edge): void {
  const rx = e.b.x - e.a.x;
  const ry = e.b.y - e.a.y;
  const sx = f.b.x - f.a.x;
  const sy = f.b.y - f.a.y;
  const denom = rx * sy - ry * sx;
  const qpx = f.a.x - e.a.x;
  const qpy = f.a.y - e.a.y;
  const lenE = Math.hypot(rx, ry);
  const lenF = Math.hypot(sx, sy);
  const tol = 1e-7 * Math.max(1, lenE, lenF);
  if (Math.abs(denom) <= tol * Math.max(lenE, lenF)) {
    // Parallel: if collinear, each edge is split at the other's end points.
    if (Math.abs(qpx * ry - qpy * rx) > tol * lenE) return;
    const onE = (p: Point) => {
      const t = ((p.x - e.a.x) * rx + (p.y - e.a.y) * ry) / (lenE * lenE);
      if (t > EPS && t < 1 - EPS) e.ts.push(t);
    };
    const onF = (p: Point) => {
      const u = ((p.x - f.a.x) * sx + (p.y - f.a.y) * sy) / (lenF * lenF);
      if (u > EPS && u < 1 - EPS) f.ts.push(u);
    };
    onE(f.a);
    onE(f.b);
    onF(e.a);
    onF(e.b);
    return;
  }
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return;
  if (t > EPS && t < 1 - EPS) e.ts.push(t);
  if (u > EPS && u < 1 - EPS) f.ts.push(u);
}

function key(p: Point): string {
  return `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`;
}

function snap(p: Point): Point {
  return { x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 };
}

function result(op: BoolOp, a: boolean, b: boolean): boolean {
  switch (op) {
    case 'UNION':
      return a || b;
    case 'SUBTRACT':
      return a && !b;
    case 'INTERSECT':
      return a && b;
    case 'EXCLUDE':
      return a !== b;
  }
}

/** Boolean operation of two regions; the result uses the non-zero rule. */
export function booleanRegions(op: BoolOp, A: Region, B: Region): Region {
  const edges = [...edgesOf(A), ...edgesOf(B)];
  // All pairwise intersections (shapes in a design file are small; O(n²) is fine).
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const eminx = Math.min(e.a.x, e.b.x);
    const emaxx = Math.max(e.a.x, e.b.x);
    const eminy = Math.min(e.a.y, e.b.y);
    const emaxy = Math.max(e.a.y, e.b.y);
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j]!;
      if (Math.max(f.a.x, f.b.x) < eminx - 1e-6 || Math.min(f.a.x, f.b.x) > emaxx + 1e-6 || Math.max(f.a.y, f.b.y) < eminy - 1e-6 || Math.min(f.a.y, f.b.y) > emaxy + 1e-6) continue;
      intersect(e, f);
    }
  }
  // Split, snap and de-duplicate pieces.
  const pieces = new Map<string, [Point, Point]>();
  for (const e of edges) {
    const ts = [0, ...e.ts.sort((x, y) => x - y), 1];
    for (let i = 0; i < ts.length - 1; i++) {
      if (ts[i + 1]! - ts[i]! < 1e-12) continue;
      const p = snap({ x: e.a.x + (e.b.x - e.a.x) * ts[i]!, y: e.a.y + (e.b.y - e.a.y) * ts[i]! });
      const q = snap({ x: e.a.x + (e.b.x - e.a.x) * ts[i + 1]!, y: e.a.y + (e.b.y - e.a.y) * ts[i + 1]! });
      const kp = key(p);
      const kq = key(q);
      if (kp === kq) continue;
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      if (!pieces.has(k)) pieces.set(k, [p, q]);
    }
  }
  // Keep the pieces where the result changes across them; orient with the result on the left.
  const kept: [Point, Point][] = [];
  for (const [p, q] of pieces.values()) {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const d = Math.min(len * 0.25, 1e-3);
    const left = { x: mx + nx * d, y: my + ny * d };
    const right = { x: mx - nx * d, y: my - ny * d };
    const inL = result(op, insideRegion(A, left), insideRegion(B, left));
    const inR = result(op, insideRegion(A, right), insideRegion(B, right));
    if (inL === inR) continue;
    kept.push(inL ? [p, q] : [q, p]);
  }
  return { contours: chain(kept), rule: 'NONZERO' };
}

/** Joins oriented pieces into closed contours. */
function chain(pieces: [Point, Point][]): Point[][] {
  const byStart = new Map<string, number[]>();
  pieces.forEach(([p], i) => {
    const k = key(p);
    const list = byStart.get(k);
    if (list) list.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Array<boolean>(pieces.length).fill(false);
  const contours: Point[][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    const contour: Point[] = [];
    let cur = i;
    const startKey = key(pieces[i]![0]);
    let guard = pieces.length + 1;
    while (guard-- > 0) {
      used[cur] = true;
      const [p, q] = pieces[cur]!;
      contour.push(p);
      const kq = key(q);
      if (kq === startKey) break;
      const next = (byStart.get(kq) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      cur = next;
    }
    const simple = simplify(contour);
    if (simple.length >= 3 && Math.abs(area(simple)) > 1e-9) contours.push(simple);
  }
  return contours;
}

/** Removes collinear and duplicate points. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length]!;
      const b = out[i]!;
      const c = out[(i + 1) % out.length]!;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (Math.abs(cross(a, c, b)) <= 1e-7 * Math.max(1, len) && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) >= 0) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function area(points: readonly Point[]): number {
  let s = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) s += (points[j]!.x + points[i]!.x) * (points[j]!.y - points[i]!.y);
  return s / 2;
}

/**
 * Combines several regions the way a design tool does: UNION of all,
 * SUBTRACT the rest from the first (bottom) one, INTERSECT all, EXCLUDE (XOR) all.
 */
export function booleanAll(op: BoolOp, regions: readonly Region[]): Region {
  if (regions.length === 0) return { contours: [], rule: 'NONZERO' };
  let acc: Region = regions[0]!;
  if (op === 'SUBTRACT') {
    if (regions.length === 1) return acc;
    let rest: Region = regions[1]!;
    for (const r of regions.slice(2)) rest = booleanRegions('UNION', rest, r);
    return booleanRegions('SUBTRACT', acc, rest);
  }
  for (const r of regions.slice(1)) acc = booleanRegions(op, acc, r);
  // A single region still gets normalised (self-intersections resolved).
  if (regions.length === 1) acc = booleanRegions('UNION', acc, { contours: [], rule: 'NONZERO' });
  return acc;
}
