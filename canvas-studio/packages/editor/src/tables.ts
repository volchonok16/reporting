// Tables (FEAT-167): made directly or pasted from Excel, Google Sheets, Numbers or
// Word. A table is a grid frame (`table` set) whose cells are frames with a text,
// placed row by row; its 1 px gaps and padding show its own fill as the lines. Rows
// grow with their texts, columns share the width and stretch with the table. In a
// presentation the colours and the font follow the theme (bound to its styles).

import { hexToColor, solid, tr, type Document, type NodeId, type NodeProps, type Paint, type Transaction } from '#core';
import type { Point } from '#geometry';
import type { Editor } from './editor.ts';
import { currentTheme, isSlides, slideSize, themeStyles, typeScale } from './slides.ts';
import { freeSpotOnBoard } from './board.ts';

/** Rows of cell texts, every row as long as the longest. */
export type TableRows = string[][];

// ---------- the clipboard ----------

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The text of a cell's HTML: line breaks and paragraphs kept, tags dropped, spaces as in a browser. */
function cellText(html: string): string {
  const flat = html
    .replace(/<!--[\s\S]*?-->/g, '')
    // Line breaks in the source are spaces, as in a browser; <br> and paragraph ends are the real ones.
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(flat)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

/** The first table of an HTML fragment (Excel, Google Sheets, Word, a web page); merged cells take empty places after them. */
function htmlRows(html: string): TableRows | null {
  const table = /<table[\s>][\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table) return null;
  const rows: TableRows = [];
  for (const tr of table.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? []) {
    const row: string[] = [];
    for (const m of tr.matchAll(/<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
      row.push(cellText(m[3] ?? ''));
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2] ?? '')?.[1] ?? 1);
      for (let i = 1; i < Math.min(span, 50); i++) row.push('');
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? rows : null;
}

/** Tab-separated text (what spreadsheets put as plain text): quoted cells may hold tabs, line breaks and "". */
function tsvRows(text: string): TableRows {
  const rows: TableRows = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atStart = true;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === '\t') {
      row.push(cell);
      cell = '';
      atStart = true;
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atStart = true;
    } else {
      cell += c;
      atStart = false;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows padded to one length; empty rows at the end and empty columns on the right dropped. */
function tidy(rows: TableRows): TableRows {
  const out = rows.map((r) => r.map((c) => c.trim()));
  while (out.length && out[out.length - 1]!.every((c) => !c)) out.pop();
  let cols = Math.max(0, ...out.map((r) => r.length));
  while (cols > 0 && out.every((r) => !r[cols - 1])) cols--;
  return out.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
}

/**
 * A table on the clipboard, or null: an HTML table of two cells or more, or plain text with
 * tabs (one cell copied from a spreadsheet stays plain text). Up to 200 × 50 cells.
 */
export function tableFromClipboard(html: string | null, text: string | null): TableRows | null {
  const fromHtml = html ? htmlRows(html) : null;
  let rows = fromHtml ? tidy(fromHtml) : null;
  if (!rows || rows.length * (rows[0]?.length ?? 0) < 2) {
    rows = text && text.includes('\t') ? tidy(tsvRows(text)) : null;
  }
  if (!rows || rows.length === 0 || rows[0]!.length === 0 || rows.length * rows[0]!.length < 2) return null;
  return rows.slice(0, 200).map((r) => r.slice(0, 50));
}

// ---------- the look ----------

interface Look {
  font: string;
  size: number;
  text: Paint;
  textStyle: string | null;
  cell: Paint;
  cellStyle: string | null;
  header: Paint;
  headerStyle: string | null;
  line: Paint;
  lineStyle: string | null;
  padX: number;
  padY: number;
}

const grey = (hex: string) => solid(hexToColor(hex)!);

/** How a table of this file looks: the theme's in a presentation, a quiet neutral one elsewhere. */
function lookOf(doc: Document, tx: Transaction, page: NodeId): Look {
  if (isSlides(doc)) {
    const theme = currentTheme(doc);
    const k = typeScale(slideSize(doc, page));
    const s = themeStyles(doc, tx, theme, k);
    return {
      font: theme.body,
      size: Math.round(26 * k),
      text: grey(theme.text),
      textStyle: s.color.text,
      cell: grey(theme.bg),
      cellStyle: s.color.bg,
      header: grey(theme.surface),
      headerStyle: s.color.surface,
      line: { ...grey(theme.muted), opacity: 0.35 },
      lineStyle: null,
      padX: Math.round(24 * k),
      padY: Math.round(14 * k),
    };
  }
  return { font: 'Inter', size: 14, text: grey('#1F2329'), textStyle: null, cell: grey('#FFFFFF'), cellStyle: null, header: grey('#F2F3F5'), headerStyle: null, line: grey('#D9DCE1'), lineStyle: null, padX: 12, padY: 8 };
}

/** Builds one cell (a frame with its text) in the table at `position`. */
function makeCell(tx: Transaction, table: NodeId, look: Look, text: string, header: boolean, position?: { before: NodeId } | { at: 'end' }): NodeId {
  const cell = tx.create(
    'FRAME',
    table,
    {
      name: tr('Ячейка'),
      layoutMode: 'VERTICAL',
      paddingTop: look.padY,
      paddingBottom: look.padY,
      paddingLeft: look.padX,
      paddingRight: look.padX,
      sizingH: { mode: 'FILL' },
      sizingV: { mode: 'FILL' },
      clipsContent: false,
      fills: [header ? look.header : look.cell],
      fillStyleId: header ? look.headerStyle : look.cellStyle,
    },
    position ?? { at: 'end' },
  );
  tx.create('TEXT', cell, {
    name: tr('Текст'),
    characters: text,
    fontFamily: look.font,
    fontSize: look.size,
    fontWeight: header ? 600 : 400,
    lineHeight: { unit: 'PERCENT', value: 135 },
    fills: [look.text],
    fillStyleId: look.textStyle,
    textAutoResize: 'HEIGHT',
    sizingH: { mode: 'FILL' },
    width: 100,
  });
  return cell;
}

const tracks = (n: number, kind: 'FR' | 'HUG') => Array.from({ length: n }, () => (kind === 'FR' ? { kind: 'FR' as const, value: 1 } : { kind: 'HUG' as const }));

// ---------- making one ----------

/**
 * Puts a table on the canvas: into the selected frame (a slide on show too) or in the
 * middle of the view; `at` — where (world) its middle goes. Selects it; returns it.
 */
export function insertTable(editor: Editor, rows: TableRows, options: { header?: boolean; at?: Point } = {}): NodeId | null {
  const d = editor.doc;
  if (d.readOnly || rows.length === 0 || rows[0]!.length === 0) return null;
  const header = options.header ?? true;
  const cols = rows[0]!.length;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  const stage = editor.slideStage?.current() ?? null;
  let parent: NodeId;
  let centre: Point;
  if (options.at) {
    centre = options.at;
    parent = editor.containerAt(centre);
  } else if (stage) {
    const b = editor.scene.bounds(stage);
    centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    parent = stage;
  } else if (only && d.type(only) === 'FRAME' && editor.acceptsChildren(only) && !tableOf(d, only)) {
    const b = editor.scene.bounds(only);
    centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    parent = only;
  } else {
    centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    parent = editor.containerAt(centre);
  }
  // Never into another table (its grid would take the new one as a cell): beside it, in the table's own parent.
  for (let t = tableOf(d, parent); t; t = tableOf(d, parent)) parent = d.parent(t) ?? editor.pageId;
  // A slide takes three quarters of its width; elsewhere about 160 px a column.
  const room = parent !== editor.pageId && d.type(parent) === 'FRAME' ? d.get(parent, 'width') : null;
  const width = Math.round(isSlides(d) && room ? room * 0.75 : Math.min(960, Math.max(320, cols * 160)));
  let local = editor.toParentSpace(parent, centre);
  let id: NodeId | null = null;
  editor.commit(
    tr('Таблица'),
    (tx) => {
      const look = lookOf(d, tx, editor.pageId);
      const height = rows.length * (look.size * 1.35 + look.padY * 2);
      // On a board, beside what is there rather than over it (FEAT-181).
      if (editor.isBoardFile() && parent === editor.pageId && !options.at) {
        const spot = freeSpotOnBoard(editor, centre, width, height);
        local = { x: spot.x + width / 2, y: spot.y + height / 2 };
      }
      id = tx.create('FRAME', parent, {
        name: tr('Таблица'),
        table: { header },
        layoutMode: 'GRID',
        gridColumns: tracks(cols, 'FR'),
        gridRows: tracks(rows.length, 'HUG'),
        gridColumnGap: 1,
        gridRowGap: 1,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width,
        height: 100,
        sizingH: { mode: 'FIXED' },
        sizingV: { mode: 'HUG' },
        x: Math.round(local.x - width / 2),
        y: Math.round(local.y - height / 2),
        fills: [look.line],
        fillStyleId: look.lineStyle,
        clipsContent: true,
        ...(d.get(parent, 'layoutMode') !== 'NONE' ? { positioning: 'ABSOLUTE' as const } : {}),
      });
      rows.forEach((row, r) => row.forEach((text) => makeCell(tx, id!, look, text, header && r === 0)));
    },
    () => (id ? [id] : []),
  );
  if (id) editor.appear([id]);
  return id;
}

/**
 * A table's frame without cells, columns in shares of `widths` (FEAT-168: the PowerPoint
 * import builds its tables with it, then adds the cells row by row with `bareCell`).
 */
export function tableFrame(tx: Transaction, parent: NodeId, o: { name: string; x: number; y: number; widths: number[]; rows: number; line: Paint }): NodeId {
  const width = o.widths.reduce((a, v) => a + v, 0) + o.widths.length + 1;
  return tx.create('FRAME', parent, {
    name: o.name,
    table: { header: false },
    layoutMode: 'GRID',
    gridColumns: o.widths.map((w) => ({ kind: 'FR' as const, value: Math.max(1, Math.round(w * 100) / 100) })),
    gridRows: tracks(o.rows, 'HUG'),
    gridColumnGap: 1,
    gridRowGap: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    x: Math.round(o.x),
    y: Math.round(o.y),
    width: Math.round(width),
    height: 100,
    sizingH: { mode: 'FIXED' },
    sizingV: { mode: 'HUG' },
    fills: [o.line],
    clipsContent: true,
  });
}

/** A cell of `tableFrame`: its fill, spans and least height; hidden when a merged cell covers its place. Its text goes in after. */
export function bareCell(tx: Transaction, table: NodeId, o: { fill: Paint; colSpan: number; rowSpan: number; minHeight: number; hidden: boolean; padX: number; padY: number }): NodeId {
  return tx.create('FRAME', table, {
    name: tr('Ячейка'),
    layoutMode: 'VERTICAL',
    paddingTop: o.padY,
    paddingBottom: o.padY,
    paddingLeft: o.padX,
    paddingRight: o.padX,
    sizingH: { mode: 'FILL' },
    sizingV: { mode: 'FILL' },
    minHeight: o.minHeight > 0 ? { unit: 'PX', value: Math.round(o.minHeight) } : null,
    gridColumnSpan: Math.max(1, o.colSpan),
    gridRowSpan: Math.max(1, o.rowSpan),
    visible: !o.hidden,
    clipsContent: false,
    fills: [o.fill],
  });
}

/** An empty table of `rows` × `cols`; the header row has column names. */
export function blankRows(rows: number, cols: number, header: boolean): TableRows {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (header && r === 0 ? tr('Столбец {0}', c + 1) : '')));
}

