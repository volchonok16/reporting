// While the model works on layers (✦ «Придумать тексты», «Переименовать слои»), the
// canvas shows it: a shimmering frame over the layers with what is being done and
// the seconds so far — the work is in the background, the person should see it.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { h, sparkles } from './dom.ts';

export class WorkGlow {
  readonly el: HTMLElement = h('div', { class: 'work-glows', 'aria-live': 'polite' });
  private frame = 0;
  private tick = 0;

  private readonly editor: Editor;
  private readonly canvas: HTMLElement;

  constructor(editor: Editor, canvas: HTMLElement) {
    this.editor = editor;
    this.canvas = canvas;
    for (const ev of ['work', 'viewport', 'change', 'page', 'document'] as const) editor.events.on(ev, () => this.schedule());
    window.addEventListener('resize', () => this.schedule());
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private update(): void {
    const e = this.editor;
    const d = e.doc;
    const v = e.viewport;
    this.el.replaceChildren();
    clearTimeout(this.tick);
    if (!e.works.size) return;
    for (const work of e.works) {
      const ids = work.ids.filter((id) => d.store.isAlive(id) && d.pageOf(id) === e.pageId);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const id of ids) {
        const b = e.scene.bounds(id);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
      const seconds = Math.floor((Date.now() - work.started) / 1000);
      const label = h('div', { class: 'work-glow-label' }, sparkles(14), h('span', {}, work.label), h('span', { class: 'work-glow-time' }, seconds ? tr('{0} с', seconds) : ''));
      // Layers out of sight (another page, deleted): the label alone, at the top of the canvas.
      if (!ids.length || !Number.isFinite(x0)) {
        this.el.append(h('div', { class: 'work-glow floating' }, label));
        continue;
      }
      const left = this.canvas.offsetLeft + x0 * v.zoom + v.offsetX;
      const top = this.canvas.offsetTop + y0 * v.zoom + v.offsetY;
      // A top-level frame has its name above it: the label goes over the name.
      const glow = h('div', { class: `work-glow${ids.some((id) => d.parent(id) === e.pageId) ? ' over-name' : ''}` }, label);
      glow.style.left = `${left - 4}px`;
      glow.style.top = `${top - 4}px`;
      glow.style.width = `${(x1 - x0) * v.zoom + 8}px`;
      glow.style.height = `${(y1 - y0) * v.zoom + 8}px`;
      this.el.append(glow);
    }
    // The seconds go on.
    this.tick = window.setTimeout(() => this.schedule(), 1000);
  }
}
