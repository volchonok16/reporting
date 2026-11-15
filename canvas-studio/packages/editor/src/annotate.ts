// Dev Mode annotations and saved measurements (step 7 of the roadmap, as Figma's Dev Mode).
//
// An annotation is a note on a layer: words for developers and the layer's CSS properties pinned
// to it, whose values are read from the layer each time (the same CSS the «Код» tab shows, so a
// card never says one thing and the code another). A saved measurement runs between edges of two
// layers (or two edges of one) and is recounted as they move or resize. Both live in the file
// (`annotations` on the layer, `measurements` on the page), both are drawn over the canvas, never
// exported. Shift+T — the tool: a click on a layer adds a note, a drag from an edge to another
// edge keeps a measurement. Shift+Y shows or hides them all.

import { tr, type Annotation, type AnnotationCategory, type MeasureSide, type NodeId, type SavedMeasurement } from '#core';
import type { Point, Rect } from '#geometry';
import { cssDecls, DEFAULT_CODE_OPTIONS, type CodeOptions } from './dev-code.ts';
import type { Editor } from './editor.ts';
import { isDark } from './theme.ts';

export const ANNOTATION_CATEGORIES: readonly { id: AnnotationCategory; label: string }[] = [
  { id: 'NONE', label: tr('Без категории') },
  { id: 'DEVELOPMENT', label: tr('Разработка') },
  { id: 'INTERACTION', label: tr('Взаимодействие') },
  { id: 'ACCESSIBILITY', label: tr('Доступность') },
  { id: 'CONTENT', label: tr('Контент') },
];

/** Colours of a category: on a light card and on a dark one (each readable as small text: AA on its card). */
const CATEGORY_COLORS: Record<AnnotationCategory, [string, string]> = {
  NONE: ['#5E5E5E', '#BDBDBD'],
  DEVELOPMENT: ['#0A6DC2', '#5AB4FF'],
  INTERACTION: ['#7C3AED', '#B79BFF'],
  ACCESSIBILITY: ['#0F7A41', '#4CD38A'],
  CONTENT: ['#A85400', '#FFA552'],
};

export function categoryColor(category: AnnotationCategory, dark = isDark()): string {
  const pair = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.NONE;
  return dark ? pair[1] : pair[0];
}

export function categoryLabel(category: AnnotationCategory): string {
  return ANNOTATION_CATEGORIES.find((c) => c.id === category)?.label ?? ANNOTATION_CATEGORIES[0]!.label;
}

/** Saved measurements: teal, apart from the red of Alt measurements and the pink of equal gaps. */
export const SAVED_MEASURE_COLOR = '#0E7C86';

/** A file may hold anything: a category the editor does not know reads as none. */
export function safeCategory(v: unknown): AnnotationCategory {
  return ANNOTATION_CATEGORIES.some((c) => c.id === v) ? (v as AnnotationCategory) : 'NONE';
}

/** The annotations of a layer, each made whole (a hand-written file may leave fields out). */
export function annotationsOf(editor: Editor, id: NodeId): Annotation[] {
  const raw = editor.doc.get(id, 'annotations');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Annotation => typeof a === 'object' && a !== null)
    .map((a) => ({
      label: typeof a.label === 'string' ? a.label : '',
      properties: Array.isArray(a.properties) ? a.properties.filter((p): p is string => typeof p === 'string') : [],
      category: safeCategory(a.category),
    }));
}

/** The CSS a layer has now, property → value (the units of the «Код» tab). */
export function layerCss(editor: Editor, id: NodeId, o: CodeOptions = DEFAULT_CODE_OPTIONS): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of cssDecls(editor.doc, id, o).decls) if (!out.has(decl.prop)) out.set(decl.prop, decl.value);
  return out;
}

// ---------- measurements ----------

const AXIS: Record<MeasureSide, 'x' | 'y'> = { LEFT: 'x', RIGHT: 'x', TOP: 'y', BOTTOM: 'y' };
const SIDES: readonly MeasureSide[] = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'];

export function isSide(v: unknown): v is MeasureSide {
  return typeof v === 'string' && (SIDES as readonly string[]).includes(v);
}

