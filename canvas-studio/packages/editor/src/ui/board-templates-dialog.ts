// Board templates (FEAT-086): pick a ready board — or an empty one, which is
// offered first when a new board opens.

import { tr } from '#core';
import { boardTemplates, insertBoardTemplate } from '../board-templates.ts';
import { insertOwnTemplate, ownTemplates, removeOwnTemplate, saveOwnTemplate } from '../board-own-templates.ts';
import { askText } from './dialog.ts';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

const ICONS: Record<string, string> = { retro: 'sticky', brainstorm: 'ellipse', kanban: 'board', flowchart: 'connector', journey: 'routeElbow', intro: 'stamp' };

export class BoardTemplatesDialog {
  private readonly overlay: HTMLElement;

  constructor(editor: Editor, opts: { fresh?: boolean } = {}) {
    const grid = h('div', { class: 'tpl-grid' });
    if (opts.fresh) {
      const empty = h('button', { class: 'tpl-card', type: 'button' }, h('span', { class: 'tpl-shape wide' }, icon('plus', 22)), h('strong', {}, tr('Пустая доска')), h('small', {}, tr('Начать с чистого листа.')));
      empty.addEventListener('click', () => this.close());
      grid.append(empty);
    }
    for (const t of boardTemplates()) {
      const card = h('button', { class: 'tpl-card', type: 'button' }, h('span', { class: 'tpl-shape wide' }, icon(ICONS[t.id] ?? 'board', 22)), h('strong', {}, t.name), h('small', {}, t.description));
      card.addEventListener('click', () => {
        this.close();
        insertBoardTemplate(editor, t);
        editor.toast(tr('Шаблон «{0}» добавлен.', t.name));
      });
      grid.append(card);
    }
    // Own templates (step 10): kept with the account, on every computer.
    const own = h('div', { class: 'tpl-grid tpl-own' });
    const fill = () => {
      own.replaceChildren();
      for (const t of ownTemplates()) {
        const card = h('button', { class: 'tpl-card', type: 'button', title: tr('Поставить шаблон «{0}» на доску', t.name) }, h('span', { class: 'tpl-shape wide' }, icon('templates', 22)), h('strong', {}, t.name), h('small', {}, new Date(t.at).toLocaleDateString()));
        card.addEventListener('click', () => {
          this.close();
          if (insertOwnTemplate(editor, t)) editor.toast(tr('Шаблон «{0}» добавлен.', t.name));
        });
        const remove = h('button', { class: 'icon-button tpl-remove', type: 'button', title: tr('Удалить шаблон «{0}»', t.name), 'aria-label': tr('Удалить шаблон «{0}»', t.name) }, icon('close', 14));
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          removeOwnTemplate(t.id);
          fill();
        });
        own.append(h('div', { class: 'tpl-own-item' }, card, remove));
      }
      if (!own.childElementCount) own.append(h('p', { class: 'share-muted' }, tr('Пока пусто. Выделите на доске стикеры, фигуры, разделы — и сохраните их как свой шаблон.')));
    };
    fill();
    const save = h('button', { class: 'text-button', type: 'button', disabled: editor.doc.readOnly || editor.selection.length === 0, title: editor.selection.length ? '' : tr('Сначала выделите на доске то, что станет шаблоном') }, tr('Сохранить выделенное как шаблон…'));
    save.addEventListener('click', async () => {
      const name = await askText({ title: tr('Свой шаблон доски'), label: tr('Название'), placeholder: tr('Например, «Ретро команды»'), confirm: tr('Сохранить'), maxLength: 80, empty: tr('Назовите шаблон') });
      if (name === null) return;
      const result = saveOwnTemplate(editor, name);
      editor.toast(result.message, result.ok ? 'info' : 'error');
      fill();
    });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const title = opts.fresh ? tr('С чего начнём?') : tr('Шаблоны досок');
    const dialog = h(
      'div',
      { class: 'dialog tpl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { class: 'dialog-header' }, h('h2', {}, title), close),
      h('p', { class: 'share-muted tpl-intro' }, tr('Шаблон встанет посреди экрана; потом его можно двигать, дописывать и удалять как обычные стикеры и фигуры.')),
      grid,
      h('div', { class: 'tpl-own-head' }, h('h3', {}, tr('Мои шаблоны')), save),
      own,
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
