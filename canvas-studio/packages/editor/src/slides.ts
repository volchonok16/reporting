// «Презентация» (as Figma Slides): a file whose page holds slides — top-level
// frames of 1920 × 1080 laid out in a grid by their order. Everything a design
// has works inside a slide; the file adds a theme (colour and text styles named
// «Тема/…» that every layout is bound to, so another theme restyles all slides),
// ready layouts, the slide's notes and transition, and the show.

import { cloneValue, Document, hexToColor, solid, TEXT_STYLE_KEYS, tr, type Color, type NodeId, type NodeProps, type SlideInfo, type TextRun, type Transaction } from '#core';
import { styleUsers } from '#components';
import { scaleNode } from '#layout';
import type { Editor } from './editor.ts';

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
/** Slides in a row of the grid, and the gaps (room for the name above each). */
export const GRID_COLS = 4;
const GAP_X = 240;
const GAP_Y = 320;

export function isSlides(doc: Document): boolean {
  return doc.get(doc.rootId, 'fileKind') === 'SLIDES';
}

/** The slides of a page in their order: its top-level frames. */
export function slideIds(doc: Document, page: NodeId): NodeId[] {
  return doc.children(page).filter((id) => doc.type(id) === 'FRAME');
}

export function slideInfo(doc: Document, id: NodeId): SlideInfo {
  return { notes: '', ...(doc.get(id, 'slide') ?? {}) };
}

export interface SlideSize {
  w: number;
  h: number;
}
const BASE: SlideSize = { w: SLIDE_W, h: SLIDE_H };

/** Formats a presentation can have; the size a layout of 1920 × 1080 is adapted to. */
export function slideFormats(): { id: string; name: string; hint: string; size: SlideSize }[] {
  return [
    { id: '16:9', name: '16 : 9', hint: tr('Экран, проектор'), size: { w: 1920, h: 1080 } },
    { id: '4:3', name: '4 : 3', hint: tr('Старые проекторы, планшет'), size: { w: 1440, h: 1080 } },
    { id: '1:1', name: '1 : 1', hint: tr('Квадрат: пост, карусель'), size: { w: 1080, h: 1080 } },
    { id: '4:5', name: '4 : 5', hint: tr('Лента соцсетей'), size: { w: 1080, h: 1350 } },
    { id: '9:16', name: '9 : 16', hint: tr('Сторис, вертикальное видео'), size: { w: 1080, h: 1920 } },
    { id: 'a4l', name: tr('A4 альбомная'), hint: tr('Печать, PDF'), size: { w: 1754, h: 1240 } },
    { id: 'a4p', name: tr('A4 книжная'), hint: tr('Печать, документ'), size: { w: 1240, h: 1754 } },
  ];
}

/** The size of the slides: the first slide's (a new file — 16:9). */
export function slideSize(doc: Document, page: NodeId): SlideSize {
  const first = slideIds(doc, page)[0];
  return first ? { w: doc.get(first, 'width'), h: doc.get(first, 'height') } : BASE;
}

/** How large the theme's type is for a size: 1 at 1920 × 1080. */
export const typeScale = (size: SlideSize) => Math.min(size.w / SLIDE_W, size.h / SLIDE_H);

/** Where the i-th slide stands in the grid (slides of `size`). */
export function gridPlace(i: number, size: SlideSize = BASE): { x: number; y: number } {
  return { x: (i % GRID_COLS) * (size.w + GAP_X), y: Math.floor(i / GRID_COLS) * (size.h + GAP_Y) };
}

/** The grid index nearest to a point (where a dragged slide was dropped). */
function gridIndexAt(x: number, y: number, size: SlideSize): number {
  const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round(x / (size.w + GAP_X))));
  const row = Math.max(0, Math.round(y / (size.h + GAP_Y)));
  return row * GRID_COLS + col;
}

