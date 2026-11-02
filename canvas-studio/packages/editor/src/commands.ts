// Command registry: every action is a command with an id, a label and optional
// shortcuts. Menus, the command palette (FR-UI-020) and keyboard handling all
// read from here, so an action is never reachable from only one place.

import { tr } from '#core';
import { IS_MAC } from './keyboard.ts';
import type { Editor, ToolId } from './editor.ts';
import { editableTextOf, isBoardObjectOrConnector, SHAPE_KINDS, STAMPS } from './board.ts';
import { sortIntoSections, textToStickies } from './board-smart.ts';
import { selectMatching } from './batch-rename.ts';
import { variantSetOf } from './multi-edit.ts';
import { changeLang, savedNudge } from './prefs.ts';
import { flipTextOnPath, putTextOnPath, takeTextOffPath } from './text-on-path.ts';
import { copyBoardLook, fitSections, pasteBoardLook, toggleSectionContents } from './board-actions.ts';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Shortcuts in "Mod+Shift+K" notation; the first one is shown in the UI. */
  keys?: string[];
  run: () => void;
  /** Other words people look for it with (both languages), for the palette. */
  keywords?: string;
  /** Hidden from the palette (e.g. arrow nudges). */
  hidden?: boolean;
  /** Fires repeatedly while the key is held. */
  repeat?: boolean;
  /** Only in designs or only on boards (FEAT-083); none — everywhere. */
  mode?: 'design' | 'board';
}

export interface CommandHost {
  editor: Editor;
  openPalette: () => void;
  newFile: () => void;
  openFile: (accept?: string) => void;
  saveFile: () => void;
  exportSelection: () => void;
  copyAs: (format: 'PNG' | 'SVG' | 'CSS') => void;
  importSvg: () => void;
  /** HTML page → layers (FEAT-036); 'prompt' — a page the model writes by a description (FEAT-172). */
  importHtml: (start?: 'prompt') => void;
  /** The selected frame changed by a description (FEAT-172). */
  editLayout: () => void;
  /** A .fig from Figma → a new file. */
  importFig: () => void;
  exportPptx: () => void;
  openHelp: () => void;
  openExample: () => void;
  openTemplates: () => void;
  /** Asks for a link and puts its card on the board (FEAT-160). */
  insertLink: () => void;
  insertCode: () => void;
  openStickers: (tab: 'stickers' | 'components') => void;
  /** Design: device mockup panel (phone / tablet / laptop / desktop / watch). */
  openDeviceMockups: () => void;
  openIcons: () => void;
  openContent: () => void;
  /** Abstract shape generator (as the Blobs plugin). */
  openBlob: () => void;
  openBackdrop: () => void;
  openDoodle: () => void;
  openTable: () => void;
  /** Waves generator (as the Get Waves plugin). */
  openWaves: () => void;
  /** Board: Mod+Enter on a sticky — a blank one beside it (FigJam). */
  boardNeighbour: () => void;
  /** Board: the name under one's stickies (FEAT-083). */
  boardName: () => void;
  /** Board: the list of sections and the mini-map. */
  boardSections?: () => void;
  boardMinimap?: () => void;
  toggleComments: () => void;
  replaceFonts: () => void;
  /** «Стили → переменные…» with a preview (FR-STY-003). */
  stylesToVariables: () => void;
  /** «Переменные в код» (FR-VAR-041). */
  variablesToCode: () => void;
  openSettings: () => void;
  removeBackground: () => void;
  cropImage: () => void;
  eraseImage: () => void;
  showHistory: () => void;
  findReplace: () => void;
  showVersions: () => void;
  /** Branches of the file; `create` — with the new-branch form ready. */
  showBranches: (create: boolean) => void;
  /** In a branch: bring the main file's changes in. */
  updateBranch: () => void;
  /** In a branch: merge it into the main file (opens the main file with the merge window). */
  mergeBranch: () => void;
  editLink: () => void;
  findSimilar: () => void;
  translateText: () => void;
  /** Opens the ✦ menu of smart actions over the tool dock. */
  openSmart: () => void;
  toggleUi: (which: 'all' | 'left' | 'right') => void;
  /** Where the tool panel stands; remembered in this browser. */
  setDockPlace: (place: 'bottom' | 'top' | 'left') => void;
  /** Size of the interface text and controls (the canvas is not affected); remembered in this browser. */
  setUiScale: (scale: number) => void;
  renameSelection: () => void;
  showAssets: () => void;
  /** Table of variables (section 11). */
  openVariables: () => void;
  showLayers: () => void;
  collapseLayers: () => void;
  expandLayers: () => void;
  /** The list of files in this browser. */
  openFiles: () => void;
  /** Focuses the layer search (Mod+F). */
  findLayers: () => void;
  placeImage: () => void;
  /** A big picture at its own size, cut into pieces (as Insert Big Image). */
  placeBigImage: () => void;
  /** Enter: finishes the pen path or point editing; returns true if it did. */
  confirm: () => boolean;
  cancel: () => boolean;
  /** Prototype viewer over the editor, or in a new tab (FR-PRT-050). */
  present: (newTab?: boolean) => void;
  /** Cursor chat: a message next to one's pointer for everyone in the file. */
  cursorChat: () => void;
  emotes: () => void;
  /** Spotlight: everyone in the file follows this person (again — ends it). */
  spotlight: () => void;
}

