// Following a collaborator (live editing, part 2, portion 3): the canvas shows
// what they see — their page, the centre of their screen and their zoom (fitted
// if this screen is smaller). A frame in their colour with their name runs
// around the canvas. Following ends when this person moves the view themselves
// (drag, wheel, click, a key), with Esc, or when the other person leaves.
// The same frame, in one's own colour, tells the author of a spotlight that
// everyone follows them.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import type { Peer, PeerView, Presence } from '../live.ts';
import { isTyping } from '../keyboard.ts';
import { h } from './dom.ts';

/** Where the followed view goes on this screen: the same centre, their zoom, fitted if this screen is smaller. */
export function followViewport(view: PeerView, screen: { width: number; height: number }): { zoom: number; offsetX: number; offsetY: number } {
  const fit = Math.min(1, screen.width / view.width, screen.height / view.height);
  const zoom = view.zoom * fit;
  return { zoom, offsetX: screen.width / 2 - view.x * zoom, offsetY: screen.height / 2 - view.y * zoom };
}

export class Following {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly label: HTMLElement;
  private readonly text: HTMLElement;
  private readonly stopButton: HTMLButtonElement;
  /** Whom this person follows. */
  private target: Peer | null = null;
  /** This person is in the spotlight (everyone follows them). */
  private presenting: { color: string } | null = null;
  /** The view is being moved by following, not by this person. */
  private applying = false;
  /** Called when following starts or stops (the avatars show who is followed). */
  onChange: (id: string | null) => void = () => {};
  /** "Stop" in the frame while in the spotlight; set by the app. */
  onStopSpotlight: () => void = () => {};

  constructor(editor: Editor, canvas: HTMLElement) {
    this.editor = editor;
    this.text = h('span', {});
    this.stopButton = h('button', { class: 'follow-stop', type: 'button', onclick: () => (this.presenting ? this.onStopSpotlight() : this.stop()) }, tr('Остановить'));
    this.label = h('div', { class: 'follow-label' }, this.text, this.stopButton);
    this.el = h('div', { class: 'follow-frame', hidden: true }, this.label);
    // This person moves the view: following is over.
    const own = () => {
      if (this.target && !this.applying) this.stop();
    };
    canvas.addEventListener('pointerdown', own, true);
    canvas.addEventListener('wheel', own, { capture: true, passive: true });
    window.addEventListener('keydown', (e) => {
      if (!this.target || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      // Cursor chat and other fields do not move the view.
      if (e.code === 'Slash' || isTyping(e.target)) return;
      if (e.key === 'Escape') e.preventDefault();
      this.stop();
    }, true);
    // Another page chosen in the page list.
    editor.events.on('page', own);
  }

  get following(): string | null {
    return this.target?.id ?? null;
  }

  follow(peer: Peer, presence: Presence | undefined): void {
    this.target = peer;
    this.render();
    this.onChange(peer.id);
    if (presence) this.update(peer.id, presence);
  }

  stop(): void {
    if (!this.target) return;
    this.target = null;
    this.render();
    this.onChange(null);
  }

  /** The followed person moved: show what they see. */
  update(from: string, presence: Presence): void {
    if (this.target?.id !== from) return;
    const editor = this.editor;
    this.applying = true;
    try {
      if (presence.page && presence.page !== editor.pageId && editor.doc.store.isAlive(presence.page)) editor.setPage(presence.page);
      if (presence.view) {
        editor.viewport.restore(followViewport(presence.view, editor.screenSize));
        editor.requestViewport();
      }
    } finally {
      this.applying = false;
    }
  }

  /** The list of people changed: the followed one may have left or changed colour. */
  setPeers(peers: Peer[]): Peer | null {
    if (!this.target) return null;
    const now = peers.find((p) => p.id === this.target!.id);
    if (!now) {
      const gone = this.target;
      this.stop();
      return gone;
    }
    this.target = now;
    this.render();
    return null;
  }

  /** This person is (or no longer is) in the spotlight. */
  setPresenting(presenting: { color: string } | null): void {
    this.presenting = presenting;
    this.render();
  }

  private render(): void {
    const color = this.target?.color ?? this.presenting?.color ?? '';
    this.el.hidden = !this.target && !this.presenting;
    this.el.style.borderColor = color;
    this.label.style.background = color;
    this.text.textContent = this.target ? tr('Вы наблюдаете за: {0}', this.target.name) : tr('Все наблюдают за вами');
    this.stopButton.title = this.target ? tr('Перестать наблюдать (Esc)') : tr('Закончить спотлайт');
  }
}