/** Where an edge of a box is along its axis. */
export function edgeAt(r: Rect, side: MeasureSide): number {
  switch (side) {
    case 'LEFT':
      return r.x;
    case 'RIGHT':
      return r.x + r.width;
    case 'TOP':
      return r.y;
    case 'BOTTOM':
      return r.y + r.height;
  }
}

export interface MeasureLine {
  from: Point;
  to: Point;
  value: number;
  /** Dashed lines bringing the far box's edge to the line when the boxes do not face each other. */
  helpers: { from: Point; to: Point }[];
}

/**
 * The line of a measurement between an edge of box `a` and a parallel edge of box `b`: across
 * the part of the boxes that faces each other (its middle), else level with `a`, the far edge
 * brought to it by a dashed line. Edges of different axes do not measure (null).
 */
export function measureLine(a: Rect, aSide: MeasureSide, b: Rect, bSide: MeasureSide): MeasureLine | null {
  const axis = AXIS[aSide];
  if (axis !== AXIS[bSide]) return null;
  const p1 = edgeAt(a, aSide);
  const p2 = edgeAt(b, bSide);
  // The other axis: the span both boxes share, if any.
  const [aLo, aHi] = axis === 'x' ? [a.y, a.y + a.height] : [a.x, a.x + a.width];
  const [bLo, bHi] = axis === 'x' ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
  const lo = Math.max(aLo, bLo);
  const hi = Math.min(aHi, bHi);
  const helpers: { from: Point; to: Point }[] = [];
  let at: number;
  if (hi >= lo) at = (lo + hi) / 2;
  else {
    at = (aLo + aHi) / 2;
    const near = at < bLo ? bLo : bHi;
    helpers.push(axis === 'x' ? { from: { x: p2, y: near }, to: { x: p2, y: at } } : { from: { x: near, y: p2 }, to: { x: at, y: p2 } });
  }
  const from = axis === 'x' ? { x: p1, y: at } : { x: at, y: p1 };
  const to = axis === 'x' ? { x: p2, y: at } : { x: at, y: p2 };
  return { from, to, value: Math.abs(p2 - p1), helpers };
}

/** A layer and its ancestors are all visible (a hidden layer's measurements and notes are not drawn). */
function shown(editor: Editor, id: NodeId): boolean {
  const d = editor.doc;
  let current: NodeId | null = id;
  while (current !== null && d.type(current) !== 'PAGE') {
    if (!d.store.isAlive(current) || !d.get(current, 'visible')) return false;
    current = d.parent(current);
  }
  return current !== null;
}

/** The measurements of the page that can be drawn now (both layers alive, shown, on this page). */
export function liveMeasurements(editor: Editor): { m: SavedMeasurement; line: MeasureLine }[] {
  const d = editor.doc;
  const raw = d.get(editor.pageId, 'measurements');
  if (!Array.isArray(raw)) return [];
  const out: { m: SavedMeasurement; line: MeasureLine }[] = [];
  for (const m of raw) {
    if (typeof m !== 'object' || m === null || typeof m.id !== 'string' || typeof m.from !== 'string' || typeof m.to !== 'string') continue;
    if (!isSide(m.fromSide) || !isSide(m.toSide)) continue;
    if (!d.store.isAlive(m.from) || !d.store.isAlive(m.to) || d.pageOf(m.from) !== editor.pageId || d.pageOf(m.to) !== editor.pageId) continue;
    if (!shown(editor, m.from) || !shown(editor, m.to)) continue;
    const line = measureLine(editor.scene.bounds(m.from), m.fromSide, editor.scene.bounds(m.to), m.toSide);
    if (line) out.push({ m: { ...m, note: typeof m.note === 'string' ? m.note : '' }, line });
  }
  return out;
}

export const fmtNumber = (v: number): string => String(Math.round(v * 100) / 100).replace('.', ',');

export function measureText(m: SavedMeasurement, value: number): string {
  const note = m.note.trim();
  return note ? `${fmtNumber(value)} · ${note}` : fmtNumber(value);
}

