// The 23 kinds of diagrams (FEAT-090, from DocPlan's «Схемы»): groups for the
// picker, names, a line on what each is for, and DocPlan's icons (24×24 strokes).

import { tr } from '#core';

export interface DiagramKind {
  id: string;
  label: string;
  /** What it is for (the picker's second line). */
  hint: string;
  /** Inner SVG of a 24×24 stroked icon. */
  icon: string;
}

export interface DiagramKindGroup {
  name: string;
  kinds: DiagramKind[];
}

export function diagramKindGroups(): DiagramKindGroup[] {
  return [
    { name: tr('Карты'), kinds: [
      { id: 'radial', label: tr('Радиальная'), hint: tr('Идеи от центра во все стороны'), icon: '<circle cx="12" cy="12" r="10"/> <line x1="12" y1="2" x2="12" y2="22"/> <line x1="2" y1="12" x2="22" y2="12"/>' },
      { id: 'classic', label: tr('Классическая карта'), hint: tr('Карта мыслей: ветки влево и вправо'), icon: '<ellipse cx="12" cy="12" rx="4" ry="3"/> <path d="M4 8C7 10 9 11 12 12"/> <path d="M4 16C7 14 9 13 12 12"/> <path d="M20 8C17 10 15 11 12 12"/> <path d="M20 16C17 14 15 13 12 12"/>' },
      { id: 'horizontal', label: tr('Иерархическая'), hint: tr('Дерево слева направо или сверху вниз'), icon: '<path d="M3 3v18h18"/> <path d="M7 16l4 4 4-4"/>' },
    ] },
    { name: tr('Процессы'), kinds: [
      { id: 'flowchart', label: tr('Блок-схема'), hint: tr('Шаги, развилки и стрелки'), icon: '<rect x="3" y="3" width="7" height="5" rx="1"/> <rect x="14" y="3" width="7" height="5" rx="1"/> <rect x="8" y="16" width="8" height="5" rx="1"/> <path d="M6.5 8v3h11V8M12 11v5"/>' },
      { id: 'bpmn', label: tr('BPMN'), hint: tr('Бизнес-процесс: роли, события, решения'), icon: '<rect x="3" y="5" width="18" height="14" rx="2"/> <path d="M8 5v14M16 5v14"/> <line x1="3" y1="12" x2="21" y2="12"/>' },
      { id: 'sequence', label: tr('Последовательность'), hint: tr('Кто кому что отправляет и в каком порядке'), icon: '<path d="M4 6h16M4 12h10M4 18h6"/> <circle cx="18" cy="18" r="2"/>' },
      { id: 'journey', label: tr('Путь пользователя'), hint: tr('Этапы глазами клиента: действия, настроение, боли'), icon: '<circle cx="5" cy="12" r="2"/> <circle cx="12" cy="7" r="2"/> <circle cx="12" cy="17" r="2"/> <circle cx="19" cy="12" r="2"/> <path d="M7 12h3M14 9l2 2M14 15l2-2"/>' },
    ] },
    { name: tr('Планы'), kinds: [
      { id: 'gantt', label: tr('Гант'), hint: tr('Задачи на шкале времени с зависимостями'), icon: '<rect x="2" y="3" width="20" height="4" rx="1"/> <rect x="4" y="9" width="16" height="4" rx="1"/> <rect x="6" y="15" width="12" height="4" rx="1"/>' },
      { id: 'timeline', label: tr('Таймлайн'), hint: tr('События и вехи по датам'), icon: '<circle cx="5" cy="12" r="2"/> <circle cx="12" cy="12" r="2"/> <circle cx="19" cy="12" r="2"/> <path d="M7 12h3M14 12h3"/>' },
      { id: 'rollout', label: tr('Роллаут'), hint: tr('Фазы запуска и задачи с ролями'), icon: '<rect x="3" y="8" width="5" height="13" rx="1"/> <rect x="10" y="8" width="5" height="13" rx="1"/> <rect x="17" y="8" width="5" height="13" rx="1"/> <path d="M4 5h16"/> <circle cx="6" cy="5" r="1.2" fill="currentColor"/> <circle cx="12" cy="5" r="1.2" fill="currentColor"/> <circle cx="18" cy="5" r="1.2" fill="currentColor"/>' },
      { id: 'lanes', label: tr('Дорожки'), hint: tr('Роли × фазы, задачи в ячейках'), icon: '<path d="M3 6h18M3 12h18M3 18h18"/> <path d="M8 6v12M14 6v12"/>' },
      { id: 'ribbon', label: tr('Лента фаз'), hint: tr('Фазы лентой сверху вниз, задачи списком'), icon: '<circle cx="6" cy="6" r="2"/> <circle cx="6" cy="12" r="2"/> <circle cx="6" cy="18" r="2"/> <path d="M10 6h10M10 12h10M10 18h7"/>' },
      { id: 'secret', label: tr('Канбан'), hint: tr('Колонки и карточки задач'), icon: '<circle cx="12" cy="12" r="10"/> <path d="M12 16v-3M12 8v.01"/>' },
    ] },
    { name: tr('Данные'), kinds: [
      { id: 'sankey', label: tr('Потоки'), hint: tr('Потоки между этапами с объёмами'), icon: '<path d="M3 7h4c3 0 3 4 6 4h8"/> <path d="M3 17h4c3 0 3-4 6-4h8"/> <path d="M3 12h4"/>' },
      { id: 'wave', label: tr('Волнообразная'), hint: tr('Мягкие потоки: источник → приёмник и величина'), icon: '<path d="M3 12 Q6 4 9 12 T15 12 T21 12"/>' },
      { id: 'pulsewave', label: tr('Динамика волны'), hint: tr('Одна метрика на нескольких срезах'), icon: '<path d="M3 15c3 0 3-6 6-6s3 2 6 2 3-5 6-5"/> <path d="M3 18c3 0 3-2 6-2s3 5 6 5 3-3 6-3" opacity="0.7"/>' },
      { id: 'treemap', label: tr('Плитки'), hint: tr('Доли целого прямоугольниками'), icon: '<rect x="3" y="3" width="18" height="18" rx="2"/> <path d="M3 12h18M12 12v9M7 3v9"/>' },
      { id: 'heatmap', label: tr('Тепловая карта'), hint: tr('Матрица значений цветом'), icon: '<rect x="3" y="3" width="7" height="7" rx="1"/> <rect x="14" y="3" width="7" height="7" rx="1"/> <rect x="3" y="14" width="7" height="7" rx="1"/> <rect x="14" y="14" width="7" height="7" rx="1"/>' },
      { id: 'waterfall', label: tr('Водопад'), hint: tr('Как складывается итог: плюсы и минусы'), icon: '<path d="M4 18V10"/> <path d="M9 18V6"/> <path d="M14 18v-5"/> <path d="M19 18V8"/> <path d="M4 10h5M9 6h5M14 13h5" opacity="0.7"/>' },
      { id: 'ridgeline', label: tr('Хребты данных'), hint: tr('Форма распределения по группам'), icon: '<path d="M3 17c2-4 4-6 6-4s4 2 6-2 4-4 6-2"/> <path d="M3 12c2-3 4-5 6-3s4 1 6-1 4-3 6-1"/>' },
      { id: 'fan', label: tr('Веер значимости'), hint: tr('Радар, где толщина луча — вес критерия'), icon: '<circle cx="12" cy="12" r="3"/> <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>' },
    ] },
    { name: tr('Оценка'), kinds: [
      { id: 'reversibility', label: tr('Карта обратимости'), hint: tr('Где решение трудно отменить'), icon: '<path d="M3 20h18"/> <path d="M3 20V6"/> <path d="M7 16l3-5 3 2 4-7"/> <circle cx="17" cy="6" r="1.5" fill="currentColor"/>' },
      { id: 'perspective', label: tr('Перспективы'), hint: tr('Одна система глазами разных ролей'), icon: '<rect x="2" y="4" width="6" height="16" rx="1"/> <rect x="9" y="4" width="6" height="16" rx="1"/> <rect x="16" y="4" width="6" height="16" rx="1"/>' },
    ] },
  ];
}

export function isDiagramKind(id: string): boolean {
  return diagramKindGroups().some((g) => g.kinds.some((k) => k.id === id));
}

export function diagramKind(id: string): DiagramKind {
  for (const g of diagramKindGroups()) for (const k of g.kinds) if (k.id === id) return k;
  return diagramKindGroups()[0]!.kinds[0]!;
}
