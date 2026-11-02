// Export of a diagram (FEAT-090), as DocPlan's menu had it: SVG, PNG with the
// background or without it, PDF on an A4 sheet, and the text of the diagram.
// Plus one of our own: the SVG on the clipboard, which a design takes as layers.
// The picture is prepared by DocPlan's own code (engine.exportSvg): framed by
// what is drawn, the renderers' background rect dropped for "no background",
// SVG filters dropped (they blur blocks in a PNG).

import type { Document } from '#core';
import { buildPdf } from '#render';
import { embeddedFonts } from '../fonts.ts';
import type { DiagramEngine } from './engine.ts';

/** @font-face of a family kept in the file: a picture made into a PNG does not see the page's fonts. */
export function fontFaceCss(doc: Document, family: string): string {
  const faces: string[] = [];
  for (const f of embeddedFonts(doc)) {
    if (f.family !== family) continue;
    const blob = doc.store.blobs.get(f.hash);
    if (!blob) continue;
    faces.push(`@font-face{font-family:"${family}";src:url(data:${blob.mime};base64,${blob.data});font-weight:${f.weight === 0 ? '1 1000' : f.weight};font-style:${f.italic ? 'italic' : 'normal'}}`);
  }
  return faces.join('');
}

export interface PreparedSvg {
  svgString: string;
  w: number;
  h: number;
}

/** The picture ready for a file: with `background`, or transparent when it is null. */
export function prepareSvg(engine: DiagramEngine, svg: SVGSVGElement, background: string, transparent: boolean, fontCss = ''): PreparedSvg {
  const p = engine.exportSvg(svg, { background, transparent });
  // What the editor adds for itself (the caret's line, nodes picked to move) is not part of the picture.
  const svgString = (fontCss ? p.svgString.replace(/<svg\b[^>]*>/, (open) => `${open}<style>${fontCss}</style>`) : p.svgString).replace(/\s?\b(is-source-line-active|is-selected)\b/g, '').replace(/<rect[^>]*class="mm-marquee"[^>]*\/>/g, '');
  return { svgString, w: p.w, h: p.h };
}

/** A standalone SVG file. */
export function svgFile(p: PreparedSvg): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${p.svgString}`;
}

/** Draws the SVG onto a canvas `scale` times its size. */
export async function rasterizePrepared(p: PreparedSvg, scale: number): Promise<HTMLCanvasElement> {
  return rasterize(p, scale);
}

async function rasterize(p: PreparedSvg, scale: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([p.svgString], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(p.w * scale));
    canvas.height = Math.max(1, Math.round(p.h * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A PNG twice the diagram's size (sharp on screens and slides); transparent when prepared so. */
export async function pngBlob(p: PreparedSvg): Promise<Blob> {
  // Very big diagrams stay under the browsers' canvas limit.
  const scale = Math.min(2, 8000 / Math.max(p.w, p.h));
  const canvas = await rasterize(p, scale);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

/** A PDF of one A4 page (landscape for a wide diagram), the diagram fitted with margins, on the background. */
export async function pdfBlob(p: PreparedSvg, background: string, title: string): Promise<Blob> {
  const landscape = p.w > p.h;
  const page = landscape ? { w: 842, h: 595 } : { w: 595, h: 842 };
  const margin = 28;
  const fit = Math.min((page.w - margin * 2) / p.w, (page.h - margin * 2) / p.h);
  // 3 pixels per point: print quality.
  const dpp = 3;
  const canvas = document.createElement('canvas');
  canvas.width = page.w * dpp;
  canvas.height = page.h * dpp;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawn = await rasterize(p, fit * dpp);
  ctx.drawImage(drawn, Math.round(((page.w - p.w * fit) / 2) * dpp), Math.round(((page.h - p.h * fit) / 2) * dpp));
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = await buildPdf([{ width: page.w, height: page.h, pixels: { width: pixels.width, height: pixels.height, data: pixels.data } }], title);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** A JPEG picture for the file's card: the diagram fitted into width × height on the background. */
export async function thumbnailDataUrl(p: PreparedSvg, background: string, width = 480, height = 300): Promise<string> {
  const fit = Math.min((width - 24) / p.w, (height - 24) / p.h, 2);
  const drawn = await rasterize(p, fit);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(drawn, Math.round((width - drawn.width) / 2), Math.round((height - drawn.height) / 2));
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Saves a blob under a file name (the browser's download). */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from the diagram's name: no characters file systems refuse. */
export function fileNameOf(name: string, ext: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'diagram';
  return `${base}.${ext}`;
}