// ---------- finding one's way ----------

/** The table a layer is in (or is), or null. */
export function tableOf(doc: Document, id: NodeId): NodeId | null {
  let at: NodeId | null = id;
  while (at && doc.store.isAlive(at)) {
    if (doc.type(at) === 'FRAME' && doc.get(at, 'table')) return at;
    at = doc.parent(at);
  }
  return null;
}

export interface TableShape {
  table: NodeId;
  rows: number;
  cols: number;
  /** Cells row by row. */
  cells: NodeId[];
}

export function tableShape(doc: Document, table: NodeId): TableShape {
  const cells = [...doc.children(table)];
  const cols = Math.max(1, doc.get(table, 'gridColumns').length);
  return { table, rows: Math.ceil(cells.length / cols), cols, cells };
}

/** The row and column of the cell a layer is in (null — the table itself or outside). */
export function cellPlace(doc: Document, id: NodeId): { table: NodeId; row: number; col: number } | null {
  const table = tableOf(doc, id);
  if (!table || table === id) return null;
  let cell: NodeId | null = id;
  while (cell && doc.parent(cell) !== table) cell = doc.parent(cell);
  if (!cell) return null;
  const { cols, cells } = tableShape(doc, table);
  const i = cells.indexOf(cell);
  return i < 0 ? null : { table, row: Math.floor(i / cols), col: i % cols };
}

