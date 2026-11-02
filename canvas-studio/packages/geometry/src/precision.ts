// Geometry of precision tools (stage "Precision"): layout grid tracks,
// measurements between boxes, per-side stroke regions and line-end shapes.
// Pure functions of plain data, shared by the canvas, the snapping engine and
// the SVG / PDF exporters.

import type { LayoutGrid, LineCap, VectorPath, VectorPoint } from '#core';
import type { Point, Rect } from './rect.ts';

const KAPPA = 0.5522847498;

// ---------- layout grids (FR-GRD-001) ----------

export interface GridTracks {
  /** Columns (x) or rows (y) as [start, end] in the frame's coordinates. */
  tracks: [number, number][];
  axis: 'x' | 'y';
}

/**
 * Tracks of a COLUMNS / ROWS grid inside a frame of `width` × `height`, as
 * Figma computes them: stretched columns divide the space between the margins;
 * left / center / right columns have a fixed size; count 0 fits as many as possible.
 */
export function gridTracks(grid: LayoutGrid, width: number, height: number): GridTracks | null {
  if (grid.pattern === 'GRID') return null;
  const axis = grid.pattern === 'COLUMNS' ? 'x' : 'y';
  const size = axis === 'x' ? width : height;
  const g = Math.max(0, grid.gutterSize);
  const tracks: [number, number][] = [];
  if (grid.alignment === 'STRETCH') {
    const n = Math.max(1, Math.round(grid.count || 1));
    const m = grid.offset;
    const track = (size - 2 * m - (n - 1) * g) / n;
    if (track <= 0) return { axis, tracks };
    for (let i = 0; i < n; i++) {
      const a = m + i * (track + g);
      tracks.push([a, a + track]);
    }
    return { axis, tracks };
  }
  const s = Math.max(1, grid.sectionSize);
  const available = grid.alignment === 'CENTER' ? size : size - Math.max(0, grid.offset);
  const n = grid.count > 0 ? Math.round(grid.count) : Math.max(1, Math.floor((available + g) / (s + g)));
  const total = n * s + (n - 1) * g;
  const start = grid.alignment === 'MIN' ? grid.offset : grid.alignment === 'MAX' ? size - grid.offset - total : (size - total) / 2 + grid.offset;
  for (let i = 0; i < n; i++) {
    const a = start + i * (s + g);
    tracks.push([a, a + s]);
  }
  return { axis, tracks };
}

/** Snap lines of a grid (frame coordinates): track edges, or every cell of a square grid. */
export function gridSnapLines(grid: LayoutGrid, width: number, height: number, limit = 2000): { x: number[]; y: number[] } {
  if (!grid.visible) return { x: [], y: [] };
  if (grid.pattern === 'GRID') {
    const s = Math.max(1, grid.sectionSize);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = 0; x <= width + 1e-9 && xs.length < limit; x += s) xs.push(x);
    for (let y = 0; y <= height + 1e-9 && ys.length < limit; y += s) ys.push(y);
    return { x: xs, y: ys };
  }
  const t = gridTracks(grid, width, height);
  if (!t) return { x: [], y: [] };
  const lines = t.tracks.flatMap(([a, b]) => [a, b]);
  return t.axis === 'x' ? { x: lines, y: [] } : { x: [], y: lines };
}

// ---------- measurements (FR-CNV-042) ----------

export interface Measurement {
  from: Point;
  to: Point;
  /** Distance shown on the label. */
  value: number;
}

export interface MeasureResult {
  lines: Measurement[];
  /** Dashed helper lines that extend an edge to where a distance is measured. */
  helpers: { from: Point; to: Point }[];
}

const contains = (o: Rect, i: Rect) => i.x >= o.x - 1e-9 && i.y >= o.y - 1e-9 && i.x + i.width <= o.x + o.width + 1e-9 && i.y + i.height <= o.y + o.height + 1e-9;

/**
 * Distances from box `a` (the selection) to box `b` (what the pointer is over),
 * as Figma shows them with Alt: to the edges of a container, gaps to a
 * neighbour, or edge-to-edge offsets of overlapping boxes.
 */
