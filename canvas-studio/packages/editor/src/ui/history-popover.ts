// Undo history (Figma users' complaint: you never know what ⌘Z will take
// back). A list of this person's steps, newest on top: a click returns the
// file to the state right after that step; steps that would be redone are
// shown faded above "Now". Others' changes are not in it — undo is personal.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { when } from './comments.ts';
import { h } from './dom.ts';

export class HistoryPopover {
  private readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly off: () => void;
  private readonly outside: (e: PointerEvent) => void;
  private readonly keys: (e: KeyboardEvent) => void;

  constructor(editor: Editor, anchor: HTMLElement) {
    this.editor = editor;
    this.el = h('div', { class: 'history-popover', role: 'dialog', 'aria-label': tr('История действий') });
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${r.bottom + 6}px`;
    this.el.style.left = `${Math.max(8, Math.min(r.left - 120, innerWidth - 300))}px`;
    document.body.append(this.el);
    this.render();
    this.off = editor.events.on('change', () => this.render());
    this.outside = (e) => {
      if (!this.el.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    };
    this.keys = (e) => {
      if (e.key === 'Escape') this.close();
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', this.outside, true);
      document.addEventListener('keydown', this.keys, true);
    });
  }

  private render(): void {
    const { undo, redo } = this.editor.doc.history();
    const rows: HTMLElement[] = [];
    const row = (label: string, at: number | null, cls: string, go: (() => void) | null) =>
      h('button', { class: `history-row ${cls}`, type: 'button', disabled: !go, onclick: go ?? undefined }, h('span', { class: 'history-label' }, label), at ? h('span', { class: 'history-time' }, when(at)) : null);
    // Redo steps, the farthest on top.
    for (let j = redo.length - 1; j >= 0; j--) rows.push(row(redo[j]!.label || tr('Изменение'), redo[j]!.at || null, 'future', () => this.editor.stepHistory(j + 1)));
    rows.push(h('div', { class: 'history-now' }, tr('Сейчас')));
    for (let k = undo.length - 1; k >= 0; k--) {
      const back = undo.length - 1 - k;
      rows.push(row(undo[k]!.label || tr('Изменение'), undo[k]!.at || null, back === 0 ? 'current' : '', back === 0 ? null : () => this.editor.stepHistory(-back)));
    }
    if (undo.length > 0) rows.push(row(tr('Как было при открытии'), null, 'start', () => this.editor.stepHistory(-undo.length)));
    if (undo.length === 0 && redo.length === 0) rows.push(h('p', { class: 'history-empty' }, tr('Пока нет действий.')));
    this.el.replaceChildren(h('div', { class: 'history-title' }, tr('История действий')), h('div', { class: 'history-list' }, ...rows));
  }

  close(): void {
    this.off();
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.keys, true);
    this.el.remove();
  }
}
