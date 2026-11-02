// "Erase with a brush" window, over the whole screen: the picture over a checkerboard
// (or white, or black — to see the edge as it will look), zoomed with ⌘ + wheel or a
// pinch, moved with the wheel or Space + drag. Brushes — dry, torn, splatter, soft, hard —
// erase or bring back with their size, hardness and opacity; "Hide all" and painting
// the picture back in with a textured brush is how a painted edge is made. Shift + click
// draws a straight stroke from the last one. Applying stores the erased picture and
// remembers the one before erasing (`eraseSource`), so the window can bring parts back later.

import { base64ToBytes, tr, type ImagePaint, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { Stroke, type EraseBrush, type EraseMode, type EraseState } from '../image-erase.ts';
import { IS_MAC } from '../keyboard.ts';
import { h, icon } from './dom.ts';

const UNDO_STEPS = 20;

type Backdrop = 'checker' | 'white' | 'black';
type Point = { x: number; y: number };

const BRUSHES: [EraseBrush, string, string][] = [
  ['dry', tr('Сухая'), tr('Полосы ворса вдоль мазка, рвётся там, где кисть «высыхает» — как мазок краской (1)')],
  ['torn', tr('Рваная'), tr('Неровный, рваный край с крошками (2)')],
  ['splatter', tr('Брызги'), tr('Капли вокруг мазка (3)')],
  ['soft', tr('Мягкая'), tr('Круглая с мягким краем; край — «Жёсткость» (4)')],
  ['hard', tr('Жёсткая'), tr('Круглая с чётким краем (5)')],
];

/** Brush size on a curve (0..100 → 2..800 px): fine control for small brushes, still reaching big ones. */
const toSize = (v: number) => Math.round(2 * Math.pow(400, v / 100));
const fromSize = (s: number) => Math.round((100 * Math.log(Math.max(2, s) / 2)) / Math.log(400));

export class EraseDialog {
  private readonly overlay: HTMLElement;
  private readonly editor: Editor;
  private readonly id: NodeId;
  private readonly index: number;
  private readonly paint: ImagePaint;
  private readonly sourceHash: string;
  private readonly stage: HTMLElement;
  private readonly view: HTMLCanvasElement;
  private readonly ring: HTMLElement;
  private readonly zoomLabel: HTMLButtonElement;
  private readonly apply: HTMLButtonElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly sizeValue: HTMLElement;
  private readonly hardnessLine: HTMLElement;
  private readonly chooseMode: (v: EraseMode) => void;
  private readonly chooseBrush: (v: EraseBrush) => void;
  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly resize: ResizeObserver;
  private brush: EraseBrush = 'dry';
  private mode: EraseMode = 'erase';
  /** Brush diameter, pixels of the picture. */
  private size = 80;
  private hardness = 0.5;
  private opacity = 1;
  private state: EraseState | null = null;
  /** Colours: the current picture's where it shows, the source's where it was erased before. */
  private colours: Uint8ClampedArray | null = null;
  private work: OffscreenCanvas | null = null;
  private out: ImageData | null = null;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private frame = 0;
  private readonly undo: Uint8ClampedArray[] = [];
  private readonly redo: Uint8ClampedArray[] = [];
  private seed = 1;
  /** The view: picture pixel → stage px is `p * scale + offset`. */
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private space = false;
  private backdrop: Backdrop = 'checker';
  private pointerAt: Point | null = null;
  /** Where the last stroke ended (Shift + click goes on from it). */
  private lastEnd: Point | null = null;

  constructor(editor: Editor, id: NodeId, index: number) {
    this.editor = editor;
    this.id = id;
    this.index = index;
    const d = editor.doc;
    this.paint = d.get(id, 'fills')[index] as ImagePaint;
    this.sourceHash = this.paint.eraseSource && d.store.blobs.has(this.paint.eraseSource) ? this.paint.eraseSource : this.paint.imageHash;

    this.view = h('canvas', { class: 'erase-view' });
    this.ring = h('div', { class: 'erase-ring', hidden: true });
    const zoomOut = h('button', { class: 'icon-button', type: 'button', title: tr('Отдалить (⌘−)'), 'aria-label': tr('Отдалить'), onclick: () => this.zoomBy(1 / 1.25) }, '−');
    const zoomIn = h('button', { class: 'icon-button', type: 'button', title: tr('Приблизить (⌘+)'), 'aria-label': tr('Приблизить'), onclick: () => this.zoomBy(1.25) }, '+');
    this.zoomLabel = h('button', { class: 'text-button erase-zoom-label', type: 'button', title: tr('Вписать в окно (⌘0)'), onclick: () => this.fit() }, '100%');
    this.stage = h('div', { class: 'erase-stage' }, this.view, this.ring, h('div', { class: 'erase-zoom' }, zoomOut, this.zoomLabel, zoomIn));
    this.bindPointer();

    const segmented = <T extends string>(label: string, items: [T, string, string][], pick: (v: T) => void) => {
      const group = h('div', { class: 'segmented with-text', role: 'group', 'aria-label': label });
      const choose = (v: T) => {
        pick(v);
        for (const el of group.children) el.classList.toggle('active', (el as HTMLElement).dataset.value === v);
      };
      for (const [value, text, title] of items) group.append(h('button', { class: 'segment', type: 'button', dataset: { value }, title, onclick: () => choose(value) }, text));
      return { group, choose };
    };
    const slider = (label: string, min: number, max: number, value: number, title: string, onInput: (v: number) => void, format: (v: number) => string) => {
      const input = h('input', { type: 'range', min: String(min), max: String(max), value: String(value), 'aria-label': label, title });
      const shown = h('span', { class: 'erase-value' }, format(value));
      input.addEventListener('input', () => {
        onInput(Number(input.value));
        shown.textContent = format(Number(input.value));
        this.showRing();
      });
      return { el: h('label', { class: 'erase-slider', title }, h('span', { class: 'erase-label' }, label), input, shown), input, shown };
    };
    const size = slider(tr('Размер'), 0, 100, fromSize(this.size), tr('Размер кисти в пикселях картинки ([ и ])'), (v) => (this.size = toSize(v)), (v) => `${toSize(v)}`);
    this.sizeInput = size.input;
    this.sizeValue = size.shown;
    const hardness = slider(tr('Жёсткость'), 0, 100, this.hardness * 100, tr('Насколько чёткий край у мягкой кисти'), (v) => (this.hardness = v / 100), (v) => `${v}%`);
    this.hardnessLine = hardness.el;
    const opacity = slider(tr('Нажим'), 5, 100, this.opacity * 100, tr('Сколько стирает или проявляет один мазок; внутри мазка не накапливается'), (v) => (this.opacity = v / 100), (v) => `${v}%`);
    const modes = segmented<EraseMode>(tr('Режим'), [['erase', tr('Стереть'), tr('Стирает картинку под кистью (E)')], ['restore', tr('Вернуть'), tr('Проявляет картинку обратно (R). Alt — другой режим на время мазка')]], (v) => (this.mode = v));
    this.chooseMode = modes.choose;
    const brushes = segmented<EraseBrush>(tr('Кисть'), BRUSHES, (v) => {
      this.brush = v;
      this.hardnessLine.hidden = v !== 'soft';
    });
    this.chooseBrush = brushes.choose;
    modes.choose(this.mode);
    brushes.choose(this.brush);

    const backdrops = h('div', { class: 'erase-backdrops', role: 'group', 'aria-label': tr('Фон под картинкой') });
    const setBackdrop = (b: Backdrop) => {
      this.backdrop = b;
      this.paintView();
      for (const el of backdrops.children) el.classList.toggle('on', (el as HTMLElement).dataset.value === b);
    };
    for (const [b, title] of [['checker', tr('Шахматка')], ['white', tr('Белый')], ['black', tr('Чёрный')]] as [Backdrop, string][]) {
      backdrops.append(h('button', { class: `erase-backdrop ${b}`, type: 'button', dataset: { value: b }, title: tr('Фон под картинкой: {0}', title), 'aria-label': title, onclick: () => setBackdrop(b) }));
    }
    setBackdrop('checker');
    const hideAll = h('button', { class: 'text-button', type: 'button', title: tr('Скрыть картинку целиком — и проявлять её кистью в режиме «Вернуть»'), onclick: () => this.setAll(false) }, tr('Скрыть всё'));
    const restoreAll = h('button', { class: 'text-button', type: 'button', title: tr('Вернуть картинку целиком'), onclick: () => this.setAll(true) }, tr('Вернуть всё'));
    const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => this.close() }, tr('Отмена'));
    this.apply = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.finish() }, tr('Применить'));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog erase-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Стереть кистью') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Стереть кистью')), close),
      h('div', { class: 'erase-tools' }, modes.group, brushes.group, size.el, this.hardnessLine, opacity.el, backdrops, h('span', { class: 'crop-spacer' }), hideAll, restoreAll),
      this.stage,
      h(
        'div',
        { class: 'crop-bar' },
        h('span', { class: 'erase-hint' }, tr('Совет: «Скрыть всё», затем проявляйте картинку сухой кистью в режиме «Вернуть». ⌘ + колёсико — масштаб, пробел — сдвиг, Shift + щелчок — прямой мазок.')),
        h('span', { class: 'crop-spacer' }),
        cancel,
        this.apply,
      ),
    );
    this.overlay = h('div', { class: 'dialog-overlay erase-overlay' }, dialog);
    // Keys go to the window while it is open, wherever the focus is (⌘Z must not undo in the file behind).
    this.onKey = (e) => this.key(e);
    this.onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      this.space = false;
      this.stage.classList.remove('panning');
      this.showRing();
    };
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.body.append(this.overlay);
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.stage);
    this.apply.focus();
    void this.load();
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.key !== 'Escape') return;
    e.stopPropagation();
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') this.close();
    else if (e.key === 'Enter') {
      e.preventDefault();
      void this.finish();
    } else if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      this.step(e.shiftKey ? 'redo' : 'undo');
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.zoomBy(1.25);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      this.zoomBy(1 / 1.25);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      this.fit();
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.space = true;
      this.stage.classList.add('panning');
      this.ring.hidden = true;
    } else if (e.code === 'KeyE') this.chooseMode('erase');
    else if (e.code === 'KeyR') this.chooseMode('restore');
    else if (/^Digit[1-5]$/.test(e.code)) this.chooseBrush(BRUSHES[Number(e.code.slice(5)) - 1]![0]);
    else if (e.code === 'BracketLeft' || e.code === 'BracketRight') this.setSize(this.size * (e.code === 'BracketRight' ? 1.2 : 1 / 1.2));
  }

  private setSize(px: number): void {
    this.size = Math.max(2, Math.min(800, Math.round(px)));
    this.sizeInput.value = String(fromSize(this.size));
    this.sizeValue.textContent = String(this.size);
    this.showRing();
  }

  private async load(): Promise<void> {
    const d = this.editor.doc;
    const read = async (hash: string) => {
      const blob = d.store.blobs.get(hash);
      if (!blob) return null;
      const bitmap = await createImageBitmap(new Blob([base64ToBytes(blob.data) as BlobPart], { type: blob.mime })).catch(() => null);
      if (!bitmap) return null;
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const x = c.getContext('2d')!;
      x.drawImage(bitmap, 0, 0);
      bitmap.close();
      return x.getImageData(0, 0, c.width, c.height);
    };
    const current = await read(this.paint.imageHash);
    let source = this.sourceHash === this.paint.imageHash ? current : await read(this.sourceHash);
    if (!current) return this.fail();
    // The source of another size (the picture was cropped since): it cannot bring anything back.
    if (!source || source.width !== current.width || source.height !== current.height) source = current;
    const n = current.width * current.height;
    const shown = new Uint8ClampedArray(n);
    const full = new Uint8ClampedArray(n);
    const colours = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      shown[p] = current.data[p * 4 + 3]!;
      full[p] = Math.max(source.data[p * 4 + 3]!, current.data[p * 4 + 3]!);
      const from = current.data[p * 4 + 3]! > 0 ? current.data : source.data;
      colours[p * 4] = from[p * 4]!;
      colours[p * 4 + 1] = from[p * 4 + 1]!;
      colours[p * 4 + 2] = from[p * 4 + 2]!;
      colours[p * 4 + 3] = 255;
    }
    this.state = { width: current.width, height: current.height, shown, full };
    this.colours = colours;
    this.work = new OffscreenCanvas(current.width, current.height);
    this.out = new ImageData(current.width, current.height);
    // A brush of a twelfth of the picture to begin with.
    this.setSize(Math.max(8, Math.max(current.width, current.height) / 12));
    this.layout();
    this.fit();
    this.touch(0, 0, current.width, current.height);
  }

  private fail(): void {
    this.close();
    this.editor.toast(tr('Не удалось прочитать картинку'));
  }

  /** The canvas fills the stage, at the screen's density. */
  private layout(): void {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.view.width = Math.max(1, Math.round(r.width * dpr));
    this.view.height = Math.max(1, Math.round(r.height * dpr));
    this.view.style.width = `${r.width}px`;
    this.view.style.height = `${r.height}px`;
    this.paintView();
  }

  private fit(): void {
    const s = this.state;
    if (!s) return;
    const r = this.stage.getBoundingClientRect();
    this.scale = Math.max(0.02, Math.min((r.width - 48) / s.width, (r.height - 48) / s.height));
    this.ox = (r.width - s.width * this.scale) / 2;
    this.oy = (r.height - s.height * this.scale) / 2;
    this.paintView();
    this.showRing();
  }

  /** Zooms round a stage point (the middle by default). */
  private zoomBy(k: number, at?: Point): void {
    const r = this.stage.getBoundingClientRect();
    const c = at ?? { x: r.width / 2, y: r.height / 2 };
    const next = Math.max(0.02, Math.min(32, this.scale * k));
    this.ox = c.x - ((c.x - this.ox) * next) / this.scale;
    this.oy = c.y - ((c.y - this.oy) * next) / this.scale;
    this.scale = next;
    this.paintView();
    this.showRing();
  }

  /** Marks a box of the picture for redrawing (at the next frame). */
  private touch(x: number, y: number, w: number, h: number): void {
    const b = this.dirty;
    this.dirty = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x + w), y1: Math.max(b.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h };
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.frame = 0;
    const { state, colours, work, out, dirty } = this;
    if (!state || !colours || !work || !out) return;
    if (dirty) {
      this.dirty = null;
      const W = state.width;
      const x0 = Math.max(0, dirty.x0);
      const y0 = Math.max(0, dirty.y0);
      const x1 = Math.min(W, dirty.x1);
      const y1 = Math.min(state.height, dirty.y1);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * W + x;
          out.data[p * 4] = colours[p * 4]!;
          out.data[p * 4 + 1] = colours[p * 4 + 1]!;
          out.data[p * 4 + 2] = colours[p * 4 + 2]!;
          out.data[p * 4 + 3] = state.shown[p]!;
        }
      }
      if (x1 > x0 && y1 > y0) work.getContext('2d')!.putImageData(out, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
    this.paintView();
  }

  private paintView(): void {
    const ctx = this.view.getContext('2d')!;
    const cssWidth = parseFloat(this.view.style.width) || this.view.width;
    const dpr = this.view.width / cssWidth;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.view.width, this.view.height);
    const s = this.state;
    if (!s || !this.work) return;
    // Under the picture: the chosen backdrop (a checkerboard of fixed screen squares).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = { x: this.ox, y: this.oy, w: s.width * this.scale, h: s.height * this.scale };
    if (this.backdrop === 'checker') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = '#e3e3e3';
      const q = 10;
      const x0 = Math.max(box.x, 0);
      const y0 = Math.max(box.y, 0);
      const x1 = Math.min(box.x + box.w, cssWidth);
      const y1 = Math.min(box.y + box.h, this.view.height / dpr);
      for (let y = Math.floor(y0 / q) * q; y < y1; y += q) for (let x = Math.floor(x0 / q) * q; x < x1; x += q) if (((x + y) / q) % 2 === 0) ctx.fillRect(x, y, q, q);
      ctx.restore();
    } else {
      ctx.fillStyle = this.backdrop === 'white' ? '#ffffff' : '#000000';
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
    // Close up the pixels are seen as pixels (the edge's fibres can be judged).
    ctx.imageSmoothingEnabled = this.scale < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.work, 0, 0);
    // The picture's edge, thin, so its size is seen even when it is all hidden.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(127, 127, 127, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(this.ox) + 0.5, Math.round(this.oy) + 0.5, Math.round(s.width * this.scale) - 1, Math.round(s.height * this.scale) - 1);
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }

  /** The brush's outline at the pointer, as large as it will paint. */
  private showRing(): void {
    const at = this.pointerAt;
    if (!at || this.space) return void (this.ring.hidden = true);
    const d = Math.max(4, this.size * this.scale);
    this.ring.hidden = false;
    Object.assign(this.ring.style, { left: `${at.x}px`, top: `${at.y}px`, width: `${d}px`, height: `${d}px` });
  }

  private bindPointer(): void {
    const target = this.view;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = this.stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toPicture = (e: { clientX: number; clientY: number }): Point => {
      const p = local(e);
      return { x: (p.x - this.ox) / this.scale, y: (p.y - this.oy) / this.scale };
    };
    target.addEventListener('pointermove', (e) => {
      this.pointerAt = local(e);
      this.showRing();
    });
    target.addEventListener('pointerleave', () => {
      this.pointerAt = null;
      this.ring.hidden = true;
    });
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // A pinch on a touchpad comes as a wheel with Ctrl.
        if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), local(e));
        else {
          this.ox -= e.deltaX;
          this.oy -= e.deltaY;
          this.paintView();
        }
      },
      { passive: false },
    );
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('pointerdown', (e) => {
      if (!this.state) return;
      e.preventDefault();
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // no real pointer: the gesture still follows moves over the picture
      }
      let stroke: Stroke | null = null;
      let move: (ev: PointerEvent) => void;
      if (this.space || e.button === 1 || e.button === 2) {
        // Space, the middle or the right button: move the view.
        const from = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
        move = (ev) => {
          this.ox = from.ox + ev.clientX - from.x;
          this.oy = from.oy + ev.clientY - from.y;
          this.paintView();
        };
      } else if (e.button === 0) {
        const state = this.state;
        this.undo.push(state.shown.slice());
        if (this.undo.length > UNDO_STEPS) this.undo.shift();
        this.redo.length = 0;
        // Each stroke its own torn edge, bristles and drops.
        this.seed = (this.seed * 48271) % 2147483647;
        const mode: EraseMode = e.altKey ? (this.mode === 'erase' ? 'restore' : 'erase') : this.mode;
        const s = new Stroke(state, { brush: this.brush, mode, radius: this.size / 2, hardness: this.hardness, opacity: this.opacity, seed: this.seed });
        stroke = s;
        const paint = (p: Point) => {
          const box = s.to(p);
          if (box) this.touch(box.x, box.y, box.w, box.h);
        };
        // Shift: a straight stroke from where the last one ended.
        if (e.shiftKey && this.lastEnd) s.to(this.lastEnd);
        paint(toPicture(e));
        move = (ev) => {
          this.pointerAt = local(ev);
          this.showRing();
          // A pen or a fast mouse sends in-between points too: each goes into the stroke.
          const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
          for (const c of events.length ? events : [ev]) paint(toPicture(c));
        };
      } else return;
      const end = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', end);
        target.removeEventListener('pointercancel', end);
        if (stroke?.last) this.lastEnd = stroke.last;
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    });
  }

  private step(which: 'undo' | 'redo'): void {
    const s = this.state;
    if (!s) return;
    const from = which === 'undo' ? this.undo : this.redo;
    const to = which === 'undo' ? this.redo : this.undo;
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push(s.shown.slice());
    s.shown.set(snapshot);
    this.touch(0, 0, s.width, s.height);
  }

  /** Everything shown again, or everything hidden (to paint the picture back in with "Restore"). */
  private setAll(show: boolean): void {
    const s = this.state;
    if (!s) return;
    this.undo.push(s.shown.slice());
    this.redo.length = 0;
    if (show) s.shown.set(s.full);
    else {
      s.shown.fill(0);
      this.chooseMode('restore');
    }
    this.touch(0, 0, s.width, s.height);
  }

  private async finish(): Promise<void> {
    const { state, work, out } = this;
    if (!state || !work || !out || this.apply.disabled) return;
    const editor = this.editor;
    const d = editor.doc;
    if (d.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
    this.apply.disabled = true;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.draw();
    }
    // Nothing erased (everything brought back) — the source picture again, without the memory of erasing.
    let whole = true;
    for (let p = 0; p < state.shown.length && whole; p++) whole = state.shown[p]! >= state.full[p]!;
    const bytes = whole ? null : new Uint8Array(await (await work.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const id = this.id;
    const index = this.index;
    const source = this.sourceHash;
    editor.commit(tr('Стереть кистью'), (tx) => {
      const fills = d.get(id, 'fills').slice();
      const paint = fills[index];
      if (paint?.type !== 'IMAGE') return;
      // The erased picture is a new one: an earlier crop no longer applies to it.
      const { crop: _crop, eraseSource: _source, ...rest } = paint;
      fills[index] = bytes ? { ...rest, imageHash: tx.addBlob(bytes, 'image/png'), eraseSource: source } : { ...rest, imageHash: source };
      tx.set(id, 'fills', fills);
    });
    this.close();
    editor.toast(whole ? tr('Картинка возвращена целиком.') : tr('Картинка стёрта кистью. Отменить — {0}.', IS_MAC ? '⌘Z' : 'Ctrl+Z'));
  }

  close(): void {
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    this.resize.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.overlay.remove();
  }
}
