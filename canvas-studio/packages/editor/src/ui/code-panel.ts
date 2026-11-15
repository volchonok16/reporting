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
import { motionCss, motionJson } from '../motion/code.ts';
import { motionFrameOf } from '../motion/model.ts';
import { CODE_LANGUAGES, codeConnectOf, connectedCode, connectNames, connectOwner, connectValues, fillTemplate, setCodeConnect, starterTemplate } from '../code-connect.ts';
import { addResource, cleanResourceUrl, inheritedResources, removeResource, renameResource, resourceKind, resourcesOf } from '../dev-resources.ts';
import { ANNOTATION_CATEGORIES, annotationsOf, categoryColor, layerCss, liveMeasurements, measureText, removeAnnotation, removeMeasurements, safeCategory, setMeasurementNote, updateAnnotation, addAnnotation } from '../annotate.ts';

export interface CodePanelHost {
  editor: Editor;
  section(title: string, ...actions: HTMLElement[]): HTMLElement;
  /** Downloads the selected layer with these settings. */
  exportAs(setting: ExportSetting): void;
  /** Opens «Сравнить изменения» for the selected layer; null — not offered. */
  compareChanges?: (() => void) | null;
  /** Opens «Песочница компонента» for the selected component or instance; null — not offered. */
  openPlayground?: (() => void) | null;
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

/** The note whose text gets the focus when the panel is built next (a click on the canvas added or took it). */
let focusNext: { id: NodeId; index: number } | null = null;
/** Words being typed into a note: a rebuild of the panel (a co-editor's edit) keeps them and the caret. */
let draft: { id: NodeId; index: number; value: string; start: number; end: number } | null = null;

export function focusNote(id: NodeId, index: number): void {
  focusNext = { id, index };
}

/** A saved measurement picked on the canvas: its number, its words and «Удалить». */
function measurementSection(host: CodePanelHost): void {
  const { editor } = host;
  const picked = editor.measureSelected;
  if (!picked) return;
  const found = liveMeasurements(editor).find((x) => x.m.id === picked);
  if (!found) return;
  const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить замер (Delete)'), 'aria-label': tr('Удалить замер'), onclick: () => removeMeasurements(editor, [picked]) }, icon('minus', 14));
  const sec = host.section(tr('Замер'), remove);
  const d = editor.doc;
  sec.append(row(editor, tr('Расстояние'), `${round(found.line.value)}px`));
  sec.append(h('div', { class: 'code-sub' }, tr('От «{0}» до «{1}»', String(d.get(found.m.from, 'name')), String(d.get(found.m.to, 'name')))));
  const note = h('input', { class: 'dialog-input annotation-note', type: 'text', maxLength: 200, value: found.m.note, placeholder: tr('Подпись после числа, например «мин.»'), 'aria-label': tr('Подпись замера') });
  note.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') note.blur();
  });
  note.addEventListener('change', () => setMeasurementNote(editor, picked, note.value.trim()));
  sec.append(note);
}

