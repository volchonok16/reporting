// Board objects on the editor's side (FEAT-083): making stickies, shapes,
// connectors, stamps and marker strokes, and the board's tools. What keeps the
// objects whole after edits is the board pass (#components board.ts).

import { Document, hexToColor, solid, tr, type BoardRole, type BoardShape, type Color, type ConnectorEnd, type ConnectorRoute, type NodeId, type VectorPath, type VectorPoint } from '#core';
import { boardTextOf, CODE_THEME, isBoardObject, roleOf, STICKY_SIZE, worldBox, worldOf, type CodeLang } from '#components';
import { apply, eraseNetwork, flattenPaths, networkFromPaths, invert, IDENTITY, type Point, type Rect } from '#geometry';
import type { Transaction } from '#core';
import { normalizeVector, type Editor } from './editor.ts';

export const BOARD_TOOLS = ['sticky', 'shape', 'connector', 'marker', 'highlighter', 'eraser', 'stamp', 'tape'] as const;
export type BoardTool = (typeof BOARD_TOOLS)[number];

export function isBoardTool(tool: string): tool is BoardTool {
  return (BOARD_TOOLS as readonly string[]).includes(tool);
}

export function isBoard(doc: Document): boolean {
  return doc.get(doc.rootId, 'fileKind') === 'BOARD';
}

/** Sticky colours, as in a pack of paper notes. */
export const STICKY_COLORS: { name: string; hex: string }[] = [
  { name: tr('Жёлтый'), hex: '#FFE27A' },
  { name: tr('Оранжевый'), hex: '#FFC48A' },
  { name: tr('Красный'), hex: '#FFA3A3' },
  { name: tr('Розовый'), hex: '#FFB8E0' },
  { name: tr('Фиолетовый'), hex: '#D6BDFF' },
  { name: tr('Синий'), hex: '#A9D2FF' },
  { name: tr('Зелёный'), hex: '#B6EBB0' },
  { name: tr('Серый'), hex: '#E4E4E4' },
];

/** Fill colours of shapes: white first (a plain flowchart), then light tints and two strong ones. */
export const SHAPE_COLORS: string[] = ['#FFFFFF', '#FFF1B8', '#FFDDBD', '#FFD1D1', '#E8DBFF', '#D6EBFF', '#D9F5D6', '#E4E4E4', '#4F5BD5', '#1E1E1E'];

/** Colours of marker strokes and connectors. */
export const INK_COLORS: string[] = ['#1E1E1E', '#4F5BD5', '#E5484D', '#F5A524', '#2FA84F', '#9B5DE5', '#8A8A8A', '#FFFFFF'];

/** Highlighter colours: bright, drawn see-through. */
export const HIGHLIGHT_COLORS: string[] = ['#F5D90A', '#FF8FA3', '#7EE081', '#7CC4FF', '#C9A2FF', '#FFB066'];

/** Board shapes, in the groups of the shapes menu. */
export const SHAPE_KINDS: { shape: BoardShape; label: string; icon: string; group: string }[] = [
  { shape: 'RECTANGLE', label: tr('Прямоугольник'), icon: 'rectangle', group: tr('Основные') },
  { shape: 'ROUNDED', label: tr('Скруглённый'), icon: 'rounded', group: tr('Основные') },
  { shape: 'ELLIPSE', label: tr('Овал'), icon: 'ellipse', group: tr('Основные') },
  { shape: 'DIAMOND', label: tr('Ромб'), icon: 'diamond', group: tr('Основные') },
  { shape: 'TRIANGLE', label: tr('Треугольник'), icon: 'polygon', group: tr('Основные') },
  { shape: 'HEXAGON', label: tr('Шестиугольник'), icon: 'hexagon', group: tr('Основные') },
  { shape: 'STAR', label: tr('Звезда'), icon: 'star', group: tr('Основные') },
  { shape: 'ARROW', label: tr('Стрелка-блок'), icon: 'blockArrow', group: tr('Основные') },
  { shape: 'SPEECH', label: tr('Реплика'), icon: 'speech', group: tr('Основные') },
  { shape: 'NOTE', label: tr('Заметка'), icon: 'note', group: tr('Основные') },
  { shape: 'TERMINATOR', label: tr('Начало / конец'), icon: 'terminator', group: tr('Блок-схема') },
  { shape: 'PARALLELOGRAM', label: tr('Параллелограмм'), icon: 'parallelogram', group: tr('Блок-схема') },
  { shape: 'SUBPROCESS', label: tr('Подпроцесс'), icon: 'subprocess', group: tr('Блок-схема') },
  { shape: 'TRAPEZOID', label: tr('Трапеция'), icon: 'trapezoid', group: tr('Блок-схема') },
  { shape: 'DOCUMENT', label: tr('Документ'), icon: 'document', group: tr('Блок-схема') },
  { shape: 'MULTI_DOCUMENT', label: tr('Документы'), icon: 'multiDocument', group: tr('Блок-схема') },
  { shape: 'CLOUD', label: tr('Облако'), icon: 'cloud', group: tr('ИТ-схема') },
  { shape: 'CYLINDER', label: tr('База данных'), icon: 'cylinder', group: tr('ИТ-схема') },
  { shape: 'QUEUE', label: tr('Очередь'), icon: 'queue', group: tr('ИТ-схема') },
  { shape: 'SERVER', label: tr('Сервер'), icon: 'server', group: tr('ИТ-схема') },
  { shape: 'USER', label: tr('Пользователь'), icon: 'user', group: tr('ИТ-схема') },
];

export const STAMPS: { id: string; text: string; label: string }[] = [
  { id: 'like', text: '👍', label: tr('Нравится') },
  { id: 'heart', text: '❤️', label: tr('Сердце') },
  { id: 'plus', text: '+1', label: tr('+1') },
  { id: 'question', text: '❓', label: tr('Вопрос') },
  { id: 'done', text: '✅', label: tr('Готово') },
  { id: 'star', text: '⭐', label: tr('Звезда') },
  { id: 'fire', text: '🔥', label: tr('Огонь') },
  { id: 'idea', text: '💡', label: tr('Идея') },
  { id: 'me', text: '', label: tr('Ваши инициалы') },
];

