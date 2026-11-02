// The bar over the selection: what is used most for what is selected, right
// where the eyes are — text style, colour, bold/italic/underline, link, list
// and alignment for a text; fill, auto layout and crop for frames, shapes and
// pictures; alignment for several layers; ✦ for each. Its last button opens or
// hides the whole right panel, so one can work with the bar alone and unfold
// the details only when needed (Figma has no such thing).

import { SHAPE_TYPES, tr, type Color, type NodeId, type Paint } from '#core';
import type { Command } from '../commands.ts';
import { MIXED_RUN } from '#layout';
import type { Editor } from '../editor.ts';
import { formatShortcut } from '../keyboard.ts';
import type { CanvasView } from '../canvas-view.ts';
import { openColorPicker } from './color-picker.ts';
import { h, icon, sparkles } from './dom.ts';
import { openStylePicker } from './styles-ui.ts';
import { FontPicker, WeightField } from './font-picker.ts';
import { MIXED } from './fields.ts';
import type { ContextBarMode } from './settings-dialog.ts';
import { hexToColor, solid, type BoardRole, type BoardShape } from '#core';
import { CODE_LANGS, isCodeLang, roleOf } from '#components';
import { addBoardColor, codeOf, setCodeLang, TAPE_COLORS, TAPE_NAMES, INK_COLORS, inkFor, lineDash, lineKindOf, SHAPE_COLORS, SHAPE_KINDS, shapeStrokeAuto, STICKY_COLORS, straighten, type LineKind } from '../board.ts';
import { linesOf, sortIntoSections, sortOptions, textToStickies } from '../board-smart.ts';
import { anyLocked, boardMenuItems, contentsHidden, setStickySize, STICKY_SIZES, stickySizeOf } from '../board-actions.ts';
import { ContextMenu, type MenuItem } from './context-menu.ts';
import { linkOfCard } from '../link-card.ts';
import { alignCellsV, cellAlignV, cellTexts, fillCellsWith, styleCellTexts } from '../tables.ts';
import { mergeActions, tableMenuItems } from './table-ui.ts';
import { openLink } from '../text-links.ts';

/** Board objects of one kind get their own bar (FEAT-083). */
function boardBarKind(d: import('#core').Document, ids: readonly NodeId[]): string | null {
  const kinds = new Set(ids.map((id) => roleOf(d, id)?.kind ?? (d.type(id) === 'SECTION' ? 'SECTION' : '')));
  if (kinds.size === 1 && kinds.has('SECTION')) return 'SECTION';
  if (kinds.size !== 1) return null;
  const k = [...kinds][0]!;
  return ['STICKY', 'SHAPE', 'CONNECTOR', 'MARKER', 'STAMP', 'LINK', 'CODE', 'TAPE'].includes(k) ? k : null;
}

/** Section colours on a board: the light tints of a design's sections. */
const SECTION_HEXES = ['#FFFFFF', '#F0F0F0', '#FFE3E0', '#FFEDD9', '#FFF8D1', '#E0F7E3', '#DEEDFF', '#EDE3FF'];
const SECTION_NAMES = [tr('Белый'), tr('Серый'), tr('Красный'), tr('Оранжевый'), tr('Жёлтый'), tr('Зелёный'), tr('Синий'), tr('Фиолетовый')];