/** Code Connect (step 7): an instance shows its component's real code filled in; a component edits its template. */
function connectSection(host: CodePanelHost, id: NodeId): void {
  const { editor } = host;
  const d = editor.doc;
  const owner = connectOwner(d, id);
  if (!owner) return;
  const type = d.type(id);
  const filled = connectedCode(d, id);
  const readOnly = d.readOnly;
  const sourceLine = (source: string) => {
    if (!source) return null;
    const link = cleanResourceUrl(source);
    return link
      ? h('a', { class: 'resource-link connect-source', href: link, target: '_blank', rel: 'noopener noreferrer', title: link }, icon('link', 14), h('span', { class: 'resource-name' }, source))
      : h('div', { class: 'code-sub connect-source' }, source);
  };
  const codeBlock = (code: string) => h('pre', { class: 'code-block connect-code', tabIndex: 0 }, code);

  // An instance (or a component without the template being edited): the code to copy.
  if (type === 'INSTANCE') {
    if (!filled) return;
    const copyButton = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код'), 'aria-label': tr('Скопировать код'), onclick: () => void copy(editor, filled.code, tr('Код скопирован')) }, icon('copy', 14));
    const sec = host.section(tr('Код из репозитория'), copyButton);
    const lang = CODE_LANGUAGES.find((l) => l.id === filled.connect.language)?.label ?? filled.connect.language;
    sec.append(h('div', { class: 'code-sub' }, tr('{0} · из компонента «{1}»', lang, String(d.get(filled.owner, 'name') ?? ''))), codeBlock(filled.code));
    const src = sourceLine(filled.connect.source);
    if (src) sec.append(src);
    return;
  }

  const connect = codeConnectOf(d, owner);
  if (readOnly && !connect) return;
  const sec = host.section(tr('Код из репозитория'));
  const names = connectNames(d, owner);
  const editorBox = h('div', { class: 'connect-form', hidden: true });
  const source = h('input', { class: 'dialog-input', type: 'text', placeholder: tr('Путь или ссылка: src/ui/Button.tsx'), 'aria-label': tr('Где лежит код'), maxLength: 2000, spellcheck: false, value: connect?.source ?? '' });
  const language = h('select', { class: 'field-select', 'aria-label': tr('Язык') }, ...CODE_LANGUAGES.map((l) => h('option', { value: l.id }, l.label)));
  language.value = connect?.language ?? 'tsx';
  const template = h('textarea', { class: 'dialog-input connect-template', rows: 6, spellcheck: false, 'aria-label': tr('Шаблон кода'), maxLength: 20000 });
  template.value = connect?.template ?? starterTemplate(d, owner);
  const preview = codeBlock('');
  const values = connectValues(d, id);
  const refresh = () => {
    preview.textContent = fillTemplate(template.value, values);
  };
  template.addEventListener('input', refresh);
  for (const el of [source, template]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const chips = names.length
    ? h(
        'div',
        { class: 'annotation-props', role: 'group', 'aria-label': tr('Вставить значение') },
        ...names.map((n) =>
          h('button', { class: 'annotation-prop', type: 'button', title: tr('Вставить {{{0}}}', n), onclick: () => {
            const at = template.selectionStart ?? template.value.length;
            const piece = `{{${n}}}`;
            template.setRangeText(piece, at, template.selectionEnd ?? at, 'end');
            template.focus();
            refresh();
          } }, n),
        ),
      )
    : null;
  const save = h('button', { class: 'text-button primary', type: 'button', onclick: () => setCodeConnect(editor, owner, { source: source.value, language: language.value, template: template.value }) }, tr('Сохранить'));
  const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => {
    editorBox.hidden = true;
    shown.hidden = false;
  } }, tr('Отмена'));
  editorBox.append(
    ...[
    h('div', { class: 'code-controls' }, h('div', { class: 'select-wrap' }, language)),
    source,
    template,
    chips ? h('div', { class: 'code-sub' }, tr('Значения вариантов и свойств — щелчок вставляет; {{#Имя}}…{{/Имя}} — только когда включено')) : null,
    chips,
    h('div', { class: 'code-sub' }, tr('Так увидят разработчики')),
    preview,
    h('div', { class: 'code-controls connect-actions' }, cancel, save),
    ].filter((el) => el !== null),
  );
  const shown = h('div', { class: 'connect-shown' });
  if (connect) {
    shown.append(codeBlock(filled?.code ?? connect.template));
    const src = sourceLine(connect.source);
    if (src) shown.append(src);
    if (!readOnly) shown.append(h('div', { class: 'code-controls connect-actions' }, h('button', { class: 'text-button', type: 'button', onclick: () => setCodeConnect(editor, owner, null) }, tr('Убрать')), h('button', { class: 'text-button', type: 'button', onclick: () => open() }, tr('Изменить…'))));
  } else {
    shown.append(h('p', { class: 'code-empty' }, tr('Настоящий код компонента из вашего репозитория: копии покажут его со своими вариантами и свойствами вместо сгенерированного CSS.')), h('button', { class: 'text-button', type: 'button', onclick: () => open() }, tr('Подключить код…')));
  }
  const open = () => {
    shown.hidden = true;
    editorBox.hidden = false;
    refresh();
    requestAnimationFrame(() => template.focus());
  };
  sec.append(shown, editorBox);
}

/** «Добавить ссылку на ресурс…» from the menu: the next build of the tab opens the link field. */
let openResourceForm = false;
export function focusResourceForm(): void {
  openResourceForm = true;
}

