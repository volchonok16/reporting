// Right panel (spec 5.2): properties of the selection, grouped in sections.
// "Position and size" is always first and keeps constraints visible (FR-UI-004).

import { buildCellTextSection, buildTableSection } from './table-ui.ts';
import { tr } from '#core';
import { colorToHex, DEV_STATUS_LABELS, exportScaleLabel, isFrameLike, parseExportScale, rgba, type DevStatus, solid, valueEquals, type Color, type Effect, type ExportSetting, type BlendMode, type GridTrack, type LayoutGrid, type Document, type NodeId, type NodeProps, type Paint, type PropKey, type TextRunStyle, type Sizing, type Transaction, type Warp, type EllipseArc, type HandleMirror, type RepeatSettings, type BrushKind, SHAPE_TYPES } from '#core';
import { applyMirror, vertexMirror } from '#geometry';
import { DEFAULT_EXPORT, packExports, renderExports } from '../exporter.ts';
import { fontAbilities } from '../font-features.ts';
import { flipTextOnPath, takeTextOffPath } from '../text-on-path.ts';
import { variantSetOf } from '../multi-edit.ts';
import { MIXED_RUN, nodePaths, placeInGrid, type RunKey } from '#layout';
import { defaultWarp, isometricCorners } from '#geometry';
import { buildCodeLayer, lastBuild, runCodeLayer } from '../code-layer.ts';
import type { AlignEdge, Editor, EditorGesture, PickedProperty } from '../editor.ts';
import { defaultGrid, isThemePageBackground, round2, shownPageBackground, themePageBackground } from '../editor.ts';
import { FontPicker, TextStyleButtons, WeightField } from './font-picker.ts';
import { buildPaintItem, type PaintHost } from './paint-editor.ts';
import { ContextMenu } from './context-menu.ts';
import { h, helpLink, icon, clear, download } from './dom.ts';
import { formatShortcut, IS_MAC } from '../keyboard.ts';
import {
  AlignGrid,
  CHOICE_SEPARATOR,
  CheckboxField,
  ColorField,
  MIXED,
  NumberField,
  SegmentedField,
  SelectField,
  TextField,
  common,
  type Choice,
  type Field,
  type Mixed,
} from './fields.ts';
import type { CanvasView } from '../canvas-view.ts';
import { buildComponentSection, type ComponentSectionHost } from './component-section.ts';
import { buildLocalStyles, closePopover, openStyleMenu, styleButton, stylePreview, StyleRow, type LocalStylesHost } from './styles-ui.ts';
import type { StyleBinding } from '#components';
import { buildPrototypePanel, prototypeSignature } from '../prototype/panel.ts';
import { buildCodePanel } from './code-panel.ts';
import { BindableField, buildModeRows, type VariableUiHost } from './variable-ui.ts';

type Phase = 'commit' | 'start' | 'update' | 'end';


const WEIGHTS = [
  { value: '100', label: 'Thin 100' },
  { value: '200', label: 'Extra Light 200' },
  { value: '300', label: 'Light 300' },
  { value: '400', label: 'Regular 400' },
  { value: '500', label: 'Medium 500' },
  { value: '600', label: 'Semi Bold 600' },
  { value: '700', label: 'Bold 700' },
  { value: '800', label: 'Extra Bold 800' },
  { value: '900', label: 'Black 900' },
] as const;

/** Last quick-export format, kept for the session. */
let quickPreset = 'PNG 2x';

/** Which help article explains a panel section (by its title, in the current language). */
let HELP_BY_TITLE: Map<string, string> | null = null;
function helpArticleFor(title: string): string | null {
  HELP_BY_TITLE ??= new Map(
    (
      [
        ['Секция', 'frames'], ['Позиция и размер', 'constraints'], ['Размер', 'auto-layout'], ['Адаптивная раскладка', 'auto-layout'], ['Слой', 'layers'],
        ['Булева операция', 'shapes'], ['Вектор', 'shapes'], ['Концы линии', 'shapes'], ['Звезда', 'shapes'], ['Многоугольник', 'shapes'],
        ['Текст', 'text'], ['Типографика', 'text'], ['Заливка', 'fills'], ['Обводка', 'fills'], ['Цвет', 'fills'], ['Эффекты', 'effects'], ['Искажение', 'warp'],
        ['Сетки', 'layout-grids'], ['Сетки колонок', 'layout-grids'], ['Экспорт', 'export'], ['Переменные', 'variables-basics'], ['Страница', 'variables-theme'],
        ['Использование', 'styles'], ['Стили', 'styles'], ['Стили цвета', 'styles'], ['Стили текста', 'styles'], ['Стили эффектов', 'styles'], ['Стили сеток', 'styles'],
        ['Копия компонента', 'components'], ['Компонент', 'components'], ['Набор вариантов', 'variants'], ['Свойства компонента', 'component-props'], ['Свойство компонента', 'component-props'], ['Слой копии компонента', 'components'],
        ['Код', 'dev-mode'], ['Готово к разработке', 'dev-mode'], ['Взаимодействия', 'prototype-actions'], ['Потоки', 'prototype'], ['Просмотр', 'prototype'], ['Прокрутка', 'prototype-actions'],
      ] as const
    ).map(([t, id]) => [tr(t), id]),
  );
  return HELP_BY_TITLE.get(title) ?? null;
}

