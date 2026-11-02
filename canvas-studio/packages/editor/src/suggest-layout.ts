// «Suggest auto layout», as in Figma — without a language model (decision of
// 12 October 2026): a frame and the frames inside it get auto layout from how
// their layers stand. Layers in one line across the stack become a row (or a
// column) of their own; a layer under all the others (a background) stays where
// it is, out of the flow; the frame keeps its size, so the design hardly moves.
// A frame whose layers overlap in a way no stack can hold is left as it was.

import { tr, type CounterAlign, type NodeId, type Transaction } from '#core';
import type { Rect } from '#geometry';
import type { Editor } from './editor.ts';

type Dir = 'HORIZONTAL' | 'VERTICAL';

interface Leaf {
  id: NodeId;
  box: Rect;
}

/** One place in a stack: a layer, or a new row/column frame holding several. */
interface Slot {
  leaf: Leaf | null;
  box: Rect;
  inner: Arrangement | null;
}

interface Arrangement {
  dir: Dir;
  slots: Slot[];
  /** Layers kept where they are, out of the flow (a background under the others). */
  absolute: NodeId[];
}

export interface SuggestPlan {
  /** Frames that get auto layout, with how. */
  frames: { id: NodeId; arrangement: Arrangement }[];
  /** New row and column frames. */
  wrappers: number;
}

/** A layer's box in its parent's space (a turned layer: the box around its corners). */
function localBox(editor: Editor, id: NodeId): Rect {
  const d = editor.doc;
  const x = d.get(id, 'x');
  const y = d.get(id, 'y');
  const w = d.get(id, 'width');
  const h = d.get(id, 'height');
  const angle = (d.get(id, 'rotation') * Math.PI) / 180;
  if (angle === 0) return { x, y, width: w, height: h };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const xs = [0, w * cos, w * cos - h * sin, -h * sin].map((v) => x + v);
  const ys = [0, w * sin, w * sin + h * cos, h * cos].map((v) => y + v);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function union(boxes: readonly Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

const start = (b: Rect, axis: 'x' | 'y') => (axis === 'x' ? b.x : b.y);
const size = (b: Rect, axis: 'x' | 'y') => (axis === 'x' ? b.width : b.height);

/** Layers in bands along an axis: a band is a run of layers whose extents overlap there. */
function bands(items: readonly Leaf[], axis: 'x' | 'y'): Leaf[][] {
  const sorted = [...items].sort((a, b) => start(a.box, axis) - start(b.box, axis));
  const out: Leaf[][] = [];
  let end = -Infinity;
  for (const item of sorted) {
    const s = start(item.box, axis);
    const e = s + size(item.box, axis);
    // Touching is not overlapping: half a pixel of slack.
    if (out.length && s < end - 0.5) {
      out[out.length - 1]!.push(item);
      end = Math.max(end, e);
    } else {
      out.push([item]);
      end = e;
    }
  }
  return out;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

/** How layers can stand in stacks; null — they overlap in a way no stack holds. */
function arrange(items: readonly Leaf[], depth = 0): Arrangement | null {
  if (items.length === 0 || depth > 8) return null;
  if (items.length === 1) return { dir: 'VERTICAL', slots: [{ leaf: items[0]!, box: items[0]!.box, inner: null }], absolute: [] };
  const rows = bands(items, 'y');
  const cols = bands(items, 'x');
  if (rows.length === 1 && cols.length === 1) {
    // A background: the largest layer, holding all the others.
    const bg = [...items].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]!;
    if (!items.every((i) => i === bg || contains(bg.box, i.box))) return null;
    const rest = arrange(items.filter((i) => i !== bg), depth + 1);
    if (!rest) return null;
    return { ...rest, absolute: [bg.id, ...rest.absolute] };
  }
  const all = union(items.map((i) => i.box));
  const vertical = rows.length > cols.length || (rows.length === cols.length && all.height >= all.width);
  const chosen = vertical ? rows : cols;
  const slots: Slot[] = [];
  for (const band of chosen) {
    if (band.length === 1) {
      slots.push({ leaf: band[0]!, box: band[0]!.box, inner: null });
      continue;
    }
    const inner = arrange(band, depth + 1);
    if (!inner) return null;
    slots.push({ leaf: null, box: union(band.map((l) => l.box)), inner });
  }
  return { dir: vertical ? 'VERTICAL' : 'HORIZONTAL', slots, absolute: [] };
}

/** Frames this works on: plain frames and components, not instances. */
function plainFrame(editor: Editor, id: NodeId): boolean {
  const d = editor.doc;
  const type = d.type(id);
  return (type === 'FRAME' || type === 'COMPONENT') && !editor.isInstanceLayer(id);
}

/** What «Suggest auto layout» would do to the selected frames and the frames inside them. */
export function planSuggest(editor: Editor, roots: readonly NodeId[]): SuggestPlan {
  const d = editor.doc;
  const plan: SuggestPlan = { frames: [], wrappers: 0 };
  const countWrappers = (a: Arrangement): number => a.slots.reduce((n, s) => n + (s.inner ? 1 + countWrappers(s.inner) : 0), 0);
  const visit = (id: NodeId) => {
    if (!plainFrame(editor, id)) return;
    const kids = d.children(id);
    for (const c of kids) visit(c);
    if (d.get(id, 'layoutMode') !== 'NONE') return;
    const shown = kids.filter((c) => d.get(c, 'visible'));
    const arrangement = arrange(shown.map((c) => ({ id: c, box: localBox(editor, c) })));
    if (!arrangement) return;
    // Hidden layers take no room in a stack: they stay where they are.
    arrangement.absolute.push(...kids.filter((c) => !d.get(c, 'visible')));
    plan.frames.push({ id, arrangement });
    plan.wrappers += countWrappers(arrangement);
  };
  for (const id of roots) visit(id);
  return plan;
}

/** The lower median of the gaps between neighbours along the stack. */
function gapOf(slots: readonly Slot[], dir: Dir): number {
  const axis = dir === 'HORIZONTAL' ? 'x' : 'y';
  const gaps: number[] = [];
  for (let i = 1; i < slots.length; i++) gaps.push(start(slots[i]!.box, axis) - (start(slots[i - 1]!.box, axis) + size(slots[i - 1]!.box, axis)));
  gaps.sort((a, b) => a - b);
  return Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)] ?? 0));
}