// ---------- changing one ----------

/** Copies a cell's look for a new cell: the same paints and padding, an empty text in the same type. */
function cloneCell(tx: Transaction, doc: Document, table: NodeId, like: NodeId, position: { before: NodeId } | { at: 'end' }, header?: boolean): NodeId {
  const keys = ['layoutMode', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'sizingH', 'sizingV', 'clipsContent', 'fills', 'fillStyleId', 'strokes', 'strokeWeight'] as const;
  const props: Partial<NodeProps> = { name: tr('Ячейка') };
  for (const k of keys) (props as Record<string, unknown>)[k] = doc.get(like, k);
  const cell = tx.create('FRAME', table, props, position);
  const text = doc.children(like).find((c) => doc.type(c) === 'TEXT');
  const textKeys = ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'lineHeight', 'fills', 'fillStyleId', 'textStyleId', 'textAlignH', 'textAutoResize', 'sizingH'] as const;
  const textProps: Partial<NodeProps> = { name: tr('Текст'), characters: '', width: 100 };
  if (text) for (const k of textKeys) (textProps as Record<string, unknown>)[k] = doc.get(text, k);
  tx.create('TEXT', cell, textProps);
  if (header !== undefined) restyleCell(tx, doc, table, cell, header);
  return cell;
}

/** A header cell has the header's fill and a bolder text; a body cell — the body's (taken from a body cell of the table). */
function restyleCell(tx: Transaction, doc: Document, table: NodeId, cell: NodeId, header: boolean): void {
  const { cols, cells } = tableShape(doc, table);
  const headerOn = !!doc.get(table, 'table')?.header;
  // Paints to copy: a body cell (below the header) and, for the header, the file's look.
  const body = cells[headerOn ? cols : 0] ?? cells[0]!;
  const look = lookOf(doc, tx, doc.store.ancestors(table).find((a) => doc.type(a) === 'PAGE') ?? doc.pages()[0]!);
  if (header) tx.update(cell, { fills: [look.header], fillStyleId: look.headerStyle });
  else if (body && body !== cell) tx.update(cell, { fills: doc.get(body, 'fills'), fillStyleId: doc.get(body, 'fillStyleId') });
  else tx.update(cell, { fills: [look.cell], fillStyleId: look.cellStyle });
  for (const t of doc.children(cell)) if (doc.type(t) === 'TEXT') tx.update(t, { fontWeight: header ? 600 : 400 });
}