export class PropertiesPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly canvas: CanvasView;
  private fields: Field[] = [];
  private signature = '';
  /** Bumped on every update of the "Code" tab: it is rebuilt each time. */
  private codeTick = 0;
  private scrub: { gesture: EditorGesture; start: Map<string, number> } | null = null;
  /** The menu of a fill, stroke or effect row. */
  private menu: ContextMenu | null = null;
  /** Style being edited in the panel (its values replace the selection's sections). */
  private editingStyle: NodeId | null = null;
  /** Selected gradient stop while editing a style's gradient (styles have no canvas handles). */
  private styleStop = 0;
  /** Opens the variables table; set by the app. */
  openVariables: (variable?: NodeId) => void = () => {};
  /** Opens the prototype viewer at a screen (null: where presenting would start); set by the app. */
  present: (start: NodeId | null, newTab?: boolean) => void = () => {};
  /** Asks for a hyperlink of the selected text; set by the app. */
  editLink: () => void = () => {};
  /** Folds the panel away (the bar over the selection stays); set by the app. */
  onFold: () => void = () => {};
  /** Opens "Crop picture" for an image fill of a layer; set by the app. */
  cropImage: (id: NodeId, index: number) => void = () => {};
  eraseImage: (id: NodeId, index: number) => void = () => {};
  removeImageBackground: (id: NodeId, index: number) => void = () => {};

  constructor(editor: Editor, canvas: CanvasView) {
    this.editor = editor;
    this.canvas = canvas;
    this.el = h('aside', { class: 'panel properties-panel', 'aria-label': tr('Свойства') });
    editor.events.on('selection', (sel) => {
      if (sel.length > 0) this.editingStyle = null;
      this.allSelectionColors = false;
      this.update();
    });
    editor.events.on('gradient', () => this.update());
    editor.events.on('warpEdit', () => this.update());
    editor.events.on('vectorEdit', () => this.update());
    editor.events.on('shapeBuilder', () => this.update());
    editor.events.on('tool', () => this.update());
    editor.events.on('textSelection', () => this.update());
    editor.events.on('editText', () => this.update());
    // Changes come many times a frame while dragging: the panel follows once per frame.
    editor.events.on('change', () => this.scheduleUpdate());
    // Esc leaves the style editor (before the canvas handles it).
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.editingStyle) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
        e.stopPropagation();
        e.preventDefault();
        this.editStyle(null);
      },
      true,
    );
    editor.events.on('page', () => this.update());
    editor.events.on('mode', () => this.update());
    editor.events.on('view', () => {
      this.signature = '';
      this.update();
    });
    editor.events.on('document', () => {
      this.editingStyle = null;
      this.update();
    });
    this.update();
  }

  private get ids(): NodeId[] {
    if (this.editingStyle) return [this.editingStyle];
    const selection = this.editor.topLevelSelection();
    // Nothing selected in a presentation: the panel edits the slide on show (FEAT-165) — its fill, its settings.
    const stage = selection.length === 0 ? this.stageSlide() : null;
    return stage ? [stage] : selection;
  }

  /** The slide on show while nothing is selected, or null. */
  private stageSlide(): NodeId | null {
    if (this.editor.selection.length > 0) return null;
    const id = this.editor.slideStage?.current() ?? null;
    return id && this.editor.doc.store.isAlive(id) ? id : null;
  }

  /** Opens a style's values in the panel (null returns to the selection). */
  editStyle(style: NodeId | null): void {
    closePopover();
    this.editingStyle = style;
    this.styleStop = 0;
    this.update();
  }

  /** Rebuilds sections only when the kind of selection changes; otherwise refreshes values in place. */
  private updateFrame = 0;

  private scheduleUpdate(): void {
    if (typeof requestAnimationFrame !== 'function') return this.update();
    this.updateFrame ||= requestAnimationFrame(() => {
      this.updateFrame = 0;
      this.update();
    });
  }

  update(): void {
    if (this.updateFrame) {
      cancelAnimationFrame(this.updateFrame);
      this.updateFrame = 0;
    }
    const sig = this.computeSignature();
    if (sig !== this.signature) {
      this.signature = sig;
      this.build();
    } else {
      for (const f of this.fields) f.refresh();
    }
  }

  private computeSignature(): string {
    const d = this.editor.doc;
    if (this.editingStyle && !d.store.isAlive(this.editingStyle)) this.editingStyle = null;
    const style = this.editingStyle;
    if (style) {
      return ['style', style, d.get(style, 'styleType'), paintShape(d.get(style, 'fills')), d.get(style, 'effects').map((e) => e.type + (e.visible ? 1 : 0)).join(','), d.get(style, 'lineHeight').unit, d.get(style, 'layoutGrids').map((g) => `${g.pattern}${g.pattern === 'GRID' ? '' : g.alignment}${g.visible ? 1 : 0}`).join(',')].join(':');
    }
    if (this.editor.prototype.mode === 'prototype') return prototypeSignature(this.editor);
    // The code follows every change of the selected layer: rebuilt each time.
    if (this.editor.prototype.mode === 'code') return `code:${++this.codeTick}`;
    const ids = this.ids;
    // The shape builder's button says how to leave it.
    const builder = this.editor.shapeBuilder ? 'builder:' : '';
    // A presentation with nothing selected shows the slide on show (FEAT-165): another slide, its fill or its settings — another panel.
    const stage = this.stageSlide();
    if (stage) return `slide:${stage}:${paintShape(d.get(stage, 'fills'))}:${JSON.stringify(d.get(stage, 'slide'))}:${d.styles().length}`;
    if (ids.length === 0) return `page:${this.editor.pageId}:${d.collections().map((c) => `${c}:${d.get(c, 'modes').length}:${d.children(c).length}`).join(',')}:${d.styles().map((id) => `${id}${JSON.stringify(d.store.record(id)?.props)}`).join(',')}`;
    return builder + ids
      .map((id) => {
        const parent = d.parent(id);
        return [
          id,
          d.type(id),
          d.get(id, 'layoutMode'),
          (() => {
            const inert = alignInert(d, id);
            return `${inert.counter ?? ''}|${inert.main ?? ''}`;
          })(),
          parent ? `${d.type(parent)}:${d.get(parent, 'layoutMode')}` : '',
          d.get(id, 'layoutMode') === 'GRID' ? `${d.get(id, 'gridColumns').map((t) => t.kind).join('')}/${d.get(id, 'gridRows').map((t) => t.kind).join('')}` : '',
          d.get(id, 'gridColumn') === null && d.get(id, 'gridRow') === null ? 'auto' : 'placed',
          d.get(id, 'positioning'),
          paintShape(d.get(id, 'fills')),
          d.get(id, 'cornerRadii') === null ? 'r1' : 'r4',
          JSON.stringify(d.get(id, 'exportSettings')),
          paintShape(d.get(id, 'strokes')),
          d.get(id, 'effects').map((e) => e.type + (e.visible ? 1 : 0) + (e.type === 'NOISE' ? (e.noiseType ?? '') : '')).join(','),
          d.get(id, 'isMask') ? 'mask' : '',
          d.get(id, 'repeat')?.kind ?? '',
          this.editor.scaleMode ? 'scale' : '',
          this.allSelectionColors ? 'all-colors' : '',
          this.allSelectionFonts ? 'all-fonts' : '',
          this.editor.vectorEdit?.id === id && this.editor.vectorEdit.selected.length > 0 ? 'points' : '',
          this.editor.vectorEdit?.id === id && this.editor.vectorEdit.tool === 'eraser' ? 'eraser' : '',
          this.editor.vectorEdit?.id === id && this.editor.vectorEdit.tool === 'width' ? `width${this.editor.widthSelection}` : '',
          (() => {
            const warp = d.get(id, 'warp');
            return warp ? `${warp.type}${warp.type === 'CYLINDER' ? warp.axis : ''}${this.editor.warpEdit === id ? '*' : ''}` : '';
          })(),
          d.get(id, 'lineHeight').unit,
          d.get(id, 'sizingH').mode,
          d.get(id, 'sizingV').mode,
          // Component structure: rebuild when links, properties or variants change.
          d.get(id, 'mainComponent') ?? '',
          d.get(id, 'componentKey') ? 'layer' : '',
          d.get(id, 'overrides').length,
          JSON.stringify(d.get(id, 'propRefs')),
          d.get(id, 'componentProps').map((p) => p.id + p.name).join(','),
          d.type(id) === 'COMPONENT_SET' ? d.children(id).map((c) => d.get(c, 'name')).join(';') : '',
          d.type(id) === 'COMPONENT' && parent && d.type(parent) === 'COMPONENT_SET' ? d.get(id, 'name') : '',
          d.type(id) === 'INSTANCE' ? this.instanceSignature(id) : '',
          d.get(id, 'fillStyleId') ?? '',
          d.get(id, 'strokeStyleId') ?? '',
          d.get(id, 'effectStyleId') ?? '',
          d.get(id, 'textStyleId') ?? '',
          d.get(id, 'gridStyleId') ?? '',
          d.get(id, 'strokeWeights') === null ? 's1' : 's4',
          d.get(id, 'strokeJoin'),
          d.type(id) === 'TEXT' && d.get(id, 'textPath') ? 'path' : '',
          d.get(id, 'layoutGrids').map((g) => `${g.pattern}${g.pattern === 'GRID' ? '' : g.alignment}${g.visible ? 1 : 0}`).join(','),
        ].join(':');
      })
      .join('|') + this.textSignature() + `|vars:${d.collections().map((c) => `${c}:${d.get(c, 'modes').length}:${d.children(c).length}`).join(',')}`;
  }

  /** Text editing state changes which text controls are shown. */
  private textSignature(): string {
    const editor = this.editor;
    if (!editor.editingText) return '';
    const { start, end } = editor.textRange();
    return `|edit:${start === end ? 'caret' : 'range'}`;
  }

  private slideSectionFn: ((section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: NodeId[]) => void) | null = null;

  /** A presentation's «Слайд» section (notes, transition) for the slide of the selection (FEAT-157). */
  get slideSection(): ((section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: NodeId[]) => void) | null {
    return this.slideSectionFn;
  }

  /** Given after the panel is built (an opened file shows its slide at once, BUG-133): the panel is built again with it. */
  set slideSection(fn: ((section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: NodeId[]) => void) | null) {
    this.slideSectionFn = fn;
    this.signature = '';
    this.update();
  }

  private build(): void {
    for (const f of this.fields) f.dispose?.();
    clear(this.el);
    this.fields = [];
    this.buildTabs();
    if (this.editor.prototype.mode === 'prototype' && !this.editingStyle) {
      buildPrototypePanel({ editor: this.editor, section: (title, ...actions) => this.section(title, ...actions), present: (start, newTab) => this.present(start, newTab) });
      return;
    }
    if (this.editor.prototype.mode === 'code' && !this.editingStyle) {
      buildCodePanel({ editor: this.editor, section: (title, ...actions) => this.section(title, ...actions), exportAs: (setting) => void this.runExport([setting]) });
      return;
    }
    if (this.editingStyle) {
      this.buildStyleEditor(this.editingStyle);
      return;
    }
    const ids = this.ids;
    // A presentation's slide on show with nothing selected: the slide's own settings, as in Figma Slides (FEAT-165).
    const stage = this.stageSlide();
    if (stage) {
      this.slideSection?.((title, ...actions) => this.section(title, ...actions), [stage]);
      this.buildPaints([stage], 'fills', tr('Фон слайда'));
      buildLocalStyles(this.stylesHost());
      return;
    }
    if (ids.length === 0) {
      this.buildPage();
      buildLocalStyles(this.stylesHost());
      return;
    }
    this.buildHeader(ids);
    this.slideSection?.((title, ...actions) => this.section(title, ...actions), ids);
    buildTableSection(this.editor, (title, ...actions) => this.section(title, ...actions), ids);
    // Cells of a table (FEAT-170): the table places and sizes them — only their look is theirs.
    if (ids.every((id) => this.editor.isTableCell(id))) {
      buildCellTextSection(this.editor, (title, ...actions) => this.section(title, ...actions), ids, (f) => this.add(f));
      this.buildPaints(ids, 'fills', ids.length === 1 ? tr('Заливка ячейки') : tr('Заливка ячеек'));
      this.buildExport(ids);
      return;
    }
    const wholeTable = ids.length === 1 && !!this.editor.doc.get(ids[0]!, 'table');
    if (wholeTable) buildCellTextSection(this.editor, (title, ...actions) => this.section(title, ...actions), ids, (f) => this.add(f));
    if (ids.length === 1) buildComponentSection(this.componentHost(), ids[0]!);
    if (ids.every((id) => this.editor.doc.type(id) === 'SECTION')) this.buildSection();
    if (ids.length === 1 && this.editor.doc.get(ids[0]!, 'code') !== null) this.buildCode(ids[0]!);
    // A slide is the paper (FEAT-165): its place and size come from the format and the order, not from here.
    const pinned = ids.every((id) => this.editor.isSlide(id));
    if (!pinned) this.buildPosition(ids);
    this.buildAutoLayout(ids);
    if (!pinned) this.buildSizing(ids);
    this.buildAppearance(ids);
    this.buildShape(ids);
    if (!pinned) this.buildRepeat(ids);
    if (this.editor.scaleMode) this.buildScale();
    if (ids.every((id) => this.editor.doc.type(id) === 'TEXT')) this.buildText(ids);
    // A table's own fill is what shows between its cells (FEAT-167).
    this.buildPaints(ids, 'fills', wholeTable ? tr('Цвет линий') : tr('Заливка'));
    this.buildPaints(ids, 'strokes', tr('Обводка'));
    this.buildEffects(ids);
    if (!pinned) this.buildWarp(ids);
    this.buildSelectionColors(ids);
    this.buildSelectionFonts(ids);
    if (ids.every((id) => isFrameLike(this.editor.doc.type(id)))) this.buildLayoutGrids(ids);
    this.buildExport(ids);
  }

  /** A code layer: its HTML, what the last build said, the live page, back to plain layers. */
  private buildCode(id: NodeId): void {
    const editor = this.editor;
    const d = editor.doc;
    const body = this.section(tr('Код'));
    const area = h('textarea', { class: 'code-input', spellcheck: false, rows: 14, 'aria-label': tr('HTML, CSS и JavaScript код-слоя') }) as HTMLTextAreaElement;
    const status = h('p', { class: 'hint small code-status', role: 'status' });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (d.store.isAlive(id) && area.value !== d.get(id, 'code')) editor.commit(tr('Изменить код'), (tx) => tx.set(id, 'code', area.value));
    };
    area.addEventListener('input', () => {
      status.textContent = tr('Соберётся, когда вы остановитесь…');
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 700);
    });
    area.addEventListener('blur', save);
    // Tab types a tab, as in a code editor; Esc leaves the field.
    area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      } else if (e.key === 'Escape') area.blur();
    });
    const showStatus = () => {
      const last = lastBuild.get(id);
      status.textContent = last?.text ?? tr('Слои внутри собираются из этого кода: правьте — они обновятся.');
      status.classList.toggle('error', last?.ok === false);
    };
    const field = {
      el: area,
      refresh: () => {
        // Mid-typing the field is ahead of the document; otherwise it follows it (undo, others' edits).
        const code = d.store.isAlive(id) ? (d.get(id, 'code') ?? '') : area.value;
        if (!timer && area.value !== code) area.value = code;
        showStatus();
      },
      dispose: () => {
        if (timer) save();
      },
    };
    this.add(field);
    const off = editor.events.on('codeBuilt', (built) => built === id && showStatus());
    this.add({ el: status, refresh: () => {}, dispose: off });
    const button = (label: string, title: string, run: () => void) => h('button', { class: 'text-button', type: 'button', title, onclick: run }, h('span', {}, label));
    body.append(
      area,
      status,
      h(
        'div',
        { class: 'grid-2' },
        button(tr('Запустить'), tr('Открыть живую страницу: скрипты работают, кнопки нажимаются'), () => {
          save();
          void runCodeLayer(editor, id);
        }),
        button(tr('Собрать заново'), tr('Ещё раз выполнить код и обновить слои внутри'), () => {
          save();
          void buildCodeLayer(editor, id);
        }),
      ),
      button(tr('В обычные слои'), tr('Оставить слои внутри как есть и убрать код'), () => this.commit(tr('В обычные слои'), (tx, n) => tx.set(n, 'code', null))),
    );
  }

  /** Section: work status (FR-CNV-071) and a quick colour (FR-CNV-070). */
  private buildSection(): void {
    const d = this.editor.doc;
    const body = this.section(tr('Секция'));
    const choices = (Object.keys(DEV_STATUS_LABELS) as DevStatus[]).map((value) => ({ value, label: DEV_STATUS_LABELS[value] }));
    const status = this.add(new SelectField(tr('Статус секции'), choices, () => common(this.ids, (id) => d.get(id, 'devStatus')), (v) => this.set('devStatus', v, tr('Статус секции'))));
    body.append(this.line(tr('Статус'), status.el, tr('Метка на названии секции. «Готово к разработке» видно в фильтре слоёв и потом в режиме разработчика')));
    const swatches = h('div', { class: 'section-swatches', role: 'group', 'aria-label': tr('Цвет секции') });
    for (const [name, c] of SECTION_COLORS) {
      const color = rgba(c[0], c[1], c[2]);
      const b = h('button', { class: 'section-swatch', type: 'button', title: name, 'aria-label': name, style: `background: rgb(${c.map((v) => Math.round(v * 255)).join(',')})` });
      b.addEventListener('click', () => this.commit(tr('Цвет секции'), (tx, id) => tx.update(id, { fills: [solid(color)], fillStyleId: null })));
      swatches.append(b);
    }
    body.append(this.line(tr('Цвет'), swatches, tr('Заливку секции можно настроить и подробно, в разделе «Заливка»')));
  }

  /** Values that change the instance section's layout (variants and property values). */
  private instanceSignature(id: NodeId): string {
    const d = this.editor.doc;
    const main = d.get(id, 'mainComponent');
    if (!main || !d.store.has(main)) return 'missing';
    const set = d.parent(main);
    return [d.store.isAlive(main), set && d.type(set) === 'COMPONENT_SET' ? d.children(set).map((c) => d.get(c, 'name')).join(';') : '', JSON.stringify(d.get(id, 'propValues'))].join('|');
  }

  /** Exports the selected layers: with `override` settings, else each layer's own (or PNG 1x). */
  private async runExport(override?: ExportSetting[]): Promise<void> {
    const d = this.editor.doc;
    try {
      const result = await renderExports(this.editor, this.canvas.renderer, this.ids, (id) => override ?? (d.get(id, 'exportSettings').length > 0 ? d.get(id, 'exportSettings') : [DEFAULT_EXPORT]));
      const packed = await packExports(this.editor, result);
      if (packed) download(packed.blob, packed.name);
      for (const note of result.notes) this.editor.toast(note);
    } catch (error) {
      this.editor.toast(tr('Не удалось экспортировать: {0}', error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  /** "Design", "Prototype" and "Code" tabs at the top of the panel (FR-PRT-001, FR-DEV). */
  private buildTabs(): void {
    if (this.editingStyle) return;
    const mode = this.editor.prototype.mode;
    const tab = (value: 'design' | 'prototype' | 'code', label: string) => {
      const b = h('button', { class: `panel-tab${mode === value ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(mode === value) }, label);
      b.addEventListener('click', () => this.editor.prototype.setMode(value));
      return b;
    };
    const play = h('button', { class: 'icon-button panel-play', type: 'button', title: tr('Просмотр прототипа (Mod+Alt+Enter)').replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'), 'aria-label': tr('Просмотр прототипа') }, icon('play', 14));
    play.addEventListener('click', () => this.present(null));
    const fold = h('button', { class: 'icon-button panel-fold', type: 'button', title: tr('Свернуть панель — останется панель над выделением'), 'aria-label': tr('Свернуть правую панель'), onclick: () => this.onFold() }, icon('panelRight', 14));
    this.el.append(h('div', { class: 'panel-tabs', role: 'tablist' }, tab('design', tr('Дизайн')), tab('prototype', tr('Прототип')), tab('code', tr('Код')), play, fold));
  }

  /** What the component sections need from the panel. */
  private componentHost(): ComponentSectionHost {
    return {
      editor: this.editor,
      section: (title, ...actions) => this.section(title, ...actions),
      add: (field) => this.add(field),
    };
  }

  // ---------- writing helpers ----------

  private add<F extends Field>(field: F): F {
    this.fields.push(field);
    return field;
  }

  private section(title: string, ...actions: HTMLElement[]): HTMLElement {
    const body = h('div', { class: 'section-body' });
    // Explanations live in the help: a "?" next to the title opens the right article.
    const article = helpArticleFor(title);
    const section = h('section', { class: 'panel-section' }, h('header', { class: 'section-header' }, h('h3', {}, title), ...(article ? [helpLink(article)] : []), ...actions), body);
    this.el.append(section);
    return body;
  }

  private commit(label: string, fn: (tx: Transaction, id: NodeId) => void): void {
    const ids = this.ids;
    this.editor.commit(label, (tx) => {
      for (const id of ids) fn(tx, id);
    });
  }

  private set<K extends PropKey>(key: K, value: NodeProps[K], label = tr('Изменить свойство')): void {
    this.commit(label, (tx, id) => tx.set(id, key, value));
  }

  /** Numeric writer that supports one-step commits and scrubbing gestures. */
  private numberWriter(ids: () => NodeId[], get: (id: NodeId) => number, apply: (tx: Transaction, id: NodeId, value: number) => void, label: string) {
    return (compute: (current: number) => number, phase: Phase) => {
      const targets = ids();
      if (phase === 'commit') {
        this.editor.commit(label, (tx) => {
          for (const id of targets) apply(tx, id, round2(compute(get(id))));
        });
      } else if (phase === 'start') {
        this.scrub = { gesture: this.editor.beginGesture(label), start: new Map(targets.map((id) => [id, get(id)])) };
      } else if (phase === 'update' && this.scrub) {
        const scrub = this.scrub;
        scrub.gesture.update((tx) => {
          for (const id of targets) apply(tx, id, round2(compute(scrub.start.get(id) ?? get(id))));
        });
      } else if (phase === 'end' && this.scrub) {
        this.scrub.gesture.commit();
        this.scrub = null;
      }
    };
  }

  private variableHost(): VariableUiHost {
    return { editor: this.editor, openVariables: (v) => this.openVariables(v) };
  }

  /** Wraps a field with the "apply variable" control (FR-VAR-030). */
  private bindable(field: string, inner: Field, ids: () => NodeId[] = () => this.ids): Field {
    this.fields = this.fields.filter((f) => f !== inner);
    return this.add(new BindableField(this.variableHost(), field, inner, ids));
  }

  private numberProp(key: PropKey & keyof NodeProps, label: string, title: string, options: { icon?: string; min?: number; max?: number; suffix?: string; scale?: number; enabled?: (id: NodeId) => boolean; variable?: string } = {}): Field {
    const d = this.editor.doc;
    const scale = options.scale ?? 1;
    const ids = () => this.ids.filter((id) => (options.enabled ? options.enabled(id) : true));
    const field = this.numberPropField(key, label, title, options, ids, scale, d);
    return options.variable ? this.bindable(options.variable, field, ids) : field;
  }

  private numberPropField(key: PropKey & keyof NodeProps, label: string, title: string, options: { icon?: string; min?: number; max?: number; suffix?: string }, ids: () => NodeId[], scale: number, d: Editor['doc']): NumberField {
    return this.add(
      new NumberField({
        label,
        title,
        icon: options.icon,
        min: options.min,
        max: options.max,
        suffix: options.suffix,
        read: () => {
          const list = ids();
          if (list.length === 0) return null;
          return common(list, (id) => (d.get(id, key) as number) * scale);
        },
        write: this.numberWriter(ids, (id) => (d.get(id, key) as number) * scale, (tx, id, v) => tx.set(id, key, (v / scale) as never), title),
      }),
    );
  }

  // ---------- sections ----------

  private stylesHost(): LocalStylesHost {
    return { editor: this.editor, section: (title, ...actions) => this.section(title, ...actions), edit: (style) => this.editStyle(style) };
  }

  /** The panel while a style is open: name, description, its values, where it is used. */
  private buildStyleEditor(style: NodeId): void {
    const editor = this.editor;
    const d = editor.doc;
    const type = d.get(style, 'styleType');
    const back = h('button', { class: 'icon-button', type: 'button', title: tr('Назад к выделению (Esc)'), onclick: () => this.editStyle(null) }, icon('back'));
    const more = h('button', { class: 'icon-button', type: 'button', title: tr('Действия со стилем'), onclick: () => openStyleMenu(more, this.stylesHost(), style) }, icon('menu'));
    const kind = type === 'FILL' ? tr('Стиль цвета') : type === 'TEXT' ? tr('Стиль текста') : type === 'GRID' ? tr('Стиль сетки') : tr('Стиль эффекта');
    const header = h('div', { class: 'style-editor-header' }, back, h('h3', {}, kind), more);
    header.addEventListener('keydown', (e) => e.key === 'Escape' && this.editStyle(null));
    this.el.append(header);

    const preview = h('div', { class: `style-editor-preview kind-${type.toLowerCase()}` });
    const renderPreview = () => {
      clear(preview);
      if (!d.store.isAlive(style)) return;
      if (type === 'TEXT') {
        const lh = d.get(style, 'lineHeight');
        const size = d.get(style, 'fontSize');
        const sample = h('div', { class: 'style-text-sample' }, tr('Съешь же ещё этих мягких французских булок'));
        Object.assign(sample.style, {
          fontFamily: `"${d.get(style, 'fontFamily')}", system-ui`,
          fontWeight: String(d.get(style, 'fontWeight')),
          fontStyle: d.get(style, 'italic') ? 'italic' : 'normal',
          fontSize: `${Math.min(28, size)}px`,
          lineHeight: lh.unit === 'AUTO' ? 'normal' : lh.unit === 'PX' ? `${Math.min(28, size) * (lh.value / size)}px` : lh.unit === 'PERCENT' ? `${lh.value}%` : String(lh.value),
          textTransform: { ORIGINAL: 'none', UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[d.get(style, 'textCase')],
          textDecoration: { NONE: 'none', UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[d.get(style, 'textDecoration')],
          fontVariantCaps: { NORMAL: 'normal', SMALL_CAPS: 'small-caps', ALL_SMALL_CAPS: 'all-small-caps' }[d.get(style, 'fontVariantCaps')],
        });
        preview.append(sample);
      } else {
        preview.append(stylePreview(d, style));
      }
    };
    renderPreview();
    this.add({ el: preview, refresh: renderPreview });
    const nameField = this.add(new TextField(tr('Название стиля'), () => (d.store.isAlive(style) ? d.get(style, 'name') : null), (v) => editor.renameStyle(style, v), { label: tr('Имя') }));
    const description = this.add(
      new TextField(tr('Описание: где и как использовать стиль'), () => (d.store.isAlive(style) ? d.get(style, 'description') : null), (v) => editor.updateStyle(style, { description: v }, tr('Описание стиля')), { label: tr('Описание') }),
    );
    const info = h('div', { class: 'section-body' }, preview, nameField.el, description.el);
    this.el.append(h('section', { class: 'panel-section' }, info));

    if (type === 'FILL') this.buildPaints([style], 'fills', tr('Цвет'));
    else if (type === 'EFFECT') this.buildEffects([style]);
    else if (type === 'GRID') this.buildLayoutGrids([style]);
    else this.buildTextStyleForm(style);

    const usage = this.section(tr('Использование'));
    const users = editor.styleUsers(style);
    usage.append(
      h('p', { class: 'hint small' }, users.length > 0 ? tr('Слоёв со стилем: {0}', users.length) : tr('Пока не используется')),
      h(
        'div',
        { class: 'button-row wrap' },
        h('button', { class: 'text-button', type: 'button', disabled: users.length === 0, onclick: () => editor.selectStyleUsers(style) }, h('span', {}, tr('Выделить слои'))),
        h('button', { class: 'text-button', type: 'button', onclick: () => this.editStyle(editor.duplicateStyle(style)) }, h('span', {}, tr('Дублировать'))),
        h('button', { class: 'text-button danger', type: 'button', onclick: () => { editor.deleteStyle(style); this.editStyle(null); } }, h('span', {}, tr('Удалить'))),
      ),
    );
  }

  /** Typography of a text style (the same controls as for text layers, written to the style). */
  private buildTextStyleForm(style: NodeId): void {
    const d = this.editor.doc;
    const body = this.section(tr('Типографика'));
    const read = <K extends keyof NodeProps>(key: K) => () => (d.store.isAlive(style) ? d.get(style, key) : null);
    const family = this.add(new FontPicker(() => d, read('fontFamily'), (v) => this.set('fontFamily', v, tr('Стиль текста: шрифт'))));
    const weight = this.add(new WeightField(read('fontFamily'), read('fontWeight'), (v) => this.set('fontWeight', v, tr('Стиль текста: начертание'))));
    const size = this.numberProp('fontSize', '', tr('Размер шрифта'), { min: 1, suffix: 'px', variable: 'fontSize' });
    const italic = this.add(new CheckboxField(tr('Курсив'), read('italic'), (v) => this.set('italic', v, tr('Стиль текста: курсив'))));
    const [lhUnit, lhValue] = this.lineHeightFields();
    const letter = this.add(
      new NumberField({
        label: 'A↔',
        title: tr('Межбуквенный интервал, %'),
        suffix: '%',
        read: () => (d.store.isAlive(style) ? d.get(style, 'letterSpacing').value : null),
        write: this.numberWriter(() => [style], (id) => d.get(id, 'letterSpacing').value, (tx, id, v) => tx.set(id, 'letterSpacing', { unit: d.get(id, 'letterSpacing').unit, value: v }), tr('Стиль текста: интервал')),
      }),
    );
    const textCase = this.add(
      new SelectField(
        tr('Регистр'),
        [
          { value: 'ORIGINAL', label: tr('Как есть') },
          { value: 'UPPER', label: tr('ВСЕ ЗАГЛАВНЫЕ') },
          { value: 'LOWER', label: tr('строчные') },
          { value: 'TITLE', label: tr('Каждое Слово') },
        ] as const,
        read('textCase'),
        (v) => this.set('textCase', v, tr('Стиль текста: регистр')),
      ),
    );
    const decoration = this.add(
      new SelectField(
        tr('Оформление'),
        [
          { value: 'NONE', label: tr('Нет') },
          { value: 'UNDERLINE', label: tr('Подчёркнутый') },
          { value: 'STRIKETHROUGH', label: tr('Зачёркнутый') },
        ] as const,
        read('textDecoration'),
        (v) => this.set('textDecoration', v, tr('Стиль текста: оформление')),
      ),
    );
    const caps = this.add(
      new SelectField(
        tr('Малые заглавные'),
        [
          { value: 'NORMAL', label: tr('Нет') },
          { value: 'SMALL_CAPS', label: tr('Из строчных') },
          { value: 'ALL_SMALL_CAPS', label: tr('Все буквы') },
        ] as const,
        read('fontVariantCaps'),
        (v) => this.set('fontVariantCaps', v, tr('Стиль текста: малые заглавные')),
        tr('Малые заглавные'),
      ),
    );
    body.append(
      family.el,
      h('div', { class: 'grid-2' }, weight.el, size.el),
      italic.el,
      h('div', { class: 'grid-2' }, lhUnit.el, this.bindable('lineHeight', lhValue).el),
      h('div', { class: 'grid-2' }, this.bindable('letterSpacing', letter).el),
      h('div', { class: 'grid-2' }, textCase.el, decoration.el),
      caps.el,
      h(
        'div',
        { class: 'grid-2' },
        this.numberProp('paragraphSpacing', tr('Между'), tr('Расстояние между абзацами, px'), { min: 0, variable: 'paragraphSpacing' }).el,
        this.numberProp('paragraphIndent', tr('Отступ'), tr('Отступ первой строки абзаца, px'), { min: 0, variable: 'paragraphIndent' }).el,
      ),
    );
  }

  private buildPage(): void {
    const d = this.editor.doc;
    const page = this.editor.pageId;
    const body = this.section(tr('Страница'));
    // The canvas colour: the theme's by default (light or dark with the interface); a colour chosen
    // by hand stays for everyone, and «Сбросить» gives the theme's back.
    const color = this.add(
      new ColorField({
        title: tr('Фон холста'),
        read: () => ({ color: shownPageBackground(d.get(page, 'backgroundColor')), opacity: 1 }),
        write: (c) => this.editor.commit(tr('Фон холста'), (tx) => tx.set(page, 'backgroundColor', { ...c, a: 1 })),
      }),
    );
    const reset = h(
      'button',
      { class: 'icon-button', type: 'button', title: tr('Сбросить: цвет холста по теме'), 'aria-label': tr('Сбросить фон'), onclick: () => this.editor.commit(tr('Фон холста по теме'), (tx) => tx.set(page, 'backgroundColor', themePageBackground())) },
      icon('reset'),
    );
    // Shown only while a colour chosen by hand is set.
    const showReset = () => (reset.hidden = isThemePageBackground(d.get(page, 'backgroundColor')));
    showReset();
    this.add({ el: reset, refresh: showReset });
    body.append(h('div', { class: 'row' }, h('span', { class: 'row-label' }, tr('Фон')), color.el, reset));
    const rows = buildModeRows(this.variableHost(), [page], (f) => this.add(f));
    if (rows) body.append(h('div', { class: 'subsection-title' }, tr('Режимы переменных')), rows);
    const count = d.collections().reduce((n, c) => n + d.children(c).length, 0);
    const vars = this.section(
      tr('Переменные'),
      h('button', { class: 'icon-button', type: 'button', title: tr('Открыть таблицу переменных'), onclick: () => this.openVariables() }, icon('table')),
    );
    vars.append(
      h('p', { class: 'hint small' }, count > 0 ? tr('Коллекций: {0}, переменных: {1}.', d.collections().length, count) : tr('Пока нет')),
      h('button', { class: 'text-button wide', type: 'button', onclick: () => this.openVariables() }, icon('table', 14), h('span', {}, tr('Таблица переменных'))),
    );

  }

  private buildHeader(ids: NodeId[]): void {
    const d = this.editor.doc;
    const types = new Set(ids.map((id) => d.type(id)));
    const typeNames: Record<string, string> = {
      FRAME: tr('Фрейм'),
      COMPONENT: tr('Компонент'),
      COMPONENT_SET: tr('Набор вариантов'),
      INSTANCE: tr('Копия компонента'),
      GROUP: tr('Группа'),
      RECTANGLE: tr('Прямоугольник'),
      ELLIPSE: tr('Эллипс'),
      POLYGON: tr('Многоугольник'),
      STAR: tr('Звезда'),
      VECTOR: tr('Вектор'),
      BOOLEAN_OPERATION: tr('Булева операция'),
      LINE: tr('Линия'),
      TEXT: tr('Текст'),
    };
    const cells = ids.every((id) => this.editor.isTableCell(id));
    const title = cells ? (ids.length === 1 ? tr('Ячейка таблицы') : tr('Ячейки таблицы: {0}', ids.length)) : ids.length === 1 ? (d.get(ids[0]!, 'table') ? tr('Таблица') : (typeNames[d.type(ids[0]!)] ?? '')) : tr('Выбрано: {0}', ids.length);
    const componentish = ids.every((id) => ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(d.type(id)) || this.editor.isInstanceLayer(id));
    const header = h('div', { class: `selection-header${componentish ? ' component-header' : ''}` }, h('span', { class: 'selection-type' }, cells || types.size === 1 || ids.length === 1 ? title : tr('Выбрано: {0}', ids.length)));
    this.el.append(header);
    if (ids.length === 1) {
      const name = this.add(new TextField(tr('Имя слоя'), () => d.get(ids[0]!, 'name'), (v) => this.set('name', v, tr('Переименовать'))));
      header.append(name.el);
    }
    // Multi-edit variants (Q, as in Figma): at the top of the panel for a set, a variant or a layer in one.
    if (!d.readOnly && (this.editor.variantEdit || (ids.length > 0 && ids.every((id) => variantSetOf(d, id) === variantSetOf(d, ids[0]!)) && variantSetOf(d, ids[0]!)))) {
      const on = this.editor.variantEdit !== null;
      header.append(h('button', { class: `text-button${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), title: on ? tr('Выйти из правки всех вариантов (Q)') : tr('Править все варианты разом: выделенное в одном варианте выделяется и в остальных, добавленное — добавляется во все (Q)'), onclick: () => this.editor.toggleVariantEdit() }, icon('component', 14), h('span', {}, on ? tr('Готово: варианты') : tr('Править варианты разом'))));
    }
    // Multi-edit text (as in Figma): one text typed into all the selected text layers.
    if (ids.length > 1 && ids.every((id) => d.type(id) === 'TEXT' && !d.get(id, 'board')) && !d.readOnly) {
      header.append(h('button', { class: 'text-button', type: 'button', title: tr('Набрать один текст во всех выделенных текстовых слоях (Enter)'), onclick: () => this.editor.startMultiTextEditing(ids) }, icon('text', 14), h('span', {}, tr('Изменить текст во всех'))));
    }
    // Two groups, as in Figma: across (left, centre, right) and up–down (top, middle, bottom).
    // Shift+click moves several layers together as one block, aligned to their parent.
    const align = h('div', { class: 'align-row', role: 'toolbar', 'aria-label': tr('Выравнивание') });
    const groups: [string, string, AlignEdge][][] = [
      [
        ['alignLeft', tr('По левому краю (Alt+A)'), 'left'],
        ['alignHCenter', tr('По центру по горизонтали (Alt+H)'), 'hcenter'],
        ['alignRight', tr('По правому краю (Alt+D)'), 'right'],
      ],
      [
        ['alignTop', tr('По верху (Alt+W)'), 'top'],
        ['alignVCenter', tr('По центру по вертикали (Alt+V)'), 'vcenter'],
        ['alignBottom', tr('По низу (Alt+S)'), 'bottom'],
      ],
    ];
    for (const group of groups) {
      const box = h('div', { class: 'align-group' });
      for (const [ic, label, edge] of group) {
        const title = ids.length > 1 ? `${label}\n${tr('Shift — выровнять вместе относительно родителя; слои из разных фреймов — каждый по своему фрейму')}` : label;
        box.append(h('button', { class: 'icon-button', type: 'button', title, 'aria-label': label, onclick: (e: MouseEvent) => this.editor.align(edge, e.shiftKey) }, icon(ic)));
      }
      align.append(box);
    }
    // A table's cells stay where the table puts them (FEAT-170): nothing to align.
    if (!cells) this.el.append(align);
  }

  private buildPosition(ids: NodeId[]): void {
    const editor = this.editor;
    const d = editor.doc;
    const body = this.section(tr('Позиция и размер'));
    // Rare settings of this section (sizing limits, pinning to the parent) go into one folded block at its end.
    const more = this.foldout('position-more', tr('Дополнительно'));
    this.positionSlots = { body, more, details: more.parentElement! };
    // Layers of an instance take their geometry from the component (FR-CMP-030).
    const free = (id: NodeId) => !editor.inAutoLayout(id) && !editor.isInstanceLayer(id);
    const own = (id: NodeId) => !editor.isInstanceLayer(id);
    const x = this.numberProp('x', 'X', tr('Позиция X относительно родителя'), { enabled: free });
    const y = this.numberProp('y', 'Y', tr('Позиция Y относительно родителя'), { enabled: free });
    const size = (key: 'width' | 'height') =>
      this.add(
        new NumberField({
          label: key === 'width' ? 'W' : 'H',
          title: key === 'width' ? tr('Ширина') : tr('Высота'),
          min: 0,
          read: () => {
            const list = this.ids.filter((id) => !(key === 'height' && d.type(id) === 'LINE') && own(id));
            return list.length === 0 ? null : common(list, (id) => d.get(id, key));
          },
          write: this.numberWriter(
            () => this.ids.filter(own),
            (id) => d.get(id, key),
            (tx, id, v) => {
              const w0 = d.get(id, 'width');
              const h0 = d.get(id, 'height');
              // With the proportions locked the other side follows.
              const locked = d.get(id, 'lockAspect') && w0 > 0 && h0 > 0;
              const r2 = (n: number) => Math.round(n * 100) / 100;
              const w = key === 'width' ? v : locked ? r2((v * w0) / h0) : w0;
              const hh = key === 'height' ? v : locked ? r2((v * h0) / w0) : h0;
              editor.applySize(tx, id, w, hh, key === 'width' || locked, key === 'height' || locked);
            },
            key === 'width' ? tr('Ширина') : tr('Высота'),
          ),
        }),
      );
    // Round the centre, as the rotation handle turns it (typing the angle it showed gives the same result).
    const turnable = () => this.ids.filter(own);
    const rotation = this.add(
      new NumberField({
        label: '',
        title: tr('Поворот, градусы'),
        icon: 'rotate',
        suffix: '°',
        read: () => (turnable().length === 0 ? null : common(turnable(), (id) => d.get(id, 'rotation'))),
        write: this.numberWriter(turnable, (id) => d.get(id, 'rotation'), (tx, id, v) => editor.applyRotation(tx, id, v), tr('Поворот, градусы')),
      }),
    );
    const width = this.bindable('width', size('width'), () => this.ids.filter(own));
    const height = this.bindable('height', size('height'), () => this.ids.filter((id) => own(id) && d.type(id) !== 'LINE'));
    // «Lock aspect ratio», as in Figma: W and H change together, in the fields and by the handles.
    const lock = h('button', { class: 'icon-button aspect-lock', type: 'button' });
    const lockable = () => this.ids.filter((id) => own(id) && d.type(id) !== 'LINE');
    const showLock = () => {
      const on = lockable().length > 0 && lockable().every((id) => d.get(id, 'lockAspect'));
      lock.classList.toggle('on', on);
      lock.setAttribute('aria-pressed', String(on));
      const label = on ? tr('Пропорции сохраняются — нажмите, чтобы менять W и H отдельно') : tr('Сохранять пропорции (W и H меняются вместе)');
      lock.title = label;
      lock.setAttribute('aria-label', label);
      lock.replaceChildren(icon(on ? 'lock' : 'unlock'));
      lock.hidden = lockable().length === 0;
    };
    lock.addEventListener('click', () => {
      const on = !lockable().every((id) => d.get(id, 'lockAspect'));
      editor.commit(on ? tr('Сохранять пропорции') : tr('Не сохранять пропорции'), (tx) => {
        for (const id of lockable()) tx.set(id, 'lockAspect', on);
      });
    });
    showLock();
    this.add({ el: lock, refresh: showLock });
    const turn = (ic: string, label: string, run: () => void) => h('button', { class: 'icon-button', type: 'button', title: label, 'aria-label': label, disabled: !ids.every(own), onclick: run }, icon(ic));
    const transforms = h(
      'div',
      { class: 'transform-buttons' },
      // Shift turns the other way: the click's own handler reads it (h() adds listeners, a second one would turn twice).
      h('button', { class: 'icon-button', type: 'button', title: tr('Повернуть на 90° (Shift — против часовой)'), 'aria-label': tr('Повернуть на 90° (Shift — против часовой)'), disabled: !ids.every(own), onclick: (e: MouseEvent) => editor.rotate90(e.shiftKey) }, icon('rotate90')),
      turn('flipH', tr('Отразить по горизонтали (Shift+H)'), () => editor.flip('H')),
      turn('flipV', tr('Отразить по вертикали (Shift+V)'), () => editor.flip('V')),
    );
    body.append(
      h('div', { class: 'grid-2' }, x.el, y.el),
      h('div', { class: 'size-row' }, width.el, height.el, lock),
      h('div', { class: 'rotation-row' }, rotation.el, transforms),
    );
    // Inside an auto layout a layer can leave it on its own (a badge over a card) — right here, not folded away.
    if (ids.every((id) => editor.inAutoLayoutParent(id) && own(id))) {
      const absolute = this.add(
        new CheckboxField(tr('Вне адаптивной раскладки'), () => common(this.ids, (id) => d.get(id, 'positioning') === 'ABSOLUTE'), (v) => this.set('positioning', v ? 'ABSOLUTE' : 'AUTO', v ? tr('Вывести из адаптивной раскладки') : tr('Вернуть в адаптивную раскладку'))),
      );
      absolute.el.title = tr('Слой остаётся на своём месте и не выстраивается в ряд с остальными — например, значок поверх карточки. Остальные слои раскладки не меняются.');
      body.append(absolute.el);
      const inGrid = ids.every((id) => d.get(d.parent(id)!, 'layoutMode') === 'GRID' && d.get(id, 'positioning') === 'AUTO');
      if (inGrid && new Set(ids.map((id) => d.parent(id))).size === 1) this.buildGridPlace(body);
    }
    body.append(this.positionSlots.details);

    // Constraints are shown whenever they apply (FR-LYR-021).
    const constrained = ids.filter((id) => {
      const parent = d.parent(id);
      return parent !== null && isFrameLike(d.type(parent)) && own(id) && (d.get(parent, 'layoutMode') === 'NONE' || d.get(id, 'positioning') === 'ABSOLUTE');
    });
    if (constrained.length === ids.length) {
      const choices = [
        { value: 'MIN', label: tr('Слева') },
        { value: 'MAX', label: tr('Справа') },
        { value: 'STRETCH', label: tr('Слева и справа') },
        { value: 'CENTER', label: tr('По центру') },
        { value: 'SCALE', label: tr('Масштаб') },
      ] as const;
      const vchoices = [
        { value: 'MIN', label: tr('Сверху') },
        { value: 'MAX', label: tr('Снизу') },
        { value: 'STRETCH', label: tr('Сверху и снизу') },
        { value: 'CENTER', label: tr('По центру') },
        { value: 'SCALE', label: tr('Масштаб') },
      ] as const;
      const hField = this.add(
        new SelectField(tr('Ограничение по горизонтали'), choices, () => common(this.ids, (id) => d.get(id, 'constraints').horizontal), (v) =>
          this.commit(tr('Ограничения'), (tx, id) => tx.set(id, 'constraints', { ...d.get(id, 'constraints'), horizontal: v })), '↔'),
      );
      const vField = this.add(
        new SelectField(tr('Ограничение по вертикали'), vchoices, () => common(this.ids, (id) => d.get(id, 'constraints').vertical), (v) =>
          this.commit(tr('Ограничения'), (tx, id) => tx.set(id, 'constraints', { ...d.get(id, 'constraints'), vertical: v })), '↕'),
      );
      // In view, as in Figma's Position section (not folded away).
      const pin = h('div', { class: 'grid-2' }, hField.el, vField.el);
      pin.title = tr('Что делает слой, когда меняют размер фрейма вокруг него: держится левого края, правого, обоих (растягивается), центра или масштабируется.');
      // The way round them, as in Figma: the frame resized with Mod held leaves its layers where they are.
      const ignore = h('p', { class: 'hint small' }, tr('Растянуть фрейм, не трогая слои внутри: тяните за край, удерживая {0}.', IS_MAC ? '⌘' : 'Ctrl'));
      this.positionSlots!.details.before(h('div', { class: 'subsection-title' }, tr('Привязка к краям фрейма')), pin, ignore);
    }
    if (!more.childElementCount) this.positionSlots.details.remove();
  }

  /** Where the position section takes sizing rows and rare settings (set by buildPosition). */
  private positionSlots: { body: HTMLElement; more: HTMLElement; details: HTMLElement } | null = null;

  /** A labelled line: text label on the left, control on the right. */
  private line(label: string, control: HTMLElement, title?: string): HTMLElement {
    return h('div', { class: 'prop-line', title: title ?? '' }, h('span', { class: 'prop-label' }, label), control);
  }

  private buildAutoLayout(ids: NodeId[]): void {
    const editor = this.editor;
    const d = editor.doc;
    if (!ids.every((id) => isFrameLike(d.type(id)))) return;
    const enabled = ids.every((id) => d.get(id, 'layoutMode') !== 'NONE');
    // An instance can adjust spacing and padding (overrides) but its structure follows the component.
    const fromComponent = ids.some((id) => d.type(id) === 'INSTANCE' || editor.isInstanceLayer(id));
    if (fromComponent && !enabled) return;
    const toggle = fromComponent
      ? null
      : h(
          'button',
          { class: 'icon-button', type: 'button', title: enabled ? tr('Убрать адаптивную раскладку (Shift+A)') : tr('Добавить адаптивную раскладку (Shift+A)'), onclick: () => editor.addAutoLayout() },
          icon(enabled ? 'minus' : 'plus'),
        );
    const body = toggle ? this.section(tr('Адаптивная раскладка'), toggle) : this.section(tr('Адаптивная раскладка'));
    if (!enabled) {
      body.append(
        h('button', { class: 'text-button wide', type: 'button', onclick: () => editor.addAutoLayout() }, icon('plus', 14), h('span', {}, tr('Включить адаптивную раскладку (Shift+A)'))),
      );
      return;
    }
    const direction = this.add(
      new SegmentedField(
        tr('Направление'),
        [
          { value: 'HORIZONTAL', label: tr('Строка'), icon: 'arrowRight' },
          { value: 'VERTICAL', label: tr('Столбец'), icon: 'arrowDown' },
          { value: 'GRID', label: tr('Сетка'), icon: 'table' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'layoutMode') as 'HORIZONTAL' | 'VERTICAL' | 'GRID'),
        (v) => this.setLayoutMode(v),
        true,
      ),
    );
    body.append(direction.el);
    if (ids.every((id) => d.get(id, 'layoutMode') === 'GRID')) {
      this.buildGrid(body);
      this.buildOverflowNote(body);
      this.buildPadding(body);
      return;
    }
    if (ids.every((id) => d.get(id, 'layoutMode') === 'HORIZONTAL')) {
      const wrap = this.add(new CheckboxField(tr('Переносить на новую строку, если не помещается'), () => common(this.ids, (id) => d.get(id, 'layoutWrap')), (v) => this.set('layoutWrap', v, tr('Перенос'))));
      body.append(wrap.el);
    }

    // Alignment: a 3×3 picture of the frame; the dot is where the children go.
    const horizontal = () => d.get(this.ids[0]!, 'layoutMode') === 'HORIZONTAL';
    const grid = this.add(
      new AlignGrid(
        () => {
          const first = this.ids[0];
          if (!first) return null;
          const primary = d.get(first, 'primaryAlign');
          const counter = d.get(first, 'counterAlign');
          const distributed = d.get(first, 'spacingMode') !== 'FIXED';
          const h2 = horizontal();
          const counterAlign = counter === 'MIN' || counter === 'CENTER' || counter === 'MAX' ? counter : 'MIN';
          return h2
            ? { x: primary, y: counterAlign, distributed: distributed ? 'x' : null }
            : { x: counterAlign, y: primary, distributed: distributed ? 'y' : null };
        },
        (x, y) =>
          this.commit(tr('Выравнивание'), (tx, id) => {
            const h2 = d.get(id, 'layoutMode') === 'HORIZONTAL';
            tx.set(id, 'primaryAlign', h2 ? x : y);
            tx.set(id, 'counterAlign', h2 ? y : x);
          }),
      ),
    );
    // Negative: the layers overlap (avatars in a stack), as in Figma.
    const gap = this.numberProp('itemSpacing', '', tr('Промежуток между слоями, px; меньше нуля — слои наезжают друг на друга'), { icon: 'gap', variable: 'itemSpacing' });
    const spacing = this.add(
      new SelectField(
        tr('Как распределять слои'),
        [
          { value: 'FIXED', label: tr('Промежуток') },
          { value: 'BETWEEN', label: tr('Раздвинуть') },
          { value: 'AROUND', label: tr('Поровну вокруг') },
          { value: 'EVENLY', label: tr('Равномерно') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'spacingMode')),
        (v) => this.set('spacingMode', v, tr('Распределение')),
      ),
    );
    const side = h('div', { class: 'align-side' }, spacing.el, gap.el);
    body.append(h('div', { class: 'align-block' }, grid.el, side));
    // What would not move a thing says so (the dots and «Раздвинуть» did nothing and looked broken).
    const inert = alignInert(d, ids[0]!);
    if (inert.counter || inert.main) {
      grid.el.classList.toggle('inert', !!inert.counter && !!inert.main);
      spacing.el.classList.toggle('inert', !!inert.main);
      body.append(h('p', { class: 'field-explain' }, [inert.counter, inert.main].filter(Boolean).join(' ')));
    }
    this.buildOverflowNote(body);
    if (ids.every((id) => d.get(id, 'layoutMode') === 'HORIZONTAL')) {
      const baseline = this.add(
        new CheckboxField(tr('По базовой линии текста'), () => common(this.ids, (id) => d.get(id, 'counterAlign') === 'BASELINE'), (v) => this.set('counterAlign', v ? 'BASELINE' : 'MIN', tr('Выравнивание'))),
      );
      baseline.el.title = tr('Слои в строке встают так, чтобы первые строки их текста стояли на одной линии');
      body.append(baseline.el);
    }
    if (ids.every((id) => d.get(id, 'layoutWrap'))) {
      const rows = this.add(
        new SelectField(
          tr('Как распределять строки'),
          [
            { value: 'AUTO', label: tr('Промежуток') },
            { value: 'SPACE_BETWEEN', label: tr('Раздвинуть') },
          ] as const,
          () => common(this.ids, (id) => d.get(id, 'counterAxisAlignContent')),
          (v) => this.set('counterAxisAlignContent', v, tr('Распределение строк')),
        ),
      );
      const rowGap = this.numberProp('counterAxisSpacing', '', tr('Промежуток между строками при переносе'), { icon: 'gap', min: 0, variable: 'counterAxisSpacing' });
      body.append(h('div', { class: 'subsection-title' }, tr('Между строками')), h('div', { class: 'grid-2' }, rows.el, rowGap.el));
    }
    const stacking = this.add(
      new SelectField(
        tr('Какой слой рисуется поверх, если слои наезжают друг на друга'),
        [
          { value: 'LAST', label: tr('Поверх: последний слой') },
          { value: 'FIRST', label: tr('Поверх: первый слой') },
        ] as const,
        () => common(this.ids, (id) => (d.get(id, 'itemReverseZIndex') ? 'FIRST' : 'LAST')),
        (v) => this.set('itemReverseZIndex', v === 'FIRST', tr('Наложение слоёв')),
      ),
    );
    body.append(stacking.el);
    this.buildPadding(body);
  }

  /**
   * «Содержимое выше рамки на N px» and «По содержимому»: a frame of a fixed size whose layers
   * stick out of it (a landing's header above the frame and its footer below — 1 November).
   * Follows the drag live; hidden while everything fits.
   */
  private buildOverflowNote(body: HTMLElement): void {
    const d = this.editor.doc;
    for (const axis of ['y', 'x'] as const) {
      const text = h('span', {});
      const label = axis === 'y' ? tr('Высота по содержимому') : tr('Ширина по содержимому');
      const fix = h('button', { class: 'text-button', type: 'button', title: label, onclick: () => this.set(axis === 'y' ? 'sizingV' : 'sizingH', { mode: 'HUG' }, label) }, tr('По содержимому'));
      const el = h('p', { class: 'field-explain overflow-note' }, text, ' ', fix);
      const field = this.add({
        el,
        refresh: () => {
          const n = Math.max(0, ...this.ids.map((id) => contentOverflow(d, id)[axis]));
          el.hidden = n === 0;
          text.textContent = axis === 'y' ? tr('Содержимое выше рамки на {0} px.', n) : tr('Содержимое шире рамки на {0} px.', n);
        },
      });
      field.refresh();
      body.append(el);
    }
  }

  /** Padding and "strokes take room": the same for rows, columns and grids. */
  private buildPadding(body: HTMLElement): void {
    const d = this.editor.doc;
    body.append(
      h('div', { class: 'subsection-title' }, tr('Внутренние отступы')),
      h(
        'div',
        { class: 'grid-2' },
        this.numberProp('paddingTop', tr('Сверху'), tr('Отступ от верхнего края фрейма до содержимого'), { min: 0, variable: 'paddingTop' }).el,
        this.numberProp('paddingBottom', tr('Снизу'), tr('Отступ от нижнего края фрейма до содержимого'), { min: 0, variable: 'paddingBottom' }).el,
        this.numberProp('paddingLeft', tr('Слева'), tr('Отступ от левого края фрейма до содержимого'), { min: 0, variable: 'paddingLeft' }).el,
        this.numberProp('paddingRight', tr('Справа'), tr('Отступ от правого края фрейма до содержимого'), { min: 0, variable: 'paddingRight' }).el,
      ),
    );
    const strokes = this.add(
      new CheckboxField(tr('Учитывать обводки в раскладке'), () => common(this.ids, (id) => d.get(id, 'strokesIncludedInLayout')), (v) => this.set('strokesIncludedInLayout', v, tr('Обводки в раскладке'))),
    );
    strokes.el.title = tr('Обводка фрейма работает как отступ, обводки слоёв внутри занимают место — ничего не залезает друг на друга');
    body.append(strokes.el);
  }

  /**
   * Switches the layout: to a grid, the layers keep their order and fill the
   * cells in reading order, and the picture stays — a row becomes a column per
   * layer, a column one column (a landing's sections were dealt into four or two
   * columns, the text broken letter by letter); the gap stays as it was.
   */
  private setLayoutMode(mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID'): void {
    const d = this.editor.doc;
    this.commit(mode === 'GRID' ? tr('Раскладка сеткой') : tr('Направление'), (tx, id) => {
      const was = d.get(id, 'layoutMode');
      tx.set(id, 'layoutMode', mode);
      if (mode !== 'GRID' || was === 'GRID') return;
      const count = d.children(id).filter((c) => d.get(c, 'positioning') === 'AUTO').length;
      const columns = was === 'HORIZONTAL' ? Math.min(48, Math.max(1, count)) : was === 'VERTICAL' ? 1 : Math.min(2, Math.max(1, count));
      tx.set(id, 'gridColumns', Array.from({ length: columns }, () => ({ kind: 'FR', value: 1 }) as GridTrack));
      tx.set(id, 'gridRows', []);
      tx.set(id, 'gridColumnGap', d.get(id, 'itemSpacing'));
      tx.set(id, 'gridRowGap', d.get(id, 'layoutWrap') ? d.get(id, 'counterAxisSpacing') : d.get(id, 'itemSpacing'));
      for (const c of d.children(id)) {
        if (d.get(c, 'gridColumn') !== null) tx.set(c, 'gridColumn', null);
        if (d.get(c, 'gridRow') !== null) tx.set(c, 'gridRow', null);
      }
    });
  }

  /** Columns and rows of a grid: how many, how each is sized, and the gaps. */
  private buildGrid(body: HTMLElement): void {
    const d = this.editor.doc;
    const first = this.ids[0]!;
    const KINDS = [
      { value: 'FR', label: tr('Доля') },
      { value: 'FIXED', label: tr('Фикс., px') },
      { value: 'HUG', label: tr('По содержимому') },
    ] as const;
    const tracksEditor = (key: 'gridColumns' | 'gridRows', title: string, countTitle: string, min: number) => {
      const tracks = d.get(first, key);
      const writeTracks = (label: string, fn: (list: GridTrack[]) => GridTrack[]) =>
        this.commit(label, (tx, id) => tx.set(id, key, fn(structuredClone(d.get(id, key)))));
      const count = this.add(
        new NumberField({
          label: '',
          title: countTitle,
          icon: key === 'gridColumns' ? 'columns' : 'rows',
          min,
          max: 48,
          read: () => common(this.ids, (id) => d.get(id, key).length),
          write: this.numberWriter(
            () => this.ids,
            (id) => d.get(id, key).length,
            (tx, id, v) => {
              const n = Math.max(min, Math.min(48, Math.round(v)));
              const list = structuredClone(d.get(id, key));
              const last: GridTrack = list[list.length - 1] ?? (key === 'gridColumns' ? { kind: 'FR', value: 1 } : { kind: 'HUG' });
              while (list.length < n) list.push(structuredClone(last));
              list.length = n;
              tx.set(id, key, list);
            },
            countTitle,
          ),
        }),
      );
      body.append(this.line(title, count.el, countTitle));
      if (key === 'gridRows' && tracks.length === 0) {
        body.append(h('p', { class: 'field-explain' }, tr('Строки добавляются сами, по высоте содержимого.')));
        return;
      }
      tracks.forEach((_, i) => {
        const kind = this.add(
          new SelectField(
            tr('Размер: доля свободного места, фиксированный или по содержимому'),
            KINDS,
            () => common(this.ids, (id) => d.get(id, key)[i]?.kind ?? 'HUG'),
            (k) =>
              writeTracks(tr('Размер дорожки'), (list) => {
                const old = list[i];
                list[i] = k === 'HUG' ? { kind: 'HUG' } : k === 'FR' ? { kind: 'FR', value: old && old.kind === 'FR' ? old.value : 1 } : { kind: 'FIXED', value: old && old.kind === 'FIXED' ? old.value : 100 };
                return list;
              }),
            String(i + 1),
          ),
        );
        const row = h('div', { class: 'grid-2 grid-track' }, kind.el);
        const t = tracks[i]!;
        if (t.kind !== 'HUG') {
          const value = this.add(
            new NumberField({
              label: t.kind === 'FR' ? 'fr' : 'px',
              title: t.kind === 'FR' ? tr('Доля свободного места') : tr('Размер, px'),
              min: 0,
              read: () => common(this.ids, (id) => {
                const x = d.get(id, key)[i];
                return x && x.kind !== 'HUG' ? x.value : 0;
              }),
              write: this.numberWriter(
                () => this.ids,
                (id) => {
                  const x = d.get(id, key)[i];
                  return x && x.kind !== 'HUG' ? x.value : 0;
                },
                (tx, id, v) => {
                  const list = structuredClone(d.get(id, key));
                  const x = list[i];
                  if (x && x.kind !== 'HUG') list[i] = { kind: x.kind, value: Math.max(0, v) };
                  tx.set(id, key, list);
                },
                tr('Размер дорожки'),
              ),
            }),
          );
          row.append(value.el);
        }
        body.append(row);
      });
    };
    tracksEditor('gridColumns', tr('Столбцы'), tr('Сколько столбцов'), 1);
    tracksEditor('gridRows', tr('Строки'), tr('Сколько строк (0 — сколько понадобится)'), 0);
    body.append(
      h(
        'div',
        { class: 'grid-2' },
        this.numberProp('gridColumnGap', '', tr('Промежуток между столбцами, px'), { icon: 'gap', min: 0 }).el,
        this.numberProp('gridRowGap', '', tr('Промежуток между строками, px'), { icon: 'gapRows', min: 0 }).el,
      ),
    );
  }

  /** A layer inside a grid: its cell (or "in order"), how many cells it takes, and where it sits in them. */
  private buildGridPlace(body: HTMLElement): void {
    const d = this.editor.doc;
    const cellOf = (id: NodeId) => placeInGrid(d, d.parent(id)!, d.children(d.parent(id)!).filter((c) => d.get(c, 'visible') && d.get(c, 'positioning') === 'AUTO')).cells.get(id);
    const place = (axis: 'gridColumn' | 'gridRow', label: string, title: string) =>
      this.add(
        new NumberField({
          label,
          title,
          min: 1,
          read: () => common(this.ids, (id) => ((axis === 'gridColumn' ? cellOf(id)?.column : cellOf(id)?.row) ?? 0) + 1),
          write: this.numberWriter(
            () => this.ids,
            (id) => ((axis === 'gridColumn' ? cellOf(id)?.column : cellOf(id)?.row) ?? 0) + 1,
            (tx, id, v) => {
              // Putting a layer somewhere fixes both coordinates: it no longer moves with the order.
              const cell = cellOf(id);
              tx.set(id, 'gridColumn', axis === 'gridColumn' ? Math.max(0, Math.round(v) - 1) : (cell?.column ?? 0));
              tx.set(id, 'gridRow', axis === 'gridRow' ? Math.max(0, Math.round(v) - 1) : (cell?.row ?? 0));
            },
            tr('Место в сетке'),
          ),
        }),
      );
    const spanField = (key: 'gridColumnSpan' | 'gridRowSpan', label: string, title: string) => this.numberProp(key, label, title, { min: 1 });
    const placed = this.ids.some((id) => d.get(id, 'gridColumn') !== null || d.get(id, 'gridRow') !== null);
    body.append(
      h('div', { class: 'subsection-title' }, tr('Место в сетке')),
      h('div', { class: 'grid-2' }, place('gridColumn', tr('Столбец'), tr('Столбец, с которого начинается слой')).el, place('gridRow', tr('Строка'), tr('Строка, с которой начинается слой')).el),
      h('div', { class: 'grid-2' }, spanField('gridColumnSpan', tr('Шир.'), tr('Сколько столбцов занимает слой')).el, spanField('gridRowSpan', tr('Выс.'), tr('Сколько строк занимает слой')).el),
    );
    const alignH = this.add(
      new SegmentedField(
        tr('Внутри ячейки по горизонтали'),
        [
          { value: 'MIN', label: tr('Слева'), icon: 'alignLeft' },
          { value: 'CENTER', label: tr('По центру'), icon: 'alignHCenter' },
          { value: 'MAX', label: tr('Справа'), icon: 'alignRight' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'gridAlignH')),
        (v) => this.set('gridAlignH', v, tr('Выравнивание в ячейке')),
      ),
    );
    const alignV = this.add(
      new SegmentedField(
        tr('Внутри ячейки по вертикали'),
        [
          { value: 'MIN', label: tr('Сверху'), icon: 'alignTop' },
          { value: 'CENTER', label: tr('По центру'), icon: 'alignVCenter' },
          { value: 'MAX', label: tr('Снизу'), icon: 'alignBottom' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'gridAlignV')),
        (v) => this.set('gridAlignV', v, tr('Выравнивание в ячейке')),
      ),
    );
    body.append(h('div', { class: 'grid-2' }, alignH.el, alignV.el));
    if (placed) {
      body.append(
        h(
          'button',
          {
            class: 'text-button wide',
            type: 'button',
            title: tr('Слой встанет в первую свободную ячейку по порядку слоёв'),
            onclick: () =>
              this.commit(tr('Место по порядку'), (tx, id) => {
                tx.set(id, 'gridColumn', null);
                tx.set(id, 'gridRow', null);
              }),
          },
          tr('Ставить по порядку'),
        ),
      );
    }
  }

  private buildSizing(ids: NodeId[]): void {
    const editor = this.editor;
    const d = editor.doc;
    const relevant = ids.every((id) => (editor.inAutoLayout(id) || (isFrameLike(d.type(id)) && d.get(id, 'layoutMode') !== 'NONE')) && !editor.isInstanceLayer(id));
    if (!relevant) return;
    // Not a section of its own (it repeated "Width/Height"): how the size behaves sits under W and H.
    const slots = this.positionSlots;
    const body = slots?.body ?? this.section(tr('Размер'));
    const before = slots?.details.isConnected ? slots.details : null;
    const put = (...els: HTMLElement[]) => {
      for (const el of els) body.insertBefore(el, before);
    };
    const more = slots?.more ?? body;
    const inLayout = ids.every((id) => editor.inAutoLayout(id));
    const choices = [
      { value: 'FIXED', label: tr('Фиксированная') },
      { value: 'HUG', label: tr('По содержимому') },
      ...(inLayout
        ? ([
            { value: 'FILL', label: tr('Заполнить') },
            { value: 'PERCENT', label: tr('Процент от родителя') },
            { value: 'FR', label: tr('Доля свободного места (fr)') },
          ] as const)
        : []),
    ] as { value: Sizing['mode']; label: string }[];
    const axis = (key: 'sizingH' | 'sizingV', title: string, short: string) => {
      const select = this.add(
        new SelectField(title, choices, () => common(this.ids, (id) => d.get(id, key).mode), (mode) => {
          const sizing: Sizing = mode === 'PERCENT' ? { mode, value: 50 } : mode === 'FR' ? { mode, value: 1 } : { mode };
          this.set(key, sizing, title);
        }, short),
      );
      const row = h('div', { class: 'grid-2' }, select.el);
      row.classList.add('sizing-row');
      const modes = ids.map((id) => d.get(id, key).mode);
      if (modes.every((m) => m === 'PERCENT' || m === 'FR')) {
        const value = this.add(
          new NumberField({
            label: modes[0] === 'PERCENT' ? '%' : 'fr',
            title: modes[0] === 'PERCENT' ? tr('Процент от родителя') : tr('Доля свободного места'),
            min: 0,
            read: () => common(this.ids, (id) => {
              const s = d.get(id, key);
              return s.mode === 'PERCENT' || s.mode === 'FR' ? s.value : 0;
            }),
            write: this.numberWriter(
              () => this.ids,
              (id) => {
                const s = d.get(id, key);
                return s.mode === 'PERCENT' || s.mode === 'FR' ? s.value : 0;
              },
              (tx, id, v) => {
                const s = d.get(id, key);
                if (s.mode === 'PERCENT' || s.mode === 'FR') tx.set(id, key, { mode: s.mode, value: v });
              },
              title,
            ),
          }),
        );
        row.append(value.el);
      }
      put(row);
    };
    axis('sizingH', tr('Ширина: как меняется («По содержимому» — обтягивает слои, «Заполнить» — занимает свободное место)'), '↔ W');
    axis('sizingV', tr('Высота: как меняется («По содержимому» — обтягивает слои, «Заполнить» — занимает свободное место)'), '↕ H');
    if (inLayout) {
      const minmax = (key: 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', label: string, title: string) =>
        this.add(
          new NumberField({
            label,
            title,
            min: 0,
            read: () => common(this.ids, (id) => d.get(id, key)?.value ?? 0),
            write: this.numberWriter(
              () => this.ids,
              (id) => d.get(id, key)?.value ?? 0,
              (tx, id, v) => tx.set(id, key, v > 0 ? { unit: d.get(id, key)?.unit ?? 'PX', value: v } : null),
              title,
            ),
          }),
        );
      more.append(
        h('div', { class: 'subsection-title' }, tr('Мин. и макс. размер (0 — без ограничения)')),
        h('div', { class: 'grid-2' }, minmax('minWidth', 'min W', tr('Минимальная ширина')).el, minmax('maxWidth', 'max W', tr('Максимальная ширина')).el),
        h('div', { class: 'grid-2' }, minmax('minHeight', 'min H', tr('Минимальная высота')).el, minmax('maxHeight', 'max H', tr('Максимальная высота')).el),
      );
      if (slots && !slots.details.isConnected) body.append(slots.details);
    }
  }

  /** Parameters of polygons, stars and line ends. */
  private buildShape(ids: NodeId[]): void {
    const d = this.editor.doc;
    const types = new Set(ids.map((id) => d.type(id)));
    // Several shapes: boolean operations (as Figma's toolbar) and the shape builder, which otherwise hide behind shortcuts.
    if (ids.length > 1 && ids.every((id) => SHAPE_TYPES.includes(d.type(id)) && d.type(id) !== 'LINE')) {
      const body = this.section(tr('Фигуры'));
      const ops = [
        { op: 'UNION', label: tr('Объединить фигуры'), keys: 'Alt+Shift+U' },
        { op: 'SUBTRACT', label: tr('Вычесть верхние фигуры из нижней'), keys: 'Alt+Shift+S' },
        { op: 'INTERSECT', label: tr('Оставить только пересечение'), keys: 'Alt+Shift+I' },
        { op: 'EXCLUDE', label: tr('Оставить всё, кроме пересечения'), keys: 'Alt+Shift+E' },
      ] as const;
      body.append(
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': tr('Булева операция') },
          ...ops.map(({ op, label, keys }) => h('button', { class: 'segment', type: 'button', title: `${label} (${formatShortcut(keys)})`, 'aria-label': label, onclick: () => this.editor.booleanSelection(op) }, icon(op.toLowerCase(), 14))),
        ),
      );
      const on = !!this.editor.shapeBuilder;
      body.append(h('button', { class: `text-button wide${on ? ' primary' : ''}`, type: 'button', title: tr('Фигуры разрежутся на области: щелчок отделяет область, протягивание сливает, Alt+щелчок удаляет'), 'aria-pressed': String(on), onclick: () => this.editor.startShapeBuilder() }, h('span', {}, on ? tr('Выйти из конструктора (Esc)') : tr('Конструктор фигур (⇧M)'))));
    }
    if (types.size !== 1) return;
    const type = [...types][0]!;
    if (type === 'BOOLEAN_OPERATION') {
      const body = this.section(tr('Булева операция'));
      const op = this.add(
        new SegmentedField(
          tr('Операция'),
          [
            { value: 'UNION', label: tr('Объединить'), icon: 'union' },
            { value: 'SUBTRACT', label: tr('Вычесть верхние из нижней'), icon: 'subtract' },
            { value: 'INTERSECT', label: tr('Пересечение'), icon: 'intersect' },
            { value: 'EXCLUDE', label: tr('Оставить всё, кроме пересечения'), icon: 'exclude' },
          ] as const,
          () => common(this.ids, (id) => d.get(id, 'booleanOp')),
          (v) => this.commit(tr('Булева операция'), (tx, id) => tx.update(id, { booleanOp: v })),
        ),
      );
      body.append(
        op.el,
        h('button', { class: 'text-button wide', type: 'button', onclick: () => this.editor.flattenSelection() }, h('span', {}, tr('Слить в одну фигуру (⌘E)'))),
      );
      return;
    }
    if (type === 'VECTOR') {
      const body = this.section(tr('Вектор'));
      const rule = this.add(
        new SelectField(
          tr('Где контуры накладываются друг на друга'),
          [
            { value: 'NONZERO', label: tr('Закрашивать всё') },
            { value: 'EVENODD', label: tr('Вырезать дырки') },
          ] as const,
          () => common(this.ids, (id) => d.get(id, 'vectorNetwork')?.regions[0]?.windingRule ?? d.get(id, 'windingRule')),
          (v) =>
            this.commit(tr('Наложение контуров'), (tx, id) => {
              tx.set(id, 'windingRule', v);
              // A network keeps the rule in its regions.
              const net = d.get(id, 'vectorNetwork');
              if (net) tx.set(id, 'vectorNetwork', { ...net, regions: net.regions.map((r) => ({ ...r, windingRule: v })) });
            }),
        ),
      );
      // Corner radius as in Figma: the whole vector, or the points selected in point editing.
      const radius = this.numberProp('cornerRadius', '', tr('Скругление всех углов, px — и между прямыми, и между кривыми. У точки со своим скруглением — её значение'), { icon: 'radius', min: 0, variable: 'cornerRadius' });
      body.append(this.line(tr('Скругление'), radius.el, tr('Скругление углов')));
      const edit = this.editor.vectorEdit;
      if (edit && ids.length === 1 && edit.id === ids[0] && edit.selected.length > 0) {
        const id = edit.id;
        const points = () => {
          const e = this.editor.vectorEdit;
          return e && e.id === id ? e.selected.map(Number) : [];
        };
        const pointRadius = this.add(
          new NumberField({
            label: '',
            icon: 'radius',
            title: tr('Скругление выбранных точек, px. Скругляется угол между двумя отрезками — прямыми или кривыми'),
            min: 0,
            read: () => {
              const net = d.get(id, 'vectorNetwork');
              const list = points().filter((v) => net?.vertices[v]);
              if (!net || list.length === 0) return null;
              const of = (v: number) => net.vertices[v]!.cornerRadius ?? d.get(id, 'cornerRadius');
              const first = of(list[0]!);
              return list.every((v) => of(v) === first) ? first : MIXED;
            },
            scrubAsCommits: true,
            write: (compute, phase) => {
              if (phase !== 'commit') return;
              const net = d.get(id, 'vectorNetwork');
              if (!net) return;
              const chosen = new Set(points());
              const layer = d.get(id, 'cornerRadius');
              this.editor.commit(tr('Скругление точек'), (tx) =>
                tx.set(id, 'vectorNetwork', {
                  ...net,
                  vertices: net.vertices.map((v, i) => (chosen.has(i) ? { ...v, cornerRadius: Math.max(0, round2(compute(v.cornerRadius ?? layer))) } : v)),
                }),
              );
            },
          }),
        );
        body.append(this.line(tr('Скругление точек'), pointRadius.el, tr('Скругление выбранных точек')));
        // Figma's mirroring: how the two handles of a point follow each other.
        const mirror = this.add(
          new SelectField<HandleMirror>(
            tr('Как ручки точки повторяют друг друга, когда тянешь одну из них (Alt при перетаскивании разрывает связь)'),
            [
              { value: 'NONE', label: tr('Без зеркалирования') },
              { value: 'ANGLE', label: tr('Угол') },
              { value: 'ANGLE_AND_LENGTH', label: tr('Угол и длина') },
            ],
            () => {
              const net = d.get(id, 'vectorNetwork');
              const list = points().filter((v) => net?.vertices[v]);
              return net && list.length ? common(list.map(String), (v) => vertexMirror(net, Number(v))) : null;
            },
            (value) => {
              const net = d.get(id, 'vectorNetwork');
              if (!net) return;
              const chosen = new Set(points());
              this.editor.commit(tr('Зеркалирование ручек'), (tx) =>
                tx.set(id, 'vectorNetwork', applyMirror({ ...net, vertices: net.vertices.map((v, i) => (chosen.has(i) ? { ...v, mirror: value } : v)) }, chosen)),
              );
            },
          ),
        );
        body.append(this.line(tr('Зеркалирование'), mirror.el, tr('Как ручки точки повторяют друг друга')));
      }
      const chosenWidth = edit && edit.tool === 'width' && ids.length === 1 && edit.id === ids[0] ? this.editor.widthSelection : null;
      if (chosenWidth !== null) {
        const id = ids[0]!;
        const width = this.add(
          new NumberField({
            label: '',
            title: tr('Толщина линии в этой точке, px'),
            min: 0,
            suffix: 'px',
            read: () => {
              const w = d.get(id, 'widthPoints')[chosenWidth];
              return w ? round2(w.width * d.get(id, 'strokeWeight')) : null;
            },
            scrubAsCommits: true,
            write: (compute, phase) => {
              const points = d.get(id, 'widthPoints');
              const w = points[chosenWidth];
              const weight = d.get(id, 'strokeWeight');
              if (phase !== 'commit' || !w || weight <= 0) return;
              const px = Math.max(0, compute(w.width * weight));
              this.editor.commit(tr('Точка ширины'), (tx) => tx.set(id, 'widthPoints', points.map((x, i) => (i === chosenWidth ? { ...x, width: round2(px / weight) } : x))));
            },
          }),
        );
        body.append(this.line(tr('Ширина в точке'), width.el, tr('Толщина линии в выбранной точке ширины')));
      }
      if (edit && edit.tool === 'eraser') {
        const weight = this.add(
          new NumberField({
            label: '',
            title: tr('Толщина ластика, px'),
            min: 1,
            max: 500,
            suffix: 'px',
            read: () => this.editor.eraserWeight,
            scrubAsCommits: true,
            write: (compute, phase) => {
              if (phase === 'commit') this.editor.setEraserWeight(round2(compute(this.editor.eraserWeight)));
            },
          }),
        );
        body.append(this.line(tr('Толщина ластика'), weight.el, tr('Сколько стирает ластик за один проход')));
      }
      body.append(
        this.line(tr('Наложение'), rule.el, tr('Как закрашивать места, где контур пересекает сам себя или один контур лежит внутри другого: закрасить или оставить дыркой (как в букве «О»)')),
        h('button', { class: 'text-button wide', type: 'button', onclick: () => this.editor.enterVectorEdit(ids[0]!) }, h('span', {}, tr('Редактировать точки (Enter)'))),
        h(
          'div',
          { class: 'grid-2' },
          h('button', { class: 'text-button', type: 'button', title: tr('Меньше точек при том же виде: кривые подбираются заново'), onclick: () => this.editor.simplifySelection() }, h('span', {}, tr('Упростить контур'))),
          h('button', { class: 'text-button', type: 'button', title: tr('Контур отодвигается наружу или внутрь на заданное расстояние'), onclick: () => void askOffset(this.editor) }, h('span', {}, tr('Сместить контур…'))),
        ),
      );
      // Open contours can have arrowheads too.
      if (ids.every((id) => nodePaths(d, id).some((p) => !p.closed))) {
        body.append(h('div', { class: 'subsection-title' }, tr('Концы контура')));
        this.buildLineEnds(body);
      }
      return;
    }
    if (type === 'POLYGON' || type === 'STAR') {
      const body = this.section(type === 'STAR' ? tr('Звезда') : tr('Многоугольник'));
      const count = this.numberProp('pointCount', '', type === 'STAR' ? tr('Количество лучей') : tr('Количество углов'), { min: 3, max: 60 });
      body.append(this.line(type === 'STAR' ? tr('Лучей') : tr('Углов'), count.el));
      if (type === 'STAR') {
        const inner = this.numberProp('innerRadius', '', tr('Толщина лучей: впадины между лучами в процентах от размера звезды'), { min: 1, max: 100, suffix: '%', scale: 100 });
        body.append(this.line(tr('Толщина лучей'), inner.el, tr('Чем меньше — тем тоньше и острее лучи')));
      }
      // As in Figma: every corner of a polygon or a star rounded alike.
      const radius = this.numberProp('cornerRadius', '', tr('Радиус скругления всех углов, px. Где стороны коротки для такого радиуса, угол скругляется меньше'), { icon: 'radius', min: 0, variable: 'cornerRadius' });
      body.append(this.line(tr('Скругление'), radius.el, tr('Скругление углов')));
    } else if (type === 'ELLIPSE') {
      // Figma's arc fields: start angle, sweep and the hole ratio.
      const body = this.section(tr('Дуга'));
      const start = this.arcField('start', tr('Угол, с которого начинается дуга, градусы по часовой от правой точки'), { suffix: '°' });
      const sweep = this.arcField('sweep', tr('Какая часть эллипса закрашена, в процентах; 100 % — эллипс целиком'), { min: -100, max: 100, suffix: '%' });
      const ratio = this.arcField('inner', tr('Отверстие в центре, в процентах от радиуса: 0 — сектор, больше — кольцо'), { min: 0, max: 99, suffix: '%' });
      body.append(h('div', { class: 'grid-2' }, start.el, sweep.el), this.line(tr('Отверстие'), ratio.el, tr('Отверстие в центре: кольцо или полукольцо')));
    } else if (type === 'LINE') {
      this.buildLineEnds(this.section(tr('Концы линии')));
    }
  }

  /** The scale tool (K): scale the selection by a factor, strokes, text and effects with it. */
  private buildScale(): void {
    const body = this.section(tr('Масштаб'));
    const field = this.add(
      new NumberField({
        label: '×',
        title: tr('Во сколько раз увеличить или уменьшить выделенное: 2 — вдвое больше, 0,5 — вдвое меньше'),
        min: 0.01,
        read: () => 1,
        write: (compute, phase) => {
          if (phase === 'commit') this.editor.scaleSelection(compute(1));
        },
        scrubAsCommits: true,
      }),
    );
    body.append(field.el, h('p', { class: 'field-explain' }, tr('Ручки рамки масштабируют всё: обводки, текст, эффекты и скругления растут вместе с размером.')));
  }

  /** Repeat transforms (Figma Draw): make a repeat group, or set one up. */
  private buildRepeat(ids: NodeId[]): void {
    const d = this.editor.doc;
    if (this.editor.vectorEdit || ids.some((id) => d.type(id) === 'SECTION' || d.get(id, 'board'))) return;
    const groups = ids.filter((id) => d.type(id) === 'GROUP' && d.get(id, 'repeat'));
    const kindButtons = () =>
      h(
        'div',
        { class: 'grid-2' },
        h('button', { class: 'text-button', type: 'button', title: tr('Повторить выделенное в ряд: копии меняются вместе с оригиналом'), onclick: () => this.editor.addRepeat('LINEAR') }, h('span', {}, tr('В ряд'))),
        h('button', { class: 'text-button', type: 'button', title: tr('Повторить выделенное по кругу: копии меняются вместе с оригиналом'), onclick: () => this.editor.addRepeat('RADIAL') }, h('span', {}, tr('По кругу'))),
      );
    if (groups.length !== ids.length) {
      if (groups.length === 0) this.section(tr('Повтор')).append(kindButtons());
      return;
    }
    const body = this.section(tr('Повтор'));
    const read = <K extends keyof RepeatSettings>(key: K) => () => common(groups, (id) => d.get(id, 'repeat')![key]);
    const write = <K extends keyof RepeatSettings>(key: K, value: RepeatSettings[K]) => this.editor.commit(tr('Повтор'), (tx) => groups.forEach((id) => tx.set(id, 'repeat', { ...d.get(id, 'repeat')!, [key]: value })));
    const kind = this.add(new SegmentedField(tr('Как повторять'), [{ value: 'LINEAR', label: tr('В ряд') }, { value: 'RADIAL', label: tr('По кругу') }] as const, read('kind'), (v) => write('kind', v)));
    const number = (key: 'count' | 'gap' | 'radius', label: string, title: string, min: number) =>
      this.add(
        new NumberField({
          label,
          title,
          min,
          read: () => {
            const v = read(key)();
            return v;
          },
          write: this.numberWriter(() => groups, (id) => d.get(id, 'repeat')![key], (tx, id, v) => tx.set(id, 'repeat', { ...d.get(id, 'repeat')!, [key]: key === 'count' ? Math.max(1, Math.round(v)) : v }), title),
        }),
      );
    const radial = groups.every((id) => d.get(id, 'repeat')!.kind === 'RADIAL');
    body.append(kind.el, this.line(tr('Копий'), number('count', '', tr('Сколько всего раз повторить, вместе с оригиналом'), 1).el, tr('Сколько всего раз повторить')));
    if (radial) body.append(this.line(tr('Радиус'), number('radius', '', tr('Расстояние от центра круга до слоёв, px'), 0).el, tr('Расстояние от центра круга до слоёв')));
    else {
      const direction = this.add(new SegmentedField(tr('Направление'), [{ value: 'HORIZONTAL', label: tr('Вправо') }, { value: 'VERTICAL', label: tr('Вниз') }] as const, read('direction'), (v) => write('direction', v)));
      body.append(this.line(tr('Промежуток'), number('gap', '', tr('Расстояние между копиями, px; меньше нуля — копии заходят друг на друга'), -10000).el, tr('Расстояние между копиями')), direction.el);
    }
    body.append(
      h(
        'div',
        { class: 'grid-2' },
        h('button', { class: 'text-button', type: 'button', title: tr('Копии станут обычными слоями, повтор уберётся'), onclick: () => this.editor.removeRepeat(true) }, h('span', {}, tr('В обычные слои'))),
        h('button', { class: 'text-button', type: 'button', title: tr('Убрать копии, оставить только оригинал'), onclick: () => this.editor.removeRepeat(false) }, h('span', {}, tr('Убрать повтор'))),
      ),
    );
  }

  /** One value of an ellipse arc; the panel shows sweep and hole in percent, as Figma. */
  private arcField(part: keyof EllipseArc, title: string, options: { min?: number; max?: number; suffix: string }): NumberField {
    const d = this.editor.doc;
    const scale = part === 'start' ? 1 : part === 'sweep' ? 100 / 360 : 100;
    const of = (id: NodeId) => (d.get(id, 'arc') ?? { start: 0, sweep: 360, inner: 0 })[part] * scale;
    const ids = () => this.ids.filter((id) => d.type(id) === 'ELLIPSE');
    return this.add(
      new NumberField({
        label: part === 'start' ? tr('Начало') : part === 'sweep' ? tr('Дуга') : '',
        title,
        min: options.min,
        max: options.max,
        suffix: options.suffix,
        read: () => {
          const list = ids();
          return list.length === 0 ? null : common(list, of);
        },
        write: this.numberWriter(ids, of, (tx, id, v) => {
          const arc = { ...(d.get(id, 'arc') ?? { start: 0, sweep: 360, inner: 0 }), [part]: v / scale };
          if (part === 'start') arc.start = ((arc.start % 360) + 360) % 360;
          // A whole ellipse without a hole is no arc at all.
          tx.set(id, 'arc', Math.abs(arc.sweep) >= 360 && arc.inner === 0 ? null : arc);
        }, title),
      }),
    );
  }

  private buildAppearance(ids: NodeId[]): void {
    const d = this.editor.doc;
    // "Layer" in Figma: how the whole layer is mixed with what is below it (BUG-007).
    const body = this.section(tr('Слой'));
    const opacity = this.numberProp('opacity', '', tr('Непрозрачность всего слоя вместе с содержимым: 100 % — полностью видно, 0 % — невидимо'), { min: 0, max: 100, suffix: '%', scale: 100, variable: 'opacity' });
    body.append(this.line(tr('Непрозрачность'), opacity.el, tr('Непрозрачность всего слоя вместе с содержимым')));
    if (ids.every((id) => d.type(id) === 'RECTANGLE' || isFrameLike(d.type(id)))) {
      const separate = ids.every((id) => d.get(id, 'cornerRadii') !== null);
      const toggle = h(
        'button',
        {
          class: `icon-button${separate ? ' on' : ''}`,
          type: 'button',
          title: separate ? tr('Одинаковое скругление для всех углов') : tr('Скруглять углы по отдельности'),
          onclick: () =>
            this.commit(tr('Скругление углов'), (tx, id) => {
              const r = d.get(id, 'cornerRadius');
              if (separate) {
                const radii = d.get(id, 'cornerRadii');
                tx.set(id, 'cornerRadii', null);
                tx.set(id, 'cornerRadius', radii ? Math.max(...radii) : r);
              } else tx.set(id, 'cornerRadii', [r, r, r, r]);
            }),
        },
        icon('padding', 14),
      );
      if (!separate) {
        const radius = this.numberProp('cornerRadius', '', tr('Радиус скругления углов, px. Больше половины меньшей стороны — получится «пилюля» или круг'), { icon: 'radius', min: 0, variable: 'cornerRadius' });
        body.append(this.line(tr('Скругление'), h('div', { class: 'with-action' }, radius.el, toggle), tr('Радиус скругления углов. Можно тянуть круглые маркеры в углах прямо на холсте')));
      } else {
        const corner = (index: number, label: string, title: string) =>
          this.add(
            new NumberField({
              label,
              title,
              min: 0,
              read: () => common(this.ids, (id) => d.get(id, 'cornerRadii')?.[index] ?? d.get(id, 'cornerRadius')),
              write: this.numberWriter(
                () => this.ids,
                (id) => d.get(id, 'cornerRadii')?.[index] ?? d.get(id, 'cornerRadius'),
                (tx, id, v) => {
                  const r = d.get(id, 'cornerRadius');
                  const radii = [...(d.get(id, 'cornerRadii') ?? [r, r, r, r])] as [number, number, number, number];
                  radii[index] = Math.max(0, v);
                  tx.set(id, 'cornerRadii', radii);
                },
                title,
              ),
            }),
          ).el;
        body.append(
          this.line(tr('Скругление'), h('div', { class: 'with-action' }, h('span', { class: 'hint small' }, tr('Каждый угол отдельно')), toggle)),
          h('div', { class: 'grid-2' }, corner(0, '↖', tr('Левый верхний угол')), corner(1, '↗', tr('Правый верхний угол')), corner(3, '↙', tr('Левый нижний угол')), corner(2, '↘', tr('Правый нижний угол'))),
        );
      }
    }
    // Blend mode beside the opacity, grouped as in Figma. "Pass through" only for groups and frames
    // (their layers blend with what is under the group); a single layer shows its PASS_THROUGH as Normal.
    const containersOnly = ids.every((id) => ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'BOOLEAN_OPERATION'].includes(d.type(id)));
    const blend = this.add(
      new SelectField<BlendMode>(
        tr('Режим наложения: как цвета слоя смешиваются со слоями под ним'),
        [
          ...(containersOnly ? [{ value: 'PASS_THROUGH', label: tr('Пропустить') } as Choice<BlendMode>] : []),
          ...blendChoices(),
        ],
        () => common(this.ids, (id) => {
          const mode = d.get(id, 'blendMode');
          return mode === 'PASS_THROUGH' && !containersOnly ? 'NORMAL' : mode;
        }),
        (v) => this.set('blendMode', v, tr('Режим наложения')),
      ),
    );
    blend.el.classList.add('blend-select');
    body.append(this.line(tr('Наложение'), blend.el, tr('Режим наложения: как цвета слоя смешиваются со слоями под ним')));
    // A mask is made from the menu (right click → "Use as mask", ⌘⌥M), as in Figma; here it only says what it does.
    if (ids.every((id) => d.get(id, 'isMask'))) {
      body.append(
        h(
          'div',
          { class: 'mask-note' },
          h('span', {}, tr('Маска: слои над ней в группе видны только внутри её формы')),
          h('button', { class: 'text-button', type: 'button', onclick: () => this.editor.setMask(false) }, tr('Убрать маску')),
        ),
      );
      const maskType = this.add(
        new SelectField(
          tr('Как маска скрывает: по прозрачности, по контуру (любая непрозрачность — полная) или по яркости (белое видно, чёрное скрыто)'),
          MASK_TYPES,
          () => common(this.ids, (id) => d.get(id, 'maskType')),
          (v) => this.set('maskType', v, tr('Тип маски')),
        ),
      );
      body.append(this.line(tr('Тип маски'), maskType.el, tr('Как маска скрывает: по прозрачности, по контуру или по яркости')));
    }
    // Rare: visibility bound to a variable — folded away.
    const more = this.foldout('layer-more', tr('Дополнительно'));
    if (ids.every((id) => isFrameLike(d.type(id)))) {
      const clip = this.add(new CheckboxField(tr('Обрезать всё, что выходит за рамку'), () => common(this.ids, (id) => d.get(id, 'clipsContent')), (v) => this.set('clipsContent', v, tr('Обрезка'))));
      body.append(clip.el);
    }
    // Visibility from a boolean variable (e.g. "показывать иконку").
    if (d.collections().some((c) => d.children(c).some((v) => d.get(v, 'varType') === 'BOOLEAN'))) {
      const shown = this.add(new CheckboxField(tr('Показан'), () => common(this.ids, (id) => d.get(id, 'visible')), (v) => this.set('visible', v, tr('Видимость'))));
      more.append(this.line(tr('Видимость'), this.bindable('visible', shown).el, tr('Можно привязать к логической переменной')), h('p', { class: 'field-explain' }, tr('Скрыть слой можно и глазом в списке слоёв. Здесь видимость можно привязать к логической переменной — например, для прототипа.')));
    }
    // Modes of variable collections for frames, groups and instances (FR-VAR-012).
    const containers = ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];
    if (ids.every((id) => containers.includes(d.type(id)))) {
      const rows = buildModeRows(this.variableHost(), ids, (f) => this.add(f));
      if (rows) body.append(h('div', { class: 'subsection-title', title: tr('Режим переменных действует на этот слой и всё внутри него') }, tr('Режимы переменных')), rows);
    }
    if (more.childElementCount) body.append(more.parentElement!);
  }

  private buildText(ids: NodeId[]): void {
    const d = this.editor.doc;
    const editor = this.editor;
    const body = this.section(tr('Текст'), styleButton(editor, 'textStyleId'));
    // With a text style the typography comes from the style (edit it there, or detach).
    const bound = editor.selectionStyle('textStyleId') !== null && !editor.editingText;
    if (bound) body.append(this.add(new StyleRow(editor, 'textStyleId', (style) => this.editStyle(style))).el);
    // Character styles apply to the selected characters while editing, otherwise to whole layers.
    const run = <K extends RunKey>(key: K) => {
      const v = editor.textStyleValue(key);
      return v === null ? null : v === MIXED_RUN ? MIXED : v;
    };
    const runNumber = (key: 'fontSize', label: string) => (compute: (current: number) => number, phase: Phase) => {
      if (phase === 'start' || phase === 'update') return;
      const current = run(key);
      editor.applyTextStyle({ [key]: Math.max(1, round2(compute(typeof current === 'number' ? current : 16))) }, label);
    };
    if (editor.editingText) {
      const { start, end } = editor.textRange();
      if (start !== end) body.append(h('p', { class: 'hint small text-scope' }, tr('Изменения применяются к выделенному тексту.')));
    }
    if (d.collections().some((c) => d.children(c).some((v) => d.get(v, 'varType') === 'STRING'))) {
      const content = this.add(new TextField(tr('Содержимое текста'), () => common(this.ids, (id) => d.get(id, 'characters')), (v) => this.set('characters', v, tr('Текст'))));
      body.append(this.line(tr('Содержимое'), this.bindable('characters', content).el, tr('Можно привязать к строковой переменной')));
    }
    if (!bound) {
    const family = this.add(
      new FontPicker(() => d, () => run('fontFamily'), (v) => editor.applyTextStyle({ fontFamily: v }, tr('Шрифт')), {
        preview: (f) => editor.previewFont(f),
        sample: () => {
          const t = editor.topLevelSelection().find((id) => d.type(id) === 'TEXT');
          return t ? d.get(t, 'characters') : null;
        },
      }),
    );
    body.append(family.el);
    const weight = this.add(new WeightField(() => run('fontFamily'), () => run('fontWeight'), (v) => editor.applyTextStyle({ fontWeight: v }, tr('Начертание'))));
    const size = this.bindable('fontSize', this.add(new NumberField({ label: '', title: tr('Размер шрифта'), min: 1, suffix: 'px', read: () => run('fontSize'), scrubAsCommits: true, write: runNumber('fontSize', tr('Размер шрифта')) })));
    body.append(h('div', { class: 'grid-2' }, weight.el, size.el));
    const styleButtons = this.add(new TextStyleButtons(editor, run));
    body.append(styleButtons.el);
    body.append(
      h(
        'button',
        { class: 'text-button wide', type: 'button', title: tr('Кавычки «ёлочки», тире, неразрывные пробелы после предлогов и в числах, многоточие — по правилам вёрстки. Стили слов сохраняются (⌥⇧⌘T)'), onclick: () => editor.typographSelection() },
        icon('text', 14),
        h('span', {}, tr('Типограф')),
      ),
    );
    // The hyperlink of the selected characters (or of whole layers).
    const linkRow = h('div', { class: 'link-row' });
    this.add({
      el: linkRow,
      refresh: () => {
        const v = editor.linkValue();
        const edit = h('button', { class: 'icon-button', type: 'button', title: tr('Изменить ссылку'), 'aria-label': tr('Изменить ссылку'), onclick: () => this.editLink() }, icon('pen', 14));
        if (typeof v === 'string') {
          const shown = v.replace(/^(https?:\/\/|mailto:|tel:)/, '').replace(/\/$/, '');
          const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Убрать ссылку'), 'aria-label': tr('Убрать ссылку'), onclick: () => editor.setLink(null) }, icon('close', 14));
          linkRow.replaceChildren(icon('link', 14), h('a', { class: 'link-url', href: v, target: '_blank', rel: 'noopener noreferrer', title: tr('Открыть {0}', v) }, shown), edit, remove);
        } else if (v === MIXED_RUN) {
          linkRow.replaceChildren(icon('link', 14), h('span', { class: 'link-url muted' }, tr('Разные ссылки')), edit);
        } else {
          linkRow.replaceChildren(h('button', { class: 'link-button', type: 'button', title: tr('Ссылка на сайт, почту или телефон (при редактировании текста — {0})', IS_MAC ? '⌘K' : 'Ctrl+K'), onclick: () => this.editLink() }, tr('Добавить ссылку…')));
        }
      },
    }).refresh();
    body.append(linkRow);
    if (editor.editingText) {
      const color = this.add(
        new ColorField({
          title: tr('Цвет выделенного текста'),
          read: () => {
            const fills = run('fills');
            if (fills === null) return null;
            if (fills === MIXED) return MIXED;
            const solidFill = fills?.find((f) => f.visible && f.type === 'SOLID');
            return solidFill && solidFill.type === 'SOLID' ? { color: solidFill.color, opacity: solidFill.opacity } : null;
          },
          write: (c, opacity) => editor.applyTextStyle({ fills: [solid({ ...c, a: 1 }, opacity)] }, tr('Цвет текста')),
        }),
      );
      body.append(this.line(tr('Цвет'), color.el));
    }

    const [lhUnit, lhValue] = this.lineHeightFields();
    const letter = this.add(
      new NumberField({
        label: 'A↔',
        title: tr('Межбуквенный интервал, %'),
        suffix: '%',
        read: () => {
          const v = run('letterSpacing');
          return v === null || v === MIXED ? v : v.value;
        },
        scrubAsCommits: true,
        write: (compute, phase) => {
          if (phase === 'start' || phase === 'update') return;
          const v = run('letterSpacing');
          const current = v && v !== MIXED ? v : { unit: 'PERCENT' as const, value: 0 };
          editor.applyTextStyle({ letterSpacing: { unit: current.unit, value: round2(compute(current.value)) } }, tr('Межбуквенный интервал'));
        },
      }),
    );
    body.append(h('div', { class: 'grid-2' }, lhUnit.el, this.bindable('lineHeight', lhValue).el), h('div', { class: 'grid-2' }, this.bindable('letterSpacing', letter).el));
    }

    const alignH = this.add(
      new SegmentedField(
        tr('Выравнивание текста'),
        [
          { value: 'LEFT', label: tr('Влево'), icon: 'textLeft' },
          { value: 'CENTER', label: tr('По центру'), icon: 'textCenter' },
          { value: 'RIGHT', label: tr('Вправо'), icon: 'textRight' },
          { value: 'JUSTIFIED', label: tr('По ширине'), icon: 'textJustify' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textAlignH')),
        (v) => this.set('textAlignH', v, tr('Выравнивание текста')),
      ),
    );
    const alignV = this.add(
      new SegmentedField(
        tr('Вертикальное выравнивание'),
        [
          { value: 'TOP', label: tr('Сверху'), icon: 'alignTop' },
          { value: 'CENTER', label: tr('По центру'), icon: 'alignVCenter' },
          { value: 'BOTTOM', label: tr('Снизу'), icon: 'alignBottom' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textAlignV')),
        (v) => this.set('textAlignV', v, tr('Вертикальное выравнивание')),
      ),
    );
    body.append(h('div', { class: 'row' }, alignH.el, alignV.el));
    const resize = this.add(
      new SelectField(
        tr('Размер блока'),
        [
          { value: 'WIDTH_AND_HEIGHT', label: tr('Авто ширина') },
          { value: 'HEIGHT', label: tr('Авто высота') },
          { value: 'NONE', label: tr('Фиксированный') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textAutoResize')),
        (v) => this.set('textAutoResize', v, tr('Размер текстового блока')),
      ),
    );
    const textCase = this.add(
      new SelectField(
        tr('Регистр'),
        [
          { value: 'ORIGINAL', label: tr('Как есть') },
          { value: 'UPPER', label: tr('ВСЕ ЗАГЛАВНЫЕ') },
          { value: 'LOWER', label: tr('строчные') },
          { value: 'TITLE', label: tr('Каждое Слово') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textCase')),
        (v) => this.set('textCase', v, tr('Регистр')),
      ),
    );
    const caps = this.add(
      new SelectField(
        tr('Малые заглавные'),
        [
          { value: 'NORMAL', label: tr('Нет') },
          { value: 'SMALL_CAPS', label: tr('Из строчных') },
          { value: 'ALL_SMALL_CAPS', label: tr('Все буквы') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'fontVariantCaps')),
        (v) => this.set('fontVariantCaps', v, tr('Малые заглавные')),
        tr('Малые заглавные'),
      ),
    );
    const kerning = this.add(new CheckboxField(tr('Кернинг (подгонка пар букв)'), () => common(this.ids, (id) => d.get(id, 'kerning')), (v) => this.set('kerning', v, tr('Кернинг'))));
    body.append(resize.el);

    // Lists are everyday; the rest is fine typography — folded away, each with a plain explanation.
    // Underline and strikethrough live only in the B I U S row above (no second control for them).
    const listType = this.add(
      new SegmentedField(
        tr('Список'),
        [
          { value: 'NONE', label: tr('Нет') },
          { value: 'BULLET', label: tr('• Маркеры') },
          { value: 'NUMBER', label: tr('1. Номера') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'listType')),
        (v) => this.set('listType', v, tr('Список')),
        true,
      ),
    );
    body.append(h('div', { class: 'subsection-title' }, tr('Список')), listType.el);
    // Figma's «Hanging list»: the markers stand outside, the items' text lines up with the text around.
    if (ids.every((id) => d.get(id, 'listType') !== 'NONE')) {
      const hanging = this.add(new CheckboxField(tr('Маркеры за краем текста'), () => common(this.ids, (id) => d.get(id, 'hangingList')), (v) => this.set('hangingList', v, tr('Висячий список'))));
      hanging.el.title = tr('Маркеры и номера выходят за левый край, а текст пунктов стоит ровно по краю — вровень с текстом вокруг.');
      // Nesting (Tab / Shift+Tab while typing) and the space between items.
      const level = (delta: 1 | -1, label: string, glyph: string) =>
        h('button', { class: 'text-button', type: 'button', title: `${label} (${delta > 0 ? 'Tab' : 'Shift+Tab'})`, onclick: () => this.editor.shiftListLevel(delta) }, h('span', {}, glyph));
      const spacing = this.add(
        new NumberField({
          label: tr('Между'),
          title: tr('Расстояние между пунктами списка, px; пусто — как между абзацами'),
          min: 0,
          read: () => common(this.ids, (id) => d.get(id, 'listSpacing') ?? d.get(id, 'paragraphSpacing')),
          write: this.numberWriter(() => this.ids, (id) => d.get(id, 'listSpacing') ?? d.get(id, 'paragraphSpacing'), (tx, id, v) => tx.set(id, 'listSpacing', Math.max(0, v)), tr('Расстояние между пунктами')),
        }),
      );
      body.append(
        hanging.el,
        h('div', { class: 'grid-2' }, spacing.el, h('div', { class: 'grid-2' }, level(-1, tr('Уменьшить отступ'), '⇤'), level(1, tr('Увеличить отступ'), '⇥'))),
      );
    }

    // Text on a path: where along it, which side, or back to a line.
    if (ids.every((id) => d.get(id, 'textPath'))) {
      const offset = this.add(
        new NumberField({
          label: tr('Сдвиг'),
          title: tr('Где на линии текст: 0 — в начале, 100 — в конце (для текста по центру — где его середина)'),
          suffix: '%',
          min: 0,
          max: 100,
          read: () => {
            const v = common(ids, (id) => d.get(id, 'textPathOffset'));
            return v === MIXED || v === null ? null : Math.round(v * 1000) / 10;
          },
          write: this.numberWriter(() => ids, (id) => d.get(id, 'textPathOffset') * 100, (tx, id, v) => tx.set(id, 'textPathOffset', Math.min(1, Math.max(0, v / 100))), tr('Сдвиг текста по контуру')),
        }),
      );
      body.append(
        h('div', { class: 'subsection-title' }, tr('По контуру')),
        h('div', { class: 'grid-2' }, offset.el, h('button', { class: 'text-button', type: 'button', onclick: () => flipTextOnPath(this.editor) }, tr('Перевернуть'))),
        h('button', { class: 'text-button wide', type: 'button', onclick: () => takeTextOffPath(this.editor) }, tr('Снять с контура')),
      );
    }
    const more = this.foldout('text-more', tr('Дополнительно'));
    const explain = (text: string) => h('p', { class: 'field-explain' }, text);
    const wrapStyle = this.add(
      new SegmentedField(
        tr('Перенос строк'),
        [
          { value: 'AUTO', label: tr('Обычный') },
          { value: 'BALANCE', label: tr('Ровный') },
          { value: 'PRETTY', label: tr('Без висячих') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textWrap')),
        (v) => this.set('textWrap', v, tr('Перенос строк')),
        true,
      ),
    );
    more.append(
      h('div', { class: 'subsection-title' }, tr('Перенос строк')),
      wrapStyle.el,
      explain(tr('«Ровный» — строки абзаца примерно одной длины (для заголовков). «Без висячих» — последнее слово не остаётся на строке одно. Рамка текста не меняется.')),
    );
    if (!bound) {
      more.append(textCase.el, explain(tr('Показывает текст заглавными или строчными, не меняя сами буквы: удобно для кнопок и заголовков.')));
      more.append(caps.el, explain(tr('Малые заглавные (капитель) — строчные буквы в виде уменьшенных заглавных. Работает, если это есть в шрифте.')));
    }
    more.append(kerning.el, explain(tr('Кернинг — автоматическая подгонка расстояний между парами букв (например, «AV», «Та»). Обычно его не выключают.')));
    const direction = this.add(
      new SegmentedField(
        tr('Направление текста'),
        [
          { value: 'AUTO', label: tr('Авто') },
          { value: 'LTR', label: tr('Слева направо') },
          { value: 'RTL', label: tr('Справа налево') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'textDirection')),
        (v) => this.set('textDirection', v, tr('Направление текста')),
        true,
      ),
    );
    more.append(h('div', { class: 'subsection-title' }, tr('Направление текста')), direction.el, explain(tr('«Авто» — по первой букве каждого абзаца: арабский и иврит пишутся справа налево, остальное — слева направо.')));
    // Figma's decoration settings: how underline and strikethrough look (they are turned on by U and S above).
    const decoStyle = this.add(
      new SegmentedField(
        tr('Стиль подчёркивания'),
        [
          { value: 'SOLID', label: tr('Линия') },
          { value: 'DASHED', label: tr('Штрих') },
          { value: 'DOTTED', label: tr('Точки') },
          { value: 'WAVY', label: tr('Волна') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'decorationStyle')),
        (v) => this.set('decorationStyle', v, tr('Стиль подчёркивания')),
        true,
      ),
    );
    const decoNumber = (key: 'decorationThickness' | 'underlineOffset', label: string, title: string, auto: (id: NodeId) => number) =>
      this.add(
        new NumberField({
          label,
          title,
          min: key === 'decorationThickness' ? 0.5 : -50,
          read: () => common(this.ids, (id) => Math.round((d.get(id, key) ?? auto(id)) * 10) / 10),
          write: this.numberWriter(() => this.ids, (id) => d.get(id, key) ?? auto(id), (tx, id, v) => tx.set(id, key, v), title),
        }),
      );
    more.append(
      h('div', { class: 'subsection-title' }, tr('Подчёркивание и зачёркивание')),
      decoStyle.el,
      h(
        'div',
        { class: 'grid-2' },
        decoNumber('decorationThickness', tr('Толщ.'), tr('Толщина линии подчёркивания и зачёркивания, px'), (id) => Math.max(1, d.get(id, 'fontSize') / 16)).el,
        decoNumber('underlineOffset', tr('Отступ'), tr('Расстояние от базовой линии до подчёркивания, px'), (id) => d.get(id, 'fontSize') * 0.12).el,
      ),
      explain(tr('Включаются кнопками U и S выше. Здесь — как они выглядят: линия, штрих, точки или волна, толщина и отступ подчёркивания от текста.')),
    );
    const hangingMarks = this.add(new CheckboxField(tr('Висячие кавычки и скобки'), () => common(this.ids, (id) => d.get(id, 'hangingPunctuation')), (v) => this.set('hangingPunctuation', v, tr('Висячая пунктуация'))));
    more.append(hangingMarks.el, explain(tr('Кавычка или скобка в начале строки выходит за край, и буквы стоят ровно по краю. У текста по правому краю так же выходят точка, запятая и закрывающая кавычка.')));
    if (!bound) {
      more.append(
        h(
          'div',
          { class: 'grid-2' },
          this.numberProp('paragraphSpacing', tr('Между'), tr('Расстояние между абзацами, px'), { min: 0, variable: 'paragraphSpacing' }).el,
          this.numberProp('paragraphIndent', tr('Отступ'), tr('Отступ первой строки абзаца, px'), { min: 0, variable: 'paragraphIndent' }).el,
        ),
        explain(tr('Отступы абзацев: «Между» — расстояние между абзацами, «Отступ» — красная строка.')),
      );
    }
    const maxLines = this.numberProp('maxLines', '', tr('Сколько строк показывать; остальное обрезается многоточием. 0 — без ограничения'), { min: 0 });
    more.append(this.line(tr('Макс. строк'), maxLines.el, tr('Текст длиннее обрезается многоточием «…». 0 — без ограничения')), explain(tr('Длинный текст обрезается многоточием «…» после этого числа строк. 0 — без ограничения.')));
    const trim = this.add(
      new SegmentedField(
        tr('Обрезка по высоте'),
        [
          { value: 'NONE', label: tr('Стандарт') },
          { value: 'CAP_HEIGHT', label: tr('По буквам') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'leadingTrim')),
        (v) => this.set('leadingTrim', v, tr('Обрезка по высоте')),
        true,
      ),
    );
    more.append(h('div', { class: 'subsection-title' }, tr('Обрезка по высоте')), trim.el, explain(tr('«По буквам» — блок от верха заглавных до базовой линии последней строки, без пустоты сверху и снизу: отступы в кнопках и адаптивной раскладке становятся такими, как видно глазу.')));
    if (!bound) more.append(this.buildFontDetails());
    body.append(more.parentElement!);
  }

  /**
   * OpenType features and variation axes of the selected texts' font (Figma's
   * «Details»): only what this font has, read from its file; the names of its
   * stylistic sets come from the font itself.
   */
  private buildFontDetails(): HTMLElement {
    const d = this.editor.doc;
    const ids = this.ids;
    const first = ids[0]!;
    const box = h('div', { class: 'font-details' });
    const explain = (text: string) => h('p', { class: 'field-explain' }, text);
    void fontAbilities(d, d.get(first, 'fontFamily'), d.get(first, 'fontWeight'), d.get(first, 'italic')).then((info) => {
      if (!box.isConnected && !box.parentElement) return;
      if (!info) {
        box.append(h('div', { class: 'subsection-title' }, tr('Функции шрифта')), explain(tr('Функции и оси шрифта (цифры одной ширины, наборы знаков, дроби) видны, когда файл шрифта есть в файле: выбор шрифта → «Встроить в файл». Шрифты WOFF2 прочитать нельзя — встройте TTF или OTF.')));
        return;
      }
      const has = new Set(info.features);
      let toggles: HTMLElement[] = [];
      const feature = (tag: string, label: string, on = false) => {
        if (!has.has(tag)) return;
        const field = this.add(
          new CheckboxField(
            label,
            () => common(ids, (id) => d.get(id, 'fontFeatures')[tag] ?? on),
            (v) =>
              this.commit(tr('Функции шрифта'), (tx, id) => {
                const next = { ...d.get(id, 'fontFeatures') };
                if (v === on) delete next[tag];
                else next[tag] = v;
                tx.set(id, 'fontFeatures', next);
              }),
          ),
        );
        field.el.title = tag;
        toggles.push(field.el);
      };
      for (const [tag, label, on] of FEATURES) feature(tag, tr(label), on);
      const main = toggles;
      // Stylistic sets and character variants: often a dozen each — folded, the count on the title (open when one is on).
      const group = (re: RegExp, title: string, fallback: string) => {
        toggles = [];
        const tags = info.features.filter((t) => re.test(t));
        for (const tag of tags) feature(tag, info.featureNames[tag] ? `${info.featureNames[tag]} (${tag})` : tr(fallback, Number(tag.slice(2))));
        if (!toggles.length) return null;
        const anyOn = ids.some((id) => tags.some((t) => d.get(id, 'fontFeatures')[t]));
        return h('details', { class: 'font-feature-group', open: anyOn }, h('summary', {}, `${title} — ${toggles.length}`), ...toggles);
      };
      const sets = group(/^ss\d\d$/, tr('Наборы знаков'), 'Набор знаков {0}');
      const variants = group(/^cv\d\d$/, tr('Варианты знаков'), 'Вариант знака {0}');
      if (main.length || sets || variants) box.append(h('div', { class: 'subsection-title' }, tr('Функции шрифта')), ...main, ...[sets, variants].filter((x): x is HTMLDetailsElement => x !== null), explain(tr('То, что умеет сам шрифт: цифры одной ширины для таблиц и цен, дроби, другие формы букв. Показано только то, что есть в этом шрифте.')));
      const axes = info.axes.filter((a) => !a.hidden && a.tag !== 'wght');
      const wght = info.axes.find((a) => a.tag === 'wght');
      if (axes.length || wght) {
        box.append(h('div', { class: 'subsection-title' }, tr('Оси шрифта')));
        // The weight is the text's own weight, here to any number the font allows (450, 530…).
        if (wght) {
          const field = this.add(
            new NumberField({
              label: tr('Толщина шрифта'),
              title: tr('Толщина: любое число от {0} до {1}', wght.min, wght.max),
              min: wght.min,
              max: wght.max,
              read: () => {
                const v = common(ids, (id) => d.get(id, 'fontWeight'));
                return v === MIXED ? null : v;
              },
              scrubAsCommits: true,
              write: (compute, phase) => {
                if (phase !== 'commit') return;
                const v = Math.min(wght.max, Math.max(wght.min, Math.round(compute(d.get(first, 'fontWeight')))));
                this.set('fontWeight', v, tr('Толщина'));
              },
            }),
          );
          box.append(field.el);
        }
        for (const a of axes) {
          const field = this.add(
            new NumberField({
              label: AXIS_NAMES[a.tag] ? tr(AXIS_NAMES[a.tag]!) : a.name,
              title: tr('{0}: от {1} до {2}', a.name, a.min, a.max),
              min: a.min,
              max: a.max,
              read: () => {
                const v = common(ids, (id) => d.get(id, 'fontVariations')[a.tag] ?? a.default);
                return v === MIXED ? null : v;
              },
              scrubAsCommits: true,
              write: (compute, phase) => {
                if (phase !== 'commit') return;
                const now = d.get(first, 'fontVariations')[a.tag] ?? a.default;
                const v = Math.min(a.max, Math.max(a.min, round2(compute(now))));
                this.commit(tr('Ось шрифта'), (tx, id) => {
                  const next = { ...d.get(id, 'fontVariations') };
                  if (v === a.default) delete next[a.tag];
                  else next[a.tag] = v;
                  tx.set(id, 'fontVariations', next);
                });
              },
            }),
          );
          box.append(field.el);
        }
        box.append(explain(tr('Вариативный шрифт плавно меняется по своим осям: толщина — любым числом (например 450), а не только 400 или 500.')));
      }
    });
    return box;
  }

  /** A folded block (remembered open or closed); returns its content element. */
  private foldout(key: string, title: string): HTMLElement {
    const content = h('div', { class: 'foldout-body' });
    let open = false;
    try {
      open = localStorage.getItem(`cs.fold.${key}`) === '1';
    } catch {
      // closed by default
    }
    const details = h('details', { class: 'foldout', open }, h('summary', {}, title), content);
    details.addEventListener('toggle', () => {
      try {
        localStorage.setItem(`cs.fold.${key}`, details.open ? '1' : '0');
      } catch {
        // not remembered
      }
    });
    return content;
  }

  /** Line height unit and value of the panel's targets (layers or a text style). */
  private lineHeightFields(): [Field, Field] {
    const d = this.editor.doc;
    const lhUnit = this.add(
      new SelectField(
        tr('Межстрочный интервал: единица'),
        [
          { value: 'AUTO', label: tr('Авто') },
          { value: 'PX', label: 'px' },
          { value: 'PERCENT', label: '%' },
          { value: 'MULTIPLIER', label: '×' },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'lineHeight').unit),
        (unit) => {
          const defaults = { AUTO: { unit: 'AUTO' }, PX: { unit: 'PX', value: 24 }, PERCENT: { unit: 'PERCENT', value: 140 }, MULTIPLIER: { unit: 'MULTIPLIER', value: 1.4 } } as const;
          this.set('lineHeight', defaults[unit], tr('Межстрочный интервал'));
        },
      ),
    );
    const lhValue = this.add(
      new NumberField({
        // Named in the field: the row has no label of its own.
        label: tr('Интервал'),
        title: tr('Межстрочный интервал'),
        min: 0,
        read: () => {
          const v = common(this.ids, (id) => d.get(id, 'lineHeight'), valueEquals);
          if (v === null) return null;
          if (v === MIXED) return MIXED;
          return v.unit === 'AUTO' ? null : v.value;
        },
        write: this.numberWriter(
          () => this.ids,
          (id) => {
            const lh = d.get(id, 'lineHeight');
            return lh.unit === 'AUTO' ? 0 : lh.value;
          },
          (tx, id, v) => {
            const lh = d.get(id, 'lineHeight');
            if (lh.unit !== 'AUTO') tx.set(id, 'lineHeight', { unit: lh.unit, value: v });
          },
          tr('Межстрочный интервал'),
        ),
      }),
    );
    return [lhUnit, lhValue];
  }

  /** Start and end of lines and open contours (FR-DRW-062). */
  private buildLineEnds(body: HTMLElement): void {
    const d = this.editor.doc;
    const caps = [
      { value: 'NONE', label: tr('Нет') },
      { value: 'LINE_ARROW', label: tr('Стрелка линиями') },
      { value: 'ARROW', label: tr('Стрелка треугольником') },
      { value: 'REVERSED_TRIANGLE', label: tr('Обратный треугольник') },
      { value: 'CIRCLE', label: tr('Круг') },
      { value: 'DIAMOND', label: tr('Ромб') },
      { value: 'SQUARE', label: tr('Квадрат') },
    ] as const;
    const start = this.add(new SelectField(tr('Начало линии'), caps, () => common(this.ids, (id) => d.get(id, 'startCap')), (v) => this.set('startCap', v, tr('Конец линии'))));
    const end = this.add(new SelectField(tr('Конец линии'), caps, () => common(this.ids, (id) => d.get(id, 'endCap')), (v) => this.set('endCap', v, tr('Конец линии'))));
    const swap = h('button', { class: 'icon-button', type: 'button', title: tr('Поменять концы местами'), onclick: () => this.commit(tr('Поменять концы'), (tx, id) => tx.update(id, { startCap: d.get(id, 'endCap'), endCap: d.get(id, 'startCap') })) }, icon('arrowRight'));
    body.append(this.line(tr('Начало'), start.el), this.line(tr('Конец'), h('div', { class: 'with-action' }, end.el, swap)));
  }

  /** Stroke settings (FR-DRW-060, 061): per-side weights, dashes, ends and joins. */
  private buildStrokeSettings(body: HTMLElement): void {
    const d = this.editor.doc;
    const ids = () => this.ids;
    const rectLike = this.ids.every((id) => ['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(d.type(id)));
    const perSide = rectLike && this.ids.some((id) => d.get(id, 'strokeWeights') !== null);
    if (rectLike) {
      const toggle = h(
        'button',
        {
          class: 'link-button',
          type: 'button',
          title: perSide ? tr('Одна толщина для всех сторон') : tr('Разная толщина сторон (например, только снизу)'),
          onclick: () =>
            this.commit(tr('Толщина сторон'), (tx, id) => {
              const w = d.get(id, 'strokeWeight');
              tx.set(id, 'strokeWeights', perSide ? null : [w, w, w, w]);
            }),
        },
        icon('padding', 14),
        h('span', {}, perSide ? tr('Одинаково со всех сторон') : tr('Разная по сторонам')),
      );
      body.append(h('div', { class: 'row end' }, toggle));
      if (perSide) {
        const side = (i: number, label: string, title: string) =>
          this.add(
            new NumberField({
              label,
              title,
              min: 0,
              read: () => common(ids(), (id) => (d.get(id, 'strokeWeights') ?? [0, 0, 0, 0])[i]!),
              write: this.numberWriter(
                ids,
                (id) => (d.get(id, 'strokeWeights') ?? [0, 0, 0, 0])[i]!,
                (tx, id, v) => {
                  const next = [...(d.get(id, 'strokeWeights') ?? [0, 0, 0, 0])] as [number, number, number, number];
                  next[i] = Math.max(0, v);
                  tx.set(id, 'strokeWeights', next);
                },
                title,
              ),
            }),
          );
        body.append(h('div', { class: 'grid-2' }, side(0, '↑', tr('Сверху')).el, side(2, '↓', tr('Снизу')).el, side(3, '←', tr('Слева')).el, side(1, '→', tr('Справа')).el));
      }
    }
    // Dashes: dash and gap (an empty dash = solid line).
    const dashPart = (i: 0 | 1, label: string, title: string) =>
      this.add(
        new NumberField({
          label,
          title,
          min: 0,
          read: () => common(ids(), (id) => d.get(id, 'dashPattern')[i] ?? 0),
          write: this.numberWriter(
            ids,
            (id) => d.get(id, 'dashPattern')[i] ?? 0,
            (tx, id, v) => {
              const cur = d.get(id, 'dashPattern');
              const dash = i === 0 ? Math.max(0, v) : (cur[0] ?? 0);
              const gap = i === 1 ? Math.max(0, v) : (cur[1] ?? cur[0] ?? 0);
              tx.set(id, 'dashPattern', dash > 0 ? [dash, gap > 0 ? gap : dash] : []);
            },
            title,
          ),
        }),
      );
    const cap = this.add(
      new SelectField(
        tr('Концы линий'),
        [
          { value: 'NONE', label: tr('Плоские') },
          { value: 'ROUND', label: tr('Круглые') },
          { value: 'SQUARE', label: tr('Квадратные') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'strokeCap')),
        (v) => this.set('strokeCap', v, tr('Концы линий')),
      ),
    );
    const join = this.add(
      new SelectField(
        tr('Углы обводки'),
        [
          { value: 'MITER', label: tr('Острые') },
          { value: 'ROUND', label: tr('Скруглённые') },
          { value: 'BEVEL', label: tr('Скошенные') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'strokeJoin')),
        (v) => this.set('strokeJoin', v, tr('Стыки обводки')),
      ),
    );
    // Drawing (Figma Draw): the width along the path and a brush. Either makes the stroke a shape — dashes and inside/outside no longer apply.
    const profile = this.add(
      new SelectField(
        tr('Толщина вдоль линии'),
        [
          { value: 'UNIFORM', label: tr('Ровная') },
          { value: 'TAPER_BOTH', label: tr('Тоньше к концам') },
          { value: 'TAPER_START', label: tr('Тоньше в начале') },
          { value: 'TAPER_END', label: tr('Тоньше в конце') },
          { value: 'TEARDROP', label: tr('Капля') },
          { value: 'WAVE', label: tr('Волна') },
          { value: 'CUSTOM', label: tr('Свои точки ширины') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'strokeProfile')),
        (v) => this.set('strokeProfile', v, tr('Толщина вдоль линии')),
        tr('Толщина вдоль линии'),
      ),
    );
    // This file's brushes, and those the selected layers brought from elsewhere.
    const customBrushes = [...d.get(d.rootId, 'brushes')];
    for (const id of this.ids) {
      const b = d.get(id, 'customBrush');
      if (b && !customBrushes.some((k) => k.id === b.id)) customBrushes.push(b);
    }
    const brush = this.add(
      new SelectField<string>(
        tr('Кисть'),
        [
          { value: 'NONE', label: tr('Без кисти') },
          { value: 'PENCIL', label: tr('Карандаш') },
          { value: 'INK', label: tr('Тушь') },
          { value: 'BRUSH', label: tr('Кисть') },
          { value: 'MARKER', label: tr('Маркер') },
          { value: 'CHALK', label: tr('Мел') },
          ...customBrushes.map((b) => ({ value: `custom:${b.id}`, label: `${b.name} (${b.kind === 'STRETCH' ? tr('растягивается') : tr('рассыпная')})` })),
        ],
        () => common(this.ids, (id) => (d.get(id, 'brush') === 'CUSTOM' ? `custom:${d.get(id, 'customBrush')?.id ?? ''}` : d.get(id, 'brush'))),
        (v) => {
          const custom = v.startsWith('custom:') ? customBrushes.find((b) => `custom:${b.id}` === v) ?? null : null;
          this.commit(tr('Кисть'), (tx, id) => tx.update(id, custom ? { brush: 'CUSTOM', customBrush: structuredClone(custom), strokeAlign: 'CENTER' } : { brush: v as BrushKind, customBrush: null }));
        },
        tr('Кисть'),
      ),
    );
    const drawing = h('details', { class: 'stroke-more foldout' }, h('summary', {}, tr('Рисование: толщина и кисть')));
    drawing.open = this.ids.some((id) => d.get(id, 'strokeProfile') !== 'UNIFORM' || d.get(id, 'brush') !== 'NONE');
    drawing.append(
      h('div', { class: 'grid-2' }, profile.el, brush.el),
      h('p', { class: 'field-explain' }, tr('Линия меняет толщину вдоль пути или рисуется кистью, как от руки. Пунктир и обводка внутри/снаружи тогда не действуют.')),
    );
    body.append(drawing);
    const details = h('details', { class: 'stroke-more foldout' }, h('summary', {}, tr('Пунктир, концы и углы')));
    details.open = this.ids.some((id) => d.get(id, 'dashPattern').length > 0 || d.get(id, 'strokeCap') !== 'NONE' || d.get(id, 'strokeJoin') !== 'MITER');
    details.append(
      h('div', { class: 'grid-2' }, dashPart(0, tr('Штрих'), tr('Длина штриха, px (0 — сплошная)')).el, dashPart(1, tr('Пробел'), tr('Промежуток между штрихами, px')).el),
      h('div', { class: 'grid-2' }, cap.el, join.el),
    );
    if (this.ids.every((id) => d.get(id, 'strokeJoin') === 'MITER')) {
      const limit = this.numberProp('strokeMiterLimit', tr('Срез углов'), tr('Очень острые углы обводки срезаются, если их кончик длиннее этого числа толщин обводки'), { min: 1, max: 100 });
      details.append(h('div', { class: 'grid-2' }, limit.el));
    }
    body.append(details);
  }

  private buildPaints(all: NodeId[], key: 'fills' | 'strokes', title: string): void {
    const d = this.editor.doc;
    // A group has no paints of its own, as in Figma: only the layers that can carry them count (BUG-109).
    const paintable = (list: readonly NodeId[]) => list.filter((id) => d.type(id) !== 'GROUP');
    const ids = paintable(all);
    if (ids.length === 0) return;
    const targets = () => paintable(this.ids);
    const commit = (label: string, fn: (tx: Transaction, id: NodeId) => void) => this.editor.commit(label, (tx) => {
      for (const id of targets()) fn(tx, id);
    });
    const shared = common(ids, (id) => d.get(id, key), valueEquals);
    const addButton = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: key === 'fills' ? tr('Добавить заливку') : tr('Добавить обводку'),
        onclick: () => {
          const color = key === 'strokes' || ids.every((id) => d.type(id) === 'TEXT') ? rgba(0, 0, 0) : rgba(0.85, 0.85, 0.85);
          commit(title, (tx, id) => tx.set(id, key, [...(shared === MIXED ? [] : d.get(id, key)), solid(color)]));
        },
      },
      icon('plus'),
    );
    const binding: StyleBinding = key === 'fills' ? 'fillStyleId' : 'strokeStyleId';
    const styleMode = this.editingStyle !== null;
    const body = styleMode ? this.section(title, addButton) : this.section(title, styleButton(this.editor, binding), addButton);
    const strokeOptions = () => {
      if (key !== 'strokes' || styleMode) return;
      const weight = this.numberProp('strokeWeight', '', tr('Толщина обводки'), { icon: 'line', min: 0, variable: 'strokeWeight' });
      const align = this.add(
        new SelectField(
          tr('Положение обводки'),
          [
            { value: 'INSIDE', label: tr('Внутри') },
            { value: 'CENTER', label: tr('По центру') },
            { value: 'OUTSIDE', label: tr('Снаружи') },
          ] as const,
          () => common(this.ids, (id) => d.get(id, 'strokeAlign')),
          (v) => this.set('strokeAlign', v, tr('Положение обводки')),
        ),
      );
      body.append(h('div', { class: 'grid-2' }, weight.el, align.el));
      this.buildStrokeSettings(body);
    };
    if (!styleMode && this.editor.selectionStyle(binding) !== null) {
      body.append(this.add(new StyleRow(this.editor, binding, (style) => this.editStyle(style))).el);
      strokeOptions();
      return;
    }
    if (shared === null) return;
    if (shared === MIXED) {
      body.append(h('div', { class: 'row' }, h('span', { class: 'hint' }, tr('Разные значения у объектов')), h('button', { class: 'text-button', type: 'button', onclick: () => {
        // The first layer that has any: «make the same» never wipes paints away.
        const source = ids.find((id) => d.get(id, key).length > 0) ?? ids[0]!;
        const value = d.get(source, key);
        commit(title, (tx, id) => tx.set(id, key, value));
      } }, tr('Сделать одинаковыми'))));
      return;
    }
    // Top of the list = top-most paint, as in Figma.
    [...shared].reverse().forEach((paint, reversedIndex) => {
      const index = shared.length - 1 - reversedIndex;
      const host: PaintHost = {
        doc: d,
        add: (field) => this.add(field),
        read: () => d.get(targets()[0]!, key)[index] ?? null,
        write: (next, extra) =>
          commit(title, (tx, id) => {
            const list = [...d.get(id, key)];
            const value = extra ? extra(tx) : next;
            if (value) list[index] = value;
            else list.splice(index, 1);
            tx.set(id, key, list);
          }),
        toast: (message) => this.editor.toast(message),
        wrapColor: (field) => this.bindable(`${key}/${index}`, field).el,
        wrapStop: (field, stop) => this.bindable(`${key}/${index}/stops/${stop}`, field).el,
        // Layers only: a colour style has no frame to crop to.
        crop: d.type(ids[0]!) === 'STYLE' ? undefined : () => this.cropImage(targets()[0]!, index),
        erase: d.type(ids[0]!) === 'STYLE' ? undefined : () => this.eraseImage(targets()[0]!, index),
        removeBg: d.type(ids[0]!) === 'STYLE' ? undefined : () => this.removeImageBackground(targets()[0]!, index),
        sources: () => this.patternSources(targets()),
        live: (next, phase) => {
          if (phase === 'start') {
            this.scrub = { gesture: this.editor.beginGesture(title), start: new Map() };
            return;
          }
          const scrub = this.scrub;
          if (!scrub) return;
          if (phase === 'update' && next) {
            scrub.gesture.update((tx) => {
              for (const id of targets()) {
                const list = [...d.get(id, key)];
                list[index] = next;
                tx.set(id, key, list);
              }
            });
          } else if (phase === 'end') {
            scrub.gesture.commit();
            this.scrub = null;
          }
        },
        gradient: styleMode
          ? {
              // A style has no canvas handles: the stop selection lives in the panel.
              selected: () => this.styleStop,
              select: (stop) => {
                this.styleStop = stop;
                for (const f of this.fields) f.refresh();
              },
            }
          : {
              selected: () => {
                const g = this.editor.gradientEdit;
                return g && g.key === key && g.index === index && ids.length === 1 && g.id === ids[0] ? g.stop : null;
              },
              select: (stop) => {
                if (ids.length === 1) this.editor.setGradientEdit({ id: ids[0]!, key, index, stop });
              },
            },
      };
      const item = buildPaintItem(host, paint, title);
      if (!styleMode) this.pickable(item, key, index);
      body.append(item);
    });
    if (shared.length > 0) strokeOptions();
  }

  /**
   * A fill, stroke or effect row, as in Figma: a click on its free space picks it — ⌘C then copies
   * just this property and ⌘V on another layer adds it; the right button opens the same in a menu.
   */
  private pickable(item: HTMLElement, key: PickedProperty['key'], index: number): void {
    const editor = this.editor;
    const isPicked = () => editor.pickedProperty?.key === key && editor.pickedProperty.index === index;
    item.classList.add('pickable');
    item.title = tr('Щелчок по свободному месту строки выделяет её: ⌘C скопирует только это свойство, ⌘V вставит его в другой слой. Правая кнопка — меню');
    item.classList.toggle('picked', isPicked());
    const pick = (on: boolean) => {
      editor.pickProperty(on ? { key, index } : null);
      for (const other of this.el.querySelectorAll('.paint-item.picked')) other.classList.remove('picked');
      item.classList.toggle('picked', on);
    };
    item.addEventListener('click', (e) => {
      if ((e.target as Element).closest('input, select, button, textarea, label, a, canvas, [tabindex]')) return;
      pick(!isPicked());
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pick(true);
      const names = { fills: [tr('Копировать заливку'), tr('Вставить заливку')], strokes: [tr('Копировать обводку'), tr('Вставить обводку')], effects: [tr('Копировать эффект'), tr('Вставить эффект')] }[key];
      (this.menu ??= new ContextMenu(document.body)).open(e.clientX, e.clientY, [
        { kind: 'action', label: names[0]!, shortcut: 'Mod+C', run: () => void editor.copyPickedProperty() },
        { kind: 'action', label: names[1]!, shortcut: 'Mod+V', disabled: editor.propertyClipKey() !== key, run: () => editor.pastePropertyText(editor.propertyClip) },
      ]);
    });
  }

  /** Mockups: the layer's picture laid onto a surface — in perspective, or round a cup or a tube. */
  private buildWarp(ids: NodeId[]): void {
    const editor = this.editor;
    const d = editor.doc;
    const has = ids.some((id) => d.get(id, 'warp') !== null);
    const single = ids.length === 1 ? ids[0]! : null;
    const setWarp = (label: string, make: (id: NodeId, current: Warp | null) => Warp | null) =>
      this.commit(label, (tx, id) => tx.set(id, 'warp', make(id, d.get(id, 'warp'))));
    const toggle = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: has ? tr('Убрать искажение') : tr('Добавить искажение'),
        onclick: () => {
          if (has) {
            editor.setWarpEdit(null);
            setWarp(tr('Убрать искажение'), () => null);
            return;
          }
          setWarp(tr('Перспектива'), () => defaultWarp('PERSPECTIVE'));
          // The corners are what one moves next.
          if (single) editor.setWarpEdit(single);
        },
      },
      icon(has ? 'minus' : 'plus'),
    );
    const body = this.section(tr('Искажение'), toggle);
    if (!has) {
      // A group's layers may be warped (a repeat's copies follow its own layers): say so, and lead to them.
      const inner: NodeId[] = [];
      for (const id of ids) {
        d.store.walk(id, (c) => {
          if (d.get(c, 'repeatCopy')) return false;
          if (d.get(c, 'warp')) inner.push(c);
        });
      }
      if (inner.length > 0) {
        body.append(
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'hint' }, tr('Искажено слоёв внутри: {0}', inner.length)),
            h('button', { class: 'text-button', type: 'button', onclick: () => editor.setSelection(inner) }, h('span', {}, tr('Выбрать'))),
          ),
        );
      }
      return;
    }
    const kind = common(ids, (id) => d.get(id, 'warp')?.type ?? 'NONE');
    if (kind === MIXED || kind === 'NONE') {
      body.append(h('p', { class: 'hint' }, tr('Разные искажения у выделенных объектов')));
      return;
    }
    const type = this.add(
      new SegmentedField(
        tr('Вид искажения'),
        [
          { value: 'PERSPECTIVE', label: tr('Перспектива') },
          { value: 'CYLINDER', label: tr('Цилиндр') },
        ] as const,
        () => common(this.ids, (id) => d.get(id, 'warp')?.type ?? 'PERSPECTIVE'),
        (v) => {
          setWarp(v === 'PERSPECTIVE' ? tr('Перспектива') : tr('Цилиндр'), (_, current) => (current?.type === v ? current : defaultWarp(v)));
          editor.setWarpEdit(v === 'PERSPECTIVE' && single ? single : null);
        },
        true,
      ),
    );
    body.append(type.el);
    if (kind === 'PERSPECTIVE') {
      if (single) {
        const editing = editor.warpEdit === single;
        body.append(
          h(
            'button',
            { class: `text-button wide${editing ? ' on' : ''}`, type: 'button', 'aria-pressed': String(editing), onclick: () => editor.setWarpEdit(editing ? null : single) },
            h('span', {}, editing ? tr('Готово (Esc)') : tr('Двигать углы на холсте')),
          ),
          h('p', { class: 'hint' }, tr('Потяните круглые ручки в углах — картинка слоя ляжет на книгу, экран или визитку под углом. Двойной щелчок по слою тоже включает ручки.')),
        );
      }
      const iso = (face: 'FLAT' | 'LEFT' | 'RIGHT', label: string, title: string) =>
        h(
          'button',
          {
            class: 'text-button',
            type: 'button',
            title,
            onclick: () => setWarp(label, (id) => ({ type: 'PERSPECTIVE', corners: isometricCorners(face, d.get(id, 'width'), d.get(id, 'height')) })),
          },
          h('span', {}, label),
        );
      body.append(
        h('div', { class: 'subsection-title' }, tr('Изометрия')),
        h(
          'div',
          { class: 'grid-2' },
          iso('FLAT', tr('Лёжа'), tr('Лежит на столе, как обложка книги или визитка')),
          iso('LEFT', tr('Стена слева'), tr('Левая боковая грань коробки')),
          iso('RIGHT', tr('Стена справа'), tr('Правая боковая грань коробки')),
          h('button', { class: 'text-button', type: 'button', title: tr('Вернуть углы на места'), onclick: () => setWarp(tr('Сбросить углы'), () => defaultWarp('PERSPECTIVE')) }, h('span', {}, tr('Сбросить углы'))),
        ),
      );
      return;
    }
    // Cylinder.
    const read = () => {
      const warp = d.get(this.ids[0]!, 'warp');
      return warp?.type === 'CYLINDER' ? warp : null;
    };
    type Cylinder = Extract<Warp, { type: 'CYLINDER' }>;
    const update = (label: string, change: (w: Cylinder) => Partial<Cylinder>) =>
      setWarp(label, (_, current) => (current?.type === 'CYLINDER' ? { ...current, ...change(current) } : current));
    const axis = this.add(
      new SegmentedField(
        tr('Как стоит цилиндр'),
        [
          { value: 'VERTICAL', label: tr('Стоит') },
          { value: 'HORIZONTAL', label: tr('Лежит') },
        ] as const,
        () => common(this.ids, (id) => {
          const warp = d.get(id, 'warp');
          return warp?.type === 'CYLINDER' ? warp.axis : 'VERTICAL';
        }),
        (v) => update(tr('Как стоит цилиндр'), () => ({ axis: v })),
        true,
      ),
    );
    const num = (label: string, title: string, key: 'bend' | 'tilt' | 'taper' | 'shade', opts: { min: number; max: number; scale: number; suffix: string }) =>
      this.add(
        new NumberField({
          label,
          title,
          min: opts.min,
          max: opts.max,
          suffix: opts.suffix,
          read: () => {
            const values = this.ids.map((id) => d.get(id, 'warp')).filter((w): w is Cylinder => w?.type === 'CYLINDER');
            if (values.length === 0) return null;
            const first = Math.round(values[0]![key] * opts.scale);
            return values.every((w) => Math.round(w[key] * opts.scale) === first) ? first : MIXED;
          },
          scrubAsCommits: true,
          write: (compute, phase) => {
            if (phase !== 'commit') return;
            const current = read();
            if (!current) return;
            const value = Math.max(opts.min, Math.min(opts.max, Math.round(compute(current[key] * opts.scale))));
            update(label, () => ({ [key]: value / opts.scale }));
          },
        }),
      );
    const preset = (label: string, title: string, value: Omit<Cylinder, 'type'>) =>
      h('button', { class: 'text-button', type: 'button', title, onclick: () => setWarp(label, () => ({ type: 'CYLINDER', ...value })) }, h('span', {}, label));
    body.append(
      this.line(tr('Цилиндр'), axis.el, tr('Стоит — как стаканчик или банка; лежит — как туба')),
      h(
        'div',
        { class: 'grid-2' },
        num(tr('Изгиб'), tr('Какую часть окружности занимает слой: 0° — плоско, 180° — вся передняя половина'), 'bend', { min: 0, max: 179, scale: 1, suffix: '°' }).el,
        num(tr('Взгляд'), tr('Края изгибаются, как у цилиндра, на который смотрят сверху (больше нуля) или снизу (меньше нуля)'), 'tilt', { min: -50, max: 50, scale: 100, suffix: '%' }).el,
        num(tr('Конус'), tr('Один конец уже другого, как у стаканчика: больше нуля — уже снизу (у лежащего — справа), меньше нуля — сверху (слева)'), 'taper', { min: -50, max: 50, scale: 100, suffix: '%' }).el,
        num(tr('Затенение'), tr('Насколько темнеют края, уходящие за изгиб'), 'shade', { min: 0, max: 100, scale: 100, suffix: '%' }).el,
      ),
      h(
        'div',
        { class: 'grid-3' },
        preset(tr('Стаканчик'), tr('Бумажный стаканчик: сужается книзу, видно чуть сверху'), { axis: 'VERTICAL', bend: 140, tilt: 0.1, taper: 0.12, shade: 0.3 }),
        preset(tr('Банка'), tr('Банка или бутылка: ровный цилиндр, видно чуть сверху'), { axis: 'VERTICAL', bend: 130, tilt: 0.06, taper: 0, shade: 0.3 }),
        preset(tr('Туба'), tr('Лежащая туба или рулон'), { axis: 'HORIZONTAL', bend: 150, tilt: 0, taper: 0, shade: 0.35 }),
      ),
    );
  }

  /** «Show all» in Selection colors was pressed. */
  private allSelectionColors = false;

  /**
   * Selection colors (Figma): every solid colour of the selected layers and what they
   * hold — fills, strokes, coloured parts of texts — one swatch per colour, most used
   * first. Changing a swatch changes that colour everywhere it is used.
   */
  private buildSelectionColors(ids: NodeId[]): void {
    const d = this.editor.doc;
    if (ids.length < 2 && !ids.some((id) => d.children(id).length > 0)) return;
    type Ref = { id: NodeId; key: 'fills' | 'strokes'; index: number } | { id: NodeId; run: number; index: number };
    const groups = new Map<string, Ref[]>();
    const add = (paint: Paint, ref: Ref) => {
      if (!paint.visible || paint.type !== 'SOLID') return;
      const c = paint.color;
      const k = `${colorToHex(c)}|${Math.round(c.a * paint.opacity * 100)}`;
      const list = groups.get(k) ?? [];
      list.push(ref);
      groups.set(k, list);
    };
    let left = 3000;
    const visit = (id: NodeId) => {
      if (left-- <= 0 || !d.get(id, 'visible')) return;
      for (const key of ['fills', 'strokes'] as const) d.get(id, key).forEach((p, index) => add(p, { id, key, index }));
      if (d.type(id) === 'TEXT') d.get(id, 'textRuns').forEach((r, run) => r.style.fills?.forEach((p, index) => add(p, { id, run, index })));
    };
    for (const id of ids) {
      visit(id);
      d.store.walk(id, (c) => {
        visit(c);
      });
    }
    if (groups.size === 0) return;
    const paintOf = (ref: Ref): Paint | undefined => ('key' in ref ? d.get(ref.id, ref.key)[ref.index] : d.get(ref.id, 'textRuns')[ref.run]?.style.fills?.[ref.index]);
    const all = [...groups.values()].sort((a, b) => b.length - a.length);
    const body = this.section(tr('Цвета выделения'));
    const shown = this.allSelectionColors ? all : all.slice(0, 8);
    for (const refs of shown) {
      const field = this.add(
        new ColorField({
          title: tr('Цвет выделения: меняется везде, где он есть ({0})', refs.length),
          read: () => {
            const p = paintOf(refs[0]!);
            return p?.type === 'SOLID' ? { color: { ...p.color, a: 1 }, opacity: p.opacity * p.color.a } : null;
          },
          write: (c, opacity) =>
            this.editor.commit(tr('Цвета выделения'), (tx) => {
              const recolor = (p: Paint): Paint => (p.type === 'SOLID' ? { ...p, color: { ...c, a: 1 }, opacity } : p);
              const byNode = new Map<NodeId, Ref[]>();
              for (const r of refs) byNode.set(r.id, [...(byNode.get(r.id) ?? []), r]);
              for (const [id, list] of byNode) {
                for (const key of ['fills', 'strokes'] as const) {
                  const mine = list.filter((r): r is Extract<Ref, { key: string }> => 'key' in r && r.key === key);
                  if (mine.length) tx.set(id, key, d.get(id, key).map((p, i) => (mine.some((r) => r.index === i) ? recolor(p) : p)));
                }
                const runs = list.filter((r): r is Extract<Ref, { run: number }> => 'run' in r);
                if (runs.length)
                  tx.set(id, 'textRuns', d.get(id, 'textRuns').map((r, ri) => (runs.some((x) => x.run === ri) ? { ...r, style: { ...r.style, fills: r.style.fills?.map((p, i) => (runs.some((x) => x.run === ri && x.index === i) ? recolor(p) : p)) } } : r)));
              }
            }),
        }),
      );
      body.append(h('div', { class: 'selection-color' }, field.el, h('span', { class: 'hint small', title: tr('Где используется этот цвет') }, String(refs.length))));
    }
    if (all.length > 8) {
      body.append(
        h(
          'button',
          {
            class: 'text-button wide',
            type: 'button',
            onclick: () => {
              this.allSelectionColors = !this.allSelectionColors;
              this.update();
            },
          },
          h('span', {}, this.allSelectionColors ? tr('Показать меньше') : tr('Показать все цвета ({0})', all.length)),
        ),
      );
    }
  }

  /** «Show all» in Selection fonts was pressed. */
  private allSelectionFonts = false;

  /**
   * Selection fonts — Selection colors for type: every font (family, weight, italic) of
   * the texts in the selection, parts of texts in another font included, one row per
   * font, most used first. Changing a row's family or weight changes that font everywhere
   * it is used; the rest of each text keeps what it had.
   */
  private buildSelectionFonts(ids: NodeId[]): void {
    const d = this.editor.doc;
    if (ids.length < 2 && !ids.some((id) => d.children(id).length > 0)) return;
    // run −1 is the text's own font: the characters no part of the text gives another font.
    type Ref = { id: NodeId; run: number };
    type Font = { family: string; weight: number; italic: boolean };
    const groups = new Map<string, { font: Font; refs: Ref[] }>();
    const sets = (s: TextRunStyle) => s.fontFamily !== undefined || s.fontWeight !== undefined || s.italic !== undefined;
    const add = (font: Font, ref: Ref) => {
      const k = `${font.family}|${font.weight}|${font.italic}`;
      const g = groups.get(k) ?? { font, refs: [] };
      g.refs.push(ref);
      groups.set(k, g);
    };
    let left = 3000;
    const visit = (id: NodeId) => {
      if (left-- <= 0 || !d.get(id, 'visible') || d.type(id) !== 'TEXT') return;
      const base: Font = { family: d.get(id, 'fontFamily'), weight: d.get(id, 'fontWeight'), italic: d.get(id, 'italic') };
      const length = d.get(id, 'characters').length;
      let covered = 0;
      d.get(id, 'textRuns').forEach((r, run) => {
        if (!sets(r.style) || r.end <= r.start) return;
        covered += Math.min(r.end, length) - Math.max(r.start, 0);
        add({ family: r.style.fontFamily ?? base.family, weight: r.style.fontWeight ?? base.weight, italic: r.style.italic ?? base.italic }, { id, run });
      });
      if (covered < length || length === 0) add(base, { id, run: -1 });
    };
    for (const id of ids) {
      visit(id);
      d.store.walk(id, (c) => {
        visit(c);
      });
    }
    if (groups.size === 0) return;
    const all = [...groups.values()].sort((a, b) => b.refs.length - a.refs.length);
    const body = this.section(tr('Шрифты выделения'));
    const change = (refs: Ref[], key: 'fontFamily' | 'fontWeight', value: string | number, label: string) =>
      this.editor.commit(label, (tx) => {
        const byNode = new Map<NodeId, number[]>();
        for (const r of refs) byNode.set(r.id, [...(byNode.get(r.id) ?? []), r.run]);
        for (const [id, runs] of byNode) {
          const own = runs.includes(-1);
          const before = d.get(id, key);
          // A part of the text in another font that took this one's family or weight keeps it.
          tx.set(id, 'textRuns', d.get(id, 'textRuns').map((r, i) => (runs.includes(i) ? { ...r, style: { ...r.style, [key]: value } } : own && sets(r.style) && r.style[key] === undefined ? { ...r, style: { ...r.style, [key]: before } } : r)));
          if (own) {
            tx.set(id, key, value as never);
            // The text no longer looks like its text style: it is unlinked, as on any other change of its font.
            if (d.get(id, 'textStyleId')) tx.set(id, 'textStyleId', null);
          }
        }
      });
    // Read again on every refresh (an undo); after a change the rows are grouped anew.
    const fontOf = (ref: Ref): Font | null => {
      if (!d.store.has(ref.id)) return null;
      const s = ref.run < 0 ? {} : (d.get(ref.id, 'textRuns')[ref.run]?.style ?? {});
      return { family: s.fontFamily ?? d.get(ref.id, 'fontFamily'), weight: s.fontWeight ?? d.get(ref.id, 'fontWeight'), italic: s.italic ?? d.get(ref.id, 'italic') };
    };
    const regroup = (refs: Ref[], key: 'fontFamily' | 'fontWeight', value: string | number) => {
      change(refs, key, value, tr('Шрифты выделения'));
      this.signature = '';
      this.update();
    };
    const shown = this.allSelectionFonts ? all : all.slice(0, 8);
    for (const { font, refs } of shown) {
      const family = this.add(new FontPicker(() => d, () => fontOf(refs[0]!)?.family ?? null, (v) => regroup(refs, 'fontFamily', v)));
      const weight = this.add(new WeightField(() => fontOf(refs[0]!)?.family ?? null, () => fontOf(refs[0]!)?.weight ?? null, (v) => regroup(refs, 'fontWeight', v)));
      const what = `${font.family} ${font.weight}${font.italic ? ` ${tr('курсив')}` : ''}`;
      body.append(
        h(
          'div',
          { class: 'selection-font', title: tr('Шрифт выделения: меняется везде, где он есть — {0} ({1})', what, refs.length) },
          family.el,
          h('div', { class: 'selection-color' }, weight.el, font.italic ? h('span', { class: 'hint small' }, tr('курсив')) : null, h('span', { class: 'hint small', title: tr('Где используется этот шрифт') }, String(refs.length))),
        ),
      );
    }
    if (all.length > 8) {
      body.append(
        h(
          'button',
          {
            class: 'text-button wide',
            type: 'button',
            onclick: () => {
              this.allSelectionFonts = !this.allSelectionFonts;
              this.update();
            },
          },
          h('span', {}, this.allSelectionFonts ? tr('Показать меньше') : tr('Показать все шрифты ({0})', all.length)),
        ),
      );
    }
  }

  /** How an effect mixes with what is under it (shadows and noise, as in Figma). */
  private effectBlend(read: () => Effect | null, update: (next: Effect | null) => void, index: number): HTMLElement {
    const field = this.add(
      new SelectField<BlendMode>(
        tr('Режим наложения эффекта {0}', index + 1),
        blendChoices(),
        () => {
          const e = read();
          return e && 'blendMode' in e ? (e.blendMode ?? 'NORMAL') : e ? 'NORMAL' : null;
        },
        (v) => {
          const e = read();
          if (e && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'NOISE')) update({ ...e, blendMode: v === 'NORMAL' ? undefined : v });
        },
      ),
    );
    return this.line(tr('Наложение'), field.el, tr('Как эффект смешивается с тем, что под ним'));
  }

  /**
   * What a pattern can repeat: layers on this page (at the top or one level in) and the
   * file's components — not the painted layers, nor what holds them or sits inside them.
   */
  private patternSources(targets: NodeId[]): { value: string; label: string }[] {
    const d = this.editor.doc;
    const blocked = new Set<NodeId>();
    for (const t of targets) {
      blocked.add(t);
      for (const a of d.store.ancestors(t)) blocked.add(a);
    }
    const inside = (id: NodeId) => targets.some((t) => t !== id && d.store.isAncestorOrSelf(t, id));
    const out: { value: string; label: string }[] = [];
    const seen = new Set<NodeId>();
    const offer = (id: NodeId) => {
      if (seen.has(id) || blocked.has(id) || inside(id) || !d.get(id, 'visible')) return;
      seen.add(id);
      out.push({ value: id, label: d.get(id, 'name') || d.type(id) });
    };
    for (const top of d.children(this.editor.pageId)) {
      offer(top);
      if (isFrameLike(d.type(top)) || d.type(top) === 'GROUP') for (const c of d.children(top)) offer(c);
    }
    for (const page of d.pages()) d.store.walk(page, (id) => { if (d.type(id) === 'COMPONENT') offer(id); });
    return out.slice(0, 300);
  }

  private buildEffects(ids: NodeId[]): void {
    const d = this.editor.doc;
    const shared = common(ids, (id) => d.get(id, 'effects'), valueEquals);
    const add = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: tr('Добавить эффект'),
        onclick: () => this.commit(tr('Эффекты'), (tx, id) => tx.set(id, 'effects', [...(shared === MIXED ? [] : d.get(id, 'effects')), newEffect('DROP_SHADOW')])),
      },
      icon('plus'),
    );
    const styleMode = this.editingStyle !== null;
    const body = styleMode ? this.section(tr('Эффекты'), add) : this.section(tr('Эффекты'), styleButton(this.editor, 'effectStyleId'), add);
    if (!styleMode && this.editor.selectionStyle('effectStyleId') !== null) {
      body.append(this.add(new StyleRow(this.editor, 'effectStyleId', (style) => this.editStyle(style))).el);
      return;
    }
    if (shared === null) return;
    if (shared === MIXED) {
      body.append(h('p', { class: 'hint' }, tr('Разные эффекты у выделенных объектов')));
      return;
    }
    if (shared.length === 0) {
      return;
    }
    shared.forEach((effect, index) => {
      const read = () => d.get(this.ids[0]!, 'effects')[index] ?? null;
      const update = (next: Effect | null) =>
        this.commit(tr('Эффекты'), (tx, id) => {
          const list = [...d.get(id, 'effects')];
          if (next) list[index] = next;
          else list.splice(index, 1);
          tx.set(id, 'effects', list);
        });
      const type = this.add(
        new SelectField(
          tr('Тип эффекта'),
          EFFECT_TYPES,
          () => read()?.type ?? null,
          (v) => {
            const current = read();
            if (current && current.type !== v) update(convertEffect(current, v));
          },
        ),
      );
      const visible = h('button', { class: 'icon-button', type: 'button', title: effect.visible ? tr('Скрыть') : tr('Показать'), onclick: () => update({ ...effect, visible: !effect.visible }) }, icon(effect.visible ? 'eye' : 'eyeOff'));
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить'), onclick: () => update(null) }, icon('minus'));
      // Drag by the grip to change the order (it changes how the layer is drawn, as in Figma).
      const grip = h('span', { class: 'effect-grip', title: tr('Перетащите, чтобы поменять порядок эффектов'), 'aria-hidden': 'true' }, icon('grip'));
      const item = h('div', { class: `paint-item${effect.visible ? '' : ' muted'}`, 'data-effect': String(index) }, h('div', { class: 'paint-row' }, grip, type.el, visible, remove));
      grip.addEventListener('pointerdown', () => (item.draggable = true));
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/x-effect', String(index));
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.draggable = false;
        item.classList.remove('dragging');
      });
      item.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('text/x-effect')) return;
        e.preventDefault();
        item.classList.add('drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
      item.addEventListener('drop', (e) => {
        item.classList.remove('drop-target');
        const from = Number(e.dataTransfer?.getData('text/x-effect'));
        if (!Number.isInteger(from) || from === index) return;
        e.preventDefault();
        this.commit(tr('Порядок эффектов'), (tx, id) => {
          const list = [...d.get(id, 'effects')];
          const [moved] = list.splice(from, 1);
          if (moved) list.splice(index, 0, moved);
          tx.set(id, 'effects', list);
        });
      });
      const num = (label: string, title: string, get: (e: Effect) => number, set: (e: Effect, v: number) => Effect, opts: { min?: number; max?: number; suffix?: string } = {}) =>
        this.add(
          new NumberField({
            label,
            title,
            min: opts.min,
            max: opts.max,
            suffix: opts.suffix,
            read: () => {
              const e = read();
              return e ? get(e) : null;
            },
            scrubAsCommits: true,
            write: (compute, phase) => {
              if (phase !== 'commit') return;
              const e = read();
              if (e) update(set(e, round2(compute(get(e)))));
            },
          }),
        );
      if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
        const sh = (e: Effect) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? e : null);
        item.append(
          h(
            'div',
            { class: 'grid-2' },
            num('X', tr('Смещение по горизонтали'), (e) => sh(e)?.offset.x ?? 0, (e, v) => { const s2 = sh(e); return s2 ? { ...s2, offset: { ...s2.offset, x: v } } : e; }).el,
            num('Y', tr('Смещение по вертикали'), (e) => sh(e)?.offset.y ?? 0, (e, v) => { const s2 = sh(e); return s2 ? { ...s2, offset: { ...s2.offset, y: v } } : e; }).el,
            num(tr('Размытие'), tr('Радиус размытия тени'), (e) => sh(e)?.radius ?? 0, (e, v) => { const s2 = sh(e); return s2 ? { ...s2, radius: v } : e; }, { min: 0 }).el,
            num(tr('Размер'), tr('Насколько тень больше (или меньше) самого объекта'), (e) => sh(e)?.spread ?? 0, (e, v) => { const s2 = sh(e); return s2 ? { ...s2, spread: v } : e; }).el,
          ),
        );
        const color = this.add(
          new ColorField({
            title: tr('Цвет тени'),
            read: () => {
              const e = read();
              return e && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') ? { color: { ...e.color, a: 1 }, opacity: e.color.a } : null;
            },
            write: (c, opacity) => {
              const e = read();
              if (e && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) update({ ...e, color: { ...c, a: opacity } });
            },
          }),
        );
        item.append(this.bindable(`effects/${index}`, color).el, this.effectBlend(read, update, index));
        if (effect.type === 'DROP_SHADOW') {
          const behind = this.add(
            new CheckboxField(
              tr('Видна за прозрачными местами'),
              () => {
                const e = read();
                return e?.type === 'DROP_SHADOW' ? !!e.showBehind : null;
              },
              (v) => {
                const e = read();
                if (e?.type === 'DROP_SHADOW') update({ ...e, showBehind: v || undefined });
              },
            ),
          );
          item.append(behind.el);
        }
      } else if (effect.type === 'NOISE') {
        const nz = (e: Effect) => (e.type === 'NOISE' ? e : null);
        const kind = this.add(
          new SelectField(
            tr('Сколько цветов в шуме'),
            NOISE_TYPES,
            () => {
              const n = nz(read() as Effect);
              return n ? (n.noiseType ?? 'GRAIN') : null;
            },
            (v) => {
              const n = nz(read() as Effect);
              if (!n) return;
              if (v === 'GRAIN') {
                const { noiseType: _, density: _d, color: _c, secondaryColor: _s, blendMode: _b, ...grain } = n;
                update({ ...grain, amount: Math.min(n.amount, 0.3) || 0.15 });
              } else update({ ...newEffect('NOISE'), ...n, noiseType: v, amount: n.noiseType ? n.amount : 1, density: n.density ?? 0.5, color: n.color ?? rgba(0, 0, 0, 0.25), secondaryColor: n.secondaryColor ?? rgba(1, 1, 1, 0.25) } as Effect);
            },
          ),
        );
        item.append(kind.el);
        const legacy = !effect.noiseType;
        item.append(
          h(
            'div',
            { class: 'grid-2' },
            legacy
              ? num(tr('Сила'), tr('Насколько заметна зернистость'), (e) => Math.round((nz(e)?.amount ?? 0) * 100), (e, v) => { const n = nz(e); return n ? { ...n, amount: Math.max(0, Math.min(100, v)) / 100 } : e; }, { min: 0, max: 100, suffix: '%' }).el
              : num(tr('Плотность'), tr('Сколько точек шума: доля пикселей'), (e) => Math.round((nz(e)?.density ?? 0.5) * 100), (e, v) => { const n = nz(e); return n ? { ...n, density: Math.max(0, Math.min(100, v)) / 100 } : e; }, { min: 0, max: 100, suffix: '%' }).el,
            num(tr('Зерно'), tr('Размер зерна, px'), (e) => nz(e)?.size ?? 1, (e, v) => { const n = nz(e); return n ? { ...n, size: Math.max(0.5, v) } : e; }, { min: 0.5, suffix: 'px' }).el,
          ),
        );
        if (effect.noiseType === 'MULTI') {
          item.append(num(tr('Непрозр.'), tr('Непрозрачность точек шума'), (e) => Math.round((nz(e)?.amount ?? 1) * 100), (e, v) => { const n = nz(e); return n ? { ...n, amount: Math.max(0, Math.min(100, v)) / 100 } : e; }, { min: 0, max: 100, suffix: '%' }).el);
        } else if (effect.noiseType) {
          const colorOf = (key: 'color' | 'secondaryColor', title: string) =>
            this.add(
              new ColorField({
                title,
                read: () => {
                  const n = nz(read() as Effect);
                  const c = n?.[key];
                  return c ? { color: { ...c, a: 1 }, opacity: c.a } : null;
                },
                write: (c, opacity) => {
                  const n = nz(read() as Effect);
                  if (n) update({ ...n, [key]: { ...c, a: opacity } });
                },
              }),
            ).el;
          item.append(colorOf('color', tr('Цвет шума')));
          if (effect.noiseType === 'DUO') item.append(colorOf('secondaryColor', tr('Второй цвет шума')));
        }
        if (!legacy) item.append(this.effectBlend(read, update, index));
      } else if (effect.type === 'TEXTURE') {
        const tx2 = (e: Effect) => (e.type === 'TEXTURE' ? e : null);
        const clip = this.add(
          new CheckboxField(
            tr('Только внутри формы'),
            () => tx2(read() as Effect)?.clipToShape ?? null,
            (v) => {
              const t = tx2(read() as Effect);
              if (t) update({ ...t, clipToShape: v });
            },
          ),
        );
        item.append(
          h(
            'div',
            { class: 'grid-2' },
            num(tr('Размер'), tr('Размер зерна шероховатости, px'), (e) => tx2(e)?.size ?? 4, (e, v) => { const t = tx2(e); return t ? { ...t, size: Math.max(0.5, v) } : e; }, { min: 0.5, suffix: 'px' }).el,
            num(tr('Радиус'), tr('Насколько далеко за край расходится шероховатость, px'), (e) => tx2(e)?.radius ?? 4, (e, v) => { const t = tx2(e); return t ? { ...t, radius: Math.max(0, v) } : e; }, { min: 0, suffix: 'px' }).el,
          ),
          clip.el,
        );
      } else if (effect.type === 'GLASS') {
        const gl = (e: Effect) => (e.type === 'GLASS' ? e : null);
        const pct = (label: string, title: string, key: 'lightIntensity' | 'refraction' | 'dispersion' | 'splay') =>
          num(label, title, (e) => Math.round((gl(e)?.[key] ?? 0) * 100), (e, v) => { const g = gl(e); return g ? { ...g, [key]: Math.max(0, Math.min(100, v)) / 100 } : e; }, { min: 0, max: 100, suffix: '%' }).el;
        item.append(
          h(
            'div',
            { class: 'grid-2' },
            num(tr('Угол света'), tr('Откуда падает свет: −45° — слева сверху'), (e) => gl(e)?.lightAngle ?? -45, (e, v) => { const g = gl(e); return g ? { ...g, lightAngle: Math.round(v) } : e; }, { min: -180, max: 180, suffix: '°' }).el,
            pct(tr('Свет'), tr('Яркость блика на краю'), 'lightIntensity'),
          ),
          // A long name: the whole width, or its value is cut.
          pct(tr('Преломление'), tr('Насколько изгибается то, что под стеклом, у края'), 'refraction'),
          h(
            'div',
            { class: 'grid-2' },
            num(tr('Глубина'), tr('Как далеко от края внутрь идёт изгиб, px'), (e) => gl(e)?.depth ?? 20, (e, v) => { const g = gl(e); return g ? { ...g, depth: Math.max(1, v) } : e; }, { min: 1, suffix: 'px' }).el,
            pct(tr('Радуга'), tr('Насколько расходятся цвета у края (дисперсия)'), 'dispersion'),
          ),
          h(
            'div',
            { class: 'grid-2' },
            num(tr('Матовость'), tr('Размытие того, что под стеклом, px'), (e) => gl(e)?.frost ?? 0, (e, v) => { const g = gl(e); return g ? { ...g, frost: Math.max(0, v) } : e; }, { min: 0, suffix: 'px' }).el,
            pct(tr('Рассеяние'), tr('Насколько широко расходится блик'), 'splay'),
          ),
          h('p', { class: 'hint' }, tr('Стекло видно, когда заливка слоя полупрозрачная или её нет.')),
        );
      } else {
        const bl = (e: Effect) => (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR' ? e : null);
        // Even, or growing toward one side (progressive, as in Figma): weak at one edge, full at the other.
        const shape = this.add(
          new SelectField(
            tr('Как размыто'),
            BLUR_SHAPES.map((x) => ({ value: x.value, label: x.label })),
            () => {
              const e = read();
              const b = e ? bl(e) : null;
              return b ? blurShapeOf(b) : null;
            },
            (v) => {
              const e = read();
              const b = e ? bl(e) : null;
              if (!b) return;
              const to = BLUR_SHAPES.find((x) => x.value === v)!;
              const { progressive: _, ...even } = b;
              update(to.ends ? { ...even, progressive: { start: b.progressive?.start ?? 0, from: to.ends[0], to: to.ends[1] } } : even);
            },
          ),
        );
        const progressive = !!bl(effect)?.progressive;
        item.append(
          h('div', { class: 'grid-2' },
            num(progressive ? tr('Сильнее всего') : tr('Радиус'), tr('Радиус размытия, px'), (e) => bl(e)?.radius ?? 0, (e, v) => { const b = bl(e); return b ? { ...b, radius: Math.max(0, v) } : e; }, { min: 0 }).el,
            progressive ? num(tr('Слабее всего'), tr('Размытие у слабого края, px'), (e) => bl(e)?.progressive?.start ?? 0, (e, v) => { const b = bl(e); return b?.progressive ? { ...b, progressive: { ...b.progressive, start: Math.max(0, v) } } : e; }, { min: 0 }).el : h('span'),
          ),
          shape.el,
        );
      }
      if (!styleMode) this.pickable(item, 'effects', index);
      body.append(item);
    });
  }

  /** Layout grids of frames (FR-GRD-001…004): columns, rows or a square grid; styles; variables. */
  private buildLayoutGrids(ids: NodeId[]): void {
    const d = this.editor.doc;
    const editor = this.editor;
    const styleMode = this.editingStyle !== null;
    const shared = common(ids, (id) => d.get(id, 'layoutGrids'), valueEquals);
    const add = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: tr('Добавить сетку колонок'),
        onclick: () => {
          this.commit(tr('Сетка колонок'), (tx, id) => tx.set(id, 'layoutGrids', [...(shared === MIXED ? [] : d.get(id, 'layoutGrids')), defaultGrid('COLUMNS')]));
          if (!editor.view.layoutGrids) editor.setView({ layoutGrids: true });
        },
      },
      icon('plus'),
    );
    const eye = h(
      'button',
      { class: `icon-button${editor.view.layoutGrids ? '' : ' on'}`, type: 'button', title: editor.view.layoutGrids ? tr('Скрыть все сетки (Ctrl+G)') : tr('Показать все сетки (Ctrl+G)'), onclick: () => editor.setView({ layoutGrids: !editor.view.layoutGrids }) },
      icon(editor.view.layoutGrids ? 'eye' : 'eyeOff'),
    );
    // Without grids the eye has nothing to show: only the styles and "+" stay.
    const anyGrid = ids.some((id) => d.get(id, 'layoutGrids').length > 0) || this.editor.doc.styles().some((st) => d.get(st, 'styleType') === 'GRID');
    const body = styleMode ? this.section(tr('Сетки'), add) : this.section(tr('Сетки колонок'), ...(anyGrid ? [styleButton(editor, 'gridStyleId'), eye] : []), add);
    if (!styleMode && editor.selectionStyle('gridStyleId') !== null) {
      body.append(this.add(new StyleRow(editor, 'gridStyleId', (style) => this.editStyle(style))).el);
      return;
    }
    if (shared === null) return;
    if (shared === MIXED) {
      body.append(h('p', { class: 'hint' }, tr('Разные сетки у выделенных фреймов')));
      return;
    }
    if (shared.length === 0) {
      return;
    }
    shared.forEach((grid, index) => {
      const read = () => d.get(this.ids[0]!, 'layoutGrids')[index] ?? null;
      const update = (fn: (g: LayoutGrid) => LayoutGrid, label = tr('Сетка колонок')) =>
        this.commit(label, (tx, id) => {
          const list = [...d.get(id, 'layoutGrids')];
          const g = list[index];
          if (!g) return;
          list[index] = fn(g);
          tx.set(id, 'layoutGrids', list);
        });
      const pattern = this.add(
        new SelectField(
          tr('Вид сетки'),
          [
            { value: 'COLUMNS', label: tr('Колонки') },
            { value: 'ROWS', label: tr('Строки') },
            { value: 'GRID', label: tr('Сетка') },
          ] as const,
          () => read()?.pattern ?? null,
          (v) => update((g) => (v === 'GRID' ? { ...defaultGrid('GRID'), color: g.color, visible: g.visible } : g.pattern === 'GRID' ? { ...defaultGrid(v), color: g.color, visible: g.visible } : { ...g, pattern: v })),
        ),
      );
      const visible = h('button', { class: 'icon-button', type: 'button', title: grid.visible ? tr('Скрыть') : tr('Показать'), onclick: () => update((g) => ({ ...g, visible: !g.visible })) }, icon(grid.visible ? 'eye' : 'eyeOff'));
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить сетку'), onclick: () => this.commit(tr('Удалить сетку'), (tx, id) => tx.set(id, 'layoutGrids', d.get(id, 'layoutGrids').filter((_, i) => i !== index))) }, icon('minus'));
      // In plain words what the grid is (a one-column grid at an edge is a margin, as files from Figma often have them),
      // and a word when it can hardly be seen at all.
      const faint = grid.color.a < 0.1;
      const item = h(
        'div',
        { class: `paint-item${grid.visible ? '' : ' muted'}` },
        h('div', { class: 'paint-row' }, pattern.el, visible, remove),
        h('p', { class: 'grid-caption' }, gridCaption(grid), faint ? h('span', { class: 'grid-faint' }, ' · ', tr('почти не видна ({0} %) — сделайте цвет плотнее, 20–30 %', Math.round(grid.color.a * 100))) : null),
      );
      const num = (key: 'count' | 'sectionSize' | 'offset' | 'gutterSize', label: string, title: string, min: number) =>
        this.bindable(
          `layoutGrids/${index}/${key}`,
          this.add(
            new NumberField({
              label,
              title,
              min,
              read: () => {
                const g = read();
                const v = g ? (g as Record<string, unknown>)[key] : undefined;
                return typeof v === 'number' ? v : null;
              },
              scrubAsCommits: true,
              write: (compute, phase) => {
                if (phase !== 'commit') return;
                update((g) => {
                  const cur = (g as Record<string, unknown>)[key];
                  if (typeof cur !== 'number') return g;
                  const v = Math.max(min, round2(compute(cur)));
                  return { ...g, [key]: key === 'count' ? Math.round(v) : v } as LayoutGrid;
                });
              },
            }),
          ),
        );
      if (grid.pattern === 'GRID') {
        item.append(h('div', { class: 'grid-2' }, num('sectionSize', tr('Размер'), tr('Размер клетки, px'), 1).el));
      } else {
        const rows = grid.pattern === 'ROWS';
        const align = this.add(
          new SelectField(
            tr('Выравнивание'),
            [
              { value: 'STRETCH', label: tr('Растянуть') },
              { value: 'MIN', label: rows ? tr('Сверху') : tr('Слева') },
              { value: 'CENTER', label: tr('По центру') },
              { value: 'MAX', label: rows ? tr('Снизу') : tr('Справа') },
            ] as const,
            () => {
              const g = read();
              return g && g.pattern !== 'GRID' ? g.alignment : null;
            },
            (v) => update((g) => (g.pattern === 'GRID' ? g : { ...g, alignment: v, count: v === 'STRETCH' && g.count === 0 ? 5 : g.count })),
          ),
        );
        item.append(
          h(
            'div',
            { class: 'grid-2' },
            num('count', rows ? tr('Строк') : tr('Колонок'), tr('Количество {0}; 0 — сколько поместится (не для «Растянуть»)', rows ? tr('строк') : tr('колонок')), 0).el,
            align.el,
            ...(grid.alignment === 'STRETCH' ? [] : [num('sectionSize', rows ? tr('Высота') : tr('Ширина'), rows ? tr('Высота строки, px') : tr('Ширина колонки, px'), 1).el]),
            num('offset', grid.alignment === 'STRETCH' || grid.alignment === 'CENTER' ? tr('Поля') : tr('Отступ'), grid.alignment === 'STRETCH' ? tr('Поля по краям фрейма, px') : tr('Отступ от края, px'), 0).el,
            num('gutterSize', tr('Между'), tr('Промежуток между колонками, px'), 0).el,
          ),
        );
      }
      const color = this.add(
        new ColorField({
          title: tr('Цвет сетки'),
          read: () => {
            const g = read();
            return g ? { color: { ...g.color, a: 1 }, opacity: g.color.a } : null;
          },
          write: (c, opacity) => update((g) => ({ ...g, color: { ...c, a: opacity } }), tr('Цвет сетки')),
        }),
      );
      item.append(color.el);
      body.append(item);
    });
  }

  private buildExport(ids: NodeId[]): void {
    const d = this.editor.doc;
    const settings = () => d.get(this.ids[0]!, 'exportSettings');
    const write = (next: ExportSetting[]) => this.commit(tr('Настройки экспорта'), (tx, id) => tx.set(id, 'exportSettings', next));
    const add = h(
      'button',
      { class: 'icon-button', type: 'button', title: tr('Добавить настройку экспорта'), onclick: () => {
        const list = settings();
        const last = list[list.length - 1];
        // Like Figma: the next row offers the next scale.
        write([...list, last ? { ...last, scale: last.format === 'SVG' || last.format === 'PDF' ? 1 : last.scale + 1, suffix: '' } : DEFAULT_EXPORT]);
      } },
      icon('plus'),
    );
    const body = this.section(tr('Экспорт'), add);
    // Last in the panel: extra room below it (styles.css).
    body.parentElement!.classList.add('export-section');
    const list = settings();
    const runExport = (override?: ExportSetting[]) => this.runExport(override);
    if (list.length === 0) {
      // One button; the format lives in a dropdown next to it (the choice is remembered).
      // PowerPoint is not a picture of a layer: it opens its own window (frames → slides), as before from the toolbar.
      const presets: [string, ExportSetting | null][] = [
        ['PNG 1x', { format: 'PNG', scale: 1, suffix: '' }],
        ['PNG 2x', { format: 'PNG', scale: 2, suffix: '' }],
        ['PNG 3x', { format: 'PNG', scale: 3, suffix: '' }],
        ['JPG 2x', { format: 'JPG', scale: 2, suffix: '' }],
        ['WebP 2x', { format: 'WEBP', scale: 2, suffix: '' }],
        ['SVG', { format: 'SVG', scale: 1, suffix: '' }],
        ['PDF', { format: 'PDF', scale: 2, suffix: '' }],
        ['HTML', { format: 'HTML', scale: 1, suffix: '' }],
        ['PPTX', null],
      ];
      const pick = h('select', { class: 'field-select', 'aria-label': tr('Формат экспорта'), title: tr('Формат') }, ...presets.map(([name]) => h('option', { value: name, selected: name === quickPreset }, name === 'PPTX' ? tr('PowerPoint (PPTX)…') : name)));
      pick.addEventListener('change', () => (quickPreset = pick.value));
      const go = h('button', { class: 'text-button', type: 'button', onclick: () => {
        const setting = (presets.find(([n]) => n === pick.value) ?? presets[1]!)[1];
        if (setting) void runExport([setting]);
        else void import('../pptx/dialog.ts').then(({ PptxExportDialog }) => new PptxExportDialog(this.editor, this.canvas.renderer));
      } }, h('span', {}, tr('Экспортировать')));
      body.append(h('div', { class: 'export-row quick' }, h('div', { class: 'field select-wrap' }, pick), go));
      return;
    }
    list.forEach((setting, index) => {
      const update = (patch: Partial<ExportSetting>) => {
        const next = [...settings()];
        const cur = next[index];
        if (!cur) return;
        next[index] = { ...cur, ...patch };
        write(next);
      };
      const vectorFormat = setting.format === 'SVG' || setting.format === 'PDF';
      // Typed as in Figma: «2x», or a size — «512w» (width), «300h» (height); the list offers the usual ones.
      const listId = `export-scales-${index}`;
      const scale = h('input', { class: 'field-input export-scale', type: 'text', value: exportScaleLabel(setting), list: listId, spellcheck: false, 'aria-label': tr('Масштаб'), title: vectorFormat ? tr('Чёткость картинок внутри PDF') : tr('Масштаб: 2x, или ширина «512w», или высота «300h»') });
      const options = h('datalist', { id: listId }, ...['0.5x', '1x', '1.5x', '2x', '3x', '4x', '512w', '1024w', '2048w', '512h'].map((v) => h('option', { value: v })));
      scale.disabled = setting.format === 'SVG' || setting.format === 'HTML';
      scale.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') scale.blur();
      });
      scale.addEventListener('change', () => {
        const parsed = vectorFormat ? (parseExportScale(scale.value)?.size ? null : parseExportScale(scale.value)) : parseExportScale(scale.value);
        if (!parsed) {
          scale.value = exportScaleLabel(setting);
          this.editor.toast(vectorFormat ? tr('Для PDF — масштаб: 1x, 2x, 3x') : tr('Масштаб: например 2x, ширина 512w или высота 300h'));
          return;
        }
        const { size: _, ...rest } = setting;
        const next = { ...rest, scale: parsed.scale, ...(parsed.size ? { size: parsed.size } : {}) };
        const cur = settings();
        write(cur.map((x, i) => (i === index ? next : x)));
      });
      const format = h('select', { class: 'field-select', 'aria-label': tr('Формат') }, ...(['PNG', 'JPG', 'WEBP', 'SVG', 'PDF', 'HTML'] as const).map((f) => h('option', { value: f, selected: f === setting.format }, f === 'WEBP' ? 'WebP' : f)));
      format.addEventListener('change', () => update({ format: format.value as ExportSetting['format'] }));
      const suffix = h('input', { class: 'field-input export-suffix', type: 'text', placeholder: tr('К имени'), value: setting.suffix, 'aria-label': tr('Добавка к имени файла'), title: tr('Добавляется к имени файла, например «@2x» или «-dark»') });
      suffix.addEventListener('keydown', (e) => e.stopPropagation());
      suffix.addEventListener('change', () => update({ suffix: suffix.value.trim() }));
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить настройку'), onclick: () => write(settings().filter((_, i) => i !== index)) }, icon('minus'));
      body.append(h('div', { class: 'export-row' }, h('div', { class: 'field' }, scale, options), h('div', { class: 'field select-wrap' }, format), h('div', { class: 'field' }, suffix), remove));
      if (setting.format === 'SVG') {
        const check = (label: string, title: string, key: 'svgCurrentColor' | 'svgResponsive' | 'svgOutlineText') => {
          const box = h('input', { type: 'checkbox', checked: !!setting[key] });
          box.addEventListener('change', () => update({ [key]: box.checked || undefined }));
          return h('label', { class: 'checkbox', title }, box, h('span', {}, label));
        };
        body.append(
          h(
            'div',
            { class: 'export-svg' },
            check(tr('Цвет из CSS'), tr('Иконка одного цвета получает цвет окружающего текста (currentColor) — её можно перекрашивать в CSS'), 'svgCurrentColor'),
            check(tr('Без размеров'), tr('Без width и height, только viewBox: картинка растягивается по контейнеру'), 'svgResponsive'),
            check(tr('Текст в кривых'), tr('Буквы становятся контурами: SVG выглядит одинаково везде, даже без шрифта. Нужен файл шрифта — встроенный в файл или Inter'), 'svgOutlineText'),
          ),
        );
      }
    });
    // How the files are named — for the whole file.
    const template = h('input', {
      class: 'field-input',
      type: 'text',
      placeholder: '{name}',
      value: String(d.get(d.rootId, 'exportNameTemplate') ?? ''),
      'aria-label': tr('Имя файлов при экспорте'),
      title: tr('Слова: {name} — имя слоя, {page} — страница, {frame} — фрейм верхнего уровня, {parent} — родитель, {file} — файл, {n} — номер, {date} — дата. «/» создаёт папку в ZIP.'),
    });
    template.addEventListener('keydown', (e) => e.stopPropagation());
    template.addEventListener('change', () => this.editor.commit(tr('Имя файлов при экспорте'), (tx) => tx.set(d.rootId, 'exportNameTemplate', template.value.trim())));
    body.append(this.line(tr('Имя'), template));
    const label = ids.length === 1 ? tr('Экспортировать «{0}»', d.get(ids[0]!, 'name')) : tr('Экспортировать {0} слоя', ids.length);
    body.append(h('button', { class: 'text-button wide', type: 'button', onclick: () => void runExport() }, h('span', {}, label)));
  }

}


