// «Сравнить изменения» (step 7, Dev Mode «Compare changes»): what happened to
// one frame (any layer with everything inside) since a saved version — which
// layers were added, removed, moved, and for each changed one which properties,
// as they were and as they are; and the code of the frame then and now, line by
// line. Node ids are the same in every version of a file, so layers are matched
// by id. Pure functions over two documents; the window is ui/compare-dialog.ts.

import { colorToHex, tr, valueEquals, type Color, type Document, type Effect, type NodeId, type Paint, type PropKey } from '#core';
import { layerCode, type CodeLang, type CodeOptions, DEFAULT_CODE_OPTIONS } from './dev-code.ts';

export interface PropChange {
  key: PropKey;
  label: string;
  before: string;
  after: string;
}

export interface LayerChange {
  id: NodeId;
  name: string;
  /** Depth under the compared layer (0 — itself), for indenting the list. */
  depth: number;
  kind: 'added' | 'removed' | 'changed';
  /** Moved to another parent or to another place among its neighbours. */
  moved: boolean;
  props: PropChange[];
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Properties a developer does not read, or that change on every edit without a visible difference. */
const SKIP = new Set<string>(['deleted', 'aiSource', 'parkedOverrides', 'embeddedFonts', 'movedFrom', 'layerKey', 'componentKey', 'boardAuthors']);

const LABELS: Record<string, string> = {
  name: 'Название', visible: 'Видимость', locked: 'Закреплён', opacity: 'Непрозрачность', blendMode: 'Режим наложения',
  x: 'X', y: 'Y', width: 'Ширина', height: 'Высота', rotation: 'Поворот',
  fills: 'Заливка', strokes: 'Обводка', strokeWeight: 'Толщина обводки', strokeWeights: 'Толщина обводки по сторонам', strokeAlign: 'Положение обводки', dashPattern: 'Пунктир',
  effects: 'Эффекты', cornerRadius: 'Скругление', cornerRadii: 'Скругление углов', cornerSmoothing: 'Сглаживание углов', clipsContent: 'Обрезать содержимое',
  constraints: 'Привязки', layoutMode: 'Адаптивная раскладка', layoutWrap: 'Перенос', itemSpacing: 'Промежуток', counterAxisSpacing: 'Промежуток между строками',
  paddingTop: 'Отступ сверху', paddingRight: 'Отступ справа', paddingBottom: 'Отступ снизу', paddingLeft: 'Отступ слева',
  primaryAlign: 'Выравнивание по главной оси', counterAlign: 'Выравнивание поперёк', sizingH: 'Ширина в раскладке', sizingV: 'Высота в раскладке',
  minWidth: 'Мин. ширина', maxWidth: 'Макс. ширина', minHeight: 'Мин. высота', maxHeight: 'Макс. высота', positioning: 'Положение в раскладке',
  characters: 'Текст', fontFamily: 'Шрифт', fontWeight: 'Начертание', italic: 'Курсив', fontSize: 'Размер шрифта', lineHeight: 'Интерлиньяж',
  letterSpacing: 'Межбуквенный интервал', paragraphSpacing: 'Интервал между абзацами', textRuns: 'Стили части текста', textAlignH: 'Выравнивание текста',
  textAlignV: 'Выравнивание по вертикали', textAutoResize: 'Размер текста', textCase: 'Регистр', textDecoration: 'Оформление текста',
  fillStyleId: 'Стиль заливки', strokeStyleId: 'Стиль обводки', effectStyleId: 'Стиль эффектов', textStyleId: 'Стиль текста', gridStyleId: 'Стиль сетки',
  mainComponent: 'Компонент', overrides: 'Изменения копии', propValues: 'Свойства копии', componentProps: 'Свойства компонента',
  boundVariables: 'Переменные', variableModes: 'Режимы переменных', reactions: 'Связи прототипа', exportSettings: 'Экспорт',
  layoutGrids: 'Сетки', annotations: 'Аннотации', devStatus: 'Статус', description: 'Описание', vectorPaths: 'Контур', vectorNetwork: 'Контур',
  isMask: 'Маска', booleanOp: 'Булева операция', pointCount: 'Число вершин', innerRadius: 'Внутренний радиус', arc: 'Дуга', code: 'Код слоя',
  keyframes: 'Ключевые кадры', motion: 'Анимация', table: 'Таблица',
};

export function propLabel(key: string): string {
  const label = LABELS[key];
  return label ? tr(label) : key;
}

const num = (n: number) => String(Math.round(n * 100) / 100);
const short = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const isColor = (v: unknown): v is Color => !!v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v && 'a' in v;

function colorText(c: Color, opacity = 1): string {
  const a = c.a * opacity;
  return a < 1 ? `${colorToHex(c)} ${Math.round(a * 100)}%` : colorToHex(c);
}

function paintText(p: Paint): string {
  const off = p.visible === false ? ` (${tr('скрыта')})` : '';
  if (p.type === 'SOLID') return colorText(p.color, p.opacity) + off;
  if (p.type === 'IMAGE') return tr('Картинка') + off;
  if (p.type === 'PATTERN') return tr('Узор') + off;
  const stops = p.stops.map((s) => colorToHex(s.color)).join(' → ');
  return `${tr('Градиент')} ${stops}${off}`;
}

function effectText(e: Effect): string {
  const names: Record<string, string> = { DROP_SHADOW: 'Тень', INNER_SHADOW: 'Внутренняя тень', LAYER_BLUR: 'Размытие', BACKGROUND_BLUR: 'Размытие фона', NOISE: 'Шум', GLASS: 'Стекло', TEXTURE: 'Текстура' };
  const name = tr(names[e.type] ?? e.type);
  const off = e.visible === false ? ` (${tr('скрыт')})` : '';
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') return `${name} ${num(e.offset.x)} ${num(e.offset.y)} ${num(e.radius)} ${colorText(e.color)}${off}`;
  if ('radius' in e && typeof e.radius === 'number') return `${name} ${num(e.radius)}${off}`;
  return name + off;
}

/** A value as a person reads it: numbers rounded, colours as hex, paints and effects by kind, references by the referenced name. */
export function valueText(doc: Document, key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'number') return num(value);
  if (typeof value === 'boolean') return value ? tr('да') : tr('нет');
  if (typeof value === 'string') {
    // Ids of styles, components and the like: their names.
    if (/StyleId$/.test(key) || key === 'mainComponent') return doc.store.isAlive(value) ? String(doc.get(value, 'name') ?? value) : tr('удалён');
    return short(key === 'characters' ? `«${value}»` : value);
  }
  if (isColor(value)) return colorText(value);
  if (Array.isArray(value)) {
    if (!value.length) return tr('нет');
    if (key === 'fills' || key === 'strokes') return (value as Paint[]).map(paintText).join(', ');
    if (key === 'effects') return (value as Effect[]).map(effectText).join(', ');
    if (value.every((v) => typeof v === 'number')) return value.map((v: number) => num(v)).join(', ');
    return tr('{0} шт.', value.length);
  }
  if (key === 'lineHeight' || key === 'letterSpacing') {
    const v = value as { value?: number; unit?: string };
    if (v.unit === 'AUTO') return tr('авто');
    if (typeof v.value === 'number') return v.unit === 'PERCENT' ? `${num(v.value)}%` : `${num(v.value)}px`;
  }
  if (key === 'cornerRadii' || key === 'strokeWeights') return Object.values(value as Record<string, number>).map((v) => (typeof v === 'number' ? num(v) : '?')).join(', ');
  return short(JSON.stringify(value));
}

