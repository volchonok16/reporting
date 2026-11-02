// Strokes of varying width (Figma Draw's width profiles and brushes): the
// stroke becomes a filled shape around the path, as wide at each point as the
// profile and the brush say. One shape serves the canvas, SVG and PDF alike.

import type { BrushKind, CustomBrush, StrokeProfile, VectorPath, WidthPoint } from '#core';
import { flattenPaths } from './vector.ts';

/** Width along the path, 0..1 of the stroke weight, by the share of the length `t`. */
export function profileWidth(profile: StrokeProfile, t: number): number {
  switch (profile) {
    case 'UNIFORM':
      return 1;
    case 'TAPER_BOTH':
      return Math.sqrt(Math.max(0, Math.sin(Math.PI * t)));
    case 'TAPER_START':
      return Math.min(1, Math.sqrt(t / 0.85));
    case 'TAPER_END':
      return Math.min(1, Math.sqrt((1 - t) / 0.85));
    case 'TEARDROP':
      // Round head near the start, a long tail.
      return t < 0.25 ? Math.sqrt(Math.max(0, Math.sin((Math.PI / 2) * (t / 0.25)))) * 0.95 + 0.05 : Math.max(0, 1 - ((t - 0.25) / 0.75) ** 1.4);
    case 'WAVE':
      return 0.55 + 0.45 * Math.sin(t * Math.PI * 6 - Math.PI / 2) * -1;
    case 'CUSTOM':
      return 1;
  }
}

/** Width at `t` from width points: smooth between them; the ends are 1 unless a point is there. */
export function widthAt(points: readonly WidthPoint[], t: number): number {
  const list = [...points].sort((a, b) => a.t - b.t);
  if (list.length === 0) return 1;
  const all = [...(list[0]!.t > 0.001 ? [{ t: 0, width: 1 }] : []), ...list, ...(list[list.length - 1]!.t < 0.999 ? [{ t: 1, width: 1 }] : [])];
  if (t <= all[0]!.t) return all[0]!.width;
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1]!;
    const b = all[i]!;
    if (t <= b.t) {
      const f = b.t - a.t > 0 ? (t - a.t) / (b.t - a.t) : 1;
      const s = f * f * (3 - 2 * f);
      return a.width + (b.width - a.width) * s;
    }
  }
  return all[all.length - 1]!.width;
}

