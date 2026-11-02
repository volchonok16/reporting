// The "Code" tab of the right panel (section 14, FR-DEV): what a developer
// needs from a layer without touching the design — sizes and distances to the
// parent, colours with their variables and styles, typography, the code
// (CSS, SwiftUI, Jetpack Compose) and the layer as PNG or SVG. With nothing
// selected: the frames and sections marked "Ready for development" and the
// file's variables as CSS. Every value is copied with a click; the tab is the
// same for viewers (nothing here changes the file).

import { colorToHex, isFrameLike, tr, type ExportSetting, type NodeId, type Paint } from '#core';
import { cssColor, cssDecls, cssVarName, DEFAULT_CODE_OPTIONS, formatCss, layerCode, variablesCss, type CodeLang, type CodeOptions } from '../dev-code.ts';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

export interface CodePanelHost {
  editor: Editor;
  section(title: string, ...actions: HTMLElement[]): HTMLElement;
  /** Downloads the selected layer with these settings. */
  exportAs(setting: ExportSetting): void;
}

const LANG_KEY = 'cs.code-lang';
const UNIT_KEY = 'cs.code-unit';
const TREE_KEY = 'cs.code-tree';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

function savedLang(): CodeLang {
  const v = read(LANG_KEY);
  return v === 'swiftui' || v === 'compose' ? v : 'css';
}
function savedOptions(): CodeOptions {
  return { ...DEFAULT_CODE_OPTIONS, unit: read(UNIT_KEY) === 'rem' ? 'rem' : 'px' };
}

/** «Copy as code → CSS» from the menu (as in Figma): each selected layer's CSS under its name, in the units chosen in the «Код» tab. */
export function selectionCss(editor: Editor): string {
  const o = savedOptions();
  return editor
    .topLevelSelection()
    .map((id) => {
      const { decls, comments } = cssDecls(editor.doc, id, o);
      return `/* ${String(editor.doc.get(id, 'name')).replace(/\*\//g, '* /')} */\n${formatCss(decls, comments)}`;
    })
    .join('\n\n');
}

const round = (n: number) => Math.round(n * 100) / 100;

async function copy(editor: Editor, text: string, what = tr('Скопировано')): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    editor.toast(what);
  } catch {
    editor.toast(tr('Не удалось скопировать: браузер не дал доступ к буферу обмена'), 'error');
  }
}

/** "Label   value" row; a click copies the value. */
function row(editor: Editor, label: string, value: string, extra?: HTMLElement | null): HTMLElement {
  return h(
    'button',
    { class: 'code-row', type: 'button', title: tr('Скопировать'), onclick: () => void copy(editor, value) },
    h('span', { class: 'code-label' }, label),
    extra ?? null,
    h('span', { class: 'code-value' }, value),
  );
}

const TYPE_NAMES: Record<string, string> = {
  FRAME: 'Фрейм', SECTION: 'Секция', COMPONENT: 'Компонент', COMPONENT_SET: 'Набор вариантов', INSTANCE: 'Копия компонента', GROUP: 'Группа', RECTANGLE: 'Прямоугольник',
  ELLIPSE: 'Эллипс', POLYGON: 'Многоугольник', STAR: 'Звезда', VECTOR: 'Вектор', BOOLEAN_OPERATION: 'Булева операция', LINE: 'Линия', TEXT: 'Текст',
};