export function createCommands(host: CommandHost): Command[] {
  const e = host.editor;
  const tool = (id: ToolId) => () => e.setTool(id);
  // The step is read at each press: it is set in «Настройки» (as Figma's «Nudge amount»).
  const nudge = (dx: number, dy: number, big = false) => () => {
    const step = big ? savedNudge().big : savedNudge().small;
    e.nudge(dx * step, dy * step);
  };
  const isBoardDoc = () => e.doc.get(e.doc.rootId, 'fileKind') === 'BOARD';
  const list: Command[] = [
    // Tools
    { id: 'tool.select', label: tr('Инструмент: Выделение и перемещение'), group: tr('Инструменты'), keys: ['V'], run: tool('select') },
    { id: 'tool.frame', mode: 'design', label: tr('Инструмент: Фрейм'), group: tr('Инструменты'), keys: ['F', 'A'], run: tool('frame') },
    { id: 'tool.rectangle', mode: 'design', label: tr('Инструмент: Прямоугольник'), group: tr('Инструменты'), keys: ['R'], run: tool('rectangle') },
    { id: 'tool.ellipse', mode: 'design', label: tr('Инструмент: Эллипс'), group: tr('Инструменты'), keys: ['O'], run: tool('ellipse') },
    { id: 'tool.line', mode: 'design', label: tr('Инструмент: Линия'), group: tr('Инструменты'), keys: ['L'], run: tool('line') },
    { id: 'tool.arrow', mode: 'design', label: tr('Инструмент: Стрелка'), group: tr('Инструменты'), keys: ['Shift+L'], run: tool('arrow') },
    { id: 'tool.polygon', mode: 'design', label: tr('Инструмент: Многоугольник'), group: tr('Инструменты'), run: tool('polygon') },
    { id: 'tool.star', mode: 'design', label: tr('Инструмент: Звезда'), group: tr('Инструменты'), run: tool('star') },
    // Shift+S is the section tool by the spec (FR-CNV-070), as in Figma; the star is in the shapes list and the palette.
    // Prototype (section 13)
    { id: 'prototype.present', mode: 'design', label: tr('Просмотр прототипа'), group: tr('Прототип'), keys: ['Mod+Alt+Enter'], run: () => host.present(false) },
    { id: 'prototype.presentTab', mode: 'design', label: tr('Просмотр прототипа в новой вкладке'), group: tr('Прототип'), run: () => host.present(true) },
    { id: 'view.comments', label: tr('Показать или скрыть комментарии'), group: tr('Вид'), keys: ['Shift+C'], keywords: 'комментарии обсуждения метки comments pins', run: () => host.toggleComments() },
    { id: 'panel.design', mode: 'design', label: tr('Вкладка «Дизайн»'), group: tr('Вид'), run: () => e.prototype.setMode('design') },
    { id: 'panel.prototype', mode: 'design', label: tr('Вкладка «Прототип»'), group: tr('Вид'), keys: ['Shift+E'], run: () => {
      // In point editing Shift+E is the eraser, as in Figma.
      if (e.vectorEdit) e.setVectorTool('eraser');
      else e.prototype.setMode(e.prototype.mode === 'prototype' ? 'design' : 'prototype');
    } },
    { id: 'panel.code', mode: 'design', label: tr('Вкладка «Код» (для разработчиков)'), group: tr('Вид'), keys: ['Shift+D'], run: () => e.prototype.setMode(e.prototype.mode === 'code' ? 'design' : 'code') },
    // Board tools (FEAT-083), keys as in FigJam.
    { id: 'tool.sticky', mode: 'board', label: tr('Инструмент: Стикер'), group: tr('Инструменты'), keys: ['S'], run: tool('sticky') },
    { id: 'tool.shape', mode: 'board', label: tr('Инструмент: Фигура'), group: tr('Инструменты'), keys: ['R'], run: () => {
      if (e.boardPrefs.shape === 'ELLIPSE') e.boardPrefs.shape = 'RECTANGLE';
      e.setTool('shape');
    } },
    { id: 'tool.shapeEllipse', mode: 'board', label: tr('Инструмент: Овал'), group: tr('Инструменты'), keys: ['O'], run: () => {
      e.boardPrefs.shape = 'ELLIPSE';
      e.setTool('shape');
    } },
    { id: 'tool.connector', mode: 'board', label: tr('Инструмент: Связь'), group: tr('Инструменты'), keys: ['X'], keywords: 'стрелка connector arrow line', run: tool('connector') },
    { id: 'tool.marker', mode: 'board', label: tr('Инструмент: Маркер'), group: tr('Инструменты'), keys: ['M'], keywords: 'рисовать карандаш draw pencil', run: tool('marker') },
    { id: 'tool.highlighter', mode: 'board', label: tr('Инструмент: Выделитель'), group: tr('Инструменты'), keys: ['Shift+M'], run: tool('highlighter') },
    { id: 'tool.eraser', label: tr('Инструмент: Ластик (стирает линии карандаша и маркера)'), group: tr('Инструменты'), keys: ['Shift+Backspace'], keywords: 'стереть стерка eraser erase', run: tool('eraser') },
    { id: 'tool.tape', mode: 'board', label: tr('Инструмент: Скотч'), group: tr('Инструменты'), keys: ['W'], keywords: 'washi tape скотч лента полоска приклеить', run: tool('tape') },
    { id: 'tool.stamp', mode: 'board', label: tr('Инструмент: Штамп'), group: tr('Инструменты'), keys: ['E'], keywords: 'реакция эмодзи голос reaction emoji', run: tool('stamp') },
    // The board's shapes and stamps, one by one (the tool lists in the dock).
    ...SHAPE_KINDS.map((k): Command => ({ id: `tool.shape.${k.shape}`, mode: 'board', hidden: true, label: tr('Фигура: {0}', k.label), group: tr('Инструменты'), run: () => {
      e.boardPrefs.shape = k.shape;
      e.setTool('shape');
    } })),
    ...STAMPS.map((s): Command => ({ id: `tool.stamp.${s.id}`, mode: 'board', hidden: true, label: tr('Штамп: {0}', s.label), group: tr('Инструменты'), run: () => {
      e.boardPrefs.stamp = s.id;
      e.setTool('stamp');
    } })),
    { id: 'board.sortColor', mode: 'board', label: tr('Упорядочить стикеры по цвету'), group: tr('Объект'), keywords: 'сортировать разделы группы sort', run: () => sortIntoSections(e, 'color') },
    { id: 'board.sortAuthor', mode: 'board', label: tr('Упорядочить стикеры по автору'), group: tr('Объект'), keywords: 'сортировать разделы группы sort', run: () => sortIntoSections(e, 'author') },
    { id: 'board.sortVotes', mode: 'board', label: tr('Упорядочить стикеры по голосам'), group: tr('Объект'), keywords: 'сортировать разделы группы sort', run: () => sortIntoSections(e, 'votes') },
    { id: 'board.sections', mode: 'board', label: tr('Разделы доски: перейти к разделу'), group: tr('Вид'), keywords: 'раздел секция навигация список sections navigate', run: () => host.boardSections?.() },
    { id: 'board.minimap', mode: 'board', label: tr('Мини-карта: показать или скрыть'), group: tr('Вид'), keywords: 'карта обзор навигация minimap overview', run: () => host.boardMinimap?.() },
    { id: 'board.fitSection', mode: 'board', label: tr('Подогнать раздел под содержимое'), group: tr('Объект'), keywords: 'раздел секция размер fit section', run: () => fitSections(e) },
    { id: 'board.toggleSectionContents', mode: 'board', label: tr('Скрыть или показать содержимое раздела'), group: tr('Объект'), keywords: 'раздел секция свернуть hide section', run: () => toggleSectionContents(e) },
    { id: 'board.textToStickies', mode: 'board', label: tr('Разбить текст на стикеры'), group: tr('Объект'), keywords: 'список строки стикеры', run: () => textToStickies(e) },
    { id: 'board.myName', mode: 'board', label: tr('Как подписывать мои стикеры…'), group: tr('Вид'), keywords: 'имя автор подпись name author', run: () => host.boardName() },
    { id: 'board.authors', mode: 'board', label: tr('Авторы стикеров: показать или скрыть'), group: tr('Вид'), run: () => {
      const on = !e.doc.get(e.doc.rootId, 'boardAuthors');
      e.commit(on ? tr('Показать авторов стикеров') : tr('Скрыть авторов стикеров'), (tx) => tx.set(e.doc.rootId, 'boardAuthors', on));
    } },
    { id: 'tool.section', label: tr('Инструмент: Секция'), group: tr('Инструменты'), keys: ['Shift+S'], run: tool('section') },
    { id: 'tool.text', label: tr('Инструмент: Текст'), group: tr('Инструменты'), keys: ['T'], run: tool('text') },
    { id: 'tool.image', label: tr('Вставить изображение…'), group: tr('Инструменты'), keys: ['Mod+Shift+K'], run: () => host.placeImage() },
    { id: 'tool.bigImage', label: tr('Вставить большое изображение…'), group: tr('Инструменты'), run: () => host.placeBigImage() },
    { id: 'object.rotationOrigin', mode: 'design', label: tr('Показать центр поворота'), group: tr('Объект'), keys: ['Alt+R'], keywords: 'точка вращения ось поворот origin rotate', run: () => e.toggleRotationOrigin() },
    { id: 'tool.scale', mode: 'design', label: tr('Инструмент: Масштаб'), group: tr('Инструменты'), keys: ['K'], keywords: 'масштабировать пропорционально scale resize обводки текст', run: tool('scale') },
    { id: 'tool.pen', mode: 'design', label: tr('Инструмент: Перо'), group: tr('Инструменты'), keys: ['P'], run: tool('pen') },
    { id: 'tool.pencil', mode: 'design', label: tr('Инструмент: Карандаш'), group: tr('Инструменты'), keys: ['Shift+P'], keywords: 'рисовать от руки набросок draw sketch freehand', run: tool('pencil') },
    { id: 'tool.hand', label: tr('Инструмент: Рука'), group: tr('Инструменты'), keys: ['H'], run: tool('hand') },
    { id: 'tool.comment', label: tr('Комментарии: оставить комментарий на холсте'), group: tr('Инструменты'), keys: ['C'], run: tool('comment') },
    { id: 'tool.eyedropper', label: tr('Пипетка: взять цвет с холста'), group: tr('Инструменты'), keys: ['I'], run: tool('eyedropper') },
    // Precision (stage 5)
    { id: 'help.open', label: tr('Справка: как пользоваться редактором'), group: tr('Справка'), keys: ['F1'], run: () => host.openHelp() },
    { id: 'help.example', label: tr('Открыть пример: обучающий файл'), group: tr('Справка'), run: () => host.openExample() },
    { id: 'view.settings', label: tr('Настройки: язык, размер интерфейса, панель инструментов…'), group: tr('Вид'), keywords: 'шаг сдвига стрелки nudge amount тема язык', run: () => host.openSettings() },
    // Language names stay in their own language, so anyone can find theirs.
    {
      id: 'layout.absolute',
      label: tr('Вывести из адаптивной раскладки / вернуть'),
      group: tr('Объект'),
      run: () => {
        if (!e.toggleAbsolute()) e.toast(tr('Выделите слой внутри фрейма с адаптивной раскладкой'));
      },
    },
    { id: 'text.link', label: tr('Ссылка в тексте…'), group: tr('Текст'), run: () => host.editLink() },
    { id: 'smart.open', mode: 'design', label: tr('Умные действия для выделения ✦'), group: tr('Объект'), keys: ['Mod+J'], run: () => host.openSmart() },
    { id: 'text.translate', label: tr('Перевести текст…'), group: tr('Текст'), run: () => host.translateText() },
    { id: 'text.replaceFonts', mode: 'design', label: tr('Заменить шрифты…'), group: tr('Текст'), keywords: 'шрифт замена старый новый replace fonts missing', run: () => host.replaceFonts() },
    { id: 'component.similar', label: tr('Найти похожие компоненты'), group: tr('Компоненты'), run: () => host.findSimilar() },
    { id: 'image.removeBg', label: tr('Удалить фон у картинки'), group: tr('Объект'), run: () => host.removeBackground() },
    { id: 'image.crop', label: tr('Обрезать картинку…'), group: tr('Объект'), run: () => host.cropImage() },
    { id: 'image.erase', label: tr('Стереть кистью…'), group: tr('Объект'), run: () => host.eraseImage() },
    {
      id: 'object.tidy',
      label: tr('Привести в порядок: имена слоёв, целые пиксели, отступы по сетке 4, привязка к переменным'),
      group: tr('Объект'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./tidy.ts').then(({ applyTidy, tidySummary }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const summary = tidySummary(applyTidy(e, roots));
          e.toast(summary ? tr('Готово: {0}. Отменить — {1}.', summary, IS_MAC ? '⌘Z' : 'Ctrl+Z') : tr('Уже в порядке: имена, пиксели, отступы и переменные не требуют правки.'));
        });
      },
    },
    {
      id: 'smart.fillData',
      label: tr('Заполнить данными: имена, цены, даты, города вместо заглушек'),
      group: tr('Объект'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./fill-data.ts').then(({ planFillData }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const plan = planFillData(e.doc, roots, (id) => e.isInstanceLayer(id));
          if (!plan.length) return e.toast(tr('Заполнять нечего: ни заглушек, ни повторяющихся текстов, ни цен, дат и имён.'));
          e.commit(tr('Заполнить данными'), (tx) => {
            for (const p of plan) {
              tx.set(p.id, 'characters', p.text);
              tx.set(p.id, 'textRuns', []);
            }
          });
          e.toast(tr('Заполнено текстов: {0}. Отменить — {1}.', plan.length, IS_MAC ? '⌘Z' : 'Ctrl+Z'));
        });
      },
    },
    {
      id: 'smart.contrast',
      label: tr('Проверить контраст текста (WCAG) и исправить'),
      group: tr('Текст'),
      run: () => {
        void import('./smart-ops.ts').then(({ contrastIssues, fixContrastIssues }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const issues = contrastIssues(e, roots);
          if (!issues.length) return e.toast(tr('Контраст в порядке: весь текст читается по WCAG AA.'));
          const fixed = e.doc.readOnly ? 0 : fixContrastIssues(e, issues);
          const rest = issues.length - fixed;
          e.toast(
            [fixed ? tr('Исправлено текстов: {0} — цвет затемнён или осветлён до нормы, оттенок тот же.', fixed) : '', rest ? tr('Ещё {0} — цвет из переменной или стиля: поправьте его там.', rest) : ''].filter(Boolean).join(' '),
          );
          if (rest) e.setSelection(issues.filter((i) => !i.fix && e.doc.pageOf(i.id) === e.pageId).map((i) => i.id));
        });
      },
    },
    {
      id: 'smart.contrastShow',
      label: tr('Показать текст с низким контрастом на странице'),
      group: tr('Текст'),
      run: () => {
        void import('./smart-ops.ts').then(({ contrastIssues }) => {
          const issues = contrastIssues(e, [...e.doc.children(e.pageId)]);
          if (!issues.length) return e.toast(tr('Контраст в порядке: весь текст читается по WCAG AA.'));
          e.setSelection(issues.map((i) => i.id));
          e.toast(tr('Выделено текстов с низким контрастом: {0}. Исправить — ✦ «Исправить контраст».', issues.length));
        });
      },
    },
    {
      id: 'smart.textStyles',
      label: tr('Подобрать текстовые стили: привязать тексты с такими же параметрами'),
      group: tr('Текст'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./smart-ops.ts').then(({ textStyleMatches, bindTextStyles }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const n = bindTextStyles(e, textStyleMatches(e, roots));
          e.toast(n ? tr('Привязано к стилям текстов: {0}.', n) : tr('Текстов, совпадающих со стилями, не найдено.'));
        });
      },
    },
    {
      id: 'smart.repeats',
      label: tr('Повторы → компонент: одинаковые блоки становятся компонентом и экземплярами'),
      group: tr('Компоненты'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./repeats.ts').then(({ findRepeats, applyRepeats }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const groups = findRepeats(e, roots);
          if (!groups.length) return e.toast(tr('Одинаковых блоков не найдено.'));
          const made = applyRepeats(e, groups);
          const blocks = groups.reduce((n, g) => n + g.ids.length, 0);
          e.setSelection(made);
          e.toast(tr('Готово: компонентов — {0}, блоков стало экземплярами — {1}. Тексты и картинки остались свои. Отменить — {2}.', made.length, blocks - made.length, IS_MAC ? '⌘Z' : 'Ctrl+Z'));
        });
      },
    },
    {
      id: 'smart.cleanup',
      label: tr('Почистить слои: пустые, группы из одного слоя, лишние обёртки'),
      group: tr('Объект'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./cleanup.ts').then(({ applyCleanup, cleanupCount }) => {
          const roots = e.selection.length ? e.topLevelSelection() : [...e.doc.children(e.pageId)];
          const n = cleanupCount(applyCleanup(e, roots));
          e.toast(n ? tr('Убрано лишних слоёв: {0}. На экране ничего не сдвинулось. Отменить — {1}.', n, IS_MAC ? '⌘Z' : 'Ctrl+Z') : tr('Лишних слоёв нет.'));
        });
      },
    },
    {
      id: 'smart.textStyleCreate',
      label: tr('Создать текстовый стиль из выделенного текста'),
      group: tr('Текст'),
      run: () => {
        const id = e.selection[0];
        if (e.doc.readOnly || !id || e.doc.type(id) !== 'TEXT') return e.toast(tr('Выделите текст'));
        void import('./smart.ts').then(({ textStyleName }) => {
          const name = textStyleName(e.doc.get(id, 'fontSize'));
          e.createStyle('TEXT', 'textStyleId', name);
          e.toast(tr('Стиль «{0}» создан, текст к нему привязан. Для других текстов — кнопка стилей у шрифта.', name));
        });
      },
    },
    {
      id: 'smart.sameImages',
      label: tr('Найти ту же картинку в файле'),
      group: tr('Объект'),
      run: () => {
        void import('./smart-ops.ts').then(({ sameImages }) => {
          const found = sameImages(e, e.selection);
          const here = found.get(e.pageId) ?? [];
          const elsewhere = [...found].filter(([p]) => p !== e.pageId);
          const others = elsewhere.reduce((n, [, ids]) => n + ids.length, 0);
          if (!here.length && !others) return e.toast(tr('Больше нигде в файле этой картинки нет.'));
          if (here.length) e.setSelection([...e.selection, ...here]);
          else {
            e.setPage(elsewhere[0]![0]);
            e.setSelection(elsewhere[0]![1]);
          }
          e.zoomToSelection();
          e.toast(others && here.length ? tr('Выделено ещё {0}; на других страницах — {1}.', here.length, others) : tr('Найдено: {0}.', here.length || elsewhere[0]![1].length));
        });
      },
    },
    {
      id: 'text.typograph',
      label: tr('Типограф: кавычки, тире, неразрывные пробелы'),
      group: tr('Текст'),
      keys: ['Mod+Alt+Shift+T'],
      keywords: 'typograph типограф кавычки ёлочки тире неразрывный пробел предлоги вёрстка оформление текста',
      run: () => void e.typographSelection(),
    },
    {
      id: 'design.colorKit',
      label: tr('Набор цветов: оттенки, гармонии, контраст'),
      group: tr('Вставка'),
      keywords: 'color kit palette палитра оттенки гармонии триада дополнительный контраст цвет',
      run: () => {
        void Promise.all([import('./ui/color-kit-dialog.ts'), import('./smart-ops.ts')]).then(([{ openColorKit }, { singleColor }]) => {
          const one = e.selection.length === 1 ? singleColor(e, e.selection[0]!) : null;
          openColorKit(e, { color: one?.color ?? { r: 0.31, g: 0.36, b: 0.84, a: 1 } });
        });
      },
    },
    {
      id: 'smart.shades',
      label: tr('Палитра из цвета: оттенки 50–900 в переменные'),
      group: tr('Переменные'),
      run: () => {
        if (e.doc.readOnly || e.selection.length !== 1) return e.toast(tr('Выделите один слой с одним сплошным цветом'));
        void import('./smart-ops.ts').then(({ createShades }) => {
          const res = createShades(e, e.selection[0]!);
          e.toast(res ? tr('Готово: «{0}» — {1} оттенков в коллекции «Палитра», слой привязан к своему оттенку.', res.group, res.count) : tr('Выделите один слой с одним сплошным цветом'));
        });
      },
    },
    {
      id: 'smart.imagePalette',
      label: tr('Палитра из картинки: главные цвета в переменные'),
      group: tr('Переменные'),
      run: () => {
        if (e.doc.readOnly || e.selection.length !== 1) return e.toast(tr('Выделите одну картинку'));
        void import('./smart-ops.ts').then(async ({ createImagePalette }) => {
          const res = await createImagePalette(e, e.selection[0]!);
          e.toast(res ? tr('Готово: коллекция «{0}», цветов — {1}.', res.collection, res.count) : tr('Не удалось прочитать цвета картинки.'), res ? 'info' : 'error');
        });
      },
    },
    {
      id: 'smart.darkTheme',
      label: tr('Тёмная тема: режим «Тёмная» в коллекции цветов'),
      group: tr('Переменные'),
      run: () => {
        if (e.doc.readOnly) return;
        void import('./smart-ops.ts').then(({ darkThemeCandidates, createDarkTheme }) => {
          const collection = darkThemeCandidates(e)[0];
          if (!collection) return e.toast(tr('Нет коллекции цветов без тёмного режима. Сначала заведите переменные цвета.'));
          const show = e.topLevelSelection().filter((id) => ['FRAME', 'COMPONENT', 'SECTION', 'GROUP', 'INSTANCE'].includes(e.doc.type(id)));
          const n = createDarkTheme(e, collection, show);
          e.toast(
            show.length
              ? tr('Режим «Тёмная» добавлен в «{0}» ({1} цветов) и включён у выделенного. Поправить цвета — в таблице переменных.', e.doc.get(collection, 'name'), n)
              : tr('Режим «Тёмная» добавлен в «{0}» ({1} цветов). Включить — у фрейма или страницы в «Режимах переменных».', e.doc.get(collection, 'name'), n),
          );
        });
      },
    },
    {
      id: 'object.autoName',
      label: tr('Переименовать слои автоматически («Прямоугольник 23» → «Кнопка», «Карточка», «Шапка»)'),
      group: tr('Объект'),
      // The rules, then the model for what they leave (smart.ts).
      run: () => void import('./smart.ts').then(({ renameLayers }) => renameLayers(e)),
    },
    { id: 'view.langRu', label: 'Язык интерфейса: русский', group: tr('Вид'), run: () => changeLang('ru') },
    { id: 'view.langEn', label: 'Interface language: English', group: tr('Вид'), run: () => changeLang('en') },
    { id: 'view.dockBottom', label: tr('Панель инструментов снизу'), group: tr('Вид'), run: () => host.setDockPlace('bottom') },
    { id: 'view.dockTop', label: tr('Панель инструментов сверху'), group: tr('Вид'), run: () => host.setDockPlace('top') },
    { id: 'view.dockLeft', label: tr('Панель инструментов слева'), group: tr('Вид'), run: () => host.setDockPlace('left') },
    ...[0.9, 1, 1.1, 1.25].map((scale) => ({ id: `view.uiScale${Math.round(scale * 100)}`, label: tr('Размер интерфейса: {0}%', Math.round(scale * 100)), group: tr('Вид'), run: () => host.setUiScale(scale) })),
    { id: 'view.rulers', label: tr('Линейки'), group: tr('Вид'), keys: ['Shift+R'], run: () => e.setView({ rulers: !e.view.rulers }) },
    { id: 'view.layoutGrids', label: tr('Показать / скрыть сетки колонок'), group: tr('Вид'), keys: [IS_MAC ? 'Ctrl+G' : 'Ctrl+Shift+4'], run: () => e.setView({ layoutGrids: !e.view.layoutGrids }) },
    { id: 'view.outlines', label: tr('Контурный режим'), group: tr('Вид'), keys: ['Mod+Shift+O'], keywords: 'outline view outlines контуры каркас рентген скелет wireframe', run: () => e.setView({ outlines: !e.view.outlines }) },
    { id: 'view.outlineHidden', label: tr('Контурный режим: показывать скрытые слои'), group: tr('Вид'), keywords: 'outline hidden контуры скрытые', run: () => e.setView({ outlineHidden: !e.view.outlineHidden, outlines: true }) },
    { id: 'view.outlineBounds', label: tr('Контурный режим: показывать рамки объектов'), group: tr('Вид'), keywords: 'outline bounds контуры рамки границы', run: () => e.setView({ outlineBounds: !e.view.outlineBounds, outlines: true }) },
    { id: 'view.cursors', label: tr('Курсоры участников: показать / скрыть'), group: tr('Вид'), keywords: 'multiplayer cursors курсоры соавторов участники скрыть', run: () => e.setView({ cursors: !e.view.cursors }) },
    { id: 'view.smartSymbols', label: tr('Умные символы при наборе: вкл / выкл'), group: tr('Вид'), keywords: 'smart quotes dashes arrows кавычки тире стрелки автозамена типограф', run: () => e.setView({ smartSymbols: !e.view.smartSymbols }) },
    { id: 'view.propertyLabels', label: tr('Подписи свойств: вкл / выкл'), group: tr('Вид'), keywords: 'property labels подписи значки иконки поля', run: () => e.setView({ propertyLabels: !e.view.propertyLabels }) },
    { id: 'view.pixelPreview', label: tr('Пиксельный предпросмотр: вкл / выкл'), group: tr('Вид'), keys: [IS_MAC ? 'Ctrl+P' : 'Ctrl+Alt+P'], keywords: 'pixel preview пиксели растр пикселизация', run: () => e.setPixelPreview('toggle') },
    { id: 'view.pixelPreview1x', label: tr('Пиксельный предпросмотр 1x'), group: tr('Вид'), keywords: 'pixel preview 1x пиксели', run: () => e.setPixelPreview(1) },
    { id: 'view.pixelPreview2x', label: tr('Пиксельный предпросмотр 2x'), group: tr('Вид'), keywords: 'pixel preview 2x retina пиксели', run: () => e.setPixelPreview(2) },
    { id: 'view.pixelGrid', label: tr('Пиксельная сетка'), group: tr('Вид'), keys: ["Shift+'"], run: () => e.setView({ pixelGrid: !e.view.pixelGrid }) },
    { id: 'view.snapPixel', label: tr('Привязка к пикселям'), group: tr('Вид'), keys: ["Mod+Shift+'"], run: () => {
      e.setView({ snapToPixel: !e.view.snapToPixel });
      e.toast(e.view.snapToPixel ? tr('Привязка к пикселям включена') : tr('Привязка к пикселям выключена'));
    } },
    { id: 'view.snapping', label: tr('Привязка к объектам и направляющим'), group: tr('Вид'), keys: [], run: () => {
      e.setView({ snapping: !e.view.snapping });
      e.toast(e.view.snapping ? tr('Привязка включена') : tr('Привязка выключена (Mod при перетаскивании отключает её на время)'));
    } },
    { id: 'guides.clear', label: tr('Удалить все направляющие страницы'), group: tr('Вид'), keys: [], run: () => e.clearGuides() },
    { id: 'file.list', label: tr('Файлы: список, открыть, переименовать, удалить'), group: tr('Файл'), keys: ['Mod+O'], run: () => host.openFiles() },
    { id: 'edit.find', label: tr('Найти и заменить…'), group: tr('Правка'), keys: ['Mod+F'], run: () => host.findReplace() },
    { id: 'layers.find', label: tr('Найти слой в панели слоёв'), group: tr('Вид'), run: () => host.findLayers() },
    { id: 'object.tidyUp', label: tr('Выстроить ровной сеткой'), group: tr('Выравнивание'), keys: [IS_MAC ? 'Ctrl+Alt+T' : 'Alt+Shift+T'], run: () => e.tidyUp() },
    { id: 'grid.add', label: tr('Добавить во фрейм сетку колонок'), group: tr('Объект'), keys: [], run: () => e.addLayoutGrid('COLUMNS') },

    // Edit
    { id: 'edit.undo', label: tr('Отменить'), group: tr('Правка'), keys: ['Mod+Z'], run: () => e.undo(), repeat: true },
    { id: 'file.versions', label: tr('История версий…'), group: tr('Файл'), keys: ['Mod+Alt+H'], run: () => host.showVersions() },
    { id: 'file.branches', label: tr('Ветки…'), group: tr('Файл'), run: () => host.showBranches(false) },
    { id: 'file.newBranch', label: tr('Создать ветку…'), group: tr('Файл'), run: () => host.showBranches(true) },
    { id: 'file.branchUpdate', label: tr('Получить изменения из основного файла'), group: tr('Файл'), run: () => host.updateBranch() },
    { id: 'file.branchMerge', label: tr('Слить ветку в основной файл…'), group: tr('Файл'), run: () => host.mergeBranch() },
    { id: 'edit.history', label: tr('История действий…'), group: tr('Правка'), run: () => host.showHistory() },
    { id: 'edit.redo', label: tr('Повторить'), group: tr('Правка'), keys: ['Mod+Shift+Z', 'Ctrl+Y'], run: () => e.redo(), repeat: true },
    { id: 'edit.copy', label: tr('Копировать'), group: tr('Правка'), keys: ['Mod+C'], run: () => e.copy() },
    { id: 'edit.copyPng', label: tr('Копировать как PNG'), group: tr('Правка'), keys: ['Mod+Shift+C'], run: () => host.copyAs('PNG') },
    { id: 'edit.copySvg', label: tr('Копировать как SVG'), group: tr('Правка'), run: () => host.copyAs('SVG') },
    { id: 'edit.copyCss', mode: 'design', label: tr('Копировать как код CSS'), group: tr('Правка'), keywords: 'css code код стили copy as', run: () => host.copyAs('CSS') },
    { id: 'file.importSvg', label: tr('Импортировать SVG…'), group: tr('Файл'), run: () => host.importSvg() },
    { id: 'file.importNative', label: tr('Импорт файла Симметрики (.csdoc.json) — новым файлом…'), group: tr('Файл'), run: () => host.openFile('.json,.csdoc,application/json') },
    { id: 'file.importFig', label: tr('Импорт из Figma (.fig) — новым файлом…'), group: tr('Файл'), run: () => host.importFig() },
    { id: 'file.importPptx', mode: 'design', label: tr('Импорт PowerPoint (.pptx): презентация…'), group: tr('Файл'), keywords: 'powerpoint pptx keynote импорт import презентация', run: () => host.openFile('.pptx') },
    { id: 'file.importHtml', mode: 'design', label: tr('Импорт HTML: страница или сайт → слои…'), group: tr('Файл'), run: () => host.importHtml() },
    { id: 'smart.editLayout', mode: 'design', label: tr('Изменить выделенный макет по описанию…'), group: tr('Объект'), run: () => host.editLayout() },
    { id: 'smart.generate', mode: 'design', label: tr('Макет по описанию: нейросеть сверстает экран…'), group: tr('Файл'), run: () => host.importHtml('prompt') },
    { id: 'board.neighbour', mode: 'board', label: tr('Новый стикер рядом с выделенным'), group: tr('Правка'), keys: ['Mod+Enter'], keywords: 'sticky стикер рядом', run: () => host.boardNeighbour() },
    { id: 'board.table', mode: 'board', label: tr('Таблица: вставить новую'), group: tr('Вставка'), keywords: 'table таблица ячейки строки столбцы excel сетка данные', run: () => host.openTable() },
    { id: 'board.stickers', mode: 'board', label: tr('Наклейки: «Круто!», «Идея», «Готово»…'), group: tr('Вставка'), keywords: 'stickers наклейки бейдж значок реакция', run: () => host.openStickers('stickers') },
    { id: 'board.components', mode: 'board', label: tr('Компоненты из файла и библиотек'), group: tr('Вставка'), keywords: 'components library библиотека компоненты ресурсы assets', run: () => host.openStickers('components') },
    { id: 'board.colors', mode: 'board', label: tr('Свои цвета доски…'), group: tr('Вид'), keywords: 'palette палитра цвета бренд brand colors свои', run: () => void import('./ui/board-colors.ts').then(({ openBoardColors }) => openBoardColors(e)) },
    { id: 'board.saveTemplate', mode: 'board', label: tr('Сохранить выделенное как шаблон доски…'), group: tr('Файл'), keywords: 'шаблон template свой сохранить', run: () => host.openTemplates() },
    { id: 'board.code', mode: 'board', label: tr('Блок кода с подсветкой'), group: tr('Вставка'), keywords: 'code block код программа подсветка синтаксис snippet фрагмент', run: () => host.insertCode() },
    { id: 'board.insertLink', mode: 'board', label: tr('Ссылка: карточка страницы с картинкой и заголовком'), group: tr('Вставка'), keywords: 'link url ссылка превью preview', run: () => host.insertLink() },
    { id: 'board.templates', mode: 'board', label: tr('Шаблоны досок: ретро, мозговой штурм, канбан, блок-схема…'), group: tr('Файл'), keywords: 'шаблон template retro kanban', run: () => host.openTemplates() },
    { id: 'file.templates', mode: 'design', label: tr('Вставить шаблон экрана: вход, профиль, список, настройки, лендинг…'), group: tr('Файл'), run: () => host.openTemplates() },
    { id: 'design.icons', mode: 'design', label: tr('Иконки'), group: tr('Вставка'), keys: ['Shift+I'], keywords: 'icons иконки значки пиктограммы набор', run: () => host.openIcons() },
    { id: 'styles.batch', mode: 'design', label: tr('Массовая правка стилей: шрифт, размер, интервалы, цвет у многих стилей сразу'), group: tr('Стили'), keywords: 'batch styler стили массово шрифт размер цвет переименовать папка', run: () => void import('./ui/batch-styles-dialog.ts').then(({ openBatchStyles }) => openBatchStyles(e)) },
    { id: 'design.content', mode: 'design', label: tr('Контент: имена, адреса, даты, цены, аватары'), group: tr('Вставка'), keywords: 'content reel контент данные имена аватары заполнить наборы', run: () => host.openContent() },
    { id: 'design.blob', mode: 'design', label: tr('Клякса: генератор абстрактных форм'), group: tr('Вставка'), keywords: 'blob blobs клякса форма абстрактная генератор пятно', run: () => host.openBlob() },
    { id: 'design.waves', mode: 'design', label: tr('Волны: генератор волн'), group: tr('Вставка'), keywords: 'waves wave get waves волны волна фон разделитель', run: () => host.openWaves() },
    { id: 'design.backdrop', mode: 'design', label: tr('Градиентный фон: сетка и аврора'), group: tr('Вставка'), keywords: 'mesh gradient aurora background градиент фон сетка аврора пятна размытый слайд обложка', run: () => host.openBackdrop() },
    { id: 'design.table', mode: 'design', label: tr('Таблица: вставить новую'), group: tr('Вставка'), keywords: 'table таблица ячейки строки столбцы excel сетка данные', run: () => host.openTable() },
    { id: 'design.doodle', mode: 'design', label: tr('Каракули: подчёркивание, обводка, стрелка от руки'), group: tr('Вставка'), keywords: 'doodle scribble underline circle arrow sparkle marker каракули подчеркнуть обвести стрелка искры звёздочка маркер галочка от руки', run: () => host.openDoodle() },
    { id: 'design.mockups', mode: 'design', label: tr('Макеты устройств: телефон, планшет, ноутбук, десктоп, часы…'), group: tr('Вставка'), keywords: 'mockup iphone android телефон планшет ноутбук', run: () => host.openDeviceMockups() },
    { id: 'file.exportPptx', mode: 'design', label: tr('Экспорт в PowerPoint (PPTX): фреймы → слайды…'), group: tr('Файл'), run: () => host.exportPptx() },
    { id: 'edit.cut', label: tr('Вырезать'), group: tr('Правка'), keys: ['Mod+X'], run: () => e.cut() },
    { id: 'edit.paste', label: tr('Вставить'), group: tr('Правка'), keys: ['Mod+V'], run: () => void e.paste(false) },
    { id: 'edit.pasteReplace', label: tr('Вставить с заменой'), group: tr('Правка'), keys: ['Mod+Shift+R'], keywords: 'заменить вставить вместо paste replace', run: () => void e.pasteReplace() },
    { id: 'edit.pasteInPlace', label: tr('Вставить на то же место'), group: tr('Правка'), keys: ['Mod+Shift+V'], run: () => void e.paste(true) },
    { id: 'edit.duplicate', label: tr('Дублировать'), group: tr('Правка'), keys: ['Mod+D'], run: () => e.duplicate() },
    { id: 'edit.delete', label: tr('Удалить'), group: tr('Правка'), keys: ['Delete', 'Backspace'], run: () => e.deleteSelection() },
    { id: 'edit.selectAll', label: tr('Выделить всё'), group: tr('Правка'), keys: ['Mod+A'], run: () => e.selectAll() },
    { id: 'edit.deselect', label: tr('Снять выделение'), group: tr('Правка'), keys: ['Escape'], run: () => {
      if (host.cancel()) return;
      if (e.tool !== 'select' || e.scaleMode) e.setTool('select');
      // Esc climbs to the parent layer, on a top-level layer it clears the selection. Figma's Esc clears at once;
      // stepping up (as in Sketch) was chosen on purpose, 14 October (BUG-062).
      else if (e.selection.some((id) => e.doc.parent(id) !== e.pageId)) e.selectParent();
      else e.setSelection([]);
    } },
    { id: 'edit.selectChildren', label: tr('Войти внутрь: выделить вложенные слои'), group: tr('Правка'), keys: ['Enter'], run: () => {
      if (host.confirm()) return;
      const only = e.selection.length === 1 ? e.selection[0]! : null;
      const boardText = only && isBoardObjectOrConnector(e.doc, only) ? editableTextOf(e, only) : null;
      if (boardText) e.startTextEditing(boardText);
      else if (only && e.doc.type(only) === 'TEXT') e.startTextEditing(only);
      // Several text layers: what is typed goes into all of them (Multi-edit text, as in Figma).
      else if (e.selection.length > 1 && e.selection.every((id) => e.doc.type(id) === 'TEXT' && !e.doc.get(id, 'board'))) e.startMultiTextEditing(e.selection);
      else if (only && ['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'].includes(e.doc.type(only))) e.enterVectorEdit(only);
      else e.selectChildren();
    } },
    { id: 'edit.selectParent', label: tr('Выделить родителя'), group: tr('Правка'), keys: ['Shift+Enter'], run: () => e.selectParent() },
    { id: 'edit.nextSibling', label: tr('Следующий слой'), group: tr('Правка'), keys: ['Tab'], run: () => e.selectSibling(1), hidden: true },
    { id: 'edit.prevSibling', label: tr('Предыдущий слой'), group: tr('Правка'), keys: ['Shift+Tab'], run: () => e.selectSibling(-1), hidden: true },
    { id: 'edit.rename', label: tr('Переименовать'), group: tr('Правка'), keys: ['Mod+R'], run: () => host.renameSelection() },
    { id: 'text.onPath', mode: 'design', label: tr('Текст по контуру (выделите текст и линию)'), group: tr('Объект'), keywords: 'текст по кривой путь линия text on path', run: () => putTextOnPath(e) },
    { id: 'text.offPath', mode: 'design', label: tr('Снять текст с контура'), group: tr('Объект'), keywords: 'текст по кривой путь text on path', run: () => takeTextOffPath(e) },
    { id: 'text.flipPath', mode: 'design', label: tr('Перевернуть текст на контуре'), group: tr('Объект'), keywords: 'текст по кривой другая сторона text on path flip', run: () => flipTextOnPath(e) },
    { id: 'edit.selectMatching', mode: 'design', label: tr('Выделить такие же слои'), group: tr('Правка'), keys: ['Mod+Alt+A'], keywords: 'похожие одинаковые совпадающие select matching same', run: () => selectMatching(e) },

    // Objects
    { id: 'object.flipH', mode: 'design', label: tr('Отразить по горизонтали'), group: tr('Объект'), keys: ['Shift+H'], keywords: 'flip mirror зеркально', run: () => e.flip('H') },
    { id: 'object.flipV', mode: 'design', label: tr('Отразить по вертикали'), group: tr('Объект'), keys: ['Shift+V'], keywords: 'flip mirror зеркально', run: () => e.flip('V') },
    { id: 'object.rotate90', mode: 'design', label: tr('Повернуть на 90° по часовой'), group: tr('Объект'), keywords: 'rotate поворот', run: () => e.rotate90(false) },
    { id: 'object.rotate90back', mode: 'design', label: tr('Повернуть на 90° против часовой'), group: tr('Объект'), keywords: 'rotate поворот', run: () => e.rotate90(true) },
    { id: 'object.group', label: tr('Сгруппировать'), group: tr('Объект'), keys: ['Mod+G'], run: () => e.group() },
    { id: 'object.ungroup', label: tr('Разгруппировать'), group: tr('Объект'), keys: ['Mod+Shift+G'], run: () => e.ungroup() },
    { id: 'shape.union', label: tr('Объединить фигуры'), group: tr('Фигуры'), keys: ['Alt+Shift+U'], run: () => e.booleanSelection('UNION') },
    { id: 'shape.subtract', label: tr('Вычесть верхние фигуры из нижней'), group: tr('Фигуры'), keys: ['Alt+Shift+S'], run: () => e.booleanSelection('SUBTRACT') },
    { id: 'shape.intersect', label: tr('Оставить только пересечение'), group: tr('Фигуры'), keys: ['Alt+Shift+I'], run: () => e.booleanSelection('INTERSECT') },
    { id: 'shape.exclude', label: tr('Оставить всё, кроме пересечения'), group: tr('Фигуры'), keys: ['Alt+Shift+E'], run: () => e.booleanSelection('EXCLUDE') },
    { id: 'shape.builder', mode: 'design', label: tr('Конструктор фигур'), group: tr('Фигуры'), keys: ['Shift+M'], run: () => e.startShapeBuilder() },
    { id: 'object.repeat', mode: 'design', label: tr('Инструмент: повтор в ряд'), group: tr('Фигуры'), run: () => e.addRepeat('LINEAR') },
    { id: 'object.repeatRadial', mode: 'design', label: tr('Инструмент: повтор по кругу'), group: tr('Фигуры'), run: () => e.addRepeat('RADIAL') },
    { id: 'brush.createStretch', mode: 'design', label: tr('Создать кисть: растягивающуюся'), group: tr('Фигуры'), run: () => e.createBrush('STRETCH') },
    { id: 'brush.createScatter', mode: 'design', label: tr('Создать кисть: рассыпную'), group: tr('Фигуры'), run: () => e.createBrush('SCATTER') },
    { id: 'shape.flatten', label: tr('Слить в одну векторную фигуру'), group: tr('Фигуры'), keys: ['Mod+E', 'Alt+Shift+F'], run: () => e.flattenSelection() },
    { id: 'shape.outline', label: tr('Превратить обводку в фигуру'), group: tr('Фигуры'), keys: ['Mod+Alt+O'], run: () => e.outlineStroke() },
    { id: 'shape.mask', label: tr('Использовать как маску'), group: tr('Фигуры'), keys: ['Mod+Alt+M'], run: () => e.useAsMask() },
    { id: 'shape.editPoints', label: tr('Редактировать точки'), group: tr('Фигуры'), run: () => { const only = e.selection[0]; if (only) e.enterVectorEdit(only); } },
    { id: 'shape.simplify', label: tr('Упростить контур'), group: tr('Фигуры'), run: () => e.simplifySelection() },
    { id: 'shape.offset', label: tr('Сместить контур…'), group: tr('Фигуры'), run: () => void import('./ui/properties-panel.ts').then(({ askOffset }) => askOffset(e)) },
    { id: 'vector.bucket', label: tr('Заливка областей (в правке точек)'), group: tr('Фигуры'), keys: ['B'], run: () => { const only = e.selection[0]; if (e.vectorEdit) e.setVectorTool('bucket'); else if (only) e.enterVectorEdit(only, 'bucket'); } },
    { id: 'vector.lasso', label: tr('Лассо: выделить точки произвольной линией (в правке точек)'), group: tr('Фигуры'), keys: ['Q'], run: () => {
      const only = e.selection[0];
      if (e.vectorEdit) e.setVectorTool('lasso');
      // Outside point editing Q is multi-edit variants, as in Figma.
      else if (e.variantEdit || (only && variantSetOf(e.doc, only))) e.toggleVariantEdit();
      else if (only) e.enterVectorEdit(only, 'lasso');
    } },
    { id: 'edit.multiEditVariants', mode: 'design', label: tr('Править варианты разом (Q)'), group: tr('Компоненты'), keywords: 'multi-edit variants варианты разом все сразу', run: () => e.toggleVariantEdit() },
    { id: 'vector.width', label: tr('Ширина: точки толщины вдоль линии (в правке точек)'), group: tr('Фигуры'), keys: ['Shift+W'], run: () => { const only = e.selection[0]; if (e.vectorEdit) e.setVectorTool('width'); else if (only) e.enterVectorEdit(only, 'width'); } },
    { id: 'vector.eraser', label: tr('Ластик: стереть части контура (в правке точек)'), group: tr('Фигуры'), run: () => { const only = e.selection[0]; if (e.vectorEdit) e.setVectorTool('eraser'); else if (only) e.enterVectorEdit(only, 'eraser'); } },
    { id: 'vector.scissors', label: tr('Ножницы: разрезать сегмент или точку (в правке точек)'), group: tr('Фигуры'), run: () => { const only = e.selection[0]; if (e.vectorEdit) e.setVectorTool('scissors'); else if (only) e.enterVectorEdit(only, 'scissors'); } },
    { id: 'object.frame', label: tr('Обернуть во фрейм'), group: tr('Объект'), keys: ['Mod+Alt+G'], run: () => e.frameSelection(false) },
    { id: 'object.section', label: tr('Обернуть в секцию'), group: tr('Объект'), run: () => e.sectionSelection() },
    { id: 'object.autoLayout', mode: 'design', label: tr('Добавить или убрать адаптивную раскладку'), group: tr('Объект'), keys: ['Shift+A'], run: () => e.addAutoLayout() },
    { id: 'object.codeLayer', mode: 'design', label: tr('Код-слой'), group: tr('Объект'), keywords: 'code layer код html css javascript react живой код', run: () => void import('./code-layer.ts').then(({ addCodeLayer }) => addCodeLayer(e)) },
    { id: 'object.suggestAutoLayout', mode: 'design', label: tr('Предложить адаптивную раскладку'), group: tr('Объект'), keywords: 'suggest auto layout подобрать раскладку автоматически ряды столбцы', run: () => void import('./suggest-layout.ts').then(({ suggestAutoLayout }) => suggestAutoLayout(e)) },
    { id: 'object.removeAllAutoLayout', mode: 'design', label: tr('Убрать всю адаптивную раскладку'), group: tr('Объект'), keys: ['Alt+Shift+A'], keywords: 'remove all auto layout убрать раскладку везде вложенные', run: () => e.removeAllAutoLayout() },
    { id: 'component.create', label: tr('Создать компонент'), group: tr('Компоненты'), keys: ['Mod+Alt+K'], run: () => e.createComponent() },
    { id: 'component.instance', label: tr('Поставить копию компонента'), group: tr('Компоненты'), run: () => e.createInstanceOfSelection() },
    { id: 'component.detach', label: tr('Отвязать от компонента'), group: tr('Компоненты'), keys: ['Mod+Alt+B'], run: () => e.detachSelection() },
    { id: 'component.goToMain', label: tr('Перейти к компоненту-оригиналу'), group: tr('Компоненты'), run: () => e.goToMainComponent() },
    { id: 'component.reset', label: tr('Сбросить изменения копии'), group: tr('Компоненты'), run: () => e.resetSelectedOverrides() },
    { id: 'view.collapseLayers', label: tr('Свернуть все слои'), group: tr('Вид'), keys: ['Alt+L'], run: () => host.collapseLayers() },
    { id: 'view.expandLayers', label: tr('Развернуть все слои'), group: tr('Вид'), keys: ['Shift+Alt+L'], run: () => host.expandLayers() },
    { id: 'view.layers', label: tr('Показать слои'), group: tr('Вид'), keys: ['Alt+1'], run: () => host.showLayers() },
    { id: 'component.assets', label: tr('Показать компоненты файла'), group: tr('Компоненты'), keys: ['Alt+2'], run: () => host.showAssets() },
    { id: 'component.combine', label: tr('Объединить компоненты в набор вариантов'), group: tr('Компоненты'), run: () => e.combineAsVariants() },
    { id: 'component.addVariant', label: tr('Добавить вариант'), group: tr('Компоненты'), run: () => e.addVariant() },
    { id: 'object.toggleVisible', label: tr('Показать / скрыть'), group: tr('Объект'), keys: ['Mod+Shift+H'], run: () => e.toggleProp('visible') },
    { id: 'object.toggleLock', label: tr('Заблокировать / разблокировать (от случайных правок)'), group: tr('Объект'), keys: ['Mod+Shift+L'], run: () => e.toggleProp('locked') },
    { id: 'object.forward', label: tr('Переместить выше'), group: tr('Объект'), keys: ['Mod+]'], run: () => e.reorder('forward') },
    { id: 'object.backward', label: tr('Переместить ниже'), group: tr('Объект'), keys: ['Mod+['], run: () => e.reorder('backward') },
    { id: 'object.front', label: tr('На передний план'), group: tr('Объект'), keys: ['Mod+Alt+]'], run: () => e.reorder('front') },
    { id: 'object.back', label: tr('На задний план'), group: tr('Объект'), keys: ['Mod+Alt+['], run: () => e.reorder('back') },
    { id: 'align.left', label: tr('Выровнять по левому краю'), group: tr('Выравнивание'), keys: ['Alt+A'], run: () => e.align('left') },
    { id: 'align.hcenter', label: tr('Выровнять по центру (горизонтально)'), group: tr('Выравнивание'), keys: ['Alt+H'], run: () => e.align('hcenter') },
    { id: 'align.right', label: tr('Выровнять по правому краю'), group: tr('Выравнивание'), keys: ['Alt+D'], run: () => e.align('right') },
    { id: 'align.top', label: tr('Выровнять по верху'), group: tr('Выравнивание'), keys: ['Alt+W'], run: () => e.align('top') },
    { id: 'align.vcenter', label: tr('Выровнять по центру (вертикально)'), group: tr('Выравнивание'), keys: ['Alt+V'], run: () => e.align('vcenter') },
    { id: 'align.bottom', label: tr('Выровнять по низу'), group: tr('Выравнивание'), keys: ['Alt+S'], run: () => e.align('bottom') },
    { id: 'align.distributeH', label: tr('Распределить по горизонтали'), group: tr('Выравнивание'), keys: ['Alt+Shift+H'], run: () => e.distribute('x') },
    { id: 'align.distributeV', label: tr('Распределить по вертикали'), group: tr('Выравнивание'), keys: ['Alt+Shift+V'], run: () => e.distribute('y') },
    { id: 'nudge.left', label: tr('Сдвинуть влево'), group: tr('Объект'), keys: ['ArrowLeft'], run: nudge(-1, 0), hidden: true, repeat: true },
    { id: 'nudge.right', label: tr('Сдвинуть вправо'), group: tr('Объект'), keys: ['ArrowRight'], run: nudge(1, 0), hidden: true, repeat: true },
    { id: 'nudge.up', label: tr('Сдвинуть вверх'), group: tr('Объект'), keys: ['ArrowUp'], run: nudge(0, -1), hidden: true, repeat: true },
    { id: 'nudge.down', label: tr('Сдвинуть вниз'), group: tr('Объект'), keys: ['ArrowDown'], run: nudge(0, 1), hidden: true, repeat: true },
    { id: 'nudge.left10', label: tr('Сдвинуть влево на большой шаг'), group: tr('Объект'), keys: ['Shift+ArrowLeft'], run: nudge(-1, 0, true), hidden: true, repeat: true },
    { id: 'nudge.right10', label: tr('Сдвинуть вправо на большой шаг'), group: tr('Объект'), keys: ['Shift+ArrowRight'], run: nudge(1, 0, true), hidden: true, repeat: true },
    { id: 'nudge.up10', label: tr('Сдвинуть вверх на большой шаг'), group: tr('Объект'), keys: ['Shift+ArrowUp'], run: nudge(0, -1, true), hidden: true, repeat: true },
    { id: 'nudge.down10', label: tr('Сдвинуть вниз на большой шаг'), group: tr('Объект'), keys: ['Shift+ArrowDown'], run: nudge(0, 1, true), hidden: true, repeat: true },

    { id: 'props.copy', label: tr('Копировать оформление (цвет, обводку, тени)'), group: tr('Правка'), keys: ['Mod+Alt+C'], run: () => (isBoardDoc() ? void copyBoardLook(e) : e.copyProperties()) },
    { id: 'props.paste', label: tr('Вставить оформление'), group: tr('Правка'), keys: ['Mod+Alt+V'], run: () => (isBoardDoc() ? void pasteBoardLook(e) : e.pasteProperties()) },

    // Text
    { id: 'text.bold', label: tr('Текст: жирный'), group: tr('Текст'), keys: ['Mod+B'], run: () => e.toggleTextStyle('bold') },
    { id: 'text.italic', label: tr('Текст: курсив'), group: tr('Текст'), keys: ['Mod+I'], run: () => e.toggleTextStyle('italic') },
    { id: 'text.underline', label: tr('Текст: подчёркнутый'), group: tr('Текст'), keys: ['Mod+U'], run: () => e.toggleTextStyle('underline') },
    { id: 'text.numbered', label: tr('Текст: нумерованный список'), group: tr('Текст'), keys: ['Mod+Shift+7'], run: () => e.toggleList('NUMBER') },
    { id: 'text.bulleted', label: tr('Текст: маркированный список'), group: tr('Текст'), keys: ['Mod+Shift+8'], run: () => e.toggleList('BULLET') },
    { id: 'text.strike', label: tr('Текст: зачёркнутый'), group: tr('Текст'), keys: ['Mod+Shift+X'], run: () => e.toggleTextStyle('strike') },
    { id: 'text.bigger', label: tr('Текст: крупнее'), group: tr('Текст'), keys: ['Mod+Shift+.'], run: () => e.changeFontSize(1), repeat: true },
    { id: 'text.smaller', label: tr('Текст: мельче'), group: tr('Текст'), keys: ['Mod+Shift+,'], run: () => e.changeFontSize(-1), repeat: true },
    { id: 'text.alignLeft', label: tr('Текст: по левому краю'), group: tr('Текст'), keys: ['Mod+Alt+L'], run: () => e.setTextAlign('LEFT') },
    { id: 'text.alignCenter', label: tr('Текст: по центру'), group: tr('Текст'), keys: ['Mod+Alt+T'], run: () => e.setTextAlign('CENTER') },
    { id: 'text.alignRight', label: tr('Текст: по правому краю'), group: tr('Текст'), keys: ['Mod+Alt+R'], run: () => e.setTextAlign('RIGHT') },

    // View
    { id: 'view.zoomIn', label: tr('Приблизить'), group: tr('Вид'), keys: ['=', 'Mod+='], run: () => e.zoomStep(1), repeat: true },
    { id: 'view.zoomOut', label: tr('Отдалить'), group: tr('Вид'), keys: ['-', 'Mod+-'], run: () => e.zoomStep(-1), repeat: true },
    { id: 'view.zoom100', label: tr('Масштаб 100 %'), group: tr('Вид'), keys: ['Shift+0', 'Mod+0'], run: () => e.zoomTo(1) },
    { id: 'view.fit', label: tr('Вписать всё'), group: tr('Вид'), keys: ['Shift+1'], run: () => e.zoomToFit() },
    { id: 'view.fitSelection', label: tr('Вписать выделение'), group: tr('Вид'), keys: ['Shift+2'], run: () => e.zoomToSelection() },
    { id: 'view.toggleUi', label: tr('Скрыть / показать интерфейс'), group: tr('Вид'), keys: ['Mod+\\'], run: () => host.toggleUi('all') },
    { id: 'view.toggleLeft', label: tr('Скрыть / показать левую панель'), group: tr('Вид'), keys: ['Mod+Shift+\\'], run: () => host.toggleUi('left') },
    { id: 'view.variables', label: tr('Таблица переменных'), group: tr('Вид'), keys: [], run: () => host.openVariables() },
    { id: 'variables.toCode', label: tr('Переменные в код: CSS, SCSS, JS, Tailwind, Swift, Kotlin, Android…'), group: tr('Переменные'), keywords: 'токены код экспорт css scss tailwind swift kotlin android xml typescript javascript tokens code export', run: () => host.variablesToCode() },
    { id: 'variables.fromStyles', mode: 'design', label: tr('Преобразовать стили в переменные…'), group: tr('Переменные'), keywords: 'стили токены переменные styles to variables convert составные', run: () => host.stylesToVariables() },
    {
      id: 'variables.bindUnbound',
      label: tr('Найти непривязанные значения и привязать к переменным'),
      group: tr('Переменные'),
      keys: [],
      run: () => {
        const [bound, ambiguous] = e.variables.bindUnbound(e.selection);
        e.toast(bound + ambiguous === 0 ? tr('Значений, совпадающих с переменными, не найдено') : tr('Привязано: {0}{1}', bound, ambiguous > 0 ? tr('; ещё {0} совпадают с несколькими переменными — выберите вручную', ambiguous) : ''));
      },
    },
    { id: 'view.toggleRight', label: tr('Скрыть / показать правую панель'), group: tr('Вид'), keys: ['Mod+Alt+\\'], run: () => host.toggleUi('right') },
    { id: 'live.chat', label: tr('Чат курсором'), group: tr('Вид'), keys: ['/'], run: () => host.cursorChat() },
    { id: 'live.emotes', label: tr('Эмоции и «Дай пять»'), group: tr('Вид'), keys: ['Y'], keywords: 'emote reaction эмодзи реакция дай пять high five', run: () => host.emotes() },
    { id: 'live.spotlight', label: tr('Спотлайт: все наблюдают за мной'), group: tr('Вид'), keys: [], run: () => host.spotlight() },
    { id: 'view.palette', label: tr('Палитра команд'), group: tr('Вид'), keys: ['Mod+K', 'Mod+/'], run: () => host.openPalette() },

    // File
    { id: 'file.new', label: tr('Новый файл'), group: tr('Файл'), keys: [], run: () => host.newFile() },
    { id: 'file.open', label: tr('Открыть файл с диска…'), group: tr('Файл'), keys: [], run: () => host.openFile() },
    { id: 'file.save', label: tr('Сохранить копию файла…'), group: tr('Файл'), keys: ['Mod+S'], run: () => host.saveFile() },
    { id: 'file.export', label: tr('Экспортировать картинками: слои с настройками экспорта или выделение'), group: tr('Файл'), keys: ['Mod+Shift+E'], run: () => host.exportSelection() },
    { id: 'page.add', label: tr('Добавить страницу'), group: tr('Файл'), run: () => e.addPage() },
  ];
  for (const c of list) c.keywords = SYNONYMS[c.id];
  return list;
}

