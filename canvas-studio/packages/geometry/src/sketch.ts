// «От руки» (FEAT-223, as in Excalidraw, Balsamiq): an outline as if drawn by hand. Pure and deterministic — the
// same layer looks the same on every redraw, in every export (the seed comes from the layer).
//   fill    the outline with a slow wobble, closed — what is filled;
//   stroke  each edge between sharp corners drawn on its own, a little past both corners, twice with different
//           wobbles — the double line of a pencil sketch.
// The wobble is a sum of three slow waves along the outline (wavelengths in layer units), so a long side bends
// gently and a short one barely: no jitter, no noise.

import type { VectorPath } from '#core';
import { flattenPaths } from './vector.ts';
import type { Point } from './rect.ts';

export interface Sketch {
  fill: VectorPath[];
  stroke: VectorPath[];
}

/** A number for a string (FNV-1a): the seed of a layer by its id. */
export function sketchSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for wobble phases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WAVES = [
  [190, 0.6],
  [73, 0.3],
  [29, 0.1],
] as const;

/** A wobble along the outline: s — distance along it; returns −1…1-ish. */
function wobble(seed: number): (s: number) => number {
  const r = rng(seed);
  const phases = WAVES.map(() => r() * Math.PI * 2);
  return (s) => WAVES.reduce((sum, [len, weight], i) => sum + weight * Math.sin((2 * Math.PI * s) / len + phases[i]!), 0);
}

/** Points every `step` units along a polyline (its own corners kept), with the distance of each. */
function resample(points: readonly Point[], closed: boolean, step: number): { p: Point; s: number }[] {
  const pts = closed ? [...points, points[0]!] : [...points];
  const out: { p: Point; s: number }[] = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ p: { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }, s: s + (len * k) / n });
    s += len;
  }
  if (!closed && pts.length) out.push({ p: { ...pts[pts.length - 1]! }, s });
  return out;
}

/** Moves each point along the outline's normal by the wobble. */
function displace(samples: readonly { p: Point; s: number }[], closed: boolean, amount: number, f: (s: number) => number): Point[] {
  const n = samples.length;
  return samples.map(({ p, s }, i) => {
    const prev = samples[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!.p;
    const next = samples[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!.p;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = amount * f(s);
    return { x: p.x - (dy / len) * d, y: p.y + (dx / len) * d };
  });
}

/** Indices of sharp corners of a polyline (turn sharper than ~40°). */
function corners(points: readonly Point[], closed: boolean): number[] {
  const out: number[] = [];
  const n = points.length;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = points[(i - 1 + n) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    if ((ux * vx + uy * vy) / (lu * lv) < 0.77) out.push(i);
  }
  return out;
}

const line = (points: Point[], closed: boolean): VectorPath => ({ closed, points: points.map((p) => ({ x: p.x, y: p.y })) });

/**
 * The hand-drawn look of outlines. `size` — the layer's smaller side: small things wobble less.
 * `roughness` 0…2 (1 — as Excalidraw's «artist»).
 */
export function sketchPaths(paths: readonly VectorPath[], seed: number, size: number, roughness = 1): Sketch {
  const amount = roughness * Math.min(3.2, Math.max(0.8, size * 0.02));
  const step = 4;
  const fill: VectorPath[] = [];
  const stroke: VectorPath[] = [];
  flattenPaths(paths, 0.3).forEach((poly, pi) => {
    if (poly.points.length < 2) return;
    const base = seed + pi * 7919;
    // The fill: the whole outline, one wobble.
    fill.push(line(displace(resample(poly.points, poly.closed, step), poly.closed, amount, wobble(base)), poly.closed));
    // The stroke: edges between corners (a smooth closed outline — one edge round, overlapping its start).
    const cs = corners(poly.points, poly.closed);
    const n = poly.points.length;
    const edges: Point[][] = [];
    if (poly.closed && cs.length === 0) {
      const overlap = Math.max(3, Math.round(n * 0.06));
      edges.push([...poly.points, ...poly.points.slice(0, overlap)]);
    } else if (poly.closed) {
      for (let k = 0; k < cs.length; k++) {
        const from = cs[k]!;
        const to = cs[(k + 1) % cs.length]!;
        const e: Point[] = [];
        for (let i = from; ; i = (i + 1) % n) {
          e.push(poly.points[i]!);
          if (i === to) break;
        }
        edges.push(e);
      }
    } else {
      const cuts = [0, ...cs, n - 1];
      for (let k = 0; k < cuts.length - 1; k++) edges.push(poly.points.slice(cuts[k], cuts[k + 1]! + 1));
    }
    for (let pass = 0; pass < 2; pass++) {
      const r = rng(base + 31 * (pass + 1));
      edges.forEach((e, ei) => {
        if (e.length < 2) return;
        // A little past both ends, as a hand does not stop exactly at the corner.
        const a = e[0]!;
        const a2 = e[1]!;
        const b = e[e.length - 1]!;
        const b2 = e[e.length - 2]!;
        const la = Math.hypot(a.x - a2.x, a.y - a2.y) || 1;
        const lb = Math.hypot(b.x - b2.x, b.y - b2.y) || 1;
        const over = amount * (1 + r() * 1.5);
        const start = { x: a.x + ((a.x - a2.x) / la) * over * r(), y: a.y + ((a.y - a2.y) / la) * over * r() };
        const end = { x: b.x + ((b.x - b2.x) / lb) * over, y: b.y + ((b.y - b2.y) / lb) * over };
        const pts = [start, ...e.slice(1, -1), end];
        stroke.push(line(displace(resample(pts, false, step), false, amount * (pass ? 1.3 : 0.8), wobble(base + 101 * (pass + 1) + ei * 13)), false));
      });
    }
  });
  return { fill, stroke };
}