/** Across the stack: the layers line up by their starts, centres or ends — whichever is closest. */
function alignOf(slots: readonly Slot[], dir: Dir, inner: Rect): CounterAlign {
  const axis = dir === 'HORIZONTAL' ? 'y' : 'x';
  const a = start(inner, axis);
  const b = a + size(inner, axis);
  const off = (f: (s: Slot) => number) => slots.reduce((sum, s) => sum + Math.abs(f(s)), 0);
  const min = off((s) => start(s.box, axis) - a);
  const mid = off((s) => start(s.box, axis) + size(s.box, axis) / 2 - (a + b) / 2);
  const max = off((s) => start(s.box, axis) + size(s.box, axis) - b);
  return mid < min - 0.5 && mid <= max ? 'CENTER' : max < min - 0.5 ? 'MAX' : 'MIN';
}

/** Lays one arrangement into `frame` (its layers already there or moved in by `place`). */
function lay(editor: Editor, tx: Transaction, frame: NodeId, a: Arrangement, room: Rect, fixed: boolean, shift: { x: number; y: number }): void {
  const d = editor.doc;
  const axis = a.dir === 'HORIZONTAL' ? 'x' : 'y';
  const slots = [...a.slots].sort((p, q) => start(p.box, axis) - start(q.box, axis));
  const content = union(slots.map((s) => s.box));
  const padding = fixed
    ? {
        paddingLeft: Math.max(0, Math.round(content.x - room.x)),
        paddingTop: Math.max(0, Math.round(content.y - room.y)),
        paddingRight: Math.max(0, Math.round(room.x + room.width - (content.x + content.width))),
        paddingBottom: Math.max(0, Math.round(room.y + room.height - (content.y + content.height))),
      }
    : { paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0 };
  tx.update(frame, {
    layoutMode: a.dir,
    itemSpacing: gapOf(slots, a.dir),
    primaryAlign: 'MIN',
    counterAlign: alignOf(slots, a.dir, content),
    ...padding,
    sizingH: { mode: fixed ? 'FIXED' : 'HUG' },
    sizingV: { mode: fixed ? 'FIXED' : 'HUG' },
  });
  // Out of the flow first (under the rest), then the stack in reading order.
  let index = 0;
  for (const id of a.absolute) {
    tx.move(id, frame, { index: index++ });
    tx.update(id, { positioning: 'ABSOLUTE', x: d.get(id, 'x') - shift.x, y: d.get(id, 'y') - shift.y });
  }
  for (const slot of slots) {
    if (slot.leaf) {
      const id = slot.leaf.id;
      tx.move(id, frame, { index: index++ });
      if (shift.x !== 0 || shift.y !== 0) tx.update(id, { x: d.get(id, 'x') - shift.x, y: d.get(id, 'y') - shift.y });
      continue;
    }
    const box = slot.box;
    const wrapper = tx.create('FRAME', frame, {
      name: slot.inner!.dir === 'HORIZONTAL' ? tr('Ряд') : tr('Столбец'),
      x: box.x - shift.x,
      y: box.y - shift.y,
      width: box.width,
      height: box.height,
      fills: [],
      clipsContent: false,
    });
    tx.move(wrapper, frame, { index: index++ });
    // The wrapper's layers are in the frame's space: shifted by the wrapper's place.
    lay(editor, tx, wrapper, slot.inner!, box, false, { x: box.x, y: box.y });
  }
}

/** Applies the plan, one step to undo. */
export function applySuggest(editor: Editor, plan: SuggestPlan): void {
  if (plan.frames.length === 0) return;
  editor.commit(tr('Предложить адаптивную раскладку'), (tx) => {
    for (const { id, arrangement } of plan.frames) {
      const d = editor.doc;
      lay(editor, tx, id, arrangement, { x: 0, y: 0, width: d.get(id, 'width'), height: d.get(id, 'height') }, true, { x: 0, y: 0 });
    }
  });
}

/** The command: the selected frames (or the frames on the page) and everything inside. */
export function suggestAutoLayout(editor: Editor): void {
  const roots = editor.topLevelSelection();
  const plan = planSuggest(editor, roots.length ? roots : editor.doc.children(editor.pageId));
  if (plan.frames.length === 0) {
    editor.toast(roots.length ? tr('Не нашлось фреймов, где слои можно выстроить рядами и столбцами') : tr('Выделите фрейм — раскладка подберётся для него и всего внутри'));
    return;
  }
  applySuggest(editor, plan);
  editor.toast(plan.wrappers > 0 ? tr('Адаптивная раскладка: фреймов — {0}, новых рядов и столбцов — {1}', plan.frames.length, plan.wrappers) : tr('Адаптивная раскладка: фреймов — {0}', plan.frames.length));
}