function subtree(doc: Document, root: NodeId): Map<NodeId, number> {
  const out = new Map<NodeId, number>();
  if (!doc.store.isAlive(root)) return out;
  const walk = (id: NodeId, depth: number) => {
    out.set(id, depth);
    for (const c of doc.children(id)) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Layer by layer, what differs in `root` between `before` (a version) and `after` (now). Ordered as in the layers panel of `after`, removed ones where they were. */
export function compareLayer(before: Document, after: Document, root: NodeId): LayerChange[] {
  const a = subtree(before, root);
  const b = subtree(after, root);
  const out: LayerChange[] = [];
  const name = (d: Document, id: NodeId) => String(d.get(id, 'name') ?? '') || tr('Без названия');
  for (const [id, depth] of b) {
    if (!a.has(id)) {
      out.push({ id, name: name(after, id), depth, kind: 'added', moved: false, props: [] });
      continue;
    }
    const was = before.store.record(id)!;
    const now = after.store.record(id)!;
    const keys = new Set([...Object.keys(was.props), ...Object.keys(now.props)]);
    const props: PropChange[] = [];
    for (const key of keys) {
      if (SKIP.has(key)) continue;
      const x = before.get(id, key as PropKey);
      const y = after.get(id, key as PropKey);
      if (valueEquals(x, y)) continue;
      const bt = valueText(before, key, x);
      let at = valueText(after, key, y);
      // Two values that read the same (a tiny shift, a hidden detail) still differ: say so.
      if (bt === at) at = `${at} (${tr('изменено')})`;
      props.push({ key: key as PropKey, label: propLabel(key), before: bt, after: at });
    }
    props.sort((p, q) => order(p.key) - order(q.key));
    const moved = id !== root && (was.parent !== now.parent || was.index !== now.index);
    if (props.length || moved) out.push({ id, name: name(after, id), depth, kind: 'changed', moved, props });
  }
  // Removed: right after their former parent's row (or at the end).
  for (const [id, depth] of a) {
    if (b.has(id)) continue;
    const change: LayerChange = { id, name: name(before, id), depth, kind: 'removed', moved: false, props: [] };
    const parent = before.parent(id);
    const at = parent ? out.findIndex((c) => c.id === parent) : -1;
    if (at >= 0) out.splice(at + 1, 0, change);
    else out.push(change);
  }
  return out;
}

const ORDER = Object.keys(LABELS);
const order = (key: string) => {
  const i = ORDER.indexOf(key);
  return i < 0 ? ORDER.length : i;
};

/** Line diff (longest common subsequence): every line of both texts, marked kept, added or removed. Long texts — compared by blocks around the changed middle. */
export function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const x = beforeText ? beforeText.split('\n') : [];
  const y = afterText ? afterText.split('\n') : [];
  // Same start and end are kept as they are; only the middle is compared.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const head: DiffLine[] = x.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = x.slice(x.length - end).map((text) => ({ kind: 'same', text }));
  const xm = x.slice(start, x.length - end);
  const ym = y.slice(start, y.length - end);
  let middle: DiffLine[];
  if (xm.length * ym.length > 4_000_000) {
    middle = [...xm.map((text) => ({ kind: 'removed' as const, text })), ...ym.map((text) => ({ kind: 'added' as const, text }))];
  } else {
    const n = xm.length;
    const m = ym.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = xm[i] === ym[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) {
        middle.push({ kind: 'same', text: xm[i]! });
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) middle.push({ kind: 'removed', text: xm[i++]! });
      else middle.push({ kind: 'added', text: ym[j++]! });
    }
    while (i < n) middle.push({ kind: 'removed', text: xm[i++]! });
    while (j < m) middle.push({ kind: 'added', text: ym[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/** The layer's code (with everything inside) then and now, line by line. A layer missing on one side gives all lines added or removed. */
export function compareCode(before: Document, after: Document, root: NodeId, lang: CodeLang, o: CodeOptions = DEFAULT_CODE_OPTIONS): DiffLine[] {
  const code = (d: Document) => (d.store.isAlive(root) ? layerCode(d, root, lang, o, true) : '');
  return diffLines(code(before), code(after));
}

/** Whether anything inside the layer differs between two documents (to find the latest version with changes). */
export function layerDiffers(before: Document, after: Document, root: NodeId): boolean {
  if (before.store.isAlive(root) !== after.store.isAlive(root)) return true;
  return compareLayer(before, after, root).length > 0;
}