export type { Mixed };

/**
 * Why aligning a row or a column changes nothing, along each axis (null — it
 * does change). Across: every layer fills it. Along: the frame hugs its layers
 * (no room left), or a layer takes all the room left — then neither alignment
 * nor «Раздвинуть» moves anything, as in CSS.
 */
export function alignInert(d: Document, id: NodeId): { counter: string | null; main: string | null } {
  const mode = d.get(id, 'layoutMode');
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') return { counter: null, main: null };
  const row = mode === 'HORIZONTAL';
  const fills = (s: Sizing) => s.mode === 'FILL' || s.mode === 'FR';
  const children = d.children(id).filter((c) => d.get(c, 'visible') && d.get(c, 'positioning') === 'AUTO');
  if (children.length === 0) return { counter: null, main: null };
  const across = row ? 'sizingV' : 'sizingH';
  const along = row ? 'sizingH' : 'sizingV';
  const counter = children.every((c) => fills(d.get(c, across)))
    ? row ? tr('Слои растянуты на всю высоту — по вертикали выравнивать нечего.') : tr('Слои растянуты на всю ширину — по горизонтали выравнивать нечего.')
    : null;
  const main = d.get(id, along).mode === 'HUG'
    ? row ? tr('Ширина рамки — по содержимому: свободного места нет, по горизонтали выравнивать и распределять нечего.') : tr('Высота рамки — по содержимому: свободного места нет, по вертикали выравнивать и распределять нечего.')
    : children.some((c) => fills(d.get(c, along)))
      ? row ? tr('Слой заполняет всё свободное место по ширине — распределять нечего.') : tr('Слой заполняет всё свободное место по высоте — распределять нечего.')
      : null;
  return { counter, main };
}