export function buildCodePanel(host: CodePanelHost): void {
  const { editor } = host;
  const ids = editor.selection;
  if (ids.length === 0) return buildOverview(host);
  if (ids.length > 1) {
    host.section(tr('Выделено слоёв: {0}', ids.length)).append(h('p', { class: 'code-empty' }, tr('Код показывается для одного слоя.')));
    return;
  }
  const id = ids[0]!;
  const d = editor.doc;
  const type = d.type(id);

  // Size and place.
  const size = host.section(String(d.get(id, 'name')) || tr('Слой'));
  size.append(h('div', { class: 'code-kind' }, tr(TYPE_NAMES[type] ?? type)));
  const b = editor.scene.bounds(id);
  size.append(
    h('div', { class: 'code-grid' }, row(editor, tr('Ширина'), `${round(d.get(id, 'width'))}px`), row(editor, tr('Высота'), `${round(d.get(id, 'height'))}px`), row(editor, 'X', `${round(d.get(id, 'x'))}px`), row(editor, 'Y', `${round(d.get(id, 'y'))}px`)),
  );
  const parent = d.parent(id);
  if (parent && d.type(parent) !== 'PAGE' && isFrameLike(d.type(parent))) {
    const p = editor.scene.bounds(parent);
    const sides: [string, number][] = [
      [tr('Слева'), b.x - p.x],
      [tr('Сверху'), b.y - p.y],
      [tr('Справа'), p.x + p.width - (b.x + b.width)],
      [tr('Снизу'), p.y + p.height - (b.y + b.height)],
    ];
    size.append(h('div', { class: 'code-sub' }, tr('До краёв «{0}»', String(d.get(parent, 'name')))), h('div', { class: 'code-grid' }, ...sides.map(([l, v]) => row(editor, l, `${round(v)}px`))));
  }
  if (round(d.get(id, 'rotation')) !== 0) size.append(row(editor, tr('Поворот'), `${round(d.get(id, 'rotation'))}°`));
  if (d.get(id, 'opacity') < 1) size.append(row(editor, tr('Прозрачность'), `${Math.round(d.get(id, 'opacity') * 100)}%`));

  // Auto layout.
  if (d.get(id, 'layoutMode') !== 'NONE') {
    const al = host.section(tr('Адаптивная раскладка'));
    al.append(row(editor, tr('Направление'), d.get(id, 'layoutMode') === 'HORIZONTAL' ? tr('По горизонтали') : d.get(id, 'layoutMode') === 'GRID' ? tr('Сеткой: {0} × {1}', d.get(id, 'gridColumns').length, Math.max(d.get(id, 'gridRows').length, 1)) : tr('По вертикали')));
    if (d.get(id, 'layoutMode') === 'GRID') al.append(row(editor, tr('Между строками и столбцами'), `${round(d.get(id, 'gridRowGap'))}px / ${round(d.get(id, 'gridColumnGap'))}px`));
    else if (d.get(id, 'spacingMode') === 'FIXED') al.append(row(editor, tr('Между элементами'), `${round(d.get(id, 'itemSpacing'))}px`));
    else al.append(row(editor, tr('Между элементами'), tr('Авто')));
    const pads = (['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const).map((k) => round(d.get(id, k)));
    al.append(row(editor, tr('Отступы'), pads.every((v) => v === pads[0]) ? `${pads[0]}px` : pads.map((v) => `${v}px`).join(' ')));
  }

  // Typography.
  if (type === 'TEXT') {
    const text = host.section(tr('Типографика'));
    const style = d.get(id, 'textStyleId');
    if (style && d.store.isAlive(style)) text.append(row(editor, tr('Стиль'), String(d.get(style, 'name'))));
    const lh = d.get(id, 'lineHeight');
    const ls = d.get(id, 'letterSpacing');
    text.append(
      row(editor, tr('Шрифт'), d.get(id, 'fontFamily')),
      row(editor, tr('Начертание'), `${d.get(id, 'fontWeight')}${d.get(id, 'italic') ? ' italic' : ''}`),
      row(editor, tr('Размер'), `${round(d.get(id, 'fontSize'))}px`),
      row(editor, tr('Интерлиньяж'), lh.unit === 'AUTO' ? tr('Авто') : lh.unit === 'PX' ? `${round(lh.value)}px` : lh.unit === 'PERCENT' ? `${round(lh.value)}%` : `×${round(lh.value)}`),
      row(editor, tr('Межбуквенный'), ls.value ? (ls.unit === 'PERCENT' ? `${round(ls.value)}%` : `${round(ls.value)}px`) : '0'),
    );
    const content = d.get(id, 'characters');
    text.append(row(editor, tr('Текст'), content.length > 60 ? `${content.slice(0, 60)}…` : content));
    // The whole text, not the cut one, goes to the clipboard.
    (text.lastElementChild as HTMLElement).onclick = () => void copy(editor, content);
  }

  // Colours: fills and strokes with their variables and styles.
  const colours: HTMLElement[] = [];
  const paintRows = (key: 'fills' | 'strokes', label: string) => {
    d.get(id, key).forEach((paint: Paint, i: number) => {
      if (!paint.visible) return;
      const variable = d.get(id, 'boundVariables')?.[`${key}/${i}`];
      const styleId = d.get(id, key === 'fills' ? 'fillStyleId' : 'strokeStyleId');
      const name = variable && d.store.isAlive(variable) ? `${d.get(variable, 'name')} · ${cssVarName(d, variable)}` : styleId && d.store.isAlive(styleId) ? String(d.get(styleId, 'name')) : '';
      if (paint.type === 'SOLID') {
        const value = cssColor(paint.color, paint.opacity);
        const swatch = h('span', { class: 'code-swatch', style: { background: value } });
        const r = row(editor, label, paint.opacity * paint.color.a < 1 ? `${colorToHex(paint.color)} · ${Math.round(paint.opacity * paint.color.a * 100)}%` : colorToHex(paint.color), swatch);
        r.onclick = () => void copy(editor, value);
        colours.push(r);
      } else colours.push(row(editor, label, paint.type === 'IMAGE' ? tr('Картинка') : tr('Градиент')));
      if (name) colours.push(h('div', { class: 'code-note' }, name));
    });
  };
  paintRows('fills', type === 'TEXT' ? tr('Цвет текста') : tr('Заливка'));
  paintRows('strokes', tr('Обводка'));
  if (d.get(id, 'strokes').some((p) => p.visible)) colours.push(row(editor, tr('Толщина обводки'), `${round(d.get(id, 'strokeWeight'))}px`));
  const radius = d.get(id, 'cornerRadii') ?? (d.get(id, 'cornerRadius') ? [d.get(id, 'cornerRadius')] : null);
  if (radius && type !== 'TEXT') colours.push(row(editor, tr('Скругление'), radius.map((r) => `${round(r)}px`).join(' ')));
  for (const e of d.get(id, 'effects')) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') colours.push(row(editor, e.type === 'DROP_SHADOW' ? tr('Тень') : tr('Внутренняя тень'), `${round(e.offset.x)} ${round(e.offset.y)} ${round(e.radius)} ${cssColor(e.color)}`));
    else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') colours.push(row(editor, e.type === 'LAYER_BLUR' ? tr('Размытие') : tr('Размытие фона'), `${round(e.radius)}px`));
  }
  if (colours.length) host.section(tr('Оформление')).append(...colours);

  // Code.
  let lang = savedLang();
  let options = savedOptions();
  const hasChildren = d.children(id).some((c) => d.get(c, 'visible') !== false);
  let tree = hasChildren && read(TREE_KEY) === '1';
  const pre = h('pre', { class: 'code-block', tabIndex: 0 });
  /** The CSS option: "HTML + CSS" when the code takes nested layers. */
  let css: HTMLOptionElement;
  const render = () => {
    pre.textContent = layerCode(d, id, lang, options, tree) || tr('/* Нет свойств для кода */');
    unit.hidden = lang !== 'css';
    css.textContent = tree ? 'HTML + CSS' : 'CSS';
  };
  const select = h(
    'select',
    { class: 'field-select', 'aria-label': tr('Язык кода') },
    (css = h('option', { value: 'css' }, 'CSS')),
    h('option', { value: 'swiftui' }, 'SwiftUI'),
    h('option', { value: 'compose' }, 'Jetpack Compose'),
  );
  select.value = lang;
  select.addEventListener('change', () => {
    lang = select.value as CodeLang;
    write(LANG_KEY, lang);
    render();
  });
  const unit = h('select', { class: 'field-select code-unit', 'aria-label': tr('Единицы') }, h('option', { value: 'px' }, 'px'), h('option', { value: 'rem' }, 'rem'));
  unit.value = options.unit;
  unit.addEventListener('change', () => {
    options = { ...options, unit: unit.value === 'rem' ? 'rem' : 'px' };
    write(UNIT_KEY, options.unit);
    render();
  });
  const copyButton = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код'), 'aria-label': tr('Скопировать код'), onclick: () => void copy(editor, pre.textContent ?? '', tr('Код скопирован')) }, icon('copy', 14));
  const code = host.section(tr('Код'), copyButton);
  const deep = h('input', { type: 'checkbox', checked: tree });
  deep.addEventListener('change', () => {
    tree = deep.checked;
    write(TREE_KEY, tree ? '1' : '0');
    render();
  });
  code.append(h('div', { class: 'code-controls' }, h('div', { class: 'select-wrap' }, select), h('div', { class: 'select-wrap' }, unit)));
  if (hasChildren) code.append(h('label', { class: 'code-check' }, deep, h('span', {}, tr('Со вложенными слоями'))));
  code.append(pre);
  render();

  // Assets.
  const assets = host.section(tr('Скачать'));
  const button = (label: string, setting: ExportSetting) => h('button', { class: 'text-button', type: 'button', onclick: () => host.exportAs(setting) }, label);
  assets.append(
    h(
      'div',
      { class: 'code-assets' },
      button('PNG 1×', { format: 'PNG', scale: 1, suffix: '' }),
      button('PNG 2×', { format: 'PNG', scale: 2, suffix: '@2x' }),
      button('SVG', { format: 'SVG', scale: 1, suffix: '' }),
    ),
  );
}

/** Nothing selected: screens ready for development and the variables as CSS. */
function buildOverview(host: CodePanelHost): void {
  const { editor } = host;
  const d = editor.doc;
  const ready: NodeId[] = [];
  const visit = (id: NodeId) => {
    for (const child of d.children(id)) {
      if (d.get(child, 'devStatus') === 'READY_FOR_DEV') ready.push(child);
      if (d.type(child) === 'SECTION') visit(child);
    }
  };
  visit(editor.pageId);
  const list = host.section(tr('Готово к разработке'));
  if (ready.length === 0) list.append(h('p', { class: 'code-empty' }, tr('На странице нет секций со статусом «Готово к разработке».')));
  for (const id of ready) {
    list.append(
      h(
        'button',
        {
          class: 'code-row ready',
          type: 'button',
          onclick: () => {
            editor.setSelection([id]);
            editor.zoomToSelection();
          },
        },
        icon('frame', 14),
        h('span', { class: 'code-label' }, String(d.get(id, 'name'))),
      ),
    );
  }
  const vars = variablesCss(d);
  if (vars) {
    const copyButton = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код'), 'aria-label': tr('Скопировать код'), onclick: () => void copy(editor, vars, tr('Код скопирован')) }, icon('copy', 14));
    host.section(tr('Переменные в CSS'), copyButton).append(h('pre', { class: 'code-block', tabIndex: 0 }, vars));
  }
  host.section(tr('Слой')).append(h('p', { class: 'code-empty' }, tr('Выделите слой: здесь появятся его размеры, цвета и код.')));
}