/** What the board tools use next (remembered while the file is open). */
export interface BoardPrefs {
  stickyColor: string;
  shape: BoardShape;
  shapeColor: string;
  route: ConnectorRoute;
  ink: string;
  stamp: string;
  /** Who makes stickies (the account's name); empty — no author. */
  author: string;
  /** Line widths of the marker and the highlighter, and the eraser's size (screen px). */
  markerSize: number;
  highlighterSize: number;
  highlightInk: string;
  /** Who votes: the account's id (or one id for this browser). */
  voter: string;
  /** The language of the next code block (the last one chosen). */
  codeLang: CodeLang;
  /** The colour of the next strip of tape. */
  tapeColor: string;
  eraserSize: number;
  /** The design pencil's ink (empty — black, white on a dark frame, as in Figma) and line width. */
  pencilInk: string;
  pencilSize: number;
}

/** Widths offered for the marker and the highlighter, and sizes of the eraser. */
export const MARKER_SIZES = [2, 4, 8, 14];
export const HIGHLIGHTER_SIZES = [12, 20, 32];
export const ERASER_SIZES = [6, 14, 30];
/** Line widths offered for the design pencil. */
export const PENCIL_SIZES = [1, 2, 3, 5, 8, 12];

export function defaultBoardPrefs(): BoardPrefs {
  return { stickyColor: STICKY_COLORS[0]!.hex, shape: 'RECTANGLE', shapeColor: SHAPE_COLORS[0]!, route: 'ELBOW', ink: INK_COLORS[0]!, stamp: 'like', author: '', markerSize: 4, highlighterSize: 20, highlightInk: HIGHLIGHT_COLORS[0]!, eraserSize: 14, voter: 'me', pencilInk: '', pencilSize: 3, codeLang: 'js', tapeColor: TAPE_COLORS[0]! };
}

const color = (hex: string): Color => hexToColor(hex) ?? { r: 1, g: 1, b: 1, a: 1 };
const INK = '#1E1E1E';

/**
 * A shape's outline by default: a darker tone of its fill (so it shows on any
 * colour — the same colour as the fill could not be seen, BUG-081); near black on white.
 */
