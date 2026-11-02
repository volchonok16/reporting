// Vector networks (stage "Vectors"): points joined by segments in any way,
// and regions — closed loops of segments that are filled. Pure functions:
// from contours to a network and back, the faces of the drawing (what the
// paint bucket fills), splitting and cutting segments, deleting points,
// simplifying.

import type { HandleMirror, NetworkRegion, NetworkSegment, Paint, VectorNetwork, VectorPath, VectorPoint, WindingRule } from '#core';
import type { Point } from './rect.ts';
import { booleanRegions, winding } from './boolean.ts';
import { cubicAt, flattenPaths, splitSegment, type Segment } from './vector.ts';

const EPS = 1e-6;
const same = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;

/** A segment of the network as a cubic from `a` to `b`. */
export function cubicOf(net: VectorNetwork, s: NetworkSegment): Segment {
  const a = net.vertices[s.a]!;
  const b = net.vertices[s.b]!;
  return { p0: { x: a.x, y: a.y }, c1: s.ca ?? { x: a.x, y: a.y }, c2: s.cb ?? { x: b.x, y: b.y }, p3: { x: b.x, y: b.y }, line: !s.ca && !s.cb };
}

// ---------- contours ⇄ network ----------

/** Contours as a network: each contour's points in order; closed contours become filled regions. */
export function networkFromPaths(paths: readonly VectorPath[], rule: WindingRule = 'NONZERO'): VectorNetwork {
  const net: VectorNetwork = { vertices: [], segments: [], regions: [] };
  for (const path of paths) {
    const pts = path.points;
    if (pts.length === 0) continue;
    const base = net.vertices.length;
    for (const p of pts) net.vertices.push({ x: p.x, y: p.y });
    const count = path.closed ? pts.length : pts.length - 1;
    const loop: number[] = [];
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % pts.length;
      const p = pts[i]!;
      const q = pts[j]!;
      const s: NetworkSegment = { a: base + i, b: base + j };
      if (p.out) s.ca = { x: p.out.x, y: p.out.y };
      if (q.in) s.cb = { x: q.in.x, y: q.in.y };
      loop.push(net.segments.length);
      net.segments.push(s);
    }
    if (path.closed && pts.length >= 2) net.regions.push({ loops: [loop], windingRule: rule });
  }
  return net;
}

/**
 * Segments of a loop (in any order) as one closed contour, walking from end
 * to end through shared points.
 */
export function loopPath(net: VectorNetwork, loop: readonly number[]): VectorPath | null {
  const left = [...loop];
  const first = net.segments[left.shift()!];
  if (!first) return null;
  const points: VectorPoint[] = [];
  const push = (v: number, outC: Point | undefined) => {
    const p = net.vertices[v]!;
    const pt: VectorPoint = { x: p.x, y: p.y };
    if (outC) pt.out = { x: outC.x, y: outC.y };
    points.push(pt);
  };
  // The way round is the order given: the first segment runs towards the end the second one touches.
  const second = net.segments[left[0] ?? -1];
  const touches = (s: NetworkSegment, v: number) => s.a === v || s.b === v || same(net.vertices[s.a]!, net.vertices[v]!) || same(net.vertices[s.b]!, net.vertices[v]!);
  const reverse = !!second && touches(second, first.a) && !touches(second, first.b);
  const start = reverse ? first.b : first.a;
  push(start, reverse ? first.cb : first.ca);
  let at = reverse ? first.a : first.b;
  let inC = reverse ? first.ca : first.cb;
  // Points are matched by index, or by place (a network may have two points at one spot).
  const meets = (v: number, w: number) => v === w || same(net.vertices[v]!, net.vertices[w]!);
  while (left.length) {
    let k = left.findIndex((si) => net.segments[si] && (net.segments[si]!.a === at || net.segments[si]!.b === at));
    if (k < 0) k = left.findIndex((si) => net.segments[si] && (meets(net.segments[si]!.a, at) || meets(net.segments[si]!.b, at)));
    if (k < 0) return null;
    const s = net.segments[left.splice(k, 1)[0]!]!;
    const forward = s.a === at || (s.b !== at && meets(s.a, at));
    const p = net.vertices[at]!;
    const pt: VectorPoint = { x: p.x, y: p.y };
    if (inC) pt.in = { x: inC.x, y: inC.y };
    const outC = forward ? s.ca : s.cb;
    if (outC) pt.out = { x: outC.x, y: outC.y };
    points.push(pt);
    at = forward ? s.b : s.a;
    inC = forward ? s.cb : s.ca;
  }
  if (!meets(at, start)) {
    // An open chain: closed by a straight line back to its start, as Figma fills it.
    const p = net.vertices[at]!;
    const pt: VectorPoint = { x: p.x, y: p.y };
    if (inC) pt.in = { x: inC.x, y: inC.y };
    points.push(pt);
    return points.length >= 3 ? { closed: true, points } : null;
  }
  if (inC) points[0]!.in = { x: inC.x, y: inC.y };
  return { closed: true, points };
}

/** Regions with paints of their own, drawn after the layer's fill. */
export interface NetworkPart {
  fill: VectorPath[];
  evenOdd: boolean;
  fills: Paint[];
}

/**
 * What to draw: the regions filled with the layer's paints as closed contours
 * (fill), the regions with paints of their own (parts), all the regions'
 * outlines (outline), and every segment once as chains through points of two
 * segments (stroke).
 */
export function networkPaths(net: VectorNetwork): { fill: VectorPath[]; stroke: VectorPath[]; evenOdd: boolean; parts: NetworkPart[]; outline: VectorPath[] } {
  const own = net.regions.filter((r) => r.fills);
  const base = own.length ? net.regions.filter((r) => !r.fills) : net.regions;
  const { fill, evenOdd } = regionsFill(net, base);
  const parts: NetworkPart[] = [];
  for (const r of own) {
    if (r.fills!.length === 0) continue;
    const one = regionsFill(net, [r]);
    if (one.fill.length) parts.push({ ...one, fills: r.fills! });
  }
  const outline = own.length ? regionsFill(net, net.regions).fill : fill;
  return { fill, stroke: strokeChains(net), evenOdd, parts, outline };
}

function regionsFill(net: VectorNetwork, regions: readonly NetworkRegion[]): { fill: VectorPath[]; evenOdd: boolean } {
  const fill: VectorPath[] = [];
  // One region: drawn with its own rule, as it is. Several: each turned into non-zero filling
  // (outlines one way round, holes the other), so they add up as Figma fills them — one by one.
  if (regions.length === 1) {
    const r = regions[0]!;
    for (const loop of r.loops) {
      const p = loopPath(net, loop);
      if (p) fill.push(p);
    }
    return { fill, evenOdd: r.windingRule === 'EVENODD' };
  }
  for (const r of regions) fill.push(...nonZeroRegion(net, r));
  return { fill, evenOdd: false };
}