/** The whole grid's box (the «Сетка» view shows it). */
export function gridBounds(count: number, size: SlideSize): { x: number; y: number; width: number; height: number } {
  const cols = Math.min(GRID_COLS, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / GRID_COLS));
  return { x: 0, y: 0, width: cols * size.w + (cols - 1) * GAP_X, height: rows * size.h + (rows - 1) * GAP_Y };
}

/**
 * Keeps the slides in their grid, in the same step as the edit: a slide dragged
 * on the canvas takes the place it was dropped on, others close up; new, deleted
 * and reordered slides move into place.
 */
export function arrangeSlides(doc: Document, tx: Transaction, page: NodeId, force = false): void {
  let slides = slideIds(doc, page);
  const size = slideSize(doc, page);
  const changes = tx.changes;
  const touched = slides.some((id) => {
    const keys = changes.updated.get(id);
    return !!keys && (keys.has('x') || keys.has('y') || keys.has('width') || keys.has('height'));
  });
  if (!force && !changes.structural && !touched) return;
  const off = (id: NodeId, i: number) => {
    const at = gridPlace(i, size);
    return Math.abs(doc.get(id, 'x') - at.x) > 1 || Math.abs(doc.get(id, 'y') - at.y) > 1;
  };
  // One slide away from its place (dragged on the canvas): it goes where it was dropped.
  const dragged = slides.filter((id, i) => off(id, i) && !changes.created.has(id));
  if (dragged.length === 1) {
    const id = dragged[0]!;
    const cx = doc.get(id, 'x') + doc.get(id, 'width') / 2 - size.w / 2;
    const cy = doc.get(id, 'y') + doc.get(id, 'height') / 2 - size.h / 2;
    const target = Math.min(slides.length - 1, gridIndexAt(cx, cy, size));
    if (target !== slides.indexOf(id)) {
      const rest = slides.filter((s) => s !== id);
      const before = rest[target];
      if (before) tx.move(id, page, { before });
      else tx.move(id, page, { after: rest[rest.length - 1]! });
      slides = slideIds(doc, page);
    }
  }
  slides.forEach((id, i) => {
    const at = gridPlace(i, size);
    if (doc.get(id, 'x') !== at.x) tx.set(id, 'x', at.x);
    if (doc.get(id, 'y') !== at.y) tx.set(id, 'y', at.y);
    // The format sets the sheet, whatever made the frame (a paste, an import, a frame drawn on the page):
    // a slide of another size gets the format's, its content fitted in it; a slide is never turned.
    if (i > 0 && (Math.abs(doc.get(id, 'width') - size.w) > 0.5 || Math.abs(doc.get(id, 'height') - size.h) > 0.5)) fitSlide(doc, tx, id, size);
    if (doc.get(id, 'rotation') !== 0) tx.set(id, 'rotation', 0);
    if (!doc.get(id, 'slide')) tx.update(id, { slide: { notes: '' }, clipsContent: true });
  });
}

/** Brings a slide to a size: its content scaled to fit and centred, as a change of format does. */
function fitSlide(doc: Document, tx: Transaction, id: NodeId, size: SlideSize): void {
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const k = Math.min(size.w / w, size.h / h);
  scaleNode(doc, tx, id, k);
  const dx = (size.w - w * k) / 2;
  const dy = (size.h - h * k) / 2;
  for (const child of doc.children(id)) tx.update(child, { x: Math.round((doc.get(child, 'x') + dx) * 100) / 100, y: Math.round((doc.get(child, 'y') + dy) * 100) / 100 });
  tx.update(id, { width: size.w, height: size.h });
}

// ---------- themes ----------

export interface SlideTheme {
  id: string;
  name: string;
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  heading: string;
  body: string;
  headingWeight: number;
}