/** Adds a measurement to the page (one undo step); the same one twice is not kept. */
export function addMeasurement(editor: Editor, from: NodeId, fromSide: MeasureSide, to: NodeId, toSide: MeasureSide): string | null {
  if (editor.doc.readOnly) return null;
  if (from === to && fromSide === toSide) return null;
  if (AXIS[fromSide] !== AXIS[toSide]) return null;
  const page = editor.pageId;
  const list = editor.doc.get(page, 'measurements');
  const same = (m: SavedMeasurement) => (m.from === from && m.fromSide === fromSide && m.to === to && m.toSide === toSide) || (m.from === to && m.fromSide === toSide && m.to === from && m.toSide === fromSide);
  const existing = list.find(same);
  if (existing) return existing.id;
  const id = editor.doc.ids.next();
  editor.commit(tr('Сохранить замер'), (tx) => tx.set(page, 'measurements', [...list, { id, from, fromSide, to, toSide, note: '' }]));
  return id;
}

export function setMeasurementNote(editor: Editor, id: string, note: string): void {
  const page = editor.pageId;
  const list = editor.doc.get(page, 'measurements');
  const m = list.find((x) => x.id === id);
  if (!m || m.note === note || editor.doc.readOnly) return;
  editor.commit(tr('Подпись замера'), (tx) => tx.set(page, 'measurements', list.map((x) => (x.id === id ? { ...x, note } : x))));
}

export function removeMeasurements(editor: Editor, ids: readonly string[]): void {
  const page = editor.pageId;
  const list = editor.doc.get(page, 'measurements');
  const next = list.filter((m) => !ids.includes(m.id));
  if (next.length === list.length || editor.doc.readOnly) return;
  editor.commit(ids.length > 1 ? tr('Удалить замеры') : tr('Удалить замер'), (tx) => tx.set(page, 'measurements', next));
}

/**
 * Which edges to measure between two boxes: the gap where they stand apart (both gaps when apart
 * on both axes), the left and top insets when they overlap (a layer inside a frame).
 */
export function gapSides(a: Rect, b: Rect): [MeasureSide, MeasureSide][] {
  const out: [MeasureSide, MeasureSide][] = [];
  if (a.x + a.width <= b.x) out.push(['RIGHT', 'LEFT']);
  else if (b.x + b.width <= a.x) out.push(['LEFT', 'RIGHT']);
  if (a.y + a.height <= b.y) out.push(['BOTTOM', 'TOP']);
  else if (b.y + b.height <= a.y) out.push(['TOP', 'BOTTOM']);
  if (out.length === 0) out.push(['LEFT', 'LEFT'], ['TOP', 'TOP']);
  return out;
}

/** «Сохранить замер»: between the two selected layers (one layer — its width and height). */
export function measureSelection(editor: Editor): void {
  const ids = editor.topLevelSelection();
  if (editor.doc.readOnly) return;
  if (ids.length === 0 || ids.length > 2) {
    editor.toast(tr('Выделите два слоя (или один, чтобы сохранить его ширину и высоту)'));
    return;
  }
  const page = editor.pageId;
  const list = editor.doc.get(page, 'measurements');
  const pairs: [NodeId, MeasureSide, NodeId, MeasureSide][] = [];
  if (ids.length === 1) {
    pairs.push([ids[0]!, 'LEFT', ids[0]!, 'RIGHT'], [ids[0]!, 'TOP', ids[0]!, 'BOTTOM']);
  } else {
    const [a, b] = [ids[0]!, ids[1]!];
    for (const [sa, sb] of gapSides(editor.scene.bounds(a), editor.scene.bounds(b))) pairs.push([a, sa, b, sb]);
  }
  const added = pairs
    .filter(([f, fs, t, ts]) => !list.some((m) => (m.from === f && m.fromSide === fs && m.to === t && m.toSide === ts) || (m.from === t && m.fromSide === ts && m.to === f && m.toSide === fs)))
    .map(([from, fromSide, to, toSide]) => ({ id: editor.doc.ids.next(), from, fromSide, to, toSide, note: '' }));
  if (added.length === 0) {
    editor.toast(tr('Такой замер уже сохранён'));
    return;
  }
  editor.commit(added.length > 1 ? tr('Сохранить замеры') : tr('Сохранить замер'), (tx) => tx.set(page, 'measurements', [...list, ...added]));
  if (!editor.view.annotations) editor.setView({ annotations: true });
}