function resourceRow(name: string, url: string, extra: HTMLElement | null): HTMLElement {
  const kind = resourceKind(url);
  const link = h('a', { class: 'resource-link', href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, icon('link', 14), h('span', { class: 'resource-name' }, name), kind && kind !== name ? h('span', { class: 'resource-kind' }, kind) : null);
  return h('div', { class: 'resource-row' }, link, extra);
}

/** Links for developers (step 7, Dev resources): the layer's own, and an instance's from its component. */
function resourceSection(host: CodePanelHost, id: NodeId): void {
  const { editor } = host;
  const d = editor.doc;
  const own = resourcesOf(d, id);
  const inherited = inheritedResources(d, id);
  const readOnly = d.readOnly;
  if (readOnly && !own.length && !inherited.length) return;
  // No browser checks: «github.com/…» without https:// is fine, the link is completed (and refused with our own words).
  const form = h('form', { class: 'resource-form', hidden: true, novalidate: true });
  const url = h('input', { class: 'dialog-input', type: 'text', inputmode: 'url', autocapitalize: 'off', placeholder: 'https://github.com/…', 'aria-label': tr('Ссылка'), maxLength: 2000, spellcheck: false });
  const name = h('input', { class: 'dialog-input', type: 'text', placeholder: tr('Название (необязательно)'), 'aria-label': tr('Название ссылки'), maxLength: 120 });
  const error = h('p', { class: 'resource-error', role: 'alert', hidden: true });
  const show = (on: boolean) => {
    form.hidden = !on;
    if (on) requestAnimationFrame(() => url.focus());
  };
  form.append(url, name, error, h('div', { class: 'code-controls' }, h('button', { class: 'text-button', type: 'button', onclick: () => show(false) }, tr('Отмена')), h('button', { class: 'text-button primary', type: 'submit' }, tr('Добавить'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const problem = addResource(editor, id, url.value, name.value);
    error.hidden = !problem;
    error.textContent = problem ?? '';
    if (problem) url.focus();
  });
  form.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') show(false);
  });
  const add = h('button', { class: 'icon-button', type: 'button', title: tr('Добавить ссылку: код, Storybook, задача, документация'), 'aria-label': tr('Добавить ссылку на ресурс'), onclick: () => show(form.hidden) }, icon('plus', 14));
  const sec = readOnly ? host.section(tr('Ресурсы')) : host.section(tr('Ресурсы'), add);
  own.forEach((r, index) => {
    const remove = readOnly ? null : h('button', { class: 'icon-button', type: 'button', title: tr('Удалить ссылку'), 'aria-label': tr('Удалить ссылку «{0}»', r.name), onclick: () => removeResource(editor, id, index) }, icon('minus', 14));
    const row = resourceRow(r.name, r.url, remove);
    if (!readOnly) {
      row.querySelector('.resource-name')!.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const input = h('input', { class: 'dialog-input resource-rename', type: 'text', value: r.name, maxLength: 120, 'aria-label': tr('Название ссылки') });
        input.addEventListener('keydown', (k) => {
          k.stopPropagation();
          if (k.key === 'Enter') input.blur();
          if (k.key === 'Escape') {
            input.value = r.name;
            input.blur();
          }
        });
        input.addEventListener('blur', () => renameResource(editor, id, index, input.value));
        row.replaceChildren(input);
        input.focus();
        input.select();
      });
      row.title = tr('Двойной щелчок по названию — переименовать');
    }
    sec.append(row);
  });
  for (const group of inherited) {
    sec.append(h('div', { class: 'code-sub' }, tr('Из компонента «{0}»', group.name)));
    for (const r of group.list) sec.append(resourceRow(r.name, r.url, null));
  }
  if (!own.length && !inherited.length) sec.append(h('p', { class: 'code-empty' }, tr('Ссылки для разработчиков: код на GitHub, история в Storybook, задача, документация.')));
  if (!readOnly) sec.append(form);
  if (openResourceForm && !readOnly) {
    openResourceForm = false;
    show(true);
  }
}