function nonZeroRegion(net: VectorNetwork, r: NetworkRegion): VectorPath[] {
  const paths = r.loops.map((loop) => loopPath(net, loop)).filter((p): p is VectorPath => p !== null);
  if (paths.length === 0) return [];
  const polys = paths.map((p) => flattenPaths([p], 0.1)[0]?.points ?? []);
  if (r.windingRule === 'NONZERO' || paths.length === 1) {
    // Turned so the biggest loop goes the positive way (its holes, drawn the other way, stay holes).
    let big = 0;
    polys.forEach((q, i) => { if (Math.abs(polyArea(q)) > Math.abs(polyArea(polys[big]!))) big = i; });
    const turn = polyArea(polys[big]!) < 0;
    return turn ? paths.map(reversePath) : paths;
  }
  // Loops that touch (share a point) or cross are resolved exactly below; nested ones are simple.
  const key = (v: number) => `${Math.round(net.vertices[v]!.x * 1e4)},${Math.round(net.vertices[v]!.y * 1e4)}`;
  const owner = new Map<string, number>();
  let touch = false;
  r.loops.forEach((loop, i) => {
    for (const si of loop) {
      const sg = net.segments[si];
      if (!sg) continue;
      for (const v of [sg.a, sg.b]) {
        const o = owner.get(key(v));
        if (o !== undefined && o !== i) touch = true;
        owner.set(key(v), i);
      }
    }
  });
  if (!touch && !loopsCross(polys)) {
    // Even-odd without crossings: a loop inside an even number of others is filled, odd — a hole.
    // (Nesting is tested with a point on the loop itself: a point inside it may fall in its hole.)
    return paths.map((p, i) => {
      const q = polys[i]![0];
      const depth = q ? polys.filter((other, j) => j !== i && pointInPolygon(other, q)).length : 0;
      return (depth % 2 === 0) === polyArea(polys[i]!) > 0 ? p : reversePath(p);
    });
  }
  // Crossing loops: resolved into plain outlines and holes (as fine polygons).
  const resolved = booleanRegions('UNION', { contours: polys.filter((q) => q.length >= 3), rule: 'EVENODD' }, { contours: [], rule: 'NONZERO' });
  return resolved.contours.map((c) => ({ closed: true, points: c.map((q) => ({ x: q.x, y: q.y })) }));
}

function polyArea(q: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p0 = q[i]!;
    const p1 = q[(i + 1) % q.length]!;
    a += p0.x * p1.y - p1.x * p0.y;
  }
  return a / 2;
}

/** Whether any two of the polygons cross each other, or one crosses itself. */
function loopsCross(polys: readonly Point[][]): boolean {
  const cross = (a: Point, b: Point, c: Point, d: Point) => {
    const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
  };
  for (let i = 0; i < polys.length; i++)
    for (let j = i; j < polys.length; j++) {
      const A = polys[i]!, B = polys[j]!;
      for (let k = 0; k < A.length; k++)
        for (let m = i === j ? k + 2 : 0; m < B.length; m++)
          if (cross(A[k]!, A[(k + 1) % A.length]!, B[m]!, B[(m + 1) % B.length]!)) return true;
    }
  return false;
}

/** Every segment once: chains between points that are ends or junctions, and rings. */
export function strokeChains(net: VectorNetwork): VectorPath[] {
  const adj = adjacency(net);
  const used = new Set<number>();
  const out: VectorPath[] = [];
  const walk = (startV: number, firstSeg: number): VectorPath => {
    const points: VectorPoint[] = [];
    let v = startV;
    let si = firstSeg;
    const p0 = net.vertices[v]!;
    points.push({ x: p0.x, y: p0.y });
    for (;;) {
      used.add(si);
      const s = net.segments[si]!;
      const forward = s.a === v;
      const outC = forward ? s.ca : s.cb;
      const inC = forward ? s.cb : s.ca;
      if (outC) points[points.length - 1]!.out = { x: outC.x, y: outC.y };
      v = forward ? s.b : s.a;
      const p = net.vertices[v]!;
      const pt: VectorPoint = { x: p.x, y: p.y };
      if (inC) pt.in = { x: inC.x, y: inC.y };
      points.push(pt);
      const next = (adj[v] ?? []).filter((x) => !used.has(x));
      if ((adj[v]?.length ?? 0) !== 2 || next.length !== 1) break;
      si = next[0]!;
    }
    // Back at the start: a ring.
    const last = points[points.length - 1]!;
    if (v === startV && points.length > 2) {
      points.pop();
      if (last.in) points[0]!.in = last.in;
      return { closed: true, points };
    }
    return { closed: false, points };
  };
  // Chains start at ends and junctions…
  for (let v = 0; v < net.vertices.length; v++) {
    if ((adj[v]?.length ?? 0) === 2) continue;
    for (const si of adj[v] ?? []) if (!used.has(si)) out.push(walk(v, si));
  }
  // …what is left are rings of points with two segments each.
  for (let si = 0; si < net.segments.length; si++) if (!used.has(si)) out.push(walk(net.segments[si]!.a, si));
  return out;
}

