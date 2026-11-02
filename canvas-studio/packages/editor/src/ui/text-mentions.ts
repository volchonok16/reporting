// @mentions in board texts and stickers (roadmap step 10): «@» typed in a text of a
// board lists the people of the file under the caret; arrows choose, Enter or Tab
// puts «@Name» in (in the accent colour), Esc closes the list. The person gets a
// letter with the text and a link to that sticker. Only on a board kept on the
// server, for people with an account: a guest or a local file sees no list.

import { tr, type NodeId } from '#core';
import { boardObjectOf } from '../board.ts';
import type { Person } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import { mentionQuery } from './comments.ts';
import { clear, h } from './dom.ts';

export interface TextMentionsHost {
  /** The people of the file; [] when mentions are off here. */
  people(): Promise<Person[]>;
  userId(): string | null;
  /** Someone was called in the text of this board object (the sticker, not its text layer). */
  mentioned(person: Person, object: NodeId, text: string): void;
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export class TextMentions {
  private readonly editor: Editor;
  private readonly input: HTMLTextAreaElement;
  private readonly host: TextMentionsHost;
  readonly list: HTMLElement;
  private found: Person[] = [];
  private index = 0;
  private at: { start: number; query: string } | null = null;

  constructor(editor: Editor, input: HTMLTextAreaElement, host: TextMentionsHost) {
    this.editor = editor;
    this.input = input;
    this.host = host;
    this.list = h('div', { class: 'mention-list text-mention-list', role: 'listbox', 'aria-label': tr('Упомянуть'), hidden: true });
    input.after(this.list);
  }

  /** After each change of the text or the caret: the «@word» before the caret shows the list. */
  update(): void {
    const editor = this.editor;
    const id = editor.editingText;
    const t = this.input;
    // Not in a code block: «@» there is code (decorators, e-mail in a string).
    if (!id || !editor.isBoardFile() || editor.doc.readOnly || t.selectionStart !== t.selectionEnd || editor.doc.get(id, 'board')?.kind === 'CODE_TEXT') return this.hide();
    const at = mentionQuery(t.value, t.selectionStart);
    this.at = at;
    if (!at) return this.hide();
    const query = at.query.toLocaleLowerCase();
    void this.host.people().then((people) => {
      if (!this.at || this.at.query.toLocaleLowerCase() !== query || editor.editingText !== id) return;
      const me = this.host.userId();
      // Any word of the name may be typed: «@ива» finds «Иван Петров» and «Мария Иванова».
      this.found = people.filter((p) => p.id !== me && p.name.toLocaleLowerCase().split(/\s+/).some((w) => w.startsWith(query))).slice(0, 8);
      this.index = 0;
      this.draw();
    });
  }

  /** Keys while the list is open: true — taken by the list (the canvas must not act on them). */
  key(e: KeyboardEvent): boolean {
    if (this.list.hidden || this.found.length === 0 || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.index = (this.index + (e.key === 'ArrowDown' ? 1 : this.found.length - 1)) % this.found.length;
      this.draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      this.pick(this.found[this.index]!);
    } else if (e.key === 'Escape') {
      this.hide();
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  hide(): void {
    this.at = null;
    this.found = [];
    this.list.hidden = true;
  }

  private pick(person: Person): void {
    const editor = this.editor;
    const id = editor.editingText;
    const at = this.at;
    this.hide();
    if (!id || !at || !editor.insertMention(person.name, at.start)) return;
    const object = boardObjectOf(editor.doc, id) ?? id;
    this.host.mentioned(person, object, editor.doc.get(id, 'characters'));
  }

  private draw(): void {
    const list = this.list;
    clear(list);
    this.found.forEach((p, i) => {
      const row = h('div', { class: `mention-item${i === this.index ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === this.index) }, h('span', { class: 'comment-avatar' }, initial(p.name)), h('span', {}, p.name));
      // pointerdown, not click: the text must not lose its caret first.
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pick(p);
      });
      list.append(row);
    });
    list.hidden = this.found.length === 0;
    if (list.hidden) return;
    // Under the caret: the invisible input stands there (canvas-view keeps it at the caret).
    const s = this.input.style;
    list.style.left = s.left;
    list.style.top = `${parseFloat(s.top || '0') + parseFloat(s.height || '0') + 4}px`;
  }
}
