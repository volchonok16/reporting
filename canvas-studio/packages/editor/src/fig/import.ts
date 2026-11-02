// Import from Figma: a .fig ("File → Save local copy" in Figma) becomes a new
// file. Reading, decompressing and converting all happen in the browser.

import { tr, type Document } from '#core';
import { refreshBoard } from '#components';
import { CanvasTextMeasurer } from '#render';
import { embedGoogleFamilies } from '../fonts.ts';
import { isFontAvailable } from '../ui/font-picker.ts';
import { FigError, readFig } from './archive.ts';
import { convertFig } from './convert.ts';

/** A .fig by its name or its first bytes (a ZIP or "fig-kiwi"). */
export async function isFigFile(file: File): Promise<boolean> {
  if (/\.(fig|jam)$/i.test(file.name)) return true;
  const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  return head === 'fig-kiwi' || head === 'fig-jam.';
}

export interface FigImport {
  doc: Document;
  /** What to tell the person: what came over and what did not. */
  note: string;
}

export async function importFig(file: File): Promise<FigImport> {
  const name = file.name.replace(/\.(fig|jam)$/i, '') || tr('Из Figma');
  let archive;
  try {
    archive = await readFig(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(error instanceof FigError ? tr('Это не файл Figma или он повреждён. Сохраните его в Figma заново: «Файл → Сохранить локальную копию».') : tr('Не удалось прочитать файл Figma: {0}', error instanceof Error ? error.message : String(error)));
  }
  // A FigJam board becomes a board of ours (FEAT-086).
  const board = archive.kind === 'figjam';
  const result = convertFig(archive, name, board);
  const pages = result.doc.pages().length;
  const parts = board && result.board
    ? [tr('Импортирована доска FigJam: стикеров — {0}, фигур — {1}, связей — {2}.', result.board.stickies, result.board.shapes, result.board.connectors)]
    : [tr('Импортировано из Figma: страниц — {0}, слоёв — {1}.', pages, result.count)];
  // Stickies fit their text, shapes their outline, connectors their ends: the board pass over everything.
  if (board) result.doc.transact((tx) => refreshBoard(result.doc, tx, new CanvasTextMeasurer()), { undoable: false });
  if (result.components > 0 || result.instances > 0) parts.push(tr('Компонентов: {0}, экземпляров: {1} — связаны, переопределения сохранены.', result.components, result.instances));
  if (result.styles > 0) parts.push(tr('Стилей: {0} — слои к ним привязаны.', result.styles));
  if (result.unlinked > 0) parts.push(tr('Экземпляров без компонента в файле: {0} — остались пустыми рамками.', result.unlinked));
  const other = [...result.skipped].reduce((s, [, n]) => s + n, 0);
  if (other > 0) parts.push(tr('Не перенесено элементов: {0}.', other));
  if (result.missingImages > 0) parts.push(tr('Картинок нет в файле: {0} — на их месте серая заливка.', result.missingImages));
  const lacking = [...result.fonts].filter((f) => !isFontAvailable(f));
  // Fonts this computer lacks come from Google Fonts when it has them: embedded, the text looks as in Figma for everyone.
  const google = lacking.length ? await embedGoogleFamilies(result.doc, lacking, false) : { embedded: [], missing: [], failed: [] };
  if (google.embedded.length > 0) parts.push(tr('Шрифты загружены из Google Fonts и встроены в файл: {0}.', google.embedded.join(', ')));
  const missing = [...google.missing, ...google.failed];
  if (missing.length > 0) parts.push(tr('Нет шрифтов на этом компьютере: {0} — текст показан заменой; шрифт можно встроить в файл.', missing.join(', ')));
  return { doc: result.doc, note: parts.join(' ') };
}