/** The notes of a layer for developers (step 7): words, a category and pinned CSS properties. */
function annotationSection(host: CodePanelHost, id: NodeId): void {
  const { editor } = host;
  const list = annotationsOf(editor, id);
  const readOnly = editor.doc.readOnly;
  const add = h('button', { class: 'icon-button', type: 'button', title: tr('Добавить аннотацию (на холсте — Shift+T)'), 'aria-label': tr('Добавить аннотацию'), onclick: () => {
    const index = addAnnotation(editor, id);
    focusNext = { id, index };
  } }, icon('plus', 14));
  if (list.length === 0 && readOnly) return;
  const sec = readOnly ? host.section(tr('Аннотации')) : host.section(tr('Аннотации'), add);
  if (list.length === 0) {
    sec.append(h('p', { class: 'code-empty' }, tr('Заметка для разработчиков рядом со слоем: текст и нужные свойства.')));
    return;
  }
  const css = layerCss(editor, id);
  list.forEach((a, index) => {
    const card = h('div', { class: 'annotation-card', style: { borderLeftColor: categoryColor(a.category) } });
    const category = h('select', { class: 'field-select', 'aria-label': tr('Категория'), disabled: readOnly }, ...ANNOTATION_CATEGORIES.map((c) => h('option', { value: c.id }, c.label)));
    category.value = a.category;
    category.addEventListener('change', () => updateAnnotation(editor, id, index, { category: safeCategory(category.value) }, tr('Категория аннотации')));
    const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить аннотацию'), 'aria-label': tr('Удалить аннотацию'), onclick: () => removeAnnotation(editor, id, index) }, icon('minus', 14));
    card.append(h('div', { class: 'code-controls' }, h('div', { class: 'select-wrap' }, category), readOnly ? null : remove));
    const text = h('textarea', { class: 'dialog-input annotation-text', rows: 3, maxLength: 5000, placeholder: tr('Что важно знать разработчику'), 'aria-label': tr('Текст аннотации'), readOnly });
    text.value = a.label;
    const mine = draft && draft.id === id && draft.index === index ? draft : null;
    if (mine) text.value = mine.value;
    text.addEventListener('input', () => (draft = { id, index, value: text.value, start: text.selectionStart, end: text.selectionEnd }));
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) text.blur();
    });
    text.addEventListener('change', () => {
      draft = null;
      updateAnnotation(editor, id, index, { label: text.value });
    });
    text.addEventListener('blur', () => {
      if (draft && draft.id === id && draft.index === index) draft = null;
    });
    card.append(text);
    // Pinned properties: what the layer has now and what was pinned before (a pinned one it lost shows «—»).
    const names = [...new Set([...a.properties, ...css.keys()])];
    if (names.length) {
      const chips = h('div', { class: 'annotation-props', role: 'group', 'aria-label': tr('Свойства на карточке') });
      for (const name of names) {
        const on = a.properties.includes(name);
        const chip = h('button', { class: 'annotation-prop', type: 'button', 'aria-pressed': String(on), disabled: readOnly, title: css.get(name) ?? '—' }, name);
        chip.addEventListener('click', () => updateAnnotation(editor, id, index, { properties: on ? a.properties.filter((p) => p !== name) : [...a.properties, name] }, tr('Свойства аннотации')));
        chips.append(chip);
      }
      card.append(h('div', { class: 'code-sub' }, tr('Свойства на карточке')), chips);
    }
    sec.append(card);
    const wanted = (focusNext && focusNext.id === id && focusNext.index === index) || mine;
    if (wanted && !readOnly) {
      focusNext = null;
      requestAnimationFrame(() => {
        if (!text.isConnected) return;
        text.focus({ preventScroll: false });
        text.scrollIntoView({ block: 'nearest' });
        if (mine) text.setSelectionRange(mine.start, mine.end);
        else text.setSelectionRange(text.value.length, text.value.length);
      });
    }
  });
}