/** Rings: closed loops of segments through points with two segments each (segment indices); null when there is anything else. */
export function ringLoops(net: VectorNetwork): number[][] | null {
  const adj = adjacency(net);
  if (adj.some((l) => l.length !== 0 && l.length !== 2)) return null;
  const used = new Set<number>();
  const loops: number[][] = [];
  for (let si = 0; si < net.segments.length; si++) {
    if (used.has(si)) continue;
    const loop: number[] = [];
    let v = net.segments[si]!.a;
    let cur = si;
    while (!used.has(cur)) {
      used.add(cur);
      loop.push(cur);
      const s = net.segments[cur]!;
      v = s.a === v ? s.b : s.a;
      const next = adj[v]!.find((x) => !used.has(x));
      if (next === undefined) break;
      cur = next;
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * Rounded corners of a network (Figma's corner radius on vectors): a point where exactly
 * two segments meet at an angle becomes an arc of its own radius, or the layer's `radius`.
 * The arc is a new segment between the two segments' shortened ends; an arc never goes
 * past the middle of a segment. Curves are cut where the arc meets them (Figma rounds
 * joins of curves too); smooth joins, ends and junctions stay. The same
 * network comes back when nothing is rounded.
 */
export function roundNetwork(net: VectorNetwork, radius: number): VectorNetwork {
  const radiusOf = (v: number) => net.vertices[v]!.cornerRadius ?? radius;
  if (!net.vertices.some((_, v) => radiusOf(v) > 0)) return net;
  const adj = adjacency(net);
  const vertices = net.vertices.map((v) => ({ x: v.x, y: v.y }));
  const segments = net.segments.map((s) => ({ ...s }));
  // Arc segments to add into the loops that pass through both of a corner's segments.
  const arcs: { s1: number; s2: number; arc: number }[] = [];
  // A segment as a cubic leaving `v` (reversed when `v` is its far end).
  const outOf = (s: NetworkSegment, v: number): Segment => {
    const c = cubicOf(net, s);
    return s.a === v ? c : { p0: c.p3, c1: c.c2, c2: c.c1, p3: c.p0, line: c.line };
  };
  const unit = (x: number, y: number) => {
    const l = Math.hypot(x, y);
    return l < EPS ? null : { x: x / l, y: y / l };
  };
  // Direction a cubic leaves its start.
  const leaving = (c: Segment) => unit(c.c1.x - c.p0.x, c.c1.y - c.p0.y) ?? unit(c.c2.x - c.p0.x, c.c2.y - c.p0.y) ?? unit(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
  // Direction a cubic runs at `t` (forward).
  const along = (c: Segment, t: number) => {
    const u = 1 - t;
    const dx = 3 * u * u * (c.c1.x - c.p0.x) + 6 * u * t * (c.c2.x - c.c1.x) + 3 * t * t * (c.p3.x - c.c2.x);
    const dy = 3 * u * u * (c.c1.y - c.p0.y) + 6 * u * t * (c.c2.y - c.c1.y) + 3 * t * t * (c.p3.y - c.c2.y);
    return unit(dx, dy) ?? leaving(c);
  };
  // Where along a cubic the straight distance from its start reaches `d`.
  const reach = (c: Segment, d: number) => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      const q = cubicAt(c, m);
      if (Math.hypot(q.x - c.p0.x, q.y - c.p0.y) < d) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  net.vertices.forEach((p, v) => {
    const r = radiusOf(v);
    const around = adj[v]!;
    if (r <= 0 || around.length !== 2) return;
    const [i1, i2] = around as [number, number];
    const s1 = net.segments[i1]!;
    const s2 = net.segments[i2]!;
    if (s1.a === s1.b || s2.a === s2.b) return;
    const c1 = outOf(s1, v);
    const c2 = outOf(s2, v);
    const l1 = Math.hypot(c1.p3.x - p.x, c1.p3.y - p.y);
    const l2 = Math.hypot(c2.p3.x - p.x, c2.p3.y - p.y);
    const u = leaving(c1);
    const w = leaving(c2);
    if (l1 < EPS || l2 < EPS || !u || !w) return;
    // A corner where the two directions meet at an angle; a smooth join (opposite directions) stays.
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * w.x + u.y * w.y)));
    if (angle > Math.PI - 1e-3 || angle < 1e-6) return;
    const t = Math.min(r / Math.tan(angle / 2), l1 / 2, l2 / 2);
    const t1 = c1.line ? t / l1 : reach(c1, t);
    const t2 = c2.line ? t / l2 : reach(c2, t);
    const start = cubicAt(c1, t1);
    const end = cubicAt(c2, t2);
    // The arc leaves each cut toward the corner, along the curve there; its handles as for a circle.
    const d1 = along(c1, t1)!;
    const d2 = along(c2, t2)!;
    const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
    const chord = Math.hypot(end.x - start.x, end.y - start.y);
    const radiusHere = turn > 1e-6 ? chord / (2 * Math.sin(turn / 2)) : 0;
    const k = (4 / 3) * Math.tan(turn / 4) * radiusHere;
    // Each segment keeps its far part, from the cut on.
    const rest = (s: NetworkSegment, c: Segment, tc: number, from: number): NetworkSegment => {
      const far = splitSegment(c, tc)[1];
      const curve = !c.line;
      const forward = s.a === v;
      return forward
        ? { a: from, b: s.b, ...(curve ? { ca: far.c1, cb: far.c2 } : {}) }
        : { a: s.a, b: from, ...(curve ? { ca: far.c2, cb: far.c1 } : {}) };
    };
    // The corner's own point moves to where the arc starts; a new point where it ends.
    vertices[v] = { x: start.x, y: start.y };
    const e = vertices.push({ x: end.x, y: end.y }) - 1;
    segments[i1] = rest(segments[i1]!, c1, t1, v);
    segments[i2] = rest(segments[i2]!, c2, t2, e);
    const arc = segments.push({ a: v, b: e, ca: { x: start.x - d1.x * k, y: start.y - d1.y * k }, cb: { x: end.x - d2.x * k, y: end.y - d2.y * k } }) - 1;
    arcs.push({ s1: i1, s2: i2, arc });
  });
  if (arcs.length === 0) return net;
  const regions = net.regions.map((region) => ({
    ...region,
    loops: region.loops.map((loop) => {
      const out = [...loop];
      for (const { s1, s2, arc } of arcs) {
        if (!loop.includes(s1) || !loop.includes(s2)) continue;
        // Right after whichever of the two comes first: the loop is walked by what touches what.
        const at = Math.min(out.indexOf(s1), out.indexOf(s2));
        out.splice(at + 1, 0, arc);
      }
      return out;
    }),
  }));
  return { vertices, segments, regions };
}

/** Segment indices at each vertex. */
export function adjacency(net: VectorNetwork): number[][] {
  const adj: number[][] = net.vertices.map(() => []);
  net.segments.forEach((s, i) => {
    adj[s.a]?.push(i);
    if (s.b !== s.a) adj[s.b]?.push(i);
  });
  return adj;
}

function signedArea(path: VectorPath): number {
  const line = flattenPaths([path], 0.5)[0];
  if (!line) return 0;
  let a = 0;
  const pts = line.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function reversePath(path: VectorPath): VectorPath {
  const points = [...path.points].reverse().map((p) => {
    const q: VectorPoint = { x: p.x, y: p.y };
    if (p.out) q.in = p.out;
    if (p.in) q.out = p.in;
    return q;
  });
  return { closed: path.closed, points };
}

/** Bounds of every vertex and control point (what normalizing a vector fits). */
export function networkBounds(net: VectorNetwork): { x: number; y: number; width: number; height: number } | null {
  const pts: Point[] = [...net.vertices];
  for (const s of net.segments) {
    // The curve itself, not its control polygon: flattened.
    if (s.ca || s.cb) for (let i = 1; i < 16; i++) pts.push(cubicAt(cubicOf(net, s), i / 16));
  }
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function mapNetwork(net: VectorNetwork, fn: (p: Point) => Point): VectorNetwork {
  return {
    // A point keeps what it has besides its place (its corner radius).
    vertices: net.vertices.map((v) => ({ ...v, ...fn(v) })),
    segments: net.segments.map((s) => ({ a: s.a, b: s.b, ...(s.ca ? { ca: fn(s.ca) } : {}), ...(s.cb ? { cb: fn(s.cb) } : {}) })),
    regions: net.regions.map((r) => ({ ...r, loops: r.loops.map((l) => [...l]) })),
  };
}

// ---------- faces (what the paint bucket fills) ----------

/** Direction a segment leaves vertex `v` (towards its control point, or the other end). */
function leaving(net: VectorNetwork, si: number, v: number): number {
  const s = net.segments[si]!;
  const p = net.vertices[v]!;
  const atA = s.a === v;
  const c = atA ? (s.ca ?? s.cb ?? net.vertices[s.b]!) : (s.cb ?? s.ca ?? net.vertices[s.a]!);
  let dx = c.x - p.x;
  let dy = c.y - p.y;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) {
    const q = atA ? net.vertices[s.b]! : net.vertices[s.a]!;
    dx = q.x - p.x;
    dy = q.y - p.y;
  }
  return Math.atan2(dy, dx);
}

export interface Face {
  /** Segment indices around the face. */
  loop: number[];
  /** The face as a polygon (curves flattened) and its signed area. */
  polygon: Point[];
  area: number;
  /** Which connected part of the drawing it belongs to. */
  component: number;
}

/**
 * The faces of the drawing: the areas segments enclose, found by walking
 * around each point always taking the next segment by angle. The outside of
 * each connected part is left out.
 */
export function findFaces(net: VectorNetwork): Face[] {
  const adj = adjacency(net);
  // Outgoing half-edges at each vertex sorted by angle.
  const around = adj.map((list, v) => list.filter((si) => net.segments[si]!.a !== net.segments[si]!.b).map((si) => ({ si, angle: leaving(net, si, v) })).sort((x, y) => x.angle - y.angle));
  const key = (si: number, from: number) => `${si}>${from}`;
  const seen = new Set<string>();
  // Connected parts, for telling each part's outside.
  const component = new Array<number>(net.vertices.length).fill(-1);
  let parts = 0;
  for (let v = 0; v < net.vertices.length; v++) {
    if (component[v] !== -1 || (adj[v]?.length ?? 0) === 0) continue;
    const stack = [v];
    component[v] = parts;
    while (stack.length) {
      const x = stack.pop()!;
      for (const si of adj[x] ?? []) {
        const s = net.segments[si]!;
        const y = s.a === x ? s.b : s.a;
        if (component[y] === -1) {
          component[y] = parts;
          stack.push(y);
        }
      }
    }
    parts++;
  }
  const faces: Face[] = [];
  for (let si = 0; si < net.segments.length; si++) {
    const s = net.segments[si]!;
    for (const from of [s.a, s.b]) {
      if (seen.has(key(si, from))) continue;
      const loop: number[] = [];
      const steps: { si: number; from: number }[] = [];
      let curSeg = si;
      let curFrom = from;
      let guard = 0;
      while (!seen.has(key(curSeg, curFrom)) && guard++ < 100000) {
        seen.add(key(curSeg, curFrom));
        loop.push(curSeg);
        steps.push({ si: curSeg, from: curFrom });
        const cs = net.segments[curSeg]!;
        const to = cs.a === curFrom ? cs.b : cs.a;
        const list = around[to] ?? [];
        // Arrived at `to` along curSeg: turn to the next segment by angle (the face on the same side).
        const back = list.findIndex((h) => h.si === curSeg);
        if (back < 0) break;
        const next = list[(back - 1 + list.length) % list.length]!;
        curSeg = next.si;
        curFrom = to;
      }
      // The polygon in the order walked: its orientation tells an inside face from the outside.
      const polygon: Point[] = [];
      for (const st of steps) {
        const cs = net.segments[st.si]!;
        const forward = cs.a === st.from;
        const c = cubicOf(net, forward ? cs : { a: cs.b, b: cs.a, ...(cs.cb ? { ca: cs.cb } : {}), ...(cs.ca ? { cb: cs.ca } : {}) });
        const n = c.line ? 1 : 16;
        for (let k = 0; k < n; k++) polygon.push(cubicAt(c, k / n));
      }
      let area = 0;
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i]!;
        const q = polygon[(i + 1) % polygon.length]!;
        area += p.x * q.y - q.x * p.y;
      }
      // A loose tail inside the face is walked there and back: it is not part of the outline.
      const once = loop.filter((x) => loop.indexOf(x) === loop.lastIndexOf(x));
      faces.push({ loop: once, polygon, area: area / 2, component: component[net.segments[si]!.a] ?? 0 });
    }
  }
  // The outside of each part is its largest loop; inner faces go the other way round.
  const out: Face[] = [];
  for (let c = 0; c < parts; c++) {
    const mine = faces.filter((f) => f.component === c && f.polygon.length >= 3 && Math.abs(f.area) > EPS);
    if (mine.length === 0) continue;
    const outer = mine.reduce((m, f) => (Math.abs(f.area) > Math.abs(m.area) ? f : m));
    const inner = Math.sign(outer.area) * -1;
    for (const f of mine) if (Math.sign(f.area) === inner) out.push(f);
  }
  return out;
}

/** Outer outline of each connected part (its outside face), for holes. */
function outlines(net: VectorNetwork): Face[] {
  const faces = findFaces(net);
  const byPart = new Map<number, Face>();
  for (const f of faces) {
    const cur = byPart.get(f.component);
    if (!cur || Math.abs(f.area) > Math.abs(cur.area)) byPart.set(f.component, f);
  }
  return [...byPart.values()];
}

export function pointInPolygon(poly: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The area under a point as a region: the smallest face around it, with the
 * parts of the drawing lying inside it (and not around the point) as holes.
 */
export function regionAt(net: VectorNetwork, p: Point): NetworkRegion | null {
  const faces = findFaces(net).filter((f) => pointInPolygon(f.polygon, p));
  if (faces.length === 0) return null;
  const face = faces.reduce((m, f) => (Math.abs(f.area) < Math.abs(m.area) ? f : m));
  const holes = outlines(net).filter((o) => o.component !== face.component && !pointInPolygon(o.polygon, p) && o.polygon.every((q) => pointInPolygon(face.polygon, q)));
  return { loops: [face.loop, ...holes.map((h) => h.loop)], windingRule: holes.length ? 'EVENODD' : 'NONZERO' };
}

const sameLoop = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((s) => y.includes(s));

/** Whether a point is painted by the network's regions (each with its own fill rule). */
export function filledAt(net: VectorNetwork, p: Point): boolean {
  for (const r of net.regions) {
    const polys = r.loops.map((l) => {
      const path = loopPath(net, l);
      return path ? (flattenPaths([path], 0.5)[0]?.points ?? []) : [];
    });
    if (r.windingRule === 'EVENODD' ? polys.filter((poly) => pointInPolygon(poly, p)).length % 2 === 1 : winding(polys, p) !== 0) return true;
  }
  return false;
}

/** A point surely inside a polygon: the middle between the first two crossings of a line across its middle. */
export function insidePoint(poly: readonly Point[]): Point | null {
  if (poly.length < 3) return null;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  for (const k of [0.5, 0.37, 0.63, 0.25, 0.75, 0.12, 0.88]) {
    const y = y0 + (y1 - y0) * k;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1]! - xs[i]! > 1e-6) return { x: (xs[i]! + xs[i + 1]!) / 2, y };
    }
  }
  return null;
}

