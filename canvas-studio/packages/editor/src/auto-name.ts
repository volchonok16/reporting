// Rename layers (October list, "AI without AI"): meaningful names from simple
// rules instead of a language model. Only layers with a default name ("Frame 3",
// "Rectangle 23", "Text", an HTML tag after an import) are renamed — a name a
// person gave is never touched. Children are named first, so a parent can use
// them: a frame with one short label becomes «Кнопка „В корзину“».

import { isFrameLike, tr, type Document, type NodeId } from '#core';

const DEFAULT_NAME = /^(Frame|Section|Component|Group|Rectangle|Ellipse|Polygon|Star|Vector|Line|Arrow|Text|Union|Subtract|Intersect|Exclude|Image|Instance|Mask group|Слой|Фрейм|Секция|Компонент|Группа|Группа с маской|Прямоугольник|Эллипс|Многоугольник|Звезда|Вектор|Линия|Стрелка|Текст|Объединение|Вычитание|Пересечение|Исключение|Изображение|Копия)( \d+)?$/i;
const HTML_TAG = /^(div|span|section|article|header|footer|main|nav|aside|p|a|li|ul|ol|img|svg|button|label|form|input|figure|picture|h[1-6]|body|html|i|b|strong|em|small)$/i;
/**
 * The HTML import's names (runtime.ts nameOf): «div.card», «section#hero», «div.card.big»,
 * «::before», the import's helpers («border», «background», «icon», «chevron», «marker», «spacer»), «img: Логотип», «nav — Главное меню» — the markup's, not a person's.
 */
const TAGS =
  'a|abbr|address|article|aside|b|blockquote|body|button|caption|code|dd|del|details|dialog|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|html|i|img|input|ins|kbd|label|legend|li|main|mark|menu|meter|nav|ol|output|p|picture|pre|progress|q|s|samp|section|select|small|span|strong|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|time|tr|u|ul|var|video|canvas|iframe';
const HTML_NAME = new RegExp(`^(?:(?:${TAGS})(?:[#.][a-z_-][\\w-]*)+|(?:${TAGS})|::(?:before|after|marker)|border(?:-(?:top|right|bottom|left))?|background|icon|chevron|marker|spacer|img: .*|(?:${TAGS})(?:[#.][a-z_-][\\w-]*)* — .*)$`, 'i');

export function isDefaultName(name: string): boolean {
  const n = name.trim();
  return n === '' || DEFAULT_NAME.test(n) || HTML_TAG.test(n) || HTML_NAME.test(n);
}

const quote = (s: string) => `«${s}»`;
/** First line of a text, trimmed to a readable length. */
function shortText(text: string, max = 32): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

interface Info {
  /** All visible text layers inside, in order, with their size. */
  texts: { id: NodeId; text: string; size: number }[];
  hasImage: boolean;
  vectorsOnly: boolean;
  children: NodeId[];
}