export function shapeStrokeAuto(fill: string): string {
  const c = color(fill);
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  if (max - min < 0.04) return max > 0.5 ? '#1E1E1E' : '#000000';
  // The same hue, saturated and dark (a light tint gets a clear line of its own colour).
  const d = max - min;
  const h = max === c.r ? ((c.g - c.b) / d + 6) % 6 : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  const l = Math.min(0.38, ((max + min) / 2) * 0.55);
  const sat = 0.65;
  const k = (n: number) => (n + h * 2) % 12;
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const p = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${p(f(0))}${p(f(8))}${p(f(4))}`.toUpperCase();
}

export { lineDash, lineKindOf, type LineKind } from '#core';

/** Readable ink over a fill: dark on light colours, white on strong ones. */
export function inkFor(fill: string): string {
  const c = color(fill);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum < 0.5 ? '#FFFFFF' : INK;
}

/** A new empty board: one page with a light background. */
export function createBoardDocument(name: string): Document {
  const doc = Document.createEmpty(name);
  doc.transact((tx) => {
    tx.update(doc.rootId, { fileKind: 'BOARD', boardAuthors: true });
    tx.set(doc.pages()[0]!, 'name', tr('Доска'));
  });
  doc.clearHistory();
  return doc;
}

/** Where a new board object goes: a section under the point, else the page. */
export function placeFor(editor: Editor, at: Point, into?: NodeId): { parent: NodeId; local: (p: Point) => Point } {
  const parent = into ?? editor.sectionAt(at);
  const inverse = parent === editor.pageId ? IDENTITY : (invert(worldOf(editor.doc, parent)) ?? IDENTITY);
  return { parent, local: (p) => apply(inverse, p) };
}

/** Puts a sticky with its centre at a point; returns it (its text is created by the board pass). */
export function createSticky(editor: Editor, center: Point, fill = editor.boardPrefs.stickyColor, size = STICKY_SIZE, into?: NodeId): NodeId {
  const { parent, local } = placeFor(editor, center, into);
  const p = local({ x: center.x - size / 2, y: center.y - size / 2 });
  return editor.commit(tr('Стикер'), (tx) => {
    const id = tx.create('FRAME', parent, {
      name: tr('Стикер'),
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: size,
      height: size,
      cornerRadius: 4,
      clipsContent: false,
      fills: [solid(color(fill))],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 2 }, radius: 6, spread: 0, visible: true }],
      board: { kind: 'STICKY', author: editor.boardPrefs.author },
    });
    tx.create('TEXT', id, { name: tr('Текст'), board: { kind: 'STICKY_TEXT' }, characters: '', fontSize: 32, textAutoResize: 'HEIGHT', fills: [solid(color(inkFor(fill)))] });
    return id;
  }, () => []);
}

/** The monospace font of code blocks (Google Fonts, OFL, with Cyrillic): embedded into the file the first time. */
export const CODE_FONT = 'JetBrains Mono';
/** Width of a new code block. */
export const CODE_WIDTH = 520;

/**
 * Puts a code block (step 10) on a free place near `center`: a dark frame with a
 * monospace text, coloured by `lang` by the board pass (components/board.ts).
 */
export function createCodeBlock(editor: Editor, center: Point, lang: CodeLang = editor.boardPrefs.codeLang, text = ''): NodeId {
  const height = 80;
  const at = editor.sectionAt(center) === editor.pageId ? freeSpotOnBoard(editor, center, CODE_WIDTH, height) : { x: center.x - CODE_WIDTH / 2, y: center.y - height / 2 };
  const { parent, local } = placeFor(editor, { x: at.x + CODE_WIDTH / 2, y: at.y + height / 2 });
  const p = local(at);
  return editor.commit(tr('Блок кода'), (tx) => {
    const id = tx.create('FRAME', parent, {
      name: tr('Блок кода'),
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: CODE_WIDTH,
      height,
      cornerRadius: 8,
      clipsContent: true,
      fills: [solid(color(CODE_THEME.background))],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.16 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true }],
      board: { kind: 'CODE', lang },
    });
    tx.create('TEXT', id, { name: tr('Код'), board: { kind: 'CODE_TEXT' }, characters: text, fontFamily: CODE_FONT, fontWeight: 400, fontSize: 15, lineHeight: { unit: 'PERCENT', value: 150 }, textAutoResize: 'HEIGHT', fills: [solid(color(CODE_THEME.text))] });
    return id;
  }, () => []);
}

/** Changes the language of code blocks: their colours follow at once (the board pass). */
export function setCodeLang(editor: Editor, ids: readonly NodeId[], lang: CodeLang): void {
  editor.commit(tr('Язык кода'), (tx) => {
    for (const id of ids) if (editor.doc.get(id, 'board')?.kind === 'CODE') tx.set(id, 'board', { kind: 'CODE', lang });
  });
  editor.boardPrefs.codeLang = lang;
}

/** The text of a code block, or null. */
export function codeOf(doc: Document, id: NodeId): string | null {
  if (doc.get(id, 'board')?.kind !== 'CODE') return null;
  const t = boardTextOf(doc, id);
  return t ? doc.get(t, 'characters') : null;
}

/**
 * Stickers (step 10): bright badges with a thick white edge, as cut-out stickers,
 * made of the board's shapes — so their outline follows the size and a double
 * click changes the word. Drawn by us, no pictures from elsewhere.
 */
export const STICKERS: readonly { id: string; label: string; shape: BoardShape; fill: string; ink: string; w: number; h: number }[] = [
  { id: 'cool', label: 'Круто!', shape: 'STAR', fill: '#FFC53D', ink: '#1E1E1E', w: 150, h: 150 },
  { id: 'idea', label: 'Идея', shape: 'CLOUD', fill: '#FFE066', ink: '#1E1E1E', w: 170, h: 110 },
  { id: 'question', label: 'Вопрос?', shape: 'SPEECH', fill: '#6C8CFF', ink: '#FFFFFF', w: 160, h: 110 },
  { id: 'important', label: 'Важно!', shape: 'TERMINATOR', fill: '#FF5C5C', ink: '#FFFFFF', w: 160, h: 64 },
  { id: 'done', label: 'Готово', shape: 'ELLIPSE', fill: '#2EBD85', ink: '#FFFFFF', w: 120, h: 120 },
  { id: 'progress', label: 'В работе', shape: 'TERMINATOR', fill: '#FF9F43', ink: '#FFFFFF', w: 170, h: 64 },
  { id: 'discuss', label: 'Обсудить', shape: 'SPEECH', fill: '#B57BFF', ink: '#FFFFFF', w: 170, h: 110 },
  { id: 'urgent', label: 'Срочно', shape: 'HEXAGON', fill: '#F0443A', ink: '#FFFFFF', w: 140, h: 120 },
  { id: 'thanks', label: 'Спасибо!', shape: 'ROUNDED', fill: '#FF7AB6', ink: '#FFFFFF', w: 170, h: 70 },
  { id: 'plus', label: '+1', shape: 'ELLIPSE', fill: '#4F5BD5', ink: '#FFFFFF', w: 90, h: 90 },
  { id: 'fire', label: 'Огонь', shape: 'STAR', fill: '#FF6B3D', ink: '#FFFFFF', w: 150, h: 150 },
  { id: 'super', label: 'Супер', shape: 'STAR', fill: '#8C6CFF', ink: '#FFFFFF', w: 150, h: 150 },
  { id: 'yes', label: 'Да', shape: 'ELLIPSE', fill: '#2EBD85', ink: '#FFFFFF', w: 90, h: 90 },
  { id: 'no', label: 'Нет', shape: 'ELLIPSE', fill: '#F0443A', ink: '#FFFFFF', w: 90, h: 90 },
  { id: 'later', label: 'Позже', shape: 'ROUNDED', fill: '#9AA5B1', ink: '#FFFFFF', w: 140, h: 64 },
  { id: 'new', label: 'Новое', shape: 'STAR', fill: '#2BB3E8', ink: '#FFFFFF', w: 150, h: 150 },
  { id: 'solved', label: 'Решено', shape: 'TERMINATOR', fill: '#2EBD85', ink: '#FFFFFF', w: 160, h: 64 },
  { id: 'blocker', label: 'Блокер', shape: 'HEXAGON', fill: '#1E1E1E', ink: '#FFFFFF', w: 140, h: 120 },
  { id: 'risk', label: 'Риск', shape: 'DIAMOND', fill: '#FFC53D', ink: '#1E1E1E', w: 130, h: 130 },
  { id: 'here', label: 'Сюда', shape: 'ARROW', fill: '#4F5BD5', ink: '#FFFFFF', w: 170, h: 90 },
];

/** Puts a sticker on a free place near `center`, slightly turned as a sticker stuck by hand; returns it. */
export function createSticker(editor: Editor, stickerId: string, center: Point): NodeId {
  const st = STICKERS.find((x) => x.id === stickerId) ?? STICKERS[0]!;
  const spot = editor.sectionAt(center) === editor.pageId ? freeSpotOnBoard(editor, center, st.w, st.h) : { x: center.x - st.w / 2, y: center.y - st.h / 2 };
  const { parent, local } = placeFor(editor, { x: spot.x + st.w / 2, y: spot.y + st.h / 2 });
  const p = local(spot);
  const label = tr(st.label);
  return editor.commit(tr('Наклейка'), (tx) => {
    const id = tx.create('FRAME', parent, {
      name: tr('Наклейка «{0}»', label),
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: st.w,
      height: st.h,
      rotation: Math.round((Math.random() * 10 - 5) * 10) / 10,
      fills: [],
      clipsContent: false,
      board: { kind: 'SHAPE', shape: st.shape },
    });
    tx.create('VECTOR', id, {
      name: label,
      board: { kind: 'SHAPE_OUTLINE' },
      fills: [solid(color(st.fill))],
      strokes: [solid(color('#FFFFFF'))],
      strokeWeight: 6,
      strokeAlign: 'CENTER',
      strokeJoin: 'ROUND',
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.22 }, offset: { x: 0, y: 3 }, radius: 8, spread: 0, visible: true }],
    });
    tx.create('TEXT', id, { name: tr('Текст'), board: { kind: 'SHAPE_TEXT' }, characters: label, fontSize: st.h < 80 ? 20 : 24, fontWeight: 800, textAlignH: 'CENTER', textAutoResize: 'HEIGHT', fills: [solid(color(st.ink))] });
    return id;
  }, () => []);
}

/** How many own colours a board keeps (the oldest goes when one more is added). */
export const BOARD_COLORS_MAX = 12;

/** Adds a colour to the board's own palette (step 10): offered to everyone in the board after the usual ones. */
export function addBoardColor(editor: Editor, hex: string): void {
  const c = hex.toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(c)) return;
  const d = editor.doc;
  const now = d.get(d.rootId, 'boardColors');
  if (now.includes(c)) return;
  editor.commit(tr('Свой цвет доски'), (tx) => tx.set(d.rootId, 'boardColors', [...now, c].slice(-BOARD_COLORS_MAX)));
}

export function removeBoardColor(editor: Editor, hex: string): void {
  const d = editor.doc;
  editor.commit(tr('Убрать свой цвет'), (tx) => tx.set(d.rootId, 'boardColors', d.get(d.rootId, 'boardColors').filter((c) => c !== hex)));
}

/** Washi tape colours: soft, as paper tape (step 10). */
export const TAPE_COLORS = ['#F9A8C9', '#9FE3C7', '#FFE08A', '#C9B6F2', '#A8D4F9', '#FFC59E', '#D9D9D9'] as const;
export const TAPE_NAMES = ['Розовый', 'Мятный', 'Жёлтый', 'Лавандовый', 'Голубой', 'Персиковый', 'Серый'] as const;
/** Width of a strip of tape, and its length when placed by a click. */
export const TAPE_WIDTH = 32;
const TAPE_CLICK_LENGTH = 200;

/** A strip's outline: straight long edges, torn (zigzag) ends. */
export function tapePath(length: number, width = TAPE_WIDTH): VectorPath {
  const teeth = 5;
  const step = width / teeth;
  const depth = 3;
  const left: VectorPoint[] = [];
  const right: VectorPoint[] = [];
  for (let i = 0; i <= teeth; i++) {
    const zig = i % 2 === 0 ? 0 : depth;
    right.push({ x: length - zig, y: i * step });
    left.push({ x: zig, y: width - i * step });
  }
  return { closed: true, points: [...right, ...left] };
}

/**
 * Lays a strip of washi tape from `a` to `b` (page points); a click (no drag) lays a
 * strip of the usual length across `a`. The strip turns along the drag; returns it.
 */
export function createTape(editor: Editor, a: Point, b: Point, fill = editor.boardPrefs.tapeColor): NodeId {
  let from = a;
  let to = b;
  if (Math.hypot(b.x - a.x, b.y - a.y) < 8 / Math.max(0.1, editor.viewport.zoom)) {
    from = { x: a.x - TAPE_CLICK_LENGTH / 2, y: a.y };
    to = { x: a.x + TAPE_CLICK_LENGTH / 2, y: a.y };
  }
  const length = Math.max(24, Math.hypot(to.x - from.x, to.y - from.y));
  const rotation = Math.round(((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) * 10) / 10;
  // The strip's middle at the middle of the drag: the corner is found back through the turn.
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const r = (rotation * Math.PI) / 180;
  const cx = length / 2;
  const cy = TAPE_WIDTH / 2;
  const x = mid.x - (Math.cos(r) * cx - Math.sin(r) * cy);
  const y = mid.y - (Math.sin(r) * cx + Math.cos(r) * cy);
  const { parent, local } = placeFor(editor, mid);
  const p = local({ x, y });
  return editor.commit(tr('Скотч'), (tx) =>
    tx.create('VECTOR', parent, {
      name: tr('Скотч'),
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      width: Math.round(length),
      height: TAPE_WIDTH,
      rotation,
      vectorPaths: [tapePath(Math.round(length))],
      fills: [solid(color(fill), 0.78)],
      strokes: [],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true }],
      board: { kind: 'TAPE' },
    }),
  () => []);
}

/** Default size of a new shape. */
export function shapeSize(shape: BoardShape): { width: number; height: number } {
  switch (shape) {
    case 'ELLIPSE':
    case 'DIAMOND':
    case 'TRIANGLE':
    case 'HEXAGON':
    case 'STAR':
      return { width: 140, height: 140 };
    case 'CYLINDER':
    case 'SERVER':
      return { width: 120, height: 150 };
    case 'USER':
      return { width: 150, height: 150 };
    case 'CLOUD':
      return { width: 200, height: 130 };
    case 'TERMINATOR':
      return { width: 180, height: 70 };
    default:
      return { width: 180, height: 100 };
  }
}

/** A shape with a text in it, in a box (page coordinates). */
export function createShape(editor: Editor, box: Rect, shape = editor.boardPrefs.shape, fill = editor.boardPrefs.shapeColor, into?: NodeId): NodeId {
  const { parent, local } = placeFor(editor, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, into);
  const p = local({ x: box.x, y: box.y });
  const label = SHAPE_KINDS.find((k) => k.shape === shape)?.label ?? tr('Фигура');
  return editor.commit(label, (tx) => {
    const id = tx.create('FRAME', parent, {
      name: label,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: Math.max(20, Math.round(box.width)),
      height: Math.max(20, Math.round(box.height)),
      fills: [],
      clipsContent: false,
      board: { kind: 'SHAPE', shape },
    });
    tx.create('VECTOR', id, { name: label, board: { kind: 'SHAPE_OUTLINE' }, fills: [solid(color(fill))], strokes: [solid(color(shapeStrokeAuto(fill)))], strokeWeight: 2, strokeAlign: 'INSIDE', strokeJoin: 'ROUND' });
    tx.create('TEXT', id, { name: tr('Текст'), board: { kind: 'SHAPE_TEXT' }, characters: '', fontSize: 16, textAlignH: 'CENTER', textAutoResize: 'HEIGHT', fills: [solid(color(inkFor(fill)))] });
    return id;
  }, () => []);
}

/** A connector between two ends; returns it. */
export function createConnector(editor: Editor, start: ConnectorEnd, end: ConnectorEnd, route = editor.boardPrefs.route, ink = editor.boardPrefs.ink): NodeId {
  return editor.commit(tr('Связь'), (tx) =>
    tx.create('VECTOR', editor.pageId, {
      name: tr('Связь'),
      board: { kind: 'CONNECTOR', start, end, route },
      strokes: [solid(color(ink))],
      strokeWeight: 2,
      strokeAlign: 'CENTER',
      strokeJoin: 'ROUND',
      strokeCap: 'ROUND',
      endCap: 'ARROW',
      fills: [],
    }),
  () => []);
}

/** Connectors lose their bend: the line is routed by itself again (FEAT-115). */
export function straighten(editor: Editor, ids: readonly NodeId[]): void {
  const bent = ids.filter((id) => (editor.doc.get(id, 'board') as { bend?: unknown } | null)?.bend);
  if (bent.length === 0) return;
  editor.commit(tr('Убрать изгиб'), (tx) => {
    for (const id of bent) {
      const { bend: _, ...role } = editor.doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
      tx.set(id, 'board', role);
    }
  });
}

/** Puts a text label at the middle of a connector (or returns the one it has). */
export function connectorLabel(editor: Editor, connector: NodeId): NodeId {
  const d = editor.doc;
  for (const r of d.store.allRecords()) {
    const role = r.props.board;
    if (role?.kind === 'CONNECTOR_LABEL' && role.connector === connector && d.store.isAlive(r.id)) return r.id;
  }
  return editor.commit(tr('Подпись связи'), (tx) => {
    const id = tx.create('FRAME', editor.pageId, {
      name: tr('Подпись'),
      fills: [solid(color('#FFFFFF'))],
      cornerRadius: 4,
      layoutMode: 'HORIZONTAL',
      sizingH: { mode: 'HUG' },
      sizingV: { mode: 'HUG' },
      paddingLeft: 6,
      paddingRight: 6,
      paddingTop: 2,
      paddingBottom: 2,
      clipsContent: false,
      board: { kind: 'CONNECTOR_LABEL', connector },
    });
    tx.create('TEXT', id, { name: tr('Текст'), characters: '', fontSize: 14, fills: [solid(color(INK))] });
    return id;
  }, () => []);
}

const GAP = 80;

const OPPOSITE = { TOP: 'BOTTOM', RIGHT: 'LEFT', BOTTOM: 'TOP', LEFT: 'RIGHT' } as const;

/**
 * Next object in a direction (FigJam's "+"): a sticky gets a neighbour of the
 * same colour, a shape the same shape, with an arrow to it. `arrow: false` —
 * a sticky's neighbour without one (Tab while typing: a quick row of ideas).
 * Returns the new object.
 */
export function addNeighbour(editor: Editor, id: NodeId, dir: 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT', shapeOverride?: BoardShape, arrow = true): NodeId | null {
  const d = editor.doc;
  const role = roleOf(d, id);
  if (!role) return null;
  const box = worldBox(d, id);
  const gap = role.kind === 'STICKY' ? 24 : GAP;
  const dx = dir === 'RIGHT' ? box.width + gap : dir === 'LEFT' ? -(box.width + gap) : 0;
  const dy = dir === 'BOTTOM' ? box.height + gap : dir === 'TOP' ? -(box.height + gap) : 0;
  if (role.kind === 'STICKY') {
    const fill = d.get(id, 'fills')[0];
    const hex = fill?.type === 'SOLID' ? colorHex(fill.color) : editor.boardPrefs.stickyColor;
    // With an arrow, the gap is a shape's: room to see the arrow between them.
    const g = arrow ? GAP : gap;
    const next = createSticky(editor, { x: box.x + box.width / 2 + (dx && Math.sign(dx) * (box.width + g)), y: box.y + box.height / 2 + (dy && Math.sign(dy) * (box.height + g)) }, hex, d.get(id, 'width'));
    if (arrow) createConnector(editor, { node: id, side: dir, x: 0, y: 0 }, { node: next, side: OPPOSITE[dir], x: 0, y: 0 });
    return next;
  }
  if (role.kind === 'SHAPE') {
    const outline = d.children(id).find((c) => roleOf(d, c)?.kind === 'SHAPE_OUTLINE');
    const fill = outline ? d.get(outline, 'fills')[0] : undefined;
    const hex = fill?.type === 'SOLID' ? colorHex(fill.color) : editor.boardPrefs.shapeColor;
    const shape = shapeOverride ?? role.shape;
    const size = shapeOverride ? shapeSize(shape) : { width: box.width, height: box.height };
    const cx = box.x + box.width / 2 + (dir === 'RIGHT' ? box.width / 2 + GAP + size.width / 2 : dir === 'LEFT' ? -(box.width / 2 + GAP + size.width / 2) : 0);
    const cy = box.y + box.height / 2 + (dir === 'BOTTOM' ? box.height / 2 + GAP + size.height / 2 : dir === 'TOP' ? -(box.height / 2 + GAP + size.height / 2) : 0);
    const next = createShape(editor, { x: cx - size.width / 2, y: cy - size.height / 2, ...size }, shape, hex);
    createConnector(editor, { node: id, side: dir, x: 0, y: 0 }, { node: next, side: OPPOSITE[dir], x: 0, y: 0 });
    return next;
  }
  return null;
}

function colorHex(c: Color): string {
  const p = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`.toUpperCase();
}

