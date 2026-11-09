// Готовые презентации. «Новая айдентика» — файл репрайса: тексты остаются слоями, не картинкой.

import { tr } from '#core';

export interface SlideTemplate {
  id: string;
  name: string;
  hint: string;
  file: string;
}

export function slideTemplates(): SlideTemplate[] {
  return [
    {
      id: 'identity',
      name: tr('Новая айдентика'),
      hint: tr('Репрайс: слайды, в которых можно править текст'),
      file: '/apps/web/templates/novaya-aydentika.pptx',
    },
  ];
}

let identityFile: Promise<File> | null = null;

/** The identity deck, fetched once. Slide names are the titles inside the file. */
export async function identitySlides(): Promise<{ name: string }[]> {
  const { readPptxFile } = await import('./pptx/import.ts');
  const file = await cachedIdentityFile();
  const deck = await readPptxFile(new Uint8Array(await file.arrayBuffer()));
  return deck.slides.map((slide, index) => ({ name: slide.name || tr('Слайд {0}', index + 1) }));
}

export function cachedIdentityFile(): Promise<File> {
  identityFile ??= loadSlideTemplate('identity');
  return identityFile;
}

export async function loadSlideTemplate(id: string): Promise<File> {
  const template = slideTemplates().find((item) => item.id === id);
  if (!template) throw new Error(tr('Нет такого шаблона'));
  const response = await fetch(template.file);
  if (!response.ok) throw new Error(tr('Шаблон «{0}» не загрузился', template.name));
  return new File([await response.arrayBuffer()], `${template.name}.pptx`, {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