/**
 * How far the layers of an auto layout frame stick out of its fixed size, along
 * each axis (px, 0 — they fit or the frame hugs them): their span plus the
 * padding, less the frame's size. Centred, they stick out on both sides.
 */
export function contentOverflow(d: Document, id: NodeId): { x: number; y: number } {
  if (d.get(id, 'layoutMode') === 'NONE') return { x: 0, y: 0 };
  const children = d.children(id).filter((c) => d.get(c, 'visible') && d.get(c, 'positioning') === 'AUTO');
  if (children.length === 0) return { x: 0, y: 0 };
  const over = (pos: 'x' | 'y', size: 'width' | 'height', sizing: 'sizingH' | 'sizingV', a: 'paddingTop' | 'paddingLeft', b: 'paddingBottom' | 'paddingRight') => {
    if (d.get(id, sizing).mode === 'HUG') return 0;
    const lo = Math.min(...children.map((c) => d.get(c, pos)));
    const hi = Math.max(...children.map((c) => d.get(c, pos) + d.get(c, size)));
    const need = hi - lo + d.get(id, a) + d.get(id, b);
    const n = Math.round(need - d.get(id, size));
    return n >= 1 ? n : 0;
  };
  return { x: over('x', 'width', 'sizingH', 'paddingLeft', 'paddingRight'), y: over('y', 'height', 'sizingV', 'paddingTop', 'paddingBottom') };
}

