// Variables in the properties panel (FR-VAR-030, 031): the "apply variable"
// control next to supported fields, the bound-variable pill, the variable picker,
// and the mode selector of pages and frames (FR-VAR-012).

import { tr } from '#core';
import { extensionsOf, fieldSpec, isExtension, isVariable } from '#components';
import { colorToHex, isColorValue, type NodeId, type VariableLiteral } from '#core';
import type { Editor } from '../editor.ts';
import { switchLayout } from '../keyboard.ts';
import { formatLiteral } from '../variables.ts';
import { clear, h, icon } from './dom.ts';
import type { Field } from './fields.ts';
import { popover } from './styles-ui.ts';

/** Small preview of a resolved value: a swatch for colours, text otherwise. */
export function valuePreview(value: VariableLiteral | undefined): HTMLElement {
  if (value !== undefined && isColorValue(value)) {
    const c = `rgba(${Math.round(value.r * 255)}, ${Math.round(value.g * 255)}, ${Math.round(value.b * 255)}, ${value.a})`;
    return h('span', { class: 'var-swatch', style: { background: `linear-gradient(${c}, ${c}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 6px 6px` } });
  }
  return h('span', { class: 'var-value' }, value === undefined ? '—' : formatLiteral(value));
}

export interface VariableUiHost {
  editor: Editor;
  /** Opens the variables table (optionally at a variable). */
  openVariables(variable?: NodeId): void;
}

/**
 * Picker of variables for a field: grouped by collection and group, filtered by
 * type and scope, with the value as the selection sees it (FR-VAR-030).
 */
export function openVariablePicker(anchor: HTMLElement, host: VariableUiHost, field: string, ids: readonly NodeId[]): void {
  const { editor } = host;
  const d = editor.doc;
  const vars = editor.variables;
  const current = vars.boundOf(field, ids);
  const spec = fieldSpec(field);
  const search = h('input', { class: 'font-search', type: 'search', placeholder: tr('Поиск переменных'), spellcheck: false, 'aria-label': tr('Поиск переменных') });
  const list = h('div', { class: 'style-list', role: 'listbox' });
  const footer = h('div', { class: 'var-picker-footer' });
  const content = h('div', { class: 'style-picker' }, h('div', { class: 'font-search-wrap' }, icon('search', 14), search), list, footer);
  const close = popover(anchor, content, 300);
  const candidates = vars.candidates(field, ids);
  // Values typed by hand that equal a variable come first (FR-VAR-031).
  const read = spec && ids[0] ? spec.read(d, ids[0]) : undefined;
  const matches = new Set(read !== undefined && !current ? vars.matching(field, read, ids) : []);
  let items: { el: HTMLElement; id: NodeId }[] = [];
  let active = 0;
  const choose = (id: NodeId | null) => {
    close();
    vars.bind(field, id, ids);
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const alt = switchLayout(q);
    clear(list);
    items = [];
    const shown = candidates.filter((v) => {
      if (!q) return true;
      const t = `${d.get(d.parent(v)!, 'name')} ${d.get(v, 'name')} ${d.get(v, 'description')}`.toLowerCase();
      return t.includes(q) || t.includes(alt);
    });
    shown.sort((a, b) => Number(matches.has(b)) - Number(matches.has(a)));
    if (shown.length === 0) {
      list.append(h('p', { class: 'hint' }, candidates.length === 0 ? tr('Нет подходящих переменных ({0}). Создайте их в таблице переменных.', spec ? spec.label.toLowerCase() : field) : tr('Ничего не найдено')));
    }
    let group = '';
    for (const v of shown) {
      const collection = d.parent(v)!;
      const parts = d.get(v, 'name').split('/');
      const g = matches.has(v) ? tr('Совпадает со значением') : [d.get(collection, 'name'), ...parts.slice(0, -1)].join(' / ');
      if (g !== group) {
        group = g;
        list.append(h('div', { class: 'font-group' }, g));
      }
      const el = h(
        'div',
        { class: `style-item${v === current ? ' selected' : ''}`, role: 'option', 'aria-selected': String(v === current), title: `${d.get(collection, 'name')} / ${d.get(v, 'name')}${d.get(v, 'description') ? `\n${d.get(v, 'description')}` : ''}` },
        icon('variable', 14),
        h('span', { class: 'style-name' }, parts[parts.length - 1]!),
        valuePreview(vars.previewValue(v, ids)),
      );
      el.addEventListener('pointerdown', (e) => e.preventDefault());
      el.addEventListener('click', () => choose(v));
      items.push({ el, id: v });
      list.append(el);
    }
    active = Math.max(0, items.findIndex((i) => i.id === current));
    highlight();
  };
  const highlight = () => {
    items.forEach((item, i) => item.el.classList.toggle('active', i === active));
    items[active]?.el.scrollIntoView({ block: 'nearest' });
  };
  search.addEventListener('input', () => {
    render();
    active = 0;
    highlight();
  });
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      highlight();
    } else if (e.key === 'Enter' && items[active]) choose(items[active]!.id);
  });
  if (current) footer.append(h('button', { class: 'text-button', type: 'button', onclick: () => choose(null) }, icon('detach', 14), h('span', {}, tr('Отвязать'))));
  footer.append(
    h('button', { class: 'text-button', type: 'button', onclick: () => { close(); host.openVariables(current && current !== 'mixed' ? current : undefined); } }, icon('table', 14), h('span', {}, tr('Таблица переменных'))),
  );
  render();
  search.focus();
}