/** Initials of a name for the "me" stamp. */
export function initials(name: string): string {
  return (name.trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2) || '?').toUpperCase();
}

/** A stamp at a point: an emoji, "+1", or the initials of whoever puts it. */
export function placeStamp(editor: Editor, center: Point, stampId = editor.boardPrefs.stamp): NodeId {
  const stamp = STAMPS.find((s) => s.id === stampId) ?? STAMPS[0]!;
  const { parent, local } = placeFor(editor, center);
  const size = 44;
  const p = local({ x: center.x - size / 2, y: center.y - size / 2 });
  const me = stamp.id === 'me';
  const plus = stamp.id === 'plus';
  return editor.commit(tr('Штамп'), (tx) => {
    const id = tx.create('FRAME', parent, {
      name: stamp.label,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: size,
      height: size,
      cornerRadius: size / 2,
      fills: me || plus ? [solid(color(me ? '#4F5BD5' : '#FFFFFF'))] : [],
      strokes: plus ? [solid(color('#4F5BD5'))] : [],
      strokeWeight: 2,
      clipsContent: false,
      effects: me || plus ? [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 1 }, radius: 4, spread: 0, visible: true }] : [],
      layoutMode: 'HORIZONTAL',
      primaryAlign: 'CENTER',
      counterAlign: 'CENTER',
      board: { kind: 'STAMP' },
    });
    tx.create('TEXT', id, { name: stamp.label, characters: me ? initials(editor.boardPrefs.author || '?') : stamp.text, fontSize: me ? 16 : plus ? 16 : 28, fontWeight: me || plus ? 700 : 400, fills: [solid(color(me ? '#FFFFFF' : plus ? '#4F5BD5' : INK))] });
    return id;
  }, () => []);
}

