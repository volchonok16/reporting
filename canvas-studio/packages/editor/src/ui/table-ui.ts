// Tables in the interface (FEAT-167): the «Таблица» window — rows × columns picked by
// pointing at a grid, as in Word and Google Docs — the «Таблица» section of the right
// panel and the context menu's table items, for the table the selection is in.

import { tr, type Color, type NodeId, type Paint } from '#core';
import type { Editor } from '../editor.ts';
import { addColumn, addRow, alignCellsV, blankRows, cellAlignV, cellPlace, cellRect, cellsOfSelection, cellTexts, insertTable, mergeCells, removeColumn, removeRow, setHeader, styleCellTexts, tableMerges, tableOf, tableShape, unmergeCell, type CellAlignV } from '../tables.ts';
import type { MenuItem } from './context-menu.ts';
import { openDialog } from './dialog.ts';
import { h, icon } from './dom.ts';
import { ColorField, MIXED, type Field, type Mixed } from './fields.ts';

const PICK_COLS = 10;
const PICK_ROWS = 8;
const KEY = 'cs-table-header';

/** Opens the window; a click on the grid (or «Вставить») puts an empty table in. */
export async function openTableDialog(editor: Editor): Promise<void> {
  if (editor.doc.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  let rows = 4;
  let cols = 3;
  let header = true;
  try {
    header = localStorage.getItem(KEY) !== '0';
  } catch {
    // the default: with a header row
  }
  const label = h('span', { class: 'tb-size' });
  const squares: HTMLElement[] = [];
  const mark = (r: number, c: number) => {
    squares.forEach((sq, i) => sq.classList.toggle('on', Math.floor(i / PICK_COLS) < r && i % PICK_COLS < c));
    label.textContent = tr('{0} × {1}: строк × столбцов', r, c);
  };
  const rowsInput = h('input', { class: 'dialog-input', type: 'number', min: '1', max: '200', value: String(rows), 'aria-label': tr('Строк') }) as HTMLInputElement;
  const colsInput = h('input', { class: 'dialog-input', type: 'number', min: '1', max: '50', value: String(cols), 'aria-label': tr('Столбцов') }) as HTMLInputElement;
  const sync = () => {
    rows = Math.max(1, Math.min(200, Math.round(Number(rowsInput.value)) || 1));
    cols = Math.max(1, Math.min(50, Math.round(Number(colsInput.value)) || 1));
    mark(Math.min(rows, PICK_ROWS), Math.min(cols, PICK_COLS));
  };
  rowsInput.addEventListener('input', sync);
  colsInput.addEventListener('input', sync);
  const grid = h('div', { class: 'tb-pick', role: 'grid', 'aria-label': tr('Размер таблицы') });
  for (let r = 1; r <= PICK_ROWS; r++) {
    for (let c = 1; c <= PICK_COLS; c++) {
      const sq = h('button', { class: 'tb-cell', type: 'button', 'aria-label': tr('{0} × {1}: строк × столбцов', r, c) });
      sq.addEventListener('pointerenter', () => mark(r, c));
      sq.addEventListener('focus', () => mark(r, c));
      sq.addEventListener('click', () => {
        rowsInput.value = String(r);
        colsInput.value = String(c);
        sync();
        grid.closest('form')?.requestSubmit();
      });
      squares.push(sq);
      grid.append(sq);
    }
  }
  grid.addEventListener('pointerleave', () => mark(Math.min(rows, PICK_ROWS), Math.min(cols, PICK_COLS)));
  const headerBox = h('input', { type: 'checkbox', checked: header }) as HTMLInputElement;
  headerBox.addEventListener('change', () => (header = headerBox.checked));
  mark(rows, cols);
  const ok = await openDialog({
    title: tr('Таблица'),
    confirm: tr('Вставить'),
    cancel: tr('Отмена'),
    body: [
      grid,
      label,
      h('div', { class: 'gen-row' }, h('label', { class: 'dialog-field' }, h('span', {}, tr('Строк')), rowsInput), h('label', { class: 'dialog-field' }, h('span', {}, tr('Столбцов')), colsInput)),
      h('label', { class: 'dialog-check' }, headerBox, h('span', {}, tr('Первая строка — заголовок'))),
      h('p', { class: 'dialog-hint' }, tr('Таблицу из Excel, Google Таблиц или Numbers можно просто вставить: скопируйте ячейки и нажмите ⌘V на холсте.')),
    ],
    focus: () => squares[(Math.min(rows, PICK_ROWS) - 1) * PICK_COLS + Math.min(cols, PICK_COLS) - 1]!,
  });
  if (!ok) return;
  try {
    localStorage.setItem(KEY, header ? '1' : '0');
  } catch {
    // not remembered
  }
  insertTable(editor, blankRows(rows, cols, header), { header });
}

/** The table the selection is in, and the selected cell's row and column (none — the table itself). */
function target(editor: Editor, ids: readonly NodeId[]): { table: NodeId; row: number | null; col: number | null } | null {
  const d = editor.doc;
  if (ids.length === 0) return null;
  const table = tableOf(d, ids[0]!);
  if (!table || ids.some((id) => tableOf(d, id) !== table)) return null;
  const place = cellPlace(d, ids[0]!);
  return { table, row: place?.row ?? null, col: place?.col ?? null };
}

/** What merging can do for the selection: cells to merge into one, or a merged cell to split. */
export function mergeActions(editor: Editor, ids: readonly NodeId[]): { merge: (() => void) | null; split: (() => void) | null } {
  const d = editor.doc;
  const rect = cellRect(d, ids);
  const merge = rect && (rect.r1 > rect.r0 || rect.c1 > rect.c0) ? () => void mergeCells(editor, rect.table, rect.r0, rect.c0, rect.r1, rect.c1) : null;
  const place = ids.length === 1 ? cellPlace(d, ids[0]!) : null;
  const merged = place ? tableMerges(d, place.table).find((m) => m.row === place.row && m.col === place.col) : null;
  const split = place && merged ? () => unmergeCell(editor, place.table, merged.cell) : null;
  // One merged cell selected: «merge» would change nothing.
  return { merge: merged && rect && rect.r1 - rect.r0 + 1 === merged.rows && rect.c1 - rect.c0 + 1 === merged.cols ? null : merge, split };
}

/** The «Таблица» section of the right panel, when the selection is in a table. */
export function buildTableSection(editor: Editor, section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: readonly NodeId[]): void {
  const t = target(editor, ids);
  if (!t) return;
  const d = editor.doc;
  const { rows, cols } = tableShape(d, t.table);
  const ro = d.readOnly;
  const body = section(tr('Таблица'));
  const button = (iconName: string, label: string, run: () => void, disabled = false) =>
    h('button', { class: 'text-button tb-action', type: 'button', disabled: ro || disabled, onclick: run }, icon(iconName, 14), h('span', {}, label));
  // Without a cell picked, rows go to the bottom and columns to the right.
  const row = t.row ?? rows - 1;
  const col = t.col ?? cols - 1;
  const header = h('input', { type: 'checkbox', checked: !!d.get(t.table, 'table')?.header, disabled: ro }) as HTMLInputElement;
  header.addEventListener('change', () => setHeader(editor, t.table, header.checked));
  body.append(
    h('p', { class: 'tb-info' }, tr('{0} × {1}: строк × столбцов', rows, cols), t.row !== null ? h('span', {}, ' · ', tr('ячейка {0}:{1}', t.row + 1, t.col! + 1)) : null),
    h(
      'div',
      { class: 'tb-actions' },
      button('plus', tr('Строка выше'), () => addRow(editor, t.table, row)),
      button('plus', tr('Строка ниже'), () => addRow(editor, t.table, row + 1)),
      button('plus', tr('Столбец слева'), () => addColumn(editor, t.table, col)),
      button('plus', tr('Столбец справа'), () => addColumn(editor, t.table, col + 1)),
      button('minus', tr('Удалить строку'), () => removeRow(editor, t.table, row), rows <= 1),
      button('minus', tr('Удалить столбец'), () => removeColumn(editor, t.table, col), cols <= 1),
    ),
    h('label', { class: 'slide-check' }, header, h('span', {}, tr('Первая строка — заголовок'))),
  );
  // Merging is always in sight (FEAT-170): unavailable, the buttons say what to select.
  const { merge, split } = mergeActions(editor, ids);
  const mergeButton = button('merge', tr('Объединить'), () => merge?.(), !merge);
  const splitButton = button('split', tr('Разъединить'), () => split?.(), !split);
  if (!merge) mergeButton.title = tr('Выделите несколько соседних ячеек: Shift+щелчок, протяните мышью или нажмите на ручку строки (столбца)');
  if (!split) splitButton.title = tr('Выделите объединённую ячейку');
  body.append(
    h('div', { class: 'tb-actions' }, mergeButton, splitButton),
    h('p', { class: 'tb-info' }, tr('Несколько ячеек — Shift+щелчок или протяните мышью; строку или столбец — ручкой слева или сверху от таблицы. Ширину столбца и высоту строки меняйте, потянув за линию между ними.')),
  );
}

const solid = (paints: readonly Paint[]): { color: Color; opacity: number } | null => {
  const p = [...paints].reverse().find((x) => x.visible && x.type === 'SOLID');
  return p && p.type === 'SOLID' ? { color: p.color, opacity: p.opacity } : null;
};

/**
 * «Текст в ячейках» (FEAT-170): the colour, weight and alignment of the texts of the
 * selected cells (or of the whole selected table), in one step for all of them.
 */
export function buildCellTextSection(editor: Editor, section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: readonly NodeId[], add: <F extends Field>(f: F) => F): void {
  const d = editor.doc;
  const cells = cellsOfSelection(d, ids);
  if (cells.length === 0) return;
  const texts = () => cellTexts(d, cells).filter((t) => d.store.isAlive(t));
  const body = section(cells.length === 1 ? tr('Текст в ячейке') : tr('Текст в ячейках'));
  const color = add(
    new ColorField({
      title: tr('Цвет текста'),
      read: (): Mixed<{ color: Color; opacity: number }> | null => {
        const all = texts().map((t) => solid(d.get(t, 'fills')));
        const first = all[0];
        if (!first) return null;
        return all.every((c) => c && c.opacity === first.opacity && c.color.r === first.color.r && c.color.g === first.color.g && c.color.b === first.color.b) ? first : MIXED;
      },
      write: (c, opacity) => styleCellTexts(editor, cells, { fills: [{ type: 'SOLID', color: { ...c, a: 1 }, opacity, visible: true }] }, tr('Цвет текста')),
    }),
  );
  const ro = d.readOnly;
  const toggles: { b: HTMLButtonElement; on: () => boolean }[] = [];
  const toggle = (content: Node | string, label: string, on: () => boolean, run: () => void) => {
    const b = h('button', { class: 'icon-button tb-toggle', type: 'button', title: label, 'aria-label': label, disabled: ro, onclick: run }, content);
    toggles.push({ b, on });
    return b;
  };
  const bold = () => texts().length > 0 && texts().every((t) => d.get(t, 'fontWeight') >= 600);
  const alignH = (v: 'LEFT' | 'CENTER' | 'RIGHT') => texts().length > 0 && texts().every((t) => d.get(t, 'textAlignH') === v);
  const alignV = (v: CellAlignV) => cells.every((c) => cellAlignV(d, c) === v);
  const row = h(
    'div',
    { class: 'tb-format' },
    toggle(h('b', {}, 'B'), tr('Жирный'), bold, () => styleCellTexts(editor, cells, { fontWeight: bold() ? 400 : 700 }, tr('Жирный'))),
    h('span', { class: 'tb-sep' }),
    ...(['LEFT', 'CENTER', 'RIGHT'] as const).map((v) =>
      toggle(icon(v === 'LEFT' ? 'textLeft' : v === 'CENTER' ? 'textCenter' : 'textRight', 16), v === 'LEFT' ? tr('Текст по левому краю') : v === 'CENTER' ? tr('Текст по центру') : tr('Текст по правому краю'), () => alignH(v), () => styleCellTexts(editor, cells, { textAlignH: v }, tr('Выравнивание текста'))),
    ),
    h('span', { class: 'tb-sep' }),
    ...(['MIN', 'CENTER', 'MAX'] as const).map((v) =>
      toggle(icon(v === 'MIN' ? 'alignTop' : v === 'CENTER' ? 'alignVCenter' : 'alignBottom', 16), v === 'MIN' ? tr('Текст сверху ячейки') : v === 'CENTER' ? tr('Текст посередине ячейки') : tr('Текст снизу ячейки'), () => alignV(v), () => alignCellsV(editor, cells, v)),
    ),
  );
  add({
    el: row,
    refresh: () => {
      for (const t of toggles) t.b.classList.toggle('on', t.on());
    },
  }).refresh();
  body.append(color.el, row);
}

/** The context menu's «Таблица» submenu, when the selection is in a table. */
export function tableMenuItems(editor: Editor, ids: readonly NodeId[]): MenuItem[] {
  const t = target(editor, ids);
  if (!t) return [];
  const { rows, cols } = tableShape(editor.doc, t.table);
  const row = t.row ?? rows - 1;
  const col = t.col ?? cols - 1;
  const ro = editor.doc.readOnly;
  return [
    {
      kind: 'submenu',
      label: tr('Таблица'),
      items: [
        { kind: 'action', label: tr('Строка выше'), disabled: ro, run: () => addRow(editor, t.table, row) },
        { kind: 'action', label: tr('Строка ниже'), disabled: ro, run: () => addRow(editor, t.table, row + 1) },
        { kind: 'action', label: tr('Столбец слева'), disabled: ro, run: () => addColumn(editor, t.table, col) },
        { kind: 'action', label: tr('Столбец справа'), disabled: ro, run: () => addColumn(editor, t.table, col + 1) },
        { kind: 'separator' },
        { kind: 'action', label: tr('Удалить строку'), disabled: ro || rows <= 1, run: () => removeRow(editor, t.table, row) },
        { kind: 'action', label: tr('Удалить столбец'), disabled: ro || cols <= 1, run: () => removeColumn(editor, t.table, col) },
        ...(() => {
          const { merge, split } = mergeActions(editor, ids);
          const items: MenuItem[] = [];
          if (merge) items.push({ kind: 'action', label: tr('Объединить ячейки'), disabled: ro, run: merge });
          if (split) items.push({ kind: 'action', label: tr('Разъединить'), disabled: ro, run: split });
          return items.length ? [{ kind: 'separator' } as MenuItem, ...items] : [];
        })(),
        { kind: 'separator' },
        { kind: 'action', label: tr('Выделить таблицу'), run: () => editor.setSelection([t.table]) },
      ],
    },
    { kind: 'separator' },
  ];
}