export function slideThemes(): SlideTheme[] {
  return [
    { id: 'light', name: tr('Светлая'), bg: '#FFFFFF', surface: '#F2F3F7', text: '#16181D', muted: '#5F6470', accent: '#4F5BD5', heading: 'Inter', body: 'Inter', headingWeight: 700 },
    { id: 'graphite', name: tr('Графит'), bg: '#17181C', surface: '#24262C', text: '#F4F4F6', muted: '#A3A7B3', accent: '#8B95FF', heading: 'Inter', body: 'Inter', headingWeight: 700 },
    { id: 'paper', name: tr('Бумага'), bg: '#FBF7F0', surface: '#F0E8DA', text: '#2B2622', muted: '#776B5F', accent: '#C2552D', heading: 'Georgia', body: 'Georgia', headingWeight: 700 },
    { id: 'ocean', name: tr('Океан'), bg: '#0E2A47', surface: '#163A5F', text: '#F2F7FC', muted: '#A9C1D9', accent: '#4CC9F0', heading: 'Inter', body: 'Inter', headingWeight: 800 },
    { id: 'forest', name: tr('Лес'), bg: '#F3F6F1', surface: '#E1EADB', text: '#1D2B1F', muted: '#5A6B5C', accent: '#2F7D4A', heading: 'Trebuchet MS', body: 'Inter', headingWeight: 700 },
    { id: 'sunset', name: tr('Закат'), bg: '#FFF4EC', surface: '#FFE3D1', text: '#2A1A14', muted: '#7D5A4A', accent: '#E8553A', heading: 'Inter', body: 'Inter', headingWeight: 800 },
    { id: 'contrast', name: tr('Контраст'), bg: '#000000', surface: '#1A1A1A', text: '#FFFFFF', muted: '#BDBDBD', accent: '#FFD60A', heading: 'Inter', body: 'Inter', headingWeight: 900 },
    { id: 'lavender', name: tr('Лаванда'), bg: '#F6F3FF', surface: '#E9E2FF', text: '#211A3A', muted: '#665E85', accent: '#7C4DFF', heading: 'Inter', body: 'Inter', headingWeight: 700 },
    { id: 'mono', name: tr('Моно'), bg: '#F5F5F2', surface: '#E6E6E1', text: '#111111', muted: '#5C5C58', accent: '#111111', heading: 'Courier New', body: 'Courier New', headingWeight: 700 },
  ];
}

type ColorRole = 'bg' | 'surface' | 'text' | 'muted' | 'accent';
type TextRole = 'title' | 'heading' | 'subtitle' | 'body' | 'caption' | 'number';

const COLOR_NAMES = (): Record<ColorRole, string> => ({ bg: tr('Тема/Фон'), surface: tr('Тема/Поверхность'), text: tr('Тема/Текст'), muted: tr('Тема/Второстепенный'), accent: tr('Тема/Акцент') });
const TEXT_NAMES = (): Record<TextRole, string> => ({ title: tr('Тема/Титул'), heading: tr('Тема/Заголовок'), subtitle: tr('Тема/Подзаголовок'), body: tr('Тема/Текст'), caption: tr('Тема/Подпись'), number: tr('Тема/Цифра') });

function textValues(theme: SlideTheme, role: TextRole, k = 1): Partial<NodeProps> {
  const heading = role === 'title' || role === 'heading' || role === 'number';
  const size = Math.round({ title: 128, heading: 80, subtitle: 44, body: 36, caption: 24, number: 240 }[role] * k);
  return {
    fontFamily: heading ? theme.heading : theme.body,
    fontWeight: heading ? theme.headingWeight : role === 'subtitle' ? 500 : 400,
    italic: false,
    fontSize: size,
    lineHeight: { unit: 'PERCENT', value: heading ? 110 : 140 },
    letterSpacing: { unit: 'PERCENT', value: heading ? -2 : 0 },
    paragraphSpacing: role === 'body' ? Math.round(16 * k) : 0,
    paragraphIndent: 0,
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    fontVariantCaps: 'NORMAL',
  };
}

const paint = (hex: string) => [solid(hexToColor(hex)!)];

