// Snapping (FR-CNV-040, 041): edges and centres of nearby objects, ruler
// guides, layout grids of frames, whole pixels and equal gaps between
// neighbours. The threshold is 4 screen pixels, so snapping feels the same at
// any zoom; Mod while dragging turns it off (FR-CNV-043).

import type { NodeId } from '#core';
import { equalSpacingSnap, gridSnapLines, type Measurement, type Rect, type SpacingMatch } from '#geometry';
import type { Editor, Guide } from './editor.ts';

export const SNAP_SCREEN_PX = 4;

type LineKind = 'object' | 'guide' | 'grid';

interface Line {
  at: number;
  from: number;
  to: number;
  kind: LineKind;
}

export interface SnapTargets {
  x: Line[];
  y: Line[];
  /** Neighbours for equal spacing and distance labels (siblings of what moves). */
  boxes: Rect[];
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  spacing: SpacingMatch[];
}

const INF = 1e9;

/**
 * Collects snap targets around the objects being edited: visible objects,
 * ruler guides, layout grids of frames in view, and the siblings of `exclude`.
 */
export function collectTargets(editor: Editor, exclude: readonly NodeId[]): SnapTargets {
  const { doc, scene, viewport } = editor;
  const targets: SnapTargets = { x: [], y: [], boxes: [] };
  if (!editor.view.snapping) return targets;
  const visible = viewport.visibleRect(editor.screenSize.width, editor.screenSize.height);
  const ids = scene.queryRect(visible);
  const excluded = (id: NodeId) => exclude.some((e) => doc.store.isAncestorOrSelf(e, id));
  let count = 0;
  for (const id of ids) {
    if (count > 2000) break;
    if (excluded(id) || !doc.get(id, 'visible')) continue;
    // Snap to direct content of open containers only, not to every nested leaf.
    if (doc.store.ancestors(id).length > 6) continue;
    addRect(targets, scene.bounds(id));
    count++;
  }
  // Ruler guides: lines across the whole canvas (page) or the frame (frame guides).
  for (const g of editor.worldGuides()) {
    const line: Line = { at: g.at, from: g.span ? (g.axis === 'X' ? g.span.y : g.span.x) : -INF, to: g.span ? (g.axis === 'X' ? g.span.y + g.span.height : g.span.x + g.span.width) : INF, kind: 'guide' };
    (g.axis === 'X' ? targets.x : targets.y).push(line);
  }
  // Layout grids of frames in view (FR-GRD-003).
  if (editor.view.layoutGrids) {
    for (const id of ids) {
      const grids = doc.get(id, 'layoutGrids');
      if (grids.length === 0 || !doc.get(id, 'visible')) continue;
      const m = scene.world(id);
      if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9) continue;
      const w = doc.get(id, 'width');
      const h = doc.get(id, 'height');
      for (const grid of grids) {
        const lines = gridSnapLines(grid, w, h, 400);
        for (const x of lines.x) targets.x.push({ at: m.e + x, from: m.f, to: m.f + h, kind: 'grid' });
        for (const y of lines.y) targets.y.push({ at: m.f + y, from: m.e, to: m.e + w, kind: 'grid' });
      }
    }
  }
  // Siblings for equal spacing.
  const parents = new Set(exclude.map((id) => doc.parent(id)).filter((p): p is NodeId => p !== null));
  for (const parent of parents) {
    for (const child of doc.children(parent)) {
      if (exclude.includes(child) || !doc.get(child, 'visible')) continue;
      targets.boxes.push(scene.bounds(child));
      if (targets.boxes.length > 500) break;
    }
  }
  return targets;
}

function addRect(t: SnapTargets, r: Rect): void {
  for (const at of [r.x, r.x + r.width / 2, r.x + r.width]) t.x.push({ at, from: r.y, to: r.y + r.height, kind: 'object' });
  for (const at of [r.y, r.y + r.height / 2, r.y + r.height]) t.y.push({ at, from: r.x, to: r.x + r.width, kind: 'object' });
}