// ---------- merged cells ----------

/** A merged cell: its place and how many rows and columns it covers. */
export interface Merge {
  cell: NodeId;
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/** The merged cells of a table (a cell spanning more than one place; the places it covers hold hidden cells). */
export function tableMerges(doc: Document, table: NodeId): Merge[] {
  const { cols, cells } = tableShape(doc, table);
  const out: Merge[] = [];
  cells.forEach((cell, i) => {
    const rs = Math.max(1, doc.get(cell, 'gridRowSpan'));
    const cs = Math.max(1, doc.get(cell, 'gridColumnSpan'));
    if (rs > 1 || cs > 1) out.push({ cell, row: Math.floor(i / cols), col: i % cols, rows: rs, cols: cs });
  });
  return out;
}

function textIn(doc: Document, cell: NodeId): NodeId | null {
  return doc.children(cell).find((c) => doc.type(c) === 'TEXT') ?? null;
}

/** Splits merged cells: each takes one place again, the cells under it come back (empty). */
function splitTx(tx: Transaction, doc: Document, table: NodeId, merges: readonly Merge[]): void {
  const { cols, cells } = tableShape(doc, table);
  for (const m of merges) {
    tx.update(m.cell, { gridRowSpan: 1, gridColumnSpan: 1 });
    for (let r = m.row; r < m.row + m.rows; r++) {
      for (let c = m.col; c < m.col + m.cols; c++) {
        const cell = cells[r * cols + c];
        if (cell && cell !== m.cell) tx.set(cell, 'visible', true);
      }
    }
  }
}

/** The rectangle of places the given layers' cells take, grown to whole merged cells. */
export function cellRect(doc: Document, ids: readonly NodeId[]): { table: NodeId; r0: number; c0: number; r1: number; c1: number } | null {
  const places = ids.map((id) => cellPlace(doc, id));
  const first = places[0];
  if (!first || places.some((p) => !p || p.table !== first.table)) return null;
  return grown(doc, first.table, Math.min(...places.map((p) => p!.row)), Math.min(...places.map((p) => p!.col)), Math.max(...places.map((p) => p!.row)), Math.max(...places.map((p) => p!.col)));
}

/**
 * The cells between two places (FEAT-170: Shift+click, dragging over cells or along the
 * row and column handles), the rectangle grown to whole merged cells; the places under a
 * merged cell are not cells to select.
 */
export function cellsBetween(doc: Document, table: NodeId, a: { row: number; col: number }, b: { row: number; col: number }): NodeId[] {
  const { r0, c0, r1, c1 } = grown(doc, table, Math.min(a.row, b.row), Math.min(a.col, b.col), Math.max(a.row, b.row), Math.max(a.col, b.col));
  const { cols, cells } = tableShape(doc, table);
  return cells.filter((cell, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return r >= r0 && r <= r1 && c >= c0 && c <= c1 && doc.get(cell, 'visible');
  });
}

function grown(doc: Document, table: NodeId, r0: number, c0: number, r1: number, c1: number): { table: NodeId; r0: number; c0: number; r1: number; c1: number } {
  const merges = tableMerges(doc, table);
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of merges) {
      const meets = m.row <= r1 && m.row + m.rows - 1 >= r0 && m.col <= c1 && m.col + m.cols - 1 >= c0;
      if (!meets) continue;
      const nr0 = Math.min(r0, m.row);
      const nc0 = Math.min(c0, m.col);
      const nr1 = Math.max(r1, m.row + m.rows - 1);
      const nc1 = Math.max(c1, m.col + m.cols - 1);
      if (nr0 !== r0 || nc0 !== c0 || nr1 !== r1 || nc1 !== c1) changed = true;
      [r0, c0, r1, c1] = [nr0, nc0, nr1, nc1];
    }
  }
  return { table, r0, c0, r1, c1 };
}