/** The theme's styles of the file, by role (made when missing). */
export function themeStyles(doc: Document, tx: Transaction, theme: SlideTheme, k = 1): { color: Record<ColorRole, NodeId>; text: Record<TextRole, NodeId> } {
  const byName = new Map(doc.children(doc.rootId).filter((id) => doc.type(id) === 'STYLE').map((id) => [`${doc.get(id, 'styleType')}:${doc.get(id, 'name')}`, id]));
  const color = {} as Record<ColorRole, NodeId>;
  for (const [role, name] of Object.entries(COLOR_NAMES()) as [ColorRole, string][]) {
    color[role] = byName.get(`FILL:${name}`) ?? tx.create('STYLE', doc.rootId, { styleType: 'FILL', name, fills: paint(theme[role]) });
  }
  const text = {} as Record<TextRole, NodeId>;
  for (const [role, name] of Object.entries(TEXT_NAMES()) as [TextRole, string][]) {
    text[role] = byName.get(`TEXT:${name}`) ?? tx.create('STYLE', doc.rootId, { styleType: 'TEXT', name, ...textValues(theme, role, k) });
  }
  return { color, text };
}

/** Colours this close (0…255 a channel) are one colour of the theme. */
const NEAR = 24;
/** A colour this far from grey is a colour (an accent), not a shade of ink or paper. */
const CHROMA = 0.25;

const rgb = (c: Color) => [c.r * 255, c.g * 255, c.b * 255] as const;
const distance = (a: Color, b: Color) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]!));
const chroma = (c: Color) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** A layer's one plain fill of its own (unbound, not split by text runs), or null. */
function ownColor(doc: Document, id: NodeId): Color | null {
  if (doc.get(id, 'fillStyleId') || Object.keys(doc.get(id, 'boundVariables') ?? {}).some((k) => k.startsWith('fills'))) return null;
  const fills = doc.get(id, 'fills');
  const p = fills.length === 1 ? fills[0]! : null;
  if (!p || p.type !== 'SOLID' || p.visible === false || p.opacity !== 1 || p.color.a !== 1) return null;
  if (doc.type(id) === 'TEXT' && (doc.get(id, 'textRuns') ?? []).some((r: TextRun) => r.style.fills)) return null;
  return p.color;
}

/**
 * Binds the slides' own colours to the theme's styles, so the theme and its styles restyle
 * them as they do the layouts (an imported slide comes with colours of its own and nothing
 * bound — editing «Тема/…» changed nothing). Roles are read from the content: the slide's
 * fill is the background, the starkest grey text the text, another grey text the secondary,
 * the most used colour the accent, the largest grey shape the surface; every layer within
 * NEAR of a role is bound to it. While nothing else in the file uses the theme's colours,
 * the theme takes the slides' colours (the import keeps its look); otherwise the slides
 * take the theme's (one deck, one theme). Colours far from every role stay their own.
 */
