// A file attached to a slide, drawn on the slide itself. Drag moves it; a click opens it.

import { tr, type NodeId, type SlideFile } from '#core';
import type { Editor } from '../editor.ts';
import { fileAnchor, openSlideFile } from '../slide-files.ts';
import { isSlides, slideIds, slideInfo } from '../slides.ts';
import { h } from './dom.ts';

const MARK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 1.5h5.2L13 5.2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1zm5 1.2V5h2.4L9 2.7zM4.5 8h7v1.2h-7V8zm0 2.4h7v1.2h-7v-1.2z"/></svg>';

export class SlideFilePins {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private frame = 0;
  private drag: { slide: NodeId; index: number; dx: number; dy: number; moved: boolean } | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    this.el = h('div', { class: 'slide-file-pins' });
    for (const event of ['viewport', 'change', 'page'] as const) editor.events.on(event, () => this.request());
  }

  attach(host: HTMLElement): void {
    host.append(this.el);
    this.request();
  }

  private request(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    if (this.drag) return;
    const editor = this.editor;
    const doc = editor.doc;
    if (!isSlides(doc)) {
      this.el.replaceChildren();
      return;
    }
    const pins: HTMLElement[] = [];
    for (const slide of slideIds(doc, editor.pageId)) {
      const files = slideInfo(doc, slide).files ?? [];
      const height = doc.get(slide, 'height');
      const origin = editor.worldOrigin(slide);
      files.forEach((file, index) => {
        const place = file.x != null && file.y != null ? { x: file.x, y: file.y } : fileAnchor(index, height);
        const at = editor.viewport.worldToScreen({ x: origin.x + place.x, y: origin.y + place.y });
        const button = h('button', {
          class: 'slide-file-pin',
          type: 'button',
          title: tr('Открыть «{0}»', file.name),
          style: { transform: `translate(${at.x}px, ${at.y}px)` },
        }) as HTMLButtonElement;
        button.innerHTML = MARK;
        button.append(h('span', {}, file.name));
        button.addEventListener('pointerdown', (e) => this.down(e, slide, index, place, file));
        button.addEventListener('click', (e) => e.stopPropagation());
        pins.push(button);
      });
    }
    this.el.replaceChildren(...pins);
  }

  private down(e: PointerEvent, slide: NodeId, index: number, place: { x: number; y: number }, file: SlideFile): void {
    if (e.button !== 0 || this.editor.doc.readOnly) {
      if (!this.editor.doc.readOnly) return;
      e.stopPropagation();
      e.preventDefault();
      if (!openSlideFile(this.editor.doc, file, 'open')) this.editor.toast(tr('Файл не найден'));
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const button = e.currentTarget as HTMLButtonElement;
    const origin = this.editor.worldOrigin(slide);
    const local = this.editor.toParentSpace(slide, this.point(e));
    const offsetX = local.x - place.x;
    const offsetY = local.y - place.y;
    this.drag = { slide, index, dx: offsetX, dy: offsetY, moved: false };
    button.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const drag = this.drag;
      if (!drag) return;
      const here = this.editor.toParentSpace(slide, this.point(ev));
      const x = here.x - offsetX;
      const y = here.y - offsetY;
      if (Math.hypot(x - place.x, y - place.y) > 3) drag.moved = true;
      place.x = x;
      place.y = y;
      const at = this.editor.viewport.worldToScreen({ x: origin.x + x, y: origin.y + y });
      button.style.transform = `translate(${at.x}px, ${at.y}px)`;
    };
    const up = (ev: PointerEvent) => {
      button.removeEventListener('pointermove', move);
      button.removeEventListener('pointerup', up);
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      if (!drag.moved) {
        if (!openSlideFile(this.editor.doc, file, 'open')) this.editor.toast(tr('Файл не найден'));
        this.paint();
        return;
      }
      const width = this.editor.doc.get(slide, 'width');
      const height = this.editor.doc.get(slide, 'height');
      const x = Math.round(Math.min(Math.max(8, place.x), Math.max(8, width - 40)));
      const y = Math.round(Math.min(Math.max(8, place.y), Math.max(8, height - 28)));
      this.editor.commit(tr('Место файла на слайде'), (tx) => {
        const files = [...(slideInfo(this.editor.doc, slide).files ?? [])];
        const item = files[index];
        if (!item) return;
        files[index] = { ...item, x, y };
        tx.set(slide, 'slide', { ...slideInfo(this.editor.doc, slide), files });
      });
      ev.stopPropagation();
    };
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', up);
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return this.editor.viewport.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }
}