export function measureRects(a: Rect, b: Rect): MeasureResult {
  const lines: Measurement[] = [];
  const helpers: { from: Point; to: Point }[] = [];
  const ar = a.x + a.width;
  const ab = a.y + a.height;
  const br = b.x + b.width;
  const bb = b.y + b.height;
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    const value = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (value > 1e-6) lines.push({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, value });
  };
  const inside = (outer: Rect, inner: Rect) => {
    const cy = inner.y + inner.height / 2;
    const cx = inner.x + inner.width / 2;
    push(outer.x, cy, inner.x, cy);
    push(inner.x + inner.width, cy, outer.x + outer.width, cy);
    push(cx, outer.y, cx, inner.y);
    push(cx, inner.y + inner.height, cx, outer.y + outer.height);
  };
  if (contains(b, a)) {
    inside(b, a);
    return { lines, helpers };
  }
  if (contains(a, b)) {
    inside(a, b);
    return { lines, helpers };
  }
  const overlapX = Math.min(ar, br) - Math.max(a.x, b.x);
  const overlapY = Math.min(ab, bb) - Math.max(a.y, b.y);
  if (overlapX > 0 && overlapY > 0) {
    // Overlapping boxes: offsets between matching edges.
    const cy = Math.max(a.y, b.y) + overlapY / 2;
    const cx = Math.max(a.x, b.x) + overlapX / 2;
    push(Math.min(a.x, b.x), cy, Math.max(a.x, b.x), cy);
    push(Math.min(ar, br), cy, Math.max(ar, br), cy);
    push(cx, Math.min(a.y, b.y), cx, Math.max(a.y, b.y));
    push(cx, Math.min(ab, bb), cx, Math.max(ab, bb));
    return { lines, helpers };
  }
  // Horizontal gap.
  if (ar <= b.x || br <= a.x) {
    const y = overlapY > 0 ? Math.max(a.y, b.y) + overlapY / 2 : a.y + a.height / 2;
    const x1 = ar <= b.x ? ar : br;
    const x2 = ar <= b.x ? b.x : a.x;
    push(x1, y, x2, y);
    // The far box's edge extended to the measuring line.
    const edgeX = ar <= b.x ? b.x : br;
    if (y < b.y) helpers.push({ from: { x: edgeX, y }, to: { x: edgeX, y: b.y } });
    else if (y > bb) helpers.push({ from: { x: edgeX, y: bb }, to: { x: edgeX, y } });
  }
  // Vertical gap.
  if (ab <= b.y || bb <= a.y) {
    const x = overlapX > 0 ? Math.max(a.x, b.x) + overlapX / 2 : a.x + a.width / 2;
    const y1 = ab <= b.y ? ab : bb;
    const y2 = ab <= b.y ? b.y : a.y;
    push(x, y1, x, y2);
    const edgeY = ab <= b.y ? b.y : bb;
    if (x < b.x) helpers.push({ from: { x, y: edgeY }, to: { x: b.x, y: edgeY } });
    else if (x > br) helpers.push({ from: { x: br, y: edgeY }, to: { x, y: edgeY } });
  }
  return { lines, helpers };
}

// ---------- equal spacing (FR-CNV-040, FR-DRW-092) ----------

export interface SpacingMatch {
  axis: 'x' | 'y';
  /** Gaps of equal size, each as [start, end] along the axis, at `at` across it. */
  gaps: { from: number; to: number; at: number }[];
  value: number;
}

/**
 * Where `moving` (along `axis`) would sit at the same gap as neighbours in a
 * row: returns the offset to apply and the gaps to mark. `others` are boxes
 * that overlap the moving box across the axis.
 */