// ---------- annotations ----------

/** Adds an empty note to a layer; its index. */
export function addAnnotation(editor: Editor, id: NodeId, category: AnnotationCategory = 'NONE'): number {
  const list = annotationsOf(editor, id);
  editor.commit(tr('Добавить аннотацию'), (tx) => tx.set(id, 'annotations', [...list, { label: '', properties: [], category }]));
  return list.length;
}

export function updateAnnotation(editor: Editor, id: NodeId, index: number, patch: Partial<Annotation>, label = tr('Изменить аннотацию')): void {
  const list = annotationsOf(editor, id);
  const current = list[index];
  if (!current || editor.doc.readOnly) return;
  const next = { ...current, ...patch };
  if (next.label === current.label && next.category === current.category && next.properties.join('\n') === current.properties.join('\n')) return;
  editor.commit(label, (tx) => tx.set(id, 'annotations', list.map((a, i) => (i === index ? next : a))));
}

export function removeAnnotation(editor: Editor, id: NodeId, index: number): void {
  const list = annotationsOf(editor, id);
  if (!list[index] || editor.doc.readOnly) return;
  editor.commit(tr('Удалить аннотацию'), (tx) => tx.set(id, 'annotations', list.filter((_, i) => i !== index)));
}

// ---------- drawing ----------

const CARD_MAX = 240;
const CARD_PAD = 8;
const GAP = 12;
const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_SMALL = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_MONO = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const MAX_LINES = 8;

/** Words broken into lines no wider than `width` (a long word is cut where it must be). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (ctx.measureText(tryLine).width <= width) {
        line = tryLine;
        continue;
      }
      if (line) out.push(line);
      line = word;
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export interface CardHit {
  id: NodeId;
  index: number;
  rect: Rect;
}

export interface MeasureHit {
  id: string;
  rect: Rect;
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
}

/**
 * Draws the notes of the page beside their layers and the saved measurements; returns where the
 * cards and the measurement labels are (a click there takes them).
 */
