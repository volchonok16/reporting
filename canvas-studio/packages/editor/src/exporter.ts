// Export of layers by their export settings (stage "Export and import"):
// PNG / JPG / WebP, SVG and vector PDF; several files are packed into one ZIP.

import { htmlDocument } from './html-export.ts';
import { exportScale, exportScaleLabel, tr } from '#core';
import type { ExportSetting, NodeId } from '#core';
import { exportNode, exportSvg, exportVectorPdf, layerPicture, zip, type Canvas2DRenderer } from '#render';
import { outlineFonts } from './text-outline.ts';
import type { Editor } from './editor.ts';

export const DEFAULT_EXPORT: ExportSetting = { format: 'PNG', scale: 2, suffix: '' };

const EXT: Record<ExportSetting['format'], string> = { PNG: 'png', JPG: 'jpg', WEBP: 'webp', SVG: 'svg', PDF: 'pdf', HTML: 'html' };
const MIME = { PNG: 'image/png', JPG: 'image/jpeg', WEBP: 'image/webp' } as const;

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export';
}

/** Words of a name template: {name}, {page}, {frame}, {parent}, {file}, {n}, {date}. */
export const NAME_TOKENS = ['{name}', '{page}', '{frame}', '{parent}', '{file}', '{n}', '{date}'] as const;

/**
 * A file name from the template. "/" (in the template or in a layer name, as
 * in Figma) makes folders inside the ZIP; every part is made safe for disks.
 */
export function exportPath(editor: Editor, id: NodeId, template: string, index: number): string {
  const d = editor.doc;
  const page = d.pageOf(id);
  let frame: NodeId = id;
  for (let p = d.parent(frame); p && p !== page && d.type(p) !== 'PAGE'; p = d.parent(p)) frame = p;
  const parent = d.parent(id);
  const values: Record<string, string> = {
    '{name}': String(d.get(id, 'name') ?? ''),
    '{page}': page ? String(d.get(page, 'name') ?? '') : '',
    '{frame}': String(d.get(frame, 'name') ?? ''),
    '{parent}': parent && d.type(parent) !== 'PAGE' ? String(d.get(parent, 'name') ?? '') : '',
    '{file}': String(d.get(d.rootId, 'name') ?? ''),
    '{n}': String(index + 1),
    '{date}': new Date().toISOString().slice(0, 10),
  };
  const filled = (template.trim() || '{name}').replace(/\{(name|page|frame|parent|file|n|date)\}/g, (m) => values[m] ?? '');
  const parts = filled.split('/').map((p) => p.trim()).filter(Boolean).map(safeName);
  return parts.length ? parts.join('/') : 'export';
}

/** Two files with one name would overwrite each other in the ZIP: the second becomes "name (2)". */
function uniqueName(taken: Map<string, number>, name: string): string {
  const key = name.toLowerCase();
  const count = (taken.get(key) ?? 0) + 1;
  taken.set(key, count);
  if (count === 1) return name;
  const dot = name.lastIndexOf('.');
  const next = `${name.slice(0, dot)} (${count})${name.slice(dot)}`;
  return taken.has(next.toLowerCase()) ? uniqueName(taken, name) : (taken.set(next.toLowerCase(), 1), next);
}

export interface ExportResult {
  files: { name: string; data: Uint8Array }[];
  /** Effects a format could not express (reported to the user). */
  notes: string[];
}

export async function renderExports(editor: Editor, renderer: Canvas2DRenderer, ids: readonly NodeId[], settingsOf: (id: NodeId) => readonly ExportSetting[]): Promise<ExportResult> {
  const files: ExportResult['files'] = [];
  const notes = new Set<string>();
  // Several layers exported to PDF with the same settings become one multi-page PDF.
  const pdfPlan = ids.map((id) => settingsOf(id).filter((s) => s.format === 'PDF'));
  const pdfKeys = new Set(pdfPlan.flatMap((list) => list.map((s) => `${s.scale}|${s.suffix}`)));
  const together = ids.length > 1 && pdfKeys.size === 1 && pdfPlan.every((list) => list.length === 1);
  if (together) {
    const s = pdfPlan[0]![0]!;
    const blob = await exportVectorPdf(renderer, editor.scene, editor.measurer, ids, Math.max(2, s.scale));
    files.push({ name: `${safeName(editor.doc.get(editor.doc.rootId, 'name'))}${s.suffix}.pdf`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  const template = String(editor.doc.get(editor.doc.rootId, 'exportNameTemplate') ?? '');
  const taken = new Map<string, number>();
  for (const f of files) taken.set(f.name.toLowerCase(), 1);
  for (const [index, id] of ids.entries()) {
    const base = exportPath(editor, id, template, index);
    for (const s of settingsOf(id)) {
      if (together && s.format === 'PDF') continue;
      const raster = s.format !== 'SVG' && s.format !== 'PDF' && s.format !== 'HTML';
      const suffix = s.suffix || (raster && s.size ? `@${exportScaleLabel(s)}` : raster && s.scale !== 1 ? `@${s.scale}x` : '');
      // «512w»: the scale that makes this layer 512 px wide.
      const scale = exportScale(s, editor.doc.get(id, 'width'), editor.doc.get(id, 'height'));
      const name = uniqueName(taken, `${base}${suffix}.${EXT[s.format]}`);
      let data: Uint8Array;
      if (s.format === 'SVG') {
        const outlines = s.svgOutlineText ? await outlineFonts(editor.doc, id, notes) : undefined;
        // Warped layers go in as pictures: their image fills have to be decoded first.
        await renderer.images.settled();
        const picture = (n: NodeId) => layerPicture(renderer, editor.scene, n);
        const { svg, skipped } = exportSvg(editor.scene, editor.measurer, [id], renderer.images, { currentColor: s.svgCurrentColor, responsive: s.svgResponsive, outlines, picture });
        for (const k of skipped) notes.add(tr('SVG не поддерживает «{0}» — эффект пропущен', k));
        data = new TextEncoder().encode(svg);
      } else if (s.format === 'HTML') {
        data = new TextEncoder().encode(htmlDocument(editor, renderer, id));
      } else if (s.format === 'PDF') {
        data = new Uint8Array(await (await exportVectorPdf(renderer, editor.scene, editor.measurer, [id], Math.max(2, s.scale))).arrayBuffer());
      } else {
        data = new Uint8Array(await (await exportNode(renderer, editor.scene, id, { scale, format: MIME[s.format], quality: 0.92 })).arrayBuffer());
      }
      files.push({ name, data });
    }
  }
  return { files, notes: [...notes] };
}

/** One file is downloaded as is; several go into a ZIP named after the file. */
export async function packExports(editor: Editor, result: ExportResult): Promise<{ blob: Blob; name: string } | null> {
  if (result.files.length === 0) return null;
  if (result.files.length === 1) {
    const f = result.files[0]!;
    const ext = f.name.split('.').pop()!;
    const type = ext === 'svg' ? 'image/svg+xml' : ext === 'pdf' ? 'application/pdf' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    // A single file is downloaded, not unpacked: no folders in its name.
    return { blob: new Blob([f.data as BlobPart], { type }), name: f.name.split('/').pop()! };
  }
  return { blob: await zip(result.files), name: `${safeName(editor.doc.get(editor.doc.rootId, 'name'))}.zip` };
}
