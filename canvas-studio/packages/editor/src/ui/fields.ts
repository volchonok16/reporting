// Property inputs (spec 5.3). Each field reads its value through a callback, so
// the panel can refresh values after any document change without rebuilding DOM.

import { tr } from '#core';
import { colorToHex, hexToColor, type Color } from '#core';
import { applyNumericInput } from '#geometry';
import { openColorPicker } from './color-picker.ts';
import { h, icon } from './dom.ts';

export const MIXED = Symbol('mixed');
export type Mixed<T> = T | typeof MIXED;

export interface Field {
  readonly el: HTMLElement;
  refresh(): void;
  /** Called when the panel is rebuilt; a disposed field must never write again. */
  dispose?(): void;
}

export interface NumberFieldOptions {
  label: string;
  /** Icon name instead of a text label. */
  icon?: string;
  title: string;
  suffix?: string;
  min?: number;
  max?: number;
  /** Decimal places shown. */
  precision?: number;
  read: () => Mixed<number> | null;
  /** Applies `compute` to every target; `phase` lets scrubbing run as one undo step. */
  write: (compute: (current: number) => number, phase: 'commit' | 'start' | 'update' | 'end') => void;
  /**
   * The writer takes only commits: dragging the label then commits the value from where
   * the drag began at every step (same-named commits merge into one undo step).
   */
  scrubAsCommits?: boolean;
}

/** Numeric input with expressions, arrows, scrub-on-label and mixed values (FR-UI-010…012). */
export class NumberField implements Field {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly options: NumberFieldOptions;
  private editing = false;
  private disposed = false;

  constructor(options: NumberFieldOptions) {
    this.options = options;
    const label = h('span', { class: 'field-label', title: options.title }, options.icon ? icon(options.icon, 12) : options.label);
    this.input = h('input', { class: 'field-input', type: 'text', inputmode: 'decimal', spellcheck: false, 'aria-label': options.title });
    // An icon's meaning in words, shown over the field with «Property labels» on (Settings, View).
    const caption = options.icon ? { 'data-caption': options.title.split(/,| \(| —/)[0]! } : {};
    this.el = h('label', { class: 'field number-field', title: options.title, ...caption }, label, this.input, options.suffix ? h('span', { class: 'field-suffix' }, options.suffix) : null);

    this.input.addEventListener('focus', () => {
      this.editing = true;
      this.input.select();
    });
    this.input.addEventListener('blur', () => {
      if (this.editing) this.commitInput();
      this.editing = false;
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitInput();
        this.input.select();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.editing = false;
        this.refresh();
        this.input.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        this.options.write((v) => this.clamp(v + step), 'commit');
        this.refresh();
        this.input.select();
      } else if (e.key === 'Tab') {
        this.commitInput();
      }
      e.stopPropagation();
    });

    // Scrub: drag the label horizontally to change the value.
    label.addEventListener('pointerdown', (e) => {
      if (this.options.read() === null) return;
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      let total = 0;
      let started = false;
      const from = this.options.read();
      const move = (ev: PointerEvent) => {
        total += ev.movementX * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
        if (this.options.scrubAsCommits) {
          if (typeof from !== 'number') return;
          const value = this.clamp(from + Math.round(total * 100) / 100);
          this.options.write(() => value, 'commit');
          this.refresh();
          return;
        }
        if (!started) {
          started = true;
          this.options.write((v) => v, 'start');
        }
        const delta = Math.round(total * 100) / 100;
        this.options.write((v) => this.clamp(v + delta), 'update');
        this.refresh();
      };
      const up = () => {
        label.removeEventListener('pointermove', move);
        label.removeEventListener('pointerup', up);
        if (started) this.options.write((v) => v, 'end');
      };
      label.addEventListener('pointermove', move);
      label.addEventListener('pointerup', up);
    });
    this.refresh();
  }

  private clamp(v: number): number {
    let out = v;
    if (this.options.min !== undefined) out = Math.max(this.options.min, out);
    if (this.options.max !== undefined) out = Math.min(this.options.max, out);
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.editing = false;
  }

  private commitInput(): void {
    // A field left over from a previous selection must not apply its text to the new one.
    if (this.disposed || !this.el.isConnected) return;
    const text = this.input.value.trim();
    const current = this.options.read();
    if (current === null) return;
    if (text === '' || (current === MIXED && text === tr('Смешанное'))) {
      this.refresh();
      return;
    }
    if (current !== MIXED && text === this.format(current)) return;
    // Relative input ("+10") applies to each object's own value (FR-UI-011).
    let failed = false;
    this.options.write((v) => {
      const result = applyNumericInput(text.replace(this.options.suffix ?? '\u0000', ''), v, true);
      if (!result.ok) {
        failed = true;
        return v;
      }
      return this.clamp(result.value);
    }, 'commit');
    this.input.classList.toggle('invalid', failed);
    this.refresh();
  }

  private format(v: number): string {
    const p = this.options.precision ?? 2;
    const f = 10 ** p;
    return String(Math.round(v * f) / f);
  }

