// "Screen template" window: pick a ready screen built with auto layout.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { screenTemplates } from '../templates.ts';
import { h, icon } from './dom.ts';

export class TemplatesDialog {
  private readonly overlay: HTMLElement;

  constructor(editor: Editor) {
    const grid = h('div', { class: 'tpl-grid' });
    for (const t of screenTemplates()) {
      const card = h(
        'button',
        { class: 'tpl-card', type: 'button' },
        h('span', { class: `tpl-shape${t.width > t.height ? ' wide' : ''}` }, icon(t.width > t.height ? 'slides' : 'frame', 22)),
        h('strong', {}, t.name),
        h('small', {}, t.description),
        h('span', { class: 'tpl-size' }, `${t.width} × ${t.height}`),
      );
      card.addEventListener('click', () => {
        this.close();
        editor.insertTemplate(t);
        editor.toast(tr('Шаблон «{0}» добавлен. Всё на адаптивной раскладке — меняйте тексты и размеры.', t.name));
      });
      grid.append(card);
    }
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog tpl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Шаблоны экранов') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Шаблоны экранов')), close),
      h('p', { class: 'share-muted tpl-intro' }, tr('Готовая отправная точка вместо пустого холста. Шаблон встанет справа от того, что уже есть на странице.')),
      grid,
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    (grid.firstElementChild as HTMLElement | null)?.focus();
  }

  close(): void {
    this.overlay.remove();
  }
}
