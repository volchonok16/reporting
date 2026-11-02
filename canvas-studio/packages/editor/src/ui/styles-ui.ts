// Styles in the interface (section 11, FR-STY): previews, the style picker of
// the fill / stroke / effect / text sections, the "bound style" row, and the
// list of local styles shown when nothing is selected.

import { tr } from '#core';
import { splitStyleName, styleUsers, type StyleBinding } from '#components';
import { colorToHex, type Document, type Effect, type NodeId, type Paint, type StyleType } from '#core';
import type { Editor } from '../editor.ts';
import { switchLayout } from '../keyboard.ts';
import { clear, h, icon } from './dom.ts';
import type { Field } from './fields.ts';
import { gradientCss } from './paint-editor.ts';

export const STYLE_TYPE_NAMES: Record<StyleType, string> = { FILL: tr('Цвета'), TEXT: tr('Текст'), EFFECT: tr('Эффекты'), GRID: tr('Сетки') };

export function bindingStyleType(binding: StyleBinding): StyleType {
  return binding === 'textStyleId' ? 'TEXT' : binding === 'effectStyleId' ? 'EFFECT' : binding === 'gridStyleId' ? 'GRID' : 'FILL';
}

/** CSS background for a list of paints (top-most paint first, as CSS layers). */
export function paintsCss(paints: readonly Paint[]): string {
  const layers = paints
    .filter((p) => p.visible)
    .slice()
    .reverse()
    .map((p) => {
      if (p.type === 'SOLID') {
        const c = `rgba(${Math.round(p.color.r * 255)}, ${Math.round(p.color.g * 255)}, ${Math.round(p.color.b * 255)}, ${p.color.a * p.opacity})`;
        return `linear-gradient(${c}, ${c})`;
      }
      if (p.type === 'IMAGE' || p.type === 'PATTERN') return 'repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 0 0 / 6px 6px';
      return gradientCss(p, 135);
    });
  return layers.length > 0 ? layers.join(', ') : 'transparent';
}