  refresh(): void {
    const value = this.options.read();
    this.el.classList.toggle('disabled', value === null);
    this.input.disabled = value === null;
    if (this.editing && document.activeElement === this.input) return;
    this.input.value = value === null ? '' : value === MIXED ? tr('Смешанное') : this.format(value);
    this.input.classList.toggle('mixed', value === MIXED);
    this.input.classList.remove('invalid');
  }
}

export interface ColorFieldOptions {
  title: string;
  read: () => Mixed<{ color: Color; opacity: number }> | null;
  write: (color: Color, opacity: number) => void;
}

/** Colour swatch + hex + opacity. */
export class ColorField implements Field {
  readonly el: HTMLElement;
  private readonly swatch: HTMLButtonElement;
  private readonly hex: HTMLInputElement;
  private readonly opacity: HTMLInputElement;
  private readonly options: ColorFieldOptions;

  constructor(options: ColorFieldOptions) {
    this.options = options;
    // Our own picker (with an eyedropper) instead of the browser's system colour window.
    this.swatch = h('button', { class: 'color-swatch', type: 'button', title: options.title, 'aria-label': tr('{0}: выбрать цвет', options.title), 'aria-haspopup': 'dialog' });
    this.hex = h('input', { class: 'field-input hex', type: 'text', spellcheck: false, 'aria-label': `${options.title}: HEX` });
    this.opacity = h('input', { class: 'field-input opacity', type: 'text', inputmode: 'decimal', 'aria-label': tr('{0}: непрозрачность', options.title) });
    this.el = h('div', { class: 'field color-field' }, this.swatch, this.hex, this.opacity, h('span', { class: 'field-suffix' }, '%'));
    this.swatch.addEventListener('click', () => {
      const cur = this.options.read();
      if (cur === null) return;
      const start = cur === MIXED ? { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1 } : cur;
      openColorPicker({
        anchor: this.swatch,
        color: start.color,
        opacity: start.opacity,
        onChange: (color, opacity) => {
          this.options.write(color, opacity);
          this.refresh();
        },
      });
    });
    const commitHex = () => {
      const c = hexToColor(this.hex.value);
      const cur = this.options.read();
      if (c && cur !== null) this.options.write({ ...c, a: 1 }, cur === MIXED ? 1 : cur.opacity);
      this.refresh();
    };
    const commitOpacity = () => {
      const cur = this.options.read();
      const n = Number(this.opacity.value.replace('%', '').replace(',', '.'));
      if (cur !== null && cur !== MIXED && Number.isFinite(n)) this.options.write(cur.color, Math.max(0, Math.min(100, n)) / 100);
      this.refresh();
    };
    for (const [input, commit] of [[this.hex, commitHex], [this.opacity, commitOpacity]] as const) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') this.refresh();
        e.stopPropagation();
      });
      input.addEventListener('change', commit);
      input.addEventListener('focus', () => input.select());
    }
    this.refresh();
  }

  refresh(): void {
    const value = this.options.read();
    if (value === null) return;
    if (value === MIXED) {
      this.hex.value = tr('Смешанное');
      this.opacity.value = '';
      return;
    }
    const hex = colorToHex(value.color);
    this.swatch.style.background = hex;
    if (document.activeElement !== this.hex) this.hex.value = hex.slice(1);
    if (document.activeElement !== this.opacity) this.opacity.value = String(Math.round(value.opacity * 100));
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  icon?: string;
}

/** A line between groups of choices in a drop-down (blend modes). */
export const CHOICE_SEPARATOR = { value: '__sep', label: '──────────' } as const;

/** A row of toggle buttons (alignment, direction). */
export class SegmentedField<T extends string> implements Field {
  readonly el: HTMLElement;
  private readonly buttons: Map<T, HTMLButtonElement> = new Map();
  private readonly read: () => Mixed<T> | null;

  constructor(title: string, choices: readonly Choice<T>[], read: () => Mixed<T> | null, write: (value: T) => void, withText = false) {
    this.read = read;
    this.el = h('div', { class: `segmented${withText ? ' with-text' : ''}`, role: 'radiogroup', 'aria-label': title });
    for (const choice of choices) {
      const button = h(
        'button',
        { class: 'segment', type: 'button', title: choice.label, 'aria-label': choice.label, onclick: () => write(choice.value) },
        choice.icon ? icon(choice.icon, 14) : null,
        withText || !choice.icon ? h('span', {}, choice.label) : null,
      );
      this.buttons.set(choice.value, button);
      this.el.append(button);
    }
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    for (const [v, b] of this.buttons) {
      b.classList.toggle('active', v === value);
      b.setAttribute('aria-checked', String(v === value));
      b.disabled = value === null;
    }
  }
}

export class SelectField<T extends string> implements Field {
  readonly el: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly read: () => Mixed<T> | null;