/**
 * Merges the cells of a rectangle into its top left one, as in Word: the texts are joined
 * (line by line) in it, the other cells are hidden under it. One step of undo.
 */
export function mergeCells(editor: Editor, table: NodeId, r0: number, c0: number, r1: number, c1: number): NodeId | null {
  const d = editor.doc;
  const { cols, cells } = tableShape(d, table);
  if (r1 <= r0 && c1 <= c0) return null;
  const anchor = cells[r0 * cols + c0];
  if (!anchor) return null;
  editor.commit(tr('Объединить ячейки'), (tx) => {
    splitTx(tx, d, table, tableMerges(d, table).filter((m) => m.row >= r0 && m.row <= r1 && m.col >= c0 && m.col <= c1));
    const texts: string[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = cells[r * cols + c]!;
        const t = textIn(d, cell);
        const value = t ? d.get(t, 'characters').trim() : '';
        if (value) texts.push(value);
        if (cell === anchor) continue;
        if (t) tx.set(t, 'characters', '');
        tx.set(cell, 'visible', false);
      }
    }
    const t = textIn(d, anchor);
    if (t) tx.set(t, 'characters', texts.join('\n'));
    tx.update(anchor, { gridRowSpan: r1 - r0 + 1, gridColumnSpan: c1 - c0 + 1 });
  }, () => [anchor]);
  return anchor;
}

