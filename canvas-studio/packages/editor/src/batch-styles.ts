// «Массовая правка стилей» (as the Batch Styler plugin): several text or colour
// styles get a common change at once — a font, a weight, a size (set, or «+2»,
// «−2», «×1.25»), line height, letter spacing, case; colours get opacity and a
// shift of lightness, saturation and hue (in OKLCH, so equal steps look equal);
// names get a find-and-replace and a folder. Untouched fields stay as each style
// has them. Bound layers follow in the same undo step.

import type { Color, Document, LetterSpacing, LineHeight, NodeId, NodeProps, Paint, TextCase, TextDecoration } from '#core';
import { fromOklch, toOklch } from './color-math.ts';

/** A number change: set to a value, add to it, or multiply it. */
export type NumberChange = { op: 'set' | 'add' | 'mul'; value: number };

/**
 * «24» — set; «+2», «-2», «−2» — add; «×1.25», «*1.25», «x1.25» — multiply. Empty or
 * unreadable — null (no change). A comma is a decimal point.
 */
export function parseNumberChange(text: string): NumberChange | null {
  const t = text.trim().replace(',', '.').replace('−', '-');
  if (!t) return null;
  const mul = t.match(/^[×*xх]\s*(\d+(?:\.\d+)?)$/i);
  if (mul) return { op: 'mul', value: Number(mul[1]) };
  const add = t.match(/^([+-])\s*(\d+(?:\.\d+)?)$/);
  if (add) return { op: 'add', value: Number(add[2]) * (add[1] === '-' ? -1 : 1) };
  const set = t.match(/^\d+(?:\.\d+)?$/);
  return set ? { op: 'set', value: Number(t) } : null;
}

export function applyNumber(change: NumberChange, now: number): number {
  const v = change.op === 'set' ? change.value : change.op === 'add' ? now + change.value : now * change.value;
  return Math.round(v * 100) / 100;
}

/** Line height: «Авто»/«auto», «120%», «24» (px), «+4» (px added; a percent one grows by the same percent points). */
export function parseLineHeight(text: string): ((now: LineHeight, fontSize: number) => LineHeight) | null {
  const t = text.trim().replace(',', '.').replace('−', '-').toLowerCase();
  if (!t) return null;
  if (t === 'авто' || t === 'auto') return () => ({ unit: 'AUTO' });
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return () => ({ unit: 'PERCENT', value: Number(pct[1]) });
  const n = parseNumberChange(t.replace(/px$/, ''));
  if (!n) return null;
  if (n.op === 'set') return () => ({ unit: 'PX', value: n.value });
  return (now, fontSize) => {
    // «Auto» is about 120 % of the size: changing it gives pixels.
    if (now.unit === 'AUTO') return { unit: 'PX', value: Math.max(0, applyNumber(n, Math.round(fontSize * 1.2))) };
    return { unit: now.unit, value: Math.max(0, applyNumber(n, now.value)) };
  };
}

/** Letter spacing: «-2%», «0», «1px», «+1» (in the style's own unit). A bare number is percent, as in the panel. */
export function parseLetterSpacing(text: string): ((now: LetterSpacing) => LetterSpacing) | null {
  const t = text.trim().replace(',', '.').replace('−', '-').toLowerCase();
  if (!t) return null;
  const px = t.match(/^(-?\d+(?:\.\d+)?)\s*px$/);
  if (px) return () => ({ unit: 'PX', value: Number(px[1]) });
  const pct = t.match(/^(-?\d+(?:\.\d+)?)\s*%?$/);
  if (pct && !/^[+]/.test(t)) return () => ({ unit: 'PERCENT', value: Number(pct[1]) });
  const add = t.match(/^\+(\d+(?:\.\d+)?)$/);
  if (add) return (now) => ({ unit: now.unit, value: Math.round((now.value + Number(add[1])) * 100) / 100 });
  return null;
}

export interface TextChanges {
  fontFamily?: string;
  fontWeight?: number;
  italic?: boolean;
  fontSize?: NumberChange;
  lineHeight?: (now: LineHeight, fontSize: number) => LineHeight;
  letterSpacing?: (now: LetterSpacing) => LetterSpacing;
  paragraphSpacing?: NumberChange;
  textCase?: TextCase;
  textDecoration?: TextDecoration;
}

