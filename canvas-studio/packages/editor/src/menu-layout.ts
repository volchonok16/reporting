// The main menu's sections laid out as a desktop app's menu bar (1 November): related
// commands together, separators between kinds, and long families in submenus — «Вид»
// had 45 commands in one list, «Объект» 42. A command the layout does not name still
// shows, at the end of its own section, so nothing new gets lost.

import { tr } from '#core';

/** A command by id, a separator, or a submenu of commands (separators inside too). */
export type MenuEntry = string | '-' | { sub: string; items: (string | '-')[] };

/** The menu's sections in order (Russian group names, as commands carry them through tr). */
export const MENU_ORDER = ['Файл', 'Презентация', 'Схема', 'Правка', 'Вид', 'Вставка', 'Объект', 'Фигуры', 'Текст', 'Выравнивание', 'Компоненты', 'Прототип', 'Переменные', 'Справка'];

const NUDGES = ['nudge.left', 'nudge.right', 'nudge.up', 'nudge.down', '-', 'nudge.left10', 'nudge.right10', 'nudge.up10', 'nudge.down10'];

export const MENU_LAYOUT: Record<string, MenuEntry[]> = {
  Файл: [
    'file.new', 'file.open', 'file.list', '-',
    'file.save',
    { sub: 'Импорт', items: ['file.importNative', 'file.importFig', 'file.importPptx', 'file.importHtml', 'file.importSvg'] },
    { sub: 'Экспорт', items: ['file.export', 'file.exportPptx'] },
    '-',
    'smart.generate', 'file.templates', 'board.templates', '-',
    'file.versions',
    { sub: 'Ветки', items: ['file.branches', 'file.newBranch', '-', 'file.branchUpdate', 'file.branchMerge'] },
    '-', 'page.add',
  ],
  Правка: [
    'edit.undo', 'edit.redo', 'edit.history', '-',
    'edit.cut', 'edit.copy',
    { sub: 'Копировать как', items: ['edit.copyPng', 'edit.copySvg', 'edit.copyCss'] },
    'edit.paste', 'edit.pasteInPlace', 'edit.pasteReplace', 'edit.duplicate', 'edit.delete', '-',
    'props.copy', 'props.paste', '-',
    'edit.find', 'edit.rename', '-',
    'edit.selectAll', 'edit.deselect', 'edit.selectMatching',
    { sub: 'Перейти по слоям', items: ['edit.selectChildren', 'edit.selectParent', '-', 'edit.nextSibling', 'edit.prevSibling'] },
    '-', 'board.neighbour',
  ],
  Вид: [
    'view.zoomIn', 'view.zoomOut', 'view.zoom100', 'view.fit', 'view.fitSelection', '-',
    { sub: 'Панели', items: ['view.toggleUi', 'view.toggleLeft', 'view.toggleRight', '-', 'view.layers', 'view.variables', '-', 'panel.design', 'panel.prototype', 'panel.code'] },
    { sub: 'Слои', items: ['layers.find', 'view.collapseLayers', 'view.expandLayers'] },
    '-',
    'view.rulers', 'view.layoutGrids', 'view.snapping', 'guides.clear',
    { sub: 'Пиксели', items: ['view.pixelPreview', 'view.pixelPreview1x', 'view.pixelPreview2x', '-', 'view.pixelGrid', 'view.snapPixel'] },
    { sub: 'Контурный режим', items: ['view.outlines', '-', 'view.outlineHidden', 'view.outlineBounds'] },
    '-',
    'view.comments', 'view.cursors', 'live.chat', 'live.spotlight', '-',
    'board.sections', 'board.minimap', 'board.authors', 'board.myName', '-',
    {
      sub: 'Интерфейс',
      items: ['view.settings', '-', 'view.langRu', 'view.langEn', '-', 'view.dockBottom', 'view.dockTop', 'view.dockLeft', '-', 'view.uiScale90', 'view.uiScale100', 'view.uiScale110', 'view.uiScale125', '-', 'view.propertyLabels', 'view.smartSymbols'],
    },
    'view.palette',
  ],
  Вставка: [
    'design.icons', 'design.content', 'tool.image', 'tool.bigImage', 'design.table', 'design.mockups', '-',
    'design.blob', 'design.waves', 'design.backdrop', 'design.doodle', '-',
    'board.insertLink',
  ],
  Объект: [
    'object.group', 'object.ungroup', 'object.frame', 'object.section', '-',
    { sub: 'Адаптивная раскладка', items: ['object.autoLayout', 'object.suggestAutoLayout', 'object.removeAllAutoLayout'] },
    'grid.add', 'object.codeLayer', '-',
    { sub: 'Порядок', items: ['object.front', 'object.forward', 'object.backward', 'object.back'] },
    { sub: 'Повернуть и отразить', items: ['object.flipH', 'object.flipV', '-', 'object.rotate90', 'object.rotate90back', '-', 'object.rotationOrigin'] },
    { sub: 'Сдвинуть', items: NUDGES },
    '-',
    'object.toggleVisible', 'object.toggleLock', '-',
    { sub: 'Картинка', items: ['image.crop', 'image.removeBg', 'image.erase'] },
    { sub: 'Текст по контуру', items: ['text.onPath', 'text.offPath', 'text.flipPath'] },
    '-',
    'smart.open', 'smart.editLayout', 'object.autoName', '-',
    { sub: 'Стикеры', items: ['board.sortColor', 'board.sortAuthor', 'board.sortVotes', '-', 'board.textToStickies'] },
    'board.fitSection', 'board.toggleSectionContents',
  ],
  Фигуры: [
    'shape.union', 'shape.subtract', 'shape.intersect', 'shape.exclude', 'shape.builder', '-',
    'shape.flatten', 'shape.outline', 'shape.mask', 'shape.simplify', 'shape.offset', '-',
    'shape.editPoints',
    { sub: 'Правка точек', items: ['vector.bucket', 'vector.lasso', 'vector.width', 'vector.eraser', 'vector.scissors'] },
    '-',
    'object.repeat', 'object.repeatRadial',
    { sub: 'Кисти', items: ['brush.createStretch', 'brush.createScatter'] },
  ],
  Текст: [
    { sub: 'Начертание', items: ['text.bold', 'text.italic', 'text.underline', 'text.strike'] },
    { sub: 'Выравнивание текста', items: ['text.alignLeft', 'text.alignCenter', 'text.alignRight'] },
    { sub: 'Списки', items: ['text.bulleted', 'text.numbered'] },
    'text.bigger', 'text.smaller', '-',
    'text.link', 'text.translate', 'text.replaceFonts',
  ],
  Выравнивание: [
    'align.left', 'align.hcenter', 'align.right', '-',
    'align.top', 'align.vcenter', 'align.bottom', '-',
    'align.distributeH', 'align.distributeV', '-',
    'object.tidyUp',
  ],
  Компоненты: [
    'component.create', 'component.combine', 'component.addVariant', '-',
    'component.instance', 'component.goToMain', 'component.reset', 'component.detach', '-',
    'component.assets', 'component.similar', 'edit.multiEditVariants',
  ],
  Переменные: ['variables.toCode', 'variables.fromStyles', '-', 'styles.batch'],
  Презентация: [
    'slides.present', 'slides.presentStart', '-',
    'slides.new', 'slides.next', 'slides.prev', '-',
    'slides.import', 'slides.pdf', 'slides.pptx',
  ],
};