/** Best snap offset for a set of candidate coordinates along one axis. */
function bestOffset(values: readonly number[], lines: readonly Line[], threshold: number): { offset: number; hits: Line[] } | null {
  let best: number | null = null;
  for (const v of values) {
    for (const line of lines) {
      const d = line.at - v;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  if (best === null) return null;
  const offset = best;
  const hits = lines.filter((line) => values.some((v) => Math.abs(line.at - (v + offset)) < 0.01));
  return { offset, hits };
}

/** A guide line to draw for a snapped line, spanning the line's extent and the moved box. */
function guideFor(axis: 'x' | 'y', line: Line, box: Rect): Guide {
  const lo = axis === 'x' ? box.y : box.x;
  const hi = axis === 'x' ? box.y + box.height : box.x + box.width;
  // Guides and grids are already visible: only the object part is drawn, bounded by the box.
  if (line.kind !== 'object') return { axis, at: line.at, from: lo, to: hi };
  return { axis, at: line.at, from: Math.min(line.from, lo), to: Math.max(line.to, hi) };
}

const roundPx = (v: number) => Math.round(v);

/** Snaps a moving rectangle; returns the offset to apply, the lines to draw and the equal gaps found. */
export function snapRect(editor: Editor, moving: Rect, targets: SnapTargets): SnapResult {
  const threshold = SNAP_SCREEN_PX / editor.viewport.zoom;
  const xs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const ys = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];
  const sx = bestOffset(xs, targets.x, threshold);
  const sy = bestOffset(ys, targets.y, threshold);
  // Equal gaps compete with lines; the closer one wins.
  const ex = equalSpacingSnap(moving, targets.boxes, 'x', threshold);
  const ey = equalSpacingSnap(moving, targets.boxes, 'y', threshold);
  const useEx = ex && (!sx || Math.abs(ex.offset) < Math.abs(sx.offset) - 1e-9);
  const useEy = ey && (!sy || Math.abs(ey.offset) < Math.abs(sy.offset) - 1e-9);
  let dx = useEx ? ex!.offset : (sx?.offset ?? 0);
  let dy = useEy ? ey!.offset : (sy?.offset ?? 0);
  // Without a snap the position lands on whole pixels.
  if (editor.view.snapToPixel) {
    if (!sx && !useEx) dx = roundPx(moving.x + dx) - moving.x;
    if (!sy && !useEy) dy = roundPx(moving.y + dy) - moving.y;
  }
  const snapped = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };
  const guides: Guide[] = [];
  if (!useEx) for (const line of sx?.hits ?? []) guides.push(guideFor('x', line, snapped));
  if (!useEy) for (const line of sy?.hits ?? []) guides.push(guideFor('y', line, snapped));
  const spacing: SpacingMatch[] = [];
  if (useEx) spacing.push(ex!.match);
  if (useEy) spacing.push(ey!.match);
  return { dx, dy, guides, spacing };
}

/** Snaps a single coordinate (a dragged edge or a point being drawn). */
export function snapValue(editor: Editor, axis: 'x' | 'y', value: number, targets: SnapTargets): { value: number; guide: Guide | null } {
  const threshold = SNAP_SCREEN_PX / editor.viewport.zoom;
  const lines = axis === 'x' ? targets.x : targets.y;
  const hit = bestOffset([value], lines, threshold);
  if (!hit) return { value: editor.view.snapToPixel ? roundPx(value) : value, guide: null };
  const line = hit.hits[0]!;
  const bounded = line.kind === 'object' ? { from: line.from, to: line.to } : { from: value - 1e-6, to: value + 1e-6 };
  return { value: value + hit.offset, guide: { axis, at: line.at, ...bounded } };
}

/**
 * Distances from a moving box to the nearest neighbour on each side (FR-CNV-041):
 * left/right among boxes overlapping it vertically, up/down among those overlapping horizontally.
 */
export function neighbourDistances(moving: Rect, boxes: readonly Rect[]): Measurement[] {
  const out: Measurement[] = [];
  const mr = moving.x + moving.width;
  const mb = moving.y + moving.height;
  let left: Rect | null = null;
  let right: Rect | null = null;
  let up: Rect | null = null;
  let down: Rect | null = null;
  for (const b of boxes) {
    const overlapY = Math.min(mb, b.y + b.height) - Math.max(moving.y, b.y) > 0;
    const overlapX = Math.min(mr, b.x + b.width) - Math.max(moving.x, b.x) > 0;
    if (overlapY && b.x + b.width <= moving.x && (!left || b.x + b.width > left.x + left.width)) left = b;
    if (overlapY && b.x >= mr && (!right || b.x < right.x)) right = b;
    if (overlapX && b.y + b.height <= moving.y && (!up || b.y + b.height > up.y + up.height)) up = b;
    if (overlapX && b.y >= mb && (!down || b.y < down.y)) down = b;
  }
  const midY = (b: Rect) => (Math.max(moving.y, b.y) + Math.min(mb, b.y + b.height)) / 2;
  const midX = (b: Rect) => (Math.max(moving.x, b.x) + Math.min(mr, b.x + b.width)) / 2;
  if (left) out.push({ from: { x: left.x + left.width, y: midY(left) }, to: { x: moving.x, y: midY(left) }, value: moving.x - (left.x + left.width) });
  if (right) out.push({ from: { x: mr, y: midY(right) }, to: { x: right.x, y: midY(right) }, value: right.x - mr });
  if (up) out.push({ from: { x: midX(up), y: up.y + up.height }, to: { x: midX(up), y: moving.y }, value: moving.y - (up.y + up.height) });
  if (down) out.push({ from: { x: midX(down), y: mb }, to: { x: midX(down), y: down.y }, value: down.y - mb });
  return out.filter((m) => m.value > 0);
}
