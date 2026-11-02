// Variables table (FR-VAR-010…026): collections on the left, a spreadsheet of
// variables × modes in the middle, details of the active variable on the right.
//
// The table is windowed (only visible rows are in the DOM), so collections with
// tens of thousands of variables stay fast (FR-VAR-014). Keyboard works like a
// spreadsheet: arrows, Tab / Shift+Tab, Enter to edit and to go down, Esc to
// cancel, Shift+arrows for a range, Mod+C / Mod+V copy and paste TSV ranges,
// also from Excel and Google Sheets (FR-VAR-020).

import { tr } from '#core';
import { baseCollection, extensionsOf, fieldSpec, isExtension, isVariable, splitStyleName } from '#components';
import { colorToHex, isAlias, isColorValue, isExpression, type NodeId, type VariableScope, type VariableType } from '#core';
import type { Editor } from '../editor.ts';
import { switchLayout } from '../keyboard.ts';
import { TYPE_NAMES } from '../variables.ts';
import { exportTokens, planImport } from '../tokens.ts';
import { pickFiles } from '../images.ts';
import { openColorPicker } from './color-picker.ts';
import { clear, download, h, icon, sparkles } from './dom.ts';
import { closePopover, popover } from './styles-ui.ts';
import { valuePreview } from './variable-ui.ts';

const ROW_H = 32;
const NAME_W = 240;

const TYPE_ICONS: Record<VariableType, string> = { COLOR: 'opacity', FLOAT: 'gap', STRING: 'text', BOOLEAN: 'eye' };

const SCOPES: Record<VariableType, { value: VariableScope; label: string }[]> = {
  COLOR: [
    { value: 'FRAME_FILL', label: tr('Заливка фреймов') },
    { value: 'SHAPE_FILL', label: tr('Заливка фигур') },
    { value: 'TEXT_FILL', label: tr('Цвет текста') },
    { value: 'STROKE_COLOR', label: tr('Обводка') },
    { value: 'EFFECT_COLOR', label: tr('Цвет теней') },
  ],
  FLOAT: [
    { value: 'WIDTH_HEIGHT', label: tr('Ширина и высота') },
    { value: 'CORNER_RADIUS', label: tr('Скругление') },
    { value: 'GAP', label: tr('Промежутки и отступы') },
    { value: 'OPACITY', label: tr('Непрозрачность') },
    { value: 'STROKE_WIDTH', label: tr('Толщина обводки') },
    { value: 'FONT_SIZE', label: tr('Размер шрифта') },
    { value: 'FONT_WEIGHT', label: tr('Начертание') },
    { value: 'LINE_HEIGHT', label: tr('Межстрочный интервал') },
    { value: 'LETTER_SPACING', label: tr('Межбуквенный интервал') },
    { value: 'PARAGRAPH_SPACING', label: tr('Абзацы') },
  ],
  STRING: [
    { value: 'TEXT_CONTENT', label: tr('Содержимое текста') },
    { value: 'FONT_FAMILY', label: tr('Шрифт') },
  ],
  BOOLEAN: [],
};

const PLATFORMS: { key: string; label: string; example: (name: string) => string }[] = [
  { key: 'WEB', label: 'CSS', example: (n) => `var(--${n.replace(/[/\s.]+/g, '-').toLowerCase()})` },
  { key: 'IOS', label: 'iOS', example: (n) => `Color.${n.replace(/[/\s.-]+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase())}` },
  { key: 'ANDROID', label: 'Android', example: (n) => `R.color.${n.replace(/[/\s.-]+/g, '_').toLowerCase()}` },
];

type Row = { kind: 'group'; path: string; count: number } | { kind: 'var'; id: NodeId };

interface Cell {
  variable: NodeId;
  /** -1 = name column, otherwise mode index. */
  col: number;
}

export class VariablesDialog {
  private readonly editor: Editor;
  private readonly overlay: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly collectionsEl: HTMLElement;
  private readonly groupsEl: HTMLElement;
  private readonly headerRow: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly details: HTMLElement;
  private readonly bulk: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly typeFilter: HTMLSelectElement;
  /** One "Show" filter: by usage or by kind of value (two separate selects were unreadable). */
  private readonly showFilter: HTMLSelectElement;
  private readonly addVariable: HTMLButtonElement;
  private readonly empty: HTMLElement;

  private collection: NodeId | null = null;
  private group: string | null = null;
  private rows: Row[] = [];
  private active: Cell | null = null;
  private anchor: Cell | null = null;
  private selected = new Set<NodeId>();
  private editing: { cell: Cell; input: HTMLInputElement } | null = null;
  private frame = 0;
  private openState = false;
  private detailsFor: string | null = null;
  /** An inline rename (collection, mode) is open: redraws would remove its input. */
  private renaming = false;