export function equalSpacingSnap(moving: Rect, others: readonly Rect[], axis: 'x' | 'y', threshold: number): { offset: number; match: SpacingMatch } | null {
  const pos = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const len = (r: Rect) => (axis === 'x' ? r.width : r.height);
  const crossA = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const crossL = (r: Rect) => (axis === 'x' ? r.height : r.width);
  const overlapsAcross = (r: Rect) => Math.min(crossA(r) + crossL(r), crossA(moving) + crossL(moving)) - Math.max(crossA(r), crossA(moving)) > 0;
  const row = others.filter(overlapsAcross).sort((p, q) => pos(p) - pos(q));
  if (row.length < 2) return null;
  // Gaps between consecutive neighbours in the row.
  const gaps: { from: number; to: number; value: number; at: number }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const p = row[i]!;
    const q = row[i + 1]!;
    const from = pos(p) + len(p);
    const to = pos(q);
    const at = (Math.max(crossA(p), crossA(q)) + Math.min(crossA(p) + crossL(p), crossA(q) + crossL(q))) / 2;
    if (to - from > 0) gaps.push({ from, to, value: to - from, at });
  }
  let best: { offset: number; match: SpacingMatch } | null = null;
  const cross = crossA(moving) + crossL(moving) / 2;
  const consider = (target: number, value: number, extra: { from: number; to: number }) => {
    const offset = target - pos(moving);
    if (Math.abs(offset) > threshold || (best && Math.abs(best.offset) <= Math.abs(offset))) return;
    const same = gaps.filter((g) => Math.abs(g.value - value) < 0.5).map((g) => ({ from: g.from, to: g.to, at: g.at }));
    best = { offset, match: { axis, value, gaps: [...same, { ...extra, at: cross }] } };
  };
  for (const g of gaps) {
    // After the last box in the row, or before the first, at the same gap.
    const last = row[row.length - 1]!;
    const first = row[0]!;
    consider(pos(last) + len(last) + g.value, g.value, { from: pos(last) + len(last), to: pos(last) + len(last) + g.value });
    consider(pos(first) - g.value - len(moving), g.value, { from: pos(first) - g.value, to: pos(first) });
  }
  // Between two neighbours, centred.
  for (let i = 0; i + 1 < row.length; i++) {
    const p = row[i]!;
    const q = row[i + 1]!;
    const space = pos(q) - (pos(p) + len(p)) - len(moving);
    if (space <= 0) continue;
    const value = space / 2;
    const target = pos(p) + len(p) + value;
    const offset = target - pos(moving);
    if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset))) {
      best = { offset, match: { axis, value, gaps: [{ from: pos(p) + len(p), to: target, at: cross }, { from: target + len(moving), to: pos(q), at: cross }] } };
    }
  }
  return best;
}

// ---------- strokes (FR-DRW-060) ----------

/** A rounded rectangle as one closed contour. */
export function roundRectPath(x: number, y: number, w: number, h: number, radii: readonly [number, number, number, number]): VectorPath {
  const max = Math.max(0, Math.min(w, h) / 2);
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(max, r))) as [number, number, number, number];
  const pts: VectorPoint[] = [];
  const corner = (r: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    if (r === 0) {
      pts.push({ x: cx, y: cy });
      return;
    }
    pts.push({ x: ax, y: ay, out: { x: ax + (cx - ax) * KAPPA, y: ay + (cy - ay) * KAPPA } });
    pts.push({ x: bx, y: by, in: { x: bx + (cx - bx) * KAPPA, y: by + (cy - by) * KAPPA } });
  };
  corner(tl, x, y + tl, x + tl, y, x, y);
  corner(tr, x + w - tr, y, x + w, y + tr, x + w, y);
  corner(br, x + w, y + h - br, x + w - br, y + h, x + w, y + h);
  corner(bl, x + bl, y + h, x, y + h - bl, x, y + h);
  return { closed: true, points: pts };
}

/**
 * The area painted by a stroke with different weights per side, as two
 * contours filled with the even-odd rule (outer edge, inner edge).
 * `weights` are [top, right, bottom, left].
 */
export function sideStrokeRegion(
  w: number,
  h: number,
  radii: readonly [number, number, number, number],
  weights: readonly [number, number, number, number],
  align: 'INSIDE' | 'CENTER' | 'OUTSIDE',
): VectorPath[] {
  const k = align === 'INSIDE' ? 0 : align === 'CENTER' ? 0.5 : 1;
  const [t, r, b, l] = weights.map((v) => Math.max(0, v)) as [number, number, number, number];
  const out = [t * k, r * k, b * k, l * k] as const;
  const ins = [t * (1 - k), r * (1 - k), b * (1 - k), l * (1 - k)] as const;
  // Corner order: top-left (top+left), top-right, bottom-right, bottom-left.
  const cornerSides: [number, number][] = [[0, 3], [0, 1], [2, 1], [2, 3]];
  const outerRadii = radii.map((rad, i) => (rad > 0 ? rad + Math.max(out[cornerSides[i]![0]]!, out[cornerSides[i]![1]]!) : 0)) as [number, number, number, number];
  const innerRadii = radii.map((rad, i) => Math.max(0, rad - Math.max(ins[cornerSides[i]![0]]!, ins[cornerSides[i]![1]]!))) as [number, number, number, number];
  const outer = roundRectPath(-out[3], -out[0], w + out[1] + out[3], h + out[0] + out[2], outerRadii);
  const iw = w - ins[1] - ins[3];
  const ih = h - ins[0] - ins[2];
  if (iw <= 0 || ih <= 0) return [outer];
  if (radii.every((rad) => rad <= 0)) {
    // Square corners: the bands of the sides, without overlaps. Two contours would
    // share the edges of the zero sides, and smoothing leaves a hairline there.
    const x0 = 0 - out[3], y0 = 0 - out[0], x1 = w + out[1], y1 = h + out[2];
    const ix1 = ins[3] + iw, iy1 = ins[0] + ih;
    const band = (ax: number, ay: number, bx: number, by: number) => roundRectPath(ax, ay, bx - ax, by - ay, [0, 0, 0, 0]);
    const bands: VectorPath[] = [];
    if (ins[0] > y0) bands.push(band(x0, y0, x1, ins[0]));
    if (y1 > iy1) bands.push(band(x0, iy1, x1, y1));
    if (ins[3] > x0) bands.push(band(x0, ins[0], ins[3], iy1));
    if (x1 > ix1) bands.push(band(ix1, ins[0], x1, iy1));
    return bands;
  }
  return [outer, roundRectPath(ins[3], ins[0], iw, ih, innerRadii)];
}

