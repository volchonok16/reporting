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

export async function loadSlideTemplate(id: string): Promise<File> {
  const template = slideTemplates().find((item) => item.id === id);
  if (!template) throw new Error(tr('Нет такого шаблона'));
  const response = await fetch(template.file);
  if (!response.ok) throw new Error(tr('Шаблон «{0}» не загрузился', template.name));
  return new File([await response.arrayBuffer()], `${template.name}.pptx`, {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
