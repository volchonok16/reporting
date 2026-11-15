// Screen reader mode of the prototype viewer (step 8): what a screen reader
// finds on a screen. The screen is read as a tree of items in reading order —
// rows top to bottom, left to right in a row; an auto layout frame in its own
// order. A layer with a click is a button (a link when all it does is open a
// site), a large text is a heading, a text is a text, a picture is an image
// (its description, or «без описания»). The «Прототип» tab sets a layer's role
// and what is said for it (a11yRole, a11yLabel), or makes it decorative.
// Pure functions: the viewer builds hidden DOM from them, the panel shows how a
// layer will be read.

import { tr, type A11yRole, type Document, type NodeId } from '#core';

export type A11yKind = 'button' | 'link' | 'heading' | 'text' | 'image' | 'group';

export interface A11yItem {
  id: NodeId;
  kind: A11yKind;
  /** What is said for it. */
  name: string;
  /** Heading level, 1–3. */
  level?: number;
  /** A picture without a description (said as such and flagged in the panel). */
  unlabeled?: boolean;
  /** The layers of a group, in reading order. */
  children?: A11yItem[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const A11Y_ROLES: readonly (readonly [A11yRole, string])[] = [
  ['AUTO', tr('Авто')],
  ['BUTTON', tr('Кнопка')],
  ['LINK', tr('Ссылка')],
  ['HEADING', tr('Заголовок')],
  ['TEXT', tr('Текст')],
  ['IMAGE', tr('Изображение')],
  ['GROUP', tr('Группа')],
  ['DECORATIVE', tr('Не читать')],
];

/** Triggers that make a layer something to press. */
const PRESS = new Set(['ON_CLICK', 'MOUSE_DOWN', 'MOUSE_UP', 'ON_PRESS']);

/** Names the editor gives by itself («Прямоугольник 3», «Frame 12»): they say nothing to a listener. */
const DEFAULT_NAME =
  /^(фрейм|секция|компонент|группа|прямоугольник|эллипс|многоугольник|звезда|вектор|линия|стрелка|текст|изображение|картинка|фото|frame|section|component|group|rectangle|ellipse|polygon|star|vector|line|arrow|text|image|picture|photo|instance|копия)(\s*\d+)?$/i;

export function meaningfulName(name: string): string {
  const n = name.trim();
  return n && !DEFAULT_NAME.test(n) ? n : '';
}

function shown(doc: Document, id: NodeId): boolean {
  return doc.get(id, 'visible') !== false && doc.get(id, 'opacity') > 0;
}

/** The text inside a layer, visible texts joined by spaces. */
export function textOf(doc: Document, id: NodeId): string {
  if (!shown(doc, id)) return '';
  if (doc.type(id) === 'TEXT') return String(doc.get(id, 'characters') ?? '').replace(/\s+/g, ' ').trim();
  return doc
    .children(id)
    .map((c) => textOf(doc, c))
    .filter(Boolean)
    .join(' ');
}

function pressable(doc: Document, id: NodeId): 'button' | 'link' | null {
  const reactions = doc.get(id, 'reactions').filter((r) => PRESS.has(r.trigger.type));
  if (reactions.length === 0) return null;
  return reactions.every((r) => r.actions.length > 0 && r.actions.every((a) => a.type === 'URL')) ? 'link' : 'button';
}

function hasImage(doc: Document, id: NodeId): boolean {
  return doc.get(id, 'fills').some((f) => f.visible !== false && f.type === 'IMAGE');
}

function headingLevel(size: number): number {
  return size >= 32 ? 1 : size >= 24 ? 2 : 3;
}

/** Children in reading order: an auto layout frame keeps its order; otherwise rows top to bottom, each left to right. */
export function readingOrder(doc: Document, id: NodeId, rect: (id: NodeId) => Rect): NodeId[] {
  const kids = doc.children(id).filter((c) => shown(doc, c));
  if (doc.get(id, 'layoutMode') !== 'NONE') return [...kids];
  const boxes = kids.map((c) => ({ id: c, r: rect(c) })).sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
  const rows: { bottom: number; items: typeof boxes }[] = [];
  for (const b of boxes) {
    const row = rows.at(-1);
    // In the row while its middle is above the row's bottom edge.
    if (row && b.r.y + b.r.height / 2 < row.bottom) {
      row.items.push(b);
      row.bottom = Math.max(row.bottom, b.r.y + b.r.height);
    } else rows.push({ bottom: b.r.y + b.r.height, items: [b] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.r.x - b.r.x).map((b) => b.id));
}

/** What a screen reader finds in a layer (the screen itself: everything on it). */
export function a11yItems(doc: Document, id: NodeId, rect: (id: NodeId) => Rect, top = true): A11yItem[] {
  if (!doc.store.isAlive(id) || !shown(doc, id)) return [];
  const role = doc.get(id, 'a11yRole') ?? 'AUTO';
  if (role === 'DECORATIVE') return [];
  const label = String(doc.get(id, 'a11yLabel') ?? '').trim();
  const name = () => label || textOf(doc, id) || meaningfulName(String(doc.get(id, 'name') ?? ''));
  const inner = () => readingOrder(doc, id, rect).flatMap((c) => a11yItems(doc, c, rect, false));
  const press = pressable(doc, id);
  switch (role) {
    case 'BUTTON':
    case 'LINK':
      return [{ id, kind: role === 'LINK' ? 'link' : 'button', name: name() || tr('без названия') }];
    case 'HEADING':
      return [{ id, kind: 'heading', name: name(), level: headingLevel(doc.type(id) === 'TEXT' ? doc.get(id, 'fontSize') : 24) }];
    case 'TEXT':
      return [{ id, kind: 'text', name: name() }];
    case 'IMAGE': {
      const n = label || meaningfulName(String(doc.get(id, 'name') ?? ''));
      return [{ id, kind: 'image', name: n, unlabeled: !n }];
    }
    case 'GROUP':
      return [{ id, kind: 'group', name: name(), children: inner() }];
    default:
      break;
  }
  if (press && !top) return [{ id, kind: press, name: name() || tr('без названия') }];
  if (doc.type(id) === 'TEXT') {
    const text = label || textOf(doc, id);
    if (!text) return [];
    const size = doc.get(id, 'fontSize');
    return [size >= 24 ? { id, kind: 'heading', name: text, level: headingLevel(size) } : { id, kind: 'text', name: text }];
  }
  const kids = doc.children(id);
  if (hasImage(doc, id) && kids.length === 0) {
    const n = label || meaningfulName(String(doc.get(id, 'name') ?? ''));
    return [{ id, kind: 'image', name: n, unlabeled: !n }];
  }
  if (label && !top) return kids.length === 0 ? [{ id, kind: 'image', name: label }] : [{ id, kind: 'group', name: label, children: inner() }];
  return inner();
}

/** What is said when the reader comes to an item: «Кнопка, Дальше». */
export function spoken(item: A11yItem): string {
  const what =
    item.kind === 'button'
      ? tr('Кнопка')
      : item.kind === 'link'
        ? tr('Ссылка')
        : item.kind === 'heading'
          ? tr('Заголовок {0} уровня', String(item.level ?? 2))
          : item.kind === 'image'
            ? tr('Изображение')
            : item.kind === 'group'
              ? tr('Группа')
              : '';
  const name = item.unlabeled ? tr('без описания') : item.name;
  return [what, name].filter(Boolean).join(', ');
}

/** Every item, groups opened, in reading order. */
export function flatItems(items: readonly A11yItem[]): A11yItem[] {
  return items.flatMap((i) => [i, ...(i.children ? flatItems(i.children) : [])]);
}