/**
 * Words people look for commands with, besides the label (FEAT-046: the
 * palette understands what you mean, no AI). Russian and English together,
 * so search works in either language.
 */
const SYNONYMS: Record<string, string> = {
  'edit.find': 'найти заменить поиск текст слово замена find replace search text',
  'layout.absolute': 'свободная позиция абсолютная вне auto layout вне адаптивной раскладки вывести из потока absolute position ignore auto layout',
  'text.link': 'ссылка гиперссылка url адрес сайт href link hyperlink',
  'file.versions': 'история версий версии восстановить откатить сравнить вчера раньше version history restore compare',
  'file.branches': 'ветки ветка ответвление слияние слить мерж branch branches merge',
  'file.newBranch': 'новая ветка создать ответвить копия попробовать branch new create',
  'file.branchUpdate': 'получить изменения обновить ветку из основного синхронизировать pull update branch',
  'file.branchMerge': 'слить ветку слияние мерж в основной merge branch',
  'edit.history': 'история отменить шаги назад вернуть undo history steps',
  'image.crop': 'обрезать кадрировать обрезка кроп пропорции crop trim cut aspect',
  'image.erase': 'стереть ластик рваный край кисть маска картинка обложка erase eraser torn edge brush mask',
  'image.removeBg': 'вырезать фон убрать фон задний план прозрачный png remove background cut out bg',
  'component.similar': 'похожие дубликат найти компонент визуальный поиск similar duplicate match',
  'text.translate': 'перевод перевести язык локализация translate localization language',
  'object.autoName': 'имена слоёв назвать слои переименовать всё rename layers auto name',
  'object.autoLayout': 'автолейаут автораскладка флекс flex стек stack auto layout адаптивная раскладка',
  'object.group': 'объединить в группу group',
  'object.ungroup': 'разбить группу распаковать ungroup',
  'object.frame': 'обернуть контейнер wrap frame',
  'component.create': 'компонент мастер символ symbol create component',
  'component.detach': 'отвязать разорвать связь detach instance',
  'component.combine': 'варианты набор вариантов состояния variants',
  'shape.union': 'склеить соединить union merge',
  'shape.subtract': 'вырезать вычесть subtract minus',
  'shape.intersect': 'пересечение intersect',
  'shape.mask': 'маска обрезать по форме mask clip',
  'shape.flatten': 'растеризовать слить вектор flatten',
  'shape.builder': 'shape builder области слить отделить вырезать собрать фигуру',
  'shape.outline': 'контур обводки outline stroke',
  'file.exportPptx': 'презентация слайды powerpoint keynote pptx slides presentation',
  'file.importNative': 'симметрика csdoc json свой файл копия резервная открыть импорт import backup',
  'file.importFig': 'figma фигма fig импорт перенести открыть import',
  'file.importHtml': 'сайт вёрстка код html to design import website',
  'smart.editLayout': 'ии ai нейросеть правка доработать изменить текстом промпт prompt edit layout',
  'smart.generate': 'ии ai нейросеть генерация сгенерировать текст промпт prompt generate layout',
  'file.templates': 'заготовка шаблон черновик макет wireframe template starter',
  'file.export': 'сохранить картинку png jpg скачать export image download',
  'edit.copyPng': 'скриншот картинка в буфер copy image',
  'edit.copySvg': 'вектор в буфер copy vector',
  'view.variables': 'токены тема тёмная светлая tokens theme dark mode variables',
  'variables.bindUnbound': 'привязать токены bind tokens',
  'help.open': 'помощь инструкция как документация help docs manual',
  'help.example': 'обучение туториал урок tutorial example',
  'view.settings': 'язык language размер шрифта крупнее масштаб интерфейса preferences',
  'prototype.present': 'просмотр демо показать play preview present',
  'live.spotlight': 'показать всем презентовать follow me',
  'live.chat': 'сообщение написать chat message',
  'align.distributeH': 'равные промежутки по горизонтали space evenly',
  'align.distributeV': 'равные промежутки по вертикали space evenly',
  'object.tidyUp': 'упорядочить сетка расставить tidy',
  'tool.pen': 'кривые безье нарисовать path bezier',
  'shape.simplify': 'упростить контур simplify path меньше точек сгладить',
  'shape.offset': 'сместить контур offset path отступ расширить сузить',
  'vector.bucket': 'заливка областей paint bucket залить область векторная сеть',
  'vector.scissors': 'ножницы разрезать scissors cut',
  'tool.eyedropper': 'взять цвет color picker',
  'grid.add': 'колонки модульная сетка columns layout grid',
  'text.bold': 'полужирный bold',
  'props.copy': 'скопировать стиль формат copy style',
  'props.paste': 'вставить стиль формат paste style',
};
