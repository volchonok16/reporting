// Text as outlines: letters as vector contours from the font files, placed
// where the canvas draws them. Used by Flatten on a text (as in Figma) and by
// "text as outlines" in SVG export.

import { tr, type Document, type NodeId, type VectorPath } from '#core';
import { decorationLookOf, decorationPath, lineOffset, pathTextGlyphs, textStyleOf, type DecorationLook, type RunFont, type TextMeasurer } from '#layout';
import type { FontFile } from '#render';
import { fontFileOf } from './font-features.ts';
import { parsePathData } from './svg-import.ts';

/**
 * Font files of every font the texts under `id` use, read beforehand (outlines
 * are made synchronously). A font without a file to read is noted in `notes`.
 */
export async function outlineFonts(doc: Document, id: NodeId, notes: Set<string>): Promise<(font: RunFont) => FontFile | null> {
  const wanted = new Map<string, { family: string; weight: number; italic: boolean }>();
  // The layer itself too: walk() visits only what is inside.
  const visit = (n: NodeId) => {
    if (doc.type(n) !== 'TEXT') return;
    const base = { family: doc.get(n, 'fontFamily'), weight: doc.get(n, 'fontWeight'), italic: doc.get(n, 'italic') };
    for (const r of [base, ...doc.get(n, 'textRuns').map((run) => ({ family: run.style.fontFamily ?? base.family, weight: run.style.fontWeight ?? base.weight, italic: run.style.italic ?? base.italic }))]) wanted.set(`${r.family}|${r.weight}|${r.italic}`, r);
  };
  visit(id);
  doc.store.walk(id, (n) => visit(n));
  const files = new Map<string, FontFile | null>();
  for (const [key, f] of wanted) {
    const file = await fontFileOf(doc, f.family, f.weight, f.italic);
    files.set(key, file);
    if (!file) notes.add(tr('Текст шрифтом «{0}» оставлен текстом: этого шрифта нет в файле. Встройте его (выбор шрифта → «Встроить в файл»), чтобы он ушёл в кривых', f.family));
  }
  return (font) => files.get(`${font.fontFamily}|${font.fontWeight}|${font.italic}`) ?? null;
}

type Place = (x: number, y: number) => { x: number; y: number };

/** One run of letters at a baseline; null — no font file, or a letter the font does not have. */
function runOutlines(text: string, font: RunFont, x: number, y: number, measurer: TextMeasurer, file: FontFile | null, place: Place, out: VectorPath[], decoration = 'NONE', width = 0, look?: DecorationLook): boolean {
  if (!file) return false;
  const axes: Record<string, number> = {};
  if (file.info.axes.some((a) => a.tag === 'wght')) axes.wght = font.fontWeight;
  // Optical size follows the font size, as browsers do (font-optical-sizing: auto).
  const opsz = file.info.axes.find((a) => a.tag === 'opsz');
  if (opsz) axes.opsz = Math.min(opsz.max, Math.max(opsz.min, font.fontSize));
  for (const m of (font.variations ?? '').matchAll(/"(\w{4})"\s+(-?[\d.]+)/g)) axes[m[1]!] = Number(m[2]);
  const k = font.fontSize / file.info.unitsPerEm;
  let prefix = '';
  // Where the canvas puts a letter: after the text before it, kerned with it (and its letter spacing).
  for (const ch of text) {
    const at = x + (prefix ? measurer.width(prefix + ch, font) - measurer.width(ch, font) : 0);
    prefix += ch;
    if (/\s/.test(ch)) continue;
    if (file.glyphId(ch.codePointAt(0)!) === 0) return false;
    const g = file.outline(ch.codePointAt(0)!, axes);
    if (!g) return false;
    const map = (p: { x: number; y: number }) => place(at + p.x * k, y - p.y * k);
    for (const path of parsePathData(g.path)) {
      out.push({ closed: path.closed, points: path.points.map((p) => ({ ...map(p), ...(p.in ? { in: map(p.in) } : {}), ...(p.out ? { out: map(p.out) } : {}) })) });
    }
  }
  // Underline and strikethrough as the canvas draws them.
  if (decoration === 'UNDERLINE' || decoration === 'STRIKETHROUGH') {
    const visible = text.replace(/\s+$/, '');
    const w = visible.length === text.length ? width : measurer.width(visible, font);
    for (const path of parsePathData(decorationPath(decoration, x, y, w, font.fontSize, look))) {
      out.push({ closed: path.closed, points: path.points.map((p) => ({ ...place(p.x, p.y), ...(p.in ? { in: place(p.in.x, p.in.y) } : {}), ...(p.out ? { out: place(p.out.x, p.out.y) } : {}) })) });
    }
  }
  return true;
}

/**
 * The letters of a text layer as contours in the layer's own coordinates; null
 * when some letter has no outline to take (its font is not in the file).
 */
export function textOutlinePaths(doc: Document, measurer: TextMeasurer, id: NodeId, fileOf: (font: RunFont) => FontFile | null): VectorPath[] | null {
  const out: VectorPath[] = [];
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const path = doc.get(id, 'textPath');
  if (path) {
    const layout = measurer.measure(textStyleOf(doc, id), null).layout;
    for (const g of pathTextGlyphs(layout, path, doc.get(id, 'textPathOffset'), doc.get(id, 'textAlignH'), measurer)) {
      const cos = Math.cos(g.angle);
      const sin = Math.sin(g.angle);
      const place: Place = (x, y) => ({ x: g.x + x * cos - y * sin, y: g.y + x * sin + y * cos });
      if (!runOutlines(g.text, g.font, 0, g.fragment.shift, measurer, fileOf(g.font), place, out)) return null;
    }
    return out;
  }
  const autoWidth = doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
  const { layout } = measurer.measure(textStyleOf(doc, id), autoWidth ? null : w);
  const valign = doc.get(id, 'textAlignV');
  const align = doc.get(id, 'textAlignH');
  const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
  const place: Place = (x, y) => ({ x, y });
  for (const line of layout.lines) {
    // Right-to-left letters need shaping this outliner does not do: the text stays text.
    if (line.rtl) return null;
    const offset = lineOffset(line, w, align);
    const baseline = top + line.y + line.baseline;
    if (line.marker && line.markerFont && !runOutlines(line.marker, line.markerFont, line.markerX ?? 0, baseline, measurer, fileOf(line.markerFont), place, out)) return null;
    for (const f of line.fragments) {
      if (f.text.length === 0) continue;
      if (!runOutlines(f.text, f.font, line.x + offset + f.x, baseline + f.shift, measurer, fileOf(f.font), place, out, f.style.textDecoration, f.width, decorationLookOf(doc, id))) return null;
    }
  }
  return out;
}