/** What decides the layout of the paint list: types, number of stops, image mode. */
function paintShape(list: readonly Paint[]): string {
  return list
    .map((p) => (p.type === 'SOLID' ? `S${p.visible ? 1 : 0}` : p.type === 'IMAGE' ? `I${p.scaleMode}${p.visible ? 1 : 0}` : p.type === 'PATTERN' ? `P${p.visible ? 1 : 0}` : `${p.type[9]}${p.stops.length}${p.visible ? 1 : 0}`))
    .join(',');
}

/** Blend modes in Figma's groups (Normal first; Pass through is added for containers). */
function blendChoices(): Choice<BlendMode>[] {
  const sep = CHOICE_SEPARATOR as unknown as Choice<BlendMode>;
  return [
    { value: 'NORMAL', label: tr('Обычный') },
    sep,
    { value: 'DARKEN', label: tr('Затемнение') },
    { value: 'MULTIPLY', label: tr('Умножение') },
    { value: 'PLUS_DARKER', label: tr('Сложение с затемнением') },
    { value: 'COLOR_BURN', label: tr('Затемнение основы') },
    sep,
    { value: 'LIGHTEN', label: tr('Замена светлым') },
    { value: 'SCREEN', label: tr('Экран') },
    { value: 'PLUS_LIGHTER', label: tr('Сложение с осветлением') },
    { value: 'COLOR_DODGE', label: tr('Осветление основы') },
    sep,
    { value: 'OVERLAY', label: tr('Перекрытие') },
    { value: 'SOFT_LIGHT', label: tr('Мягкий свет') },
    { value: 'HARD_LIGHT', label: tr('Жёсткий свет') },
    sep,
    { value: 'DIFFERENCE', label: tr('Разница') },
    { value: 'EXCLUSION', label: tr('Исключение') },
    sep,
    { value: 'HUE', label: tr('Цветовой тон') },
    { value: 'SATURATION', label: tr('Насыщенность') },
    { value: 'COLOR', label: tr('Цветность') },
    { value: 'LUMINOSITY', label: tr('Яркость') },
  ];
}

