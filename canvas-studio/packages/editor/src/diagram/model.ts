// A diagram file (FEAT-090): an ordinary document whose root holds the
// diagram — its kind, its one text and the look. Saving,
// versions, sharing and editing together work as for any file.

import { colorToHex, Document, hexToColor, tr, type DiagramSpec } from '#core';
import { fromOklch, toOklch } from '../color-math.ts';

export function isDiagram(doc: Document): boolean {
  return doc.get(doc.rootId, 'fileKind') === 'DIAGRAM';
}

export function defaultDiagramSpec(): DiagramSpec {
  return { layout: 'radial', theme: 'soft', font: 'system', direction: 'lr', spacing: {}, offsets: {} };
}

/** The diagram of a document, with defaults for anything missing. */
export function diagramSpec(doc: Document): DiagramSpec {
  const spec = doc.get(doc.rootId, 'diagram');
  return { ...defaultDiagramSpec(), ...(spec ?? {}) };
}

/** A new diagram file, no text yet; its kind is chosen when it is first opened, unless given. */
export function createDiagramDocument(name: string, layout?: string): Document {
  const doc = Document.createEmpty(name);
  doc.transact((tx) => {
    tx.update(doc.rootId, { fileKind: 'DIAGRAM', diagram: layout ? { ...defaultDiagramSpec(), layout } : { ...defaultDiagramSpec(), fresh: true } });
    tx.set(doc.pages()[0]!, 'name', tr('Схема'));
  });
  doc.clearHistory();
  return doc;
}

/** Text families of the layouts (the same syntax shares one text). */
const FAMILY: Record<string, string> = { radial: 'tree', classic: 'tree', horizontal: 'tree', rollout: 'rollout', lanes: 'rollout', ribbon: 'rollout' };

export function diagramFamily(layout: string): string {
  return FAMILY[layout] ?? layout;
}

/** Whether a diagram is drawn dark: its own choice, else the interface's theme. */
export function diagramDark(spec: DiagramSpec, interfaceDark: boolean): boolean {
  return spec.look ? spec.look === 'dark' : interfaceDark;
}

/** The background of a diagram drawn light or dark (the canvas under it, exported pictures). */
export function diagramBackground(dark: boolean): string {
  return dark ? '#1e1e1e' : '#ffffff';
}

/**
 * Eight colours from one (a brand's): the same lightness and chroma, hues a
 * fixed step apart, ordered so that neighbours differ (branches next to each
 * other are told apart). The colour itself comes first.
 */
export function paletteFrom(hex: string): string[] {
  const base = hexToColor(hex);
  if (!base) return [];
  const { l, c, h } = toOklch(base);
  const L = Math.min(0.78, Math.max(0.55, l));
  const C = Math.min(0.19, Math.max(0.09, c));
  return [0, 3, 6, 1, 4, 7, 2, 5].map((k, i) => (i === 0 ? colorToHex(base).slice(0, 7) : colorToHex(fromOklch({ l: L, c: C, h: (h + k * 45) % 360 })).slice(0, 7)));
}

/** DocPlan's font names (diagrams made before any family could be chosen) as families. */
const OLD_FONTS: Record<string, string> = { system: 'system-ui', arial: 'Arial', georgia: 'Georgia', times: 'Times New Roman', verdana: 'Verdana', trebuchet: 'Trebuchet MS', mono: 'Courier New' };

/** The font family of a diagram ('system-ui' — as the interface). */
export function diagramFontFamily(spec: DiagramSpec): string {
  return OLD_FONTS[spec.font] ?? (spec.font || 'system-ui');
}

/** The text written, or null — none yet. */
export function diagramText(spec: DiagramSpec): string | null {
  const text = spec.text ?? spec.texts?.[diagramFamily(spec.layout)];
  return typeof text === 'string' ? text : null;
}

/** The diagram with `text` as its one text (the texts per family of an older file are dropped). */
export function withDiagramText(spec: DiagramSpec, text: string | null): DiagramSpec {
  const { texts: _texts, text: _text, ...rest } = spec;
  return text === null ? rest : { ...rest, text };
}

/** Whether a kind draws the text written for another (one syntax family). */
export function sameDiagramText(a: string, b: string): boolean {
  return diagramFamily(a) === diagramFamily(b);
}

// ---------- moving a branch of a map in its text (FEAT-092) ----------

const INDENT = '    ';

/** Indent of a line in columns (a tab is four). */
const indentOf = (line: string) => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, INDENT).length;

/** Lines [i, end) of a tree text: the line and everything nested deeper under it (no trailing blank lines). */
function branchEnd(lines: readonly string[], i: number): number {
  const base = indentOf(lines[i]!);
  let j = i + 1;
  while (j < lines.length && (lines[j]!.trim() === '' || indentOf(lines[j]!) > base)) j++;
  while (j > i + 1 && lines[j - 1]!.trim() === '') j--;
  return j;
}

/**
 * Moves the branch at line `from` (1-based, with its nested lines) under the
 * line `to` as its last child. Null — not possible (into itself, the root).
 */
export function moveBranch(text: string, from: number, to: number): string | null {
  const lines = text.split('\n');
  const f = from - 1;
  const t = to - 1;
  if (f < 0 || t < 0 || f >= lines.length || t >= lines.length || f === t) return null;
  const fEnd = branchEnd(lines, f);
  if (t >= f && t < fEnd) return null;
  const shift = indentOf(lines[t]!) + INDENT.length - indentOf(lines[f]!);
  const block = lines.slice(f, fEnd).map((line) => {
    if (line.trim() === '') return line;
    const width = Math.max(0, indentOf(line) + shift);
    return ' '.repeat(width) + line.replace(/^[ \t]*/, '');
  });
  const rest = [...lines.slice(0, f), ...lines.slice(fEnd)];
  const t2 = t > f ? t - (fEnd - f) : t;
  const at = branchEnd(rest, t2);
  rest.splice(at, 0, ...block);
  return rest.join('\n');
}