/** Splits a merged cell back into its places (the text stays in the top left one). */
export function unmergeCell(editor: Editor, table: NodeId, cell: NodeId): void {
  const d = editor.doc;
  const merge = tableMerges(d, table).find((m) => m.cell === cell);
  if (!merge) return;
  editor.commit(tr('Разъединить ячейки'), (tx) => splitTx(tx, d, table, [merge]));
}

// ---------- rows and columns ----------

/** Adds a row before `row` (its count — at the end); new cells look like the row next to them. */
function addRowTx(tx: Transaction, d: Document, table: NodeId, row: number): void {
  // A merged cell the new row would cut through is split first.
  splitTx(tx, d, table, tableMerges(d, table).filter((m) => m.row < row && row < m.row + m.rows));
  const { rows, cols, cells } = tableShape(d, table);
  const at = Math.max(0, Math.min(rows, row));
  const headerOn = !!d.get(table, 'table')?.header;
  const before = cells[at * cols];
  // A row added above the header becomes a body row under it: the header stays on top.
  const likeRow = Math.min(rows - 1, Math.max(headerOn ? 1 : 0, at === rows ? rows - 1 : at));
  for (let c = 0; c < cols; c++) {
    const like = cells[likeRow * cols + c] ?? cells[c]!;
    cloneCell(tx, d, table, like, before ? { before } : { at: 'end' }, headerOn && at === 0 ? false : undefined);
  }
  tx.set(table, 'gridRows', tracks(rows + 1, 'HUG'));
  if (headerOn && at === 0) {
    // The new top row is the header; the old header becomes a body row.
    const now = tableShape(d, table).cells;
    for (let c = 0; c < cols; c++) {
      restyleCell(tx, d, table, now[c]!, true);
      restyleCell(tx, d, table, now[cols + c]!, false);
    }
  }
}

/** Adds a column before `col` (its count — at the right end). */
function addColumnTx(tx: Transaction, d: Document, table: NodeId, col: number): void {
  splitTx(tx, d, table, tableMerges(d, table).filter((m) => m.col < col && col < m.col + m.cols));
  const { rows, cols, cells } = tableShape(d, table);
  const at = Math.max(0, Math.min(cols, col));
  for (let r = rows - 1; r >= 0; r--) {
    const like = cells[r * cols + Math.min(at, cols - 1)]!;
    const before = at < cols ? cells[r * cols + at] : cells[(r + 1) * cols];
    const made = cloneCell(tx, d, table, like, before ? { before } : { at: 'end' });
    if (!d.get(like, 'visible')) tx.set(made, 'visible', true);
  }
  // A new column has the width of its neighbours' average share.
  const columns = [...d.get(table, 'gridColumns')];
  const shares = columns.map((t) => (t.kind === 'FR' ? t.value : 1));
  const share = shares.reduce((a, v) => a + v, 0) / Math.max(1, shares.length);
  columns.splice(at, 0, { kind: 'FR', value: Math.round(share * 100) / 100 || 1 });
  tx.set(table, 'gridColumns', columns);
}

export function addRow(editor: Editor, table: NodeId, row: number): void {
  editor.commit(tr('Добавить строку'), (tx) => addRowTx(tx, editor.doc, table, row));
}

export function addColumn(editor: Editor, table: NodeId, col: number): void {
  editor.commit(tr('Добавить столбец'), (tx) => addColumnTx(tx, editor.doc, table, col));
}

