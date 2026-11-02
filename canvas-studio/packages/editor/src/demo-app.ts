// "Start here" of the starter file: a small but real project — «Тропа», a
// travel app. Three phone screens (home, a tour, booking) and the home screen
// once more in the dark theme (a variable mode on the frame), drawn landscapes
// instead of photos, colours on variables, components with variants (button,
// chip, tab bar) and prototype links between the screens. Short notes on the
// left say what to try.

import { combineAsVariants, convertFrameToComponent, createInstance } from '#components';
import { hexToColor, solid, tr, type Color, type NodeId, type NodeProps, type Paint, type Transaction } from '#core';
import type { Editor } from './editor.ts';

const c = (hex: string): Color => hexToColor(hex)!;

/** Theme colours: light and dark values. */
const THEME: Record<string, [string, string]> = {
  bg: ['#F6F3EE', '#141312'],
  surface: ['#FFFFFF', '#211F1D'],
  text: ['#1C1B1A', '#F4F1EC'],
  muted: ['#77716A', '#A59F97'],
  accent: ['#FF6B3D', '#FF8A5C'],
  'accent-soft': ['#FFE7DD', '#3A241B'],
  line: ['#E9E3DA', '#33302C'],
};

const W = 390;
const H = 844;

interface Ctx {
  tx: Transaction;
  editor: Editor;
  vars: Record<string, NodeId>;
  /** Labels of copies, set in a second step (after the components settle). */
  labels: [NodeId, string][];
}

type Tone = keyof typeof THEME | `#${string}`;

/** A fill (bound to a theme variable, or a fixed colour). */
function fill(ctx: Ctx, tone: Tone, opacity = 1): Pick<NodeProps, 'fills' | 'boundVariables'> {
  if (tone.startsWith('#')) return { fills: [solid(c(tone), opacity)], boundVariables: null };
  return { fills: [solid(c(THEME[tone]![0]), opacity)], boundVariables: { 'fills/0': ctx.vars[tone]! } };
}

function strokeOf(ctx: Ctx, tone: keyof typeof THEME): Pick<NodeProps, 'strokes'> & { bound: Record<string, string> } {
  return { strokes: [solid(c(THEME[tone]![0]))], bound: { 'strokes/0': ctx.vars[tone]! } };
}

function gradient(stops: [string, number][], from = { x: 0.5, y: 0 }, to = { x: 0.5, y: 1 }, opacity = 1): Paint {
  return { type: 'GRADIENT_LINEAR', from, to, stops: stops.map(([hex, position]) => ({ position, color: c(hex) })), opacity, visible: true };
}

function text(ctx: Ctx, parent: NodeId, characters: string, size: number, weight: number, tone: Tone, extra: Partial<NodeProps> = {}): NodeId {
  return ctx.tx.create('TEXT', parent, {
    name: characters.length > 32 ? `${characters.slice(0, 32)}…` : characters,
    characters,
    fontSize: size,
    fontWeight: weight,
    lineHeight: { unit: 'PERCENT', value: size >= 22 ? 120 : 140 },
    textAutoResize: 'WIDTH_AND_HEIGHT',
    ...fill(ctx, tone),
    ...extra,
  });
}

function row(ctx: Ctx, parent: NodeId, name: string, extra: Partial<NodeProps> = {}): NodeId {
  return ctx.tx.create('FRAME', parent, { name, layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, counterAlign: 'CENTER', fills: [], clipsContent: false, ...extra });
}