const hexOf = (c: Color) => {
  const p = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`.toUpperCase();
};

export interface ContextBarHost {
  /** Shows or hides the right panel. */
  toggleRight(): void;
  rightHidden(): boolean;
  openSmart(): void;
  /** Board menu items the app adds (a link to the object, sticky sizes). */
  boardExtras?(): { copyLink?: MenuItem };
}

const SHAPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'SECTION', 'COMPONENT_SET']);

const solidOf = (fills: readonly Paint[]): { color: Color; opacity: number } | null => {
  const p = [...fills].reverse().find((f) => f.visible && f.type === 'SOLID');
  return p && p.type === 'SOLID' ? { color: p.color, opacity: p.opacity } : null;
};
const css = (c: Color, opacity = 1) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a * opacity})`;

export class ContextBar {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly canvas: CanvasView;
  private readonly commands: Map<string, Command>;
  private readonly host: ContextBarHost;
  /** What the bar is built for: rebuilt only when it changes. */
  private kind = '';
  private frame = 0;
  private pressed = false;
  /** Refreshes the pressed states and the swatch of the current build. */
  private sync: () => void = () => {};
  enabled = true;
  /** When it shows (Settings): with the right panel folded, always or never. */
  mode: ContextBarMode = 'folded';
  /** On a board: no right panel to unfold and no ✦ yet, the board's own controls. */
  boardMode = false;

  /** The «⋯» list on a board. */
  private readonly menu = new ContextMenu(document.body);

  constructor(editor: Editor, canvas: CanvasView, commands: Map<string, Command>, host: ContextBarHost) {
    this.editor = editor;
    this.canvas = canvas;
    this.commands = commands;
    this.host = host;
    this.el = h('div', { class: 'context-bar', role: 'toolbar', 'aria-label': tr('Быстрые настройки выделенного'), hidden: true });
    // Not over the canvas while dragging: it comes back where the layer has landed.
    canvas.element.addEventListener('pointerdown', () => {
      this.pressed = true;
      this.el.hidden = true;
    });
    window.addEventListener('pointerup', () => {
      if (!this.pressed) return;
      this.pressed = false;
      this.schedule();
    });
    for (const ev of ['selection', 'viewport', 'change', 'editText', 'tool', 'document', 'vectorEdit', 'shapeBuilder', 'textSelection'] as const) editor.events.on(ev, () => this.schedule());
    window.addEventListener('resize', () => this.schedule());
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private update(): void {
    const e = this.editor;
    const d = e.doc;
    const all = e.editingText ? [e.editingText] : e.topLevelSelection();
    // Connectors held by objects at both ends follow them: a section with its arrows is one thing to act on
    // (else the bar would offer aligning, which moves nothing — BUG-072).
    const held = (id: NodeId) => {
      const r = roleOf(d, id);
      return (r?.kind === 'CONNECTOR' && r.start.node !== null && r.end.node !== null) || r?.kind === 'CONNECTOR_LABEL';
    };
    const free = all.filter((id) => !held(id));
    const ids = free.length > 0 ? free : all;
    const wantedAlways = this.mode === 'always' || (this.mode === 'folded' && this.host.rightHidden());
    // Cells of a table get their bar always, as in FigJam (FEAT-170): fill, text, merging — right over them.
    const cells = !e.editingText && ids.length > 0 && ids.every((id) => e.isTableCell(id)) && new Set(ids.map((id) => d.parent(id))).size === 1;
    const wanted = wantedAlways || cells;
    const show = this.enabled && wanted && !this.pressed && !d.readOnly && ids.length > 0 && !this.canvas.busy && e.tool === 'select' && e.vectorEdit === null && e.shapeBuilder === null;
    if (!show) {
      this.el.hidden = true;
      return;
    }
    const types = [...new Set(ids.map((id) => d.type(id)))];
    const image = ids.length === 1 && d.get(ids[0]!, 'fills').some((p) => p.visible && p.type === 'IMAGE');
    // On a board a locked object shows only that it is locked and how to unlock it.
    const board = e.editingText ? null : this.boardMode && anyLocked(e, ids) ? 'LOCKED' : boardBarKind(d, ids);
    const kind = board ? `board-${board}` : cells ? 'cells' : types.length === 1 && types[0] === 'TEXT' ? 'text' : ids.length > 1 ? 'many' : image ? 'image' : SHAPES.has(types[0]!) ? 'shape' : 'other';
    // A board's own colours are in its bar: a colour added or removed (by anyone) rebuilds it.
    const key = `${kind}:${ids.length === 1 ? ids[0] : ids.join(',')}${board ? `:${d.get(d.rootId, 'boardColors').join('')}` : ''}`;
    if (key !== this.kind) {
      this.kind = key;
      this.build(kind, ids);
    }
    this.sync();
    this.el.hidden = this.el.childElementCount === 0;
    this.place(ids);
  }

  /** Over the selection (under it when there is no room above), inside the canvas. */
  private place(ids: readonly NodeId[]): void {
    const e = this.editor;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    // Over the cells' table, past its column handles, not over its other rows (FEAT-170).
    const cellTable = this.kind.startsWith('cells:') && ids[0] ? e.doc.parent(ids[0]) : null;
    if (cellTable) ids = [cellTable];
    for (const id of ids) {
      const b = e.scene.bounds(id);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    const v = e.viewport;
    const area = this.canvas.element;
    const left = area.offsetLeft;
    const top = area.offsetTop;
    const W = area.clientWidth;
    const H = area.clientHeight;
    const sx0 = x0 * v.zoom + v.offsetX;
    const sx1 = x1 * v.zoom + v.offsetX;
    const sy0 = y0 * v.zoom + v.offsetY;
    const sy1 = y1 * v.zoom + v.offsetY;
    const bw = this.el.offsetWidth;
    const bh = this.el.offsetHeight;
    // Top-level frames have their name above them: room for it; anything inside sits closer.
    const gap = cellTable ? 22 : ids.some((id) => e.doc.parent(id) === e.pageId) ? 30 : 10;
    let y = sy0 - bh - gap;
    if (y < 8) y = Math.min(H - bh - 72, sy1 + gap);
    const x = Math.max(8, Math.min(W - bw - 8, (sx0 + sx1) / 2 - bw / 2));
    this.el.style.left = `${left + x}px`;
    this.el.style.top = `${top + Math.max(8, y)}px`;
  }

  private button(label: string, content: Node | string, run: () => void, command?: string): HTMLButtonElement {
    const key = command ? formatShortcut(this.commands.get(command)?.keys?.[0] ?? '') : '';
    const title = key ? `${label} (${key})` : label;
    const b = h('button', { class: 'cb-button', type: 'button', title, 'aria-label': label }, content);
    // Keep the focus (and a text selection) where it is.
    b.addEventListener('pointerdown', (ev) => ev.preventDefault());
    b.addEventListener('click', run);
    return b;
  }

  private run(command: string): () => void {
    return () => this.commands.get(command)?.run();
  }

  private separator(): HTMLElement {
    return h('span', { class: 'cb-sep', 'aria-hidden': 'true' });
  }

  /** A colour swatch: the colour of `read`, a picker writing through `write`. */
  /**
   * A colour button: a filled square for a fill, a ring for a stroke (as they
   * look on the layer). No colour — a dashed, crossed outline and a title saying
   * a click adds one (a dark chip on a dark bar was invisible and puzzling).
   */
  private swatch(label: string, read: () => { color: Color; opacity: number } | null, write: (c: Color, opacity: number) => void, ring = false): HTMLButtonElement {
    const chip = h('span', { class: `cb-swatch${ring ? ' ring' : ''}` });
    const b = this.button(label, chip, () => {
      const now = read() ?? { color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 };
      openColorPicker({ anchor: b, color: now.color, opacity: now.opacity, onChange: write });
    });
    const syncChip = () => {
      const c = read();
      const color = c ? css(c.color, c.opacity) : '';
      chip.style.background = ring ? '' : color;
      chip.style.borderColor = ring ? color : '';
      chip.classList.toggle('none', !c);
      const title = c ? label : tr('{0}: нет — нажмите, чтобы добавить', label);
      b.title = title;
      b.setAttribute('aria-label', title);
    };
    const prev = this.sync;
    this.sync = () => {
      prev();
      syncChip();
    };
    return b;
  }

  /**
   * A number: typed, or ↑/↓ (Shift — by 10); Enter or leaving the field applies,
   * Esc puts the value back. `read` null hides the field (not for this layer).
   */
  private field(label: string, glyph: Node | string, read: () => number | null, write: (v: number) => void, opts: { min?: number; max?: number; unit?: string; /** A list to pick from (a chevron next to the field). */ choices?: () => { label: string; pick: () => void; on: boolean }[] } = {}): HTMLElement {
    const input = h('input', { class: 'cb-input', type: 'text', inputmode: 'decimal', 'aria-label': label, spellcheck: false });
    const el = h('label', { class: 'cb-field', title: label }, h('span', { class: 'cb-field-glyph', 'aria-hidden': 'true' }, glyph), input, opts.unit ? h('span', { class: 'cb-field-unit' }, opts.unit) : '');
    if (opts.choices) {
      const choices = opts.choices;
      const chevron = h('button', { class: 'cb-field-more', type: 'button', title: tr('{0}: выбрать из списка', label), 'aria-label': tr('{0}: выбрать из списка', label), 'aria-haspopup': 'listbox' }, icon('chevronDown', 12));
      chevron.addEventListener('pointerdown', (ev) => ev.preventDefault());
      chevron.addEventListener('click', (ev) => {
        ev.preventDefault();
        document.querySelector('.cb-list')?.remove();
        const list = h('div', { class: 'cb-list', role: 'listbox', 'aria-label': label });
        const close = () => {
          list.remove();
          document.removeEventListener('pointerdown', outside, true);
        };
        const outside = (e2: Event) => {
          if (!list.contains(e2.target as Node) && !chevron.contains(e2.target as Node)) close();
        };
        for (const c of choices()) {
          const item = h('button', { class: `cb-list-item${c.on ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(c.on) }, c.label);
          item.addEventListener('pointerdown', (e2) => e2.preventDefault());
          item.addEventListener('click', () => {
            close();
            c.pick();
            show();
          });
          list.append(item);
        }
        document.body.append(list);
        const r = el.getBoundingClientRect();
        const below = r.bottom + 6 + list.offsetHeight < window.innerHeight;
        list.style.left = `${r.left}px`;
        list.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - list.offsetHeight)}px`;
        list.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'center' });
        document.addEventListener('pointerdown', outside, true);
      });
      el.append(chevron);
    }
    const clamp = (v: number) => Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, v));
    const show = () => {
      const v = read();
      el.hidden = v === null;
      if (v !== null && document.activeElement !== input) input.value = String(Math.round(v * 100) / 100);
    };
    const apply = () => {
      const v = Number(input.value.replace(',', '.').replace(/[^\d.+-]/g, ''));
      if (input.value.trim() !== '' && Number.isFinite(v) && v !== read()) write(clamp(v));
      show();
    };
    input.addEventListener('keydown', (ev) => {
      // The editor's shortcuts stay out of the field.
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        apply();
        input.select();
      } else if (ev.key === 'Escape') {
        input.value = '';
        show();
        input.blur();
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        const now = read() ?? 0;
        write(clamp(now + (ev.key === 'ArrowUp' ? 1 : -1) * (ev.shiftKey ? 10 : 1)));
        input.value = String(Math.round((read() ?? now) * 100) / 100);
      }
    });
    input.addEventListener('blur', apply);
    input.addEventListener('focus', () => input.select());
    const prev = this.sync;
    this.sync = () => {
      prev();
      show();
    };
    return el;
  }

  private toggle(label: string, content: Node | string, command: string, pressed: () => boolean): HTMLButtonElement {
    const b = this.button(label, content, this.run(command), command);
    const prev = this.sync;
    this.sync = () => {
      prev();
      const on = pressed();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    };
    return b;
  }

  /** Round colour buttons; the current colour is ringed. */
  private dots(label: string, base: readonly string[], read: () => string | null, write: (hex: string) => void, names?: readonly string[], own = false): HTMLElement {
    const d = this.editor.doc;
    // A board's own colours come after the usual ones (step 10), and «+» adds one.
    const extra = own ? d.get(d.rootId, 'boardColors').filter((c) => !base.some((x) => x.toUpperCase() === c)) : [];
    const colors = [...base, ...extra];
    const wrap = h('span', { class: 'cb-dots', role: 'group', 'aria-label': label });
    const buttons = colors.map((hex, i) => {
      const name = names?.[i] ?? STICKY_COLORS.find((c) => c.hex === hex)?.name ?? (i >= base.length ? tr('свой {0}', hex) : hex);
      const b = this.button(`${label}: ${name}`, h('span', { class: 'cb-dot-chip', style: { background: hex } }), () => write(hex));
      b.classList.add('cb-dot');
      return b;
    });
    wrap.append(...buttons);
    if (own && !d.readOnly) {
      const input = h('input', { class: 'cb-color-input', type: 'color', tabindex: -1, 'aria-hidden': 'true' }) as HTMLInputElement;
      const plus = this.button(tr('Свой цвет: выбрать и добавить в палитру доски'), icon('plus', 12), () => {
        input.value = (read() ?? '#888888').toLowerCase();
        input.click();
      });
      plus.classList.add('cb-dot', 'cb-dot-add');
      input.addEventListener('change', () => {
        const hex = input.value.toUpperCase();
        addBoardColor(this.editor, hex);
        write(hex);
        this.schedule();
      });
      wrap.append(plus, input);
    }
    const prev = this.sync;
    this.sync = () => {
      prev();
      const now = read();
      buttons.forEach((b, i) => b.classList.toggle('on', now === colors[i]));
    };
    return wrap;
  }

  /** A button that opens a short list under it. */
  /** A button with a word on it (when an icon would not say what it does). */
  private textButton(label: string, run: () => void): HTMLButtonElement {
    const b = this.button(label, label, run);
    b.classList.add('cb-text');
    return b;
  }

  /** A worded button opening a list of worded choices. */
  private textMenuButton(label: string, items: { label: string; run: () => void; on?: () => boolean }[]): HTMLButtonElement {
    const b = this.textButton(label, () => {
      document.querySelector('.cb-menu')?.remove();
      const r = b.getBoundingClientRect();
      const menu = h('div', { class: 'cb-menu cb-menu-list', role: 'menu', 'aria-label': label });
      const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
      };
      const outside = (ev: Event) => {
        if (!menu.contains(ev.target as Node) && ev.target !== b) close();
      };
      for (const item of items) {
        // The current one is marked (else a choice of the same thing seems to do nothing).
        const on = item.on?.() ?? false;
        const it = h('button', { class: `cb-menu-row${on ? ' on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(on) }, on ? `✓ ${item.label}` : item.label);
        it.addEventListener('pointerdown', (ev) => ev.preventDefault());
        it.addEventListener('click', () => {
          close();
          item.run();
        });
        menu.append(it);
      }
      document.body.append(menu);
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`;
      menu.style.top = `${r.bottom + 6}px`;
      document.addEventListener('pointerdown', outside, true);
    });
    b.append(' ▾');
    return b;
  }

  private menuButton(label: string, content: () => Node, items: { label: string; icon: string; run: () => void; on?: () => boolean }[]): HTMLButtonElement {
    const b = this.button(label, content(), () => {
      document.querySelector('.cb-menu')?.remove();
      const r = b.getBoundingClientRect();
      const menu = h('div', { class: 'cb-menu', role: 'menu', 'aria-label': label });
      const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
      };
      const outside = (ev: Event) => {
        if (!menu.contains(ev.target as Node)) close();
      };
      for (const item of items) {
        const on = item.on?.() ?? false;
        const it = h('button', { class: `cb-menu-item${on ? ' on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(on), title: item.label, 'aria-label': item.label }, icon(item.icon, 18));
        it.addEventListener('pointerdown', (ev) => ev.preventDefault());
        it.addEventListener('click', () => {
          close();
          item.run();
        });
        menu.append(it);
      }
      document.body.append(menu);
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`;
      menu.style.top = `${r.bottom + 6}px`;
      document.addEventListener('pointerdown', outside, true);
    });
    const prev = this.sync;
    this.sync = () => {
      prev();
      b.replaceChildren(content());
    };
    return b;
  }

  /** Sizes to pick; a sticky's text also has «Авто» (the largest that fits). */
  private sizeChoices(ids: readonly NodeId[]): { label: string; pick: () => void; on: boolean }[] {
    const e = this.editor;
    const d = e.doc;
    const stickyOf = (id: NodeId): NodeId | null => {
      if (roleOf(d, id)?.kind === 'STICKY') return id;
      const p = d.parent(id);
      return p && roleOf(d, p)?.kind === 'STICKY' ? p : null;
    };
    const stickies = ids.map(stickyOf).filter((x): x is NodeId => !!x);
    const current = (() => {
      const v = e.textStyleValue('fontSize');
      if (typeof v === 'number') return v;
      const first = ids[0];
      const text = first && d.type(first) === 'TEXT' ? first : first ? d.children(first).find((c) => roleOf(d, c)?.kind === 'STICKY_TEXT' || roleOf(d, c)?.kind === 'SHAPE_TEXT') : undefined;
      return text ? d.get(text, 'fontSize') : null;
    })();
    const auto = stickies.length > 0 && stickies.every((s) => {
      const r = d.get(s, 'board');
      return r?.kind === 'STICKY' && !r.fontSize;
    });
    const out: { label: string; pick: () => void; on: boolean }[] = [];
    if (stickies.length) out.push({ label: tr('Авто — по размеру стикера'), pick: () => e.setTextSize(null), on: auto });
    for (const s of [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96]) out.push({ label: String(s), pick: () => e.setTextSize(s), on: !auto && current === s });
    return out;
  }

  /**
   * A board shape's outline: none, solid, dashed or dotted; its width; its
   * colour (by default a darker tone of the fill). The button shows how it is now.
   */
  private shapeStroke(outlines: () => NodeId[]): HTMLButtonElement {
    const e = this.editor;
    const d = e.doc;
    const color = (hex: string) => hexToColor(hex)!;
    const hexOf2 = (paints: readonly Paint[]) => {
      const f = paints.find((p) => p.visible && p.type === 'SOLID');
      return f && f.type === 'SOLID' ? hexOf(f.color) : null;
    };
    type Kind = 'NONE' | 'SOLID' | 'DASHED' | 'DOTTED';
    const kindOf = (o: NodeId): Kind => {
      if (!d.get(o, 'strokes').some((p) => p.visible) || d.get(o, 'strokeWeight') <= 0) return 'NONE';
      // An outline of the fill's own colour cannot be seen (shapes made before BUG-081): it counts as none.
      if (hexOf2(d.get(o, 'strokes')) === hexOf2(d.get(o, 'fills'))) return 'NONE';
      const dash = d.get(o, 'dashPattern');
      return dash.length === 0 ? 'SOLID' : dash[0] === 0 ? 'DOTTED' : 'DASHED';
    };
    const dashFor = (kind: Kind, w: number): number[] => (kind === 'NONE' ? [] : lineDash(kind, w, kind === 'DOTTED'));
    const first = () => outlines()[0] ?? null;
    /** The outline's colour, or its automatic tone when it has none yet (or the fill's own, which does not show). */
    const strokeColorOf = (o: NodeId) => {
      const fill = hexOf2(d.get(o, 'fills')) ?? '#FFFFFF';
      const own = hexOf2(d.get(o, 'strokes'));
      return own && own !== fill ? own : shapeStrokeAuto(fill);
    };
    const apply = (label: string, change: (o: NodeId, now: { kind: Kind; weight: number; hex: string }) => { kind: Kind; weight: number; hex: string }) =>
      e.commit(label, (tx) => {
        for (const o of outlines()) {
          const now = { kind: kindOf(o), weight: d.get(o, 'strokeWeight') || 2, hex: strokeColorOf(o) };
          const next = change(o, now);
          tx.update(o, {
            strokes: next.kind === 'NONE' ? [] : [solid(color(next.hex))],
            strokeWeight: next.weight,
            dashPattern: dashFor(next.kind, next.weight),
            strokeCap: next.kind === 'DOTTED' ? 'ROUND' : 'NONE',
          });
        }
      });
    const preview = h('span', { class: 'cb-stroke-preview' });
    const b = this.button(tr('Обводка: вид, толщина, цвет'), preview, () => open());
    const sync = () => {
      const o = first();
      const kind = o ? kindOf(o) : 'NONE';
      preview.className = `cb-stroke-preview ${kind.toLowerCase()}`;
      preview.style.borderColor = o && kind !== 'NONE' ? strokeColorOf(o) : '';
    };
    const prev = this.sync;
    this.sync = () => {
      prev();
      sync();
    };
    const open = () => {
      document.querySelector('.cb-menu')?.remove();
      const menu = h('div', { class: 'cb-menu cb-stroke-menu', role: 'dialog', 'aria-label': tr('Обводка') });
      const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
      };
      const outside = (ev: Event) => {
        if (!menu.contains(ev.target as Node) && !b.contains(ev.target as Node)) close();
      };
      const row = (title: string, items: { label: Node | string; title: string; on: () => boolean; run: () => void }[]) => {
        const buttons = items.map((it) => {
          const btn = h('button', { class: 'cb-stroke-choice', type: 'button', title: it.title, 'aria-label': it.title }, it.label);
          btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
          btn.addEventListener('click', () => {
            it.run();
            refresh();
          });
          return { btn, on: it.on };
        });
        menu.append(h('div', { class: 'cb-stroke-row' }, h('span', { class: 'cb-stroke-title' }, title), ...buttons.map((x) => x.btn)));
        return buttons;
      };
      const o = () => first();
      const kinds: [Kind, string][] = [['NONE', tr('Нет')], ['SOLID', tr('Сплошная')], ['DASHED', tr('Пунктир')], ['DOTTED', tr('Точки')]];
      const all = [
        ...row(tr('Вид'), kinds.map(([k, label]) => ({ label: h('span', { class: `cb-stroke-sample ${k.toLowerCase()}` }), title: label, on: () => (o() ? kindOf(o()!) === k : false), run: () => apply(tr('Обводка'), (_, now) => ({ ...now, kind: k })) }))),
        ...row(tr('Толщина'), [1, 2, 4, 8].map((w) => ({ label: String(w), title: tr('Толщина {0} px', w), on: () => (o() ? kindOf(o()!) !== 'NONE' && d.get(o()!, 'strokeWeight') === w : false), run: () => apply(tr('Толщина обводки'), (_, now) => ({ ...now, kind: now.kind === 'NONE' ? 'SOLID' : now.kind, weight: w })) }))),
        ...row(tr('Цвет'), [
          { label: tr('Авто'), title: tr('Темнее заливки'), on: () => { const x = o(); return !!x && kindOf(x) !== 'NONE' && strokeColorOf(x) === shapeStrokeAuto(hexOf2(d.get(x, 'fills')) ?? '#FFFFFF'); }, run: () => apply(tr('Цвет обводки'), (id, now) => ({ ...now, kind: now.kind === 'NONE' ? 'SOLID' : now.kind, hex: shapeStrokeAuto(hexOf2(d.get(id, 'fills')) ?? '#FFFFFF') })) },
          ...INK_COLORS.map((hex) => ({ label: h('span', { class: 'cb-dot-chip', style: { background: hex } }), title: hex, on: () => { const x = o(); return !!x && kindOf(x) !== 'NONE' && strokeColorOf(x) === hex; }, run: () => apply(tr('Цвет обводки'), (_, now) => ({ ...now, kind: now.kind === 'NONE' ? 'SOLID' : now.kind, hex })) })),
        ]),
      ];
      const refresh = () => {
        for (const x of all) x.btn.classList.toggle('on', x.on());
        sync();
      };
      refresh();
      document.body.append(menu);
      const r = b.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`;
      menu.style.top = `${r.bottom + 6}px`;
      document.addEventListener('pointerdown', outside, true);
    };
    return b;
  }

  /**
   * A button that opens rows of choices (a word or a sample each), the chosen
   * ones marked; it stays open for the next choice and shows the current state.
   */
  private choiceButton(label: string, content: () => Node, rows: { title: string; items: { label: () => Node | string; title: string; on: () => boolean; run: () => void }[] }[]): HTMLButtonElement {
    const b = this.button(label, content(), () => {
      document.querySelector('.cb-menu')?.remove();
      const menu = h('div', { class: 'cb-menu cb-stroke-menu', role: 'dialog', 'aria-label': label });
      const all: { btn: HTMLButtonElement; on: () => boolean }[] = [];
      const refresh = () => {
        for (const x of all) x.btn.classList.toggle('on', x.on());
        b.replaceChildren(content());
      };
      for (const row of rows) {
        const buttons = row.items.map((it) => {
          const btn = h('button', { class: 'cb-stroke-choice', type: 'button', title: it.title, 'aria-label': it.title }, it.label());
          btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
          btn.addEventListener('click', () => {
            it.run();
            refresh();
          });
          all.push({ btn, on: it.on });
          return btn;
        });
        menu.append(h('div', { class: 'cb-stroke-row' }, h('span', { class: 'cb-stroke-title' }, row.title), ...buttons));
      }
      const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
      };
      const outside = (ev: Event) => {
        if (!menu.contains(ev.target as Node) && !b.contains(ev.target as Node)) close();
      };
      refresh();
      document.body.append(menu);
      const r = b.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`;
      menu.style.top = `${r.bottom + 6}px`;
      document.addEventListener('pointerdown', outside, true);
    });
    const prev = this.sync;
    this.sync = () => {
      prev();
      b.replaceChildren(content());
    };
    return b;
  }

  /** Aligning and spacing in one button (a row of nine would not fit over a sticky). */
  private alignMenu(): HTMLButtonElement {
    const item = (command: string, glyph: string) => ({ label: this.commands.get(command)!.label, icon: glyph, run: this.run(command) });
    return this.menuButton(tr('Выровнять и распределить'), () => icon('alignLeft', 16), [
      item('align.left', 'alignLeft'),
      item('align.hcenter', 'alignHCenter'),
      item('align.right', 'alignRight'),
      item('align.top', 'alignTop'),
      item('align.vcenter', 'alignVCenter'),
      item('align.bottom', 'alignBottom'),
      item('align.distributeH', 'columns'),
      item('align.distributeV', 'rows'),
      item('object.tidyUp', 'gapRows'),
    ]);
  }

  private boardParts(kind: string, ids: readonly NodeId[]): (HTMLElement | null)[] {
    const e = this.editor;
    const d = e.doc;
    const first = ids[0]!;
    const role = <K extends BoardRole['kind']>(id: NodeId) => d.get(id, 'board') as Extract<BoardRole, { kind: K }>;
    const child = (id: NodeId, k: BoardRole['kind']) => d.children(id).find((c) => roleOf(d, c)?.kind === k) ?? null;
    const fillHex = (id: NodeId | null) => {
      const f = id ? d.get(id, 'fills').find((p) => p.visible && p.type === 'SOLID') : undefined;
      return f && f.type === 'SOLID' ? hexOf(f.color) : null;
    };
    const strokeHex = (id: NodeId) => {
      const f = d.get(id, 'strokes').find((p) => p.visible && p.type === 'SOLID');
      return f && f.type === 'SOLID' ? hexOf(f.color) : null;
    };
    const color = (hex: string) => hexToColor(hex)!;
    const textOf = (id: NodeId) => child(id, roleOf(d, id)?.kind === 'STICKY' ? 'STICKY_TEXT' : 'SHAPE_TEXT');
    switch (kind) {
      case 'LOCKED': {
        const b = this.button(tr('Открепить'), h('span', { class: 'cb-locked' }, icon('lock', 14), ' ', tr('Закреплено')), this.run('object.toggleLock'), 'object.toggleLock');
        b.title = tr('Закреплено: не двигается и не попадает в рамку выделения. Нажмите, чтобы открепить (⇧⌘L)');
        b.classList.add('cb-text');
        return [b];
      }
      case 'LINK': {
        // A link card: its page, nothing of a frame's look (FEAT-160).
        const url = ids.length === 1 ? linkOfCard(e, ids[0]!) : null;
        if (!url) return [];
        const b = this.button(tr('Открыть ссылку'), h('span', { class: 'cb-locked' }, icon('link', 14), ' ', tr('Открыть')), () => openLink(url));
        b.title = `${tr('Открыть ссылку')}: ${url}`;
        b.classList.add('cb-text');
        return [b];
      }
      case 'TAPE': {
        // Washi tape: its colour (the next strip takes it too).
        return [
          this.dots(tr('Цвет скотча'), TAPE_COLORS, () => fillHex(first), (hex) => {
            e.commit(tr('Цвет скотча'), (tx) => ids.forEach((id) => tx.set(id, 'fills', [solid(color(hex), 0.78)])));
            e.boardPrefs.tapeColor = hex;
          }, TAPE_NAMES.map((n) => tr(n)), true),
        ];
      }
      case 'CODE': {
        // A code block (step 10): its language (the colours follow) and copying the code.
        const langOf = () => {
          const langs = new Set(ids.map((id) => (d.get(id, 'board') as { lang?: string } | null)?.lang));
          const one = langs.size === 1 ? [...langs][0] : undefined;
          return isCodeLang(one) ? one : null;
        };
        const name = () => tr(CODE_LANGS.find((l) => l.id === langOf())?.label ?? 'Разные');
        const lang = this.textMenuButton(name(), CODE_LANGS.map((l) => ({ label: tr(l.label), run: () => setCodeLang(e, ids, l.id), on: () => langOf() === l.id })));
        lang.title = tr('Язык кода: от него зависит подсветка');
        lang.setAttribute('aria-label', tr('Язык кода'));
        const prevLang = this.sync;
        this.sync = () => {
          prevLang();
          lang.firstChild!.textContent = name();
        };
        const copy = this.textButton(tr('Копировать код'), () => {
          const code = ids.map((id) => codeOf(d, id) ?? '').join('\n\n');
          void navigator.clipboard.writeText(code).then(
            () => e.toast(tr('Код скопирован')),
            () => e.toast(tr('Не получилось скопировать: браузер не дал доступ к буферу обмена')),
          );
        });
        return [lang, this.separator(), copy];
      }
      case 'SECTION': {
        const hidden = () => ids.every((id) => contentsHidden(e, id));
        const eye = this.button(tr('Скрыть содержимое раздела'), icon('eye', 16), this.run('board.toggleSectionContents'));
        const prev = this.sync;
        this.sync = () => {
          prev();
          const label = hidden() ? tr('Показать содержимое раздела') : tr('Скрыть содержимое раздела');
          eye.title = label;
          eye.setAttribute('aria-label', label);
          eye.replaceChildren(icon(hidden() ? 'eyeOff' : 'eye', 16));
          eye.classList.toggle('on', hidden());
        };
        return [
          this.dots(tr('Цвет раздела'), SECTION_HEXES, () => fillHex(first), (hex) => e.commit(tr('Цвет раздела'), (tx) => ids.forEach((id) => tx.update(id, { fills: [solid(color(hex))], fillStyleId: null }))), SECTION_NAMES, true),
          this.separator(),
          this.textButton(tr('Размер по содержимому'), this.run('board.fitSection')),
          eye,
        ];
      }
      case 'STICKY': {
        // Square, wide or big: the word on the button is the current one.
        const sizeName = () => STICKY_SIZES.find((x) => x.id === stickySizeOf(e, ids))?.label ?? tr('Свой размер');
        const size = this.textMenuButton(sizeName(), STICKY_SIZES.map((x) => ({ label: x.label, run: () => setStickySize(e, x.id, ids), on: () => stickySizeOf(e, ids) === x.id })));
        size.title = tr('Размер стикера: квадратный, широкий или большой');
        size.setAttribute('aria-label', tr('Размер стикера'));
        const prevSize = this.sync;
        this.sync = () => {
          prevSize();
          size.firstChild!.textContent = sizeName();
        };
        return [
          size,
          this.field(tr('Размер текста'), icon('text', 14), () => {
            const t = child(first, 'STICKY_TEXT');
            return t ? d.get(t, 'fontSize') : null;
          }, (v) => e.setTextSize(v), { min: 4, max: 400, choices: () => this.sizeChoices(ids) }),
          this.separator(),
          this.dots(tr('Цвет стикера'), STICKY_COLORS.map((c) => c.hex), () => fillHex(first), (hex) => {
            e.boardPrefs.stickyColor = hex;
            e.commit(tr('Цвет стикера'), (tx) => {
              for (const id of ids) {
                tx.set(id, 'fills', [solid(color(hex))]);
                const t = textOf(id);
                if (t) tx.set(t, 'fills', [solid(color(inkFor(hex)))]);
              }
            });
          }, undefined, true),
        ];
      }
      case 'SHAPE': {
        const shapeIcon = () => icon(SHAPE_KINDS.find((k) => k.shape === role<'SHAPE'>(first).shape)?.icon ?? 'rectangle', 16);
        const kinds = this.menuButton(tr('Вид фигуры'), shapeIcon, SHAPE_KINDS.map((k) => ({
          label: k.label,
          icon: k.icon,
          on: () => role<'SHAPE'>(first).shape === k.shape,
          run: () => {
            e.boardPrefs.shape = k.shape as BoardShape;
            e.commit(tr('Вид фигуры'), (tx) => {
              for (const id of ids) tx.set(id, 'board', { kind: 'SHAPE', shape: k.shape });
            });
          },
        })));
        const outlines = () => ids.map((id) => child(id, 'SHAPE_OUTLINE')).filter((x): x is NodeId => !!x);
        const stroke = this.shapeStroke(outlines);
        return [
          kinds,
          this.separator(),
          this.dots(tr('Цвет фигуры'), SHAPE_COLORS, () => fillHex(child(first, 'SHAPE_OUTLINE')), (hex) => {
            e.boardPrefs.shapeColor = hex;
            e.commit(tr('Цвет фигуры'), (tx) => {
              for (const id of ids) {
                const o = child(id, 'SHAPE_OUTLINE');
                if (o) {
                  const before = fillHex(o) ?? '#FFFFFF';
                  tx.set(o, 'fills', [solid(color(hex))]);
                  // An outline in the automatic tone follows the new colour; one picked by hand stays.
                  const s = strokeHex(o);
                  if (s && (s === shapeStrokeAuto(before) || s === before)) tx.set(o, 'strokes', [solid(color(shapeStrokeAuto(hex)))]);
                }
                const t = textOf(id);
                if (t) tx.set(t, 'fills', [solid(color(inkFor(hex)))]);
              }
            });
          }, undefined, true),
          stroke,
        ];
      }
      case 'CONNECTOR': {
        const setRole = (label: string, patch: (r: Extract<BoardRole, { kind: 'CONNECTOR' }>) => Partial<Extract<BoardRole, { kind: 'CONNECTOR' }>>) =>
          e.commit(label, (tx) => {
            for (const id of ids) tx.set(id, 'board', { ...role<'CONNECTOR'>(id), ...patch(role<'CONNECTOR'>(id)) });
          });
        const routes = (['STRAIGHT', 'ELBOW', 'CURVE'] as const).map((r) => {
          const label = r === 'STRAIGHT' ? tr('Прямая') : r === 'ELBOW' ? tr('Под прямым углом') : tr('Плавная');
          const b = this.button(label, icon(r === 'STRAIGHT' ? 'routeStraight' : r === 'ELBOW' ? 'routeElbow' : 'routeCurve', 16), () => {
            e.boardPrefs.route = r;
            setRole(tr('Вид линии'), () => ({ route: r }));
          });
          return { r, b };
        });
        // Elbow lines go around objects; off — straight through them (FEAT-115).
        const avoidButton = this.button(tr('Обходить объекты'), icon('routeAvoid', 16), () => {
          const next = role<'CONNECTOR'>(first).avoid === false;
          setRole(next ? tr('Обходить объекты') : tr('Проходить сквозь объекты'), () => ({ avoid: next }));
        });
        const bent = () => ids.some((id) => !!role<'CONNECTOR'>(id).bend);
        const straightButton = this.button(tr('Убрать изгиб: линия проложится сама'), icon('routeReset', 16), () => straighten(e, ids));
        const ends = () => (d.get(first, 'startCap') !== 'NONE' ? 'both' : d.get(first, 'endCap') !== 'NONE' ? 'end' : 'none');
        const endsButton = this.button(tr('Концы: стрелка в конце, с двух сторон или без стрелок'), icon('arrowEnd', 16), () => {
          const next = ends() === 'end' ? 'both' : ends() === 'both' ? 'none' : 'end';
          e.commit(tr('Концы связи'), (tx) => {
            for (const id of ids) tx.update(id, { startCap: next === 'both' ? 'ARROW' : 'NONE', endCap: next === 'none' ? 'NONE' : 'ARROW' });
          });
        });
        const lineKind = () => lineKindOf(d.get(first, 'dashPattern'));
        const setKind = (kind: LineKind) =>
          e.commit(tr('Вид линии'), (tx) => {
            for (const id of ids) {
              const round = d.get(id, 'strokeCap') === 'ROUND' || kind === 'DOTTED';
              tx.update(id, { dashPattern: lineDash(kind, d.get(id, 'strokeWeight'), round), ...(kind === 'DOTTED' ? { strokeCap: 'ROUND' as const } : {}) });
            }
          });
        const dashButton = this.choiceButton(tr('Сплошная, пунктир или точки'), () => h('span', { class: `cb-stroke-sample ${lineKind().toLowerCase()}` }), [
          { title: tr('Вид'), items: (['SOLID', 'DASHED', 'DOTTED'] as const).map((k) => ({ label: () => h('span', { class: `cb-stroke-sample ${k.toLowerCase()}` }), title: k === 'SOLID' ? tr('Сплошная') : k === 'DASHED' ? tr('Пунктир') : tr('Точки'), on: () => lineKind() === k, run: () => setKind(k) })) },
        ]);
        const prev = this.sync;
        this.sync = () => {
          prev();
          for (const { r, b } of routes) b.classList.toggle('on', role<'CONNECTOR'>(first).route === r);
          const r0 = role<'CONNECTOR'>(first);
          avoidButton.hidden = r0.route !== 'ELBOW' || bent();
          avoidButton.classList.toggle('on', r0.avoid !== false);
          avoidButton.title = r0.avoid !== false ? tr('Обходит объекты. Нажмите — пройдёт сквозь них') : tr('Проходит сквозь объекты. Нажмите — будет обходить');
          straightButton.hidden = !bent();
          endsButton.replaceChildren(icon(ends() === 'both' ? 'arrowEnds' : ends() === 'end' ? 'arrowEnd' : 'lineEnd', 16));
        };
        return [
          ...routes.map((x) => x.b),
          avoidButton,
          straightButton,
          this.separator(),
          endsButton,
          dashButton,
          this.field(tr('Толщина линии'), '≡', () => d.get(first, 'strokeWeight'), (v) => e.commit(tr('Толщина линии'), (tx) => ids.forEach((id) => {
            tx.set(id, 'strokeWeight', v);
            // Dashes follow the new weight (they would close up on a thicker line).
            const kind = lineKindOf(d.get(id, 'dashPattern'));
            if (kind !== 'SOLID') tx.set(id, 'dashPattern', lineDash(kind, v, true));
          })), { min: 1, max: 40 }),
          this.separator(),
          this.dots(tr('Цвет линии'), INK_COLORS, () => strokeHex(first), (hex) => {
            e.boardPrefs.ink = hex;
            e.commit(tr('Цвет линии'), (tx) => ids.forEach((id) => tx.set(id, 'strokes', [solid(color(hex))])));
          }),
        ];
      }
      case 'MARKER':
        return [
          this.dots(tr('Цвет'), INK_COLORS, () => strokeHex(first), (hex) => {
            e.boardPrefs.ink = hex;
            e.commit(tr('Цвет'), (tx) => ids.forEach((id) => tx.set(id, 'strokes', [{ ...solid(color(hex)), opacity: d.get(id, 'strokes')[0]?.opacity ?? 1 }])));
          }),
          this.field(tr('Толщина линии'), '≡', () => d.get(first, 'strokeWeight'), (v) => e.commit(tr('Толщина линии'), (tx) => ids.forEach((id) => tx.set(id, 'strokeWeight', v))), { min: 1, max: 80 }),
        ];
      default:
        return [];
    }
  }

  /** Table cells (FEAT-170): their fill, their texts' colour, weight and place, merging, rows and columns. */
  private cellParts(ids: readonly NodeId[]): (HTMLElement | null)[] {
    const e = this.editor;
    const d = e.doc;
    const cells = () => ids.filter((id) => d.store.isAlive(id));
    const texts = () => cellTexts(d, cells());
    const paint = (color: Color, opacity: number): Paint => ({ type: 'SOLID', color, opacity, visible: true });
    const bold = () => texts().length > 0 && texts().every((t) => d.get(t, 'fontWeight') >= 600);
    const boldButton = this.button(tr('Жирный'), h('b', {}, 'B'), () => styleCellTexts(e, cells(), { fontWeight: bold() ? 400 : 700 }, tr('Жирный')));
    const alignH = this.button(tr('Выравнивание текста'), icon('textLeft', 16), () => {
      const now = texts()[0] ? d.get(texts()[0]!, 'textAlignH') : 'LEFT';
      styleCellTexts(e, cells(), { textAlignH: now === 'LEFT' ? 'CENTER' : now === 'CENTER' ? 'RIGHT' : 'LEFT' }, tr('Выравнивание текста'));
    });
    const alignV = this.button(tr('Текст сверху, посередине или снизу ячейки'), icon('alignTop', 16), () => {
      const now = cellAlignV(d, ids[0]!);
      alignCellsV(e, cells(), now === 'MIN' ? 'CENTER' : now === 'CENTER' ? 'MAX' : 'MIN');
    });
    const prev = this.sync;
    this.sync = () => {
      prev();
      boldButton.classList.toggle('on', bold());
      const hNow = texts()[0] ? d.get(texts()[0]!, 'textAlignH') : 'LEFT';
      alignH.replaceChildren(icon(hNow === 'CENTER' ? 'textCenter' : hNow === 'RIGHT' ? 'textRight' : 'textLeft', 16));
      const vNow = ids[0] && d.store.isAlive(ids[0]) ? cellAlignV(d, ids[0]) : 'MIN';
      alignV.replaceChildren(icon(vNow === 'CENTER' ? 'alignVCenter' : vNow === 'MAX' ? 'alignBottom' : 'alignTop', 16));
    };
    const { merge, split } = mergeActions(e, ids);
    const more = this.button(tr('Строки и столбцы'), h('span', { class: 'cb-more', 'aria-hidden': 'true' }, '•••'), () => {
      const r = more.getBoundingClientRect();
      const menu = tableMenuItems(e, ids)[0];
      if (menu?.kind === 'submenu') this.menu.open(r.left, r.bottom + 6, menu.items);
    });
    return [
      this.swatch(ids.length === 1 ? tr('Заливка ячейки') : tr('Заливка ячеек'), () => solidOf(d.get(ids[0]!, 'fills')), (color, opacity) => fillCellsWith(e, cells(), paint(color, opacity))),
      this.swatch(tr('Цвет текста'), () => (texts()[0] ? solidOf(d.get(texts()[0]!, 'fills')) : null), (color, opacity) => styleCellTexts(e, cells(), { fills: [paint(color, opacity)] }, tr('Цвет текста'))),
      boldButton,
      alignH,
      alignV,
      merge || split ? this.separator() : null,
      merge ? this.textButton(tr('Объединить'), merge) : null,
      split ? this.textButton(tr('Разъединить'), split) : null,
      this.separator(),
      more,
    ];
  }

  private build(kind: string, ids: readonly NodeId[]): void {
    const e = this.editor;
    const d = e.doc;
    this.sync = () => {};
    const parts: (HTMLElement | null)[] = [];
    if (kind.startsWith('board-')) {
      parts.push(...this.boardParts(kind.slice(6), ids));
      // Several objects of one kind line up as any others do (they had no way to, but by shortcuts).
      if (ids.length > 1 && kind !== 'board-LOCKED') parts.push(this.separator(), this.alignMenu());
    } else if (kind === 'many' && this.boardMode) {
      parts.push(this.alignMenu());
    } else if (kind === 'text') {
      // Font and its weight, as in the right panel (the same lists); text styles — a small button, when the file has any.
      const run = <K extends 'fontFamily' | 'fontWeight'>(key: K) => {
        const v = e.textStyleValue(key);
        return v === null ? null : v === MIXED_RUN ? MIXED : (v as never);
      };
      const font = new FontPicker(() => d, () => run('fontFamily'), (v) => e.applyTextStyle({ fontFamily: v }, tr('Шрифт')), {
        preview: (f) => e.previewFont(f),
        sample: () => {
          const t = e.topLevelSelection().find((id) => d.type(id) === 'TEXT');
          return t ? d.get(t, 'characters') : null;
        },
      });
      const weight = new WeightField(() => run('fontFamily'), () => run('fontWeight'), (v) => e.applyTextStyle({ fontWeight: v }, tr('Начертание')));
      font.el.classList.add('cb-font');
      weight.el.classList.add('cb-weight');
      const prevFont = this.sync;
      this.sync = () => {
        prevFont();
        font.refresh();
        weight.refresh();
      };
      const fills = () => {
        const v = e.textStyleValue('fills');
        return Array.isArray(v) ? solidOf(v as Paint[]) : solidOf(d.get(ids[0]!, 'fills'));
      };
      const hasStyles = d.styles().some((st) => d.get(st, 'styleType') === 'TEXT');
      const style = hasStyles ? this.button(tr('Текстовый стиль'), icon('styles', 16), () => openStylePicker(style!, e, 'textStyleId')) : null;
      parts.push(
        font.el,
        weight.el,
        this.field(
          tr('Размер шрифта'),
          icon('text', 14),
          () => {
            const v = e.textStyleValue('fontSize');
            return typeof v === 'number' ? v : d.get(ids[0]!, 'fontSize');
          },
          (v) => e.setTextSize(v),
          { min: 1, max: 1000, choices: () => this.sizeChoices(ids) },
        ),
        style,
        this.swatch(tr('Цвет текста'), fills, (color, opacity) => e.applyTextStyle({ fills: [{ type: 'SOLID', color, opacity, visible: true }] }, tr('Цвет текста'))),
        this.separator(),
        this.toggle(tr('Жирный'), h('b', {}, 'B'), 'text.bold', () => Number(e.textStyleValue('fontWeight')) >= 600),
        this.toggle(tr('Курсив'), h('i', {}, 'I'), 'text.italic', () => e.textStyleValue('italic') === true),
        this.toggle(tr('Подчёркнутый'), h('u', {}, 'U'), 'text.underline', () => e.textStyleValue('textDecoration') === 'UNDERLINE'),
        this.button(tr('Ссылка'), icon('link', 16), this.run('text.link')),
        this.separator(),
        this.toggle(tr('Маркированный список'), icon('listBullet', 16), 'text.bulleted', () => ids.every((id) => d.get(id, 'listType') === 'BULLET')),
      );
      const align = this.button(tr('Выравнивание текста'), icon('textLeft', 16), () => {
        const now = d.get(ids[0]!, 'textAlignH');
        e.setTextAlign(now === 'LEFT' ? 'CENTER' : now === 'CENTER' ? 'RIGHT' : 'LEFT');
      });
      const prevAlign = this.sync;
      this.sync = () => {
        prevAlign();
        const now = d.get(ids[0]!, 'textAlignH');
        align.replaceChildren(icon(now === 'CENTER' ? 'textCenter' : now === 'RIGHT' ? 'textRight' : now === 'JUSTIFIED' ? 'textJustify' : 'textLeft', 16));
      };
      parts.push(align);
    } else if (kind === 'cells') {
      parts.push(...this.cellParts(ids));
    } else if (kind === 'many') {
      parts.push(
        this.button(tr('По левому краю'), icon('alignLeft', 16), this.run('align.left'), 'align.left'),
        this.button(tr('По центру по горизонтали'), icon('alignHCenter', 16), this.run('align.hcenter'), 'align.hcenter'),
        this.button(tr('По правому краю'), icon('alignRight', 16), this.run('align.right'), 'align.right'),
        this.button(tr('По верху'), icon('alignTop', 16), this.run('align.top'), 'align.top'),
        this.button(tr('По центру по вертикали'), icon('alignVCenter', 16), this.run('align.vcenter'), 'align.vcenter'),
        this.button(tr('По низу'), icon('alignBottom', 16), this.run('align.bottom'), 'align.bottom'),
        this.button(tr('Распределить по горизонтали'), icon('columns', 16), this.run('align.distributeH'), 'align.distributeH'),
        this.button(tr('Распределить по вертикали'), icon('rows', 16), this.run('align.distributeV'), 'align.distributeV'),
        this.separator(),
        this.button(tr('Выстроить ровной сеткой'), icon('gapRows', 16), this.run('object.tidyUp'), 'object.tidyUp'),
        // Auto layout is a design's tool: a board has no such command (the button would do nothing).
        this.commands.has('object.autoLayout') ? this.button(tr('Добавить адаптивную раскладку'), icon('wrap', 16), this.run('object.autoLayout'), 'object.autoLayout') : null,
      );
      // Shapes only: boolean operations, as in Figma's toolbar.
      if (ids.every((id) => SHAPE_TYPES.includes(d.type(id)) && d.type(id) !== 'LINE') && this.commands.has('shape.union')) {
        parts.push(
          this.separator(),
          this.button(tr('Объединить фигуры'), icon('union', 16), this.run('shape.union'), 'shape.union'),
          this.button(tr('Вычесть верхние фигуры из нижней'), icon('subtract', 16), this.run('shape.subtract'), 'shape.subtract'),
          this.button(tr('Оставить только пересечение'), icon('intersect', 16), this.run('shape.intersect'), 'shape.intersect'),
          this.button(tr('Оставить всё, кроме пересечения'), icon('exclude', 16), this.run('shape.exclude'), 'shape.exclude'),
        );
      }
    } else if (kind === 'image' || kind === 'shape') {
      const id = ids[0]!;
      const type = d.type(id);
      const set = (props: Parameters<Editor['setProps']>[1], label: string) => e.setProps([id], props, label);
      if (kind === 'image') {
        parts.push(this.button(tr('Обрезать картинку'), icon('clip', 16), this.run('image.crop')), this.button(tr('Удалить фон'), icon('scissors', 16), this.run('image.removeBg')), this.button(tr('Стереть кистью'), icon('eraser', 16), this.run('image.erase')), this.separator());
      } else {
        parts.push(
          this.swatch(
            tr('Заливка'),
            () => solidOf(d.get(id, 'fills')),
            (color, opacity) =>
              e.commit(tr('Заливка'), (tx) => {
                const fills = d.get(id, 'fills').slice();
                const at = fills.findLastIndex((p) => p.visible && p.type === 'SOLID');
                const paint: Paint = { type: 'SOLID', color, opacity, visible: true };
                if (at >= 0) fills[at] = paint;
                else fills.push(paint);
                tx.set(id, 'fills', fills);
              }),
          ),
        );
      }
      // Stroke: its colour and weight (a colour picked on a layer without one adds it).
      parts.push(
        this.swatch(
          tr('Обводка'),
          () => solidOf(d.get(id, 'strokes')),
          (color, opacity) =>
            e.commit(tr('Обводка'), (tx) => {
              const strokes = d.get(id, 'strokes').slice();
              const at = strokes.findLastIndex((p) => p.visible && p.type === 'SOLID');
              const paint: Paint = { type: 'SOLID', color, opacity, visible: true };
              if (at >= 0) strokes[at] = paint;
              else {
                strokes.push(paint);
                if (d.get(id, 'strokeWeight') <= 0) tx.set(id, 'strokeWeight', 1);
              }
              tx.set(id, 'strokes', strokes);
            }),
          true,
        ),
        this.field(tr('Толщина обводки'), '≡', () => (d.get(id, 'strokes').some((p) => p.visible) ? d.get(id, 'strokeWeight') : null), (v) => set({ strokeWeight: v }, tr('Толщина обводки')), { min: 0, max: 500 }),
      );
      if (['FRAME', 'COMPONENT', 'INSTANCE', 'RECTANGLE', 'COMPONENT_SET'].includes(type) || kind === 'image') {
        parts.push(this.field(tr('Скругление'), icon('radius', 14), () => d.get(id, 'cornerRadius'), (v) => set({ cornerRadius: v, cornerRadii: null }, tr('Скругление')), { min: 0, max: 10_000 }));
      }
      parts.push(this.field(tr('Непрозрачность'), icon('opacity', 14), () => Math.round(d.get(id, 'opacity') * 100), (v) => set({ opacity: v / 100 }, tr('Непрозрачность')), { min: 0, max: 100, unit: '%' }));
      if (type === 'FRAME' || type === 'COMPONENT') {
        const al = () => d.get(id, 'layoutMode');
        const hasAl = () => al() === 'HORIZONTAL' || al() === 'VERTICAL';
        if (this.commands.has('object.autoLayout')) parts.push(this.separator(), this.toggle(tr('Адаптивная раскладка'), icon('wrap', 16), 'object.autoLayout', () => al() !== 'NONE'));
        const dir = this.button(tr('Направление: в строку или в столбец'), icon('arrowDown', 16), () => set({ layoutMode: al() === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL' }, tr('Направление адаптивной раскладки')));
        const prev = this.sync;
        this.sync = () => {
          prev();
          dir.hidden = !hasAl();
          dir.replaceChildren(icon(al() === 'HORIZONTAL' ? 'arrowRight' : 'arrowDown', 16));
        };
        parts.push(
          dir,
          this.field(tr('Промежуток'), icon('gap', 14), () => (hasAl() ? d.get(id, 'itemSpacing') : null), (v) => set({ itemSpacing: v }, tr('Промежуток')), { min: -10_000, max: 10_000 }),
          this.field(
            tr('Внутренние отступы (все четыре)'),
            icon('padding', 14),
            () => {
              if (!hasAl()) return null;
              const p = [d.get(id, 'paddingTop'), d.get(id, 'paddingRight'), d.get(id, 'paddingBottom'), d.get(id, 'paddingLeft')];
              return p.every((v) => v === p[0]) ? p[0]! : Math.max(...p);
            },
            (v) => set({ paddingTop: v, paddingRight: v, paddingBottom: v, paddingLeft: v }, tr('Внутренние отступы')),
            { min: 0, max: 10_000 },
          ),
        );
      }
    }
    if (this.boardMode) {
      // No right panel on a board. Several stickies: sorted into named sections (BUG-071).
      const sorts = sortOptions(this.editor);
      if (sorts.length) {
        if (parts.length) parts.push(this.separator());
        parts.push(this.textMenuButton(tr('Упорядочить'), sorts.map((o) => ({ label: o.label, run: () => sortIntoSections(this.editor, o.by) }))));
      }
      // A text of several lines: one sticky per line.
      if (ids.length === 1 && d.type(ids[0]!) === 'TEXT' && !d.get(ids[0]!, 'board') && linesOf(d.get(ids[0]!, 'characters')).length > 1) {
        if (parts.length) parts.push(this.separator());
        parts.push(this.textButton(tr('Разбить на стикеры'), () => textToStickies(this.editor)));
      }
      // Everything else for the selection: the same list as the right click.
      if (parts.length) parts.push(this.separator());
      const more = this.button(tr('Ещё: порядок, похожие, оформление, закрепить…'), h('span', { class: 'cb-more', 'aria-hidden': 'true' }, '•••'), () => {
        const r = more.getBoundingClientRect();
        this.menu.open(r.left, r.bottom + 6, boardMenuItems(this.editor, this.commands, this.host.boardExtras?.() ?? {}));
      });
      parts.push(more);
      this.el.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
      return;
    }
    if (parts.length) parts.push(this.separator());
    const smart = this.button(tr('Умные действия'), sparkles(18), () => this.host.openSmart(), 'smart.open');
    smart.classList.add('cb-smart');
    const panel = this.button('', icon('panelRight', 16), () => {
      this.host.toggleRight();
      this.sync();
    });
    const prev = this.sync;
    this.sync = () => {
      prev();
      const hidden = this.host.rightHidden();
      const label = hidden ? tr('Развернуть: все свойства справа') : tr('Свернуть правую панель');
      panel.title = label;
      panel.setAttribute('aria-label', label);
      panel.classList.toggle('on', !hidden);
    };
    parts.push(smart, panel);
    this.el.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
  }
}