export function bindSlideColors(doc: Document, tx: Transaction, slides: NodeId[], theme: SlideTheme = currentTheme(doc)): void {
  const s = themeStyles(doc, tx, theme);
  const layers: { id: NodeId; color: Color }[] = [];
  const visit = (id: NodeId): boolean | void => {
    if (doc.type(id) === 'INSTANCE' || doc.get(id, 'visible') === false) return false;
    const color = ownColor(doc, id);
    if (color) layers.push({ id, color });
  };
  for (const slide of slides) if (visit(slide) !== false) doc.store.walk(slide, visit);
  if (!layers.length) return;
  const isSlide = new Set(slides);
  // Colours with their weight: a text by its letters, a shape by its area.
  const tally = (pick: (l: { id: NodeId; color: Color }) => number) => {
    const out: { color: Color; w: number; n: number }[] = [];
    for (const l of layers) {
      const w = pick(l);
      if (w <= 0) continue;
      const same = out.find((c) => distance(c.color, l.color) < 1);
      if (same) (same.w += w), same.n++;
      else out.push({ color: l.color, w, n: 1 });
    }
    return out.sort((a, b) => b.w - a.w);
  };
  const area = (id: NodeId) => doc.get(id, 'width') * doc.get(id, 'height');
  const roles: Partial<Record<ColorRole, Color>> = {};
  const bg = tally((l) => (isSlide.has(l.id) ? area(l.id) : 0))[0]?.color;
  if (bg) roles.bg = bg;
  const greyText = tally((l) => (doc.type(l.id) === 'TEXT' && chroma(l.color) < CHROMA ? doc.get(l.id, 'characters').length : 0));
  const paper = lum(bg ?? hexToColor(theme.bg)!);
  const text = [...greyText].sort((a, b) => Math.abs(lum(b.color) - paper) - Math.abs(lum(a.color) - paper))[0]?.color;
  if (text) {
    roles.text = text;
    const muted = greyText.find((c) => distance(c.color, text) > NEAR)?.color;
    if (muted) roles.muted = muted;
  }
  const accent = tally((l) => (chroma(l.color) >= CHROMA ? 1 : 0))[0]?.color;
  if (accent) roles.accent = accent;
  const surface = tally((l) => (doc.type(l.id) !== 'TEXT' && !isSlide.has(l.id) && chroma(l.color) < CHROMA ? area(l.id) : 0)).find(
    (c) => (!bg || distance(c.color, bg) > 4) && Object.values(roles).every((r) => distance(c.color, r) > 4),
  )?.color;
  if (surface) roles.surface = surface;
  const used = new Set<NodeId>();
  for (const slide of slides) used.add(slide), doc.store.walk(slide, (id) => void used.add(id));
  const adopt = (Object.values(s.color) as NodeId[]).every((style) => styleUsers(doc, style, 'fillStyleId').every((u) => used.has(u.id)) && styleUsers(doc, style, 'strokeStyleId').length === 0);
  if (adopt) for (const [role, color] of Object.entries(roles) as [ColorRole, Color][]) tx.update(s.color[role], { fills: [solid(color)] });
  for (const { id, color } of layers) {
    let best: ColorRole | null = null;
    for (const [role, c] of Object.entries(roles) as [ColorRole, Color][]) if (distance(color, c) <= NEAR && (!best || distance(color, c) < distance(color, roles[best]!))) best = role;
    if (best) tx.update(id, { fills: cloneValue(doc.get(s.color[best], 'fills')), fillStyleId: s.color[best] });
  }
}

/**
 * A file opened with slides imported before BUG-140 (nothing bound to the theme's colours):
 * they are bound on opening, the theme taking their colours — the look stays, no undo step.
 */
export function bindOldSlides(doc: Document): void {
  if (!isSlides(doc)) return;
  const names = new Set(Object.values(COLOR_NAMES()));
  const styles = doc.children(doc.rootId).filter((id) => doc.type(id) === 'STYLE' && doc.get(id, 'styleType') === 'FILL' && names.has(doc.get(id, 'name')));
  if (styles.some((style) => styleUsers(doc, style).length)) return;
  const slides = doc.pages().flatMap((page) => slideIds(doc, page));
  if (!slides.length) return;
  doc.transact((tx) => bindSlideColors(doc, tx, slides));
  doc.clearHistory();
}

/** Restyles the whole file: the theme's styles take the theme's values, bound layers follow. */
export function applySlideTheme(editor: Editor, theme: SlideTheme): void {
  const doc = editor.doc;
  const k = typeScale(slideSize(doc, editor.pageId));
  editor.commit(tr('Тема: {0}', theme.name), (tx) => {
    // Imported slides first take the theme's styles, so the theme reaches them too.
    bindSlideColors(doc, tx, slideIds(doc, editor.pageId), currentTheme(doc));
    const s = themeStyles(doc, tx, theme, k);
    for (const role of Object.keys(s.color) as ColorRole[]) tx.update(s.color[role], { fills: paint(theme[role]) });
    for (const role of Object.keys(s.text) as TextRole[]) tx.update(s.text[role], textValues(theme, role, k));
    tx.set(doc.rootId, 'slideTheme', theme.id);
  });
}

export function currentTheme(doc: Document): SlideTheme {
  const id = doc.get(doc.rootId, 'slideTheme');
  return slideThemes().find((t) => t.id === id) ?? slideThemes()[0]!;
}

// ---------- layouts ----------

