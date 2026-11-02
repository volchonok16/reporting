// Starter file (item 11 of the October list): a short tour on several pages.
// "Start here" — a product card built with auto layout and a button component
// set; "Auto layout" — live examples to poke at; "Prototype" — two connected
// screens with a flow; "Plugins" — HTML import and PowerPoint export step by
// step, with a slide ready to export; "Together" — sharing and live work.
// Every page explains itself with notes right on the canvas.

import { combineAsVariants, convertFrameToComponent, createInstance } from '#components';
import { hexToColor, solid, tr, type Color, type NodeId, type Transaction } from '#core';
import type { Editor } from './editor.ts';
import { buildTravelApp, labelCopies } from './demo-app.ts';

const c = (hex: string): Color => hexToColor(hex)!;
const mac = () => typeof navigator !== 'undefined' && navigator.platform.includes('Mac');
/** "Mod" and "Alt" in shortcuts as this computer writes them. */
const keys = (text: string) => text.replace(/Mod/g, mac() ? '⌘' : 'Ctrl').replace(/Alt/g, mac() ? '⌥' : 'Alt');

const INK = '#1E1E1E';
const MUTED = '#5C5C5C';
const BLUE = '#4F5BD5';

export function buildDemo(editor: Editor): void {
  const doc = editor.doc;
  const start = editor.pageId;
  let labels: [string, string][] = [];
  editor.commit(tr('Пример'), (tx) => {
    tx.set(start, 'name', tr('Начните здесь'));
    labels = buildTravelApp(editor, tx, start, keys);
    buildAutoLayout(tx, tx.create('PAGE', doc.rootId, { name: tr('Адаптивная раскладка'), backgroundColor: doc.get(start, 'backgroundColor') }));
    buildPrototype(tx, tx.create('PAGE', doc.rootId, { name: tr('Прототип'), backgroundColor: doc.get(start, 'backgroundColor') }));
    buildPlugins(tx, tx.create('PAGE', doc.rootId, { name: tr('Плагины'), backgroundColor: doc.get(start, 'backgroundColor') }));
    buildTogether(tx, tx.create('PAGE', doc.rootId, { name: tr('Совместная работа'), backgroundColor: doc.get(start, 'backgroundColor') }));
  });
  editor.commit(tr('Пример'), (tx) => labelCopies(editor, tx, labels));
  editor.doc.clearHistory();
}

/** A yellow sticky note with a title and lines of text. */
function note(tx: Transaction, parent: NodeId, x: number, y: number, title: string, lines: readonly string[], width = 360): NodeId {
  const frame = tx.create('FRAME', parent, {
    name: title,
    x,
    y,
    width,
    layoutMode: 'VERTICAL',
    sizingV: { mode: 'HUG' },
    itemSpacing: 8,
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 20,
    paddingLeft: 20,
    cornerRadius: 12,
    fills: [solid(c('#FFF8E1'))],
  });
  text(tx, frame, title, 18, 700, '#3D3D3D');
  for (const line of lines) text(tx, frame, keys(line), 14, 400, '#3D3D3D');
  return frame;
}

function text(tx: Transaction, parent: NodeId, characters: string, fontSize: number, fontWeight: number, color: string, fill = true): NodeId {
  return tx.create('TEXT', parent, {
    name: characters.length > 40 ? `${characters.slice(0, 40)}…` : characters,
    characters,
    fontSize,
    fontWeight,
    lineHeight: { unit: 'PERCENT', value: 140 },
    textAutoResize: fill ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
    ...(fill ? { sizingH: { mode: 'FILL' as const } } : {}),
    fills: [solid(c(color))],
  });
}

// ---------------------------------------------------------------- Start here