export interface ColorChanges {
  /** Opacity of every paint, 0–1. */
  opacity?: number;
  /** OKLCH shifts: lightness and chroma in percent points of their range, hue in degrees. */
  lightness?: number;
  chroma?: number;
  hue?: number;
  /** One colour for every solid paint (gradients keep their stops). */
  color?: Color;
}

export interface NameChanges {
  find?: string;
  replace?: string;
  /** Moves into a folder: «Кнопки/Основные» (empty — out of folders). Undefined — folders stay. */
  folder?: string;
}

/** «Кнопки/Основная» with the find-and-replace and the folder applied. */
export function renamed(name: string, change: NameChanges): string {
  let next = name;
  if (change.find) next = next.split(change.find).join(change.replace ?? '');
  if (change.folder !== undefined) {
    const leaf = next.split('/').pop()!.trim();
    const folder = change.folder
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
    next = folder ? `${folder}/${leaf}` : leaf;
  }
  // «Бренд/Синий» with «Бренд» removed is «Синий», not «/Синий»: no empty folders.
  next = next
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');
  return next || name;
}

function shifted(c: Color, change: ColorChanges): Color {
  if (change.color) return { ...change.color, a: c.a };
  if (!change.lightness && !change.chroma && !change.hue) return c;
  const p = toOklch(c);
  return fromOklch(
    {
      l: Math.min(1, Math.max(0, p.l + (change.lightness ?? 0) / 100)),
      // Chroma's useful range is about 0–0.37: a percent point of it.
      c: Math.max(0, p.c + ((change.chroma ?? 0) / 100) * 0.37),
      h: (((p.h + (change.hue ?? 0)) % 360) + 360) % 360,
    },
    c.a,
  );
}

export function changedPaints(paints: readonly Paint[], change: ColorChanges): Paint[] {
  return paints.map((p): Paint => {
    const opacity = change.opacity ?? p.opacity;
    if (p.type === 'SOLID') return { ...p, color: shifted(p.color, change), opacity };
    if ('stops' in p) return { ...p, stops: p.stops.map((s) => ({ ...s, color: change.color ? s.color : shifted(s.color, change) })), opacity };
    return { ...p, opacity };
  });
}

/** What changes in each style: only the props that differ. */
export function planBatch(doc: Document, styles: readonly NodeId[], text: TextChanges, color: ColorChanges, names: NameChanges): Map<NodeId, Partial<NodeProps>> {
  const out = new Map<NodeId, Partial<NodeProps>>();
  for (const id of styles) {
    const patch: Partial<NodeProps> = {};
    const type = doc.get(id, 'styleType');
    if (type === 'TEXT') {
      if (text.fontFamily !== undefined) patch.fontFamily = text.fontFamily;
      if (text.fontWeight !== undefined) patch.fontWeight = text.fontWeight;
      if (text.italic !== undefined) patch.italic = text.italic;
      const size = text.fontSize ? Math.max(1, applyNumber(text.fontSize, doc.get(id, 'fontSize'))) : doc.get(id, 'fontSize');
      if (text.fontSize) patch.fontSize = size;
      if (text.lineHeight) patch.lineHeight = text.lineHeight(doc.get(id, 'lineHeight'), size);
      if (text.letterSpacing) patch.letterSpacing = text.letterSpacing(doc.get(id, 'letterSpacing'));
      if (text.paragraphSpacing) patch.paragraphSpacing = Math.max(0, applyNumber(text.paragraphSpacing, doc.get(id, 'paragraphSpacing')));
      if (text.textCase !== undefined) patch.textCase = text.textCase;
      if (text.textDecoration !== undefined) patch.textDecoration = text.textDecoration;
    }
    if (type === 'FILL' && (color.opacity !== undefined || color.lightness || color.chroma || color.hue || color.color)) patch.fills = changedPaints(doc.get(id, 'fills'), color);
    const name = renamed(doc.get(id, 'name'), names);
    if (name !== doc.get(id, 'name')) patch.name = name;
    // Only what really differs: an untouched style stays out of the step.
    for (const k of Object.keys(patch) as (keyof NodeProps)[]) if (JSON.stringify(patch[k]) === JSON.stringify(doc.get(id, k))) delete patch[k];
    if (Object.keys(patch).length) out.set(id, patch);
  }
  return out;
}
