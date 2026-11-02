// PowerPoint import (FEAT-158), the building side: the slides read by
// import.ts become slides of a presentation — frames with their background,
// notes and transition, holding shapes, texts with their styles, pictures
// (cropped as on the slide), lines, groups and tables. One undo step.

import { tr, type Color, type NodeId, type NodeProps, type Paint, type TextRun, type TextRunStyle, type Transaction } from '#core';
import type { Editor } from '../editor.ts';
import { buildSvgInto } from '../svg-import.ts';
import { gridPlace, slideIds } from '../slides.ts';
import { bareCell, tableFrame } from '../tables.ts';
import type { Crop, ImDeck, ImElement, ImFill, ImStroke, ImText } from './import.ts';
import { RAW_MIME } from './emf.ts';

type Media = Map<string, { bytes: Uint8Array; mime: string }>;

const opaque = (c: Color): Color => ({ r: c.r, g: c.g, b: c.b, a: 1 });
const solidOf = (c: Color): Paint => ({ type: 'SOLID', color: opaque(c), opacity: c.a, visible: true });
const cssHex = (c: Color) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** A cropped picture's key in the media map: its path and the crop. */
const cropKey = (p: string, c: Crop | null) => (c ? `${p}#${c.l},${c.t},${c.r},${c.b}` : p);

/** Cuts pictures as the slides crop them (a browser's canvas); without one, the whole picture is used. */
export async function cropMedia(deck: ImDeck): Promise<Media> {
  const out: Media = new Map(deck.media);
  const wanted = new Map<string, { path: string; crop: Crop }>();
  const visit = (els: ImElement[]) => {
    for (const e of els) {
      if (e.k === 'pic' && e.crop) wanted.set(cropKey(e.path, e.crop), { path: e.path, crop: e.crop });
      if (e.k === 'shape' && e.fill?.type === 'image' && e.fill.crop) wanted.set(cropKey(e.fill.path, e.fill.crop), { path: e.fill.path, crop: e.fill.crop });
      if (e.k === 'group') visit(e.children);
    }
  };
  for (const s of deck.slides) visit(s.elements);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return out;
  // Pixels taken out of EMF+ wrappers: encoded as PNG here (a canvas does it).
  for (const [key, m] of out) {
    if (!m.mime.startsWith(RAW_MIME)) continue;
    const w = Number(/w=(\d+)/.exec(m.mime)?.[1]);
    const h = Number(/h=(\d+)/.exec(m.mime)?.[1]);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(m.bytes.buffer, m.bytes.byteOffset, w * h * 4), w, h), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) out.set(key, { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' });
    else out.delete(key);
  }
  for (const [key, { path, crop }] of wanted) {
    const src = deck.media.get(path);
    if (!src || src.mime === 'image/svg+xml') continue;
    try {
      const bitmap = await createImageBitmap(new Blob([src.bytes as BlobPart], { type: src.mime }));
      const sx = Math.max(0, crop.l) * bitmap.width;
      const sy = Math.max(0, crop.t) * bitmap.height;
      const sw = Math.max(1, (1 - Math.max(0, crop.l) - Math.max(0, crop.r)) * bitmap.width);
      const sh = Math.max(1, (1 - Math.max(0, crop.t) - Math.max(0, crop.b)) * bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const mime = src.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
      if (blob) out.set(key, { bytes: new Uint8Array(await blob.arrayBuffer()), mime });
    } catch {
      // the whole picture then
    }
  }
  return out;
}

/** Top-left of a box of w × h turned by `rot` degrees around its centre (cx, cy): our layers turn around their origin. */
function origin(cx: number, cy: number, w: number, h: number, rot: number): { x: number; y: number } {
  const a = (rot * Math.PI) / 180;
  return { x: cx - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a), y: cy - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a) };
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Puts the deck's slides into the presentation after `after` (or at the end);
 * returns the new slides. `media` — pictures (cropped ones under their crop key).
 */