/** Smooths a hand-drawn line: fewer points (Douglas–Peucker), then curves through them. */
export function smoothStroke(points: readonly Point[], tolerance: number): VectorPoint[] {
  if (points.length < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const keep = douglasPeucker(points, tolerance);
  if (keep.length < 3) return keep.map((p) => ({ x: p.x, y: p.y }));
  // Catmull-Rom through the kept points, as cubic handles.
  const out: VectorPoint[] = [];
  for (let i = 0; i < keep.length; i++) {
    const p = keep[i]!;
    const prev = keep[i - 1] ?? p;
    const next = keep[i + 1] ?? p;
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    out.push({ x: p.x, y: p.y, ...(i > 0 ? { in: { x: p.x - tx, y: p.y - ty } } : {}), ...(i < keep.length - 1 ? { out: { x: p.x + tx, y: p.y + ty } } : {}) });
  }
  return out;
}

function douglasPeucker(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i]!, a, b);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [a, b];
  return [...douglasPeucker(points.slice(0, index + 1), tolerance).slice(0, -1), ...douglasPeucker(points.slice(index), tolerance)];
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A marker or highlighter stroke through page points. */
export function createMarkerStroke(editor: Editor, points: readonly Point[], highlighter: boolean, ink = editor.boardPrefs.ink): NodeId | null {
  if (points.length < 2) return null;
  const smooth = smoothStroke(points, 1.2 / Math.max(0.1, editor.viewport.zoom));
  const xs = smooth.flatMap((p) => [p.x, p.in?.x ?? p.x, p.out?.x ?? p.x]);
  const ys = smooth.flatMap((p) => [p.y, p.in?.y ?? p.y, p.out?.y ?? p.y]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const shift = (q: Point) => ({ x: Math.round((q.x - x) * 100) / 100, y: Math.round((q.y - y) * 100) / 100 });
  const path: VectorPath = { closed: false, points: smooth.map((p) => ({ ...shift(p), ...(p.in ? { in: shift(p.in) } : {}), ...(p.out ? { out: shift(p.out) } : {}) })) };
  return editor.commit(highlighter ? tr('Выделитель') : tr('Маркер'), (tx) =>
    tx.create('VECTOR', editor.pageId, {
      name: highlighter ? tr('Выделитель') : tr('Маркер'),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
      vectorPaths: [path],
      strokes: [solid(color(highlighter ? editor.boardPrefs.highlightInk : ink), highlighter ? 0.4 : 1)],
      strokeWeight: highlighter ? editor.boardPrefs.highlighterSize : editor.boardPrefs.markerSize,
      strokeAlign: 'CENTER',
      strokeCap: 'ROUND',
      strokeJoin: 'ROUND',
      fills: [],
      board: { kind: 'MARKER' },
    }),
  () => []);
}

/**
 * The eraser over marker strokes: the part of each stroke under a circle
 * (page point, radius in page units) goes; a stroke cut in two stays as two
 * pieces of one layer; a stroke erased whole is deleted.
 */
export function eraseStrokes(editor: Editor, tx: Transaction, at: Point, radius: number, from: Point = at): boolean {
  if (!editor.isBoardFile()) return eraseDrawn(editor, tx, from, at, radius);
  const d = editor.doc;
  let changed = false;
  for (const id of markersAt(editor, at, radius)) {
    const m = worldOf(d, id);
    const inv = invert(m);
    if (!inv) continue;
    const c = apply(inv, at);
    const reach = radius + d.get(id, 'strokeWeight') / 2;
    const pieces: Point[][] = [];
    let hit = false;
    for (const line of flattenPaths(d.get(id, 'vectorPaths'), 0.2)) {
      // Dense enough that the circle never falls between two points.
      const pts: Point[] = [];
      line.points.forEach((p, i) => {
        const prev = line.points[i - 1];
        if (prev) {
          const n = Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(0.5, reach / 3));
          for (let k = 1; k < n; k++) pts.push({ x: prev.x + ((p.x - prev.x) * k) / n, y: prev.y + ((p.y - prev.y) * k) / n });
        }
        pts.push(p);
      });
      let run: Point[] = [];
      for (const p of pts) {
        if (Math.hypot(p.x - c.x, p.y - c.y) <= reach) {
          hit = true;
          if (run.length > 1) pieces.push(run);
          run = [];
        } else run.push(p);
      }
      if (run.length > 1) pieces.push(run);
    }
    // The circle only touched the stroke's box: nothing to erase.
    if (!hit) continue;
    if (pieces.length === 0) {
      tx.delete(id);
      changed = true;
      continue;
    }
    // Pieces in the page, then back into the layer's own box.
    const world = pieces.map((p) => p.map((q) => apply(m, q)));
    const xs = world.flat().map((q) => q.x);
    const ys = world.flat().map((q) => q.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const parentInv = invert(worldOf(d, d.parent(id)!)) ?? IDENTITY;
    const origin = apply(parentInv, { x: x0, y: y0 });
    const r2 = (v: number) => Math.round(v * 100) / 100;
    tx.update(id, {
      x: r2(origin.x),
      y: r2(origin.y),
      rotation: 0,
      width: r2(Math.max(...xs) - x0),
      height: r2(Math.max(...ys) - y0),
      vectorPaths: world.map((p) => ({ closed: false, points: p.map((q) => ({ x: r2(q.x - x0), y: r2(q.y - y0) })) })),
    });
    changed = true;
  }
  return changed;
}

/** Marker strokes under a page point (for the eraser). */
/**
 * The eraser in a design file (as in Figma Draw): lines drawn with the pencil or the pen
 * (vectors with a stroke and no fill) lose the part under the eraser's path from `from`
 * to `at`; curves stay curves, the ends get new points; a line erased whole is deleted.
 */
function eraseDrawn(editor: Editor, tx: Transaction, from: Point, at: Point, radius: number): boolean {
  const d = editor.doc;
  let changed = false;
  const hits = new Set([...editor.scene.hitTest(at, { tolerance: radius }), ...editor.scene.hitTest(from, { tolerance: radius })]);
  for (const id of hits) {
    if (d.type(id) !== 'VECTOR' || !editor.canTransform(id) || editor.isInstanceLayer(id)) continue;
    if (d.get(id, 'fills').some((f) => f.visible) || !d.get(id, 'strokes').some((s) => s.visible)) continue;
    // A pencil line is kept as paths until its points are edited: the eraser works on the network.
    const net = d.get(id, 'vectorNetwork') ?? networkFromPaths(d.get(id, 'vectorPaths'));
    const m = worldOf(d, id);
    const inv = invert(m);
    if (!inv) continue;
    // The eraser's radius in the layer's own units, plus half the line (touching its edge erases).
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const next = eraseNetwork(net, apply(inv, from), apply(inv, at), radius / scale + d.get(id, 'strokeWeight') / 2);
    if (!next) continue;
    changed = true;
    if (next.segments.length === 0) {
      tx.delete(id);
      continue;
    }
    tx.set(id, 'vectorNetwork', next);
    normalizeVector(d, tx, id);
  }
  return changed;
}

export function markersAt(editor: Editor, at: Point, radius: number): NodeId[] {
  const d = editor.doc;
  return editor.scene.hitTest(at, { tolerance: radius }).filter((id) => roleOf(d, id)?.kind === 'MARKER');
}

/** The object a click on the board selects instead of one of its parts. */
export function boardObjectOf(doc: Document, id: NodeId): NodeId | null {
  for (let cur: NodeId | null = id; cur; cur = doc.parent(cur)) {
    if (isBoardObject(doc, cur)) return cur;
    const t = doc.type(cur);
    if (t === 'PAGE' || t === 'DOCUMENT') return null;
  }
  return null;
}

/** The text to edit for a board object (a connector gets a label to type into). */
export function editableTextOf(editor: Editor, id: NodeId): NodeId | null {
  const d = editor.doc;
  const role = roleOf(d, id);
  if (role?.kind === 'CONNECTOR') return boardTextOf(d, connectorLabel(editor, id));
  return boardTextOf(d, id);
}

export function isBoardObjectOrConnector(doc: Document, id: NodeId): boolean {
  return isBoardObject(doc, id) || isConnector(doc, id);
}

export function isConnector(doc: Document, id: NodeId): boolean {
  return roleOf(doc, id)?.kind === 'CONNECTOR';
}

export type { BoardRole };

// ---------- timer and voting (FEAT-086) ----------

/** Writes a board-wide state (timer, vote): shared with everyone, outside the undo history. */
export function setBoardState<K extends 'boardTimer' | 'boardVoting'>(editor: Editor, key: K, value: import('#core').NodeProps[K]): void {
  editor.doc.transact((tx) => tx.set(editor.doc.rootId, key, value), { undoable: false });
}

/** Votes of a session per object: all of them and this voter's. */
export function votesOf(doc: Document, session: string, voter: string): Map<NodeId, { total: number; mine: number }> {
  const out = new Map<NodeId, { total: number; mine: number }>();
  for (const r of doc.store.allRecords()) {
    const role = r.props.board;
    if (role?.kind !== 'VOTE' || role.session !== session || !doc.store.isAlive(r.id)) continue;
    const object = doc.parent(r.id);
    if (!object) continue;
    const v = out.get(object) ?? { total: 0, mine: 0 };
    v.total++;
    if (role.voter === voter) v.mine++;
    out.set(object, v);
  }
  return out;
}

/** How many votes this voter has used in a session. */
export function usedVotes(doc: Document, session: string, voter: string): number {
  let n = 0;
  for (const v of votesOf(doc, session, voter).values()) n += v.mine;
  return n;
}

/** Objects that take votes: stickies and shapes. */
export function votable(doc: Document, id: NodeId): boolean {
  const kind = roleOf(doc, id)?.kind;
  return kind === 'STICKY' || kind === 'SHAPE';
}

/** Puts one of this voter's votes on an object; false when none are left. */
export function addVote(editor: Editor, object: NodeId): boolean {
  const d = editor.doc;
  const voting = d.get(d.rootId, 'boardVoting');
  if (!voting?.open || !votable(d, object)) return false;
  if (usedVotes(d, voting.id, editor.boardPrefs.voter) >= voting.perPerson) return false;
  editor.commit(tr('Голос'), (tx) => {
    tx.create('ELLIPSE', object, { name: tr('Голос'), visible: false, width: 1, height: 1, fills: [], board: { kind: 'VOTE', voter: editor.boardPrefs.voter, session: voting.id } });
  }, () => editor.selection);
  return true;
}

/** Takes back one of this voter's votes from an object. */
export function removeVote(editor: Editor, object: NodeId): boolean {
  const d = editor.doc;
  const voting = d.get(d.rootId, 'boardVoting');
  if (!voting?.open) return false;
  const mine = d.children(object).find((c) => {
    const role = roleOf(d, c);
    return role?.kind === 'VOTE' && role.session === voting.id && role.voter === editor.boardPrefs.voter;
  });
  if (!mine) return false;
  editor.commit(tr('Убрать голос'), (tx) => tx.delete(mine), () => editor.selection);
  return true;
}

/** Removes every vote of a session (and the vote itself). */
export function clearVotes(editor: Editor, session: string): void {
  const d = editor.doc;
  const ids: NodeId[] = [];
  for (const r of d.store.allRecords()) if (r.props.board?.kind === 'VOTE' && r.props.board.session === session && d.store.isAlive(r.id)) ids.push(r.id);
  editor.commit(tr('Убрать голоса'), (tx) => ids.forEach((id) => tx.delete(id)), () => editor.selection);
  setBoardState(editor, 'boardVoting', null);
}

/** Short text of an object for lists (its first line). */
export function objectLabel(doc: Document, id: NodeId): string {
  const text = boardTextOf(doc, id);
  const s = text ? doc.get(text, 'characters').trim().split('\n')[0]! : '';
  return s || doc.get(id, 'name');
}

// ---------- guests (FEAT-088) ----------

const ANIMALS = [tr('Жираф'), tr('Панда'), tr('Ёж'), tr('Лиса'), tr('Енот'), tr('Сова'), tr('Выдра'), tr('Кит'), tr('Пингвин'), tr('Коала'), tr('Тигр'), tr('Лемур'), tr('Бобр'), tr('Фламинго'), tr('Альпака'), tr('Хомяк')];

/**
 * Someone on a board without an account (by a link that lets guests edit): an
 * animal's name for the cursor and the stickies, and an id for votes — kept in
 * this browser, so the same guest stays the same animal.
 */
export function guestIdentity(): { name: string; id: string } {
  let name = '';
  let id = '';
  try {
    name = localStorage.getItem('cs.guestName') ?? '';
    id = localStorage.getItem('cs.guestId') ?? '';
  } catch {
    // no storage: a new animal each time
  }
  if (!name) name = tr('{0} (гость)', ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!);
  if (!id) id = `guest-${Math.random().toString(36).slice(2, 12)}`;
  try {
    localStorage.setItem('cs.guestName', name);
    localStorage.setItem('cs.guestId', id);
  } catch {
    // not remembered
  }
  return { name, id };
}

/**
 * Where a new object of `w × h` goes on a board near `centre` without covering what is
 * there: the centre itself when free, else the nearest free place on rings around it
 * (24 px apart from the others). Returns the top-left corner in page coordinates.
 */
export function freeSpotOnBoard(editor: Editor, centre: Point, w: number, h: number): Point {
  const gap = 24;
  const doc = editor.doc;
  const taken: Rect[] = doc
    .children(editor.pageId)
    .filter((id) => doc.get(id, 'visible') !== false)
    .map((id) => editor.scene.bounds(id))
    .filter((b) => b.width > 0 || b.height > 0);
  const free = (x: number, y: number) => taken.every((b) => x + w + gap <= b.x || b.x + b.width + gap <= x || y + h + gap <= b.y || b.y + b.height + gap <= y);
  const x0 = Math.round(centre.x - w / 2);
  const y0 = Math.round(centre.y - h / 2);
  if (free(x0, y0)) return { x: x0, y: y0 };
  const step = Math.max(40, Math.round(Math.min(w, h) / 2));
  for (let ring = 1; ring <= 40; ring++) {
    // Nearest first: the candidates of a ring sorted by their distance from the centre.
    const spots: Point[] = [];
    for (let i = -ring; i <= ring; i++) {
      spots.push({ x: x0 + i * step, y: y0 - ring * step }, { x: x0 + i * step, y: y0 + ring * step });
      if (Math.abs(i) < ring) spots.push({ x: x0 - ring * step, y: y0 + i * step }, { x: x0 + ring * step, y: y0 + i * step });
    }
    spots.sort((a, b) => Math.hypot(a.x - x0, a.y - y0) - Math.hypot(b.x - x0, b.y - y0));
    const found = spots.find((p) => free(p.x, p.y));
    if (found) return found;
  }
  return { x: x0, y: y0 };
}