export function drawAnnotations(ctx: CanvasRenderingContext2D, editor: Editor, screen: { width: number; height: number }, focus: { id: NodeId; index: number } | null): { cards: CardHit[]; labels: MeasureHit[] } {
  const cards: CardHit[] = [];
  const labels: MeasureHit[] = [];
  if (!editor.view.annotations) return { cards, labels };
  const vp = editor.viewport;
  const dark = isDark();
  ctx.save();

  // Measurements first: the cards go over them.
  for (const { m, line } of liveMeasurements(editor)) {
    const a = vp.worldToScreen(line.from);
    const b = vp.worldToScreen(line.to);
    const picked = editor.measureSelected === m.id;
    ctx.strokeStyle = SAVED_MEASURE_COLOR;
    ctx.lineWidth = picked ? 2 : 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const hl of line.helpers) {
      const p = vp.worldToScreen(hl.from);
      const q = vp.worldToScreen(hl.to);
      ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
      ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    ctx.beginPath();
    ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    for (const p of [a, b]) {
      if (horizontal) {
        ctx.moveTo(Math.round(p.x) + 0.5, p.y - 4);
        ctx.lineTo(Math.round(p.x) + 0.5, p.y + 4);
      } else {
        ctx.moveTo(p.x - 4, Math.round(p.y) + 0.5);
        ctx.lineTo(p.x + 4, Math.round(p.y) + 0.5);
      }
    }
    ctx.stroke();
    const text = measureText(m, line.value);
    ctx.font = FONT_MONO;
    const w = ctx.measureText(text).width + 10;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = horizontal ? { x: c.x - w / 2, y: c.y - 9, width: w, height: 18 } : { x: c.x + 6, y: c.y - 9, width: w, height: 18 };
    roundRect(ctx, r, 4);
    ctx.fillStyle = SAVED_MEASURE_COLOR;
    ctx.fill();
    if (picked) {
      ctx.strokeStyle = dark ? '#FFFFFF' : '#1E1E1E';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, r.x + 5, r.y + r.height / 2 + 0.5);
    labels.push({ id: m.id, rect: r });
  }

  // Notes.
  const bg = dark ? '#2C2C2C' : '#FFFFFF';
  const fg = dark ? '#E8E8E8' : '#1E1E1E';
  const muted = dark ? '#A8A8A8' : '#6B6B6B';
  const ids = editor.annotatedLayers();
  for (const id of ids) {
    if (!editor.doc.store.isAlive(id) || !shown(editor, id) || editor.isPinned(id)) continue;
    const list = annotationsOf(editor, id);
    if (list.length === 0) continue;
    const box = editor.scene.bounds(id);
    const tl = vp.worldToScreen({ x: box.x, y: box.y });
    const br = vp.worldToScreen({ x: box.x + box.width, y: box.y + box.height });
    // Off screen: not drawn (a far layer's cards would still be laid out for nothing).
    if (br.x < -CARD_MAX - GAP || tl.x > screen.width + CARD_MAX + GAP || br.y < -400 || tl.y > screen.height + 40) continue;
    const css = list.some((a) => a.properties.length > 0) ? layerCss(editor, id) : null;
    // Right of the layer; where the screen ends — under it (left of it the cards covered the gaps people measure).
    const below = br.x + GAP + CARD_MAX > screen.width - 8;
    // Under the layer: below its size label (it sits right under a selected layer).
    let y = below ? br.y + GAP + 22 : tl.y;
    const firstColor = categoryColor(list[0]!.category, dark);
    ctx.strokeStyle = firstColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(br.x - tl.x), Math.round(br.y - tl.y));
    list.forEach((a, index) => {
      const color = categoryColor(a.category, dark);
      ctx.font = FONT;
      const inner = CARD_MAX - CARD_PAD * 2 - 3;
      const text = a.label.trim() || (a.properties.length ? '' : tr('Пустая аннотация'));
      let lines = text ? wrapText(ctx, text, inner) : [];
      if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES - 1), `${lines[MAX_LINES - 1]}…`];
      const props = a.properties.map((p) => [p, css?.get(p) ?? '—'] as const);
      ctx.font = FONT_MONO;
      const propWidth = Math.min(inner, Math.max(0, ...props.map(([p, v]) => ctx.measureText(`${p}: ${v}`).width)));
      ctx.font = FONT;
      const textWidth = Math.min(inner, Math.max(0, ...lines.map((l) => ctx.measureText(l).width)));
      ctx.font = FONT_SMALL;
      const head = a.category !== 'NONE' ? categoryLabel(a.category).toUpperCase() : '';
      const headWidth = head ? ctx.measureText(head).width : 0;
      const width = Math.max(64, Math.ceil(Math.max(textWidth, propWidth, headWidth)) + CARD_PAD * 2 + 3);
      const height = CARD_PAD * 2 + (head ? 14 : 0) + lines.length * 16 + props.length * 16 + (lines.length && props.length ? 4 : 0);
      // Under the layer it stays on screen: pressed to the canvas's right edge if need be.
      const x = below ? Math.max(8, Math.min(tl.x, screen.width - 8 - width)) : br.x + GAP;
      const r = { x: Math.round(x), y: Math.round(y), width, height };
      // The leader from the card to the layer's edge (under the layer — from its bottom edge).
      const anchor = below ? { x: Math.min(Math.max(r.x + 12, tl.x), br.x), y: br.y } : { x: br.x, y: Math.min(Math.max(r.y + 12, tl.y), Math.max(tl.y, br.y)) };
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchor.x + 0.5, anchor.y + 0.5);
      ctx.lineTo(below ? r.x + 12.5 : r.x, below ? r.y : r.y + 12.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      // The card: a calm plate, the category's colour as a bar on its left and a thin edge.
      roundRect(ctx, r, 6);
      ctx.fillStyle = bg;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      const isFocus = focus !== null && focus.id === id && focus.index === index;
      ctx.strokeStyle = color;
      ctx.lineWidth = isFocus ? 2 : 1;
      ctx.stroke();
      ctx.save();
      roundRect(ctx, r, 6);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(r.x, r.y, 3, r.height);
      ctx.restore();
      let ty = r.y + CARD_PAD;
      const tx = r.x + CARD_PAD + 3;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      if (head) {
        ctx.font = FONT_SMALL;
        ctx.fillStyle = color;
        ctx.fillText(head, tx, ty);
        ty += 14;
      }
      ctx.font = FONT;
      ctx.fillStyle = a.label.trim() ? fg : muted;
      for (const l of lines) {
        ctx.fillText(l, tx, ty + 1);
        ty += 16;
      }
      if (lines.length && props.length) ty += 4;
      ctx.font = FONT_MONO;
      for (const [p, v] of props) {
        ctx.fillStyle = muted;
        const label = `${p}: `;
        ctx.fillText(label, tx, ty + 2);
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = fg;
        let value = v;
        while (value.length > 1 && lw + ctx.measureText(value).width > inner) value = value.slice(0, -2) + '…';
        ctx.fillText(value, tx + lw, ty + 2);
        ty += 16;
      }
      cards.push({ id, index, rect: r });
      y = r.y + r.height + 6;
    });
  }
  ctx.restore();
  return { cards, labels };
}