/**
 * A panel field that can be bound to a variable: shows the field with a
 * variable button on hover, or a pill with the bound variable.
 */
export class BindableField implements Field {
  readonly el: HTMLElement;
  private readonly host: VariableUiHost;
  private readonly field: string;
  private readonly inner: Field;
  private readonly ids: () => NodeId[];
  private readonly pill: HTMLElement;
  private readonly button: HTMLButtonElement;
  private lastSuggestionKey = '';

  constructor(host: VariableUiHost, field: string, inner: Field, ids: () => NodeId[]) {
    this.host = host;
    this.field = field;
    this.inner = inner;
    this.ids = ids;
    this.button = h('button', { class: 'var-bind', type: 'button', title: tr('Применить переменную'), 'aria-label': tr('Применить переменную'), tabindex: -1 }, icon('variable', 14));
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      openVariablePicker(this.el, host, field, this.ids());
    });
    this.pill = h('div', { class: 'var-pill', hidden: true });
    this.el = h('div', { class: 'bindable' }, inner.el, this.pill, this.button);
    this.refresh();
  }

  refresh(): void {
    this.inner.refresh();
    const { editor } = this.host;
    const d = editor.doc;
    const ids = this.ids();
    const vars = editor.variables;
    const bound = ids.length > 0 ? vars.boundOf(this.field, ids) : null;
    const hasCandidates = ids.length > 0 && d.collections().length > 0;
    this.button.hidden = !hasCandidates || bound !== null;
    this.inner.el.hidden = bound !== null;
    this.pill.hidden = bound === null;
    this.el.classList.toggle('is-bound', bound !== null);
    if (bound !== null) {
      clear(this.pill);
      const open = h('button', { class: 'var-pill-open', type: 'button', onclick: () => openVariablePicker(this.el, this.host, this.field, this.ids()) });
      if (bound === 'mixed') open.append(icon('variable', 14), h('span', { class: 'var-pill-name' }, tr('Разные переменные')));
      else {
        const name = isVariable(d, bound) ? d.get(bound, 'name').split('/').pop()! : '?';
        open.title = isVariable(d, bound) ? tr('{0} / {1}\nЩелчок — выбрать другую', d.get(d.parent(bound)!, 'name'), d.get(bound, 'name')) : '';
        open.append(icon('variable', 14), h('span', { class: 'var-pill-name' }, name), valuePreview(vars.previewValue(bound, ids)));
      }
      const detach = h('button', { class: 'icon-button', type: 'button', title: tr('Отвязать: значение останется'), onclick: () => vars.bind(this.field, null, this.ids()) }, icon('detach', 14));
      this.pill.append(open, detach);
      return;
    }
    // Typed value equal to a variable: highlight the button with a hint (FR-VAR-031).
    if (!hasCandidates) return;
    const spec = fieldSpec(this.field);
    const value = spec && ids[0] ? spec.read(d, ids[0]) : undefined;
    const key = value === undefined ? '' : isColorValue(value) ? colorToHex(value, true) : String(value);
    if (key === this.lastSuggestionKey) return;
    this.lastSuggestionKey = key;
    // Only colours and numbers: "true" or a short text matching a variable is a coincidence, not a token.
    const matches = value !== undefined && value !== 0 && spec && (spec.type === 'COLOR' || spec.type === 'FLOAT') ? vars.matching(this.field, value, ids) : [];
    this.el.classList.toggle('has-match', matches.length > 0);
    this.button.title = matches.length > 0 ? tr('Значение совпадает с переменной «{0}» — привязать?', d.get(matches[0]!, 'name')) : tr('Применить переменную');
  }

  dispose(): void {
    this.inner.dispose?.();
  }
}

