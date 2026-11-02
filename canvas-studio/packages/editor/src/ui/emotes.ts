// Emotes and high fives (roadmap step 10), as in FigJam: Y opens a ring of
// reactions at one's pointer; the chosen one flies up from it for everyone in
// the file (the server passes it on and keeps nothing). ✋ near someone's pointer
// asks them for a high five — they see the request at your pointer; when they
// answer with ✋ near yours within five seconds, everyone sees «Пять!» between
// the two pointers.

import { tr } from '#core';
import type { Point } from '#geometry';
import type { Editor } from '../editor.ts';
import type { Emote, Peer, Presence } from '../live.ts';
import { h } from './dom.ts';

/** The emotes of the ring, in its order (the server takes only these). */
export const EMOTES = ['👍', '❤️', '😂', '🎉', '🔥', '👏', '😮', '✋'] as const;
export const HIGH_FIVE = '✋';
/** A high five asked is answered within this time. */
export const HIGH_FIVE_MS = 5000;
/** How near another pointer ✋ is aimed at that person (screen px). */
const AIM_PX = 90;

export interface EmotesHost {
  /** Sends an emote to the others; false — no live connection here. */
  send(emote: Emote): boolean;
  /** This person's id in the room. */
  self(): string | null;
  /** The others in the file, and where their pointers are. */
  peers(): readonly Peer[];
  presenceOf(id: string): Presence | undefined;
  /** This person's pointer (page coordinates), or null when it is off the canvas. */
  cursor(): Point | null;
  selfName(): string;
  selfColor(): string;
  toast(text: string): void;
}

/**
 * High fives seen in the room: who asked whom and when. A ✋ from A to B with an
 * earlier ✋ from B to A not older than five seconds makes a high five.
 */
export class HighFives {
  private readonly asked = new Map<string, number>();

  /** Records ✋ from `from` to `to`; true — it answers one asked by `to`, a high five. */
  record(from: string, to: string, now = Date.now()): boolean {
    for (const [key, at] of this.asked) if (now - at > HIGH_FIVE_MS) this.asked.delete(key);
    const back = this.asked.get(`${to}>${from}`);
    if (back !== undefined) {
      this.asked.delete(`${to}>${from}`);
      return true;
    }
    this.asked.set(`${from}>${to}`, now);
    return false;
  }
}

export class Emotes {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly host: EmotesHost;
  private readonly fives = new HighFives();
  private ring: HTMLElement | null = null;

  constructor(editor: Editor, host: EmotesHost) {
    this.editor = editor;
    this.host = host;
    this.el = h('div', { class: 'emote-layer', 'aria-hidden': 'true' });
  }

  get isOpen(): boolean {
    return this.ring !== null;
  }