/** Deletes a row (the last one stays). */
export function removeRow(editor: Editor, table: NodeId, row: number): void {
  const d = editor.doc;
  if (tableShape(d, table).rows <= 1) return;
  const headerOn = !!d.get(table, 'table')?.header;
  editor.commit(tr('Удалить строку'), (tx) => {
    splitTx(tx, d, table, tableMerges(d, table).filter((m) => m.row <= row && row < m.row + m.rows));
    const { rows, cols, cells } = tableShape(d, table);
    if (row < 0 || row >= rows) return;
    for (let c = 0; c < cols; c++) tx.delete(cells[row * cols + c]!);
    tx.set(table, 'gridRows', tracks(rows - 1, 'HUG'));
    // The header deleted: the next row takes its place as the header.
    if (headerOn && row === 0) for (const cell of tableShape(d, table).cells.slice(0, cols)) restyleCell(tx, d, table, cell, true);
  });
  editor.setSelection(editor.selection.filter((id) => d.store.isAlive(id)));
}

/** Deletes a column (the last one stays). */
export function removeColumn(editor: Editor, table: NodeId, col: number): void {
  const d = editor.doc;
  if (tableShape(d, table).cols <= 1) return;
  editor.commit(tr('Удалить столбец'), (tx) => {
    splitTx(tx, d, table, tableMerges(d, table).filter((m) => m.col <= col && col < m.col + m.cols));
    const { rows, cols, cells } = tableShape(d, table);
    if (col < 0 || col >= cols) return;
    for (let r = 0; r < rows; r++) tx.delete(cells[r * cols + col]!);
    const columns = [...d.get(table, 'gridColumns')];
    columns.splice(col, 1);
    tx.set(table, 'gridColumns', columns);
  });
  editor.setSelection(editor.selection.filter((id) => d.store.isAlive(id)));
}

/**
 * Pastes rows of texts into a table from a cell on, as a spreadsheet does: the texts go
 * into the cells to the right and down, rows and columns are added when they run out. One step.
 */
export function fillCells(editor: Editor, table: NodeId, row: number, col: number, data: TableRows): void {
  const d = editor.doc;
  if (d.readOnly || data.length === 0) return;
  editor.commit(tr('Вставить в таблицу'), (tx) => {
    while (tableShape(d, table).rows < row + data.length) addRowTx(tx, d, table, tableShape(d, table).rows);
    const width = Math.max(...data.map((r) => r.length));
    while (tableShape(d, table).cols < col + width) addColumnTx(tx, d, table, tableShape(d, table).cols);
    const { cols, cells } = tableShape(d, table);
    data.forEach((values, r) =>
      values.forEach((value, c) => {
        const t = textIn(d, cells[(row + r) * cols + col + c]!);
        if (t && d.get(t, 'characters') !== value) tx.set(t, 'characters', value);
      }),
    );
  });
}

/** Turns the header row on or off. */
export function setHeader(editor: Editor, table: NodeId, header: boolean): void {
  const d = editor.doc;
  const { cols, cells } = tableShape(d, table);
  editor.commit(header ? tr('Строка заголовка') : tr('Без строки заголовка'), (tx) => {
    tx.set(table, 'table', { ...d.get(table, 'table')!, header });
    for (const cell of cells.slice(0, cols)) restyleCell(tx, d, table, cell, header);
  });
}

/**
 * The text of the cell `step` away from the one a text is in (Tab / Shift+Tab while typing,
 * row by row); past the last cell a row is added, as in Word and Excel. Null — not in a table.
 */
export function stepCell(editor: Editor, text: NodeId, step: 1 | -1): NodeId | null {
  const d = editor.doc;
  const place = cellPlace(d, text);
  if (!place) return null;
  let { rows, cols } = tableShape(d, place.table);
  let i = place.row * cols + place.col + step;
  if (i < 0) i = 0;
  if (i >= rows * cols) {
    if (d.readOnly) return null;
    addRow(editor, place.table, rows);
    ({ rows, cols } = tableShape(d, place.table));
  }
  // Places under a merged cell are passed by.
  const all = tableShape(d, place.table).cells;
  let at = Math.min(i, rows * cols - 1);
  while (all[at] && !d.get(all[at]!, 'visible') && at + step >= 0 && at + step < all.length) at += step;
  const cell = all[at];
  return cell ? textIn(d, cell) : null;
}

// ---------- the look of cells ----------