/** Whether a screen point is inside a rect (with a margin). */
export function inRect(r: Rect, p: Point, margin = 0): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.width + margin && p.y >= r.y - margin && p.y <= r.y + r.height + margin;
}

// ---------- the tool ----------

export interface EdgeHit {
  id: NodeId;
  side: MeasureSide;
  /** Distance from the pointer to the edge, screen pixels. */
  distance: number;
}

/** The edge of a box nearest a point, if within `tol` of it (along the edge's own span too). */
export function nearestEdge(r: Rect, p: Point, tol: number, axis: 'x' | 'y' | null = null): { side: MeasureSide; distance: number } | null {
  let best: { side: MeasureSide; distance: number } | null = null;
  for (const side of SIDES) {
    if (axis && AXIS[side] !== axis) continue;
    const along = AXIS[side] === 'x' ? p.y >= r.y - tol && p.y <= r.y + r.height + tol : p.x >= r.x - tol && p.x <= r.x + r.width + tol;
    if (!along) continue;
    const distance = Math.abs((AXIS[side] === 'x' ? p.x : p.y) - edgeAt(r, side));
    if (distance <= tol && (!best || distance < best.distance)) best = { side, distance };
  }
  return best;
}

export interface AnnotateHost {
  request(): void;
  /** A note was added or a card taken: the panel shows it (the «Код» tab), its text in focus. */
  focusNote(id: NodeId, index: number): void;
}

type Drag = { kind: 'measure'; from: EdgeHit; to: EdgeHit | null; pointer: Point; start: Point } | { kind: 'click'; id: NodeId | null; start: Point };

/** The annotate tool (Shift+T) and clicks on cards and measurement labels with any tool. */
export class AnnotateView {
  private readonly editor: Editor;
  private readonly host: AnnotateHost;
  private drag: Drag | null = null;
  /** Hovered edge with the tool (drawn thick: a drag from it measures). */
  private hoverEdge: EdgeHit | null = null;
  private cards: CardHit[] = [];
  private labels: MeasureHit[] = [];
  /** The note shown in the panel: its card is ringed. */
  focus: { id: NodeId; index: number } | null = null;