  /** The ring of reactions around the pointer (or the middle of the screen). */
  open(): void {
    if (!this.host.self()) return void this.host.toast(tr('Эмоции работают в файлах на сервере, когда в них кто-то есть.'));
    this.close();
    const size = this.editor.screenSize;
    const cursor = this.host.cursor();
    const at = cursor ? this.editor.viewport.worldToScreen(cursor) : { x: size.width / 2, y: size.height / 2 };
    const ring = h('div', { class: 'emote-ring', role: 'menu', 'aria-label': tr('Эмоции') });
    ring.style.left = `${Math.min(Math.max(at.x, 90), size.width - 90)}px`;
    ring.style.top = `${Math.min(Math.max(at.y, 90), size.height - 90)}px`;
    EMOTES.forEach((emoji, i) => {
      const angle = (i / EMOTES.length) * Math.PI * 2 - Math.PI / 2;
      const b = h('button', { class: `emote-option${emoji === HIGH_FIVE ? ' high-five' : ''}`, type: 'button', role: 'menuitem', title: emoji === HIGH_FIVE ? tr('Дай пять: наведите на курсор коллеги ({0})', i + 1) : `${emoji} (${i + 1})` }, emoji);
      b.style.transform = `translate(${Math.cos(angle) * 62}px, ${Math.sin(angle) * 62}px)`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.send(emoji);
        this.close();
      });
      ring.append(b);
    });
    ring.append(h('span', { class: 'emote-hint' }, tr('1–8 или щелчок · Esc')));
    const key = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= EMOTES.length) {
        e.preventDefault();
        e.stopPropagation();
        this.send(EMOTES[n - 1]!);
        this.close();
      } else if (e.key === 'Escape' || e.key === 'y' || e.key === 'Y' || e.key === 'н' || e.key === 'Н') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    const outside = (e: PointerEvent) => {
      if (!ring.contains(e.target as Node)) this.close();
    };
    // After this key press is over: the Y that opened the ring must not close it at once.
    const listen = setTimeout(() => {
      document.addEventListener('keydown', key, true);
      document.addEventListener('pointerdown', outside, true);
    }, 0);
    this.ring = ring;
    (ring as HTMLElement & { cleanup?: () => void }).cleanup = () => {
      clearTimeout(listen);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
    };
    this.el.append(ring);
  }

  close(): void {
    if (!this.ring) return;
    (this.ring as HTMLElement & { cleanup?: () => void }).cleanup?.();
    this.ring.remove();
    this.ring = null;
  }

  /** The person nearest to this pointer, near enough to be aimed at (for ✋). */
  private aimedAt(at: Point): string | null {
    const vp = this.editor.viewport;
    const me = vp.worldToScreen(at);
    let best: { id: string; d: number } | null = null;
    for (const p of this.host.peers()) {
      const pr = this.host.presenceOf(p.id);
      if (!pr?.cursor || pr.page !== this.editor.pageId) continue;
      const s = vp.worldToScreen(pr.cursor);
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      if (d <= AIM_PX && (!best || d < best.d)) best = { id: p.id, d };
    }
    return best?.id ?? null;
  }

  send(emoji: string): void {
    const self = this.host.self();
    if (!self) return;
    const size = this.editor.screenSize;
    const at = this.host.cursor() ?? this.editor.viewport.screenToWorld({ x: size.width / 2, y: size.height / 2 });
    const to = emoji === HIGH_FIVE ? this.aimedAt(at) : null;
    const emote: Emote = { emoji, x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10, page: this.editor.pageId as string, to };
    if (!this.host.send(emote)) return;
    this.show(self, emote, this.host.selfColor());
    if (emoji === HIGH_FIVE && !to) this.host.toast(tr('Чтобы дать пять, наведите курсор на курсор коллеги и снова нажмите Y → ✋'));
  }

  /** An emote from someone (or oneself): flies up; a high five asked or given shows as such. */
  receive(from: string, emote: Emote): void {
    const peer = this.host.peers().find((p) => p.id === from);
    this.show(from, emote, peer?.color ?? '#4f5bd5', peer?.name);
  }

  private show(from: string, emote: Emote, color: string, name?: string): void {
    if (emote.page !== this.editor.pageId) return;
    const at = this.editor.viewport.worldToScreen({ x: emote.x, y: emote.y });
    this.fly(emote.emoji, at);
    if (emote.emoji !== HIGH_FIVE || !emote.to) return;
    const self = this.host.self();
    if (this.fives.record(from, emote.to)) {
      // Both gave five: «Пять!» between the two pointers, for everyone.
      const other = from === self ? null : this.host.presenceOf(from)?.cursor;
      const target = emote.to === self ? this.host.cursor() : this.host.presenceOf(emote.to)?.cursor;
      const b = target ? this.editor.viewport.worldToScreen(target) : at;
      const a = other ? this.editor.viewport.worldToScreen(other) : at;
      this.burst({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return;
    }
    if (emote.to === self) {
      // Asked for a high five: a bubble at their pointer, answered by ✋ near it.
      const bubble = h('div', { class: 'emote-ask', style: { left: `${at.x}px`, top: `${at.y}px`, background: color } }, tr('{0} даёт пять — Y → ✋ у курсора', name ?? tr('Коллега')));
      this.el.append(bubble);
      setTimeout(() => bubble.remove(), HIGH_FIVE_MS);
    }
  }

  private fly(emoji: string, at: Point): void {
    const el = h('div', { class: 'emote-fly', style: { left: `${at.x}px`, top: `${at.y}px` } }, emoji);
    // A little to the side each time, so several in a row do not cover each other.
    el.style.setProperty('--drift', `${Math.round(Math.random() * 40 - 20)}px`);
    this.el.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  private burst(at: Point): void {
    const el = h('div', { class: 'emote-burst', style: { left: `${at.x}px`, top: `${at.y}px` } }, h('span', { class: 'emote-burst-hands' }, '✋👏✋'), h('span', { class: 'emote-burst-text' }, tr('Пять!')));
    this.el.append(el);
    setTimeout(() => el.remove(), 2200);
  }
}

