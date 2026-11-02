// Auto layout engine (section 9.4 of the spec).
//
// The model follows CSS Flexbox so that a layout built here translates to code
// without interpretation (FR-AL-006):
//   FIXED   → flex: none, width: Npx
//   HUG     → width: fit-content
//   FILL    → flex: 1 1 0
//   FR n    → flex: n 1 0
//   PERCENT → flex: none, width: n%
// min/max may be px or % of the parent's content box (FR-AL-005). With no min
// set, a filling layer is never narrower than its content can get — CSS
// `min-width: auto` (a text's longest word; a frame that clips: nothing).
//
// Widths are always resolved before heights, because wrapping text and nested
// auto layout derive their height from their width.
//
// Grid layout (FR-AL-020…024) follows CSS grid: columns and rows are px
// (FIXED), shares of the room left (FR) or as large as their content (HUG);
// layers sit in cells — where they are put, or in reading order — may span
// several, and fill their cell or align in it.

import { isFrameLike, type Document, type GridTrack, type Length, type NodeId, type Sizing } from '#core';
import { textStyleOf, type TextMeasurer } from './text-measure.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlexItem {
  base: number;
  grow: number;
  min: number;
  max: number;
}

const EPS = 1e-6;

/** Where a grid frame's columns and rows are (in the frame's own space), and the cell of each layer. */
export interface GridGeometry {
  columns: { start: number; size: number }[];
  rows: { start: number; size: number }[];
  cells: Map<NodeId, GridCell>;
}

export interface GridCell {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

/**
 * Puts layers into cells: those with a place first, the rest in reading
 * order into the first free cells. Returns the cells and how many columns
 * and rows there are (the frame's own, or more when layers need them).
 */
export function placeInGrid(doc: Document, frame: NodeId, children: readonly NodeId[]): { cells: Map<NodeId, GridCell>; columns: number; rows: number } {
  const cells = new Map<NodeId, GridCell>();
  const taken = new Set<string>();
  let columns = Math.max(1, doc.get(frame, 'gridColumns').length);
  const span = (v: number) => Math.max(1, Math.round(v) || 1);
  const take = (c: GridCell) => {
    for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.column; k < c.column + c.columnSpan; k++) taken.add(`${r}:${k}`);
  };
  const free = (c: GridCell) => {
    for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.column; k < c.column + c.columnSpan; k++) if (taken.has(`${r}:${k}`)) return false;
    return true;
  };
  const auto: NodeId[] = [];
  for (const child of children) {
    const col = doc.get(child, 'gridColumn');
    const row = doc.get(child, 'gridRow');
    if (col === null && row === null) {
      auto.push(child);
      continue;
    }
    const cell = { column: Math.max(0, Math.round(col ?? 0)), row: Math.max(0, Math.round(row ?? 0)), columnSpan: span(doc.get(child, 'gridColumnSpan')), rowSpan: span(doc.get(child, 'gridRowSpan')) };
    columns = Math.max(columns, cell.column + cell.columnSpan);
    cells.set(child, cell);
    take(cell);
  }
  let row = 0;
  let col = 0;
  for (const child of auto) {
    const columnSpan = Math.min(columns, span(doc.get(child, 'gridColumnSpan')));
    const rowSpan = span(doc.get(child, 'gridRowSpan'));
    for (let guard = 0; guard < 100_000; guard++) {
      if (col + columnSpan > columns) {
        col = 0;
        row++;
      }
      const cell = { column: col, row, columnSpan, rowSpan };
      if (free(cell)) {
        cells.set(child, cell);
        take(cell);
        col += columnSpan;
        break;
      }
      col++;
    }
  }
  let rows = doc.get(frame, 'gridRows').length;
  for (const c of cells.values()) rows = Math.max(rows, c.row + c.rowSpan);
  return { cells, columns, rows: Math.max(1, rows) };
}

/**
 * Sizes of grid tracks along one axis. `inner` — the room inside the frame
 * (null when the frame hugs its content: shares then size by content too);
 * `items` — the room each layer needs and the tracks it covers.
 */