/** Smooth noise in −1..1 along a line (the same for the same seed: a stroke looks the same every time). */
function noise(x: number, seed: number): number {
  const hash = (i: number) => {
    let h = Math.imul(i ^ seed, 0x27d4eb2d) ^ 0x165667b1;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/** How a brush changes the width at a distance `s` (px) along the path, `t` of the length. */
function brushWidth(brush: BrushKind, s: number, t: number, seed: number): number {
  switch (brush) {
    case 'NONE':
    case 'MARKER':
    case 'CUSTOM':
      return 1;
    case 'PENCIL':
      // Small fast wobble, ends a little thinner (the lead lifts off the paper).
      return (0.85 + 0.12 * noise(s / 3, seed)) * Math.min(1, 0.6 + Math.min(t, 1 - t) * 8);
    case 'INK':
      return 0.7 + 0.3 * noise(s / 35, seed);
    case 'BRUSH':
      // A loaded brush: soft start, the paint running out toward the end, slow wobble.
      return Math.min(1, t * 6 + 0.15) * (1 - 0.45 * t) * (0.75 + 0.25 * noise(s / 20, seed));
    case 'CHALK':
      return 0.8 + 0.2 * noise(s / 1.5, seed);
  }
}

export interface VariableStrokeOptions {
  weight: number;
  profile: StrokeProfile;
  /** Width points of the CUSTOM profile. */
  points?: readonly WidthPoint[];
  brush: BrushKind;
  /** The brush of a CUSTOM stroke. */
  custom?: CustomBrush | null;
  /** Round ends on open paths (flat otherwise; a marker is always flat). */
  roundCaps: boolean;
  seed?: number;
}

/** True when the stroke needs the shape (not a plain canvas line). */
export function isVariableStroke(profile: StrokeProfile, brush: BrushKind): boolean {
  return profile !== 'UNIFORM' || brush !== 'NONE';
}

interface P {
  x: number;
  y: number;
}

/**
 * The outline of a variable-width stroke of `paths`: closed straight-edged
 * contours to fill (nonzero). Closed paths give a ring (outer and inner edge).
 */
export function variableStrokeOutline(paths: readonly VectorPath[], o: VariableStrokeOptions): VectorPath[] {
  if (o.brush === 'CUSTOM' && o.custom && o.custom.contours.length > 0) return customBrushOutline(paths, o.custom, o.weight);
  const out: VectorPath[] = [];
  const seed = o.seed ?? 7;
  const step = Math.max(0.5, Math.min(4, o.weight / 3));
  for (const line of flattenPaths(paths, 0.2)) {
    const pts = resample(line.points, step, line.closed);
    if (pts.length < 2) continue;
    // Lengths along the line.
    const len: number[] = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
    const total = len[len.length - 1]! + (line.closed ? Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) : 0);
    if (total <= 0) continue;
    const half = pts.map((_, i) => {
      const t = len[i]! / total;
      const profile = o.profile === 'CUSTOM' ? widthAt(o.points ?? [], t) : profileWidth(o.profile, line.closed ? 0.5 : t);
      return (o.weight / 2) * profile * brushWidth(o.brush, len[i]!, line.closed ? 0.5 : t, seed);
    });
    const n = pts.length;
    const left: P[] = [];
    const right: P[] = [];
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? pts[i - 1]! : line.closed ? pts[n - 1]! : null;
      const next = i < n - 1 ? pts[i + 1]! : line.closed ? pts[0]! : null;
      const n1 = prev ? normal(prev, pts[i]!) : null;
      const n2 = next ? normal(pts[i]!, next) : null;
      let nx = (n1?.x ?? 0) + (n2?.x ?? 0);
      let ny = (n1?.y ?? 0) + (n2?.y ?? 0);
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      // A corner keeps the stroke's width: the offset grows as the corner sharpens (up to a limit).
      const ref = n1 ?? n2!;
      const k = Math.min(3, 1 / Math.max(0.33, nx * ref.x + ny * ref.y));
      const h = half[i]! * k;
      left.push({ x: pts[i]!.x + nx * h, y: pts[i]!.y + ny * h });
      right.push({ x: pts[i]!.x - nx * h, y: pts[i]!.y - ny * h });
    }
    if (line.closed) {
      out.push(polygon(left), polygon([...right].reverse()));
      continue;
    }
    const ring: P[] = [...left];
    if (o.roundCaps && o.brush !== 'MARKER') ring.push(...cap(pts[n - 1]!, left[n - 1]!, half[n - 1]!, pts[n - 2]!));
    ring.push(...[...right].reverse());
    if (o.roundCaps && o.brush !== 'MARKER') ring.push(...cap(pts[0]!, right[0]!, half[0]!, pts[1]!));
    out.push(polygon(ring));
  }
  return out;
}

function normal(a: P, b: P): P {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: -dy / l, y: dx / l };
}

/** A half circle round an end, from one edge to the other, bulging away from `inner`. */
function cap(end: P, from: P, r: number, inner: P): P[] {
  if (r < 0.05) return [];
  const a0 = Math.atan2(from.y - end.y, from.x - end.x);
  const away = Math.atan2(end.y - inner.y, end.x - inner.x);
  // Turn toward the outside of the line.
  const dir = Math.sin(away - a0) > 0 ? 1 : -1;
  const out: P[] = [];
  for (let k = 1; k < 8; k++) {
    const a = a0 + (dir * Math.PI * k) / 8;
    out.push({ x: end.x + Math.cos(a) * r, y: end.y + Math.sin(a) * r });
  }
  return out;
}

