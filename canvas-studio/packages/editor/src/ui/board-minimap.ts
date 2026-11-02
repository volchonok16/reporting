// A board's mini-map (п.3 «рабочие мелочи»): the whole board small in the
// corner, the visible part framed. A click or a drag moves the view there.
// Folded to a button by default; open or folded is remembered in this browser.

import { tr, type NodeId, type Paint } from '#core';
import { roleOf } from '#components';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

const KEY = 'cs-board-minimap';
const W = 200;
const H = 140;
const PAD = 8;

const css = (paints: readonly Paint[], fallback: string): string => {
  const p = paints.find((f) => f.visible && f.type === 'SOLID');
  if (!p || p.type !== 'SOLID') return fallback;
  const c = p.color;
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a * p.opacity})`;
};

export class BoardMinimap {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly canvas: HTMLCanvasElement;
  private readonly toggleButton: HTMLButtonElement;
  private open = false;
  private frame = 0;
  /** World → map: the scale and the world point at the map's top left. */
  private map = { scale: 1, x: 0, y: 0 };

  constructor(editor: Editor) {
    this.editor = editor;
    this.canvas = h('canvas', { class: 'minimap-canvas', width: W, height: H, 'aria-label': tr('Мини-карта доски: щёлкните, чтобы перейти') });
    this.toggleButton = h('button', { class: 'minimap-toggle', type: 'button' });
    this.toggleButton.addEventListener('click', () => this.setOpen(!this.open));
    this.el = h('div', { class: 'board-minimap' }, this.canvas, this.toggleButton);
    let dragging = false;
    const go = (ev: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      this.centerOn({ x: this.map.x + (ev.clientX - r.left) / this.map.scale, y: this.map.y + (ev.clientY - r.top) / this.map.scale });
    };
    this.canvas.addEventListener('pointerdown', (ev) => {
      dragging = true;
      this.canvas.setPointerCapture(ev.pointerId);
      go(ev);
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (dragging) go(ev);
    });
    this.canvas.addEventListener('pointerup', () => (dragging = false));
    for (const ev of ['change', 'viewport', 'document', 'page'] as const) editor.events.on(ev, () => this.schedule());
    window.addEventListener('resize', () => this.schedule());
    let saved = false;
    try {
      saved = localStorage.getItem(KEY) === 'open';
    } catch {
      // folded
    }
    this.setOpen(saved, false);
  }

  setOpen(open: boolean, remember = true): void {
    this.open = open;
    this.el.classList.toggle('open', open);
    this.canvas.hidden = !open;
    const label = open ? tr('Скрыть мини-карту') : tr('Мини-карта доски');
    this.toggleButton.title = label;
    this.toggleButton.setAttribute('aria-label', label);
    this.toggleButton.replaceChildren(icon(open ? 'close' : 'board', 14));
    if (remember) {
      try {
        localStorage.setItem(KEY, open ? 'open' : 'folded');
      } catch {
        // not remembered
      }
    }
    this.schedule();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private schedule(): void {
    if (!this.open || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private centerOn(p: { x: number; y: number }): void {
    const e = this.editor;
    const v = e.viewport;
    v.restore({ zoom: v.zoom, offsetX: e.screenSize.width / 2 - p.x * v.zoom, offsetY: e.screenSize.height / 2 - p.y * v.zoom });
    e.requestViewport();
  }

  /** What the map shows: sections and the objects on the page and in sections (their own parts are not needed). */
  private objects(): NodeId[] {
    const d = this.editor.doc;
    const out: NodeId[] = [];
    const walk = (parent: NodeId) => {
      for (const id of d.children(parent)) {
        if (!d.get(id, 'visible')) continue;
        out.push(id);
        if (d.type(id) === 'SECTION') walk(id);
      }
    };
    walk(this.editor.pageId);
    return out;
  }

  private draw(): void {
    const e = this.editor;
    const d = e.doc;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== W * dpr) {
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ids = this.objects();
    const view = e.viewport.visibleRect(e.screenSize.width, e.screenSize.height);
    // The map holds the whole board and the view, whichever is bigger.
    let x0 = view.x;
    let y0 = view.y;
    let x1 = view.x + view.width;
    let y1 = view.y + view.height;
    const boxes = new Map(ids.map((id) => [id, e.scene.bounds(id)]));
    for (const b of boxes.values()) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    const scale = Math.min((W - PAD * 2) / Math.max(1, x1 - x0), (H - PAD * 2) / Math.max(1, y1 - y0));
    const ox = (W - (x1 - x0) * scale) / 2;
    const oy = (H - (y1 - y0) * scale) / 2;
    this.map = { scale, x: x0 - ox / scale, y: y0 - oy / scale };
    const rect = (b: { x: number; y: number; width: number; height: number }) => [(b.x - this.map.x) * scale, (b.y - this.map.y) * scale, Math.max(1, b.width * scale), Math.max(1, b.height * scale)] as const;
    const ink = getComputedStyle(this.el).getPropertyValue('--minimap-ink').trim() || 'rgba(0, 0, 0, 0.35)';
    for (const id of ids) {
      const b = boxes.get(id)!;
      const kind = roleOf(d, id)?.kind;
      const type = d.type(id);
      if (type === 'SECTION') {
        ctx.fillStyle = css(d.get(id, 'fills'), 'rgba(0, 0, 0, 0.06)');
        ctx.fillRect(...rect(b));
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(...rect(b));
      } else if (kind === 'STICKY') {
        ctx.fillStyle = css(d.get(id, 'fills'), '#FFE27A');
        ctx.fillRect(...rect(b));
      } else if (kind === 'SHAPE') {
        const outline = d.children(id).find((c) => roleOf(d, c)?.kind === 'SHAPE_OUTLINE');
        ctx.fillStyle = outline ? css(d.get(outline, 'fills'), ink) : ink;
        ctx.fillRect(...rect(b));
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(...rect(b));
      } else if (kind === 'CONNECTOR' || kind === 'CONNECTOR_LABEL' || kind === 'VOTE') {
        continue;
      } else {
        ctx.fillStyle = ink;
        ctx.fillRect(...rect(b));
      }
    }
    // The visible part.
    ctx.strokeStyle = '#4F5BD5';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(79, 91, 213, 0.08)';
    ctx.fillRect(...rect(view));
    ctx.strokeRect(...rect(view));
  }
}