  constructor(editor: Editor, host: AnnotateHost) {
    this.editor = editor;
    this.host = host;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  private tolerance(): number {
    return 6;
  }

  /** The deepest shown layer under a world point (the one a note goes on). */
  private layerAt(world: Point): NodeId | null {
    const editor = this.editor;
    const hits = editor.pickable(editor.scene.hitTest(world, { tolerance: 2 / editor.viewport.zoom }));
    for (const hit of hits) {
      const id = editor.selectableFor(hit, true);
      if (editor.doc.store.isAlive(id) && editor.doc.type(id) !== 'PAGE') return id;
    }
    return null;
  }

  /** The edge nearest the pointer among the layers around it; `axis` — only edges across it. */
  edgeAt(world: Point, axis: 'x' | 'y' | null = null): EdgeHit | null {
    const editor = this.editor;
    const d = editor.doc;
    const zoom = editor.viewport.zoom;
    const tol = this.tolerance() / zoom;
    const around = editor.scene.queryRect({ x: world.x - tol, y: world.y - tol, width: tol * 2, height: tol * 2 });
    let best: EdgeHit | null = null;
    for (const id of editor.pickable(around)) {
      if (!d.store.isAlive(id) || d.pageOf(id) !== editor.pageId || d.type(id) === 'PAGE' || !shown(editor, id)) continue;
      const edge = nearestEdge(editor.scene.bounds(id), world, tol, axis);
      if (!edge) continue;
      const distance = edge.distance * zoom;
      // Equally near: the deeper layer (a button's edge on the card's edge is the button's).
      const deeper = best && Math.abs(distance - best.distance) < 0.5 && d.store.isAncestorOrSelf(best.id, id);
      if (!best || distance < best.distance - 0.5 || deeper) best = { id, side: edge.side, distance };
    }
    return best;
  }

  /** A card or a measurement label under a screen point. */
  private hitCard(screen: Point): CardHit | null {
    for (let i = this.cards.length - 1; i >= 0; i--) if (inRect(this.cards[i]!.rect, screen)) return this.cards[i]!;
    return null;
  }

  private hitLabel(screen: Point): MeasureHit | null {
    for (let i = this.labels.length - 1; i >= 0; i--) if (inRect(this.labels[i]!.rect, screen, 2)) return this.labels[i]!;
    return null;
  }

  /** Hover with no button: a cursor when the view takes the pointer here. */
  hover(world: Point, screen: Point): string | null {
    const editor = this.editor;
    const toolEdge = editor.tool === 'annotate' ? this.edgeAt(world) : null;
    if (editor.view.annotations && !toolEdge && (this.hitCard(screen) || this.hitLabel(screen))) {
      if (this.hoverEdge) {
        this.hoverEdge = null;
        this.host.request();
      }
      return 'pointer';
    }
    if (editor.tool !== 'annotate') return null;
    const edge = toolEdge;
    const key = (e: EdgeHit | null) => (e ? `${e.id}:${e.side}` : '');
    if (key(edge) !== key(this.hoverEdge)) {
      this.hoverEdge = edge;
      this.host.request();
    }
    editor.setHover(edge ? edge.id : this.layerAt(world));
    return edge ? (edge.side === 'LEFT' || edge.side === 'RIGHT' ? 'col-resize' : 'row-resize') : 'crosshair';
  }

  /** A press: true when the view takes it. */
  pointerDown(world: Point, screen: Point): boolean {
    const editor = this.editor;
    // With the tool, an edge under the pointer is a measurement started, even under a card.
    const edge = editor.tool === 'annotate' && !editor.doc.readOnly ? this.edgeAt(world) : null;
    if (editor.view.annotations && !edge) {
      const label = this.hitLabel(screen);
      if (label) {
        editor.selectMeasurement(label.id);
        this.focus = null;
        return true;
      }
      const card = this.hitCard(screen);
      if (card) {
        editor.setSelection([card.id]);
        this.focus = { id: card.id, index: card.index };
        this.host.focusNote(card.id, card.index);
        return true;
      }
    }
    if (editor.measureSelected) editor.selectMeasurement(null);
    if (editor.tool !== 'annotate') return false;
    if (editor.doc.readOnly) {
      editor.toast(tr('Файл открыт только для просмотра: аннотации и замеры добавляет тот, кто может его править'));
      return true;
    }
    this.drag = edge ? { kind: 'measure', from: edge, to: null, pointer: world, start: screen } : { kind: 'click', id: this.layerAt(world), start: screen };
    this.host.request();
    return true;
  }

  pointerMove(world: Point): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.kind === 'click') {
      // A drag that did not start on an edge: nothing to measure from.
      return;
    }
    drag.pointer = world;
    const axis = AXIS[drag.from.side];
    const to = this.edgeAt(world, axis);
    drag.to = to && !(to.id === drag.from.id && to.side === drag.from.side) ? to : null;
    this.editor.setHover(drag.to?.id ?? null);
    this.host.request();
  }

  pointerUp(screen: Point): void {
    const drag = this.drag;
    this.drag = null;
    const editor = this.editor;
    if (!drag) return;
    if (drag.kind === 'measure') {
      if (drag.to) {
        const id = addMeasurement(editor, drag.from.id, drag.from.side, drag.to.id, drag.to.side);
        if (id) {
          if (!editor.view.annotations) editor.setView({ annotations: true });
          editor.selectMeasurement(id);
        }
      } else {
        // A click on an edge: a note on that layer, as a click inside it.
        if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 4) this.note(drag.from.id);
      }
      this.host.request();
      return;
    }
    if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) > 4) return;
    if (drag.id) this.note(drag.id);
    this.host.request();
  }

  private note(id: NodeId): void {
    const editor = this.editor;
    const index = addAnnotation(editor, id);
    if (!editor.view.annotations) editor.setView({ annotations: true });
    editor.setSelection([id]);
    this.focus = { id, index };
    this.host.focusNote(id, index);
  }

  cancel(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.host.request();
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, screen: { width: number; height: number }): void {
    const editor = this.editor;
    if (this.focus && (!editor.doc.store.isAlive(this.focus.id) || !editor.selection.includes(this.focus.id) || editor.prototype.mode !== 'code')) this.focus = null;
    const hits = drawAnnotations(ctx, editor, screen, this.focus);
    this.cards = hits.cards;
    this.labels = hits.labels;
    if (editor.tool !== 'annotate') {
      this.hoverEdge = null;
      return;
    }
    const vp = editor.viewport;
    const edgeLine = (e: EdgeHit) => {
      const r = editor.scene.bounds(e.id);
      const a = e.side === 'LEFT' || e.side === 'RIGHT' ? { x: edgeAt(r, e.side), y: r.y } : { x: r.x, y: edgeAt(r, e.side) };
      const b = e.side === 'LEFT' || e.side === 'RIGHT' ? { x: edgeAt(r, e.side), y: r.y + r.height } : { x: r.x + r.width, y: edgeAt(r, e.side) };
      const p = vp.worldToScreen(a);
      const q = vp.worldToScreen(b);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = SAVED_MEASURE_COLOR;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const drag = this.drag;
    if (drag?.kind === 'measure') {
      edgeLine(drag.from);
      if (drag.to) {
        edgeLine(drag.to);
        const line = measureLine(editor.scene.bounds(drag.from.id), drag.from.side, editor.scene.bounds(drag.to.id), drag.to.side);
        if (line) {
          const a = vp.worldToScreen(line.from);
          const b = vp.worldToScreen(line.to);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          const text = fmtNumber(line.value);
          ctx.font = FONT_MONO;
          const w = ctx.measureText(text).width + 10;
          const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          roundRect(ctx, { x: c.x - w / 2, y: c.y - 9, width: w, height: 18 }, 4);
          ctx.fillStyle = SAVED_MEASURE_COLOR;
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText(text, c.x, c.y + 0.5);
        }
      } else {
        const p = vp.worldToScreen(drag.pointer);
        const r = editor.scene.bounds(drag.from.id);
        const at = edgeAt(r, drag.from.side);
        const start = drag.from.side === 'LEFT' || drag.from.side === 'RIGHT' ? vp.worldToScreen({ x: at, y: drag.pointer.y }) : vp.worldToScreen({ x: drag.pointer.x, y: at });
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    } else if (this.hoverEdge && editor.doc.store.isAlive(this.hoverEdge.id)) {
      edgeLine(this.hoverEdge);
    }
    ctx.restore();
  }
}