/**
 * The regions of one connected part of the drawing again, as its faces: a
 * face stays filled when its inside was painted before (in `before`), so
 * splitting a filled area keeps both halves filled — as Figma does. `set`
 * forces one face filled or empty. Regions of other parts stay as they are.
 */
export function refillPart(before: VectorNetwork, net: VectorNetwork, vertex: number, set?: { loop: number[]; filled: boolean }): VectorNetwork {
  const faces = findFaces(net);
  const part = faces.find((f) => f.loop.some((si) => net.segments[si]!.a === vertex || net.segments[si]!.b === vertex))?.component;
  if (part === undefined) return net;
  const mine = faces.filter((f) => f.component === part);
  const mySegments = new Set(mine.flatMap((f) => f.loop));
  // Regions that touch this part are replaced; the others stay.
  const others = net.regions.filter((r) => !r.loops.some((l) => l.some((si) => mySegments.has(si))));
  const holes = outlines(net).filter((o) => o.component !== part);
  const regions: NetworkRegion[] = [...others];
  for (const f of mine) {
    let filled: boolean;
    if (set && sameLoop(set.loop, f.loop)) filled = set.filled;
    else {
      const q = insidePoint(f.polygon);
      filled = !!q && filledAt(before, q);
    }
    if (!filled) continue;
    const inside = holes.filter((o) => o.polygon.every((q) => pointInPolygon(f.polygon, q)));
    regions.push({ loops: [f.loop, ...inside.map((o) => o.loop)], windingRule: inside.length ? 'EVENODD' : 'NONZERO' });
  }
  return { ...net, regions };
}