/** The previous start page (a product card); kept for reference, not built. */
export function buildStart(editor: Editor, tx: Transaction, page: NodeId): void {
  const card = tx.create('FRAME', page, {
    name: tr('Карточка товара'),
    x: 0,
    y: 0,
    width: 320,
    layoutMode: 'VERTICAL',
    sizingV: { mode: 'HUG' },
    itemSpacing: 12,
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 20,
    paddingLeft: 16,
    cornerRadius: 16,
    fills: [solid(c('#FFFFFF'))],
    strokes: [solid(c('#E6E6E6'))],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 8 }, radius: 24, spread: 0, visible: true }],
  });
  tx.create('RECTANGLE', card, {
    name: tr('Обложка'),
    height: 180,
    sizingH: { mode: 'FILL' },
    cornerRadius: 10,
    fills: [
      {
        type: 'GRADIENT_LINEAR',
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        stops: [
          { position: 0, color: c('#7B61FF') },
          { position: 1, color: c(BLUE) },
        ],
        opacity: 1,
        visible: true,
      },
    ],
  });
  tx.create('TEXT', card, {
    name: tr('Заголовок'),
    characters: tr('Беспроводные наушники'),
    fontSize: 20,
    fontWeight: 600,
    textAutoResize: 'HEIGHT',
    sizingH: { mode: 'FILL' },
    fills: [solid(c(INK))],
  });
  tx.create('TEXT', card, {
    name: tr('Описание'),
    characters: tr('Активное шумоподавление, до 30 часов работы и быстрая зарядка за 10 минут.'),
    fontSize: 14,
    lineHeight: { unit: 'PERCENT', value: 145 },
    textAutoResize: 'HEIGHT',
    sizingH: { mode: 'FILL' },
    fills: [solid(c('#6B6B6B'))],
  });
  const row = tx.create('FRAME', card, {
    name: tr('Цена и кнопка'),
    layoutMode: 'HORIZONTAL',
    sizingH: { mode: 'FILL' },
    sizingV: { mode: 'HUG' },
    counterAlign: 'CENTER',
    itemSpacing: 12,
    fills: [],
    clipsContent: false,
  });
  tx.create('TEXT', row, {
    name: tr('Цена'),
    characters: '12 990 ₽',
    fontSize: 18,
    fontWeight: 700,
    sizingH: { mode: 'FR', value: 1 },
    textAutoResize: 'HEIGHT',
    fills: [solid(c(INK))],
  });
  const set = buildButtonSet(editor, tx, page);
  createInstance(editor.doc, tx, editor.doc.children(set)[0]!, row);

  // Notes stack in a column, so their real heights never overlap.
  const column = tx.create('FRAME', page, { name: tr('Подсказки'), x: 380, y: 0, layoutMode: 'VERTICAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, itemSpacing: 24, fills: [], clipsContent: false });
  note(tx, column, 0, 0, tr('С чего начать'), [
    tr('F — фрейм, R — прямоугольник, O — эллипс, T — текст'),
    tr('Shift+A — обернуть выделение в адаптивную раскладку'),
    tr('Перетаскивание объекта в фрейм делает его дочерним'),
    tr('Двойной щелчок — войти внутрь группы или редактировать текст'),
    tr('Mod+Alt+K — сделать компонент, Alt+2 — панель ресурсов'),
    tr('Mod+K — палитра команд, Mod+\\ — скрыть интерфейс'),
  ]);
  note(tx, column, 0, 0, tr('Что в этом файле'), [
    tr('Страницы — слева вверху. Пройдите их по порядку:'),
    tr('• Адаптивная раскладка — живые примеры: потяните за край, поменяйте текст.'),
    tr('• Прототип — два экрана, связанные нажатием. Нажмите ▷ справа вверху.'),
    tr('• Плагины — импорт HTML-страницы и экспорт в PowerPoint.'),
    tr('• Совместная работа — как поделиться файлом и работать вместе.'),
    tr('Справка — кнопка ? справа вверху или меню ☰ → «Справка».'),
  ]);
  note(tx, page, 800, 140, tr('Компоненты'), [
    tr('«Кнопка» — компонент с двумя вариантами. В карточке стоит её копия.'),
    tr('Поменяйте цвет в компоненте — изменится и копия. У копии справа можно переключить вариант.'),
  ], 300);
}

/** «Кнопка» with two variants, placed to the right of the notes. */
function buildButtonSet(editor: Editor, tx: Transaction, page: NodeId): NodeId {
  const doc = editor.doc;
  const variants = [
    [tr('Вид=Основная'), BLUE, '#FFFFFF', null],
    [tr('Вид=Вторичная'), '#FFFFFF', BLUE, BLUE],
  ] as const;
  const components = variants.map(([name, fill, label, stroke], i) => {
    const frame = tx.create('FRAME', page, {
      name,
      x: 800 + i * 160,
      y: 0,
      layoutMode: 'HORIZONTAL',
      sizingH: { mode: 'HUG' },
      sizingV: { mode: 'HUG' },
      paddingTop: 10,
      paddingBottom: 10,
      paddingLeft: 18,
      paddingRight: 18,
      cornerRadius: 8,
      fills: [solid(c(fill))],
      strokes: stroke ? [solid(c(stroke))] : [],
    });
    tx.create('TEXT', frame, {
      name: tr('Подпись'),
      characters: tr('В корзину'),
      fontSize: 14,
      fontWeight: 600,
      fills: [solid(c(label))],
    });
    return convertFrameToComponent(doc, tx, frame);
  });
  return combineAsVariants(doc, tx, components, tr('Кнопка'));
}

// ---------------------------------------------------------------- Auto layout

function pill(tx: Transaction, parent: NodeId, label: string, fill: string, color: string): NodeId {
  const p = tx.create('FRAME', parent, {
    name: label,
    layoutMode: 'HORIZONTAL',
    sizingH: { mode: 'HUG' },
    sizingV: { mode: 'HUG' },
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 12,
    paddingRight: 12,
    cornerRadius: 99,
    fills: [solid(c(fill))],
  });
  text(tx, p, label, 13, 500, color, false);
  return p;
}

function buildAutoLayout(tx: Transaction, page: NodeId): void {
  // 1. A button hugs its text.
  const button = tx.create('FRAME', page, {
    name: tr('Кнопка по содержимому'),
    x: 0,
    y: 0,
    layoutMode: 'HORIZONTAL',
    sizingH: { mode: 'HUG' },
    sizingV: { mode: 'HUG' },
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 20,
    paddingRight: 20,
    cornerRadius: 10,
    fills: [solid(c(BLUE))],
  });
  text(tx, button, tr('Поменяйте этот текст'), 15, 600, '#FFFFFF', false);
  note(tx, page, 0, 80, tr('1. По содержимому'), [tr('Кнопка обтягивает текст: допишите слово — она вырастет. Отступы задаются справа, в разделе «Адаптивная раскладка».')], 320);

  // 2. A row: label fills, value hugs.
  const row = tx.create('FRAME', page, {
    name: tr('Строка: заполнить и по содержимому'),
    x: 400,
    y: 0,
    width: 360,
    layoutMode: 'HORIZONTAL',
    sizingV: { mode: 'HUG' },
    counterAlign: 'CENTER',
    itemSpacing: 12,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 16,
    paddingRight: 16,
    cornerRadius: 10,
    fills: [solid(c('#FFFFFF'))],
    strokes: [solid(c('#E6E6E6'))],
  });
  text(tx, row, tr('Доставка'), 14, 400, MUTED);
  text(tx, row, tr('Бесплатно'), 14, 600, INK, false);
  note(tx, page, 400, 80, tr('2. Заполнить'), [tr('«Доставка» занимает всё свободное место (Заполнить), «Бесплатно» — по содержимому. Потяните строку за правый край.')], 360);

  // 3. A column list with a fixed gap.
  const list = tx.create('FRAME', page, {
    name: tr('Список'),
    x: 820,
    y: 0,
    width: 240,
    layoutMode: 'VERTICAL',
    sizingV: { mode: 'HUG' },
    itemSpacing: 8,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    paddingRight: 12,
    cornerRadius: 10,
    fills: [solid(c('#FFFFFF'))],
    strokes: [solid(c('#E6E6E6'))],
  });
  for (const item of [tr('Профиль'), tr('Заказы'), tr('Избранное'), tr('Настройки')]) {
    const it = tx.create('FRAME', list, { name: item, layoutMode: 'HORIZONTAL', sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, cornerRadius: 6, fills: [solid(c('#F5F5F5'))] });
    text(tx, it, item, 14, 500, INK);
  }
  note(tx, page, 820, 260, tr('3. Столбец'), [tr('Пункты встают друг под другом с промежутком 8. Перетащите пункт выше или ниже — остальные подвинутся. Удалите один — список сожмётся.')], 300);

  // 4. Tags that wrap.
  const tags = tx.create('FRAME', page, {
    name: tr('Теги с переносом'),
    x: 1160,
    y: 0,
    width: 280,
    layoutMode: 'HORIZONTAL',
    layoutWrap: true,
    sizingV: { mode: 'HUG' },
    itemSpacing: 8,
    counterAxisSpacing: 8,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 12,
    paddingRight: 12,
    cornerRadius: 10,
    fills: [solid(c('#FFFFFF'))],
    strokes: [solid(c('#E6E6E6'))],
  });
  for (const tag of [tr('дизайн'), tr('интерфейсы'), tr('прототипы'), tr('компоненты'), tr('переменные'), tr('адаптивная раскладка')]) pill(tx, tags, tag, '#E8F4FF', '#0B6BB8');
  note(tx, page, 1160, 160, tr('4. Перенос'), [tr('Теги переносятся на новую строку, когда не помещаются. Сделайте блок уже — строк станет больше.')], 280);
}

// ---------------------------------------------------------------- Prototype

function screen(tx: Transaction, page: NodeId, x: number, name: string, title: string, body: string, buttonLabel: string): { frame: NodeId; button: NodeId } {
  const frame = tx.create('FRAME', page, {
    name,
    x,
    y: 0,
    width: 360,
    height: 640,
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingTop: 72,
    paddingBottom: 32,
    paddingLeft: 24,
    paddingRight: 24,
    fills: [solid(c('#FFFFFF'))],
  });
  text(tx, frame, title, 26, 700, INK);
  text(tx, frame, body, 15, 400, MUTED);
  const button = tx.create('FRAME', frame, {
    name: buttonLabel,
    layoutMode: 'HORIZONTAL',
    sizingH: { mode: 'FILL' },
    sizingV: { mode: 'HUG' },
    primaryAlign: 'CENTER',
    paddingTop: 14,
    paddingBottom: 14,
    cornerRadius: 12,
    fills: [solid(c(BLUE))],
  });
  text(tx, button, buttonLabel, 16, 600, '#FFFFFF', false);
  return { frame, button };
}

function buildPrototype(tx: Transaction, page: NodeId): void {
  const one = screen(tx, page, 0, tr('Экран 1 — Приветствие'), tr('Привет!'), tr('Это первый экран прототипа. Нажмите кнопку — откроется второй.'), tr('Дальше'));
  const two = screen(tx, page, 440, tr('Экран 2 — Готово'), tr('Готово'), tr('Переход настроен на вкладке «Прототип» справа: выделите кнопку и посмотрите.'), tr('Назад'));
  const transition = { type: 'DISSOLVE' as const, duration: 300, easing: { type: 'EASE_OUT' as const } };
  tx.set(one.button, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: two.frame, transition }] }]);
  tx.set(two.button, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]);
  tx.set(page, 'flowStartingPoints', [{ nodeId: one.frame, name: tr('Знакомство'), description: '' }]);
  note(tx, page, 880, 0, tr('Как это работает'), [
    tr('Нажмите ▷ справа вверху (или Mod+Alt+Enter) — откроется просмотр с первого экрана.'),
    tr('Вкладка «Прототип» справа: выделите кнопку — увидите связь «По нажатию → Перейти к».'),
    tr('Новая связь: потяните синий «+» с края слоя на другой экран.'),
  ]);
}