function resample(points: readonly P[], step: number, closed: boolean): P[] {
  const src = closed && points.length > 1 && points[0]!.x === points[points.length - 1]!.x && points[0]!.y === points[points.length - 1]!.y ? points.slice(0, -1) : points;
  const out: P[] = [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i]!;
    const b = i < src.length - 1 ? src[i + 1]! : closed ? src[0]! : null;
    out.push({ x: a.x, y: a.y });
    if (!b) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.floor(d / step);
    for (let j = 1; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  // Points on top of each other give no direction.
  return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1]!.x, p.y - out[i - 1]!.y) > 1e-6);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function polygon(ring: P[]): VectorPath {
  return { closed: true, points: ring.map((p) => ({ x: r2(p.x), y: r2(p.y) })) };
}

// ---------- custom brushes ----------

/** A line with lengths along it: the place and the left normal at any distance. */
function station(points: readonly P[], closed: boolean) {
  const pts = closed ? [...points, points[0]!] : [...points];
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = len[len.length - 1]!;
  return {
    total,
    at(s: number): { p: P; n: P } {
      const d = Math.max(0, Math.min(total, s));
      let i = 1;
      while (i < pts.length - 1 && len[i]! < d) i++;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const seg = len[i]! - len[i - 1]! || 1;
      const f = Math.max(0, Math.min(1, (d - len[i - 1]!) / seg));
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, n: normal(a, b) };
    },
  };
}

/** Brush contours with points no further apart than `step` (of the unit box), so a bend follows the line. */
function dense(contours: readonly P[][], step: number): P[][] {
  return contours.map((c) => {
    const out: P[] = [];
    c.forEach((a, i) => {
      const b = c[(i + 1) % c.length]!;
      const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
    });
    return out;
  });
}

/**
 * The stroke drawn with a custom brush: a stretch brush bent along the whole of each
 * line (its height is the stroke weight), a scatter brush repeated along it, each copy
 * turned with the line.
 */
export function customBrushOutline(paths: readonly VectorPath[], brush: CustomBrush, weight: number): VectorPath[] {
  const out: VectorPath[] = [];
  for (const line of flattenPaths(paths, 0.2)) {
    if (line.points.length < 2) continue;
    const st = station(line.points, line.closed);
    if (st.total <= 0) continue;
    if (brush.kind === 'STRETCH') {
      for (const c of dense(brush.contours, Math.max(0.002, Math.min(0.05, 2 / st.total)))) {
        out.push(polygon(c.map((q) => {
          const { p, n } = st.at(q.x * st.total);
          return { x: p.x - n.x * q.y * weight, y: p.y - n.y * q.y * weight };
        })));
      }
      continue;
    }
    // Scatter: copies as tall as the stroke weight, side by side along the line.
    const w = Math.max(0.5, weight * brush.aspect);
    const count = Math.max(1, Math.floor(st.total / w));
    const gap = st.total / count;
    for (let k = 0; k < count; k++) {
      const mid = st.at(gap * (k + 0.5));
      const tx = { x: -mid.n.y, y: mid.n.x };
      for (const c of brush.contours) {
        out.push(polygon(c.map((q) => {
          const along = (q.x - 0.5) * w;
          const across = -q.y * weight;
          return { x: mid.p.x + tx.x * along + mid.n.x * across, y: mid.p.y + tx.y * along + mid.n.y * across };
        })));
      }
    }
  }
  return out;
}

/** A brush from a layer's closed outlines (its own coordinates). Null — nothing closed to make it of. */
export function brushFromPaths(paths: readonly VectorPath[], kind: 'STRETCH' | 'SCATTER', name: string, id: string): CustomBrush | null {
  const lines = flattenPaths(paths, 0.25).filter((l) => l.closed && l.points.length >= 3);
  if (lines.length === 0) return null;
  const xs = lines.flatMap((l) => l.points.map((p) => p.x));
  const ys = lines.flatMap((l) => l.points.map((p) => p.y));
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  if (w <= 0 || h <= 0) return null;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return { id, name, kind, aspect: w / h, contours: lines.map((l) => l.points.map((p) => ({ x: r4((p.x - x0) / w), y: r4((p.y - y0) / h - 0.5) }))) };
}