/** Paint bucket: fills the area under the point, or empties it when it is painted. */
export function toggleRegionAt(net: VectorNetwork, p: Point): VectorNetwork | null {
  const region = regionAt(net, p);
  if (!region) return null;
  const first = net.segments[region.loops[0]![0]!]!;
  return refillPart(net, net, first.a, { loop: region.loops[0]!, filled: !filledAt(net, p) });
}

// ---------- editing ----------

/** Splits segment `si` at `t` with a new shared point; regions keep going through it. Returns the new point's index. */
export function splitNetworkSegment(net: VectorNetwork, si: number, t: number): { net: VectorNetwork; vertex: number } {
  const s = net.segments[si]!;
  const [l, r] = splitSegment(cubicOf(net, s), t);
  const vertices = [...net.vertices, { x: l.p3.x, y: l.p3.y }];
  const m = vertices.length - 1;
  const curve = !!(s.ca || s.cb);
  const left: NetworkSegment = { a: s.a, b: m, ...(curve ? { ca: l.c1, cb: l.c2 } : {}) };
  const right: NetworkSegment = { a: m, b: s.b, ...(curve ? { ca: r.c1, cb: r.c2 } : {}) };
  const segments = [...net.segments];
  segments[si] = left;
  segments.push(right);
  const ni = segments.length - 1;
  const regions = net.regions.map((reg) => ({ ...reg, loops: reg.loops.map((loop) => loop.flatMap((x) => (x === si ? [si, ni] : [x]))) }));
  return { net: { vertices, segments, regions }, vertex: m };
}

/** Scissors: cuts segment `si` at `t` — two loose ends; regions through it are no longer closed and go. */
export function cutNetworkSegment(net: VectorNetwork, si: number, t: number): VectorNetwork {
  const s = net.segments[si]!;
  const [l, r] = splitSegment(cubicOf(net, s), t);
  const vertices = [...net.vertices, { x: l.p3.x, y: l.p3.y }, { x: l.p3.x, y: l.p3.y }];
  const m1 = vertices.length - 2;
  const m2 = vertices.length - 1;
  const curve = !!(s.ca || s.cb);
  const segments = [...net.segments];
  segments[si] = { a: s.a, b: m1, ...(curve ? { ca: l.c1, cb: l.c2 } : {}) };
  segments.push({ a: m2, b: s.b, ...(curve ? { ca: r.c1, cb: r.c2 } : {}) });
  return { vertices, segments, regions: net.regions.filter((reg) => !reg.loops.some((loop) => loop.includes(si))) };
}

/** Scissors on a point: each of its segments gets its own copy of the point. */
export function detachVertex(net: VectorNetwork, v: number): VectorNetwork {
  const adj = adjacency(net)[v] ?? [];
  if (adj.length < 2) return net;
  const vertices = [...net.vertices];
  const segments = net.segments.map((s) => ({ ...s }));
  for (const si of adj.slice(1)) {
    vertices.push({ ...net.vertices[v]! });
    const copy = vertices.length - 1;
    const s = segments[si]!;
    if (s.a === v) s.a = copy;
    else s.b = copy;
  }
  return { vertices, segments, regions: net.regions.filter((reg) => !reg.loops.some((loop) => loop.some((si) => adj.includes(si)))) };
}

/**
 * Deletes points. A point between two segments joins its neighbours with one
 * segment (the shape stays closed); a loose end or a junction takes its
 * segments with it. Points left without segments go too.
 */
export function deleteVertices(net: VectorNetwork, doomed: ReadonlySet<number>): VectorNetwork {
  let segments: (NetworkSegment | null)[] = net.segments.map((s) => ({ ...s }));
  let regions = net.regions.map((r) => ({ ...r, loops: r.loops.map((l) => [...l]) }));
  const adjOf = (v: number) => segments.map((s, i) => (s && (s.a === v || s.b === v) ? i : -1)).filter((i) => i >= 0);
  for (const v of doomed) {
    const adj = adjOf(v);
    if (adj.length === 2) {
      const [i, j] = adj as [number, number];
      const s1 = segments[i]!;
      const s2 = segments[j]!;
      const u = s1.a === v ? s1.b : s1.a;
      const w = s2.a === v ? s2.b : s2.a;
      if (u !== v && w !== v) {
        // Keep the outer control points: the joined curve leaves u and arrives at w as before.
        const cu = s1.a === v ? s1.cb : s1.ca;
        const cw = s2.a === v ? s2.cb : s2.ca;
        segments[i] = { a: u, b: w, ...(cu ? { ca: cu } : {}), ...(cw ? { cb: cw } : {}) };
        segments[j] = null;
        regions = regions.map((r) => ({ ...r, loops: r.loops.map((l) => l.filter((x) => x !== j)) }));
        continue;
      }
    }
    for (const si of adj) segments[si] = null;
    regions = regions.filter((r) => !r.loops.some((l) => l.some((x) => adj.includes(x))));
  }
  // Renumber: drop removed segments and points without segments.
  const keepSeg = segments.map((s) => s !== null);
  const segIndex: number[] = [];
  let n = 0;
  keepSeg.forEach((k, i) => (segIndex[i] = k ? n++ : -1));
  const live = segments.filter((s): s is NetworkSegment => s !== null);
  const used = new Set<number>(live.flatMap((s) => [s.a, s.b]));
  const vIndex: number[] = [];
  const vertices = net.vertices.filter((_, i) => used.has(i) && !doomed.has(i));
  let m = 0;
  net.vertices.forEach((_, i) => (vIndex[i] = used.has(i) && !doomed.has(i) ? m++ : -1));
  return {
    vertices,
    segments: live.filter((s) => vIndex[s.a]! >= 0 && vIndex[s.b]! >= 0).map((s) => ({ ...s, a: vIndex[s.a]!, b: vIndex[s.b]! })),
    regions: regions
      .map((r) => ({ ...r, loops: r.loops.map((l) => l.map((x) => segIndex[x]!).filter((x) => x >= 0)).filter((l) => l.length > 0) }))
      .filter((r) => r.loops.length > 0),
  };
}

