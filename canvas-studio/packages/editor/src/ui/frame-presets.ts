// Ready sizes for the Frame tool (as Figma's list in its right panel): while
// the tool is on, a strip next to the tool panel offers phones, tablets,
// desktops, social posts, paper and slides. A click puts a frame of that size
// in the middle of the view; dragging a frame by hand works as before.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

interface Preset {
  name: string;
  width: number;
  height: number;
}

const GROUPS = (): { label: string; icon: string; presets: Preset[] }[] => [
  {
    label: tr('Телефон'),
    icon: 'phone',
    presets: [
      { name: 'iPhone 16', width: 393, height: 852 },
      { name: 'iPhone 16 Pro Max', width: 440, height: 956 },
      { name: 'iPhone SE', width: 375, height: 667 },
      { name: 'Android', width: 412, height: 917 },
    ],
  },
  {
    label: tr('Планшет'),
    icon: 'tablet',
    presets: [
      { name: 'iPad mini', width: 744, height: 1133 },
      { name: 'iPad Pro 11"', width: 834, height: 1194 },
      { name: 'iPad Pro 13"', width: 1032, height: 1376 },
    ],
  },
  {
    label: tr('Компьютер'),
    icon: 'desktop',
    presets: [
      { name: 'MacBook Air', width: 1280, height: 832 },
      { name: tr('Монитор'), width: 1440, height: 1024 },
      { name: 'Full HD', width: 1920, height: 1080 },
    ],
  },
  {
    label: tr('Соцсети'),
    icon: 'image',
    presets: [
      { name: tr('Пост 1:1'), width: 1080, height: 1080 },
      { name: tr('Пост 4:5'), width: 1080, height: 1350 },
      { name: tr('Сторис'), width: 1080, height: 1920 },
    ],
  },
  {
    label: tr('Бумага и слайды'),
    icon: 'page',
    presets: [
      { name: 'A4', width: 595, height: 842 },
      { name: tr('Слайд 16:9'), width: 1920, height: 1080 },
      { name: tr('Слайд 4:3'), width: 1024, height: 768 },
    ],
  },
];

export class FramePresets {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly dock: HTMLElement;
  private open: string | null = null;

  constructor(editor: Editor, dock: HTMLElement) {
    this.editor = editor;
    this.dock = dock;
    this.el = h('div', { class: 'frame-presets', role: 'toolbar', 'aria-label': tr('Размеры фрейма'), hidden: true });
    editor.events.on('tool', () => {
      this.open = null;
      this.update();
    });
    window.addEventListener('resize', () => this.place());
    this.update();
  }

  private update(): void {
    const on = this.editor.tool === 'frame' && !this.editor.doc.readOnly;
    this.el.hidden = !on;
    if (!on) return;
    const groups = GROUPS();
    const row = h('div', { class: 'fp-groups' }, h('span', { class: 'fp-hint' }, tr('Тяните рамку или выберите размер:')));
    // Closing the sizes puts the Frame tool away, as choosing another tool would.
    const close = h('button', { class: 'icon-button fp-close', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.editor.setTool('select') }, icon('close'));
    for (const g of groups) {
      const b = h('button', { class: `fp-group${this.open === g.label ? ' on' : ''}`, type: 'button', 'aria-expanded': String(this.open === g.label) }, icon(g.icon, 14), h('span', {}, g.label));
      b.addEventListener('click', () => {
        this.open = this.open === g.label ? null : g.label;
        this.update();
      });
      row.append(b);
    }
    row.append(close);
    const parts: HTMLElement[] = [row];
    const opened = groups.find((g) => g.label === this.open);
    if (opened) {
      parts.push(
        h(
          'div',
          { class: 'fp-list' },
          ...opened.presets.map((p) => {
            const b = h('button', { class: 'fp-preset', type: 'button' }, h('span', {}, p.name), h('small', {}, `${p.width} × ${p.height}`));
            b.addEventListener('click', () => this.put(p));
            return b;
          }),
        ),
      );
    }
    this.el.replaceChildren(...parts);
    this.place();
  }

  /** A frame of the size in the middle of the view, selected, and the view fitted to it. */
  private put(p: Preset): void {
    const e = this.editor;
    const { width, height } = e.screenSize;
    const c = e.viewport.screenToWorld({ x: width / 2, y: height / 2 });
    const id = e.commit(tr('Фрейм'), (tx) => tx.create('FRAME', e.pageId, { name: p.name, x: Math.round(c.x - p.width / 2), y: Math.round(c.y - p.height / 2), width: p.width, height: p.height }), () => []);
    e.setTool('select');
    e.setSelection([id]);
    e.zoomToSelection();
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
      this.el.style.top = `${where === 'top' ? d.bottom - a.top + 8 : d.top - a.top - hh - 8}px`;
    }
  }
}
