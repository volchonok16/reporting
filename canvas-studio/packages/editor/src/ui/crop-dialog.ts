// "Crop picture" window: the whole picture with a frame to drag by its
// corners, edges or middle; proportions to keep; "Whole picture" brings back
// everything. Applying stores the kept part as a new picture (so every export
// shows it the same) and remembers the whole one, so the crop can be changed
// later. The layer is resized so the picture stays where it was on the canvas.

import { base64ToBytes, tr, type ImagePaint, type NodeId } from '#core';
import { dragCrop, fitRatio, FULL, isFull, layerAfterCrop, type CropHandle, type CropRect } from '../crop.ts';
import type { Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import { h, icon } from './dom.ts';

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const STAGE_W = 640;
const STAGE_H = 420;

export class CropDialog {
  private readonly overlay: HTMLElement;
  private readonly editor: Editor;
  private readonly id: NodeId;
  private readonly index: number;
  private readonly paint: ImagePaint;
  private readonly source: string;
  private rect: CropRect;
  /** Width/height to keep, in pixels; null — free. */
  private aspect: number | null = null;
  private bitmap: ImageBitmap | null = null;
  private readonly stage: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly hole: HTMLElement;
  private readonly size: HTMLElement;
  private shown = { width: 0, height: 0 };

  constructor(editor: Editor, id: NodeId, index: number) {
    this.editor = editor;
    this.id = id;
    this.index = index;
    const d = editor.doc;
    this.paint = d.get(id, 'fills')[index] as ImagePaint;
    this.source = this.paint.crop?.source && d.store.blobs.has(this.paint.crop.source) ? this.paint.crop.source : this.paint.imageHash;
    this.rect = this.paint.crop && this.source === this.paint.crop.source ? { x: this.paint.crop.x, y: this.paint.crop.y, width: this.paint.crop.width, height: this.paint.crop.height } : { ...FULL };

    this.stage = h('div', { class: 'crop-stage' });
    this.frame = h('div', { class: 'crop-frame', title: tr('Тяните, чтобы сдвинуть') });
    for (const handle of HANDLES) this.frame.append(h('span', { class: `crop-handle ${handle}`, dataset: { handle } }));
    this.hole = h('div', { class: 'crop-hole' });
    this.stage.append(h('div', { class: 'crop-shade' }, this.hole), this.frame);
    this.bindDrag();
    this.size = h('span', { class: 'crop-size' });

    const ratios: [string, number | null | 'layer'][] = [
      [tr('Свободно'), null],
      [tr('Как у слоя'), 'layer'],
      ['1:1', 1],
      ['4:3', 4 / 3],
      ['3:4', 3 / 4],
      ['16:9', 16 / 9],
      ['9:16', 9 / 16],
    ];
    const ratio = h('select', { class: 'field-select', 'aria-label': tr('Пропорции') }, ...ratios.map(([label], i) => h('option', { value: String(i) }, label)));
    ratio.addEventListener('change', () => {
      const chosen = ratios[Number(ratio.value)]![1];
      this.aspect = chosen === 'layer' ? d.get(id, 'width') / Math.max(1e-6, d.get(id, 'height')) : chosen;
      if (this.aspect !== null && this.bitmap) this.rect = fitRatio(this.rect, this.shareRatio()!);
      this.draw();
    });
    ratio.addEventListener('keydown', (e) => e.stopPropagation());
    const whole = h('button', { class: 'text-button', type: 'button', onclick: () => ((this.rect = { ...FULL }), (ratio.value = '0'), (this.aspect = null), this.draw()) }, tr('Вся картинка'));
    const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => this.close() }, tr('Отмена'));
    const apply = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.apply() }, tr('Обрезать'));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog crop-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Обрезать картинку') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Обрезать картинку')), close),
      this.stage,
      h('div', { class: 'crop-bar' }, h('div', { class: 'select-wrap' }, ratio), this.size, h('span', { class: 'crop-spacer' }), whole, cancel, apply),
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        void this.apply();
      }
    });
    document.body.append(this.overlay);
    apply.focus();
    void this.load();
  }

  private async load(): Promise<void> {
    const blob = this.editor.doc.store.blobs.get(this.source);
    if (!blob) return this.fail();
    this.bitmap = await createImageBitmap(new Blob([base64ToBytes(blob.data) as BlobPart], { type: blob.mime })).catch(() => null);
    if (!this.bitmap) return this.fail();
    const k = Math.min(STAGE_W / this.bitmap.width, STAGE_H / this.bitmap.height, 1);
    this.shown = { width: Math.round(this.bitmap.width * k), height: Math.round(this.bitmap.height * k) };
    const canvas = h('canvas', { class: 'crop-image', width: this.shown.width, height: this.shown.height });
    canvas.getContext('2d')?.drawImage(this.bitmap, 0, 0, this.shown.width, this.shown.height);
    this.stage.style.width = `${this.shown.width}px`;
    this.stage.style.height = `${this.shown.height}px`;
    this.stage.prepend(canvas);
    this.draw();
  }

  private fail(): void {
    this.close();
    this.editor.toast(tr('Не удалось прочитать картинку'));
  }

  /** The kept proportion in shares of the picture. */
  private shareRatio(): number | null {
    if (this.aspect === null || !this.bitmap) return null;
    return (this.aspect * this.bitmap.height) / this.bitmap.width;
  }

  private draw(): void {
    const { width, height } = this.shown;
    const r = this.rect;
    const box = { left: `${r.x * width}px`, top: `${r.y * height}px`, width: `${r.width * width}px`, height: `${r.height * height}px` };
    Object.assign(this.frame.style, box);
    Object.assign(this.hole.style, box);
    if (this.bitmap) this.size.textContent = `${Math.round(r.width * this.bitmap.width)} × ${Math.round(r.height * this.bitmap.height)} px`;
  }

  private bindDrag(): void {
    this.frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.bitmap) return;
      e.preventDefault();
      const handle = ((e.target as HTMLElement).dataset.handle as CropHandle | undefined) ?? 'move';
      const start = { ...this.rect };
      const from = { x: e.clientX, y: e.clientY };
      try {
        this.frame.setPointerCapture(e.pointerId);
      } catch {
        // no real pointer (a pen lifted already): the drag still follows moves over the frame
      }
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - from.x) / this.shown.width;
        const dy = (ev.clientY - from.y) / this.shown.height;
        // Shift keeps the current proportion while dragging, as in other editors.
        const ratio = this.shareRatio() ?? (ev.shiftKey && handle !== 'move' ? start.width / start.height : null);
        this.rect = dragCrop(start, handle, dx, dy, ratio);
        this.draw();
      };
      const up = () => {
        this.frame.removeEventListener('pointermove', move);
        this.frame.removeEventListener('pointerup', up);
        this.frame.removeEventListener('pointercancel', up);
      };
      this.frame.addEventListener('pointermove', move);
      this.frame.addEventListener('pointerup', up);
      this.frame.addEventListener('pointercancel', up);
    });
  }

  private async apply(): Promise<void> {
    const bitmap = this.bitmap;
    if (!bitmap) return;
    const editor = this.editor;
    const d = editor.doc;
    if (d.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
    const r = this.rect;
    const before: CropRect = this.paint.crop && this.paint.crop.source === this.source ? this.paint.crop : FULL;
    let bytes: Uint8Array | null = null;
    let mime = 'image/png';
    if (!isFull(r)) {
      const sx = Math.round(r.x * bitmap.width);
      const sy = Math.round(r.y * bitmap.height);
      const sw = Math.max(1, Math.round(r.width * bitmap.width));
      const sh = Math.max(1, Math.round(r.height * bitmap.height));
      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      // Photos stay JPEG/WebP (much smaller); everything else becomes PNG (keeps transparency).
      const sourceMime = d.store.blobs.get(this.source)?.mime ?? '';
      mime = sourceMime === 'image/jpeg' || sourceMime === 'image/webp' ? sourceMime : 'image/png';
      bytes = new Uint8Array(await (await canvas.convertToBlob({ type: mime, quality: 0.92 })).arrayBuffer());
    }
    const id = this.id;
    const index = this.index;
    editor.commit(tr('Обрезать картинку'), (tx) => {
      const fills = d.get(id, 'fills').slice();
      const paint = fills[index];
      if (paint?.type !== 'IMAGE') return;
      const { crop: _old, ...rest } = paint;
      fills[index] = bytes ? { ...rest, imageHash: tx.addBlob(bytes, mime), crop: { source: this.source, ...pick(r) } } : { ...rest, imageHash: this.source };
      tx.set(id, 'fills', fills);
      if (paint.scaleMode !== 'TILE') {
        const next = layerAfterCrop({ x: d.get(id, 'x'), y: d.get(id, 'y'), width: d.get(id, 'width'), height: d.get(id, 'height'), rotation: d.get(id, 'rotation') }, before, r);
        tx.set(id, 'x', next.x);
        tx.set(id, 'y', next.y);
        tx.set(id, 'width', next.width);
        tx.set(id, 'height', next.height);
      }
    });
    this.close();
    editor.toast(tr('Картинка обрезана. Отменить — {0}.', IS_MAC ? '⌘Z' : 'Ctrl+Z'));
  }

  close(): void {
    this.bitmap?.close();
    this.overlay.remove();
  }
}

function pick(r: CropRect): CropRect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