/** Nearest segment to a point: index, parameter and distance. */
export function nearestSegment(net: VectorNetwork, p: Point): { segment: number; t: number; distance: number } | null {
  let best: { segment: number; t: number; distance: number } | null = null;
  net.segments.forEach((s, i) => {
    const c = cubicOf(net, s);
    let bt = 0;
    let bd = Infinity;
    const steps = c.line ? 1 : 48;
    if (c.line) {
      const dx = c.p3.x - c.p0.x;
      const dy = c.p3.y - c.p0.y;
      const len2 = dx * dx + dy * dy;
      bt = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - c.p0.x) * dx + (p.y - c.p0.y) * dy) / len2));
      bd = Math.hypot(p.x - (c.p0.x + dx * bt), p.y - (c.p0.y + dy * bt));
    } else {
      for (let k = 0; k <= steps; k++) {
        const q = cubicAt(c, k / steps);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < bd) {
          bd = d;
          bt = k / steps;
        }
      }
      let step = 1 / steps;
      for (let k = 0; k < 12; k++) {
        step /= 2;
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const q = cubicAt(c, t);
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < bd) {
            bd = d;
            bt = t;
          }
        }
      }
    }
    if (!best || bd < best.distance) best = { segment: i, t: bt, distance: bd };
  });
  return best;
}

// ---------- simplify ----------

/**
 * Fewer points, same look (within `tolerance` px): every chain between ends,
 * junctions and sharp corners is fitted again with as few cubic curves as
 * the tolerance allows (Schneider's algorithm). Regions follow their chains.
 */