const MASK_TYPES = [
  { value: 'ALPHA', label: tr('По прозрачности') },
  { value: 'VECTOR', label: tr('По контуру') },
  { value: 'LUMINANCE', label: tr('По яркости') },
] as const;

const NOISE_TYPES = [
  { value: 'GRAIN', label: tr('Зерно') },
  { value: 'MONO', label: tr('Один цвет') },
  { value: 'DUO', label: tr('Два цвета') },
  { value: 'MULTI', label: tr('Много цветов') },
] as const;

const EFFECT_TYPES = [
  { value: 'DROP_SHADOW', label: tr('Тень') },
  { value: 'INNER_SHADOW', label: tr('Внутренняя тень') },
  { value: 'LAYER_BLUR', label: tr('Размытие слоя') },
  { value: 'BACKGROUND_BLUR', label: tr('Размытие фона') },
  { value: 'NOISE', label: tr('Шум') },
  { value: 'TEXTURE', label: tr('Текстура') },
  { value: 'GLASS', label: tr('Стекло') },
] as const;

type EffectType = Effect['type'];

/** How a blur spreads: even, or stronger toward a side (the ends: weak, then strong). */
const BLUR_SHAPES: { value: string; label: string; ends: [{ x: number; y: number }, { x: number; y: number }] | null }[] = [
  { value: 'even', label: tr('Везде одинаково'), ends: null },
  { value: 'top', label: tr('Сильнее к верху'), ends: [{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }] },
  { value: 'bottom', label: tr('Сильнее к низу'), ends: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }] },
  { value: 'left', label: tr('Сильнее влево'), ends: [{ x: 1, y: 0.5 }, { x: 0, y: 0.5 }] },
  { value: 'right', label: tr('Сильнее вправо'), ends: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] },
];