export function buildDeck(editor: Editor, tx: Transaction, deck: ImDeck, media: Media, after: NodeId | null): NodeId[] {
  const page = editor.pageId;
  const hashes = new Map<string, string>();
  const hashOf = (key: string): string | null => {
    const known = hashes.get(key);
    if (known) return known;
    const m = media.get(key);
    if (!m) return null;
    const h = tx.addBlob(m.bytes, m.mime);
    hashes.set(key, h);
    return h;
  };
  const paintOf = (f: ImFill): Paint | null => {
    if (!f) return null;
    if (f.type === 'solid') return solidOf(f.color);
    if (f.type === 'gradient') {
      const a = (f.angle * Math.PI) / 180;
      const dx = Math.cos(a) / 2;
      const dy = Math.sin(a) / 2;
      return {
        type: f.radial ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
        stops: f.stops.map((s) => ({ position: s.pos, color: s.color })),
        from: f.radial ? { x: 0.5, y: 0.5 } : { x: 0.5 - dx, y: 0.5 - dy },
        to: f.radial ? { x: 1, y: 0.5 } : { x: 0.5 + dx, y: 0.5 + dy },
        opacity: 1,
        visible: true,
      };
    }
    const hash = hashOf(cropKey(f.path, f.crop)) ?? hashOf(f.path);
    return hash ? { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true } : null;
  };
  const strokeProps = (s: ImStroke | null): Partial<NodeProps> =>
    s ? { strokes: [solidOf(s.color)], strokeWeight: round(s.width), strokeAlign: 'CENTER', dashPattern: s.dash ? [round(s.width * 3), round(s.width * 2)] : [] } : { strokes: [] };

  const text = (parent: NodeId, t: ImText, name: string, rot: number, pivot: { x: number; y: number } | null): NodeId | null => {
    const paras = t.paragraphs;
    const withText = paras.filter((p) => p.runs.some((r) => r.text.trim()));
    if (!withText.length) return null;
    // One kind of bullet for all of them: a real list; otherwise the marks go into the text.
    const kinds = new Set(withText.map((p) => p.bullet));
    const list = kinds.size === 1 && !kinds.has('none') ? ([...kinds][0] === 'num' ? 'NUMBER' : 'BULLET') : 'NONE';
    const base = withText[0]!.runs.find((r) => r.text.trim()) ?? withText[0]!.runs[0]!;
    const baseStyle: TextRunStyle = { fontFamily: base.font, fontWeight: base.bold ? 700 : 400, italic: base.italic, fontSize: round(base.size), fills: [solidOf(base.color)], textDecoration: base.underline ? 'UNDERLINE' : base.strike ? 'STRIKETHROUGH' : 'NONE' };
    let characters = '';
    const runs: TextRun[] = [];
    const levels: number[] = [];
    paras.forEach((p, i) => {
      if (i > 0) characters += '\n';
      levels.push(p.level);
      if (list === 'NONE' && p.bullet !== 'none') characters += p.bullet === 'num' ? `${withText.indexOf(p) + 1}. ` : '• ';
      for (const r of p.runs) {
        const start = characters.length;
        characters += r.text;
        const style: TextRunStyle = {};
        if (r.font !== baseStyle.fontFamily) style.fontFamily = r.font;
        if ((r.bold ? 700 : 400) !== baseStyle.fontWeight) style.fontWeight = r.bold ? 700 : 400;
        if (r.italic !== baseStyle.italic) style.italic = r.italic;
        if (round(r.size) !== baseStyle.fontSize) style.fontSize = round(r.size);
        if (cssHex(r.color) !== cssHex(base.color) || r.color.a !== base.color.a) style.fills = [solidOf(r.color)];
        const deco = r.underline ? 'UNDERLINE' : r.strike ? 'STRIKETHROUGH' : 'NONE';
        if (deco !== baseStyle.textDecoration) style.textDecoration = deco;
        if (r.link) style.link = r.link;
        if (Object.keys(style).length && characters.length > start) runs.push({ start, end: characters.length, style });
      }
    });
    const first = withText[0]!;
    // A text in a turned shape turns with it, around the shape's centre.
    let x = t.x;
    let y = t.y;
    if (rot && pivot) {
      const c = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
      const a = (rot * Math.PI) / 180;
      const turned = { x: pivot.x + (c.x - pivot.x) * Math.cos(a) - (c.y - pivot.y) * Math.sin(a), y: pivot.y + (c.x - pivot.x) * Math.sin(a) + (c.y - pivot.y) * Math.cos(a) };
      ({ x, y } = origin(turned.x, turned.y, t.w, t.h, rot));
    }
    return tx.create('TEXT', parent, {
      name: characters.split('\n').find((l) => l.trim())?.slice(0, 40) || name,
      characters,
      x: round(x),
      y: round(y),
      width: round(t.w),
      height: round(t.h),
      rotation: rot,
      // «Не переносить»: the box takes the text's width (a substitute font wider than the original does not break lines).
      textAutoResize: t.noWrap ? 'WIDTH_AND_HEIGHT' : 'NONE',
      textAlignH: first.align,
      textAlignV: t.anchor,
      lineHeight: first.lineHeight,
      paragraphSpacing: round(withText.slice(1).find((p) => p.spaceBefore)?.spaceBefore ?? 0),
      listType: list,
      listLevels: list === 'NONE' ? [] : levels,
      fontFamily: baseStyle.fontFamily,
      fontWeight: baseStyle.fontWeight,
      italic: baseStyle.italic,
      fontSize: baseStyle.fontSize,
      fills: baseStyle.fills,
      textDecoration: baseStyle.textDecoration,
      textRuns: runs,
    });
  };

  const place = (parent: NodeId, e: ImElement): void => {
    switch (e.k) {
      case 'group': {
        const g = tx.create('GROUP', parent, { name: e.name });
        for (const c of e.children) place(g, c);
        if (tx.doc.children(g).length === 0) tx.delete(g);
        return;
      }
      case 'line': {
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        tx.create('LINE', parent, { name: e.name, x: round(e.x1), y: round(e.y1), width: round(Math.max(1, len)), height: 0, rotation: round((Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180) / Math.PI), ...strokeProps(e.stroke) });
        return;
      }
      case 'table': {
        // A real table (FEAT-168): a grid of cells whose rows grow with their texts, merged cells kept.
        const line = e.rows.flatMap((r) => r.cells).find((c) => c?.stroke)?.stroke;
        const table = tableFrame(tx, parent, { name: e.name, x: e.x, y: e.y, widths: e.cols, rows: e.rows.length, line: solidOf(line?.color ?? { r: 0.8, g: 0.8, b: 0.82, a: 1 }) });
        e.rows.forEach((row) => {
          e.cols.forEach((_, i) => {
            const cell = row.cells[i] ?? null;
            const frame = bareCell(tx, table, {
              fill: (cell && paintOf(cell.fill)) || solidOf({ r: 1, g: 1, b: 1, a: 1 }),
              colSpan: cell?.span ?? 1,
              rowSpan: cell?.rowSpan ?? 1,
              minHeight: cell ? row.h : 0,
              hidden: !cell,
              padX: 8,
              padY: 4,
            });
            const made = cell ? text(frame, { ...cell.text, noWrap: false }, tr('Текст'), 0, null) : null;
            if (made) tx.update(made, { sizingH: { mode: 'FILL' }, textAutoResize: 'HEIGHT' });
            else tx.create('TEXT', frame, { name: tr('Текст'), characters: '', sizingH: { mode: 'FILL' }, textAutoResize: 'HEIGHT', width: 100 });
          });
        });
        return;
      }
      case 'vector': {
        const at = origin(e.x + e.w / 2, e.y + e.h / 2, e.w, e.h, e.rot);
        const made = buildSvgInto(tx, editor, e.svg, parent, { x: at.x, y: at.y, width: e.w, height: e.h }, e.name);
        if (made && e.rot) tx.set(made, 'rotation', e.rot);
        return;
      }
      case 'missing': {
        const at = origin(e.x + e.w / 2, e.y + e.h / 2, e.w, e.h, e.rot);
        const what = e.what === 'chart' ? tr('Диаграмма из PowerPoint') : e.what === 'smartart' ? tr('Рисунок SmartArt') : e.what === 'picture' ? tr('Картинка (формат не поддерживается)') : tr('Объект из PowerPoint');
        tx.create('RECTANGLE', parent, { name: what, x: round(at.x), y: round(at.y), width: round(e.w), height: round(e.h), rotation: e.rot, cornerRadius: 8, fills: [solidOf({ r: 0.93, g: 0.93, b: 0.95, a: 1 })], strokes: [solidOf({ r: 0.7, g: 0.7, b: 0.75, a: 1 })], dashPattern: [6, 4] });
        return;
      }
      case 'pic': {
        const at = origin(e.x + e.w / 2, e.y + e.h / 2, e.w, e.h, e.rot);
        const hash = hashOf(cropKey(e.path, e.crop)) ?? hashOf(e.path);
        if (!hash) return;
        tx.create(e.geom === 'ellipse' ? 'ELLIPSE' : 'RECTANGLE', parent, {
          name: e.name,
          x: round(at.x),
          y: round(at.y),
          width: round(e.w),
          height: round(e.h),
          rotation: e.rot,
          fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'STRETCH', scale: 1, opacity: 1, visible: true, ...(e.flipH ? { flipX: true } : {}), ...(e.flipV ? { flipY: true } : {}) }],
          ...strokeProps(e.stroke),
        });
        return;
      }
      case 'shape': {
        const fill = paintOf(e.fill);
        const visible = !!fill || !!e.stroke;
        const both = visible && e.text && e.text.paragraphs.some((p) => p.runs.some((r) => r.text.trim()));
        const holder = both ? tx.create('GROUP', parent, { name: e.name }) : parent;
        if (visible) {
          const at = origin(e.x + e.w / 2, e.y + e.h / 2, e.w, e.h, e.rot);
          const common = { name: both ? tr('Фигура') : e.name, x: round(at.x), y: round(at.y), width: round(e.w), height: round(e.h), rotation: e.rot, fills: fill ? [fill] : [], ...strokeProps(e.stroke) };
          if (e.geom === 'cust' && e.path) {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(e.w)} ${round(e.h)}"><path d="${e.path}" fill="${fill?.type === 'SOLID' ? cssHex(fill.color) : 'none'}"${fill?.type === 'SOLID' && fill.opacity < 1 ? ` fill-opacity="${fill.opacity}"` : ''}${e.stroke ? ` stroke="${cssHex(e.stroke.color)}" stroke-width="${round(e.stroke.width)}"` : ''}/></svg>`;
            const made = buildSvgInto(tx, editor, svg, holder, { x: at.x, y: at.y, width: e.w, height: e.h }, common.name);
            if (made) {
              if (e.rot) tx.set(made, 'rotation', e.rot);
              if (fill && fill.type !== 'SOLID') tx.set(made, 'fills', [fill]);
            }
          } else if (e.geom === 'ellipse' || e.geom === 'circle') tx.create('ELLIPSE', holder, common);
          else if (e.geom === 'triangle') tx.create('POLYGON', holder, { ...common, pointCount: 3 });
          else if (e.geom === 'diamond') tx.create('POLYGON', holder, { ...common, pointCount: 4 });
          else if (e.geom === 'hexagon') tx.create('POLYGON', holder, { ...common, pointCount: 6 });
          else if (e.geom === 'star5') tx.create('STAR', holder, { ...common, pointCount: 5 });
          else tx.create('RECTANGLE', holder, { ...common, cornerRadius: round(e.radius) });
        }
        if (e.text) text(holder, e.text, e.name, e.rot, { x: e.x + e.w / 2, y: e.y + e.h / 2 });
        if (both && tx.doc.children(holder).length === 0) tx.delete(holder);
        return;
      }
    }
  };

  const made: NodeId[] = [];
  let last = after ?? slideIds(tx.doc, page).at(-1) ?? null;
  deck.slides.forEach((s, i) => {
    const bg = paintOf(s.background);
    const at = gridPlace(slideIds(tx.doc, page).length, { w: deck.width, h: deck.height });
    const frame = tx.create(
      'FRAME',
      page,
      {
        name: s.name || tr('Слайд {0}', i + 1),
        x: at.x,
        y: at.y,
        width: deck.width,
        height: deck.height,
        clipsContent: true,
        fills: bg ? [bg] : [solidOf({ r: 1, g: 1, b: 1, a: 1 })],
        slide: { notes: s.notes, ...(s.transition ? { transition: s.transition } : {}), ...(s.hidden ? { skip: true } : {}) },
      },
      last ? { after: last } : { at: 'end' },
    );
    for (const e of s.elements) place(frame, e);
    made.push(frame);
    last = frame;
  });
  return made;
}

/** What the person should know after an import: what was left out, fonts this computer does not have. */
export function importNote(deck: ImDeck, missingFonts: string[]): string {
  const names: Record<string, string> = { chart: tr('диаграммы'), smartart: tr('рисунки SmartArt'), object: tr('встроенные объекты'), picture: tr('картинки в формате WMF и HD Photo'), video: tr('видео и звук') };
  const left = [...deck.skipped].map(([k, n]) => `${names[k] ?? k} — ${n}`);
  const parts: string[] = [];
  if (left.length) parts.push(tr('Не перенесены (на их месте — рамки): {0}.', left.join(', ')));
  if (missingFonts.length) parts.push(tr('Шрифтов нет на этом компьютере: {0} — показаны похожими; их можно добавить в файл (Текст → шрифт → «Добавить файлы шрифтов»).', missingFonts.slice(0, 4).join(', ') + (missingFonts.length > 4 ? '…' : '')));
  return parts.join(' ');
}