export function simplifyNetwork(net: VectorNetwork, tolerance = 1): VectorNetwork {
  const adj = adjacency(net);
  // A point is kept when it is an end, a junction or a corner sharper than 30°.
  const keep = new Set<number>();
  net.vertices.forEach((_, v) => {
    const list = adj[v] ?? [];
    if (list.length !== 2) return void keep.add(v);
    const d1 = leaving(net, list[0]!, v);
    const d2 = leaving(net, list[1]!, v);
    let diff = Math.abs(d1 - d2) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (Math.PI - diff > Math.PI / 6) keep.add(v);
  });
  // Rings without any kept point keep their first one.
  const usedSeg = new Set<number>();
  const vertices = [...net.vertices];
  const segments: NetworkSegment[] = [];
  const newOf = new Map<number, number[]>();
  const runs: { from: number; segs: number[] }[] = [];
  const walk = (from: number, first: number) => {
    const segs: number[] = [];
    let v = from;
    let si = first;
    for (;;) {
      usedSeg.add(si);
      segs.push(si);
      const s = net.segments[si]!;
      v = s.a === v ? s.b : s.a;
      if (keep.has(v)) break;
      const next = (adj[v] ?? []).find((x) => !usedSeg.has(x));
      if (next === undefined) break;
      si = next;
    }
    runs.push({ from, segs });
  };
  for (const v of keep) for (const si of adj[v] ?? []) if (!usedSeg.has(si)) walk(v, si);
  for (let si = 0; si < net.segments.length; si++) {
    if (usedSeg.has(si)) continue;
    keep.add(net.segments[si]!.a);
    walk(net.segments[si]!.a, si);
  }
  for (const run of runs) {
    // The run as a polyline from its start to its end.
    let v = run.from;
    const pts: Point[] = [{ ...net.vertices[v]! }];
    for (const si of run.segs) {
      const s = net.segments[si]!;
      const forward = s.a === v;
      const c = cubicOf(net, forward ? s : { a: s.b, b: s.a, ...(s.cb ? { ca: s.cb } : {}), ...(s.ca ? { cb: s.ca } : {}) });
      const n = c.line ? 1 : 24;
      for (let k = 1; k <= n; k++) pts.push(cubicAt(c, k / n));
      v = forward ? s.b : s.a;
    }
    const end = v;
    const fitted = run.segs.length === 1 && net.segments[run.segs[0]!]!.ca === undefined && net.segments[run.segs[0]!]!.cb === undefined ? null : fitCubics(pts, tolerance);
    const ids: number[] = [];
    if (!fitted) {
      const s = net.segments[run.segs[0]!]!;
      const forward = s.a === run.from;
      segments.push(forward ? { ...s } : { a: s.b, b: s.a, ...(s.cb ? { ca: s.cb } : {}), ...(s.ca ? { cb: s.ca } : {}) });
      ids.push(segments.length - 1);
    } else {
      let a = run.from;
      fitted.forEach((c, i) => {
        let b = end;
        if (i < fitted.length - 1) {
          vertices.push({ x: c.p3.x, y: c.p3.y });
          b = vertices.length - 1;
        }
        const straight = isStraight(c, tolerance);
        segments.push({ a, b, ...(straight ? {} : { ca: c.c1, cb: c.c2 }) });
        ids.push(segments.length - 1);
        a = b;
      });
    }
    for (const si of run.segs) newOf.set(si, ids);
  }
  // Points only between old segments of a run are gone: renumber the ones still used.
  const used = new Set(segments.flatMap((s) => [s.a, s.b]));
  const map: number[] = [];
  const outVertices: Point[] = [];
  vertices.forEach((p, i) => {
    if (used.has(i)) {
      map[i] = outVertices.length;
      outVertices.push({ x: round(p.x), y: round(p.y) });
    }
  });
  const r2 = (p: Point | undefined) => (p ? { x: round(p.x), y: round(p.y) } : undefined);
  return {
    vertices: outVertices,
    segments: segments.map((s) => ({ a: map[s.a]!, b: map[s.b]!, ...(s.ca ? { ca: r2(s.ca)! } : {}), ...(s.cb ? { cb: r2(s.cb)! } : {}) })),
    regions: net.regions.map((r) => ({ ...r, loops: r.loops.map((l) => [...new Set(l.flatMap((si) => newOf.get(si) ?? []))]) })),
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function isStraight(c: Segment, tolerance: number): boolean {
  const d = (p: Point) => {
    const dx = c.p3.x - c.p0.x;
    const dy = c.p3.y - c.p0.y;
    const len = Math.hypot(dx, dy) || 1;
    return Math.abs((p.x - c.p0.x) * dy - (p.y - c.p0.y) * dx) / len;
  };
  return d(c.c1) < tolerance / 4 && d(c.c2) < tolerance / 4;
}

/** Fits cubic curves through points within `error` (Philip J. Schneider, Graphics Gems, 1990). */
export function fitCubics(points: readonly Point[], error: number): Segment[] {
  const pts = points.filter((p, i) => i === 0 || !same(p, points[i - 1]!));
  if (pts.length < 2) return [];
  if (pts.length === 2) return [{ p0: pts[0]!, c1: pts[0]!, c2: pts[1]!, p3: pts[1]!, line: true }];
  const tan = (a: Point, b: Point) => norm({ x: b.x - a.x, y: b.y - a.y });
  const out: Segment[] = [];
  fit(pts, 0, pts.length - 1, tan(pts[0]!, pts[1]!), tan(pts[pts.length - 1]!, pts[pts.length - 2]!), error, out, 0);
  return out;
}

function norm(v: Point): Point {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function fit(pts: readonly Point[], first: number, last: number, t1: Point, t2: Point, error: number, out: Segment[], depth: number): void {
  const n = last - first + 1;
  if (n === 2) {
    const d = Math.hypot(pts[last]!.x - pts[first]!.x, pts[last]!.y - pts[first]!.y) / 3;
    out.push({ p0: pts[first]!, c1: { x: pts[first]!.x + t1.x * d, y: pts[first]!.y + t1.y * d }, c2: { x: pts[last]!.x + t2.x * d, y: pts[last]!.y + t2.y * d }, p3: pts[last]!, line: false });
    return;
  }
  let u = chordLength(pts, first, last);
  let bez = generate(pts, first, last, u, t1, t2);
  let { max, split } = maxError(pts, first, last, bez, u);
  if (max < error) return void out.push(bez);
  if (max < error * 4) {
    for (let i = 0; i < 20; i++) {
      u = reparameterize(pts, first, last, u, bez);
      bez = generate(pts, first, last, u, t1, t2);
      ({ max, split } = maxError(pts, first, last, bez, u));
      if (max < error) return void out.push(bez);
    }
  }
  if (depth > 40) return void out.push(bez);
  const center = norm({ x: pts[split - 1]!.x - pts[split + 1]!.x, y: pts[split - 1]!.y - pts[split + 1]!.y });
  fit(pts, first, split, t1, center, error, out, depth + 1);
  fit(pts, split, last, { x: -center.x, y: -center.y }, t2, error, out, depth + 1);
}

function chordLength(pts: readonly Point[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = u[u.length - 1]! || 1;
  return u.map((v) => v / total);
}

function generate(pts: readonly Point[], first: number, last: number, u: readonly number[], t1: Point, t2: Point): Segment {
  const p0 = pts[first]!;
  const p3 = pts[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i]!;
    const b1 = 3 * t * (1 - t) ** 2;
    const b2 = 3 * t * t * (1 - t);
    const a1 = { x: t1.x * b1, y: t1.y * b1 };
    const a2 = { x: t2.x * b2, y: t2.y * b2 };
    c00 += a1.x * a1.x + a1.y * a1.y;
    c01 += a1.x * a2.x + a1.y * a2.y;
    c11 += a2.x * a2.x + a2.y * a2.y;
    const b0 = (1 - t) ** 3 + b1;
    const b3 = b2 + t ** 3;
    const p = pts[first + i]!;
    const tmp = { x: p.x - (p0.x * b0 + p3.x * b3), y: p.y - (p0.y * b0 + p3.y * b3) };
    x0 += a1.x * tmp.x + a1.y * tmp.y;
    x1 += a2.x * tmp.x + a2.y * tmp.y;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (alpha1 < seg * 1e-6 || alpha2 < seg * 1e-6) alpha1 = alpha2 = seg / 3;
  return { p0, c1: { x: p0.x + t1.x * alpha1, y: p0.y + t1.y * alpha1 }, c2: { x: p3.x + t2.x * alpha2, y: p3.y + t2.y * alpha2 }, p3, line: false };
}

function maxError(pts: readonly Point[], first: number, last: number, bez: Segment, u: readonly number[]): { max: number; split: number } {
  let max = 0;
  let split = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const q = cubicAt(bez, u[i - first]!);
    const d = Math.hypot(q.x - pts[i]!.x, q.y - pts[i]!.y);
    if (d > max) {
      max = d;
      split = i;
    }
  }
  return { max, split };
}

function reparameterize(pts: readonly Point[], first: number, last: number, u: readonly number[], bez: Segment): number[] {
  return u.map((t, k) => {
    const p = pts[first + k]!;
    const q = cubicAt(bez, t);
    // Newton step on the distance.
    const d1 = derivative(bez, t);
    const d2 = second(bez, t);
    const num = (q.x - p.x) * d1.x + (q.y - p.y) * d1.y;
    const den = d1.x * d1.x + d1.y * d1.y + (q.x - p.x) * d2.x + (q.y - p.y) * d2.y;
    return den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
  });
}

function derivative(s: Segment, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (s.c1.x - s.p0.x) + 6 * u * t * (s.c2.x - s.c1.x) + 3 * t * t * (s.p3.x - s.c2.x),
    y: 3 * u * u * (s.c1.y - s.p0.y) + 6 * u * t * (s.c2.y - s.c1.y) + 3 * t * t * (s.p3.y - s.c2.y),
  };
}

function second(s: Segment, t: number): Point {
  const u = 1 - t;
  return {
    x: 6 * u * (s.c2.x - 2 * s.c1.x + s.p0.x) + 6 * t * (s.p3.x - 2 * s.c2.x + s.c1.x),
    y: 6 * u * (s.c2.y - 2 * s.c1.y + s.p0.y) + 6 * t * (s.p3.y - 2 * s.c2.y + s.c1.y),
  };
}

// ---------- eraser ----------

/** Distance from a point to the segment from `a` to `b`. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** The part of a cubic between `t0` and `t1`. */
function subCubic(c: Segment, t0: number, t1: number): Segment {
  const right = t0 > 0 ? splitSegment(c, t0)[1] : c;
  return t1 < 1 ? splitSegment(right, (t1 - t0) / (1 - t0))[0] : right;
}

/**
 * The eraser over strokes: what of the segments lies within `radius` of the
 * stroke from `from` to `to` goes; the curves are cut exactly (new loose
 * points at the cuts). Regions through a cut segment are no longer closed and
 * go. Null — nothing was touched.
 */
export function eraseNetwork(net: VectorNetwork, from: Point, to: Point, radius: number): VectorNetwork | null {
  const inside = (p: Point) => toSegment(p, from, to) < radius;
  const vertices = [...net.vertices];
  const segments: NetworkSegment[] = [];
  const cut = new Set<number>();
  const moved: number[] = [];
  net.segments.forEach((s, si) => {
    const c = cubicOf(net, s);
    const length = Math.hypot(c.c1.x - c.p0.x, c.c1.y - c.p0.y) + Math.hypot(c.c2.x - c.c1.x, c.c2.y - c.c1.y) + Math.hypot(c.p3.x - c.c2.x, c.p3.y - c.c2.y);
    const steps = Math.max(16, Math.min(2000, Math.ceil(length / Math.max(0.25, radius / 4))));
    const at = (t: number) => inside(cubicAt(c, t));
    // Where the segment goes in or out of the eraser, refined by halving.
    const edge = (t0: number, t1: number) => {
      const in0 = at(t0);
      for (let k = 0; k < 24; k++) {
        const m = (t0 + t1) / 2;
        if (at(m) === in0) t0 = m;
        else t1 = m;
      }
      return (t0 + t1) / 2;
    };
    const outside: [number, number][] = [];
    let start: number | null = at(0) ? null : 0;
    let prev = 0;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const was = at(prev);
      const now = at(t);
      if (was !== now) {
        const e = edge(prev, t);
        if (now) {
          if (start !== null) outside.push([start, e]);
          start = null;
        } else start = e;
      }
      prev = t;
    }
    if (start !== null) outside.push([start, 1]);
    if (outside.length === 1 && outside[0]![0] === 0 && outside[0]![1] === 1) {
      moved[si] = segments.length;
      segments.push(s);
      return;
    }
    cut.add(si);
    for (const [t0, t1] of outside) {
      if (t1 - t0 < 1e-6) continue;
      const part = subCubic(c, t0, t1);
      const end = (t: number, p: Point, v: number) => {
        if (t === 0 || t === 1) return v;
        vertices.push({ x: p.x, y: p.y });
        return vertices.length - 1;
      };
      const a = end(t0, part.p0, s.a);
      const b = end(t1, part.p3, s.b);
      segments.push({ a, b, ...(c.line ? {} : { ca: part.c1, cb: part.c2 }) });
    }
  });
  if (cut.size === 0) return null;
  // Renumber: points left without segments go (unless they were alone already).
  const used = new Set(segments.flatMap((s) => [s.a, s.b]));
  const before = new Set(net.segments.flatMap((s) => [s.a, s.b]));
  const index: number[] = [];
  const kept = vertices.filter((_, i) => used.has(i) || (i < net.vertices.length && !before.has(i)));
  let n = 0;
  vertices.forEach((_, i) => (index[i] = used.has(i) || (i < net.vertices.length && !before.has(i)) ? n++ : -1));
  const regions = net.regions.filter((r) => !r.loops.some((l) => l.some((x) => cut.has(x)))).map((r) => ({ ...r, loops: r.loops.map((l) => l.map((x) => moved[x]!)) }));
  return { vertices: kept, segments: segments.map((s) => ({ ...s, a: index[s.a]!, b: index[s.b]! })), regions };
}

/**
 * The eraser over a filled shape: the stroke from `from` to `to` is cut out of
 * its fill, with new points along the erased edge. Null — it missed the shape.
 */
export function eraseFill(net: VectorNetwork, from: Point, to: Point, radius: number): VectorNetwork | null {
  const { fill, evenOdd } = networkPaths(net);
  const polys = flattenPaths(fill, 0.05).filter((l) => l.closed && l.points.length >= 3).map((l) => l.points);
  if (polys.length === 0) return null;
  const xs = polys.flat().map((p) => p.x);
  const ys = polys.flat().map((p) => p.y);
  if (Math.max(from.x, to.x) + radius < Math.min(...xs) || Math.min(from.x, to.x) - radius > Math.max(...xs) || Math.max(from.y, to.y) + radius < Math.min(...ys) || Math.min(from.y, to.y) - radius > Math.max(...ys)) return null;
  const shape = booleanRegions('UNION', { contours: polys, rule: evenOdd ? 'EVENODD' : 'NONZERO' }, { contours: [], rule: 'NONZERO' });
  const left = booleanRegions('SUBTRACT', shape, { contours: [eraserCapsule(from, to, radius)], rule: 'NONZERO' });
  const area = (r: { contours: Point[][] }) => Math.abs(r.contours.reduce((s, c) => s + c.reduce((a, p, i) => a + (c[(i + 1) % c.length]!.x - p.x) * (c[(i + 1) % c.length]!.y + p.y), 0) / 2, 0));
  if (Math.abs(area(left) - area(shape)) < 1e-3) return null;
  return networkFromPaths(left.contours.map((c) => ({ closed: true, points: c.map((p) => ({ x: p.x, y: p.y })) })));
}

/** The eraser's stroke from `from` to `to` as a polygon (a capsule). */
export function eraserCapsule(from: Point, to: Point, radius: number): Point[] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const n = Math.max(8, Math.min(32, Math.ceil(radius)));
  const arc = (c: Point, a0: number) => Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + Math.cos(a0 + (Math.PI * i) / n) * radius, y: c.y + Math.sin(a0 + (Math.PI * i) / n) * radius }));
  return [...arc(to, angle - Math.PI / 2), ...arc(from, angle + Math.PI / 2)];
}