export type SlideLayout = 'title' | 'section' | 'titleText' | 'twoColumns' | 'imageText' | 'quote' | 'bigNumber' | 'threeCards' | 'blank';

export function slideLayouts(): { id: SlideLayout; name: string }[] {
  return [
    { id: 'title', name: tr('Титульный') },
    { id: 'titleText', name: tr('Заголовок и текст') },
    { id: 'twoColumns', name: tr('Две колонки') },
    { id: 'imageText', name: tr('Картинка и текст') },
    { id: 'threeCards', name: tr('Три карточки') },
    { id: 'section', name: tr('Раздел') },
    { id: 'quote', name: tr('Цитата') },
    { id: 'bigNumber', name: tr('Большая цифра') },
    { id: 'blank', name: tr('Пустой') },
  ];
}

const PAD = 128;

/**
 * Builds a slide of a layout after `after` (or at the end); returns its frame.
 * Texts and shapes are bound to the theme's styles.
 */
export function createSlide(doc: Document, tx: Transaction, page: NodeId, layout: SlideLayout, after?: NodeId | null): NodeId {
  const theme = currentTheme(doc);
  const size = slideSize(doc, page);
  const s = themeStyles(doc, tx, theme, typeScale(size));
  const slides = slideIds(doc, page);
  const index = after ? slides.indexOf(after) + 1 : slides.length;
  const at = gridPlace(index, size);
  const position = after ? { after } : slides.length ? { after: slides[slides.length - 1]! } : undefined;
  const name = slideLayouts().find((l) => l.id === layout)!.name;
  const frame = tx.create('FRAME', page, { name, x: at.x, y: at.y, width: size.w, height: size.h, clipsContent: true, fills: paint(theme.bg), fillStyleId: s.color.bg, slide: { notes: '' } }, position);
  const text = (role: TextRole, characters: string, x: number, y: number, width: number, color: ColorRole = role === 'caption' || role === 'subtitle' ? 'muted' : 'text', extra: Partial<NodeProps> = {}) => {
    const values: Record<string, unknown> = {};
    for (const k of TEXT_STYLE_KEYS) values[k] = doc.get(s.text[role], k);
    // A size or case of its own would be put back by the style: such a text keeps the theme's colour only.
    const own = Object.keys(extra).some((k) => (TEXT_STYLE_KEYS as readonly string[]).includes(k));
    return tx.create('TEXT', frame, { name: characters.split('\n')[0]!.slice(0, 40), characters, x, y, width, textAutoResize: 'HEIGHT', ...values, ...(own ? {} : { textStyleId: s.text[role] }), fills: paint(theme[color]), fillStyleId: s.color[color], ...extra });
  };
  const box = (x: number, y: number, width: number, height: number, name: string, role: ColorRole = 'surface', radius = 24) =>
    tx.create('RECTANGLE', frame, { name, x, y, width, height, cornerRadius: radius, fills: paint(theme[role]), fillStyleId: s.color[role] });
  const W = SLIDE_W - PAD * 2;
  switch (layout) {
    case 'title':
      box(PAD, 380, 12, 220, tr('Акцент'), 'accent', 6);
      text('title', tr('Название презентации'), PAD + 56, 360, W - 56);
      text('subtitle', tr('Подзаголовок, автор или дата'), PAD + 56, 540, W - 56);
      break;
    case 'section':
      text('caption', tr('Раздел 1'), PAD, 400, W, 'accent', { textCase: 'UPPER', letterSpacing: { unit: 'PERCENT', value: 8 } });
      text('title', tr('Название раздела'), PAD, 450, W);
      break;
    case 'titleText':
      text('heading', tr('Заголовок слайда'), PAD, PAD, W);
      text('body', tr('Главная мысль слайда в одном-двух предложениях.\nВторой абзац с подробностями, цифрами или примером.'), PAD, 320, 1200);
      break;
    case 'twoColumns': {
      const col = (W - 96) / 2;
      text('heading', tr('Сравнение'), PAD, PAD, W);
      text('subtitle', tr('Было'), PAD, 330, col, 'accent');
      text('body', tr('Что было до: проблема, старый способ, неудобство.'), PAD, 410, col);
      text('subtitle', tr('Стало'), PAD + col + 96, 330, col, 'accent');
      text('body', tr('Что стало после: решение, выгода, результат.'), PAD + col + 96, 410, col);
      break;
    }
    case 'imageText':
      box(0, 0, SLIDE_W / 2, SLIDE_H, tr('Картинка'), 'surface', 0);
      text('heading', tr('Заголовок'), SLIDE_W / 2 + 112, 300, SLIDE_W / 2 - 112 - PAD);
      text('body', tr('Пара предложений о том, что на картинке и почему это важно.'), SLIDE_W / 2 + 112, 520, SLIDE_W / 2 - 112 - PAD);
      break;
    case 'threeCards': {
      const cw = (W - 2 * 48) / 3;
      text('heading', tr('Три главных пункта'), PAD, PAD, W);
      [tr('Первый'), tr('Второй'), tr('Третий')].forEach((title, i) => {
        const x = PAD + i * (cw + 48);
        box(x, 340, cw, 600, tr('Карточка'));
        text('number', String(i + 1).padStart(2, '0'), x + 48, 380, cw - 96, 'accent', { fontSize: 72 });
        text('subtitle', title, x + 48, 520, cw - 96, 'text');
        text('caption', tr('Коротко о пункте: одна-две строки.'), x + 48, 600, cw - 96);
      });
      break;
    }
    case 'quote':
      text('number', '«', PAD, 140, 300, 'accent', { fontSize: 280, lineHeight: { unit: 'PERCENT', value: 100 } });
      text('heading', tr('Хорошая цитата говорит за слайд сама — коротко и точно.'), PAD + 40, 400, 1500, 'text', { fontWeight: 500 });
      text('caption', tr('— Имя Фамилия, должность'), PAD + 40, 760, 1200);
      break;
    case 'bigNumber':
      text('number', '87%', PAD, 260, W, 'accent');
      text('subtitle', tr('Что означает эта цифра — одной строкой'), PAD, 580, 1400, 'text');
      text('caption', tr('Источник: откуда данные, год'), PAD, 680, 1400);
      break;
    case 'blank':
      break;
  }
  // The layout is drawn for 1920 × 1080: another format takes its places (texts keep the theme's type).
  if (size.w !== SLIDE_W || size.h !== SLIDE_H) {
    const sx = size.w / SLIDE_W;
    const sy = size.h / SLIDE_H;
    const k = typeScale(size);
    for (const id of doc.children(frame)) {
      const isText = doc.type(id) === 'TEXT';
      tx.update(id, { x: Math.round(doc.get(id, 'x') * sx), y: Math.round(doc.get(id, 'y') * sy), width: Math.round(doc.get(id, 'width') * sx), ...(isText ? {} : { height: Math.round(doc.get(id, 'height') * sy) }) });
      // A size of its own (the big «01», the quote mark) shrinks as the theme's type does.
      if (isText && !doc.get(id, 'textStyleId')) tx.set(id, 'fontSize', Math.round(doc.get(id, 'fontSize') * k));
    }
  }
  return frame;
}

