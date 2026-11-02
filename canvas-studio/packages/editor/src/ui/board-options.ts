// What a board tool makes next (FEAT-083): a small strip next to the tool
// panel while the tool is on — the colour and width of the marker, the size
// of the eraser, the colour of the next sticky or shape, the kind of line.
// Changing an object that is already there is the bar over the selection.

import { tr } from '#core';
import { ERASER_SIZES, HIGHLIGHT_COLORS, HIGHLIGHTER_SIZES, INK_COLORS, MARKER_SIZES, PENCIL_SIZES, SHAPE_COLORS, STICKY_COLORS } from '../board.ts';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';
import { tearOff, type PadHost } from './sticky-pad.ts';

export class BoardOptions {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly dock: HTMLElement;
  private shownFor = '';
  /** Set by the app: the colours become pads of stickies. */
  pad: PadHost | null = null;
  /** The next sticky's colour changed (the pad button shows it). */
  onStickyColor: () => void = () => {};

  constructor(editor: Editor, dock: HTMLElement) {
    this.editor = editor;
    this.dock = dock;
    this.el = h('div', { class: 'board-options', role: 'toolbar', 'aria-label': tr('Настройки инструмента'), hidden: true });
    editor.events.on('tool', () => this.update());
    window.addEventListener('resize', () => this.place());
    this.update();
  }

  private update(): void {
    const tool = this.editor.tool;
    if (tool === this.shownFor && !this.el.hidden) return this.place();
    this.shownFor = tool;
    const parts = this.partsFor(tool);
    this.el.replaceChildren(...parts);
    this.el.hidden = parts.length === 0 || this.editor.doc.readOnly;
    this.place();
  }

  /** Over the tool panel (beside it when the panel is on the left). */
  private place(): void {
    if (this.el.hidden) return;
    const area = this.el.parentElement;
    if (!area) return;
    const a = area.getBoundingClientRect();
    const d = this.dock.getBoundingClientRect();
    const place = this.dock.dataset.place ?? 'bottom';
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    if (place === 'left') {
      this.el.style.left = `${d.right - a.left + 8}px`;
      this.el.style.top = `${Math.max(8, d.top - a.top + d.height / 2 - hgt / 2)}px`;
    } else {
      this.el.style.left = `${Math.max(8, Math.min(a.width - w - 8, d.left - a.left + d.width / 2 - w / 2))}px`;
      this.el.style.top = `${place === 'top' ? d.bottom - a.top + 8 : d.top - a.top - hgt - 8}px`;
    }
  }