// ---------- handle mirroring ----------

/** The two handles at a smooth-able point: segment indices and which end; null — not two segments. */
export function handlesAt(net: VectorNetwork, v: number): { segment: number; end: 'a' | 'b' }[] | null {
  const at: { segment: number; end: 'a' | 'b' }[] = [];
  net.segments.forEach((s, i) => {
    if (s.a === v) at.push({ segment: i, end: 'a' });
    if (s.b === v) at.push({ segment: i, end: 'b' });
  });
  return at.length === 2 ? at : null;
}

/** How the handles at a point follow each other: its own setting, or read from how they stand. */
export function vertexMirror(net: VectorNetwork, v: number): HandleMirror {
  const own = net.vertices[v]?.mirror;
  if (own) return own;
  const at = handlesAt(net, v);
  const p = net.vertices[v];
  if (!at || !p) return 'NONE';
  const [h1, h2] = at.map(({ segment, end }) => (end === 'a' ? net.segments[segment]!.ca : net.segments[segment]!.cb));
  if (!h1 || !h2) return 'NONE';
  const a1 = Math.atan2(h1.y - p.y, h1.x - p.x);
  const a2 = Math.atan2(h2.y - p.y, h2.x - p.x);
  let diff = Math.abs(a1 - a2) % (2 * Math.PI);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  if (Math.abs(diff - Math.PI) > 0.02) return 'NONE';
  const l1 = Math.hypot(h1.x - p.x, h1.y - p.y);
  const l2 = Math.hypot(h2.x - p.x, h2.y - p.y);
  return Math.abs(l1 - l2) <= Math.max(0.05, 0.01 * Math.max(l1, l2)) ? 'ANGLE_AND_LENGTH' : 'ANGLE';
}

/** After a point's mirroring is set: the second handle follows the first one, as the setting says. */
export function applyMirror(net: VectorNetwork, points: ReadonlySet<number>): VectorNetwork {
  const segments = net.segments.map((s) => ({ ...s }));
  for (const v of points) {
    const mode = net.vertices[v]?.mirror;
    const pair = handlesAt(net, v);
    if (!mode || mode === 'NONE' || !pair) continue;
    const p = net.vertices[v]!;
    const [first, second] = pair as [{ segment: number; end: 'a' | 'b' }, { segment: number; end: 'a' | 'b' }];
    const h1 = first.end === 'a' ? segments[first.segment]!.ca : segments[first.segment]!.cb;
    const h2 = second.end === 'a' ? segments[second.segment]!.ca : segments[second.segment]!.cb;
    if (!h1 || !h2) continue;
    const l1 = Math.hypot(h1.x - p.x, h1.y - p.y);
    const len = mode === 'ANGLE' ? Math.hypot(h2.x - p.x, h2.y - p.y) : l1;
    if (l1 === 0) continue;
    const next = { x: Math.round((p.x - ((h1.x - p.x) * len) / l1) * 100) / 100, y: Math.round((p.y - ((h1.y - p.y) * len) / l1) * 100) / 100 };
    if (second.end === 'a') segments[second.segment]!.ca = next;
    else segments[second.segment]!.cb = next;
  }
  return { ...net, segments };
}