/**
 * The presentation of «Попробовать презентацию» (29 October: each kind has an example): the travel
 * app of the design example reports its launch — a title, three cards, a big number, before and
 * after, a quote, with the speaker's notes. In the «Океан» theme, as on the landing page.
 */
export function buildSlidesExample(editor: Editor): void {
  const doc = editor.doc;
  const page = editor.pageId;
  // The layout's texts in order, each replaced (null keeps the layout's own: the quote mark, the numbers).
  const deck: [SlideLayout, (string | null)[], string][] = [
    ['title', [tr('Тропа: итоги запуска'), tr('Приложение для путешествий по России · октябрь 2026')], tr('Здороваемся и коротко: за квартал приложение вышло, выросло и понравилось людям. Дальше — по цифрам.')],
    ['threeCards', [tr('Что сделали за квартал'), null, tr('Запуск'), tr('Приложение вышло в обоих магазинах.'), null, tr('Рост'), tr('Аудитория выросла в три раза.'), null, tr('Отзывы'), tr('Средняя оценка — 4,8 из 5.')], tr('По карточке на месяц: запуск, рост, отзывы.')],
    ['bigNumber', [null, tr('пользователей возвращаются через неделю'), tr('Источник: аналитика приложения, октябрь 2026')], tr('Главная цифра: люди возвращаются, значит маршруты им нужны.')],
    ['twoColumns', [tr('Было и стало'), tr('До запуска'), tr('Маршрут собирали в таблицах, бронировали по телефону.'), tr('Сейчас'), tr('Маршрут и бронь — в одном приложении за пару минут.')], tr('Что поменялось для путешественника.')],
    ['quote', [null, tr('Наконец-то поездка собирается за вечер, а не за неделю.'), tr('— Анна, путешествует из Казани')], tr('Отзыв из магазина приложений — читаем вслух.')],
  ];
  editor.commit(tr('Пример'), (tx) => {
    const first = slideIds(doc, page)[0];
    let after: NodeId | null = null;
    deck.forEach(([layout, texts, notes], i) => {
      // The new file's own title slide is the first one.
      const slide: NodeId = i === 0 && first ? first : createSlide(doc, tx, page, layout, after);
      const own = doc.children(slide).filter((id) => doc.type(id) === 'TEXT');
      texts.forEach((text, k) => {
        const id = own[k];
        if (id && text !== null) tx.update(id, { characters: text, name: text.split('\n')[0]!.slice(0, 40) });
      });
      tx.set(slide, 'slide', { notes });
      after = slide;
    });
  });
  const ocean = slideThemes().find((t) => t.id === 'ocean');
  if (ocean) applySlideTheme(editor, ocean);
}