/**
 * The cells a selection stands for (FEAT-170): selected cells, the cells of selected texts,
 * every cell of a selected table. Empty — not all in one table.
 */
export function cellsOfSelection(doc: Document, ids: readonly NodeId[]): NodeId[] {
  const first = ids[0] ? tableOf(doc, ids[0]) : null;
  if (!first || ids.some((id) => tableOf(doc, id) !== first)) return [];
  const out = new Set<NodeId>();
  for (const id of ids) {
    if (id === first) {
      for (const c of doc.children(first)) if (doc.get(c, 'visible')) out.add(c);
      continue;
    }
    let cell: NodeId | null = id;
    while (cell && doc.parent(cell) !== first) cell = doc.parent(cell);
    if (cell) out.add(cell);
  }
  return [...out];
}

/** The texts the cells hold (the cell's own text; one in a row with a badge too). */
export function cellTexts(doc: Document, cells: readonly NodeId[]): NodeId[] {
  return cells.flatMap((cell) => doc.children(cell).filter((c) => doc.type(c) === 'TEXT'));
}

/**
 * Sets text properties on the whole texts of the cells (FEAT-170): colour, weight, size,
 * alignment — the same property in the runs is dropped, so the cell looks as asked. One step.
 */
export function styleCellTexts(editor: Editor, cells: readonly NodeId[], props: Partial<Pick<NodeProps, 'fills' | 'fontWeight' | 'fontSize' | 'italic' | 'textAlignH'>>, label: string): void {
  const d = editor.doc;
  const texts = cellTexts(d, cells);
  if (d.readOnly || texts.length === 0) return;
  const keys = Object.keys(props);
  editor.commit(label, (tx) => {
    for (const t of texts) {
      const runs = d.get(t, 'textRuns');
      const kept = runs
        .map((r) => {
          const style = { ...r.style } as Record<string, unknown>;
          for (const k of keys) delete style[k];
          return { ...r, style };
        })
        .filter((r) => Object.keys(r.style).length > 0);
      tx.update(t, { ...props, ...('fills' in props ? { fillStyleId: null } : {}), ...(kept.length !== runs.length || keys.some((k) => runs.some((r) => k in r.style)) ? { textRuns: kept } : {}) });
    }
  });
}

/** Where the texts stand in their cells, top to bottom (a cell of a column — along it, of a row — across). */
export type CellAlignV = 'MIN' | 'CENTER' | 'MAX';

export function cellAlignV(doc: Document, cell: NodeId): CellAlignV {
  const v = doc.get(cell, 'layoutMode') === 'HORIZONTAL' ? doc.get(cell, 'counterAlign') : doc.get(cell, 'primaryAlign');
  return v === 'CENTER' || v === 'MAX' ? v : 'MIN';
}

export function alignCellsV(editor: Editor, cells: readonly NodeId[], v: CellAlignV): void {
  const d = editor.doc;
  if (d.readOnly || cells.length === 0) return;
  editor.commit(tr('Выравнивание в ячейке'), (tx) => {
    for (const cell of cells) tx.set(cell, d.get(cell, 'layoutMode') === 'HORIZONTAL' ? 'counterAlign' : 'primaryAlign', v);
  });
}

/** Paints the cells (one colour; a style the cells were bound to is let go). One step. */
export function fillCellsWith(editor: Editor, cells: readonly NodeId[], paint: Paint): void {
  if (editor.doc.readOnly || cells.length === 0) return;
  editor.commit(tr('Заливка ячеек'), (tx) => {
    for (const cell of cells) tx.update(cell, { fills: [paint], fillStyleId: null });
  });
}

/** The cell texts, row by row (for copying the table out as text, and tests). */
export function tableTexts(doc: Document, table: NodeId): TableRows {
  const { cols, cells } = tableShape(doc, table);
  const out: TableRows = [];
  cells.forEach((cell, i) => {
    if (i % cols === 0) out.push([]);
    const text = doc.children(cell).find((c) => doc.type(c) === 'TEXT');
    out[out.length - 1]!.push(text ? doc.get(text, 'characters') : '');
  });
  return out;
}
