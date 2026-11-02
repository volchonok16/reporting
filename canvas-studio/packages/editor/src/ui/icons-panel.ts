// «Иконки»: Simmetrika's own icon set next to the tool panel — search in Russian
// or English, categories, the size, line width and colour of what is inserted;
// a click puts the icon into the selected frame (or the middle of the view), a
// drag puts it where it is dropped.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { DEFAULT_LOOK, insertIcon, type IconLook } from '../icons/insert.ts';
import { ICONS, type IconCategory, type IconDef } from '../icons/set.ts';
import { h, icon } from './dom.ts';

/** What a dragged icon carries to the canvas: its id. */
export const ICON_DRAG_TYPE = 'application/x-simmetrika-icon';

const LOOK_KEY = 'cs-icon-look';

const CATEGORIES = (): [IconCategory | 'all', string][] => [
  ['all', tr('Все')],
  ['ui', tr('Интерфейс')],
  ['arrows', tr('Стрелки')],
  ['people', tr('Люди и общение')],
  ['media', tr('Медиа')],
  ['files', tr('Файлы и данные')],
  ['commerce', tr('Покупки')],
  ['devices', tr('Устройства')],
  ['nature', tr('Погода и природа')],
  ['places', tr('Места и транспорт')],
  ['design', tr('Текст и дизайн')],
  ['charts', tr('Графики')],
  ['misc', tr('Разное')],
];

