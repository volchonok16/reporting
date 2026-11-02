// Cursor chat (live editing, part 2, portion 3): "/" over the canvas opens a
// bubble at one's pointer; what is typed reaches the others at once, next to
// this person's cursor. Enter sends — the message stays a few seconds and
// fades; Esc takes it back. The bubble follows the pointer and closes by
// itself after a while without typing.

import { tr } from '#core';
import { h } from './dom.ts';

/** Longest message (the server cuts longer ones too). */
export const CHAT_LIMIT = 100;
/** How long a sent message stays next to the cursor. */
const LINGER = 5000;
/** The bubble closes after this long without typing. */
const IDLE = 15_000;

export class CursorChat {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private message: string | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The message others should see now changed; set by the app. */
  onMessage: (text: string | null) => void = () => {};

  constructor() {
    this.input = h('input', { class: 'cursor-chat-input', type: 'text', maxlength: CHAT_LIMIT, placeholder: tr('Сообщение'), spellcheck: false, 'aria-label': tr('Чат курсором: сообщение видят все в файле') });
    this.el = h('div', { class: 'cursor-chat', hidden: true }, this.input);
    this.input.addEventListener('input', () => {
      this.clearLinger();
      this.restartIdle();
      this.set(this.input.value.trim() ? this.input.value : null);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close(false);
      }
    });
    // Clicking elsewhere: the message stays a little, as after Enter.
    this.input.addEventListener('blur', () => {
      if (!this.el.hidden) this.close(true);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Opens the bubble at a point of the canvas (screen px inside it), in this person's colour. */
  open(at: { x: number; y: number }, color: string): void {
    this.clearLinger();
    this.input.style.background = color;
    this.moveTo(at);
    this.el.hidden = false;
    this.input.value = '';
    this.set(null);
    this.input.focus();
    this.restartIdle();
  }

  moveTo(at: { x: number; y: number }): void {
    this.el.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }

  /** Closes the bubble: a sent message stays for the others a few seconds, a cancelled one goes at once. */
  close(keep: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const wasOpen = !this.el.hidden;
    this.el.hidden = true;
    if (wasOpen && document.activeElement === this.input) this.input.blur();
    if (keep && this.message) {
      this.clearLinger();
      this.lingerTimer = setTimeout(() => this.set(null), LINGER);
    } else {
      this.set(null);
    }
  }

  private set(text: string | null): void {
    const next = text ? text.slice(0, CHAT_LIMIT) : null;
    if (next === this.message) return;
    this.message = next;
    this.onMessage(next);
  }

  private clearLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private restartIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(true), IDLE);
  }
}
