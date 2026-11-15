// The bar over the canvas in focus view (step 7): which frame is shown alone,
// the previous and next frames of the page, and the way back (Esc).

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

export class FocusBar {
  readonly el: HTMLElement;
  private readonly name: HTMLElement;
  private readonly count: HTMLElement;
  private readonly editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;
    this.name = h('strong', { class: 'focus-name' });
    this.count = h('span', { class: 'focus-count' });
    const prev = h('button', { class: 'icon-button', type: 'button', title: tr('Предыдущий фрейм'), 'aria-label': tr('Предыдущий фрейм'), onclick: () => editor.stepFocus(-1) }, icon('back', 14));
    const next = h('button', { class: 'icon-button focus-next', type: 'button', title: tr('Следующий фрейм'), 'aria-label': tr('Следующий фрейм'), onclick: () => editor.stepFocus(1) }, icon('back', 14));
    const leave = h('button', { class: 'text-button', type: 'button', title: tr('Вернуться ко всей странице (Esc)'), onclick: () => editor.setFocus(null) }, tr('Вся страница'), h('kbd', {}, 'Esc'));
    this.el = h('div', { class: 'focus-bar', role: 'status', hidden: true }, h('span', { class: 'focus-label' }, tr('Фокус')), this.name, prev, this.count, next, leave);
    editor.events.on('focus', () => this.update());
    editor.events.on('change', () => {
      if (editor.focusFrame) this.update();
    });
    this.update();
  }

  private update(): void {
    const e = this.editor;
    const id = e.focusFrame;
    this.el.hidden = !id;
    if (!id || !e.doc.store.isAlive(id)) return;
    this.name.textContent = String(e.doc.get(id, 'name') ?? '');
    const frames = e.focusableFrames();
    this.count.textContent = tr('{0} из {1}', frames.indexOf(id) + 1, frames.length);
  }
}
