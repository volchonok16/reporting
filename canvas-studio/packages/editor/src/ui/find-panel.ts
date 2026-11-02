// "Find and replace" panel over the canvas (Mod+F): what to find, what to
// put instead, where to look. Enter goes to the next match (Shift+Enter — the
// previous one), selecting its layer and bringing it into view.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { findMatches, replaceMatches, type FindMatch, type FindOptions, type FindScope } from '../find-replace.ts';
import { IS_MAC } from '../keyboard.ts';
import { h, icon } from './dom.ts';

export class FindPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly find: HTMLInputElement;
  private readonly replace: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly options: FindOptions = { query: '', caseSensitive: false, wholeWord: false, scope: 'file', names: false };
  private matches: FindMatch[] = [];
  private current = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** "In the selection": the selection when the search started (going to a match selects it). */
  private within: string[] = [];

  constructor(editor: Editor) {
    this.editor = editor;
    const stop = (input: HTMLInputElement, onEnter: (e: KeyboardEvent) => void) =>
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter(e);
        } else if (e.key === 'Escape') this.close();
      });
    this.find = h('input', { class: 'find-input', type: 'search', placeholder: tr('Найти'), 'aria-label': tr('Найти'), spellcheck: false });
    this.replace = h('input', { class: 'find-input', type: 'text', placeholder: tr('Заменить на'), 'aria-label': tr('Заменить на'), spellcheck: false });
    stop(this.find, (e) => this.go(e.shiftKey ? -1 : 1));
    stop(this.replace, (e) => (e.metaKey || e.ctrlKey ? this.replaceAll() : this.replaceOne()));
    this.find.addEventListener('input', () => this.schedule());
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    const toggle = (label: string, title: string, key: 'caseSensitive' | 'wholeWord' | 'names') => {
      const b = h('button', { class: 'find-toggle', type: 'button', title, 'aria-pressed': 'false' }, label);
      b.addEventListener('click', () => {
        this.options[key] = !this.options[key];
        b.setAttribute('aria-pressed', String(this.options[key]));
        b.classList.toggle('on', this.options[key]);
        this.search();
      });
      return b;
    };
    const scope = h(
      'select',
      { class: 'field-select', 'aria-label': tr('Где искать') },
      h('option', { value: 'file' }, tr('Во всём файле')),
      h('option', { value: 'page' }, tr('На этой странице')),
      h('option', { value: 'selection' }, tr('В выделенном')),
    );
    scope.addEventListener('change', () => {
      this.options.scope = scope.value as FindScope;
      this.within = [...this.editor.selection];
      this.search();
    });
    scope.addEventListener('keydown', (e) => e.stopPropagation());
    const button = (label: string, title: string, run: () => void, cls = 'text-button') => h('button', { class: cls, type: 'button', title, onclick: run }, label);
    this.el = h(
      'div',
      { class: 'find-panel', role: 'search', hidden: true },
      h(
        'div',
        { class: 'find-row' },
        this.find,
        this.count,
        h('button', { class: 'icon-button', type: 'button', title: tr('Предыдущее (Shift+Enter)'), 'aria-label': tr('Предыдущее'), onclick: () => this.go(-1) }, icon('chevronUp')),
        h('button', { class: 'icon-button', type: 'button', title: tr('Следующее (Enter)'), 'aria-label': tr('Следующее'), onclick: () => this.go(1) }, icon('chevronDown')),
        h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close')),
      ),
      h(
        'div',
        { class: 'find-row' },
        this.replace,
        button(tr('Заменить'), tr('Заменить найденное и перейти к следующему (Enter)'), () => this.replaceOne()),
        button(tr('Все'), tr('Заменить все совпадения ({0}+Enter)', IS_MAC ? '⌘' : 'Ctrl'), () => this.replaceAll()),
      ),
      h(
        'div',
        { class: 'find-row find-options' },
        toggle('Aa', tr('Учитывать регистр'), 'caseSensitive'),
        toggle(tr('Слово'), tr('Только слово целиком'), 'wholeWord'),
        toggle(tr('Имена'), tr('Искать и в названиях слоёв'), 'names'),
        h('div', { class: 'select-wrap' }, scope),
      ),
    );
    // After a replacement or any other change, the list is found again.
    editor.events.on('change', () => {
      if (!this.el.hidden && this.options.query) this.schedule();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Opens with the selected text (if any) as the query. */
  open(): void {
    this.el.hidden = false;
    this.within = [...this.editor.selection];
    const t = this.editor.textSel;
    const id = this.editor.editingText;
    if (id && t && t.anchor !== t.focus) {
      const text = this.editor.doc.get(id, 'characters');
      this.find.value = text.slice(Math.min(t.anchor, t.focus), Math.max(t.anchor, t.focus));
    }
    this.find.focus();
    this.find.select();
    this.search();
  }

  close(): void {
    this.el.hidden = true;
    this.editor.events.emit('viewport', undefined);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(), 120);
  }

  private search(): void {
    this.options.query = this.find.value;
    const before = this.matches[this.current];
    this.matches = findMatches(this.editor.doc, this.options, { pageId: this.editor.pageId, selection: this.within });
    // Stay on the same match when the list is found again.
    this.current = before ? this.matches.findIndex((m) => m.id === before.id && m.field === before.field && m.start >= before.start) : -1;
    if (this.current < 0 && before) this.current = Math.min(this.matches.length - 1, Math.max(0, this.matches.findIndex((m) => m.id === before.id)));
    this.showCount();
  }

  private showCount(): void {
    const n = this.matches.length;
    this.count.textContent = !this.options.query ? '' : n === 0 ? tr('Нет') : this.current >= 0 ? `${this.current + 1} / ${n}` : String(n);
    this.el.classList.toggle('none', !!this.options.query && n === 0);
  }

  /** Goes to the next (1) or previous (-1) match: its page, its layer selected and in view. */
  private go(step: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.current = (this.current + step + this.matches.length) % this.matches.length;
    if (this.current < 0) this.current = 0;
    const m = this.matches[this.current]!;
    const editor = this.editor;
    if (m.page !== editor.pageId && editor.doc.store.isAlive(m.page)) editor.setPage(m.page);
    editor.setSelection([m.id]);
    const b = editor.scene.bounds(m.id);
    const tl = editor.viewport.worldToScreen({ x: b.x, y: b.y });
    const br = editor.viewport.worldToScreen({ x: b.x + b.width, y: b.y + b.height });
    const { width, height } = editor.screenSize;
    const visible = tl.x >= 0 && tl.y >= 0 && br.x <= width && br.y <= height;
    if (!visible) {
      if (br.x - tl.x > width * 0.9 || br.y - tl.y > height * 0.9) editor.zoomToSelection();
      else {
        editor.viewport.panBy(width / 2 - (tl.x + br.x) / 2, height / 2 - (tl.y + br.y) / 2);
        editor.requestViewport();
      }
    }
    this.showCount();
  }

  private replaceOne(): void {
    if (this.editor.doc.readOnly) return void this.editor.toast(tr('Только просмотр: изменения не сохраняются.'));
    if (this.current < 0) return this.go(1);
    const m = this.matches[this.current];
    if (!m) return;
    const replacement = this.replace.value;
    this.editor.commit(tr('Заменить текст'), (tx) => replaceMatches(this.editor.doc, tx, [m], replacement));
    this.search();
    // The same index now points at the next match.
    this.current = Math.min(this.current - 1, this.matches.length - 1);
    this.go(1);
  }

  private replaceAll(): void {
    if (this.editor.doc.readOnly) return void this.editor.toast(tr('Только просмотр: изменения не сохраняются.'));
    if (this.matches.length === 0) return;
    const matches = this.matches;
    const replacement = this.replace.value;
    let count = 0;
    this.editor.commit(tr('Заменить всё'), (tx) => {
      count = replaceMatches(this.editor.doc, tx, matches, replacement);
    });
    this.editor.toast(tr('Заменено: {0}. Отменить — {1}.', count, IS_MAC ? '⌘Z' : 'Ctrl+Z'));
    this.search();
  }
}