function column(ctx: Ctx, parent: NodeId, name: string, extra: Partial<NodeProps> = {}): NodeId {
  return ctx.tx.create('FRAME', parent, { name, layoutMode: 'VERTICAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, fills: [], clipsContent: false, ...extra });
}

/** A drawn landscape (sky, sun, mountains, a lake) filling a frame of w×h. */
function landscape(ctx: Ctx, parent: NodeId, w: number, h: number, sky: [string, string], lake: boolean): void {
  const tx = ctx.tx;
  tx.update(parent, { fills: [gradient([[sky[0], 0], [sky[1], 1]])] });
  tx.create('ELLIPSE', parent, { name: tr('Солнце'), x: w * 0.68, y: h * 0.14, width: 64, height: 64, fills: [solid(c('#FFE9B0'), 0.95)] });
  tx.create('POLYGON', parent, { name: tr('Дальняя гора'), x: -w * 0.12, y: h * 0.32, width: w * 0.8, height: h * 0.62, pointCount: 3, fills: [gradient([['#9C8CD4', 0], ['#7C6CB8', 1]])] });
  tx.create('POLYGON', parent, { name: tr('Гора'), x: w * 0.32, y: h * 0.24, width: w * 0.9, height: h * 0.76, pointCount: 3, fills: [gradient([['#6E5BB0', 0], ['#4C3F8A', 1]])] });
  tx.create('POLYGON', parent, { name: tr('Снег'), x: w * 0.32 + w * 0.9 * 0.38, y: h * 0.24, width: w * 0.9 * 0.24, height: h * 0.76 * 0.24, pointCount: 3, fills: [solid(c('#F4F0FF'), 0.9)] });
  tx.create('ELLIPSE', parent, { name: tr('Холм'), x: -w * 0.25, y: h * 0.78, width: w * 1.5, height: h * 0.5, fills: [solid(c('#2F2A5E'))] });
  if (lake) tx.create('ELLIPSE', parent, { name: tr('Озеро'), x: -w * 0.1, y: h * 0.84, width: w * 1.2, height: h * 0.3, fills: [gradient([['#8FDCF0', 0], ['#3E8FD0', 1]])] });
  tx.create('RECTANGLE', parent, { name: tr('Затемнение'), x: 0, y: h * 0.45, width: w, height: h * 0.55, fills: [gradient([['#000000', 0], ['#000000', 1]], { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, 0)] });
}

// ---------------------------------------------------------------- components

interface Kit {
  buttonPrimary: NodeId;
  buttonSecondary: NodeId;
  chipActive: NodeId;
  chip: NodeId;
  tabBar: NodeId;
}

function buildKit(ctx: Ctx, page: NodeId, x: number, y: number): Kit {
  const { tx, editor } = ctx;
  const doc = editor.doc;
  const buttons = (
    [
      [tr('Вид=Основная'), 'accent', '#FFFFFF'],
      [tr('Вид=Вторичная'), 'accent-soft', 'accent'],
    ] as const
  ).map(([name, bg, label], i) => {
    const f = tx.create('FRAME', page, { name, x, y: y + i * 70, layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, primaryAlign: 'CENTER', counterAlign: 'CENTER', paddingTop: 15, paddingBottom: 15, paddingLeft: 24, paddingRight: 24, cornerRadius: 16, ...fill(ctx, bg) });
    text(ctx, f, tr('Забронировать'), 16, 600, label as Tone, { name: tr('Подпись') });
    return convertFrameToComponent(doc, tx, f);
  });
  combineAsVariants(doc, tx, buttons, tr('Кнопка'));
  const chips = (
    [
      [tr('Состояние=Активный'), 'text', 'bg'],
      [tr('Состояние=Обычный'), 'surface', 'text'],
    ] as const
  ).map(([name, bg, label], i) => {
    const s = strokeOf(ctx, 'line');
    const f = tx.create('FRAME', page, {
      name,
      x: x + 260,
      y: y + i * 60,
      layoutMode: 'HORIZONTAL',
      sizingH: { mode: 'HUG' },
      sizingV: { mode: 'HUG' },
      paddingTop: 9,
      paddingBottom: 9,
      paddingLeft: 16,
      paddingRight: 16,
      cornerRadius: 99,
      ...fill(ctx, bg),
      ...(bg === 'surface' ? { strokes: s.strokes } : {}),
    });
    if (bg === 'surface') tx.set(f, 'boundVariables', { ...(doc.get(f, 'boundVariables') ?? {}), ...s.bound });
    text(ctx, f, tr('Горы'), 14, 500, label, { name: tr('Подпись') });
    return convertFrameToComponent(doc, tx, f);
  });
  combineAsVariants(doc, tx, chips, tr('Чип'));
  // Tab bar.
  const bar = tx.create('FRAME', page, { name: tr('Таб-бар'), x, y: y + 200, width: W, height: 84, layoutMode: 'HORIZONTAL', spacingMode: 'BETWEEN', counterAlign: 'MIN', paddingTop: 12, paddingLeft: 36, paddingRight: 36, ...fill(ctx, 'surface') });
  const s = strokeOf(ctx, 'line');
  tx.update(bar, { strokes: s.strokes, strokeWeights: [1, 0, 0, 0], strokeAlign: 'INSIDE' });
  tx.set(bar, 'boundVariables', { ...(doc.get(bar, 'boundVariables') ?? {}), ...s.bound });
  const tabs: [string, 'RECTANGLE' | 'ELLIPSE' | 'STAR'][] = [
    [tr('Главная'), 'RECTANGLE'],
    [tr('Поиск'), 'ELLIPSE'],
    [tr('Избранное'), 'STAR'],
    [tr('Профиль'), 'ELLIPSE'],
  ];
  tabs.forEach(([label, shape], i) => {
    const tone: Tone = i === 0 ? 'accent' : 'muted';
    const item = column(ctx, bar, label, { counterAlign: 'CENTER', itemSpacing: 6 });
    tx.create(shape, item, { name: tr('Значок'), width: 22, height: 22, cornerRadius: shape === 'RECTANGLE' ? 6 : 0, ...(shape === 'STAR' ? { pointCount: 5, innerRadius: 0.5 } : {}), ...fill(ctx, tone) });
    text(ctx, item, label, 11, 500, tone, { name: tr('Подпись') });
  });
  const tabBar = convertFrameToComponent(doc, tx, bar);
  const set = (id: NodeId) => doc.children(doc.parent(id)!);
  return { buttonPrimary: set(buttons[0]!)[0]!, buttonSecondary: set(buttons[0]!)[1]!, chipActive: set(chips[0]!)[0]!, chip: set(chips[0]!)[1]!, tabBar };
}

/** A copy of a component with its label changed. */
function instance(ctx: Ctx, component: NodeId, parent: NodeId, label?: string, props: Partial<NodeProps> = {}): NodeId {
  const doc = ctx.editor.doc;
  const id = createInstance(doc, ctx.tx, component, parent, props);
  if (label !== undefined) ctx.labels.push([id, label]);
  return id;
}

// ---------------------------------------------------------------- screens

function phone(ctx: Ctx, page: NodeId, x: number, name: string): NodeId {
  const screen = ctx.tx.create('FRAME', page, { name, x, y: 0, width: W, height: H, cornerRadius: 36, clipsContent: true, layoutMode: 'VERTICAL', itemSpacing: 20, paddingTop: 14, paddingLeft: 20, paddingRight: 20, paddingBottom: 100, ...fill(ctx, 'bg') });
  const bar = row(ctx, screen, tr('Статус'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN', paddingLeft: 12, paddingRight: 8 });
  text(ctx, bar, '9:41', 15, 600, 'text');
  const icons = row(ctx, bar, tr('Значки'), { itemSpacing: 5 });
  for (const w of [17, 15, 24]) ctx.tx.create('RECTANGLE', icons, { width: w, height: 11, cornerRadius: 3, ...fill(ctx, 'text') });
  return screen;
}

function buildHome(ctx: Ctx, page: NodeId, kit: Kit, x: number, name: string): { screen: NodeId; hero: NodeId } {
  const { tx } = ctx;
  const screen = phone(ctx, page, x, name);
  const head = row(ctx, screen, tr('Приветствие'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN' });
  const hello = column(ctx, head, tr('Текст'), { itemSpacing: 4 });
  text(ctx, hello, tr('Доброе утро, Аня'), 15, 400, 'muted');
  text(ctx, hello, tr('Куда отправимся?'), 28, 700, 'text');
  const avatar = tx.create('FRAME', head, { name: tr('Аватар'), width: 46, height: 46, cornerRadius: 23, layoutMode: 'HORIZONTAL', primaryAlign: 'CENTER', counterAlign: 'CENTER', fills: [gradient([['#FFB36B', 0], ['#FF6B3D', 1]], { x: 0, y: 0 }, { x: 1, y: 1 })] });
  text(ctx, avatar, 'А', 18, 700, '#FFFFFF');

  const search = row(ctx, screen, tr('Поиск'), { sizingH: { mode: 'FILL' }, itemSpacing: 12, paddingTop: 15, paddingBottom: 15, paddingLeft: 18, paddingRight: 18, cornerRadius: 16, ...fill(ctx, 'surface') });
  tx.create('ELLIPSE', search, { name: tr('Лупа'), width: 16, height: 16, fills: [], ...strokeOf(ctx, 'muted'), strokeWeight: 2 });
  text(ctx, search, tr('Горы, озёра, города…'), 15, 400, 'muted');

  const chips = row(ctx, screen, tr('Категории'), { itemSpacing: 8 });
  instance(ctx, kit.chipActive, chips, tr('Все'));
  for (const label of [tr('Горы'), tr('Озёра'), tr('Города')]) instance(ctx, kit.chip, chips, label);

  const title = row(ctx, screen, tr('Заголовок раздела'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN' });
  text(ctx, title, tr('Популярное'), 20, 700, 'text');
  text(ctx, title, tr('Все туры'), 14, 600, 'accent');

  const hero = tx.create('FRAME', screen, { name: tr('Тур: Алтай'), sizingH: { mode: 'FILL' }, height: 250, cornerRadius: 24, clipsContent: true });
  landscape(ctx, hero, W - 40, 250, ['#FFC58F', '#FF7A59'], true);
  const rating = row(ctx, hero, tr('Рейтинг'), { positioning: 'ABSOLUTE', x: 16, y: 16, paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10, cornerRadius: 99, fills: [solid(c('#FFFFFF'), 0.9)], itemSpacing: 4 });
  text(ctx, rating, '★ 4,9', 13, 700, '#1C1B1A');
  const caption = column(ctx, hero, tr('Подпись'), { positioning: 'ABSOLUTE', x: 20, y: 168, itemSpacing: 2 });
  text(ctx, caption, tr('Телецкое озеро'), 24, 700, '#FFFFFF');
  text(ctx, caption, tr('Алтай · 7 дней · от 38 000 ₽'), 14, 500, '#FFFFFF', { fills: [solid(c('#FFFFFF'), 0.85)] });

  const more = row(ctx, screen, tr('Ещё туры'), { sizingH: { mode: 'FILL' }, itemSpacing: 14 });
  for (const [label, sub, sky] of [
    [tr('Байкал'), tr('5 дней'), ['#9BE1F7', '#4C8BE0']],
    [tr('Карелия'), tr('4 дня'), ['#B8F0C2', '#3FA27A']],
  ] as const) {
    const card = column(ctx, more, label, { sizingH: { mode: 'FILL' }, itemSpacing: 10 });
    const pic = tx.create('FRAME', card, { name: tr('Картинка'), sizingH: { mode: 'FILL' }, height: 112, cornerRadius: 18, clipsContent: true });
    landscape(ctx, pic, 163, 112, [sky[0], sky[1]], true);
    text(ctx, card, label, 16, 700, 'text');
    text(ctx, card, sub, 13, 400, 'muted');
  }
  instance(ctx, kit.tabBar, screen, undefined, { positioning: 'ABSOLUTE', x: 0, y: H - 84 });
  return { screen, hero };
}

function buildTour(ctx: Ctx, page: NodeId, kit: Kit, x: number): { screen: NodeId; back: NodeId; book: NodeId } {
  const { tx } = ctx;
  const screen = tx.create('FRAME', page, { name: tr('Тур'), x, y: 0, width: W, height: H, cornerRadius: 36, clipsContent: true, layoutMode: 'VERTICAL', itemSpacing: 18, paddingBottom: 24, ...fill(ctx, 'bg') });
  const top = tx.create('FRAME', screen, { name: tr('Обложка'), sizingH: { mode: 'FILL' }, height: 360, clipsContent: true });
  landscape(ctx, top, W, 360, ['#FFD2A1', '#FF8466'], true);
  const back = tx.create('FRAME', top, { name: tr('Назад'), x: 20, y: 56, width: 44, height: 44, cornerRadius: 22, layoutMode: 'HORIZONTAL', primaryAlign: 'CENTER', counterAlign: 'CENTER', fills: [solid(c('#FFFFFF'), 0.9)] });
  text(ctx, back, '←', 20, 600, '#1C1B1A');
  const heart = tx.create('FRAME', top, { name: tr('В избранное'), x: W - 64, y: 56, width: 44, height: 44, cornerRadius: 22, layoutMode: 'HORIZONTAL', primaryAlign: 'CENTER', counterAlign: 'CENTER', fills: [solid(c('#FFFFFF'), 0.9)] });
  tx.create('STAR', heart, { name: tr('Звезда'), width: 18, height: 18, pointCount: 5, innerRadius: 0.5, fills: [solid(c('#FF6B3D'))] });

  const body = column(ctx, screen, tr('Описание'), { sizingH: { mode: 'FILL' }, itemSpacing: 16, paddingLeft: 24, paddingRight: 24 });
  text(ctx, body, tr('Телецкое озеро'), 28, 700, 'text');
  text(ctx, body, tr('Алтай · ★ 4,9 · 128 отзывов'), 14, 500, 'muted');
  const stats = row(ctx, body, tr('Коротко'), { sizingH: { mode: 'FILL' }, itemSpacing: 10 });
  for (const [value, label] of [
    [tr('7 дней'), tr('Длительность')],
    [tr('Средняя'), tr('Сложность')],
    [tr('до 12'), tr('В группе')],
  ] as const) {
    const box = column(ctx, stats, label, { sizingH: { mode: 'FILL' }, itemSpacing: 2, paddingTop: 12, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, cornerRadius: 16, ...fill(ctx, 'surface') });
    text(ctx, box, value, 16, 700, 'text');
    text(ctx, box, label, 12, 400, 'muted');
  }
  text(ctx, body, tr('Маршрут'), 18, 700, 'text');
  for (const day of [tr('День 1 · Горно-Алтайск — Артыбаш'), tr('День 3 · Водопад Корбу на катере'), tr('День 5 · Перевал Кату-Ярык')]) {
    const r = row(ctx, body, day, { itemSpacing: 12 });
    tx.create('ELLIPSE', r, { name: tr('Точка'), width: 10, height: 10, ...fill(ctx, 'accent') });
    text(ctx, r, day, 15, 400, 'text');
  }
  const bottom = row(ctx, body, tr('Цена и кнопка'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN', paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, cornerRadius: 20, ...fill(ctx, 'surface') });
  const price = column(ctx, bottom, tr('Цена'), { itemSpacing: 2 });
  text(ctx, price, '38 000 ₽', 22, 700, 'text');
  text(ctx, price, tr('за человека'), 13, 400, 'muted');
  const book = instance(ctx, kit.buttonPrimary, bottom, tr('Забронировать'));
  return { screen, back, book };
}

function buildBooking(ctx: Ctx, page: NodeId, kit: Kit, x: number): { screen: NodeId; back: NodeId } {
  const { tx } = ctx;
  const screen = phone(ctx, page, x, tr('Бронирование'));
  const head = row(ctx, screen, tr('Шапка'), { itemSpacing: 14 });
  const back = tx.create('FRAME', head, { name: tr('Назад'), width: 44, height: 44, cornerRadius: 22, layoutMode: 'HORIZONTAL', primaryAlign: 'CENTER', counterAlign: 'CENTER', ...fill(ctx, 'surface') });
  text(ctx, back, '←', 20, 600, 'text');
  text(ctx, head, tr('Бронирование'), 22, 700, 'text');

  const summary = row(ctx, screen, tr('Тур'), { sizingH: { mode: 'FILL' }, itemSpacing: 14, paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, cornerRadius: 20, ...fill(ctx, 'surface') });
  const thumb = tx.create('FRAME', summary, { name: tr('Картинка'), width: 64, height: 64, cornerRadius: 14, clipsContent: true });
  landscape(ctx, thumb, 64, 64, ['#FFC58F', '#FF7A59'], true);
  const info = column(ctx, summary, tr('О туре'), { itemSpacing: 2 });
  text(ctx, info, tr('Телецкое озеро'), 16, 700, 'text');
  text(ctx, info, tr('14–20 июля · 7 дней'), 13, 400, 'muted');

  const cal = column(ctx, screen, tr('Календарь'), { sizingH: { mode: 'FILL' }, itemSpacing: 8, paddingTop: 16, paddingBottom: 16, paddingLeft: 14, paddingRight: 14, cornerRadius: 20, ...fill(ctx, 'surface') });
  text(ctx, cal, tr('Июль 2026'), 16, 700, 'text');
  const days = [tr('Пн'), tr('Вт'), tr('Ср'), tr('Чт'), tr('Пт'), tr('Сб'), tr('Вс')];
  const week = (labels: string[], kind: (i: number) => 'head' | 'day' | 'edge' | 'range' | 'none') => {
    const r = row(ctx, cal, tr('Неделя'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN' });
    labels.forEach((label, i) => {
      const k = kind(i);
      const cell = tx.create('FRAME', r, {
        name: label || '—',
        width: 40,
        height: 36,
        cornerRadius: 12,
        layoutMode: 'HORIZONTAL',
        primaryAlign: 'CENTER',
        counterAlign: 'CENTER',
        ...(k === 'edge' ? fill(ctx, 'accent') : k === 'range' ? fill(ctx, 'accent-soft') : { fills: [] }),
      });
      if (label) text(ctx, cell, label, k === 'head' ? 12 : 14, k === 'edge' ? 700 : 500, k === 'head' ? 'muted' : k === 'edge' ? '#FFFFFF' : 'text');
    });
  };
  week(days, () => 'head');
  // July 2026 starts on a Wednesday.
  let d = 1 - 2;
  for (let w = 0; w < 5; w++) {
    const labels = Array.from({ length: 7 }, (_, i) => {
      const n = d + i;
      return n >= 1 && n <= 31 ? String(n) : '';
    });
    const start = d;
    week(labels, (i) => {
      const n = start + i;
      if (n === 14 || n === 20) return 'edge';
      if (n > 14 && n < 20) return 'range';
      return 'day';
    });
    d += 7;
  }

  const people = row(ctx, screen, tr('Путешественники'), { sizingH: { mode: 'FILL' }, spacingMode: 'BETWEEN', paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, cornerRadius: 20, ...fill(ctx, 'surface') });
  const who = column(ctx, people, tr('Кто едет'), { itemSpacing: 2 });
  text(ctx, who, tr('Взрослые'), 16, 600, 'text');
  text(ctx, who, tr('от 18 лет'), 13, 400, 'muted');
  const counter = row(ctx, people, tr('Счётчик'), { itemSpacing: 16 });
  for (const label of ['−', '2', '+']) {
    if (label === '2') {
      text(ctx, counter, label, 18, 700, 'text');
      continue;
    }
    const b = tx.create('FRAME', counter, { name: label, width: 36, height: 36, cornerRadius: 18, layoutMode: 'HORIZONTAL', primaryAlign: 'CENTER', counterAlign: 'CENTER', fills: [], ...strokeOf(ctx, 'line') });
    text(ctx, b, label, 18, 600, 'text');
  }
  instance(ctx, kit.buttonPrimary, screen, tr('Оплатить 76 000 ₽'), { sizingH: { mode: 'FILL' } });
  return { screen, back };
}

/** A yellow note on the canvas. */
function note(ctx: Ctx, parent: NodeId, title: string, lines: readonly string[]): NodeId {
  const frame = ctx.tx.create('FRAME', parent, { name: title, width: 340, layoutMode: 'VERTICAL', sizingV: { mode: 'HUG' }, itemSpacing: 8, paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, cornerRadius: 14, fills: [solid(c('#FFF8E1'))] });
  ctx.tx.create('TEXT', frame, { name: title, characters: title, fontSize: 18, fontWeight: 700, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' }, fills: [solid(c('#3D3D3D'))] });
  for (const line of lines) ctx.tx.create('TEXT', frame, { name: line.slice(0, 32), characters: line, fontSize: 14, lineHeight: { unit: 'PERCENT', value: 140 }, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' }, fills: [solid(c('#3D3D3D'))] });
  return frame;
}

/** Sets the labels of the copies (call in its own step after `buildTravelApp`). */
export function labelCopies(editor: Editor, tx: Transaction, labels: readonly [NodeId, string][]): void {
  const doc = editor.doc;
  for (const [id, label] of labels) {
    const t = doc.children(id).find((n) => doc.type(n) === 'TEXT');
    if (t) tx.set(t, 'characters', label);
  }
}

export function buildTravelApp(editor: Editor, tx: Transaction, page: NodeId, keys: (text: string) => string): [NodeId, string][] {
  const doc = editor.doc;
  // Theme variables: light and dark.
  const light = `m${Math.random().toString(36).slice(2, 10)}`;
  const dark = `m${Math.random().toString(36).slice(2, 10)}`;
  const collection = tx.create('VARIABLE_COLLECTION', doc.rootId, { name: tr('Тема «Тропы»'), modes: [{ id: light, name: tr('Светлая') }, { id: dark, name: tr('Тёмная') }] });
  const vars: Record<string, NodeId> = {};
  for (const [name, [l, d]] of Object.entries(THEME)) {
    vars[name] = tx.create('VARIABLE', collection, { name: `color/${name}`, varType: 'COLOR', varValues: { [light]: c(l), [dark]: c(d) }, codeSyntax: { WEB: `--color-${name}` } });
  }
  const ctx: Ctx = { tx, editor, vars, labels: [] };
  const kit = buildKit(ctx, page, 1940, 960);
  const home = buildHome(ctx, page, kit, 0, tr('Главная'));
  const tour = buildTour(ctx, page, kit, 470);
  const booking = buildBooking(ctx, page, kit, 940);
  const night = buildHome(ctx, page, kit, 1470, tr('Главная — тёмная тема'));
  tx.set(night.screen, 'variableModes', { [collection]: dark });

  // Prototype: home → tour → booking, back buttons go back.
  const slide = { type: 'SLIDE_IN' as const, direction: 'LEFT' as const, duration: 350, easing: { type: 'EASE_OUT' as const } };
  tx.set(home.hero, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: tour.screen, transition: slide }] }]);
  tx.set(tour.book, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: booking.screen, transition: slide }] }]);
  tx.set(tour.back, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]);
  tx.set(booking.back, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]);
  tx.set(page, 'flowStartingPoints', [{ nodeId: home.screen, name: tr('Путешествие'), description: '' }]);

  // Notes on the left.
  const notes = tx.create('FRAME', page, { name: tr('Подсказки'), x: -400, y: 0, layoutMode: 'VERTICAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, itemSpacing: 20, fills: [], clipsContent: false });
  note(ctx, notes, tr('Это «Тропа» — приложение для путешествий'), [
    tr('Нажмите ▷ справа вверху: прототип начнётся с главного экрана. Нажмите на карточку тура, затем «Забронировать».'),
    tr('Справа — тот же экран в тёмной теме: у фрейма выбран режим «Тёмная», цвета берутся из переменных.'),
    tr('Ниже справа — компоненты: кнопка, чип и таб-бар. Поменяйте цвет кнопки — изменятся все экраны.'),
  ]);
  note(ctx, notes, tr('Попробуйте'), [
    keys(tr('Выделите любой слой и откройте вкладку «Код» (Shift+D) — CSS, SwiftUI или Compose.')),
    keys(tr('Mod+K — палитра команд: любое действие по названию.')),
    tr('F — фрейм, R — прямоугольник, T — текст, Shift+A — адаптивная раскладка.'),
    tr('Остальные страницы файла — слева вверху: адаптивная раскладка, прототип, плагины, совместная работа.'),
  ]);
  return ctx.labels;
}