function effectCss(effects: readonly Effect[]): string {
  return effects
    .filter((e) => e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'))
    .map((e) => {
      if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') return '';
      const c = `rgba(${Math.round(e.color.r * 255)}, ${Math.round(e.color.g * 255)}, ${Math.round(e.color.b * 255)}, ${e.color.a})`;
      return `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset.x / 2}px ${e.offset.y / 2}px ${e.radius / 2}px ${e.spread / 2}px ${c}`;
    })
    .filter(Boolean)
    .join(', ');
}

/** Small preview of a style: a swatch, "Ag" in the style's font, or a shadowed tile. */
export function stylePreview(doc: Document, style: NodeId): HTMLElement {
  const type = doc.get(style, 'styleType');
  if (type === 'FILL') return h('span', { class: 'style-swatch', style: { background: paintsCss(doc.get(style, 'fills')) } });
  if (type === 'GRID') {
    const g = doc.get(style, 'layoutGrids')[0];
    const bg =
      g?.pattern === 'ROWS'
        ? 'repeating-linear-gradient(180deg, rgba(255,0,0,0.35) 0 3px, transparent 3px 5px)'
        : g?.pattern === 'GRID'
          ? 'repeating-linear-gradient(90deg, rgba(255,0,0,0.5) 0 1px, transparent 1px 4px), repeating-linear-gradient(180deg, rgba(255,0,0,0.5) 0 1px, transparent 1px 4px)'
          : 'repeating-linear-gradient(90deg, rgba(255,0,0,0.35) 0 3px, transparent 3px 5px)';
    return h('span', { class: 'style-swatch style-grid', style: { background: bg } });
  }
  if (type === 'TEXT') {
    return h(
      'span',
      { class: 'style-glyph', style: { fontFamily: `"${doc.get(style, 'fontFamily')}", system-ui`, fontWeight: String(doc.get(style, 'fontWeight')), fontStyle: doc.get(style, 'italic') ? 'italic' : 'normal' } },
      'Ag',
    );
  }
  const effects = doc.get(style, 'effects');
  const blur = effects.some((e) => e.visible && (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR'));
  return h('span', { class: `style-effect${blur ? ' blur' : ''}`, style: { boxShadow: effectCss(effects) } });
}

/** Short description under the name: hex, "Inter 16/24", "Тень 0 4 8". */
export function styleMeta(doc: Document, style: NodeId): string {
  const type = doc.get(style, 'styleType');
  if (type === 'FILL') {
    const fills = doc.get(style, 'fills');
    if (fills.length === 1 && fills[0]!.type === 'SOLID') {
      const f = fills[0]!;
      return `${colorToHex(f.color)}${f.opacity < 1 ? ` · ${Math.round(f.opacity * 100)}%` : ''}`;
    }
    if (fills.length === 1) return fills[0]!.type === 'IMAGE' ? tr('Изображение') : tr('Градиент');
    return tr('{0} слоя заливки', fills.length);
  }
  if (type === 'GRID') {
    const grids = doc.get(style, 'layoutGrids');
    return grids
      .map((g) => (g.pattern === 'GRID' ? tr('Сетка {0}', g.sectionSize) : `${g.count || tr('Авто')} ${g.pattern === 'COLUMNS' ? tr('кол.') : tr('стр.')}, ${g.gutterSize}`))
      .join(' + ') || tr('Пусто');
  }
  if (type === 'TEXT') {
    const lh = doc.get(style, 'lineHeight');
    const line = lh.unit === 'AUTO' ? tr('Авто') : lh.unit === 'PX' ? `${lh.value}` : lh.unit === 'PERCENT' ? `${lh.value}%` : `×${lh.value}`;
    return `${doc.get(style, 'fontFamily')} ${doc.get(style, 'fontWeight')} · ${doc.get(style, 'fontSize')}/${line}`;
  }
  const effects = doc.get(style, 'effects');
  const names: Record<Effect['type'], string> = { DROP_SHADOW: tr('Тень'), INNER_SHADOW: tr('Внутренняя тень'), LAYER_BLUR: tr('Размытие'), BACKGROUND_BLUR: tr('Размытие фона'), NOISE: tr('Шум'), TEXTURE: tr('Текстура'), GLASS: tr('Стекло') };
  return effects.map((e) => names[e.type]).join(', ') || tr('Без эффектов');
}

// ---------- popover ----------

let openPopover: { el: HTMLElement; close: () => void } | null = null;

/** A floating panel next to `anchor`; closes on outside click and Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, width = 260): () => void {
  openPopover?.close();
  const el = h('div', { class: 'style-popover', role: 'dialog' }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width))}px`;
  // On the side with more room, and never taller than it (it ran off the screen as the font list did).
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const down = below > 340 || below >= above;
  if (down) el.style.top = `${r.bottom + 4}px`;
  else el.style.bottom = `${window.innerHeight - r.top + 4}px`;
  el.style.maxHeight = `${Math.max(160, Math.min(460, down ? below : above))}px`;
  el.style.overflowY = 'auto';
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    if (openPopover?.el === el) openPopover = null;
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  openPopover = { el, close };
  return close;
}

export function closePopover(): void {
  openPopover?.close();
}

/** Styles grouped by folder ("Brand/Primary" → folder "Brand"). */
function grouped(doc: Document, styles: readonly NodeId[]): [string, NodeId[]][] {
  const groups = new Map<string, NodeId[]>();
  for (const id of styles) {
    const folder = splitStyleName(doc.get(id, 'name')).folders.join(' / ');
    const list = groups.get(folder);
    if (list) list.push(id);
    else groups.set(folder, [id]);
  }
  return [...groups];
}

function styleItem(doc: Document, style: NodeId, selected: boolean): HTMLElement {
  const { name } = splitStyleName(doc.get(style, 'name'));
  const description = doc.get(style, 'description');
  return h(
    'div',
    { class: `style-item${selected ? ' selected' : ''}`, role: 'option', 'aria-selected': String(selected), tabindex: -1, title: `${doc.get(style, 'name')}${description ? `\n${description}` : ''}\n${styleMeta(doc, style)}` },
    stylePreview(doc, style),
    h('span', { class: 'style-name' }, name),
    h('span', { class: 'style-meta' }, styleMeta(doc, style)),
  );
}

/**
 * Picker of the fill / stroke / effect / text sections: search, styles by
 * folder, and "Create style" from the selection's current values.
 */
export function openStylePicker(anchor: HTMLElement, editor: Editor, binding: StyleBinding): void {
  const doc = editor.doc;
  const type = bindingStyleType(binding);
  const current = editor.selectionStyle(binding);
  const search = h('input', { class: 'font-search', type: 'search', placeholder: tr('Поиск стилей'), spellcheck: false, 'aria-label': tr('Поиск стилей') });
  const list = h('div', { class: 'style-list', role: 'listbox' });
  const createName = h('input', { class: 'field-input', type: 'text', placeholder: tr('Название стиля'), spellcheck: false, 'aria-label': tr('Название нового стиля') });
  const create = h('button', { class: 'text-button', type: 'button' }, icon('plus', 14), h('span', {}, tr('Создать стиль')));
  const content = h(
    'div',
    { class: 'style-picker' },
    h('div', { class: 'font-search-wrap' }, icon('search', 14), search),
    list,
    h('div', { class: 'style-create' }, h('div', { class: 'field text-field' }, createName), create),
  );
  const close = popover(anchor, content, 280);
  let items: { el: HTMLElement; id: NodeId }[] = [];
  let active = 0;
  const choose = (id: NodeId) => {
    close();
    editor.applyStyle(binding, id);
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const alt = switchLayout(q);
    const styles = editor.stylesOf(type).filter((id) => {
      if (!q) return true;
      const t = `${doc.get(id, 'name')} ${doc.get(id, 'description')}`.toLowerCase();
      return t.includes(q) || t.includes(alt);
    });
    clear(list);
    items = [];
    if (styles.length === 0) list.append(h('p', { class: 'hint' }, q ? tr('Ничего не найдено') : tr('В файле пока нет стилей ({0}). Создайте первый ниже.', STYLE_TYPE_NAMES[type].toLowerCase())));
    for (const [folder, ids] of grouped(doc, styles)) {
      if (folder) list.append(h('div', { class: 'font-group' }, icon('folder', 12), ` ${folder}`));
      for (const id of ids) {
        const el = styleItem(doc, id, id === current);
        el.addEventListener('pointerdown', (e) => e.preventDefault());
        el.addEventListener('click', () => choose(id));
        items.push({ el, id });
        list.append(el);
      }
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
  const doCreate = () => {
    close();
    editor.createStyle(type, binding, createName.value);
  };
  createName.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doCreate();
  });
  create.addEventListener('click', doCreate);
  render();
  search.focus();
}

/** The button in a section header that opens the style picker. */
export function styleButton(editor: Editor, binding: StyleBinding): HTMLButtonElement {
  const button: HTMLButtonElement = h('button', { class: 'icon-button', type: 'button', title: tr('Стили'), 'aria-haspopup': 'dialog', onclick: () => openStylePicker(button, editor, binding) }, icon('styles'));
  return button;
}

/** Row shown instead of the raw values when the selection uses a style. */
export class StyleRow implements Field {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly binding: StyleBinding;
  private readonly onEdit: (style: NodeId) => void;

  constructor(editor: Editor, binding: StyleBinding, onEdit: (style: NodeId) => void) {
    this.editor = editor;
    this.binding = binding;
    this.onEdit = onEdit;
    this.el = h('div', { class: 'style-row' });
    this.refresh();
  }

  refresh(): void {
    const { editor, binding } = this;
    const doc = editor.doc;
    const style = editor.selectionStyle(binding);
    clear(this.el);
    if (style === null) return;
    const detach = h('button', { class: 'icon-button', type: 'button', title: tr('Отвязать от стиля: значения останутся, связь со стилем пропадёт'), onclick: () => editor.detachStyle(binding) }, icon('detach'));
    if (style === 'mixed') {
      this.el.append(h('span', { class: 'style-name muted' }, tr('Разные стили')), detach);
      return;
    }
    const { folders, name } = splitStyleName(doc.get(style, 'name'));
    const open = h(
      'button',
      { class: 'style-open', type: 'button', title: tr('{0}\nЩелчок — выбрать другой стиль', doc.get(style, 'name')), onclick: () => openStylePicker(open, editor, binding) },
      stylePreview(doc, style),
      h('span', { class: 'style-name' }, name),
      folders.length > 0 ? h('span', { class: 'style-meta' }, folders.join(' / ')) : null,
    );
    const edit = h('button', { class: 'icon-button', type: 'button', title: tr('Изменить стиль (изменится во всех слоях)'), onclick: () => this.onEdit(style) }, icon('sliders'));
    this.el.append(open, edit, detach);
  }
}

export interface LocalStylesHost {
  editor: Editor;
  section(title: string, ...actions: HTMLElement[]): HTMLElement;
  edit(style: NodeId): void;
}

/**
 * The file's styles, shown when nothing is selected: one "Styles" section with
 * a group per kind that has any. A style is made from a layer (the styles
 * button next to "Fill", "Text", "Effects"), not here: an empty style that
 * nothing uses only puzzled people (12 Oct).
 */
export function buildLocalStyles(host: LocalStylesHost): void {
  const { editor } = host;
  const doc = editor.doc;
  const kinds = (['FILL', 'TEXT', 'EFFECT', 'GRID'] as const).map((type) => ({ type, styles: editor.stylesOf(type) }));
  const some = kinds.some((k) => (k.type === 'TEXT' || k.type === 'FILL') && k.styles.length > 1);
  // Several text or colour styles: «Массовая правка» changes a common property at once (as Batch Styler).
  const batch = some && !doc.readOnly ? h('button', { class: 'icon-button', type: 'button', title: tr('Массовая правка стилей'), 'aria-label': tr('Массовая правка стилей'), onclick: () => void import('./batch-styles-dialog.ts').then(({ openBatchStyles }) => openBatchStyles(editor)) }, icon('sliders', 14)) : null;
  const body = batch ? host.section(tr('Стили'), batch) : host.section(tr('Стили'));
  if (kinds.every((k) => k.styles.length === 0)) {
    body.append(h('p', { class: 'styles-empty' }, tr('Пока нет. Чтобы сохранить оформление слоя как стиль, выделите слой и нажмите'), ' ', icon('styles', 12), ' ', tr('у заливки, текста или эффектов.')));
    return;
  }
  for (const { type, styles } of kinds) {
    if (styles.length === 0) continue;
    body.append(h('div', { class: 'styles-kind' }, type === 'FILL' ? tr('Цвета') : type === 'TEXT' ? tr('Текст') : type === 'GRID' ? tr('Сетки') : tr('Эффекты')));
    // Colours by what they paint — shapes, text, strokes: side by side a fill and a text colour look alike.
    for (const [use, list] of type === 'FILL' ? colourUses(editor, styles) : [['', styles] as const]) {
      if (use) body.append(h('div', { class: 'styles-use' }, use));
      for (const [folder, ids] of grouped(doc, list)) {
        if (folder) body.append(h('div', { class: 'style-folder' }, icon('folder', 12), h('span', {}, folder)));
        for (const id of ids) {
          const item = styleItem(doc, id, false);
          item.classList.add('local');
          item.tabIndex = 0;
          const users = editor.styleUsers(id).length;
          const more = h('button', { class: 'icon-button', type: 'button', title: tr('Действия'), onclick: (e: MouseEvent) => {
            e.stopPropagation();
            openStyleMenu(more, host, id);
          } }, icon('menu', 14));
          item.append(h('span', { class: 'style-count', title: tr('Слоёв со стилем') }, users > 0 ? String(users) : ''), more);
          item.addEventListener('click', () => host.edit(id));
          item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') host.edit(id);
            if (e.key === 'Delete' || e.key === 'Backspace') editor.deleteStyle(id);
            e.stopPropagation();
          });
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openStyleMenu(more, host, id);
          });
          body.append(item);
        }
      }
    }
  }
}