// ---------- line ends (FR-DRW-062) ----------

export interface CapShape {
  paths: VectorPath[];
  /** Filled shapes (triangle, circle…) or stroked lines (line arrow). */
  filled: boolean;
}

/**
 * Shape of a line end at `p`, pointing along `angle` (radians, the direction
 * the line travels when it arrives at the end), sized from the stroke weight.
 */
export function capShape(kind: LineCap, p: Point, angle: number, weight: number): CapShape | null {
  if (kind === 'NONE') return null;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Local frame: +u along the line (towards the tip), +v across it.
  const at = (u: number, v: number): VectorPoint => ({ x: p.x + u * cos - v * sin, y: p.y + u * sin + v * cos });
  const len = Math.max(6, weight * 4);
  const spread = Math.max(4, weight * 2.5);
  const poly = (pts: VectorPoint[], closed = true): VectorPath => ({ closed, points: pts });
  switch (kind) {
    case 'ARROW':
      return { filled: true, paths: [poly([at(0, 0), at(-len, -spread), at(-len, spread)])] };
    case 'REVERSED_TRIANGLE':
      return { filled: true, paths: [poly([at(-len, 0), at(0, -spread), at(0, spread)])] };
    case 'LINE_ARROW':
      return { filled: false, paths: [poly([at(-len, -spread), at(0, 0), at(-len, spread)], false)] };
    case 'DIAMOND': {
      const s = Math.max(4, weight * 2.5);
      return { filled: true, paths: [poly([at(s, 0), at(0, -s), at(-s, 0), at(0, s)])] };
    }
    case 'SQUARE': {
      const s = Math.max(3, weight * 2);
      return { filled: true, paths: [poly([at(-s, -s), at(s, -s), at(s, s), at(-s, s)])] };
    }
    case 'CIRCLE': {
      const rr = Math.max(3, weight * 2);
      const kk = rr * KAPPA;
      return {
        filled: true,
        paths: [
          {
            closed: true,
            points: [
              { x: p.x + rr, y: p.y, in: { x: p.x + rr, y: p.y - kk }, out: { x: p.x + rr, y: p.y + kk } },
              { x: p.x, y: p.y + rr, in: { x: p.x + kk, y: p.y + rr }, out: { x: p.x - kk, y: p.y + rr } },
              { x: p.x - rr, y: p.y, in: { x: p.x - rr, y: p.y + kk }, out: { x: p.x - rr, y: p.y - kk } },
              { x: p.x, y: p.y - rr, in: { x: p.x - kk, y: p.y - rr }, out: { x: p.x + kk, y: p.y - rr } },
            ],
          },
        ],
      };
    }
  }
}

/** End points of open contours with the direction of arrival (for caps on vectors and lines). */
export function openEnds(paths: readonly VectorPath[]): { start: { p: Point; angle: number }; end: { p: Point; angle: number } }[] {
  const out: { start: { p: Point; angle: number }; end: { p: Point; angle: number } }[] = [];
  for (const path of paths) {
    if (path.closed || path.points.length < 2) continue;
    const pts = path.points;
    const first = pts[0]!;
    const second = pts[1]!;
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    // Direction from the nearest control point (handle) towards the end.
    const fromStart = first.out ?? second.in ?? second;
    const toEnd = last.in ?? prev.out ?? prev;
    out.push({
      start: { p: { x: first.x, y: first.y }, angle: Math.atan2(first.y - fromStart.y, first.x - fromStart.x) },
      end: { p: { x: last.x, y: last.y }, angle: Math.atan2(last.y - toEnd.y, last.x - toEnd.x) },
    });
  }
  return out;
}
