// The show of a presentation (FEAT-157): slides one at a time on the whole
// screen, each coming in with its transition; arrows, space and a click go on,
// Esc ends. «Окно докладчика» opens a second window with the current and the
// next slide, the notes, a timer and the clock — it is drawn from here, so the
// two never disagree. The show plays a private copy of the file.

import { deserialize, serialize, tr, type Document, type NodeId, type SlideTransition } from '#core';
import { invert } from '#geometry';
import type { TextMeasurer } from '#layout';
import { Canvas2DRenderer, SceneGraph } from '#render';
import { fileAnchor, openSlideFile } from '../slide-files.ts';
import { slideIds, slideInfo } from '../slides.ts';
import { h, icon } from './dom.ts';

export interface SlideShowOptions {
  doc: Document;
  pageId: NodeId;
  /** The slide to start from; null — the first. */
  start: NodeId | null;
  measurer: TextMeasurer;
  /** The show ended on this slide. */
  onClose: (last: NodeId | null) => void;
}

interface Box {
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
}

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export class SlideShow {
  readonly el: HTMLElement;
  private readonly doc: Document;
  private readonly scene: SceneGraph;
  private readonly renderer: Canvas2DRenderer;
  private readonly slides: NodeId[];
  private readonly canvas: HTMLCanvasElement;
  private readonly counter: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly filesHost: HTMLElement;
  private readonly onClose: (last: NodeId | null) => void;
  private index = 0;
  private anim: { from: number; to: number; start: number; transition: SlideTransition; back: boolean } | null = null;
  private black = false;
  private typed = '';
  private frame = 0;
  private hideTimer = 0;
  private readonly started = Date.now();
  private presenter: { win: Window; current: HTMLCanvasElement; next: HTMLCanvasElement; notes: HTMLElement; counter: HTMLElement; timer: HTMLElement; clock: HTMLElement; start: number } | null = null;
  private presenterTick = 0;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly onResize = () => this.request();

  constructor(options: SlideShowOptions) {
    // A private copy: the show never touches the file.
    this.doc = deserialize(serialize(options.doc));
    this.scene = new SceneGraph(this.doc, options.pageId);
    this.renderer = new Canvas2DRenderer(options.measurer);
    this.renderer.images.onLoad = () => this.request();
    this.onClose = options.onClose;
    this.slides = slideIds(this.doc, options.pageId).filter((id) => !slideInfo(this.doc, id).skip || id === options.start);
    this.index = Math.max(0, options.start ? this.slides.indexOf(options.start) : 0);

    this.canvas = h('canvas', { class: 'show-canvas', 'aria-label': tr('Слайд') });
    this.counter = h('span', { class: 'show-counter' });
    const button = (name: string, label: string, run: () => void) => h('button', { class: 'show-button', type: 'button', title: label, 'aria-label': label, onclick: (e: MouseEvent) => (e.stopPropagation(), run()) }, icon(name, 18));
    this.bar = h(
      'div',
      { class: 'show-bar' },
      button('chevronLeft', tr('Назад (←)'), () => this.go(this.index - 1)),
      this.counter,
      button('chevronRight', tr('Дальше (→, пробел)'), () => this.go(this.index + 1)),
      h('span', { class: 'show-sep' }),
      h('button', { class: 'show-text-button', type: 'button', onclick: (e: MouseEvent) => (e.stopPropagation(), this.openPresenter()) }, icon('note', 16), h('span', {}, tr('Окно докладчика'))),
      button('close', tr('Завершить (Esc)'), () => this.close()),
    );
    this.filesHost = h('div', { class: 'show-files' });
    this.el = h('div', { class: 'slide-show', role: 'dialog', 'aria-label': tr('Показ презентации'), tabindex: -1 }, this.canvas, this.filesHost, this.bar);
    this.el.addEventListener('click', () => this.go(this.index + 1));
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.go(this.index - 1);
    });
    this.el.addEventListener('pointermove', () => this.showBar());
    document.body.append(this.el);
    this.el.focus();
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('fullscreenchange', this.onResize);
    void this.el.requestFullscreen?.().catch(() => undefined);
    this.showBar();
    this.paintFiles();
    this.request();
  }

  private paintFiles(): void {
    const id = this.black ? null : this.slides[this.index];
    const files = id ? (slideInfo(this.doc, id).files ?? []) : [];
    const height = id ? this.doc.get(id, 'height') : 0;
    this.filesHost.replaceChildren(
      ...files.map((file, index) => {
        const button = h('button', { class: 'show-file', type: 'button', title: tr('Открыть «{0}»', file.name) }, file.name);
        const place = file.x != null && file.y != null ? { x: file.x, y: file.y } : fileAnchor(index, height);
        button.dataset.x = String(place.x);
        button.dataset.y = String(place.y);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!openSlideFile(this.doc, file, 'open')) return;
        });
        return button;
      }),
    );
    this.placeFiles();
  }

  /** Puts each file icon where it was dragged on the slide. */
  private placeFiles(): void {
    const id = this.black ? null : this.slides[this.index];
    if (!id) return;
    const box = this.fit(id, this.canvas.clientWidth, this.canvas.clientHeight);
    for (const button of this.filesHost.children) {
      if (!(button instanceof HTMLElement)) continue;
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      button.style.left = `${box.x + x * box.scale}px`;
      button.style.top = `${box.y + y * box.scale}px`;
    }
  }

  // ---------- moving ----------

  go(to: number): void {
    if (this.slides.length === 0) return;
    if (to >= this.slides.length) {
      // After the last slide — the end, as in other presentation apps: one more step closes.
      if (this.index === this.slides.length - 1 && !this.anim) this.close();
      return;
    }
    if (to < 0 || to === this.index) return;
    const back = to < this.index;
    // Forward: the slide coming in brings its transition; back: the one leaving takes it back.
    const transition = slideInfo(this.doc, this.slides[back ? this.index : to]!).transition ?? { type: 'NONE', duration: 0 };
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.anim = transition.type === 'NONE' || reduce || Math.abs(to - this.index) > 1 ? null : { from: this.index, to, start: performance.now(), transition, back };
    this.index = to;
    this.black = false;
    this.paintFiles();
    this.request();
    this.drawPresenter();
  }

  private key(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'Escape') this.close();
    else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || (k === 'Enter' && !this.typed)) this.go(this.index + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') this.go(this.index - 1);
    else if (k === 'Home') this.go(0);
    else if (k === 'End') this.go(this.slides.length - 1);
    else if (/^[0-9]$/.test(k)) this.typed += k;
    else if (k === 'Enter' && this.typed) {
      // «12 Enter» — to slide 12.
      this.go(Math.min(this.slides.length, Math.max(1, Number(this.typed))) - 1);
      this.typed = '';
    } else if (k === 'b' || k === 'B' || k === 'и' || k === 'И' || k === '.') {
      this.black = !this.black;
      this.paintFiles();
      this.request();
    } else if (k === 'p' || k === 'P' || k === 'з' || k === 'З') this.openPresenter();
    else return;
    if (!/^[0-9]$/.test(k) && k !== 'Enter') this.typed = '';
    e.preventDefault();
    e.stopPropagation();
  }

  private showBar(): void {
    this.bar.classList.add('on');
    this.el.classList.remove('no-cursor');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.bar.classList.remove('on');
      this.el.classList.add('no-cursor');
    }, 2000);
  }

  close(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.hideTimer);
    clearInterval(this.presenterTick);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('fullscreenchange', this.onResize);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    this.presenter?.win.close();
    this.el.remove();
    this.onClose(this.slides[this.index] ?? null);
  }

  // ---------- drawing ----------

  private request(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Where a slide stands in a canvas of w × h CSS pixels: fitted, centred. */
  private fit(id: NodeId, w: number, hgt: number, pad = 0): Box {
    const sw = this.doc.get(id, 'width');
    const sh = this.doc.get(id, 'height');
    const scale = Math.min((w - pad * 2) / sw, (hgt - pad * 2) / sh);
    return { x: (w - sw * scale) / 2, y: (hgt - sh * scale) / 2, scale, width: sw * scale, height: sh * scale };
  }

  private draw(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.counter.textContent = `${this.index + 1} / ${this.slides.length}`;
    const id = this.slides[this.index];
    if (!id || this.black) return;
    const anim = this.anim;
    if (anim) {
      const raw = Math.min(1, (performance.now() - anim.start) / Math.max(1, anim.transition.duration));
      const p = ease(raw);
      const from = this.slides[anim.from]!;
      const box = this.fit(id, w, hgt);
      const W = w;
      const H = hgt;
      const dir = anim.back ? -1 : 1;
      switch (anim.transition.type) {
        case 'DISSOLVE':
          this.drawSlide(ctx, from, this.fit(from, w, hgt), dpr, 0, 0, 1);
          this.drawSlide(ctx, id, box, dpr, 0, 0, p);
          break;
        case 'MOVE_IN':
          this.drawSlide(ctx, from, this.fit(from, w, hgt), dpr, 0, 0, 1);
          this.drawSlide(ctx, id, box, dpr, dir * (1 - p) * W, 0, 1);
          break;
        case 'PUSH':
          this.drawSlide(ctx, from, this.fit(from, w, hgt), dpr, -dir * p * W, 0, 1);
          this.drawSlide(ctx, id, box, dpr, dir * (1 - p) * W, 0, 1);
          break;
        case 'SLIDE_UP':
          this.drawSlide(ctx, from, this.fit(from, w, hgt), dpr, 0, 0, 1);
          this.drawSlide(ctx, id, box, dpr, 0, dir * (1 - p) * H, 1);
          break;
        default:
          this.drawSlide(ctx, id, box, dpr, 0, 0, 1);
      }
      if (raw < 1) this.request();
      else this.anim = null;
      this.placeFiles();
      return;
    }
    this.drawSlide(ctx, id, this.fit(id, w, hgt), dpr, 0, 0, 1);
    this.placeFiles();
  }

  /** A slide at its box, shifted by (dx, dy), clipped to its own rectangle. */
  private drawSlide(ctx: CanvasRenderingContext2D, id: NodeId, box: Box, dpr: number, dx: number, dy: number, alpha: number): void {
    const inv = invert(this.scene.world(id));
    if (!inv) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(box.x + dx, box.y + dy, box.width, box.height);
    ctx.clip();
    ctx.setTransform(dpr * box.scale, 0, 0, dpr * box.scale, dpr * (box.x + dx), dpr * (box.y + dy));
    ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
    this.renderer.renderNode(ctx, this.scene, id, this.scene.renderBounds(id), box.scale * dpr);
    ctx.restore();
  }

  /** A slide drawn into a canvas of the presenter's window. */
  private paintInto(canvas: HTMLCanvasElement, id: NodeId | undefined): void {
    const win = canvas.ownerDocument.defaultView ?? window;
    const dpr = win.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hgt * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!id) return;
    this.drawSlide(ctx, id, this.fit(id, w, hgt), dpr, 0, 0, 1);
  }

  // ---------- the presenter's window ----------

  private openPresenter(): void {
    if (this.presenter && !this.presenter.win.closed) {
      this.presenter.win.focus();
      return;
    }
    const win = window.open('', 'cs-presenter', 'width=1200,height=760');
    if (!win) {
      this.toast(tr('Браузер не дал открыть окно докладчика: разрешите всплывающие окна для этого сайта.'));
      return;
    }
    const d = win.document;
    d.title = tr('Окно докладчика');
    d.body.replaceChildren();
    const style = d.createElement('style');
    style.textContent = PRESENTER_CSS;
    d.head.append(style);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') => {
      const x = d.createElement(tag);
      x.className = cls;
      if (text) x.textContent = text;
      return x;
    };
    const current = el('canvas', 'p-current');
    const next = el('canvas', 'p-next');
    const notes = el('div', 'p-notes');
    const counter = el('span', 'p-counter');
    const timer = el('span', 'p-timer');
    const clock = el('span', 'p-clock');
    const btn = (text: string, run: () => void) => {
      const b = el('button', 'p-button', text);
      b.addEventListener('click', run);
      return b;
    };
    let size = 22;
    const head = el('div', 'p-head');
    head.append(counter, timer, btn(tr('Сбросить'), () => this.presenter && (this.presenter.start = Date.now())), clock);
    const nav = el('div', 'p-nav');
    nav.append(btn('‹ ' + tr('Назад'), () => this.go(this.index - 1)), btn(tr('Дальше') + ' ›', () => this.go(this.index + 1)), btn('A−', () => ((size = Math.max(14, size - 2)), (notes.style.fontSize = `${size}px`))), btn('A+', () => ((size = Math.min(48, size + 2)), (notes.style.fontSize = `${size}px`))), btn(tr('Завершить показ'), () => this.close()));
    const left = el('div', 'p-left');
    left.append(current, nav);
    const nextLabel = el('div', 'p-label', tr('Следующий'));
    const notesLabel = el('div', 'p-label', tr('Заметки'));
    const right = el('div', 'p-right');
    right.append(nextLabel, next, notesLabel, notes);
    const main = el('div', 'p-main');
    main.append(left, right);
    d.body.append(head, main);
    d.addEventListener('keydown', (e) => this.key(e));
    win.addEventListener('resize', () => this.drawPresenter());
    this.presenter = { win, current, next, notes, counter, timer, clock, start: Date.now() };
    clearInterval(this.presenterTick);
    this.presenterTick = window.setInterval(() => this.tickPresenter(), 1000);
    this.drawPresenter();
    this.tickPresenter();
  }

  private drawPresenter(): void {
    const p = this.presenter;
    if (!p || p.win.closed) return;
    const id = this.slides[this.index];
    this.paintInto(p.current, id);
    this.paintInto(p.next, this.slides[this.index + 1]);
    const notes = id ? slideInfo(this.doc, id).notes.trim() : '';
    p.notes.textContent = notes || tr('Заметок к этому слайду нет. Их пишут в редакторе: справа, в разделе «Слайд».');
    p.notes.classList.toggle('empty', !notes);
    p.counter.textContent = tr('Слайд {0} из {1}', this.index + 1, this.slides.length);
  }

  private tickPresenter(): void {
    const p = this.presenter;
    if (!p || p.win.closed) return;
    const s = Math.floor((Date.now() - p.start) / 1000);
    const two = (n: number) => String(n).padStart(2, '0');
    p.timer.textContent = `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    p.clock.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private toast(text: string): void {
    const t = h('div', { class: 'show-toast' }, text);
    this.el.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  /** How long the show has run (for tests and the presenter). */
  elapsed(): number {
    return Date.now() - this.started;
  }
}

const PRESENTER_CSS = `
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #111214; color: #f2f2f4; font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.p-head { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid #2a2c31; }
.p-counter { font-weight: 600; }
.p-timer { margin-left: auto; font-size: 28px; font-variant-numeric: tabular-nums; font-weight: 600; }
.p-clock { color: #9a9ea8; font-variant-numeric: tabular-nums; }
.p-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; padding: 20px; }
.p-left, .p-right { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.p-current { flex: 1; min-height: 0; width: 100%; }
.p-next { width: 100%; aspect-ratio: 16 / 9; }
.p-label { color: #9a9ea8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.p-notes { flex: 1; min-height: 0; overflow-y: auto; font-size: 22px; line-height: 1.5; white-space: pre-wrap; }
.p-notes.empty { color: #6f7380; font-size: 16px !important; }
.p-nav { display: flex; gap: 8px; flex-wrap: wrap; }
.p-button { padding: 8px 14px; border: 1px solid #3a3d44; border-radius: 8px; background: #1d1f23; color: inherit; font: inherit; cursor: pointer; }
.p-button:hover { background: #2a2d33; }
`;
