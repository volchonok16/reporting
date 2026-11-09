// PowerPoint import (FEAT-158), the way in: a .pptx file becomes a new
// presentation, or its slides go into the open one after the current slide.

import { tr, type Document, type NodeId } from '#core';
import type { TextMeasurer } from '#layout';
import { Editor } from '../editor.ts';
import { arrangeSlides, bindSlideColors, createSlidesDocument } from '../slides.ts';
import { isFontAvailable } from '../ui/font-picker.ts';
import { readPptxFile } from './import.ts';
import { buildDeck, cropMedia, importNote } from './import-build.ts';

async function read(file: Blob) {
  const deck = await readPptxFile(new Uint8Array(await file.arrayBuffer()));
  if (!deck.slides.length) throw new Error(tr('В файле нет слайдов.'));
  const media = await cropMedia(deck);
  const missing = [...deck.fonts].filter((f) => !isFontAvailable(f));
  return { deck, media, note: importNote(deck, missing) };
}

/** A new presentation from a .pptx: named after the file (or its title). */
export async function pptxToDocument(file: File, measurer: TextMeasurer): Promise<{ doc: Document; note: string }> {
  const { deck, media, note } = await read(file);
  const name = deck.title || file.name.replace(/\.pptx$/i, '');
  const doc = createSlidesDocument(name, true);
  const editor = new Editor(doc, measurer);
  editor.editPass = (tx, final) => final && arrangeSlides(doc, tx, editor.pageId, true);
  // Its colours become the theme's: «Тема/…» and the theme restyle the slides as they do the layouts.
  editor.commit(tr('Импорт PowerPoint'), (tx) => bindSlideColors(doc, tx, buildDeck(editor, tx, deck, media, null)));
  doc.clearHistory();
  return { doc, note: [tr('Импортировано слайдов: {0}.', deck.slides.length), note].filter(Boolean).join(' ') };
}

/** The slides of a .pptx into the open presentation after `after`; one undo step. `only` inserts that one slide. */
export async function importPptxInto(editor: Editor, file: File, after: NodeId | null, only?: number): Promise<{ slides: NodeId[]; note: string }> {
  const { deck, media, note } = await read(file);
  if (only !== undefined) {
    const slide = deck.slides[only];
    if (!slide) throw new Error(tr('В шаблоне нет такого слайда'));
    deck.slides = [slide];
  }
  let slides: NodeId[] = [];
  editor.commit(tr('Импорт PowerPoint'), (tx) => {
    slides = buildDeck(editor, tx, deck, media, after);
    bindSlideColors(editor.doc, tx, slides);
  });
  return { slides, note: [tr('Добавлено слайдов: {0}. Отменить — ⌘Z.', slides.length), note].filter(Boolean).join(' ') };
}