  constructor(editor: Editor) {
    this.editor = editor;
    this.search = h('input', { class: 'vars-search', type: 'search', placeholder: tr('Поиск: имя, значение, описание'), spellcheck: false, 'aria-label': tr('Поиск переменных') });
    this.typeFilter = h(
      'select',
      { class: 'field-select', 'aria-label': tr('Тип') },
      h('option', { value: '' }, tr('Все типы')),
      ...(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] as const).map((t) => h('option', { value: t }, TYPE_NAMES[t])),
    );
    this.showFilter = h(
      'select',
      { class: 'field-select', 'aria-label': tr('Показать') },
      h('option', { value: '' }, tr('Все переменные')),
      h('option', { value: 'used' }, tr('Используются в макете')),
      h('option', { value: 'unused' }, tr('Нигде не используются')),
      h('option', { value: 'alias' }, tr('Ссылаются на другие')),
      h('option', { value: 'value' }, tr('Со своим значением')),
    );
    for (const el of [this.search, this.typeFilter, this.showFilter]) el.addEventListener('input', () => this.refresh());
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusTable();
      }
    });
    this.addVariable = h('button', { class: 'text-button primary', type: 'button', onclick: () => this.openAddMenu() }, icon('plus', 14), h('span', {}, tr('Переменная')));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), onclick: () => this.close() }, icon('close'));
    const exportButton = h('button', { class: 'text-button', type: 'button', title: tr('Скачать переменные и стили в формате W3C Design Tokens (JSON)'), onclick: () => this.exportJson() }, h('span', {}, tr('Экспорт')));
    const codeButton = h('button', { class: 'text-button', type: 'button', title: tr('Переменные как код: CSS, SCSS, JS/TS, Tailwind, Swift, Kotlin, Android XML'), onclick: () => void import('./token-code-dialog.ts').then(({ openTokenCode }) => openTokenCode(this.editor, (m) => this.editor.toast(m))) }, h('span', {}, tr('Код')));
    const importButton: HTMLButtonElement = h('button', { class: 'text-button', type: 'button', title: tr('Загрузить токены (W3C Design Tokens JSON) с просмотром изменений'), onclick: () => void this.importJson(importButton) }, h('span', {}, tr('Импорт')));
    const header = h(
      'header',
      { class: 'vars-header' },
      h('h2', {}, tr('Переменные')),
      h('div', { class: 'vars-search-wrap' }, icon('search', 14), this.search),
      h('div', { class: 'field select-wrap' }, this.typeFilter),
      h('div', { class: 'field select-wrap' }, this.showFilter),
      exportButton,
      importButton,
      codeButton,
      this.addVariable,
      close,
    );
    this.collectionsEl = h('div', { class: 'vars-collections' });
    this.groupsEl = h('div', { class: 'vars-groups' });
    const side = h(
      'aside',
      { class: 'vars-side' },
      h('div', { class: 'vars-side-title' }, h('span', {}, tr('Коллекции')), h('button', { class: 'icon-button', type: 'button', title: tr('Новая коллекция'), onclick: () => this.createCollection() }, icon('plus'))),
      this.collectionsEl,
      h('div', { class: 'vars-side-title' }, h('span', {}, tr('Группы'))),
      this.groupsEl,
    );
    this.headerRow = h('div', { class: 'vars-row vars-head', role: 'row' });
    this.spacer = h('div', { class: 'vars-spacer' });
    this.rowsEl = h('div', { class: 'vars-rows', role: 'rowgroup' });
    this.empty = h('div', { class: 'vars-empty', hidden: true });
    this.scroller = h('div', { class: 'vars-scroller', tabindex: 0, role: 'grid', 'aria-label': tr('Таблица переменных') }, this.headerRow, h('div', { class: 'vars-body-rows' }, this.spacer, this.rowsEl), this.empty);
    this.scroller.addEventListener('scroll', () => this.renderRows());
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    this.details = h('aside', { class: 'vars-details' });
    this.bulk = h('div', { class: 'vars-bulk', hidden: true });
    this.dialog = h('div', { class: 'vars-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Переменные') }, header, h('div', { class: 'vars-main' }, side, h('div', { class: 'vars-center' }, this.scroller, this.bulk), this.details));
    this.overlay = h('div', { class: 'vars-overlay', hidden: true }, this.dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.dialog.addEventListener('copy', (e) => this.onCopy(e));
    this.dialog.addEventListener('paste', (e) => this.onPaste(e));
    this.dialog.addEventListener('keydown', (e) => {
      // Undo and redo work while the table is open; other shortcuts stay inside.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.code === 'KeyZ' || e.code === 'KeyY') && !(e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        if (e.code === 'KeyY' || e.shiftKey) editor.redo();
        else editor.undo();
      }
      if (e.key === 'Escape' && !this.editing) this.close();
      e.stopPropagation();
    });
    document.body.append(this.overlay);
    editor.events.on('change', () => {
      if (this.openState) this.schedule();
    });
    editor.events.on('document', () => {
      if (this.openState) this.close();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** Opens the table, optionally at a variable or a collection. */
  open(variable?: NodeId, collection?: NodeId): void {
    const d = this.editor.doc;
    this.openState = true;
    this.overlay.hidden = false;
    if (collection && d.store.isAlive(collection)) {
      this.collection = collection;
      this.group = null;
      this.active = null;
      this.selected.clear();
    }
    if (variable && isVariable(d, variable)) {
      this.collection = d.parent(variable)!;
      this.group = null;
      this.active = { variable, col: 0 };
      this.selected = new Set([variable]);
    }
    if (!this.collection || !d.store.isAlive(this.collection)) this.collection = d.collections()[0] ?? null;
    this.refresh();
    if (this.active) this.scrollTo(this.active.variable);
    this.focusTable();
  }

  close(): void {
    if (!this.openState) return;
    this.stopEditing(false);
    closePopover();
    this.openState = false;
    this.overlay.hidden = true;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.openState && !this.editing && !this.renaming) this.refresh();
    });
  }

  private focusTable(): void {
    this.scroller.focus({ preventScroll: true });
  }

  // ---------- data ----------

  private modes() {
    return this.collection ? this.editor.doc.get(this.collection, 'modes') : [];
  }

  /** The extension being shown (FR-VAR-013), or undefined for an ordinary collection. */
  private scope(): NodeId | undefined {
    const c = this.collection;
    return c && isExtension(this.editor.doc, c) ? c : undefined;
  }

  private visibleVariables(): NodeId[] {
    if (!this.collection) return [];
    const show = this.showFilter.value;
    const list = this.editor.variables.search(this.collection, this.search.value, {
      type: (this.typeFilter.value || null) as VariableType | null,
      used: show === 'used' ? true : show === 'unused' ? false : null,
      alias: show === 'alias' ? true : show === 'value' ? false : null,
    });
    const g = this.group;
    return g === null ? list : list.filter((v) => this.editor.doc.get(v, 'name').startsWith(`${g}/`));
  }

  /** Rows: group headers followed by their variables, in list order. */
  private buildRows(vars: NodeId[]): Row[] {
    const d = this.editor.doc;
    const byGroup = new Map<string, NodeId[]>();
    for (const v of vars) {
      const g = splitStyleName(d.get(v, 'name')).folders.join('/');
      const list = byGroup.get(g);
      if (list) list.push(v);
      else byGroup.set(g, [v]);
    }
    const rows: Row[] = [];
    for (const [path, ids] of byGroup) {
      if (path) rows.push({ kind: 'group', path, count: ids.length });
      for (const id of ids) rows.push({ kind: 'var', id });
    }
    return rows;
  }

  private varRows(): NodeId[] {
    return this.rows.flatMap((r) => (r.kind === 'var' ? [r.id] : []));
  }

  // ---------- rendering ----------

  private refresh(): void {
    const d = this.editor.doc;
    if (!this.collection || !d.store.isAlive(this.collection)) this.collection = d.collections()[0] ?? null;
    if (this.active && !isVariable(d, this.active.variable)) this.active = null;
    for (const v of [...this.selected]) if (!isVariable(d, v)) this.selected.delete(v);
    this.renderCollections();
    this.renderGroups();
    this.rows = this.buildRows(this.visibleVariables());
    this.renderHeader();
    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.renderRows();
    this.renderEmpty();
    this.renderDetails();
    this.renderBulk();
  }

  private renderCollections(): void {
    const d = this.editor.doc;
    clear(this.collectionsEl);
    // Extensions right under what they extend, indented by level.
    const ordered: { c: NodeId; level: number }[] = [];
    const placed = new Set<NodeId>();
    const place = (c: NodeId, level: number) => {
      if (placed.has(c)) return;
      placed.add(c);
      ordered.push({ c, level });
      for (const e of d.collections()) if (d.get(e, 'extendsCollection') === c) place(e, level + 1);
    };
    for (const c of d.collections()) if (!isExtension(d, c)) place(c, 0);
    for (const c of d.collections()) place(c, 0);
    for (const { c, level } of ordered) {
      const extension = isExtension(d, c);
      const count = extension ? Object.keys(d.get(c, 'varOverrides')).filter((v) => isVariable(d, v)).length : d.children(c).length;
      const item = h(
        'div',
        {
          class: `vars-collection${c === this.collection ? ' active' : ''}${extension ? ' extension' : ''}`,
          tabindex: 0,
          style: level > 0 ? `padding-left: ${8 + level * 14}px` : '',
          title: extension
            ? tr('{0}: расширяет «{1}», своих значений у переменных: {2}', d.get(c, 'name'), d.get(d.get(c, 'extendsCollection')!, 'name'), count)
            : tr('{0}: {1} переменных, режимов: {2}', d.get(c, 'name'), count, d.get(c, 'modes').length),
        },
        extension ? h('span', { class: 'vars-ext-mark', 'aria-hidden': 'true' }, '↳') : null,
        h('span', { class: 'vars-collection-name' }, d.get(c, 'name')),
        h('span', { class: 'vars-count' }, String(count)),
      );
      const more = h('button', { class: 'icon-button', type: 'button', title: tr('Действия с коллекцией'), onclick: (e: MouseEvent) => {
        e.stopPropagation();
        this.collectionMenu(more, c);
      } }, icon('menu', 14));
      item.append(more);
      item.addEventListener('click', () => {
        this.collection = c;
        this.group = null;
        this.active = null;
        this.selected.clear();
        this.refresh();
      });
      item.addEventListener('dblclick', () => this.inlineRename(item.querySelector('.vars-collection-name')!, d.get(c, 'name'), (v) => this.editor.variables.renameCollection(c, v)));
      this.collectionsEl.append(item);
    }
    if (d.collections().length === 0) this.collectionsEl.append(h('p', { class: 'hint small' }, tr('Коллекций пока нет.')));
    this.collectionsEl.append(h('button', { class: 'link-button vars-example', type: 'button', title: tr('Коллекция «Тема» с режимами «Светлая» и «Тёмная»'), onclick: () => this.createThemeExample() }, tr('+ Пример: светлая и тёмная тема')));
    if (d.styles().length > 0) {
      this.collectionsEl.append(
        h('button', { class: 'link-button vars-example', type: 'button', title: tr('Значения стилей станут переменными, стили и слои останутся связаны'), onclick: () => void import('./styles-to-variables-dialog.ts').then(({ openStylesToVariables }) => openStylesToVariables(this.editor, (m) => this.editor.toast(m), (c) => this.open(undefined, c))) }, tr('+ Из стилей…')),
      );
    }
  }

  private renderGroups(): void {
    const d = this.editor.doc;
    clear(this.groupsEl);
    if (!this.collection) return;
    const hits = new Set(this.search.value.trim() ? this.visibleVariablesIgnoringGroup() : []);
    const counts = new Map<string, { total: number; hits: number }>();
    const own = this.editor.variables.variablesOf(this.collection);
    for (const v of own) {
      const parts = splitStyleName(d.get(v, 'name')).folders;
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        const c = counts.get(path) ?? { total: 0, hits: 0 };
        c.total++;
        if (hits.has(v)) c.hits++;
        counts.set(path, c);
      }
    }
    const all = h('div', { class: `vars-group${this.group === null ? ' active' : ''}` }, h('span', {}, tr('Все переменные')), h('span', { class: 'vars-count' }, String(own.length)));
    all.addEventListener('click', () => {
      this.group = null;
      this.refresh();
    });
    this.groupsEl.append(all);
    for (const [path, c] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      const depth = path.split('/').length - 1;
      const item = h(
        'div',
        { class: `vars-group${this.group === path ? ' active' : ''}${c.hits > 0 ? ' has-hits' : ''}`, style: { paddingLeft: `${8 + depth * 12}px` }, title: path },
        icon('folder', 12),
        h('span', {}, path.split('/').pop()!),
        h('span', { class: 'vars-count' }, c.hits > 0 ? `${c.hits}/${c.total}` : String(c.total)),
      );
      item.addEventListener('click', () => {
        this.group = path;
        this.refresh();
      });
      this.groupsEl.append(item);
    }
  }

  private visibleVariablesIgnoringGroup(): NodeId[] {
    const g = this.group;
    this.group = null;
    const list = this.visibleVariables();
    this.group = g;
    return list;
  }

  private gridColumns(): string {
    return `${NAME_W}px repeat(${Math.max(1, this.modes().length)}, minmax(150px, 1fr)) 36px`;
  }

  private renderHeader(): void {
    const d = this.editor.doc;
    clear(this.headerRow);
    this.headerRow.style.gridTemplateColumns = this.gridColumns();
    if (!this.collection) return;
    const ext = this.scope();
    this.headerRow.append(
      h(
        'div',
        { class: 'vars-cell vars-head-cell' },
        ext ? h('span', { class: 'vars-ext-note', title: tr('Значения жирным — свои, остальные берутся из «{0}». Переменные и режимы добавляются там.', d.get(d.get(ext, 'extendsCollection')!, 'name')) }, tr('Расширяет «{0}»', d.get(d.get(ext, 'extendsCollection')!, 'name'))) : tr('Имя'),
      ),
    );
    if (ext) {
      // Modes belong to the parent: shown, not edited here.
      for (const m of this.modes()) this.headerRow.append(h('div', { class: 'vars-cell vars-head-cell', title: tr('Режим родительской коллекции') }, h('span', { class: 'vars-mode-name' }, m.name)));
      this.headerRow.append(h('div', { class: 'vars-cell vars-head-cell' }));
      return;
    }
    this.modes().forEach((m, i) => {
      const label = h('span', { class: 'vars-mode-name' }, m.name);
      const cell = h('div', { class: 'vars-cell vars-head-cell', title: i === 0 ? tr('{0} — режим по умолчанию', m.name) : m.name }, label, i === 0 ? h('span', { class: 'vars-default' }, tr('по умолч.')) : null);
      const more = h('button', { class: 'icon-button', type: 'button', title: tr('Действия с режимом'), onclick: (e: MouseEvent) => {
        e.stopPropagation();
        this.modeMenu(more, m.id, i);
      } }, icon('menu', 14));
      cell.append(more);
      cell.addEventListener('dblclick', () => this.inlineRename(label, m.name, (v) => this.editor.variables.renameMode(this.collection!, m.id, v)));
      this.headerRow.append(cell);
    });
    const add = h('button', { class: 'icon-button', type: 'button', title: tr('Добавить режим (например, «Тёмная»)'), onclick: () => {
      const id = this.editor.variables.addMode(this.collection!);
      this.refresh();
      const label = [...this.headerRow.querySelectorAll<HTMLElement>('.vars-mode-name')].pop();
      if (label) this.inlineRename(label, d.get(this.collection!, 'modes').find((m) => m.id === id)?.name ?? '', (v) => this.editor.variables.renameMode(this.collection!, id, v));
    } }, icon('plus'));
    // A colour collection without a dark mode: one with colours worked out (✦, an algorithm, not a guess of a model).
    const darkable = !d.get(this.collection!, 'modes').some((m) => /тёмн|темн|dark|night|ночн/i.test(m.name)) && d.children(this.collection!).some((v) => d.get(v, 'varType') === 'COLOR');
    const dark = darkable
      ? h('button', { class: 'text-button vars-dark', type: 'button', title: tr('Добавить режим «Тёмная»: нейтральные цвета меняют светлоту, акценты чуть светлеют'), onclick: () => void this.addDarkMode() }, sparkles(14), h('span', {}, tr('Тёмная')))
      : '';
    this.headerRow.append(h('div', { class: 'vars-cell vars-head-cell vars-add-mode' }, add, dark));
  }

  private async addDarkMode(): Promise<void> {
    const { createDarkTheme } = await import('../smart-ops.ts');
    const n = createDarkTheme(this.editor, this.collection!, []);
    this.refresh();
    this.editor.toast(tr('Режим «Тёмная»: подобрано цветов — {0}. Это черновик — поправьте цвета прямо в таблице.', n));
  }

  private renderEmpty(): void {
    const d = this.editor.doc;
    clear(this.empty);
    const has = this.rows.length > 0;
    this.empty.hidden = has;
    this.addVariable.disabled = !this.collection || !!this.scope();
    this.addVariable.title = this.scope() ? tr('Переменные добавляются в родительскую коллекцию — расширение получит их само') : '';
    if (has) return;
    if (!this.collection) {
      this.empty.append(
        h('p', {}, tr('Переменных пока нет. Проще всего начать с примера: коллекция «Тема» с режимами «Светлая» и «Тёмная» и пятью цветами.')),
        h(
          'div',
          { class: 'button-row' },
          h('button', { class: 'text-button primary', type: 'button', onclick: () => this.createThemeExample() }, h('span', {}, tr('Создать пример: светлая и тёмная тема'))),
          h('button', { class: 'text-button', type: 'button', onclick: () => this.createCollection() }, icon('plus', 14), h('span', {}, tr('Пустая коллекция'))),
        ),
        h('button', { class: 'link-button', type: 'button', onclick: () => window.dispatchEvent(new CustomEvent('cs-help', { detail: 'variables-theme' })) }, tr('Как пользоваться переменными — пошагово')),
      );
    } else if (this.scope() && d.children(baseCollection(d, this.collection)).length === 0) {
      this.empty.append(h('p', {}, tr('В родительской коллекции пока нет переменных. Добавьте их там — расширение получит их само.')));
    } else if (d.children(this.collection).length === 0 && !this.scope()) {
      this.empty.append(h('p', {}, tr('В коллекции пока нет переменных. Добавьте первую кнопкой «+ Переменная» или вставьте столбец значений из таблицы (⌘V).')));
    } else {
      this.empty.append(h('p', {}, tr('Ничего не найдено. Измените поиск или фильтры.')));
    }
  }

  /** Draws only the rows in view. */
  private renderRows(): void {
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW_H) + 5);
    clear(this.rowsEl);
    this.rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    const columns = this.gridColumns();
    for (let i = first; i < last; i++) {
      const row = this.rows[i]!;
      const el = row.kind === 'group' ? this.groupRow(row) : this.variableRow(row.id);
      el.style.gridTemplateColumns = columns;
      this.rowsEl.append(el);
    }
  }

  private groupRow(row: Extract<Row, { kind: 'group' }>): HTMLElement {
    return h('div', { class: 'vars-row vars-group-row', role: 'row' }, h('div', { class: 'vars-cell' }, icon('folder', 12), h('span', {}, row.path.split('/').join(' / ')), h('span', { class: 'vars-count' }, String(row.count))));
  }

  private variableRow(v: NodeId): HTMLElement {
    const d = this.editor.doc;
    const vars = this.editor.variables;
    const type = d.get(v, 'varType');
    const row = h('div', { class: `vars-row${this.selected.has(v) ? ' selected' : ''}`, role: 'row', dataset: { id: v } });
    const name = splitStyleName(d.get(v, 'name')).name;
    const nameCell = h(
      'div',
      { class: `vars-cell vars-name${this.isActive(v, -1) ? ' active' : ''}${this.inRange(v, -1) ? ' in-range' : ''}`, role: 'gridcell', title: `${d.get(v, 'name')}${d.get(v, 'description') ? `\n${d.get(v, 'description')}` : ''}` },
      h('span', { class: 'vars-type', title: TYPE_NAMES[type] }, icon(TYPE_ICONS[type], 14)),
      h('span', { class: 'vars-name-text' }, name),
      d.get(v, 'hiddenFromPublishing') ? h('span', { class: 'vars-badge', title: tr('Скрыта при публикации') }, tr('скрыта')) : null,
    );
    nameCell.addEventListener('pointerdown', (e) => this.onCellPointer(e, { variable: v, col: -1 }));
    nameCell.addEventListener('dblclick', () => this.startEditing({ variable: v, col: -1 }));
    row.append(nameCell);
    const modes = this.modes();
    const scope = this.scope();
    const values = vars.valuesByMode(v, scope);
    modes.forEach((m, i) => {
      const entry = values[i];
      const raw = entry?.raw;
      // In an extension, values it does not set itself come from the parent: dimmed.
      const inherited = !!scope && entry?.own === false;
      const cell = h('div', { class: `vars-cell vars-value${this.isActive(v, i) ? ' active' : ''}${this.inRange(v, i) ? ' in-range' : ''}${inherited ? ' inherited' : ''}${scope && !inherited ? ' own' : ''}`, role: 'gridcell' });
      if (inherited) cell.title = tr('Из родительской коллекции. Введите значение, чтобы задать своё');
      if (entry?.error !== undefined && raw !== undefined && (isExpression(raw) || isAlias(raw))) {
        // An expression's mistake is shown in the cell itself (FR-VAR-003).
        cell.classList.add('error');
        cell.append(h('span', { class: 'vars-fx', 'aria-hidden': 'true' }, 'ƒ'), h('span', { class: 'vars-error-text', title: `${vars.formatValue(v, m.id, scope)}\n${entry.error}` }, entry.error));
      } else if (raw !== undefined && isExpression(raw)) {
        const text = vars.expressionText(raw.expr);
        cell.append(
          h(
            'span',
            { class: 'vars-alias vars-expr', title: tr('Выражение: {0}\nРезультат: {1}', text, entry?.value !== undefined ? formatResult(entry.value) : '—') },
            type === 'COLOR' ? valuePreview(entry?.value) : null,
            h('span', { class: 'vars-fx', 'aria-hidden': 'true' }, 'ƒ'),
            h('span', { class: 'vars-expr-result' }, entry?.value !== undefined ? formatResult(entry.value) : '—'),
            h('span', { class: 'vars-muted vars-expr-text' }, text),
          ),
        );
      } else if (raw !== undefined && isAlias(raw)) {
        const target = isVariable(d, raw.id) ? d.get(raw.id, 'name') : tr('нет переменной');
        cell.append(
          h(
            'span',
            { class: 'vars-alias', title: tr('Ссылка на «{0}»{1}. Значение: {2}', target, raw.opacity !== undefined ? tr(' с непрозрачностью {0}%', Math.round(raw.opacity * 100)) : '', entry?.value !== undefined ? formatResult(entry.value) : '—') },
            type === 'COLOR' ? valuePreview(entry?.value) : null,
            h('span', {}, target.split('/').pop()!),
            raw.opacity !== undefined ? h('span', { class: 'vars-alias-opacity' }, `${Math.round(raw.opacity * 100)}%`) : null,
          ),
        );
      } else if (type === 'BOOLEAN') {
        const box = h('input', { type: 'checkbox', checked: raw === true, 'aria-label': `${name}: ${m.name}`, tabindex: -1 });
        box.addEventListener('change', () => vars.setValue(v, m.id, box.checked, scope));
        cell.append(box, h('span', { class: 'vars-muted' }, raw === true ? 'true' : 'false'));
      } else if (type === 'COLOR') {
        const value = entry?.value;
        // Our colour picker (with opacity and an eyedropper), not the browser's system window.
        const swatch = h('button', { class: 'vars-color-input', type: 'button', tabindex: -1, title: tr('Выбрать цвет'), 'aria-label': tr('{0}: {1} — выбрать цвет', name, m.name) });
        swatch.addEventListener('pointerdown', (e) => e.stopPropagation());
        swatch.addEventListener('click', () => {
          const start = isColorValue(value) ? value : { r: 1, g: 1, b: 1, a: 1 };
          openColorPicker({
            anchor: swatch,
            color: { ...start, a: 1 },
            opacity: start.a,
            onChange: (c, opacity) => vars.setValue(v, m.id, { ...c, a: opacity }, scope),
          });
        });
        cell.append(h('span', { class: 'vars-swatch-wrap' }, valuePreview(value), swatch), h('span', { class: 'vars-text' }, value !== undefined ? vars.formatValue(v, m.id, scope).replace(/^#/, '') : '—'));
      } else {
        cell.append(h('span', { class: 'vars-text' }, raw === undefined ? '—' : vars.formatValue(v, m.id, scope)));
      }
      cell.addEventListener('pointerdown', (e) => this.onCellPointer(e, { variable: v, col: i }));
      cell.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        this.startEditing({ variable: v, col: i });
      });
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.setActive({ variable: v, col: i }, false);
        // The row was redrawn: anchor the menu to the new cell.
        this.cellMenu(this.cellElement({ variable: v, col: i }) ?? this.scroller, v, m.id);
      });
      row.append(cell);
    });
    row.append(h('div', { class: 'vars-cell' }));
    return row;
  }

  private isActive(v: NodeId, col: number): boolean {
    return this.active?.variable === v && this.active.col === col;
  }

  /** Whether a cell is inside the anchor–active rectangle. */
  private inRange(v: NodeId, col: number): boolean {
    if (!this.active || !this.anchor || (this.active.variable === this.anchor.variable && this.active.col === this.anchor.col)) return false;
    const list = this.varRows();
    const r1 = list.indexOf(this.anchor.variable);
    const r2 = list.indexOf(this.active.variable);
    const r = list.indexOf(v);
    const [c1, c2] = [Math.min(this.anchor.col, this.active.col), Math.max(this.anchor.col, this.active.col)];
    return r >= Math.min(r1, r2) && r <= Math.max(r1, r2) && col >= c1 && col <= c2;
  }

  // ---------- selection and keyboard ----------

  private onCellPointer(e: PointerEvent, cell: Cell): void {
    if (e.button !== 0) return;
    // Rows are redrawn on selection: keep the focus on the grid, not on a removed cell.
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    if (this.editing && (this.editing.cell.variable !== cell.variable || this.editing.cell.col !== cell.col)) this.stopEditing(true);
    const mod = e.metaKey || e.ctrlKey;
    if (cell.col === -1) {
      // Row selection for bulk actions (FR-VAR-022).
      if (e.shiftKey && this.active) {
        const list = this.varRows();
        const a = list.indexOf(this.anchor?.variable ?? this.active.variable);
        const b = list.indexOf(cell.variable);
        this.selected = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
        this.active = cell;
        this.redrawSelection();
        this.focusTable();
        return;
      }
      if (mod) {
        if (this.selected.has(cell.variable)) this.selected.delete(cell.variable);
        else this.selected.add(cell.variable);
        this.active = cell;
        this.anchor = cell;
        this.redrawSelection();
        this.focusTable();
        return;
      }
    }
    this.setActive(cell, e.shiftKey);
    this.focusTable();
  }

  private setActive(cell: Cell, extend: boolean): void {
    this.active = cell;
    if (!extend || !this.anchor) this.anchor = cell;
    if (!extend) this.selected = new Set([cell.variable]);
    this.redrawSelection();
    this.scrollTo(cell.variable);
  }

  private redrawSelection(): void {
    this.renderRows();
    this.renderDetails();
    this.renderBulk();
  }

  private scrollTo(v: NodeId): void {
    const index = this.rows.findIndex((r) => r.kind === 'var' && r.id === v);
    if (index < 0) return;
    const top = index * ROW_H;
    const view = this.scroller.clientHeight - ROW_H; // minus the sticky header
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_H > this.scroller.scrollTop + view) this.scroller.scrollTop = top + ROW_H - view;
    this.renderRows();
  }

  private move(dr: number, dc: number, extend: boolean): void {
    const list = this.varRows();
    if (list.length === 0) return;
    const cur = this.active ?? { variable: list[0]!, col: 0 };
    let r = Math.max(0, list.indexOf(cur.variable));
    let c = cur.col + dc;
    const cols = this.modes().length;
    if (c >= cols) {
      c = -1;
      r++;
    } else if (c < -1) {
      c = cols - 1;
      r--;
    }
    r = Math.max(0, Math.min(list.length - 1, r + dr));
    this.setActive({ variable: list[r]!, col: c }, extend);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing) return;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        this.move(e.key === 'ArrowDown' ? 1 : -1, 0, e.shiftKey);
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        if (this.active) this.setActive({ variable: this.active.variable, col: Math.max(-1, Math.min(this.modes().length - 1, this.active.col + (e.key === 'ArrowRight' ? 1 : -1))) }, e.shiftKey);
        else this.move(0, 0, false);
        return;
      case 'Tab':
        e.preventDefault();
        this.move(0, e.shiftKey ? -1 : 1, false);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (this.active) this.startEditing(this.active);
        return;
      case 'Delete':
      case 'Backspace':
        if (this.active?.col === -1 || this.selected.size > 1) {
          e.preventDefault();
          this.deleteSelected();
        }
        return;
      case 'a':
      case 'A':
        if (mod) {
          e.preventDefault();
          this.selected = new Set(this.varRows());
          this.redrawSelection();
        }
        return;
    }
    // Typing starts editing with the typed character (spreadsheet behaviour).
    if (!mod && !e.altKey && e.key.length === 1 && this.active) {
      e.preventDefault();
      const type = this.editor.doc.get(this.active.variable, 'varType');
      if (type === 'BOOLEAN' && this.active.col >= 0 && e.key === ' ') {
        const mode = this.modes()[this.active.col]!;
        this.editor.variables.setValue(this.active.variable, mode.id, this.editor.doc.get(this.active.variable, 'varValues')[mode.id] !== true);
        return;
      }
      this.startEditing(this.active, e.key);
    }
  }

  // ---------- editing ----------

  private cellElement(cell: Cell): HTMLElement | null {
    const row = this.rowsEl.querySelector<HTMLElement>(`.vars-row[data-id="${CSS.escape(cell.variable)}"]`);
    return (row?.children[cell.col + 1] as HTMLElement | undefined) ?? null;
  }

  private startEditing(cell: Cell, initial?: string): void {
    const d = this.editor.doc;
    const vars = this.editor.variables;
    this.stopEditing(true);
    this.setActive(cell, false);
    const el = this.cellElement(cell);
    if (!el) return;
    const mode = cell.col >= 0 ? this.modes()[cell.col] : null;
    const type = d.get(cell.variable, 'varType');
    const scope = this.scope();
    if (type === 'BOOLEAN' && mode && initial === undefined && !isExpression(vars.rawOf(cell.variable, mode.id, scope))) {
      vars.setValue(cell.variable, mode.id, vars.rawOf(cell.variable, mode.id, scope) !== true, scope);
      return;
    }
    const current = mode ? vars.formatValue(cell.variable, mode.id, scope) : d.get(cell.variable, 'name');
    const input = h('input', { class: 'vars-input', type: 'text', spellcheck: false, value: initial ?? current, 'aria-label': mode ? tr('Значение: {0}', mode.name) : tr('Имя переменной') });
    input.title = mode ? tr('Значение, ссылка {имя} (для цвета {имя} @ 60%) или выражение: = {имя} * 2, lighten({имя}, 10%), {условие} ? 8 : 12') : tr('Полное имя; «/» — группы');
    clear(el);
    el.classList.add('editing');
    el.append(input);
    input.focus();
    if (initial === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
    this.editing = { cell, input };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.stopEditing(true)) this.move(e.shiftKey ? -1 : 1, 0, false);
        this.focusTable();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (this.stopEditing(true)) this.move(0, e.shiftKey ? -1 : 1, false);
        this.focusTable();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.stopEditing(false);
        this.focusTable();
      }
    });
    input.addEventListener('blur', () => {
      if (this.editing?.input === input) this.stopEditing(true);
    });
  }

  /** Ends editing; returns false (and keeps editing) when the value is invalid. */
  private stopEditing(commit: boolean): boolean {
    const editing = this.editing;
    if (!editing) return true;
    const d = this.editor.doc;
    const vars = this.editor.variables;
    const { cell, input } = editing;
    if (commit && isVariable(d, cell.variable)) {
      const text = input.value;
      if (cell.col === -1) {
        if (text.trim() && text.trim() !== d.get(cell.variable, 'name') && !vars.renameVariable(cell.variable, text)) {
          input.classList.add('invalid');
          return false;
        }
      } else {
        const mode = this.modes()[cell.col];
        const scope = this.scope();
        if (mode && text !== vars.formatValue(cell.variable, mode.id, scope)) {
          const parsed = vars.parseInput(d.get(cell.variable, 'varType'), text, this.collection ?? undefined);
          if (parsed === null) {
            input.classList.add('invalid');
            this.editor.toast(vars.parseError || tr('Не похоже на значение типа «{0}»', TYPE_NAMES[d.get(cell.variable, 'varType')]), 'error');
            return false;
          }
          if (!vars.setValue(cell.variable, mode.id, parsed, scope)) {
            input.classList.add('invalid');
            return false;
          }
        }
      }
    }
    this.editing = null;
    this.refresh();
    return true;
  }

  // ---------- clipboard (FR-VAR-020) ----------

  private rangeCells(): { variables: NodeId[]; modes: string[] } | null {
    if (!this.active) return null;
    const list = this.varRows();
    const a = this.anchor ?? this.active;
    const r1 = list.indexOf(a.variable);
    const r2 = list.indexOf(this.active.variable);
    const c1 = Math.max(0, Math.min(a.col, this.active.col));
    const c2 = Math.max(0, Math.max(a.col, this.active.col));
    return { variables: list.slice(Math.min(r1, r2), Math.max(r1, r2) + 1), modes: this.modes().slice(c1, c2 + 1).map((m) => m.id) };
  }

  private onCopy(e: ClipboardEvent): void {
    if (this.editing || (e.target instanceof HTMLInputElement && e.target.type === 'text') || e.target instanceof HTMLTextAreaElement) return;
    const range = this.rangeCells();
    if (!range) return;
    e.preventDefault();
    const text = this.active?.col === -1 && this.anchor?.col === -1 ? range.variables.map((v) => this.editor.doc.get(v, 'name')).join('\n') : this.editor.variables.copyTable(range.variables, range.modes, this.scope());
    e.clipboardData?.setData('text/plain', text);
    this.editor.toast(tr('Скопировано'));
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.editing || (e.target instanceof HTMLInputElement && e.target.type === 'text') || e.target instanceof HTMLTextAreaElement) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text || !this.collection) return;
    e.preventDefault();
    const start = this.active?.variable ?? null;
    const col = Math.max(0, this.active?.col ?? 0);
    const n = this.editor.variables.pasteTable(this.collection, start, col, text);
    this.editor.toast(n > 0 ? tr('Вставлено значений: {0}', n) : tr('Нечего вставить: значения не подошли к типам переменных'));
  }

  // ---------- tokens (FR-VAR-040) ----------

  private exportJson(): void {
    const d = this.editor.doc;
    const json = exportTokens(d);
    const name = (d.get(d.rootId, 'name') || 'tokens').replace(/[\\/:*?"<>|]+/g, '_');
    download(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `${name}.tokens.json`);
  }

  private async importJson(anchor: HTMLElement): Promise<void> {
    const [file] = await pickFiles('.json,application/json');
    if (!file) return;
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      this.editor.toast(tr('Файл не читается как JSON'), 'error');
      return;
    }
    const plan = planImport(this.editor, json);
    const added = plan.changes.filter((c) => c.added);
    const changed = plan.changes.filter((c) => !c.added);
    const list = h('div', { class: 'vars-import-list' });
    const group = (title: string, items: typeof plan.changes) => {
      if (items.length === 0) return;
      list.append(h('div', { class: 'vars-subtitle' }, `${title}: ${items.length}`));
      for (const c of items.slice(0, 150)) list.append(h('div', { class: `vars-import-item ${c.added ? 'added' : 'changed'}` }, c.added ? '+ ' : '~ ', c.label));
      if (items.length > 150) list.append(h('div', { class: 'vars-muted' }, tr('…и ещё {0}', items.length - 150)));
    };
    group(tr('Добавится'), added);
    group(tr('Обновится'), changed);
    if (plan.warnings.length > 0) {
      list.append(h('div', { class: 'vars-subtitle' }, tr('Предупреждения: {0}', plan.warnings.length)));
      for (const w of plan.warnings.slice(0, 50)) list.append(h('div', { class: 'vars-import-item warning' }, w));
    }
    if (plan.changes.length === 0 && plan.warnings.length === 0) list.append(h('p', { class: 'hint' }, tr('В файле нет переменных и стилей.')));
    let close = () => {};
    const apply = h('button', { class: 'text-button primary', type: 'button', disabled: plan.changes.length === 0 }, tr('Применить'));
    apply.addEventListener('click', () => {
      close();
      plan.apply();
      this.editor.toast(tr('Импортировано: добавлено {0}, обновлено {1}. Отменить — ⌘Z', added.length, changed.length));
      this.collection = null;
      this.refresh();
    });
    const cancel = h('button', { class: 'text-button', type: 'button' }, tr('Отмена'));
    cancel.addEventListener('click', () => close());
    const box = h('div', { class: 'vars-import' }, h('h3', {}, tr('Импорт «{0}»', file.name)), list, h('div', { class: 'button-row' }, cancel, apply));
    close = popover(anchor, box, 440);
  }

  // ---------- menus ----------

  private openAddMenu(): void {
    if (!this.collection) return;
    const list = h('div', { class: 'style-menu', role: 'menu' });
    let close = () => {};
    for (const t of ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] as const) {
      const b = h('button', { class: 'style-menu-item', type: 'button', role: 'menuitem' }, icon(TYPE_ICONS[t], 14), h('span', {}, TYPE_NAMES[t]));
      b.addEventListener('click', () => {
        close();
        const after = this.active?.variable;
        const prefix = this.group ? `${this.group}/` : after ? splitStyleName(this.editor.doc.get(after, 'name')).folders.map((f) => `${f}/`).join('') : '';
        const id = this.editor.variables.createVariable(this.collection!, t, `${prefix}${TYPE_NAMES[t]}`, undefined, after ? { after } : { at: 'end' });
        this.refresh();
        this.scrollTo(id);
        this.startEditing({ variable: id, col: -1 });
      });
      list.append(b);
    }
    close = popover(this.addVariable, list, 200);
  }

  private collectionMenu(anchor: HTMLElement, c: NodeId): void {
    const d = this.editor.doc;
    const list = h('div', { class: 'style-menu', role: 'menu' });
    let close = () => {};
    const action = (label: string, run: () => void) => {
      const b = h('button', { class: 'style-menu-item', type: 'button' }, label);
      b.addEventListener('click', () => {
        close();
        run();
      });
      list.append(b);
    };
    action(tr('Переименовать'), () => {
      const el = [...this.collectionsEl.querySelectorAll<HTMLElement>('.vars-collection')].find((x) => x.querySelector('.vars-collection-name')?.textContent === d.get(c, 'name'))?.querySelector<HTMLElement>('.vars-collection-name');
      if (el) this.inlineRename(el, d.get(c, 'name'), (v) => this.editor.variables.renameCollection(c, v));
    });
    action(tr('Расширить коллекцию…'), () => {
      const id = this.editor.variables.createExtension(c);
      this.collection = id;
      this.group = null;
      this.active = null;
      this.selected.clear();
      this.refresh();
      this.editor.toast(tr('Расширение создано: в нём все переменные «{0}». Введите свои значения там, где они должны отличаться', d.get(c, 'name')));
    });
    const extensions = extensionsOf(d, c).length;
    action(
      isExtension(d, c)
        ? tr('Удалить расширение{0}', extensions > 0 ? tr(' (и вложенные: {0})', extensions) : '')
        : tr('Удалить коллекцию ({0}){1}', d.children(c).length, extensions > 0 ? tr(' и расширения ({0})', extensions) : ''),
      () => this.editor.variables.deleteCollection(c),
    );
    close = popover(anchor, list, 260);
  }

  private modeMenu(anchor: HTMLElement, mode: string, index: number): void {
    const c = this.collection!;
    const d = this.editor.doc;
    const list = h('div', { class: 'style-menu', role: 'menu' });
    let close = () => {};
    const action = (label: string, run: () => void, disabled = false) => {
      const b = h('button', { class: 'style-menu-item', type: 'button', disabled }, label);
      b.addEventListener('click', () => {
        close();
        run();
      });
      list.append(b);
    };
    const modes = d.get(c, 'modes');
    action(tr('Переименовать'), () => {
      const label = this.headerRow.querySelectorAll<HTMLElement>('.vars-mode-name')[index];
      if (label) this.inlineRename(label, modes[index]!.name, (v) => this.editor.variables.renameMode(c, mode, v));
    });
    action(tr('Сделать режимом по умолчанию'), () => this.editor.variables.setDefaultMode(c, mode), index === 0);
    action(tr('Сдвинуть влево'), () => this.editor.variables.moveMode(c, mode, index - 1), index === 0);
    action(tr('Сдвинуть вправо'), () => this.editor.variables.moveMode(c, mode, index + 1), index === modes.length - 1);
    action(tr('Удалить режим'), () => this.editor.variables.deleteMode(c, mode), modes.length <= 1);
    close = popover(anchor, list, 240);
  }

  /** Cell menu: alias to another variable or back to a plain value (FR-VAR-001). */
  private cellMenu(anchor: HTMLElement, v: NodeId, mode: string): void {
    const d = this.editor.doc;
    const vars = this.editor.variables;
    const type = d.get(v, 'varType');
    const scope = this.scope();
    const raw = vars.rawOf(v, mode, scope);
    const box = h('div', { class: 'style-picker' });
    let close = () => {};
    if (raw !== undefined && (isAlias(raw) || isExpression(raw))) {
      const plain = h('button', { class: 'style-menu-item', type: 'button' }, isExpression(raw) ? tr('Заменить выражение результатом') : tr('Заменить ссылку значением'));
      plain.addEventListener('click', () => {
        close();
        const value = vars.valuesByMode(v, scope).find((x) => x.mode === mode)?.value;
        if (value !== undefined) vars.setValue(v, mode, value, scope);
      });
      box.append(plain);
    }
    if (scope && vars.valuesByMode(v, scope).find((x) => x.mode === mode)?.own) {
      const reset = h('button', { class: 'style-menu-item', type: 'button' }, tr('Вернуть значение из «{0}»', d.get(d.get(scope, 'extendsCollection')!, 'name')));
      reset.addEventListener('click', () => {
        close();
        vars.resetOverride(scope, [v], mode);
      });
      box.append(reset);
    }
    const search = h('input', { class: 'font-search', type: 'search', placeholder: tr('Сослаться на переменную…'), spellcheck: false });
    const list = h('div', { class: 'style-list' });
    const render = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      const alt = switchLayout(q);
      const options = d
        .collections()
        .flatMap((c) => d.children(c).map((o) => ({ o, c })))
        .filter(({ o }) => o !== v && d.get(o, 'varType') === type && !vars.dependsOn(o).includes(v))
        .filter(({ o, c }) => !q || `${d.get(c, 'name')}/${d.get(o, 'name')}`.toLowerCase().includes(q) || `${d.get(c, 'name')}/${d.get(o, 'name')}`.toLowerCase().includes(alt));
      if (options.length === 0) list.append(h('p', { class: 'hint' }, tr('Нет переменных того же типа')));
      for (const { o, c } of options.slice(0, 200)) {
        const item = h('div', { class: 'style-item' }, icon('variable', 14), h('span', { class: 'style-name' }, `${c === this.collection ? '' : `${d.get(c, 'name')} / `}${d.get(o, 'name')}`), valuePreview(vars.previewValue(o, [])));
        item.addEventListener('click', () => {
          close();
          vars.setValue(v, mode, { type: 'ALIAS', id: o }, scope);
        });
        list.append(item);
      }
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => e.stopPropagation());
    box.append(h('div', { class: 'font-search-wrap' }, icon('search', 14), search), list);
    render();
    close = popover(anchor, box, 300);
    search.focus();
  }

  private inlineRename(el: HTMLElement, value: string, commit: (v: string) => void): void {
    const input = h('input', { class: 'vars-input', type: 'text', value, spellcheck: false });
    el.replaceWith(input);
    input.focus();
    input.select();
    this.renaming = true;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.renaming = false;
      if (save && input.value.trim() && input.value.trim() !== value) commit(input.value);
      this.refresh();
      this.focusTable();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private createThemeExample(): void {
    this.collection = this.editor.variables.createThemeExample();
    this.group = null;
    this.refresh();
    this.editor.toast(tr('Готово. Теперь привяжите цвета слоёв к переменным (шестиугольник в поле цвета) и переключите режим у экрана — подробнее в справке.'));
  }

  private createCollection(): void {
    const id = this.editor.variables.createCollection();
    this.collection = id;
    this.group = null;
    this.refresh();
    const el = [...this.collectionsEl.querySelectorAll<HTMLElement>('.vars-collection.active .vars-collection-name')][0];
    if (el) this.inlineRename(el, this.editor.doc.get(id, 'name'), (v) => this.editor.variables.renameCollection(id, v));
  }

  // ---------- bulk actions (FR-VAR-022) ----------

  private renderBulk(): void {
    const d = this.editor.doc;
    const vars = this.editor.variables;
    const ids = [...this.selected].filter((v) => isVariable(d, v));
    clear(this.bulk);
    this.bulk.hidden = ids.length < 2;
    if (ids.length < 2) return;
    const ext = this.scope();
    if (ext) {
      // In an extension the variables are the parent's: only its own values can go.
      const reset = h('button', { class: 'text-button', type: 'button', onclick: () => vars.resetOverride(ext, ids, null) }, tr('Вернуть значения родителя'));
      this.bulk.append(h('span', { class: 'vars-bulk-count' }, tr('Выбрано: {0}', ids.length)), reset);
      return;
    }
    const usages = ids.reduce((n, v) => n + vars.usages(v).direct.length, 0);
    const rename = h('button', { class: 'text-button', type: 'button' }, tr('Переименовать…'));
    rename.addEventListener('click', () => {
      const find = h('input', { class: 'field-input', type: 'text', placeholder: tr('Найти (или /regexp/)') });
      const replace = h('input', { class: 'field-input', type: 'text', placeholder: tr('Заменить на ($1 — группа)') });
      const go = h('button', { class: 'text-button primary', type: 'button' }, tr('Переименовать'));
      const box = h('div', { class: 'vars-form' }, h('div', { class: 'field text-field' }, find), h('div', { class: 'field text-field' }, replace), go);
      for (const i of [find, replace]) i.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go.click();
      });
      let close = () => {};
      go.addEventListener('click', () => {
        if (!find.value) return;
        close();
        const n = vars.renameByPattern(ids, find.value, replace.value);
        this.editor.toast(tr('Переименовано: {0}', n));
      });
      close = popover(rename, box, 280);
      find.focus();
    });
    const group = h('button', { class: 'text-button', type: 'button' }, tr('В группу…'));
    group.addEventListener('click', () => {
      const input = h('input', { class: 'field-input', type: 'text', placeholder: tr('Группа, например color/brand (пусто — без группы)') });
      const go = h('button', { class: 'text-button primary', type: 'button' }, tr('Переместить'));
      const box = h('div', { class: 'vars-form' }, h('div', { class: 'field text-field' }, input), go);
      let close = () => {};
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go.click();
      });
      go.addEventListener('click', () => {
        close();
        vars.moveToGroup(ids, input.value);
      });
      close = popover(group, box, 300);
      input.focus();
    });
    const types = new Set(ids.map((v) => d.get(v, 'varType')));
    const scope = h('button', { class: 'text-button', type: 'button', disabled: types.size !== 1 }, tr('Область…'));
    scope.title = types.size !== 1 ? tr('Выберите переменные одного типа') : '';
    scope.addEventListener('click', () => {
      const type = [...types][0]!;
      const box = this.scopeEditor(type, d.get(ids[0]!, 'scopes'), (next) => vars.setScopes(ids, next));
      popover(scope, box, 260);
    });
    const remove = h('button', { class: 'text-button danger', type: 'button' }, tr('Удалить{0}', usages > 0 ? tr(' (используются: {0})', usages) : ''));
    remove.addEventListener('click', () => this.deleteSelected());
    this.bulk.append(h('span', { class: 'vars-bulk-count' }, tr('Выбрано: {0}', ids.length)), rename, group, scope, remove);
  }

  private deleteSelected(): void {
    // The variables of an extension belong to its parent.
    if (this.scope()) return;
    const ids = [...this.selected].filter((v) => isVariable(this.editor.doc, v));
    if (ids.length === 0 && this.active) ids.push(this.active.variable);
    if (ids.length === 0) return;
    const usages = ids.reduce((n, v) => n + this.editor.variables.usages(v).direct.length, 0);
    this.editor.variables.deleteVariables(ids);
    this.selected.clear();
    this.active = null;
    this.editor.toast(tr('Удалено переменных: {0}{1}. Отменить — ⌘Z', ids.length, usages > 0 ? tr('; {0} привязок отвязаны, значения сохранены', usages) : ''));
  }

  private scopeEditor(type: VariableType, current: readonly VariableScope[], write: (next: VariableScope[]) => void): HTMLElement {
    const options = SCOPES[type];
    const box = h('div', { class: 'vars-scopes' });
    if (options.length === 0) {
      box.append(h('p', { class: 'hint small' }, tr('Логические переменные предлагаются для видимости слоёв.')));
      return box;
    }
    const all = h('input', { type: 'checkbox', checked: current.length === 0 });
    box.append(h('label', { class: 'checkbox' }, all, h('span', {}, tr('Везде, где подходит тип'))));
    const boxes = options.map((o) => {
      const cb = h('input', { type: 'checkbox', checked: current.length === 0 || current.includes(o.value) });
      box.append(h('label', { class: 'checkbox indent' }, cb, h('span', {}, o.label)));
      return { cb, value: o.value };
    });
    const emit = () => {
      const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.value);
      write(chosen.length === options.length ? [] : chosen);
    };
    all.addEventListener('change', () => {
      for (const b of boxes) b.cb.checked = all.checked;
      emit();
    });
    for (const b of boxes) b.cb.addEventListener('change', () => {
      all.checked = boxes.every((x) => x.cb.checked);
      emit();
    });
    return box;
  }

  // ---------- details (FR-VAR-023…025) ----------

  private renderDetails(): void {
    const d = this.editor.doc;
    const vars = this.editor.variables;
    const v = this.active?.variable;
    const key = v && isVariable(d, v) ? `${v}:${JSON.stringify(d.store.record(v)?.props)}` : '';
    // Do not rebuild under the user's typing.
    if (key === this.detailsFor && this.details.contains(document.activeElement)) return;
    this.detailsFor = key;
    clear(this.details);
    if (!v || !isVariable(d, v)) {
      this.details.append(h('p', { class: 'hint small' }, tr('Выберите переменную, чтобы увидеть описание, область применения, имена в коде, где она используется и от чего зависит.')));
      return;
    }
    const type = d.get(v, 'varType');
    const section = (title: string, ...children: (HTMLElement | null)[]) => h('section', { class: 'vars-detail-section' }, h('h3', {}, title), ...children);
    const nameInput = h('input', { class: 'field-input', type: 'text', value: d.get(v, 'name'), spellcheck: false, 'aria-label': tr('Имя') });
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
    });
    nameInput.addEventListener('change', () => {
      if (!vars.renameVariable(v, nameInput.value)) nameInput.value = d.get(v, 'name');
    });
    const desc = h('textarea', { class: 'field-input vars-textarea', rows: 2, placeholder: tr('Где и как использовать'), 'aria-label': tr('Описание') }, d.get(v, 'description'));
    desc.addEventListener('keydown', (e) => e.stopPropagation());
    desc.addEventListener('change', () => vars.setDetails(v, { description: desc.value }));
    this.details.append(
      section(tr('Переменная'), h('div', { class: 'field text-field' }, nameInput), h('div', { class: 'vars-meta' }, icon(TYPE_ICONS[type], 14), TYPE_NAMES[type]), desc),
    );
    if (SCOPES[type].length > 0) this.details.append(section(tr('Где предлагать'), this.scopeEditor(type, d.get(v, 'scopes'), (next) => vars.setDetails(v, { scopes: next }))));
    const syntax = d.get(v, 'codeSyntax');
    const code = h('div', { class: 'vars-code' });
    for (const p of PLATFORMS) {
      const input = h('input', { class: 'field-input', type: 'text', value: syntax[p.key] ?? '', placeholder: p.example(d.get(v, 'name')), spellcheck: false, 'aria-label': p.label });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        const next = { ...d.get(v, 'codeSyntax') };
        if (input.value.trim()) next[p.key] = input.value.trim();
        else delete next[p.key];
        vars.setDetails(v, { codeSyntax: next });
      });
      code.append(h('label', { class: 'field text-field' }, h('span', { class: 'field-label' }, p.label), input));
    }
    // Any other platform: existing keys, plus a row to add one (FR-VAR-023).
    const known = new Set(PLATFORMS.map((p) => p.key));
    for (const [k, val] of Object.entries(syntax).filter(([k]) => !known.has(k))) {
      const input = h('input', { class: 'field-input', type: 'text', value: val, spellcheck: false, 'aria-label': k });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        const next = { ...d.get(v, 'codeSyntax') };
        if (input.value.trim()) next[k] = input.value.trim();
        else delete next[k];
        vars.setDetails(v, { codeSyntax: next });
      });
      code.append(h('label', { class: 'field text-field' }, h('span', { class: 'field-label', title: k }, k), input));
    }
    const newKey = h('input', { class: 'field-input', type: 'text', placeholder: tr('Платформа'), spellcheck: false, 'aria-label': tr('Своя платформа') });
    const newVal = h('input', { class: 'field-input', type: 'text', placeholder: tr('Имя в коде'), spellcheck: false, 'aria-label': tr('Имя для своей платформы') });
    const addPlatform = () => {
      const k = newKey.value.trim();
      const val = newVal.value.trim();
      if (!k || !val) return;
      vars.setDetails(v, { codeSyntax: { ...d.get(v, 'codeSyntax'), [k]: val } });
    };
    for (const i of [newKey, newVal]) i.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') addPlatform();
    });
    newVal.addEventListener('change', addPlatform);
    code.append(h('div', { class: 'grid-2' }, h('div', { class: 'field text-field' }, newKey), h('div', { class: 'field text-field' }, newVal)));
    const hidden = h('input', { type: 'checkbox', checked: d.get(v, 'hiddenFromPublishing') });
    hidden.addEventListener('change', () => vars.setDetails(v, { hiddenFromPublishing: hidden.checked }));
    this.details.append(section(tr('Имена в коде'), code, h('label', { class: 'checkbox' }, hidden, h('span', {}, tr('Скрыть при публикации')))));

    // Where used (FR-VAR-024).
    const usages = vars.usages(v);
    const usedBox = h('div', { class: 'vars-usages' });
    const all = [...usages.direct.map((u) => ({ ...u, through: null as NodeId | null })), ...usages.viaAlias];
    if (all.length === 0) usedBox.append(h('p', { class: 'hint small' }, tr('Нигде не используется.')));
    for (const u of all.slice(0, 100)) {
      const isStyle = d.type(u.id) === 'STYLE';
      const page = d.pageOf(u.id);
      const item = h(
        'button',
        { class: 'vars-usage', type: 'button', title: isStyle ? tr('Стиль') : tr('Страница «{0}»', page ? d.get(page, 'name') : '') },
        icon(isStyle ? 'styles' : 'rectangle', 12),
        h('span', { class: 'vars-usage-name' }, d.get(u.id, 'name')),
        h('span', { class: 'vars-muted' }, `${fieldSpec(u.field)?.label ?? u.field}${u.through ? tr(' · через {0}', d.get(u.through, 'name')) : ''}`),
      );
      item.addEventListener('click', () => {
        if (isStyle) return;
        this.close();
        vars.selectUsers([u.id]);
      });
      usedBox.append(item);
    }
    if (all.length > 100) usedBox.append(h('p', { class: 'hint small' }, tr('…и ещё {0}', all.length - 100)));
    const layers = all.filter((u) => d.type(u.id) !== 'STYLE').map((u) => u.id);
    const selectAll = layers.length > 1 ? h('button', { class: 'text-button', type: 'button', onclick: () => { this.close(); vars.selectUsers(layers); } }, tr('Выделить все слои ({0})', new Set(layers).size)) : null;
    this.details.append(section(tr('Где используется ({0})', all.length), usedBox, selectAll));

    // Alias graph (FR-VAR-025).
    const chain = vars.dependsOn(v);
    const dependents = vars.dependents(v);
    const link = (id: NodeId) => {
      const b = h('button', { class: 'vars-usage', type: 'button' }, icon('variable', 12), h('span', { class: 'vars-usage-name' }, `${d.parent(id) !== this.collection ? `${d.get(d.parent(id)!, 'name')} / ` : ''}${d.get(id, 'name')}`));
      b.addEventListener('click', () => this.open(id));
      return b;
    };
    this.details.append(
      section(
        tr('Зависимости'),
        h('div', { class: 'vars-subtitle' }, tr('Зависит от')),
        chain.length > 0 ? h('div', { class: 'vars-chain' }, ...chain.map(link)) : h('p', { class: 'hint small' }, tr('Только собственные значения.')),
        h('div', { class: 'vars-subtitle' }, tr('От неё зависят')),
        dependents.length > 0 ? h('div', { class: 'vars-chain' }, ...dependents.map(link)) : h('p', { class: 'hint small' }, tr('Ничего.')),
      ),
    );
    const ext = this.scope();
    if (ext) {
      const own = vars.valuesByMode(v, ext).filter((x) => x.own).length;
      const reset = h('button', { class: 'text-button', type: 'button', disabled: own === 0, onclick: () => vars.resetOverride(ext, [v], null) }, tr('Вернуть значения родителя'));
      this.details.append(section(tr('В расширении'), h('p', { class: 'hint small' }, own > 0 ? tr('Своих значений: {0} из {1}', own, this.modes().length) : tr('Все значения из «{0}»', d.get(d.get(ext, 'extendsCollection')!, 'name'))), reset));
      return;
    }
    const dup = h('button', { class: 'text-button', type: 'button', onclick: () => this.open(vars.duplicateVariable(v)) }, tr('Дублировать'));
    const del = h('button', { class: 'text-button danger', type: 'button', onclick: () => this.deleteSelected() }, tr('Удалить'));
    this.details.append(h('div', { class: 'button-row' }, dup, del));
  }
}

/** A computed value as the table shows it. */
function formatResult(v: unknown): string {
  if (isColorValue(v)) return colorToHex(v, v.a < 1);
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