  constructor(title: string, choices: readonly Choice<T>[], read: () => Mixed<T> | null, write: (value: T) => void, label?: string) {
    this.read = read;
    this.select = h('select', { class: 'field-select', 'aria-label': title, title });
    for (const c of choices) this.select.append(h('option', { value: c.value, disabled: c.value === CHOICE_SEPARATOR.value }, c.label));
    this.select.addEventListener('change', () => write(this.select.value as T));
    this.select.addEventListener('keydown', (e) => e.stopPropagation());
    this.el = label ? h('label', { class: 'field select-wrap' }, h('span', { class: 'field-label' }, label), this.select) : h('div', { class: 'field select-wrap' }, this.select);
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    this.select.disabled = value === null;
    mixedOption(this.select, value === MIXED);
    this.select.value = value === null ? '' : value === MIXED ? '__mixed' : value;
  }
}

/**
 * «Смешанное» is in the list only while the layers differ: Safari shows a
 * hidden option in its menu anyway (a grey «Смешанное» under every choice).
 */
export function mixedOption(select: HTMLSelectElement, mixed: boolean): void {
  const option = select.querySelector<HTMLOptionElement>('option[value="__mixed"]');
  if (mixed && !option) select.append(h('option', { value: '__mixed', disabled: true }, tr('Смешанное')));
  else if (!mixed && option) option.remove();
}

export class CheckboxField implements Field {
  readonly el: HTMLElement;
  private readonly box: HTMLInputElement;
  private readonly read: () => Mixed<boolean> | null;

  constructor(label: string, read: () => Mixed<boolean> | null, write: (value: boolean) => void) {
    this.read = read;
    this.box = h('input', { type: 'checkbox' });
    this.box.addEventListener('change', () => write(this.box.checked));
    this.el = h('label', { class: 'checkbox' }, this.box, h('span', {}, label));
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    this.box.disabled = value === null;
    this.box.indeterminate = value === MIXED;
    this.box.checked = value === true;
  }
}

export class TextField implements Field {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly read: () => Mixed<string> | null;

  constructor(title: string, read: () => Mixed<string> | null, write: (value: string) => void, options: { list?: string; label?: string } = {}) {
    this.read = read;
    this.input = h('input', { class: 'field-input', type: 'text', 'aria-label': title, title, list: options.list, spellcheck: false });
    const commit = () => {
      const v = this.input.value.trim();
      const cur = this.read();
      if (v !== '' && cur !== null && v !== cur) write(v);
    };
    this.input.addEventListener('change', commit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') this.refresh();
      e.stopPropagation();
    });
    this.el = options.label ? h('label', { class: 'field text-field' }, h('span', { class: 'field-label' }, options.label), this.input) : h('div', { class: 'field text-field' }, this.input);
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    this.input.disabled = value === null;
    if (document.activeElement === this.input) return;
    this.input.value = value === null ? '' : value === MIXED ? '' : value;
    this.input.placeholder = value === MIXED ? tr('Смешанное') : '';
  }
}

/** Reads one value from many nodes: the value if they agree, MIXED otherwise. */
export function common<T>(ids: readonly string[], read: (id: string) => T, equals: (a: T, b: T) => boolean = Object.is): Mixed<T> | null {
  if (ids.length === 0) return null;
  const first = read(ids[0]!);
  for (let i = 1; i < ids.length; i++) if (!equals(first, read(ids[i]!))) return MIXED;
  return first;
}

type Align = 'MIN' | 'CENTER' | 'MAX';

/**
 * 3×3 alignment picker for auto layout (BUG-006): the dot shows where children
 * sit inside the frame; a click puts them there. Axes follow the direction.
 */
export class AlignGrid implements Field {
  readonly el: HTMLElement;
  private readonly cells: HTMLButtonElement[] = [];
  private readonly read: () => { x: Align; y: Align; distributed: 'x' | 'y' | null } | null;

  constructor(read: () => { x: Align; y: Align; distributed: 'x' | 'y' | null } | null, write: (x: Align, y: Align) => void) {
    this.read = read;
    this.el = h('div', { class: 'align-grid', role: 'radiogroup', 'aria-label': tr('Выравнивание содержимого') });
    const names: Record<Align, [string, string]> = { MIN: [tr('слева'), tr('сверху')], CENTER: [tr('по центру'), tr('по центру')], MAX: [tr('справа'), tr('снизу')] };
    for (const y of ['MIN', 'CENTER', 'MAX'] as const) {
      for (const x of ['MIN', 'CENTER', 'MAX'] as const) {
        const label = `${names[y][1]}, ${names[x][0]}`.replace(tr('по центру, по центру'), tr('по центру'));
        const cell = h('button', { class: 'align-cell', type: 'button', title: tr('Разместить {0}', label), 'aria-label': label, onclick: () => write(x, y) }, h('span', { class: 'align-dot' }));
        cell.dataset.x = x;
        cell.dataset.y = y;
        this.cells.push(cell);
        this.el.append(cell);
      }
    }
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    for (const cell of this.cells) {
      const x = cell.dataset.x as Align;
      const y = cell.dataset.y as Align;
      // With "space between" along an axis, every cell on that axis is equivalent.
      const active = value !== null && (value.distributed === 'x' || x === value.x) && (value.distributed === 'y' || y === value.y);
      cell.classList.toggle('active', active);
      cell.setAttribute('aria-checked', String(active));
      cell.disabled = value === null;
    }
  }
}
