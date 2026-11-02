// PDF export (FEAT-016): our own minimal PDF 1.4 writer, no dependencies.
// Each exported object becomes one page of its size (1 px = 1 pt, as in Figma).
// The page holds the object rendered by the same renderer as the canvas at the
// chosen scale, losslessly compressed (Flate) with an alpha mask, so the PDF
// looks exactly like the canvas. Vector PDF output is planned separately.

import { tr } from '#core';
import type { NodeId } from '#core';
import type { Canvas2DRenderer } from './canvas-renderer.ts';
import { rasterize } from './export.ts';
import type { SceneGraph } from './scene.ts';

const encoder = new TextEncoder();

/** zlib-compressed bytes (PDF FlateDecode) via the platform's CompressionStream. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Assembles PDF objects and writes the cross-reference table. */
export class PdfWriter {
  private readonly objects: (Uint8Array | null)[] = [];

  /** Reserves an object number (for forward references). */
  reserve(): number {
    this.objects.push(null);
    return this.objects.length;
  }

  set(ref: number, dict: string, stream?: Uint8Array): void {
    const head = encoder.encode(`${ref} 0 obj\n${dict}\n`);
    const parts: Uint8Array[] = [head];
    if (stream) parts.push(encoder.encode('stream\n'), stream, encoder.encode('\nendstream\n'));
    parts.push(encoder.encode('endobj\n'));
    this.objects[ref - 1] = concat(parts);
  }

  add(dict: string, stream?: Uint8Array): number {
    const ref = this.reserve();
    this.set(ref, dict, stream);
    return ref;
  }

  build(root: number, title: string): Uint8Array {
    const info = this.add(`<< /Title ${pdfString(title)} /Producer (Simmetrika) >>`);
    const header = encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const parts: Uint8Array[] = [header];
    const offsets: number[] = [];
    let offset = header.length;
    for (const obj of this.objects) {
      if (!obj) throw new Error(tr('PDF: незаполненный объект'));
      offsets.push(offset);
      parts.push(obj);
      offset += obj.length;
    }
    const xref = [`xref\n0 ${this.objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(encoder.encode(`${xref}trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    return concat(parts);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** PDF text string: UTF-16BE with BOM, so Cyrillic titles survive. */
function pdfString(text: string): string {
  let hex = 'FEFF';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += code.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

export interface PdfPageImage {
  /** Page size in points. */
  width: number;
  height: number;
  /** Pixel data (RGBA) of the rendered page. */
  pixels: { width: number; height: number; data: Uint8ClampedArray };
}

/** Builds a PDF from rendered pages. Pure function of its input (testable without a browser canvas). */
export async function buildPdf(pages: readonly PdfPageImage[], title: string): Promise<Uint8Array> {
  const pdf = new PdfWriter();
  const catalog = pdf.reserve();
  const pagesRef = pdf.reserve();
  const kids: number[] = [];
  for (const page of pages) {
    const { width: pw, height: ph, data } = page.pixels;
    const rgb = new Uint8Array(pw * ph * 3);
    const alpha = new Uint8Array(pw * ph);
    let opaque = true;
    for (let i = 0, j = 0, k = 0; i < data.length; i += 4, j += 3, k++) {
      rgb[j] = data[i]!;
      rgb[j + 1] = data[i + 1]!;
      rgb[j + 2] = data[i + 2]!;
      alpha[k] = data[i + 3]!;
      if (data[i + 3] !== 255) opaque = false;
    }
    let smask = '';
    if (!opaque) {
      const mask = await deflate(alpha);
      const maskRef = pdf.add(`<< /Type /XObject /Subtype /Image /Width ${pw} /Height ${ph} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>`, mask);
      smask = ` /SMask ${maskRef} 0 R`;
    }
    const image = await deflate(rgb);
    const imageRef = pdf.add(`<< /Type /XObject /Subtype /Image /Width ${pw} /Height ${ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${image.length} >>`, image);
    const w = round(page.width);
    const h = round(page.height);
    const content = encoder.encode(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);
    const contentRef = pdf.add(`<< /Length ${content.length} >>`, content);
    kids.push(pdf.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageRef} 0 R >> >> /Contents ${contentRef} 0 R >>`));
  }
  pdf.set(pagesRef, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  return pdf.build(catalog, title);
}

function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Exports nodes as a PDF with one page per node. `scale` is the pixel density of the pages. */
export async function exportPdf(renderer: Canvas2DRenderer, scene: SceneGraph, ids: readonly NodeId[], scale = 2): Promise<Blob> {
  const pages: PdfPageImage[] = [];
  for (const id of ids) {
    const { canvas, bounds } = await rasterize(renderer, scene, id, scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(tr('Canvas 2D недоступен'));
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pages.push({ width: bounds.width, height: bounds.height, pixels: { width: image.width, height: image.height, data: image.data } });
  }
  const title = ids.length === 1 ? scene.doc.get(ids[0]!, 'name') : scene.doc.get(scene.doc.rootId, 'name');
  const bytes = await buildPdf(pages, title);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
