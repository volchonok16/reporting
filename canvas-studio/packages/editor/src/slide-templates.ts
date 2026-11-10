// Готовые слайды T2 B2B. Тексты остаются слоями, не картинкой.

import { tr } from '#core';

export interface SlideTemplate {
  id: string;
  name: string;
  hint: string;
  file: string;
}

export const SLIDE_TEMPLATE_ID = 't2-b2b';

/** Имена слайдов шаблона, по порядку в файле. В самом pptx названий нет. */
export const TEMPLATE_SLIDE_NAMES = [
  'Титульный',
  'Разделитель, тёмный',
  'Разделитель, светлый',
  'Титульный, тёмный',
  'Цитата',
  'Оглавление',
  'Оглавление с подразделами',
  'Текст и факты',
  'Текст и факты со сноской',
  'Две колонки, бирюзовый',
  'Две колонки, светлый',
  'Три шага, бирюзовый',
  'Три шага, светлый',
  'Карточки, бирюзовые',
  'Карточки, светлые',
  'Структура рынка',
  'Динамика охвата',
  'Доли рынка',
  'Таймлайн',
  'Инвентарь и профиль',
  'Таблица форматов',
  'Таблица форматов, вариант 2',
  'Условия закупки',
  'Кейсы',
  'Заголовок и метрики',
  'Как сейчас и как будет',
  'Финал, тёмный',
  'Финал, светлый',
  'Финал с контактами',
] as const;

export function slideTemplates(): SlideTemplate[] {
  return [
    {
      id: SLIDE_TEMPLATE_ID,
      name: tr('Шаблон T2 B2B'),
      hint: tr('Титульный, разделы, таблицы и финал'),
      file: '/apps/web/templates/t2-b2b.pptx',
    },
  ];
}

export function templateSlideNames(): string[] {
  return TEMPLATE_SLIDE_NAMES.map((name) => tr(name));
}

/** Слайды шаблона для меню «+ Слайд». Имена заданы здесь, файл для списка не читается. */
export function identitySlides(): { name: string }[] {
  return templateSlideNames().map((name) => ({ name }));
}

let identityFile: Promise<File> | null = null;

export function cachedIdentityFile(): Promise<File> {
  identityFile ??= loadSlideTemplate(SLIDE_TEMPLATE_ID);
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