/**
 * Colour styles split by what uses them: «Заливка» (shapes and frames), «Цвет текста», «Обводка»,
 * a mix of them, «Не используются». One group only — no headings: nothing to tell apart.
 */
function colourUses(editor: Editor, styles: readonly NodeId[]): [string, NodeId[]][] {
  const doc = editor.doc;
  const ORDER = [tr('Заливка'), tr('Цвет текста'), tr('Обводка')];
  const groups = new Map<string, NodeId[]>();
  for (const id of styles) {
    const uses = new Set<number>();
    for (const u of styleUsers(doc, id)) uses.add(u.binding === 'strokeStyleId' ? 2 : doc.type(u.id) === 'TEXT' ? 1 : 0);
    const key = uses.size ? [...uses].sort().map((i) => ORDER[i]!).join(' + ') : tr('Не используются');
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  }
  // Single uses first in their order, then mixes, the unused last.
  const rank = (k: string) => (k === tr('Не используются') ? 99 : ORDER.includes(k) ? ORDER.indexOf(k) : 10);
  const out = [...groups].sort((a, b) => rank(a[0]) - rank(b[0]));
  return out.length > 1 ? out : [['', [...styles]]];
}

/** Actions of one style: edit, select layers, duplicate, replace, delete (FR-STY-004). */
export function openStyleMenu(anchor: HTMLElement, host: LocalStylesHost, style: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const list = h('div', { class: 'style-menu', role: 'menu' });
  let close = () => {};
  const action = (label: string, run: () => void, disabled = false) => {
    const b = h('button', { class: 'style-menu-item', type: 'button', role: 'menuitem', disabled }, label);
    b.addEventListener('click', () => {
      close();
      run();
    });
    list.append(b);
  };
  const users = editor.styleUsers(style).length;
  action(tr('Изменить стиль'), () => host.edit(style));
  action(users > 0 ? tr('Выделить слои со стилем ({0})', users) : tr('Стиль нигде не используется'), () => editor.selectStyleUsers(style), users === 0);
  action(tr('Дублировать'), () => host.edit(editor.duplicateStyle(style)));
  const type = doc.get(style, 'styleType');
  if ((type === 'TEXT' || type === 'FILL') && !doc.readOnly) action(tr('Массовая правка…'), () => void import('./batch-styles-dialog.ts').then(({ openBatchStyles }) => openBatchStyles(editor, type, [style])));
  const others = editor.stylesOf(doc.get(style, 'styleType')).filter((id) => id !== style);
  if (others.length > 0 && users > 0) {
    list.append(h('div', { class: 'style-menu-title' }, tr('Заменить во всём файле на…')));
    for (const other of others) {
      const b = h('button', { class: 'style-menu-item with-preview', type: 'button', role: 'menuitem' }, stylePreview(doc, other), h('span', {}, doc.get(other, 'name')));
      b.addEventListener('click', () => {
        close();
        const n = editor.replaceStyle(style, other);
        editor.toast(tr('Стиль заменён в {0} местах', n));
      });
      list.append(b);
    }
  }
  action(tr('Удалить стиль'), () => editor.deleteStyle(style));
  close = popover(anchor, list, 240);
}