export function gridTrackSizes(defs: readonly GridTrack[], count: number, inner: number | null, gap: number, items: readonly { start: number; span: number; size: number; min?: number }[]): number[] {
  const def = (i: number): GridTrack => defs[i] ?? { kind: 'HUG' };
  const isFr = (i: number) => def(i).kind === 'FR' && inner !== null;
  const sizes = Array.from({ length: count }, (_, i) => {
    const d = def(i);
    return d.kind === 'FIXED' ? Math.max(0, d.value) : 0;
  });
  // Content of single tracks first, then layers spanning several grow the content-sized tracks they cover.
  const ordered = [...items].sort((a, b) => a.span - b.span);
  for (const it of ordered) {
    const tracks = Array.from({ length: it.span }, (_, k) => it.start + k).filter((i) => i < count);
    const growable = tracks.filter((i) => def(i).kind === 'HUG' || (def(i).kind === 'FR' && inner === null));
    if (growable.length === 0) continue;
    if (it.span === 1) {
      sizes[it.start] = Math.max(sizes[it.start] ?? 0, it.size);
      continue;
    }
    if (tracks.some(isFr)) continue;
    const have = tracks.reduce((s, i) => s + (sizes[i] ?? 0), 0) + gap * (tracks.length - 1);
    const extra = it.size - have;
    if (extra > EPS) for (const i of growable) sizes[i]! += extra / growable.length;
  }
  if (inner !== null) {
    // A share is never less than the least its layers take (CSS: 1fr = minmax(auto, 1fr)); a share that
    // would be is held there, and the others split what is left.
    const floor = sizes.map(() => 0);
    for (const it of items) if (it.span === 1 && it.min && isFr(it.start)) floor[it.start] = Math.max(floor[it.start] ?? 0, it.min);
    let frs = sizes.map((_, i) => i).filter(isFr);
    const used = sizes.reduce((s, v, i) => s + (isFr(i) ? 0 : v), 0) + gap * Math.max(0, count - 1);
    let room = Math.max(0, inner - used);
    while (frs.length) {
      const total = frs.reduce((s, i) => s + Math.max(0, (def(i) as { value: number }).value), 0) || 1;
      for (const i of frs) sizes[i] = (room * Math.max(0, (def(i) as { value: number }).value)) / total;
      const held = frs.filter((i) => (sizes[i] ?? 0) < (floor[i] ?? 0) - EPS);
      if (!held.length) break;
      for (const i of held) {
        sizes[i] = floor[i]!;
        room = Math.max(0, room - floor[i]!);
      }
      frs = frs.filter((i) => !held.includes(i));
    }
  }
  return sizes;
}