function blurShapeOf(e: Extract<Effect, { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR' }>): string {
  const p = e.progressive;
  if (!p) return 'even';
  const dx = p.to.x - p.from.x;
  const dy = p.to.y - p.from.y;
  return Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
}

function newEffect(type: EffectType): Effect {
  switch (type) {
    case 'DROP_SHADOW':
      return { type, color: rgba(0, 0, 0, 0.25), offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true };
    case 'INNER_SHADOW':
      return { type, color: rgba(0, 0, 0, 0.25), offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true };
    case 'LAYER_BLUR':
      return { type, radius: 4, visible: true };
    case 'BACKGROUND_BLUR':
      return { type, radius: 12, visible: true };
    case 'NOISE':
      return { type, amount: 1, size: 1, visible: true, noiseType: 'MONO', density: 0.5, color: rgba(0, 0, 0, 0.25), secondaryColor: rgba(1, 1, 1, 0.25) };
    case 'TEXTURE':
      return { type, size: 4, radius: 4, clipToShape: false, visible: true };
    case 'GLASS':
      return { type, lightAngle: -45, lightIntensity: 0.5, refraction: 0.6, depth: 20, dispersion: 0.3, frost: 4, splay: 0.3, visible: true };
  }
}

/** Switching the type keeps what still applies (shadow colour and offset, blur radius). */
function convertEffect(effect: Effect, type: EffectType): Effect {
  const next = newEffect(type);
  if ((next.type === 'DROP_SHADOW' || next.type === 'INNER_SHADOW') && (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW')) return { ...effect, type: next.type };
  if ((next.type === 'LAYER_BLUR' || next.type === 'BACKGROUND_BLUR') && 'radius' in effect) return { ...next, radius: effect.radius, visible: effect.visible };
  return { ...next, visible: effect.visible };
}

/** OpenType features shown by name (when the font has them); the last value — on by default in browsers. */
const FEATURES: [string, string, boolean][] = [
  ['tnum', 'Цифры одной ширины (для таблиц)', false],
  ['pnum', 'Пропорциональные цифры', false],
  ['lnum', 'Цифры высотой с заглавные', false],
  ['onum', 'Старостильные цифры', false],
  ['zero', 'Ноль с чертой', false],
  ['frac', 'Дроби (1/2 → ½)', false],
  ['case', 'Знаки под заглавные (скобки, тире)', false],
  ['liga', 'Лигатуры (fi, fl)', true],
  ['calt', 'Контекстные замены', true],
  ['dlig', 'Дополнительные лигатуры', false],
  ['salt', 'Альтернативные знаки', false],
];

/** Names of the registered axes (others show the font's own name). */
const AXIS_NAMES: Record<string, string> = { wdth: 'Ширина', opsz: 'Оптический размер', slnt: 'Наклон', ital: 'Курсив' };

/** Quick section colours: light tints that keep content readable. */
const SECTION_COLORS: readonly [string, readonly [number, number, number]][] = [
  [tr('Белый'), [1, 1, 1]],
  [tr('Серый'), [0.94, 0.94, 0.94]],
  [tr('Красный'), [1, 0.89, 0.88]],
  [tr('Оранжевый'), [1, 0.93, 0.85]],
  [tr('Жёлтый'), [1, 0.97, 0.82]],
  [tr('Зелёный'), [0.88, 0.97, 0.89]],
  [tr('Синий'), [0.87, 0.93, 1]],
  [tr('Фиолетовый'), [0.93, 0.89, 1]],
];

/** Asks how far to move the outline (a negative distance moves it in) and does it. */
export async function askOffset(editor: Editor): Promise<void> {
  const { askText } = await import('./dialog.ts');
  const value = await askText({ title: tr('Сместить контур'), label: tr('Расстояние, px'), value: '4', confirm: tr('Сместить'), hint: tr('Больше нуля — наружу, меньше нуля — внутрь. Углы скругляются.') });
  if (value === null) return;
  const distance = Number(value.replace(',', '.'));
  if (!Number.isFinite(distance) || distance === 0) {
    editor.toast(tr('Введите число, например 4 или −4'));
    return;
  }
  editor.offsetSelection(distance);
}

/** What a layout grid is, in plain words. */
function gridCaption(g: LayoutGrid): string {
  const px = (v: number) => `${round2(v)} px`;
  if (g.pattern === 'GRID') return tr('Квадратная сетка: клетка {0}', px(g.sectionSize));
  const rows = g.pattern === 'ROWS';
  if (g.count === 1 && (g.alignment === 'MIN' || g.alignment === 'MAX')) {
    const edge = rows ? (g.alignment === 'MIN' ? tr('сверху') : tr('снизу')) : g.alignment === 'MIN' ? tr('слева') : tr('справа');
    return g.offset ? tr('Полоса {0} {1}, в {2} от края', px(g.sectionSize), edge, px(g.offset)) : tr('Поле {0}: {1}', edge, px(g.sectionSize));
  }
  const count = g.count || tr('сколько поместится');
  if (g.alignment === 'STRETCH') return rows ? tr('Строк: {0}, промежуток {1}, поля {2}', count, px(g.gutterSize), px(g.offset)) : tr('Колонок: {0}, промежуток {1}, поля {2}', count, px(g.gutterSize), px(g.offset));
  return rows ? tr('Строк: {0} по {1}, промежуток {2}', count, px(g.sectionSize), px(g.gutterSize)) : tr('Колонок: {0} по {1}, промежуток {2}', count, px(g.sectionSize), px(g.gutterSize));
}