export function suggestNames(doc: Document, roots: readonly NodeId[]): Map<NodeId, string> {
  const out = new Map<NodeId, string>();
  const name = (id: NodeId) => out.get(id) ?? doc.get(id, 'name');
  const visible = (id: NodeId) => doc.get(id, 'visible');
  const hasImageFill = (id: NodeId) => doc.get(id, 'fills').some((p) => p.visible && p.type === 'IMAGE');
  const hasFill = (id: NodeId) => doc.get(id, 'fills').some((p) => p.visible && p.opacity > 0);
  const hasStroke = (id: NodeId) => doc.get(id, 'strokes').some((p) => p.visible);
  const rounded = (id: NodeId) => doc.get(id, 'cornerRadius') > 0 || !!doc.get(id, 'cornerRadii');
  const shadow = (id: NodeId) => doc.get(id, 'effects').some((e) => e.visible && e.type === 'DROP_SHADOW');

  const info = (id: NodeId): Info => {
    const texts: Info['texts'] = [];
    let hasImage = false;
    let vectors = 0;
    let other = 0;
    const walk = (n: NodeId) => {
      if (!visible(n)) return;
      const t = doc.type(n);
      if (t === 'TEXT') {
        const text = doc.get(n, 'characters').trim();
        if (text) texts.push({ id: n, text, size: doc.get(n, 'fontSize') });
        other++;
      } else if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION' || t === 'STAR' || t === 'POLYGON' || t === 'LINE') vectors++;
      if (hasImageFill(n)) hasImage = true;
      for (const c of doc.children(n)) walk(c);
    };
    for (const c of doc.children(id)) walk(c);
    if (hasImageFill(id)) hasImage = true;
    return { texts, hasImage, vectorsOnly: vectors > 0 && other === 0 && !hasImage, children: doc.children(id).filter(visible) };
  };

  /** Structure of a layer, to spot repeated siblings (list items, cards). */
  const signature = (id: NodeId): string => `${doc.type(id)}:${doc.get(id, 'layoutMode')}:${doc.children(id).map((c) => doc.type(c)).join(',')}`;

  const nameOf = (id: NodeId): string | null => {
    const t = doc.type(id);
    const w = doc.get(id, 'width');
    const h = doc.get(id, 'height');
    if (t === 'TEXT') {
      const text = shortText(doc.get(id, 'characters'));
      return text || null;
    }
    if (t === 'LINE' || ((t === 'RECTANGLE' || t === 'FRAME') && !doc.children(id).length && (h <= 2 || w <= 2))) return tr('Разделитель');
    if (hasImageFill(id) && !doc.children(id).length) return t === 'ELLIPSE' || (rounded(id) && Math.abs(w - h) < 1 && doc.get(id, 'cornerRadius') >= w / 2 - 0.5) ? tr('Аватар') : tr('Изображение');
    if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION' || t === 'STAR' || t === 'POLYGON') return Math.max(w, h) <= 48 ? tr('Иконка') : tr('Иллюстрация');
    if (t === 'RECTANGLE' || t === 'ELLIPSE') {
      // A shape under everything else in its parent, as big as the parent: the background.
      const parent = doc.parent(id);
      if (parent && doc.children(parent)[0] === id && doc.type(parent) !== 'PAGE' && w >= doc.get(parent, 'width') - 1 && h >= doc.get(parent, 'height') - 1) return tr('Фон');
      if (t === 'ELLIPSE' && Math.max(w, h) <= 16) return tr('Индикатор');
      return null;
    }
    if (!isFrameLike(t) && t !== 'GROUP') return null;

    const i = info(id);
    const top = doc.parent(id);
    const onPage = top !== null && (doc.type(top) === 'PAGE' || doc.type(top) === 'SECTION');
    if (i.vectorsOnly && Math.max(w, h) <= 48) return tr('Иконка');
    if (i.vectorsOnly) return tr('Иллюстрация');
    const words = i.texts.length === 1 ? i.texts[0]!.text.split(/\s+/).length : 0;

    // Only buttons inside: a group of buttons.
    if (i.children.length >= 2 && i.children.every((c) => name(c).startsWith(tr('Кнопка')))) return tr('Кнопки');
    // Repeated siblings: a list.
    if (i.children.length >= 3 && new Set(i.children.map(signature)).size === 1 && doc.children(i.children[0]!).length > 0) return tr('Список');
    const heading = [...i.texts].sort((a, b) => b.size - a.size)[0];
    // A screen: a top-level frame, named by its biggest text.
    if (onPage && isFrameLike(t)) return heading ? tr('Экран {0}', quote(shortText(heading.text, 24))) : tr('Экран');
    // Header and footer: a full-width strip at the top or the bottom of a screen.
    if (top && isFrameLike(doc.type(top)) && onPageScreen(doc, top)) {
      const pw = doc.get(top, 'width');
      const ph = doc.get(top, 'height');
      const y = doc.get(id, 'y');
      // A thin strip across is a bar, not a header or a footer (an accent line of 4 px at the top).
      if (w >= pw - 1 && h < 24 && !i.texts.length) return tr('Полоса');
      if (w >= pw - 1 && h <= 120 && y <= 1) return tr('Шапка');
      if (w >= pw - 1 && h <= 120 && y + h >= ph - 1) return i.texts.length >= 3 && i.children.length >= 3 ? tr('Таббар') : tr('Подвал');
    }
    // A short label in a small box with a fill or a border, narrower than its parent: a button.
    const narrow = !top || doc.type(top) === 'PAGE' || w < doc.get(top, 'width') * 0.7;
    if (!onPage && narrow && i.texts.length === 1 && words <= 4 && h <= 64 && (hasFill(id) || hasStroke(id)) && i.children.length <= 3) return tr('Кнопка {0}', quote(shortText(i.texts[0]!.text, 24)));
    // An image with text in a box with a fill, rounding or a shadow: a card.
    if (i.hasImage && heading && (hasFill(id) || rounded(id) || shadow(id))) return tr('Карточка {0}', quote(shortText(heading.text, 24)));
    // A box with a border around one short text: an input field.
    if (hasStroke(id) && i.texts.length === 1 && h <= 56 && w >= 120 && words <= 6) return tr('Поле {0}', quote(shortText(i.texts[0]!.text, 24)));
    if (heading) return t === 'GROUP' ? tr('Группа {0}', quote(shortText(heading.text, 24))) : tr('Блок {0}', quote(shortText(heading.text, 24)));
    return null;
  };

  const visit = (id: NodeId) => {
    const t = doc.type(id);
    // Layers of an instance follow their component: renaming them would be an override.
    if (t === 'INSTANCE') return;
    for (const c of doc.children(id)) visit(c);
    if (t === 'PAGE' || t === 'DOCUMENT' || t === 'COMPONENT' || t === 'COMPONENT_SET') return;
    if (!isDefaultName(doc.get(id, 'name'))) return;
    const next = nameOf(id);
    if (next && next !== doc.get(id, 'name')) out.set(id, next);
  };
  for (const r of roots) visit(r);

  // Repeated siblings with the same new name get numbers: «Пункт 1», «Пункт 2».
  const byParent = new Map<NodeId | null, NodeId[]>();
  for (const id of out.keys()) {
    const p = doc.parent(id);
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  for (const ids of byParent.values()) {
    const counts = new Map<string, NodeId[]>();
    for (const id of ids) counts.set(out.get(id)!, [...(counts.get(out.get(id)!) ?? []), id]);
    for (const [base, same] of counts) if (same.length > 1 && doc.type(same[0]!) !== 'TEXT') same.forEach((id, k) => out.set(id, `${base} ${k + 1}`));
  }
  return out;
}

/** A top-level frame (a screen) or a frame right inside one. */
function onPageScreen(doc: Document, id: NodeId): boolean {
  const p = doc.parent(id);
  return p !== null && (doc.type(p) === 'PAGE' || doc.type(p) === 'SECTION');
}