function savedLook(): IconLook {
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<IconLook> | null;
    return { ...DEFAULT_LOOK, ...(v ?? {}) };
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

/** The icon as a small picture for the panel (drawn with the text colour). */
function preview(def: IconDef, stroke: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = def.body;
  return svg;
}

/** Search words: «стрел» finds every arrow, «arrow» too; all words must match. */
export function findIcons(query: string, category: IconCategory | 'all'): IconDef[] {
  const words = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
  return ICONS.filter((i) => {
    if (category !== 'all' && i.cat !== category) return false;
    const hay = `${i.ru} ${i.en} ${i.id} ${i.tags}`.toLowerCase().replace(/ё/g, 'е');
    return words.every((w) => hay.includes(w));
  });
}

export class IconsPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly dock: HTMLElement;
  private category: IconCategory | 'all' = 'all';
  private query = '';
  private look = savedLook();
  private readonly grid: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly chips: HTMLElement;

  constructor(editor: Editor, dock: HTMLElement) {
    this.editor = editor;
    this.dock = dock;
    this.search = h('input', { class: 'ip-search', type: 'search', placeholder: tr('Найти иконку: стрелка, корзина, user…'), 'aria-label': tr('Найти иконку') }) as HTMLInputElement;
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.fill();
    });
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      // Enter puts the first icon found.
      if (e.key === 'Enter') {
        const first = findIcons(this.query, this.category)[0];
        if (first) this.insert(first);
      }
    });
    this.chips = h('div', { class: 'ip-cats', role: 'tablist', 'aria-label': tr('Категории иконок') });
    this.grid = h('div', { class: 'ip-grid', role: 'list' });
    const head = h(
      'div',
      { class: 'ip-head' },
      icon('search', 14),
      this.search,
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close')),
    );
    this.el = h('div', { class: 'frame-presets icons-panel', role: 'dialog', 'aria-label': tr('Иконки'), hidden: true }, head, this.chips, this.grid, this.lookRow());
    window.addEventListener('resize', () => this.place());
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (this.el.hidden || !t || this.el.contains(t) || this.dock.contains(t)) return;
      this.close();
    });
  }

  toggle(): void {
    if (this.editor.doc.readOnly) return;
    this.el.hidden = !this.el.hidden;
    if (this.el.hidden) return;
    this.fillChips();
    this.fill();
    this.place();
    this.search.focus();
    this.search.select();
  }

  close(): void {
    this.el.hidden = true;
  }

  private fillChips(): void {
    this.chips.replaceChildren(
      ...CATEGORIES().map(([value, label]) => {
        const on = value === this.category;
        const b = h('button', { class: `fp-group${on ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on) }, h('span', {}, label));
        b.addEventListener('click', () => {
          this.category = value;
          this.fillChips();
          this.fill();
        });
        return b;
      }),
    );
  }

  private fill(): void {
    const found = findIcons(this.query, this.category);
    if (found.length === 0) {
      this.grid.replaceChildren(h('p', { class: 'ip-empty' }, tr('Ничего не нашлось — попробуйте другое слово, по-русски или по-английски')));
      return;
    }
    this.grid.replaceChildren(
      ...found.map((def) => {
        const b = h('button', { class: 'ip-icon', type: 'button', title: `${def.ru} · ${def.en}`, 'aria-label': def.ru, draggable: 'true', role: 'listitem' }, preview(def, Math.min(2.5, Math.max(1, (this.look.stroke * 24) / this.look.size))));
        b.addEventListener('click', () => this.insert(def));
        b.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(ICON_DRAG_TYPE, def.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
        });
        return b;
      }),
    );
  }

  /** Size, line width and colour of the next icons; remembered in this browser. */
  private lookRow(): HTMLElement {
    const save = () => {
      try {
        localStorage.setItem(LOOK_KEY, JSON.stringify(this.look));
      } catch {
        // not remembered
      }
      this.fill();
    };
    const select = (label: string, values: number[], get: () => number, set: (v: number) => void, unit: string) => {
      const s = h('select', { class: 'ip-select', 'aria-label': label, title: label }, ...values.map((v) => h('option', { value: String(v), selected: v === get() }, `${v} ${unit}`))) as HTMLSelectElement;
      s.addEventListener('change', () => {
        set(Number(s.value));
        save();
      });
      return h('label', { class: 'ip-field' }, h('span', {}, label), s);
    };
    const color = h('input', { type: 'color', value: this.look.color, 'aria-label': tr('Цвет иконки') }) as HTMLInputElement;
    color.addEventListener('input', () => {
      this.look.color = color.value.toUpperCase();
      save();
    });
    return h(
      'div',
      { class: 'ip-look' },
      select(tr('Размер'), [12, 16, 20, 24, 32, 40, 48, 64], () => this.look.size, (v) => (this.look.size = v), 'px'),
      select(tr('Линия'), [1, 1.25, 1.5, 1.75, 2, 2.5, 3], () => this.look.stroke, (v) => (this.look.stroke = v), 'px'),
      h('label', { class: 'ip-field' }, h('span', {}, tr('Цвет')), color),
      h('span', { class: 'fp-hint' }, tr('Щелчок — во фрейм или в центр, перетаскивание — куда угодно')),
    );
  }

  private insert(def: IconDef): void {
    if (insertIcon(this.editor, def, this.look)) this.editor.setTool('select');
  }

  /** Drop from the panel onto the canvas: the icon where it lands. */
  drop(id: string, world: { x: number; y: number }): boolean {
    const def = ICONS.find((i) => i.id === id);
    if (!def) return false;
    insertIcon(this.editor, def, this.look, world);
    this.editor.setTool('select');
    return true;
  }

  private place(): void {
    if (this.el.hidden) return;
    const area = this.el.parentElement;
    if (!area) return;
    const a = area.getBoundingClientRect();
    const d = this.dock.getBoundingClientRect();
    const where = this.dock.dataset.place ?? 'bottom';
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    if (where === 'left') {
      this.el.style.left = `${d.right - a.left + 8}px`;
      this.el.style.top = `${Math.max(8, d.top - a.top + d.height / 2 - hh / 2)}px`;
    } else {
      this.el.style.left = `${Math.max(8, Math.min(a.width - w - 8, d.left - a.left + d.width / 2 - w / 2))}px`;
      this.el.style.top = `${where === 'top' ? d.bottom - a.top + 8 : Math.max(8, d.top - a.top - hh - 8)}px`;
    }
  }
}
