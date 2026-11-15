// Import from Sketch (step 9): a .sketch becomes a new file. Unpacked and converted here, in the browser.

import { tr, type Document } from '#core';
import { unzip } from '../fig/archive.ts';
import { isFontAvailable } from '../ui/font-picker.ts';
import { convertSketch, type SketchArchive } from './convert.ts';

/** A .sketch by its name. */
export function isSketchFile(file: File): boolean {
  return /\.sketch$/i.test(file.name);
}

/** The archive's JSON: the document, its pages in order, and the pictures. */
export async function readSketch(bytes: Uint8Array): Promise<SketchArchive> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(bytes, (name) => name.endsWith('.json') || name.startsWith('images/'));
  } catch {
    throw new Error(tr('Это не файл Sketch или он повреждён.'));
  }
  const json = (name: string) => {
    const b = files.get(name);
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  };
  const document = json('document.json');
  // Before Sketch 43 the file was a database, not JSON.
  if (!document) throw new Error(tr('Файл Sketch старше версии 43: откройте его в новом Sketch и сохраните заново.'));
  const pages = ((document.pages ?? []) as { _ref?: string }[]).map((p) => json(`${p._ref}.json`)).filter(Boolean);
  return { document, pages, files };
}

export async function importSketch(file: File): Promise<{ doc: Document; note: string }> {
  const name = file.name.replace(/\.sketch$/i, '') || tr('Из Sketch');
  const archive = await readSketch(new Uint8Array(await file.arrayBuffer()));
  const r = convertSketch(archive, name);
  const parts = [tr('Импортировано из Sketch: страниц — {0}, слоёв — {1}.', r.doc.pages().length, r.count)];
  if (r.components > 0 || r.instances > 0) parts.push(tr('Символов: {0}, экземпляров: {1}.', r.components, r.instances));
  if (r.unlinked > 0) parts.push(tr('Экземпляров без символа в файле: {0}. Они остались пустыми.', r.unlinked));
  const other = [...r.skipped].reduce((s, [, n]) => s + n, 0);
  if (other > 0) parts.push(tr('Не перенесено элементов: {0}.', other));
  if (r.missingImages > 0) parts.push(tr('Картинок нет в файле: {0}. На их месте серая заливка.', r.missingImages));
  const lacking = [...r.fonts].filter((f) => !isFontAvailable(f));
  if (lacking.length > 0) parts.push(tr('Нет шрифтов на этом компьютере: {0}. Текст показан заменой, шрифт можно встроить в файл.', lacking.join(', ')));
  return { doc: r.doc, note: parts.join(' ') };
}