/**
 * Changes the format of every slide: each one's content is scaled as a whole (text,
 * strokes, radii — the scale tool's way) to fit the new size, centred; the theme's
 * type follows. One undo step; the grid closes up by itself.
 */
export function setSlideFormat(editor: Editor, size: SlideSize): void {
  const doc = editor.doc;
  const page = editor.pageId;
  const slides = slideIds(doc, page);
  const now = slideSize(doc, page);
  if (!slides.length || (now.w === size.w && now.h === size.h)) return;
  editor.commit(tr('Формат слайдов'), (tx) => {
    for (const id of slides) fitSlide(doc, tx, id, size);
    // The theme's text styles: the same scale as the slides' content, so bound texts and their styles agree.
    const k = Math.min(size.w / now.w, size.h / now.h);
    for (const name of Object.values(TEXT_NAMES())) {
      const style = doc.children(doc.rootId).find((id) => doc.type(id) === 'STYLE' && doc.get(id, 'styleType') === 'TEXT' && doc.get(id, 'name') === name);
      if (style) tx.update(style, { fontSize: Math.round(doc.get(style, 'fontSize') * k), paragraphSpacing: Math.round(doc.get(style, 'paragraphSpacing') * k) });
    }
  });
}

/** The format of a size, or null for a size of its own (an import). */
export function formatOf(size: SlideSize): ReturnType<typeof slideFormats>[number] | null {
  return slideFormats().find((f) => f.size.w === size.w && f.size.h === size.h) ?? null;
}

/** A new presentation: the theme's styles and a title slide (none when `empty` — an import fills it). */
export function createSlidesDocument(name: string, empty = false): Document {
  const doc = Document.createEmpty(name);
  doc.transact((tx) => {
    tx.update(doc.rootId, { fileKind: 'SLIDES', slideTheme: 'light' });
    const page = doc.pages()[0]!;
    tx.update(page, { name: tr('Слайды'), backgroundColor: { r: 0.93, g: 0.93, b: 0.94, a: 1 } });
    if (empty) themeStyles(doc, tx, slideThemes()[0]!);
    else createSlide(doc, tx, page, 'title');
  });
  doc.clearHistory();
  return doc;
}