// ---------------------------------------------------------------- Plugins

function buildPlugins(tx: Transaction, page: NodeId): void {
  note(tx, page, 0, 0, tr('Импорт HTML → слои'), [
    tr('Кнопка </> на панели инструментов или «Файл → Импорт HTML».'),
    tr('1. Перетащите .html или папку сайта — или вставьте код (например, ответ нейросети).'),
    tr('2. Выберите ширину экрана и посмотрите превью.'),
    tr('3. «Импортировать» — страница станет фреймами с адаптивной раскладкой, текстом, картинками и иконками.'),
    tr('Отменить импорт — Mod+Z.'),
  ], 400);
  note(tx, page, 440, 0, tr('Экспорт в PowerPoint'), [
    tr('Кнопка с экраном на панели инструментов или «Файл → Экспорт в PowerPoint».'),
    tr('1. Выделите фреймы — каждый станет слайдом (ничего не выделено — все фреймы страницы).'),
    tr('2. Порядок — как на холсте: по рядам сверху вниз, слева направо.'),
    tr('3. «Скачать PPTX» — текст останется текстом, фигуры — фигурами. Открывается в PowerPoint, Keynote, Google Slides.'),
    tr('Попробуйте на слайде ниже.'),
  ], 400);
  const slide = tx.create('FRAME', page, {
    name: tr('Слайд для экспорта'),
    x: 0,
    y: 380,
    width: 960,
    height: 540,
    layoutMode: 'VERTICAL',
    primaryAlign: 'CENTER',
    itemSpacing: 16,
    paddingLeft: 72,
    paddingRight: 72,
    fills: [{ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, stops: [{ position: 0, color: c('#1B1B3A') }, { position: 1, color: c('#3B2A8C') }], opacity: 1, visible: true }],
  });
  text(tx, slide, tr('Квартальные итоги'), 48, 700, '#FFFFFF');
  text(tx, slide, tr('Этот фрейм станет слайдом PowerPoint: заголовок и текст можно будет править прямо в презентации.'), 22, 400, '#C9C6F5');
  const stats = tx.create('FRAME', slide, { name: tr('Цифры'), layoutMode: 'HORIZONTAL', sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, itemSpacing: 16, fills: [] });
  for (const [value, label] of [['+38%', tr('выручка')], ['12 400', tr('клиентов')], ['4,8', tr('оценка')]] as const) {
    const box = tx.create('FRAME', stats, { name: label, layoutMode: 'VERTICAL', sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, itemSpacing: 4, paddingTop: 16, paddingBottom: 16, paddingLeft: 20, paddingRight: 20, cornerRadius: 12, fills: [solid(c('#FFFFFF'), 0.08)] });
    text(tx, box, value, 32, 700, '#FFFFFF');
    text(tx, box, label, 14, 400, '#C9C6F5');
  }
}

// ---------------------------------------------------------------- Together

function buildTogether(tx: Transaction, page: NodeId): void {
  note(tx, page, 0, 0, tr('Поделиться'), [
    tr('Войдите — файлы будут храниться на сервере и открываться с любого устройства.'),
    tr('«Поделиться» справа вверху: пригласите по email с ролью (редактировать, комментировать, смотреть) или откройте доступ по ссылке — с паролем и сроком.'),
    tr('Ссылка на выделенный слой открывает файл прямо на нём.'),
  ], 400);
  note(tx, page, 440, 0, tr('Работать вместе'), [
    tr('Правки соавторов видны сразу, их курсоры и выделения — тоже.'),
    tr('Щелчок по аватару вверху — наблюдать за человеком: видите то же, что он.'),
    tr('Спотлайт (палитра команд, Mod+K) — все в файле наблюдают за вами.'),
    tr('/ над холстом — чат курсором: сообщение у вашего указателя видят все.'),
  ], 400);
  note(tx, page, 880, 0, tr('На телефоне'), [tr('Файл открывается для просмотра: одним пальцем двигать холст, двумя — масштаб. Править — на компьютере или планшете.')], 320);
}
