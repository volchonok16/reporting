// "Remove background" window for a photo: the cut found by itself is shown over a
// checkerboard (what goes is dimmed), and two brushes put it right — "Keep" over a
// part of the object that went, "Remove" over background that stayed; after every
// stroke the picture is cut again with the strokes as hints. A plain background
// (a logo, a product on white) needs no window: it is cleared straight away.

import { base64ToBytes, tr, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import { Cutout } from '../remove-bg.ts';
import { h, icon } from './dom.ts';

const STAGE_W = 640;
const STAGE_H = 440;

type Brush = 'keep' | 'remove';

/** Removes the background of one layer's picture: at once when it is plain, in the window when it is a photo. */
export async function removeBackgroundOf(editor: Editor, id: NodeId, index: number): Promise<void> {
  const d = editor.doc;
  if (d.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  const paint = d.get(id, 'fills')[index];
  if (paint?.type !== 'IMAGE') return;
  const blob = d.store.blobs.get(paint.imageHash);
  if (!blob) return;
  const bytes = base64ToBytes(blob.data);
  const { LOADING_NOTE } = await import('../ai-cutout.ts');
  const cut = await Cutout.open(bytes, blob.mime, () => editor.toast(LOADING_NOTE()));
  if (!cut) return void editor.toast(tr('Не удалось прочитать картинку'));
  if (cut.isPlain) {
    if (cut.objectShare > 0.995) return void editor.toast(tr('Фон не найден: картинка уже без фона или он сливается с предметом.'));
    const res = await cut.finish();
    store(editor, id, index, res.png);
    return;
  }
  new RemoveBgDialog(editor, id, index, cut, bytes, blob.mime);
}

/** Puts the cut-out into the fill (one undo step). */
function store(editor: Editor, id: NodeId, index: number, png: Uint8Array): void {
  const d = editor.doc;
  editor.commit(tr('Удалить фон'), (tx) => {
    const fills = d.get(id, 'fills').slice();
    const paint = fills[index];
    // The cut-out is a new picture: an earlier crop no longer applies to it.
    if (paint?.type === 'IMAGE') fills[index] = { ...paint, imageHash: tx.addBlob(png, 'image/png'), crop: undefined };
    tx.set(id, 'fills', fills);
  });
  editor.toast(tr('Фон удалён. Отменить — {0}.', IS_MAC ? '⌘Z' : 'Ctrl+Z'));
}

class RemoveBgDialog {
  private readonly overlay: HTMLElement;
  private readonly view: HTMLCanvasElement;
  private readonly marks: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly apply: HTMLButtonElement;
  private bitmap: ImageBitmap | null = null;
  private brush: Brush = 'remove';
  /** Brush diameter on the screen, px. */
  private size = 24;
  /** Strokes on the small copy: 1 — keep, 2 — remove. */
  private hints: Uint8Array;
  private busy = false;
  /** A stroke drawn while cutting: cut again when the current cut ends. */
  private again = false;
  private shown = { width: 0, height: 0 };
  private readonly editor: Editor;
  private readonly id: NodeId;
  private readonly index: number;
  private readonly cut: Cutout;

  constructor(editor: Editor, id: NodeId, index: number, cut: Cutout, bytes: Uint8Array, mime: string) {
    this.editor = editor;
    this.id = id;
    this.index = index;
    this.cut = cut;
    this.hints = new Uint8Array(cut.small.width * cut.small.height);
    const k = Math.min(STAGE_W / cut.width, STAGE_H / cut.height, 1);
    this.shown = { width: Math.max(1, Math.round(cut.width * k)), height: Math.max(1, Math.round(cut.height * k)) };
    this.view = h('canvas', { class: 'cutout-view', width: this.shown.width, height: this.shown.height });
    this.marks = h('canvas', { class: 'cutout-marks', width: this.shown.width, height: this.shown.height });
    const stage = h('div', { class: 'crop-stage cutout-stage' }, this.view, this.marks);
    stage.style.width = `${this.shown.width}px`;
    stage.style.height = `${this.shown.height}px`;
    this.bindStrokes();

    const brushes = h('div', { class: 'segmented with-text', role: 'group', 'aria-label': tr('Кисть') });
    const choose = (b: Brush) => {
      this.brush = b;
      for (const el of brushes.children) el.classList.toggle('active', (el as HTMLElement).dataset.brush === b);
    };
    brushes.append(
      h('button', { class: 'segment', type: 'button', dataset: { brush: 'keep' }, title: tr('Проведите по части предмета, которая пропала (K)'), onclick: () => choose('keep') }, h('span', { class: 'cutout-dot keep' }), tr('Оставить')),
      h('button', { class: 'segment', type: 'button', dataset: { brush: 'remove' }, title: tr('Проведите по фону, который остался (R)'), onclick: () => choose('remove') }, h('span', { class: 'cutout-dot remove' }), tr('Убрать')),
    );
    choose('remove');
    const size = h('input', { type: 'range', min: '6', max: '80', value: String(this.size), class: 'cutout-size', 'aria-label': tr('Размер кисти'), title: tr('Размер кисти ([ и ])') });
    size.addEventListener('input', () => (this.size = Number(size.value)));
    const reset = h('button', { class: 'text-button', type: 'button', title: tr('Убрать все мазки'), onclick: () => this.reset() }, tr('Сбросить'));
    this.status = h('span', { class: 'crop-size cutout-status' });
    const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => this.close() }, tr('Отмена'));
    this.apply = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.finish() }, tr('Удалить фон'));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog crop-dialog cutout-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Удалить фон') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Удалить фон')), close),
      h('p', { class: 'cutout-hint' }, tr('Затемнено то, что уйдёт. Не так — проведите кистью: «Оставить» по пропавшей части предмета, «Убрать» по оставшемуся фону. Alt — другая кисть.')),
      stage,
      h('div', { class: 'crop-bar' }, brushes, size, this.status, h('span', { class: 'crop-spacer' }), reset, cancel, this.apply),
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.key !== 'Escape' && e.key !== 'Enter') return;
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'Enter') {
        e.preventDefault();
        void this.finish();
      } else if (e.key === 'k' || e.key === 'л') choose('keep');
      else if (e.key === 'r' || e.key === 'к') choose('remove');
      else if (e.key === '[' || e.key === ']') {
        this.size = Math.max(6, Math.min(80, this.size + (e.key === ']' ? 4 : -4)));
        size.value = String(this.size);
      }
    });
    document.body.append(this.overlay);
    this.apply.focus();
    void createImageBitmap(new Blob([bytes as BlobPart], { type: mime }))
      .then((b) => {
        this.bitmap = b;
        this.draw();
      })
      .catch(() => this.close());
  }

  /** The picture with what goes dimmed over the checkerboard, and the strokes on top. */
  private draw(): void {
    const { width, height } = this.shown;
    const ctx = this.view.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    if (!this.bitmap) return;
    // The object mask at the shown size (smooth upscaling of the small mask).
    const { small, label } = this.cut;
    const mask = new OffscreenCanvas(small.width, small.height);
    const mctx = mask.getContext('2d')!;
    const md = mctx.createImageData(small.width, small.height);
    for (let p = 0; p < label.length; p++) md.data[p * 4 + 3] = label[p] ? 255 : 0;
    mctx.putImageData(md, 0, 0);
    // What goes: the picture faintly; what stays: the picture in full.
    ctx.globalAlpha = 0.22;
    ctx.drawImage(this.bitmap, 0, 0, width, height);
    ctx.globalAlpha = 1;
    const kept = new OffscreenCanvas(width, height);
    const kctx = kept.getContext('2d')!;
    kctx.imageSmoothingQuality = 'high';
    kctx.drawImage(mask, 0, 0, width, height);
    kctx.globalCompositeOperation = 'source-in';
    kctx.drawImage(this.bitmap, 0, 0, width, height);
    ctx.drawImage(kept, 0, 0);
    const m = this.marks.getContext('2d')!;
    m.clearRect(0, 0, width, height);
    const hints = new OffscreenCanvas(small.width, small.height);
    const hctx = hints.getContext('2d')!;
    const hd = hctx.createImageData(small.width, small.height);
    for (let p = 0; p < this.hints.length; p++) {
      const v = this.hints[p];
      if (!v) continue;
      // Keep — green, remove — red (as in other cut-out tools).
      hd.data.set(v === 1 ? [36, 190, 90, 150] : [235, 60, 60, 150], p * 4);
    }
    hctx.putImageData(hd, 0, 0);
    m.imageSmoothingEnabled = false;
    m.drawImage(hints, 0, 0, width, height);
  }

  private bindStrokes(): void {
    const target = this.marks;
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // no real pointer: the stroke still follows moves over the picture
      }
      const brush: Brush = e.altKey ? (this.brush === 'keep' ? 'remove' : 'keep') : this.brush;
      let last = this.toSmall(e);
      this.paint(last, last, brush);
      const move = (ev: PointerEvent) => {
        const next = this.toSmall(ev);
        this.paint(last, next, brush);
        last = next;
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        void this.recut();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    });
  }

  /** A pointer position on the small copy. */
  private toSmall(e: PointerEvent): { x: number; y: number } {
    const r = this.marks.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.cut.small.width, y: ((e.clientY - r.top) / r.height) * this.cut.small.height };
  }

  /** Marks a round-ended segment of the stroke on the small copy. */
  private paint(a: { x: number; y: number }, b: { x: number; y: number }, brush: Brush): void {
    const { width, height } = this.cut.small;
    const radius = Math.max(1, ((this.size / 2) * width) / this.shown.width);
    const value = brush === 'keep' ? 1 : 2;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / len2)) : 0;
        if (Math.hypot(x + 0.5 - (a.x + t * dx), y + 0.5 - (a.y + t * dy)) <= radius) this.hints[y * width + x] = value;
      }
    }
    this.draw();
  }

  private async recut(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.status.textContent = tr('Вырезаю…');
    try {
      do {
        this.again = false;
        // Let the stroke show before the heavy work.
        await new Promise((r) => setTimeout(r, 16));
        await this.cut.recut(this.hints.slice());
        this.draw();
      } while (this.again);
    } finally {
      this.busy = false;
      this.status.textContent = '';
    }
  }

  private reset(): void {
    this.hints.fill(0);
    void this.recut();
  }

  private async finish(): Promise<void> {
    if (this.busy || this.apply.disabled) return;
    if (this.cut.objectShare < 0.002) return void this.editor.toast(tr('Ничего не осталось: отметьте кистью «Оставить» сам предмет.'));
    this.apply.disabled = true;
    this.status.textContent = tr('Готовлю картинку…');
    const res = await this.cut.finish();
    store(this.editor, this.id, this.index, res.png);
    this.close();
  }

  close(): void {
    this.bitmap?.close();
    this.overlay.remove();
  }
}