  private partsFor(tool: string): HTMLElement[] {
    const p = this.editor.boardPrefs;
    const refresh = () => {
      this.shownFor = '';
      this.update();
    };
    const dots = (label: string, colors: readonly string[], current: string, set: (hex: string) => void) =>
      h(
        'span',
        { class: 'bo-group', role: 'group', 'aria-label': label },
        ...colors.map((hex) => {
          const name = STICKY_COLORS.find((c) => c.hex === hex)?.name ?? hex;
          const b = h('button', { class: `bo-dot${hex === current ? ' on' : ''}`, type: 'button', title: `${label}: ${name}`, 'aria-label': `${label}: ${name}`, 'aria-pressed': String(hex === current) }, h('span', { style: { background: hex } }));
          b.addEventListener('click', () => {
            set(hex);
            refresh();
          });
          return b;
        }),
      );
    const sizes = (label: string, values: readonly number[], current: number, set: (v: number) => void, scale: (v: number) => number, ring = false, ink = p.ink) =>
      h(
        'span',
        { class: 'bo-group', role: 'group', 'aria-label': label },
        ...values.map((v) => {
          const size = Math.max(3, Math.min(22, scale(v)));
          const b = h('button', { class: `bo-size${v === current ? ' on' : ''}`, type: 'button', title: `${label}: ${v} px`, 'aria-label': `${label}: ${v} px`, 'aria-pressed': String(v === current) }, h('span', { class: ring ? 'ring' : '', style: { width: `${size}px`, height: `${size}px`, background: ring ? 'transparent' : ink } }));
          b.addEventListener('click', () => {
            set(v);
            refresh();
          });
          return b;
        }),
      );
    const sep = () => h('span', { class: 'bo-sep', 'aria-hidden': 'true' });
    switch (tool) {
      case 'marker':
        return [dots(tr('Цвет'), INK_COLORS, p.ink, (c) => (p.ink = c)), sep(), sizes(tr('Толщина'), MARKER_SIZES, p.markerSize, (v) => (p.markerSize = v), (v) => v + 2)];
      case 'pencil': {
        // Auto: black, white on a dark frame (as in Figma); or a colour of one's own.
        const auto = h('button', { class: `bo-dot${p.pencilInk === '' ? ' on' : ''}`, type: 'button', title: tr('Цвет: авто — чёрный, на тёмном белый'), 'aria-label': tr('Цвет: авто'), 'aria-pressed': String(p.pencilInk === '') }, h('span', { class: 'auto' }));
        auto.addEventListener('click', () => {
          p.pencilInk = '';
          refresh();
        });
        const own = p.pencilInk !== '' && !INK_COLORS.includes(p.pencilInk);
        const input = h('input', { type: 'color', value: own ? p.pencilInk : '#4F5BD5', 'aria-label': tr('Свой цвет') }) as HTMLInputElement;
        input.addEventListener('change', () => {
          p.pencilInk = input.value.toUpperCase();
          refresh();
        });
        const custom = h('label', { class: `bo-dot bo-custom${own ? ' on' : ''}`, title: tr('Свой цвет') }, h('span', own ? { style: { background: p.pencilInk } } : { class: 'rainbow' }), input);
        const colors = dots(tr('Цвет'), INK_COLORS, p.pencilInk, (c) => (p.pencilInk = c));
        colors.prepend(auto);
        colors.append(custom);
        const ink = p.pencilInk || 'var(--text)';
        return [colors, sep(), sizes(tr('Толщина'), PENCIL_SIZES, p.pencilSize, (v) => (p.pencilSize = v), (v) => 2 + v * 1.4, false, ink)];
      }
      case 'highlighter':
        return [dots(tr('Цвет'), HIGHLIGHT_COLORS, p.highlightInk, (c) => (p.highlightInk = c)), sep(), sizes(tr('Толщина'), HIGHLIGHTER_SIZES, p.highlighterSize, (v) => (p.highlighterSize = v), (v) => v / 1.6, false, p.highlightInk)];
      case 'eraser':
        return [h('span', { class: 'bo-label' }, tr('Размер ластика')), sizes(tr('Размер ластика'), ERASER_SIZES, p.eraserSize, (v) => (p.eraserSize = v), (v) => v * 0.75, true)];
      case 'sticky': {
        const group = dots(tr('Цвет стикера'), STICKY_COLORS.map((c) => c.hex), p.stickyColor, (c) => {
          p.stickyColor = c;
          this.onStickyColor();
        });
        // Each colour is a pad too: drag a sticky of that colour off it.
        if (this.pad) [...group.children].forEach((b, i) => tearOff(b as HTMLElement, this.pad!, () => STICKY_COLORS[i]!.hex));
        return [group];
      }
      case 'shape':
        return [dots(tr('Цвет фигуры'), SHAPE_COLORS, p.shapeColor, (c) => (p.shapeColor = c))];
      case 'connector': {
        const route = (r: 'STRAIGHT' | 'ELBOW' | 'CURVE', label: string, glyph: string) => {
          const b = h('button', { class: `bo-icon${p.route === r ? ' on' : ''}`, type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(p.route === r) }, icon(glyph, 16));
          b.addEventListener('click', () => {
            p.route = r;
            refresh();
          });
          return b;
        };
        return [
          h('span', { class: 'bo-group' }, route('STRAIGHT', tr('Прямая'), 'routeStraight'), route('ELBOW', tr('Под прямым углом'), 'routeElbow'), route('CURVE', tr('Плавная'), 'routeCurve')),
          sep(),
          dots(tr('Цвет линии'), INK_COLORS, p.ink, (c) => (p.ink = c)),
        ];
      }
      default:
        return [];
    }
  }
}