function resolveLength(length: Length | null, parentInner: number | null): number | null {
  if (length === null) return null;
  if (length.unit === 'PX') return length.value;
  return parentInner === null ? null : (length.value / 100) * parentInner;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Distributes `free` space among growing items, freezing items that hit min/max (CSS flex algorithm). */
export function distribute(items: readonly FlexItem[], free: number): number[] {
  const sizes = items.map((item) => clamp(item.base, item.min, item.max));
  let active = items.map((item, i) => (item.grow > 0 ? i : -1)).filter((i) => i >= 0);
  let remaining = free;
  for (let guard = 0; guard <= items.length && active.length > 0; guard++) {
    const totalGrow = active.reduce((sum, i) => sum + (items[i]?.grow ?? 0), 0);
    const share = Math.max(0, remaining);
    const frozen: number[] = [];
    for (const i of active) {
      const item = items[i]!;
      const target = item.base + (share * item.grow) / totalGrow;
      const clamped = clamp(target, item.min, item.max);
      sizes[i] = clamped;
      if (Math.abs(clamped - target) > EPS) frozen.push(i);
    }
    if (frozen.length === 0) break;
    for (const i of frozen) remaining -= (sizes[i] ?? 0) - (items[i]?.base ?? 0);
    active = active.filter((i) => !frozen.includes(i));
  }
  return sizes;
}

export class LayoutEngine {
  readonly boxes = new Map<NodeId, Box>();
  /** Columns, rows and cells of every grid frame laid out (for the canvas and dropping into cells). */
  readonly grids = new Map<NodeId, GridGeometry>();
  private readonly doc: Document;
  private readonly measurer: TextMeasurer;
  private readonly minContent = new Map<NodeId, number>();

  constructor(doc: Document, measurer: TextMeasurer) {
    this.doc = doc;
    this.measurer = measurer;
  }

  isAutoLayout(id: NodeId): boolean {
    return isFrameLike(this.doc.type(id)) && this.doc.get(id, 'layoutMode') !== 'NONE';
  }

  /** Children that take part in the flow: visible and not absolutely positioned. */
  flowChildren(id: NodeId): NodeId[] {
    return this.doc
      .children(id)
      .filter((c) => this.doc.get(c, 'visible') && this.doc.get(c, 'positioning') === 'AUTO');
  }

  /**
   * Lays out `root` and everything auto-laid-out beneath it.
   * The root keeps its position; its size is resolved from its own sizing.
   */
  layoutRoot(root: NodeId): Map<NodeId, Box> {
    const x = this.doc.get(root, 'x');
    const y = this.doc.get(root, 'y');
    if (this.doc.type(root) === 'TEXT') {
      const width = this.intrinsicWidth(root);
      this.boxes.set(root, { x, y, width, height: this.heightFor(root, width) });
      return this.boxes;
    }
    if (!this.isAutoLayout(root)) return this.boxes;
    const width = this.doc.get(root, 'sizingH').mode === 'HUG' ? this.intrinsicWidth(root) : this.doc.get(root, 'width');
    const fixedHeight = this.doc.get(root, 'sizingV').mode === 'HUG' ? null : this.doc.get(root, 'height');
    const height = this.arrange(root, width, fixedHeight);
    this.boxes.set(root, { x, y, width, height });
    return this.boxes;
  }

  /**
   * Effective sizing of a child along an axis. Auto-sizing text hugs its content:
   * "auto height" text hugs vertically, "auto width" text hugs on both axes.
   */
  sizing(id: NodeId, axis: 'H' | 'V'): Sizing {
    // A rotated child keeps its size; the flow uses its rotated bounding box (as Figma does).
    if (this.doc.get(id, 'rotation') !== 0) return { mode: 'FIXED' };
    const stored = this.doc.get(id, axis === 'H' ? 'sizingH' : 'sizingV');
    if (stored.mode !== 'FIXED' || this.doc.type(id) !== 'TEXT') return stored;
    const auto = this.doc.get(id, 'textAutoResize');
    if (axis === 'V' && auto !== 'NONE') return { mode: 'HUG' };
    if (axis === 'H' && auto === 'WIDTH_AND_HEIGHT') return { mode: 'HUG' };
    return stored;
  }

  /**
   * Room a child takes in the flow: its size, or for a rotated child the box
   * around the rotated shape, with the offset from that box to the child's origin.
   */
  footprint(id: NodeId): { width: number; height: number; dx: number; dy: number } {
    const w = this.doc.get(id, 'width');
    const h = this.doc.get(id, 'height');
    const deg = this.doc.get(id, 'rotation');
    if (deg === 0) return { width: w, height: h, dx: 0, dy: 0 };
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    // Corners rotated about the top-left corner (the node's origin).
    const xs = [0, w * cos, -h * sin, w * cos - h * sin];
    const ys = [0, w * sin, h * cos, w * sin + h * cos];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, dx: -minX, dy: -minY };
  }

  /** Stored size along an axis, as the flow sees it (rotated children: their bounding box). */
  private fixedSize(id: NodeId, axis: 'H' | 'V'): number {
    const f = this.footprint(id);
    return axis === 'H' ? f.width : f.height;
  }

  // ---------- intrinsic sizes ----------

  /** Width the node would have if it hugged its content. */
  intrinsicWidth(id: NodeId): number {
    const type = this.doc.type(id);
    if (type === 'TEXT') {
      if (this.doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT') return this.measureText(id, null).width;
      return this.doc.get(id, 'width');
    }
    if (this.isAutoLayout(id) && this.doc.get(id, 'sizingH').mode === 'HUG') return this.contentWidth(id);
    return this.doc.get(id, 'width');
  }

  /** Height of a node laid out at `width`. */
  heightFor(id: NodeId, width: number): number {
    const type = this.doc.type(id);
    if (type === 'TEXT') {
      if (this.doc.get(id, 'textAutoResize') === 'NONE') return this.doc.get(id, 'height');
      return this.measureText(id, width).height;
    }
    if (this.isAutoLayout(id)) {
      const fixed = this.doc.get(id, 'sizingV').mode === 'HUG' ? null : this.doc.get(id, 'height');
      return this.arrange(id, width, fixed);
    }
    return this.doc.get(id, 'height');
  }

  private contentWidth(id: NodeId): number {
    if (this.doc.get(id, 'layoutMode') === 'GRID') return this.gridColumns(id, null).width;
    const children = this.flowChildren(id);
    const horizontal = this.doc.get(id, 'layoutMode') === 'HORIZONTAL';
    const pad = this.padding(id);
    const padding = pad.left + pad.right;
    const widths = children.map((c) => this.hugWidthOfChild(c));
    if (!horizontal) return padding + Math.max(0, ...widths);
    const gaps = this.doc.get(id, 'itemSpacing') * Math.max(0, children.length - 1);
    return padding + widths.reduce((s, w) => s + w, 0) + gaps;
  }

  private hugWidthOfChild(child: NodeId): number {
    const sizing = this.sizing(child, 'H');
    const raw = sizing.mode === 'FIXED' ? this.fixedSize(child, 'H') : this.intrinsicWidth(child);
    const min = resolveLength(this.doc.get(child, 'minWidth'), null) ?? 0;
    const max = resolveLength(this.doc.get(child, 'maxWidth'), null) ?? Infinity;
    return clamp(raw, min, max) + this.strokeExtra(child, 'H');
  }

  /**
   * The least width a layer takes without its content sticking out — CSS
   * `min-width: auto` of a flex item, `minmax(auto, 1fr)` of a grid column: a
   * text's longest word, a row's layers side by side, a column's widest. A
   * frame that clips its content shrinks to nothing (overflow: hidden, as in
   * CSS), and so does a layer outside auto layout.
   */
  minContentWidth(id: NodeId): number {
    const cached = this.minContent.get(id);
    if (cached !== undefined) return cached;
    let w = 0;
    if (this.doc.type(id) === 'TEXT') {
      if (this.doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT') w = this.measureText(id, null).width;
      else {
        // Every word on a line of its own: the widest line is the longest word (CJK: the widest letter).
        const lines = this.measureText(id, 0).lines;
        w = Math.ceil(Math.max(0, ...lines.map((l) => (l.x ?? 0) + l.width)));
      }
    } else if (this.isAutoLayout(id) && !this.doc.get(id, 'clipsContent')) {
      const children = this.flowChildren(id);
      const each = children.map((c) => this.minContribution(c));
      const mode = this.doc.get(id, 'layoutMode');
      if (mode === 'GRID') {
        const placement = placeInGrid(this.doc, id, children);
        const defs = this.doc.get(id, 'gridColumns');
        const cols = Array.from({ length: placement.columns }, (_, i) => (defs[i]?.kind === 'FIXED' ? Math.max(0, (defs[i] as { value: number }).value) : 0));
        children.forEach((c, i) => {
          const cell = placement.cells.get(c)!;
          if (cell.columnSpan === 1 && defs[cell.column]?.kind !== 'FIXED') cols[cell.column] = Math.max(cols[cell.column] ?? 0, each[i] ?? 0);
        });
        w = cols.reduce((sum, v) => sum + v, 0) + this.doc.get(id, 'gridColumnGap') * Math.max(0, cols.length - 1);
      } else if (mode === 'HORIZONTAL' && !this.doc.get(id, 'layoutWrap')) {
        w = each.reduce((sum, v) => sum + v, 0) + Math.max(0, this.doc.get(id, 'itemSpacing')) * Math.max(0, children.length - 1);
      } else w = Math.max(0, ...each);
      const pad = this.padding(id);
      w += pad.left + pad.right;
    }
    this.minContent.set(id, w);
    return w;
  }

  /** What a layer adds to its parent's least width: its own, its content's, or its least when it fills. */
  private minContribution(child: NodeId): number {
    const sizing = this.sizing(child, 'H');
    const raw = sizing.mode === 'FIXED' ? this.fixedSize(child, 'H') : sizing.mode === 'HUG' ? this.intrinsicWidth(child) : sizing.mode === 'PERCENT' ? 0 : this.minContentWidth(child);
    const min = resolveLength(this.doc.get(child, 'minWidth'), null) ?? 0;
    const max = resolveLength(this.doc.get(child, 'maxWidth'), null) ?? Infinity;
    return clamp(raw, min, max) + this.strokeExtra(child, 'H');
  }

  private measureText(id: NodeId, maxWidth: number | null) {
    const d = this.doc;
    return this.measurer.measure(
      textStyleOf(d, id),
      maxWidth,
    );
  }

  // ---------- arrangement ----------

  /** Lays out the children of an auto layout frame at `width` × `height` (null = hug). Returns the final height. */
  arrange(id: NodeId, width: number, height: number | null): number {
    if (this.doc.get(id, 'layoutMode') === 'GRID') return this.arrangeGrid(id, width, height);
    return this.doc.get(id, 'layoutMode') === 'HORIZONTAL' ? this.arrangeHorizontal(id, width, height) : this.arrangeVertical(id, width, height);
  }

  private padding(id: NodeId) {
    // "Include strokes": the frame's own stroke inside its box adds to the padding.
    const [st, sr, sb, sl] = this.doc.get(id, 'strokesIncludedInLayout') ? this.strokeSides(id, 'inner') : [0, 0, 0, 0];
    return {
      top: this.doc.get(id, 'paddingTop') + st,
      right: this.doc.get(id, 'paddingRight') + sr,
      bottom: this.doc.get(id, 'paddingBottom') + sb,
      left: this.doc.get(id, 'paddingLeft') + sl,
    };
  }

  /** Stroke width per side [top, right, bottom, left] inside (or outside) a node's box. */
  private strokeSides(id: NodeId, part: 'inner' | 'outer'): [number, number, number, number] {
    if (!this.doc.get(id, 'strokes').some((p) => p.visible)) return [0, 0, 0, 0];
    const align = this.doc.get(id, 'strokeAlign');
    const share = align === 'CENTER' ? 0.5 : (align === 'INSIDE') === (part === 'inner') ? 1 : 0;
    const w = this.doc.get(id, 'strokeWeights') ?? [0, 0, 0, 0].map(() => this.doc.get(id, 'strokeWeight'));
    return w.map((v) => v * share) as [number, number, number, number];
  }

  /** Room a child's stroke takes outside its box when the parent counts strokes; [top, right, bottom, left]. */
  private outerStroke(child: NodeId): [number, number, number, number] {
    const parent = this.doc.parent(child);
    if (!parent || !this.doc.get(parent, 'strokesIncludedInLayout') || this.doc.type(child) === 'TEXT') return [0, 0, 0, 0];
    return this.strokeSides(child, 'outer');
  }

  /** Extra room along an axis for a child's outer stroke. */
  private strokeExtra(child: NodeId, axis: 'H' | 'V'): number {
    const [t, r, b, l] = this.outerStroke(child);
    return axis === 'H' ? l + r : t + b;
  }

  private mainItem(child: NodeId, sizing: Sizing, axis: 'H' | 'V', inner: number | null, hugSize: () => number): FlexItem {
    const minLen = this.doc.get(child, axis === 'H' ? 'minWidth' : 'minHeight');
    const maxLen = this.doc.get(child, axis === 'H' ? 'maxWidth' : 'maxHeight');
    // A filling layer with no min of its own: as narrow as its content can get, not narrower (CSS min-width: auto).
    const filling = (sizing.mode === 'FILL' || sizing.mode === 'FR') && inner !== null;
    const min = resolveLength(minLen, inner) ?? (filling && axis === 'H' ? this.minContentWidth(child) : 0);
    const max = resolveLength(maxLen, inner) ?? Infinity;
    const stored = this.fixedSize(child, axis);
    // The slot holds the child and its outer stroke (when the parent counts strokes).
    const ex = this.strokeExtra(child, axis);
    const slot = (it: FlexItem): FlexItem => (ex ? { base: it.base + ex, grow: it.grow, min: it.min + ex, max: it.max + ex } : it);
    switch (sizing.mode) {
      case 'FIXED':
        return slot({ base: stored, grow: 0, min, max });
      case 'HUG':
        return slot({ base: hugSize(), grow: 0, min, max });
      case 'PERCENT':
        return slot(inner === null ? { base: hugSize(), grow: 0, min, max } : { base: (sizing.value / 100) * inner, grow: 0, min, max });
      case 'FILL':
        return slot(inner === null ? { base: hugSize(), grow: 0, min, max } : { base: 0, grow: 1, min, max });
      case 'FR':
        return slot(inner === null ? { base: hugSize(), grow: 0, min, max } : { base: 0, grow: Math.max(0, sizing.value), min, max });
    }
  }

  private counterSize(child: NodeId, sizing: Sizing, axis: 'H' | 'V', inner: number | null, hugSize: () => number): number {
    const min = resolveLength(this.doc.get(child, axis === 'H' ? 'minWidth' : 'minHeight'), inner) ?? 0;
    const max = resolveLength(this.doc.get(child, axis === 'H' ? 'maxWidth' : 'maxHeight'), inner) ?? Infinity;
    let size: number;
    switch (sizing.mode) {
      case 'FIXED':
        size = this.fixedSize(child, axis);
        break;
      case 'HUG':
        size = hugSize();
        break;
      case 'PERCENT':
        size = inner === null ? hugSize() : (sizing.value / 100) * inner;
        break;
      case 'FILL':
      case 'FR':
        // Filling: the slot is the whole line; the child is the slot minus its outer stroke.
        if (inner !== null) return clamp(inner - this.strokeExtra(child, axis), min, max) + this.strokeExtra(child, axis);
        size = hugSize();
        break;
    }
    return clamp(size, min, max) + this.strokeExtra(child, axis);
  }

  /** Start offset and gap along the main axis for the chosen spacing mode. */
  private spacing(id: NodeId, inner: number, used: number, count: number): { start: number; gap: number } {
    const mode = this.doc.get(id, 'spacingMode');
    const gap = this.doc.get(id, 'itemSpacing');
    const free = inner - used;
    if (mode === 'BETWEEN' && count > 1 && free >= 0) return { start: 0, gap: free / (count - 1) };
    // One child with "auto" spacing sits at the start, as in Figma.
    if (mode === 'BETWEEN' && count <= 1) return { start: 0, gap };
    if (mode === 'AROUND' && count > 0 && free >= 0) return { start: free / count / 2, gap: free / count };
    if (mode === 'EVENLY' && count > 0 && free >= 0) return { start: free / (count + 1), gap: free / (count + 1) };
    const total = used + gap * Math.max(0, count - 1);
    const align = this.doc.get(id, 'primaryAlign');
    const start = align === 'CENTER' ? (inner - total) / 2 : align === 'MAX' ? inner - total : 0;
    return { start, gap };
  }

  private fixedGaps(id: NodeId, count: number): number {
    return this.doc.get(id, 'spacingMode') === 'FIXED' ? this.doc.get(id, 'itemSpacing') * Math.max(0, count - 1) : 0;
  }

  private counterOffset(id: NodeId, inner: number, size: number): number {
    const align = this.doc.get(id, 'counterAlign');
    if (align === 'CENTER') return (inner - size) / 2;
    if (align === 'MAX') return inner - size;
    return 0;
  }

  private arrangeHorizontal(id: NodeId, width: number, height: number | null): number {
    const pad = this.padding(id);
    const innerW = Math.max(0, width - pad.left - pad.right);
    const innerHKnown = height === null ? null : Math.max(0, height - pad.top - pad.bottom);
    const children = this.flowChildren(id);
    const wrap = this.doc.get(id, 'layoutWrap');
    const gap = this.doc.get(id, 'itemSpacing');

    // 1. Widths (main axis).
    const items = children.map((c) => this.mainItem(c, this.sizing(c, 'H'), 'H', innerW, () => this.intrinsicWidth(c)));
    let widths: number[];
    const lines: number[][] = [[]];
    if (wrap) {
      // 2. Lines. A filling layer claims its min width (or its content's) when rows are formed,
      // then takes its share of what is left in its row (as in Figma).
      const claim = children.map((c, i) => {
        const it = items[i]!;
        if (it.grow === 0) return clamp(it.base, it.min, it.max);
        return this.doc.get(c, 'minWidth') ? it.min : clamp(Math.max(this.intrinsicWidth(c) + this.strokeExtra(c, 'H'), it.min), it.min, it.max);
      });
      let lineWidth = 0;
      children.forEach((_, i) => {
        const w = claim[i] ?? 0;
        const line = lines[lines.length - 1]!;
        if (line.length > 0 && lineWidth + gap + w > innerW + EPS) {
          lines.push([i]);
          lineWidth = w;
        } else {
          lineWidth += (line.length > 0 ? gap : 0) + w;
          line.push(i);
        }
      });
      widths = [...claim];
      for (const line of lines) {
        const lineItems = line.map((i) => items[i]!);
        if (!lineItems.some((it) => it.grow > 0)) continue;
        const fixed = lineItems.reduce((s, it) => s + (it.grow > 0 ? 0 : clamp(it.base, it.min, it.max)), 0);
        const sizes = distribute(lineItems, innerW - fixed - this.fixedGaps(id, line.length));
        line.forEach((i, k) => (widths[i] = sizes[k] ?? 0));
      }
    } else {
      const free = innerW - items.reduce((s, it) => s + (it.grow > 0 ? 0 : clamp(it.base, it.min, it.max)), 0) - this.fixedGaps(id, children.length);
      widths = distribute(items, free);
      lines[0] = children.map((_, i) => i);
    }

    // 3. Heights (counter axis). FILL children stretch to the line, or to the frame when not wrapping.
    const hugHeights = children.map((c, i) => (this.doc.get(c, 'rotation') !== 0 ? this.fixedSize(c, 'V') : this.heightFor(c, (widths[i] ?? 0) - this.strokeExtra(c, 'H'))));
    const heights = children.map((c, i) =>
      this.counterSize(c, this.sizing(c, 'V'), 'V', null, () => hugHeights[i] ?? 0),
    );
    const baseline = this.doc.get(id, 'counterAlign') === 'BASELINE';
    // Text baselines line up: a row is as tall as the most room above a baseline plus the most below.
    const baselines = baseline ? children.map((c, i) => this.baselineOf(c, widths[i] ?? 0, heights[i] ?? 0)) : [];
    const lineHeights = lines.map((line) => {
      if (baseline) {
        const above = Math.max(0, ...line.map((i) => baselines[i] ?? 0));
        const below = Math.max(0, ...line.map((i) => (heights[i] ?? 0) - (baselines[i] ?? 0)));
        return above + below;
      }
      return Math.max(0, ...line.map((i) => {
        const mode = this.sizing(children[i]!, 'V').mode;
        return mode === 'FILL' || mode === 'FR' ? (hugHeights[i] ?? 0) + this.strokeExtra(children[i]!, 'V') : heights[i] ?? 0;
      }));
    });
    const rowGap = this.doc.get(id, 'counterAxisSpacing');
    const contentH = lineHeights.reduce((s, h) => s + h, 0) + rowGap * Math.max(0, lines.length - 1);
    const finalH = height ?? contentH + pad.top + pad.bottom;
    const innerH = innerHKnown ?? contentH;

    if (!baseline) {
      children.forEach((c, i) => {
        const sizing = this.sizing(c, 'V');
        const lineIndex = lines.findIndex((l) => l.includes(i));
        const available = lines.length > 1 ? lineHeights[lineIndex] ?? 0 : innerH;
        heights[i] = this.counterSize(c, sizing, 'V', available, () => hugHeights[i] ?? 0);
      });
    }

    // 4. Positions. Wrapped rows move together by the counter alignment when the frame is taller (as in Figma),
    // or spread to its edges when the gap between rows is "auto".
    let lineTop = pad.top;
    let lineGap = rowGap;
    if (wrap && lines.length > 1 && innerHKnown !== null) {
      if (this.doc.get(id, 'counterAxisAlignContent') === 'SPACE_BETWEEN') lineGap += Math.max(0, innerHKnown - contentH) / (lines.length - 1);
      else if (!baseline) lineTop += Math.max(0, this.counterOffset(id, innerHKnown, contentH));
    }
    lines.forEach((line, li) => {
      const used = line.reduce((s, i) => s + (widths[i] ?? 0), 0);
      const { start, gap: between } = this.spacing(id, innerW, used, line.length);
      const lineH = lines.length > 1 ? lineHeights[li] ?? 0 : innerH;
      const above = baseline ? Math.max(0, ...line.map((i) => baselines[i] ?? 0)) : 0;
      let x = pad.left + start;
      for (const i of line) {
        const child = children[i]!;
        const w = widths[i] ?? 0;
        const h = heights[i] ?? 0;
        const y = lineTop + (baseline ? above - (baselines[i] ?? 0) : this.counterOffset(id, lineH, h));
        this.place(child, { x, y, width: w, height: h });
        x += w + between;
      }
      lineTop += lineH + lineGap;
    });
    return finalH;
  }

  /**
   * Distance from a layer's top to the baseline of its first line of text, at
   * the given size: a text's own, a frame's first text inside (as CSS does);
   * a layer without text sits on its bottom edge.
   */
  baselineOf(id: NodeId, width: number, height: number): number {
    const type = this.doc.type(id);
    if (type === 'TEXT') {
      const ex = this.strokeExtra(id, 'H');
      const m = this.measureText(id, this.doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT' ? null : Math.max(0, width - ex));
      const first = m.layout.lines[0];
      if (!first) return height;
      const alignV = this.doc.get(id, 'textAlignV');
      const room = height - this.strokeExtra(id, 'V') - m.height;
      const shift = this.doc.get(id, 'textAutoResize') !== 'NONE' ? 0 : alignV === 'CENTER' ? room / 2 : alignV === 'BOTTOM' ? room : 0;
      return first.y + first.baseline + shift + this.outerStroke(id)[0];
    }
    if (this.isAutoLayout(id) && this.doc.get(id, 'layoutMode') !== 'GRID' && this.doc.get(id, 'rotation') === 0) {
      // Lay the frame out at this size into a scratch engine and look at its first layer.
      const w = Math.max(0, width - this.strokeExtra(id, 'H'));
      const h = Math.max(0, height - this.strokeExtra(id, 'V'));
      const scratch = new LayoutEngine(this.doc, this.measurer);
      scratch.arrange(id, w, h);
      for (const child of this.flowChildren(id)) {
        const b = scratch.boxes.get(child);
        if (!b) continue;
        return b.y + scratch.baselineOf(child, b.width, b.height) + this.outerStroke(id)[0];
      }
    }
    return height;
  }

  private arrangeVertical(id: NodeId, width: number, height: number | null): number {
    const pad = this.padding(id);
    const innerW = Math.max(0, width - pad.left - pad.right);
    const innerH = height === null ? null : Math.max(0, height - pad.top - pad.bottom);
    const children = this.flowChildren(id);

    // 1. Widths (counter axis).
    const widths = children.map((c) => this.counterSize(c, this.sizing(c, 'H'), 'H', innerW, () => this.intrinsicWidth(c)));

    // 2. Heights (main axis).
    const items = children.map((c, i) => this.mainItem(c, this.sizing(c, 'V'), 'V', innerH, () => this.heightFor(c, (widths[i] ?? 0) - this.strokeExtra(c, 'H'))));
    const fixedTotal = items.reduce((s, it) => s + (it.grow > 0 ? 0 : clamp(it.base, it.min, it.max)), 0);
    // Hugging its content, a frame with "auto" spacing keeps the gap it has (it has no free room to share).
    const gaps = innerH === null ? this.doc.get(id, 'itemSpacing') * Math.max(0, children.length - 1) : this.fixedGaps(id, children.length);
    const heights = innerH === null ? items.map((it) => clamp(it.base, it.min, it.max)) : distribute(items, innerH - fixedTotal - gaps);
    const used = heights.reduce((s, h) => s + h, 0);
    const finalH = height ?? used + gaps + pad.top + pad.bottom;
    const inner = innerH ?? used + gaps;

    // 3. Positions.
    const { start, gap } = this.spacing(id, inner, used, children.length);
    let y = pad.top + start;
    children.forEach((child, i) => {
      const w = widths[i] ?? 0;
      const h = heights[i] ?? 0;
      const x = pad.left + this.counterOffset(id, innerW, w);
      this.place(child, { x, y, width: w, height: h });
      y += h + gap;
    });
    return finalH;
  }

  // ---------- grid ----------

  /** Width a layer asks of its column (its own width, or its content's when it fills). */
  private gridWantWidth(child: NodeId): number {
    const sizing = this.sizing(child, 'H');
    return (sizing.mode === 'FIXED' ? this.fixedSize(child, 'H') + this.strokeExtra(child, 'H') : this.hugWidthOfChild(child));
  }

  /** Column sizes of a grid frame; `innerW` null — the frame hugs its content. Total width with padding too. */
  private gridColumns(id: NodeId, innerW: number | null): { sizes: number[]; width: number; placement: ReturnType<typeof placeInGrid> } {
    const children = this.flowChildren(id);
    const placement = placeInGrid(this.doc, id, children);
    const gap = this.doc.get(id, 'gridColumnGap');
    const items = children.map((c) => {
      const cell = placement.cells.get(c)!;
      return { start: cell.column, span: cell.columnSpan, size: this.gridWantWidth(c), min: this.minContribution(c) };
    });
    const sizes = gridTrackSizes(this.doc.get(id, 'gridColumns'), placement.columns, innerW, gap, items);
    const pad = this.padding(id);
    const width = pad.left + pad.right + sizes.reduce((s, v) => s + v, 0) + gap * Math.max(0, sizes.length - 1);
    return { sizes, width, placement };
  }

  private arrangeGrid(id: NodeId, width: number, height: number | null): number {
    const pad = this.padding(id);
    const innerW = Math.max(0, width - pad.left - pad.right);
    const innerH = height === null ? null : Math.max(0, height - pad.top - pad.bottom);
    const children = this.flowChildren(id);
    const colGap = this.doc.get(id, 'gridColumnGap');
    const rowGap = this.doc.get(id, 'gridRowGap');
    const { sizes: cols, placement } = this.gridColumns(id, innerW);
    const starts = (sizes: number[], from: number, gap: number) => {
      const out: number[] = [];
      let at = from;
      for (const v of sizes) {
        out.push(at);
        at += v + gap;
      }
      return out;
    };
    const colStarts = starts(cols, pad.left, colGap);
    const span = (sizes: number[], first: number, n: number, gap: number) => sizes.slice(first, first + n).reduce((s, v) => s + v, 0) + gap * Math.max(0, Math.min(n, sizes.length - first) - 1);

    // 1. Widths: filling layers take their cell, others keep their own or their content's.
    const widths = children.map((c) => {
      const cell = placement.cells.get(c)!;
      const room = span(cols, cell.column, cell.columnSpan, colGap);
      const sizing = this.sizing(c, 'H');
      const min = resolveLength(this.doc.get(c, 'minWidth'), room) ?? 0;
      const max = resolveLength(this.doc.get(c, 'maxWidth'), room) ?? Infinity;
      const ex = this.strokeExtra(c, 'H');
      if (sizing.mode === 'FILL' || sizing.mode === 'FR') return clamp(room - ex, min, max) + ex;
      if (sizing.mode === 'PERCENT') return clamp((sizing.value / 100) * room, min, max) + ex;
      if (sizing.mode === 'HUG') return clamp(this.intrinsicWidth(c), min, max) + ex;
      return this.fixedSize(c, 'H') + ex;
    });

    // 2. Rows from the heights the layers have at those widths.
    const hug = children.map((c, i) => {
      const mode = this.sizing(c, 'V').mode;
      if (mode === 'FIXED') return this.fixedSize(c, 'V') + this.strokeExtra(c, 'V');
      const w = (widths[i] ?? 0) - this.strokeExtra(c, 'H');
      // A filling auto layout counts with its content, as a stretched item of a CSS grid: the row
      // grows (and shrinks) to it, then it fills the row (FEAT-167: a table cell's text grows its row;
      // with its own height the row kept whatever height it had once).
      const stretched = (mode === 'FILL' || mode === 'FR') && this.isAutoLayout(c);
      const h = this.doc.get(c, 'rotation') !== 0 ? this.fixedSize(c, 'V') : stretched ? this.arrange(c, w, null) : this.heightFor(c, w);
      // Its least and greatest heights count for the row too (FEAT-170: a table row dragged higher than its texts).
      const min = resolveLength(this.doc.get(c, 'minHeight'), null) ?? 0;
      const max = resolveLength(this.doc.get(c, 'maxHeight'), null) ?? Infinity;
      return clamp(h, min, max) + this.strokeExtra(c, 'V');
    });
    const items = children.map((c, i) => {
      const cell = placement.cells.get(c)!;
      return { start: cell.row, span: cell.rowSpan, size: hug[i] ?? 0 };
    });
    const rows = gridTrackSizes(this.doc.get(id, 'gridRows'), placement.rows, innerH, rowGap, items);
    const rowStarts = starts(rows, pad.top, rowGap);

    // 3. Heights and places in the cells.
    children.forEach((c, i) => {
      const cell = placement.cells.get(c)!;
      const roomW = span(cols, cell.column, cell.columnSpan, colGap);
      const roomH = span(rows, cell.row, cell.rowSpan, rowGap);
      const sizing = this.sizing(c, 'V');
      const ex = this.strokeExtra(c, 'V');
      const min = resolveLength(this.doc.get(c, 'minHeight'), roomH) ?? 0;
      const max = resolveLength(this.doc.get(c, 'maxHeight'), roomH) ?? Infinity;
      let h: number;
      if (sizing.mode === 'FILL' || sizing.mode === 'FR') h = clamp(roomH - ex, min, max) + ex;
      else if (sizing.mode === 'PERCENT') h = clamp((sizing.value / 100) * roomH, min, max) + ex;
      else h = clamp((hug[i] ?? 0) - ex, min, max) + ex;
      const w = widths[i] ?? 0;
      const offset = (align: string, room: number, size: number) => (align === 'CENTER' ? (room - size) / 2 : align === 'MAX' ? room - size : 0);
      const x = (colStarts[cell.column] ?? pad.left) + offset(this.doc.get(c, 'gridAlignH'), roomW, w);
      const y = (rowStarts[cell.row] ?? pad.top) + offset(this.doc.get(c, 'gridAlignV'), roomH, h);
      this.place(c, { x, y, width: w, height: h });
    });
    this.grids.set(id, {
      columns: cols.map((size, i) => ({ start: colStarts[i]!, size })),
      rows: rows.map((size, i) => ({ start: rowStarts[i]!, size })),
      cells: placement.cells,
    });
    return height ?? pad.top + pad.bottom + rows.reduce((s, v) => s + v, 0) + rowGap * Math.max(0, rows.length - 1);
  }

  /** Records a child's box and lays out its own children if it is an auto layout frame. */
  private place(child: NodeId, box: Box): void {
    const [st, sr, sb, sl] = this.outerStroke(child);
    if (st || sr || sb || sl) box = { x: box.x + sl, y: box.y + st, width: Math.max(0, box.width - sl - sr), height: Math.max(0, box.height - st - sb) };
    if (this.doc.get(child, 'rotation') !== 0) {
      // The slot is the rotated bounding box: put the origin where the rotated shape fills it.
      const f = this.footprint(child);
      box = { x: box.x + f.dx, y: box.y + f.dy, width: this.doc.get(child, 'width'), height: this.doc.get(child, 'height') };
    }
    this.boxes.set(child, box);
    if (this.isAutoLayout(child)) this.arrange(child, box.width, box.height);
  }
}