export interface MenuCommand {
  id: string;
  group: string;
  label: string;
}

export type LaidOut<C> = { kind: 'command'; command: C } | { kind: 'separator' } | { kind: 'submenu'; label: string; items: LaidOut<C>[] };

/**
 * The sections of the menu with their commands laid out: what the layout names
 * (when the command is there — the mode and the file decide), then the rest of
 * the section's commands. A submenu of one command is that command; an empty
 * one is dropped.
 */
export function layOutMenu<C extends MenuCommand>(commands: readonly C[]): { label: string; items: LaidOut<C>[] }[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const named = new Set<string>();
  for (const entries of Object.values(MENU_LAYOUT)) {
    for (const e of entries) for (const id of typeof e === 'string' ? [e] : e.items) if (id !== '-' && byId.has(id)) named.add(id);
  }
  const one = (id: string): LaidOut<C>[] => {
    if (id === '-') return [{ kind: 'separator' }];
    const c = byId.get(id);
    return c ? [{ kind: 'command', command: c }] : [];
  };
  const sections: { label: string; items: LaidOut<C>[] }[] = [];
  for (const key of MENU_ORDER) {
    const label = tr(key);
    const items: LaidOut<C>[] = [];
    for (const e of MENU_LAYOUT[key] ?? []) {
      if (typeof e === 'string') items.push(...one(e));
      else {
        const inner = e.items.flatMap(one);
        const real = inner.filter((i) => i.kind === 'command');
        if (real.length === 1) items.push(real[0]!);
        else if (real.length > 1) items.push({ kind: 'submenu', label: tr(e.sub), items: inner });
      }
    }
    const rest = commands.filter((c) => c.group === label && !named.has(c.id));
    if (rest.length) items.push({ kind: 'separator' }, ...rest.map((command) => ({ kind: 'command' as const, command })));
    if (items.some((i) => i.kind !== 'separator')) sections.push({ label, items });
  }
  return sections;
}