export function buildCodePanel(host: CodePanelHost): void {
  const { editor } = host;
  const ids = editor.selection;
  measurementSection(host);
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

  if (host.compareChanges) {
    const compare = host.compareChanges;
    size.append(h('button', { class: 'text-button code-compare', type: 'button', title: tr('Этот слой в сохранённой версии рядом с ним сейчас: свойства и код'), onclick: () => compare() }, icon('clock', 14), tr('Сравнить изменения…')));
  }

  // Focus view (step 7): a frame of the page shown alone.
  if (editor.focusFrame === id) {
    size.append(h('button', { class: 'text-button code-compare', type: 'button', title: tr('Вернуться ко всей странице (Esc)'), onclick: () => editor.setFocus(null) }, icon('fit', 14), tr('Вся страница')));
  } else if (!editor.focusFrame && editor.focusableFrames().includes(id)) {
    size.append(h('button', { class: 'text-button code-compare', type: 'button', title: tr('Только этот фрейм: остальное скрыто, выйти — Esc'), onclick: () => editor.setFocus(id) }, icon('fit', 14), tr('Фокус на фрейме')));
  }
  if (host.openPlayground && (type === 'INSTANCE' || type === 'COMPONENT' || type === 'COMPONENT_SET')) {
    const open = host.openPlayground;
    size.append(h('button', { class: 'text-button code-compare', type: 'button', title: tr('Варианты и свойства компонента: картинка и код сразу, файл не меняется'), onclick: () => open() }, icon('component', 14), tr('Открыть в песочнице…')));
  }

  annotationSection(host, id);
  resourceSection(host, id);
  connectSection(host, id);

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

  // The timeline of the frame the layer is on (Motion, stage 5): its code as CSS or JSON.
  const motionFrame = motionFrameOf(editor.doc, id);
  if (motionFrame) {
    let format: 'css' | 'json' = 'css';
    const out = h('pre', { class: 'code-block', tabIndex: 0 });
    const show = () => (out.textContent = format === 'css' ? motionCss(editor.doc, motionFrame) : motionJson(editor.doc, motionFrame));
    const pick = h('select', { class: 'field-select', 'aria-label': tr('Формат анимации') }, h('option', { value: 'css' }, 'CSS'), h('option', { value: 'json' }, 'JSON'));
    pick.addEventListener('change', () => {
      format = pick.value === 'json' ? 'json' : 'css';
      show();
    });
    const copyMotion = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код анимации'), 'aria-label': tr('Скопировать код анимации'), onclick: () => void copy(editor, out.textContent ?? '', tr('Код анимации скопирован')) }, icon('copy', 14));
    const motion = editor.doc.get(motionFrame, 'motion')!;
    host.section(tr('Анимация'), copyMotion).append(
      h('p', { class: 'code-empty' }, tr('Таймлайн «{0}»: {1} с{2}', editor.doc.get(motionFrame, 'name'), (motion.duration / 1000).toFixed(2).replace('.', ','), motion.loop ? tr(', по кругу') : '')),
      h('div', { class: 'code-controls' }, h('div', { class: 'select-wrap' }, pick)),
      out,
    );
    show();
  }

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
  // Notes and measurements of the page (step 7): a click takes the layer.
  const annotated = editor.annotatedLayers().filter((id) => d.store.isAlive(id));
  const measures = liveMeasurements(editor);
  if (annotated.length || measures.length) {
    const clear = h('button', { class: 'text-button', type: 'button', onclick: () => removeMeasurements(editor, measures.map((x) => x.m.id)) }, tr('Удалить все замеры'));
    const notes = host.section(tr('Аннотации и замеры'));
    for (const id of annotated) {
      const first = annotationsOf(editor, id)[0];
      notes.append(
        h(
          'button',
          { class: 'code-row ready', type: 'button', title: tr('Выделить слой'), onclick: () => {
            editor.setSelection([id]);
            editor.zoomToSelection();
          } },
          h('span', { class: 'code-swatch', style: { background: categoryColor(first?.category ?? 'NONE'), borderColor: 'transparent' } }),
          h('span', { class: 'code-label' }, String(d.get(id, 'name'))),
          h('span', { class: 'code-value' }, first?.label.split('\n')[0] ?? ''),
        ),
      );
    }
    if (measures.length) {
      notes.append(h('div', { class: 'code-sub' }, tr('Замеров на странице: {0}', measures.length)), ...measures.slice(0, 50).map((x) => {
        const r = row(editor, `${d.get(x.m.from, 'name')} → ${d.get(x.m.to, 'name')}`, measureText(x.m, x.line.value));
        r.title = tr('Выбрать замер');
        r.onclick = () => editor.selectMeasurement(x.m.id);
        r.style.cursor = 'pointer';
        return r;
      }));
      if (!d.readOnly) notes.append(h('div', { class: 'code-assets' }, clear));
    }
    if (!editor.view.annotations) notes.append(h('p', { class: 'code-empty' }, tr('Сейчас скрыты на холсте: Shift+Y — показать.')));
  }
  const vars = variablesCss(d);
  if (vars) {
    const copyButton = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код'), 'aria-label': tr('Скопировать код'), onclick: () => void copy(editor, vars, tr('Код скопирован')) }, icon('copy', 14));
    host.section(tr('Переменные в CSS'), copyButton).append(h('pre', { class: 'code-block', tabIndex: 0 }, vars));
  }
  host.section(tr('Слой')).append(h('p', { class: 'code-empty' }, tr('Выделите слой: здесь появятся его размеры, цвета и код.')));
}