/** Mode selectors for nodes (or a page): one row per collection with several modes (FR-VAR-012). */
export function buildModeRows(host: VariableUiHost, ids: readonly NodeId[], add: <F extends Field>(f: F) => F): HTMLElement | null {
  const { editor } = host;
  const d = editor.doc;
  const vars = editor.variables;
  const onPage = ids.length === 1 && d.type(ids[0]!) === 'PAGE';
  // A layer shows the choice only when something inside it uses the collection
  // (or a mode is already chosen): otherwise the switch changes nothing visible.
  const uses = (c: NodeId) => {
    if (onPage) return true;
    if (ids.some((id) => vars.explicitChoice(id, c))) return true;
    const stack = [...ids];
    for (let n = 0; stack.length && n < 5000; n++) {
      const id = stack.pop()!;
      const bound = d.get(id, 'boundVariables');
      if (bound && Object.values(bound).some((v) => d.store.isAlive(v) && d.parent(v) === c)) return true;
      stack.push(...d.children(id));
    }
    return false;
  };
  // An extended collection is chosen in its parent's row (FR-VAR-013): «Бренд Б · Тёмная».
  const collections = d.collections().filter((c) => !isExtension(d, c) && (d.get(c, 'modes').length > 1 || extensionsOf(d, c).length > 0) && uses(c));
  if (collections.length === 0 || ids.length === 0) return null;
  const box = h('div', { class: 'mode-rows' });
  for (const c of collections) {
    const select = h('select', { class: 'field-select', 'aria-label': tr('Режим: {0}', d.get(c, 'name')) });
    const choiceName = (scope: NodeId, mode: string | null) => {
      const m = d.get(c, 'modes').find((x) => x.id === mode)?.name ?? '';
      return scope === c ? m : `${d.get(scope, 'name')} · ${m}`;
    };
    const field: Field = {
      el: h('div', { class: 'row' }, h('span', { class: 'row-label', title: d.get(c, 'name') }, d.get(c, 'name')), h('div', { class: 'field select-wrap' }, select)),
      refresh: () => {
        if (!d.store.isAlive(c)) return;
        const modes = d.get(c, 'modes');
        const extensions = extensionsOf(d, c);
        const explicit = new Set(ids.map((id) => {
          const x = vars.explicitChoice(id, c);
          return x ? `${x.scope}|${x.mode}` : '';
        }));
        const parent = ids[0] ? d.parent(ids[0]) : null;
        const inherited = vars.effectiveChoice(parent, c);
        clear(select);
        select.append(h('option', { value: '' }, onPage ? tr('По умолчанию: {0}', choiceName(inherited.scope, inherited.mode)) : tr('Как у родителя: {0}', choiceName(inherited.scope, inherited.mode))));
        // The closed list shows only the option: an extension's names itself.
        const options = (scope: NodeId) => modes.map((m) => h('option', { value: `${scope}|${m.id}` }, choiceName(scope, m.id)));
        if (extensions.length === 0) select.append(...options(c));
        else for (const scope of [c, ...extensions]) select.append(h('optgroup', { label: d.get(scope, 'name') }, ...options(scope)));
        if (explicit.size > 1) select.append(h('option', { value: '__mixed', disabled: true }, tr('Разные')));
        select.value = explicit.size > 1 ? '__mixed' : [...explicit][0]!;
      },
    };
    select.addEventListener('change', () => {
      if (!select.value) vars.setMode(ids, c, null);
      else {
        const [scope, mode] = select.value.split('|') as [NodeId, string];
        vars.setMode(ids, scope, mode);
      }
    });
    field.refresh();
    add(field);
    box.append(field.el);
  }
  return box;
}
