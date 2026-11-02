// "Similar components" window: components of the file most like the selected
// layer, with a preview; go to one, or replace the layer with its instance.

import { tr } from '#core';
import { renderThumbnail, type Canvas2DRenderer } from '#render';
import type { Editor } from '../editor.ts';
import { similarComponents } from '../similar.ts';
import { h, icon } from './dom.ts';

export class SimilarDialog {
  private readonly overlay: HTMLElement;

  constructor(editor: Editor, renderer: Canvas2DRenderer) {
    const d = editor.doc;
    const target = editor.topLevelSelection()[0]!;
    const found = similarComponents(d, target).slice(0, 12);
    const list = h('div', { class: 'sim-list' });
    if (!found.length) list.append(h('p', { class: 'hint' }, tr('Похожих компонентов в файле не нашлось.')));
    for (const { component, score } of found) {
      const canvas = h('canvas', { class: 'sim-thumb' });
      const page = d.pageOf(component);
      const go = h('button', { class: 'text-button', type: 'button' }, tr('Перейти'));
      go.addEventListener('click', () => {
        this.close();
        if (page && page !== editor.pageId) editor.setPage(page);
        editor.setSelection([component]);
        editor.zoomToSelection();
      });
      const replace = h('button', { class: 'text-button primary', type: 'button', disabled: d.readOnly }, tr('Заменить на копию'));
      replace.addEventListener('click', () => {
        this.close();
        editor.replaceWithInstance(target, component);
        editor.toast(tr('Слой заменён копией «{0}». Отменить — Mod+Z.', d.get(component, 'name')).replace('Mod', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'));
      });
      list.append(
        h(
          'div',
          { class: 'sim-row' },
          canvas,
          h('div', { class: 'sim-info' }, h('strong', {}, d.get(component, 'name')), h('small', {}, `${tr('Сходство {0}%', Math.round(score * 100))}${page ? ` · ${d.get(page, 'name')}` : ''}`)),
          go,
          replace,
        ),
      );
      requestAnimationFrame(() => renderThumbnail(renderer, editor.scene, component, canvas, 72, 48));
    }
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog sim-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Похожие компоненты') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Похожие на «{0}»', d.get(target, 'name'))), close),
      list,
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
  }

  close(): void {
    this.overlay.remove();
  }
}
