// Speaker's notes under the slide (FEAT-166), as in Figma Slides: a rounded card at
// the bottom of the canvas in the «Слайд» view, as wide as the slide and under it,
// with the notes of the slide on show. The slide is fitted above the card and the
// tools. A tab on the card's top edge drags its height; dragged down to the end (or
// clicked) the card hides whole and only the tab stays, over the tools, to pull it
// back up. Both are remembered. The notes are seen only by the speaker — in the
// presenter's window during the show.

import { tr, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { slideInfo } from '../slides.ts';
import { h, sparkles } from './dom.ts';

const KEY = 'cs.slides.notes';
const MIN_H = 64;
/** Dragged lower than this, the card hides, px. */
const HIDE_AT = 40;
/** The tab left of a hidden card, px. */
const TAB_W = 72;
const TAB_H = 16;
/** Room under the card and between it, the tools and the slide, px. */
const GAP = 12;
/** Where the tools stand without the card (their own bottom in the styles), and the tab's gap above them. */
const DOCK_BOTTOM = 16;
const TAB_GAP = 6;
/** The card is never narrower than this, even under a narrow slide (9:16), px. */
const MIN_W = 360;

interface Saved {
  open: boolean;
  height: number;
}

function saved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    return { open: v?.open ?? true, height: Math.max(MIN_H, Number(v?.height) || 120) };
  } catch {
    return { open: true, height: 120 };
  }
}

export class SlideNotesBar {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly area: HTMLElement;
  private readonly text: HTMLTextAreaElement;
  private readonly tab: HTMLElement;
  /** ✦ — the model writes the notes by the slide's texts (or completes those there are). */
  private readonly magic: HTMLButtonElement;
  private readonly state = saved();
  private slide: NodeId | null = null;
  private shown = false;
  private timer = 0;
  private readonly current: () => NodeId | null;

  /** `area` — the canvas area: the bar's height is set on it, so the canvas ends above the bar. */
  constructor(editor: Editor, area: HTMLElement, current: () => NodeId | null) {
    this.editor = editor;
    this.area = area;
    this.current = current;
    this.text = h('textarea', {
      class: 'sn-text',
      placeholder: tr('Заметки докладчика: что сказать на этом слайде. Видны только вам — в окне докладчика при показе'),
      'aria-label': tr('Заметки докладчика'),
      spellcheck: true,
    }) as HTMLTextAreaElement;
    // Typing is one step a pause: not a step per letter.
    this.text.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.save(), 700);
    });
    this.text.addEventListener('blur', () => this.save());
    // Keys go to the text, not to the canvas shortcuts; Esc leaves it.
    this.text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.text.blur();
    });
    // The tab: dragged — the height (down to the end hides the card); clicked — hides or shows it.
    this.tab = h('div', {
      class: 'sn-tab',
      role: 'separator',
      'aria-orientation': 'horizontal',
      tabindex: 0,
    });
    this.tab.addEventListener('pointerdown', (e) => this.dragHeight(e));
    this.tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.setOpen(!this.state.open);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const up = e.key === 'ArrowUp';
        if (!this.state.open) {
          if (up) this.setOpen(true);
        } else if (!up && this.state.height <= MIN_H) this.setOpen(false);
        else {
          this.state.height = Math.min(this.maxHeight(), Math.max(MIN_H, this.state.height + (up ? 16 : -16)));
          this.remember();
          this.layout();
        }
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.magic = h('button', { class: 'icon-button sn-magic', type: 'button', title: tr('Написать заметку нейросетью'), 'aria-label': tr('Написать заметку нейросетью'), onclick: () => void this.writeNotes() }, sparkles(20)) as HTMLButtonElement;
    // While the model writes: lines of a note drawing themselves over the field, as the layout preview does.
    const line = (width: number) => h('div', { class: 'hi-sk sn-sk-line', style: { width: `${width}%` } });
    const waiting = h('div', { class: 'sn-waiting', 'aria-hidden': 'true' }, h('div', { class: 'sn-waiting-caption' }, sparkles(14), tr('Нейросеть пишет заметку…')), line(92), line(84), line(96), line(60));
    this.el = h('section', { class: 'slide-notes-bar', 'aria-label': tr('Заметки докладчика') }, this.tab, this.text, waiting, this.magic);
    editor.events.on('change', ({ changes }) => {
      if (this.slide && changes.updated.get(this.slide)?.has('slide') && document.activeElement !== this.text) this.load();
      if (this.slide && !editor.doc.store.isAlive(this.slide)) this.refresh();
    });
    editor.events.on('document', () => this.refresh());
    // The card follows the slide on the screen: its left edge and width.
    editor.events.on('viewport', () => this.place());
  }

  /** Shown in the «Слайд» view only; follows the slide on show. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.refresh();
  }

  /** The slide on show may have changed: its notes come in (what was typed is kept first). */
  refresh(): void {
    const next = this.shown ? this.current() : null;
    if (next !== this.slide) {
      this.save();
      this.slide = next;
      this.load();
    }
    this.layout();
  }

  private load(): void {
    const d = this.editor.doc;
    this.text.value = this.slide && d.store.isAlive(this.slide) ? slideInfo(d, this.slide).notes : '';
    this.text.disabled = d.readOnly || !this.slide;
    this.magic.hidden = d.readOnly || !this.slide;
    this.drawTab();
  }

  private async writeNotes(): Promise<void> {
    const slide = this.slide;
    if (!slide || this.magic.disabled) return;
    this.save();
    this.magic.disabled = true;
    this.el.classList.add('sn-busy');
    this.el.setAttribute('aria-busy', 'true');
    try {
      const { writeNotes } = await import('../ai-text.ts');
      const notes = await writeNotes(this.editor, slide, this.text.value);
      if (this.slide === slide) {
        this.text.value = notes;
        this.drawTab();
      }
    } catch (error) {
      this.editor.toast(error instanceof Error ? error.message : String(error));
    } finally {
      this.magic.disabled = false;
      this.el.classList.remove('sn-busy');
      this.el.removeAttribute('aria-busy');
    }
  }

  private save(): void {
    clearTimeout(this.timer);
    const d = this.editor.doc;
    const slide = this.slide;
    if (!slide || d.readOnly || !d.store.isAlive(slide)) return;
    const info = slideInfo(d, slide);
    if (this.text.value === info.notes) return;
    this.editor.commit(tr('Заметки слайда'), (tx) => tx.set(slide, 'slide', { ...info, notes: this.text.value }));
    this.drawTab();
  }

  private drawTab(): void {
    const has = this.text.value.trim().length > 0;
    this.el.classList.toggle('has-notes', has);
    this.tab.title = this.state.open
      ? tr('Заметки докладчика: потяните, чтобы изменить высоту, вниз до конца или щелчок — скрыть')
      : has
        ? tr('Заметки докладчика (есть): потяните вверх или щёлкните, чтобы открыть')
        : tr('Заметки докладчика: потяните вверх или щёлкните, чтобы открыть');
    this.tab.setAttribute('aria-label', this.tab.title);
    this.tab.setAttribute('aria-expanded', String(this.state.open));
    this.magic.title = has ? tr('Дополнить заметки по слайду — нейросеть') : tr('Написать заметки по слайду — нейросеть');
    this.magic.setAttribute('aria-label', this.magic.title);
  }

  private setOpen(open: boolean): void {
    this.state.open = open;
    this.remember();
    this.layout();
    if (open) this.text.focus();
  }

  private maxHeight(): number {
    return Math.max(MIN_H, Math.round(this.area.clientHeight * 0.6));
  }

  private layout(): void {
    const on = this.shown && !!this.slide;
    const open = this.state.open;
    this.el.hidden = !on;
    this.area.classList.toggle('with-notes', on);
    // Open, the card lies at the bottom and the tools stand on it; hidden, the tools are in their
    // usual place and the tab stands on them (user's decision, 28 October: not at the very edge).
    const dock = (this.area.querySelector('.tool-dock') as HTMLElement | null)?.offsetHeight ?? 48;
    const height = open ? this.state.height : TAB_H;
    const under = open ? GAP + height + GAP : DOCK_BOTTOM;
    const tabBottom = DOCK_BOTTOM + dock + TAB_GAP;
    this.area.style.setProperty('--notes-h', `${on ? height : 0}px`);
    this.area.style.setProperty('--notes-dock', `${under}px`);
    this.el.style.bottom = open ? '' : `${tabBottom}px`;
    this.el.classList.toggle('folded', !open);
    this.text.hidden = !open;
    this.drawTab();
    // The slide keeps GAP clear of the tools on the card (of the tab on the tools); a whole slide stays whole.
    // The view's own padding round the slide counts towards it.
    const pad = (this.editor.constructor as typeof Editor).STAGE_PADDING;
    const inset = on ? Math.max(0, (open ? under + dock : tabBottom + TAB_H) + GAP - pad) : 0;
    if (inset !== this.editor.stageInset) {
      const whole = this.editor.stageFitted();
      this.editor.stageInset = inset;
      if (whole) this.editor.fitStage();
      else this.editor.requestViewport();
    }
    this.place();
  }

  /** Puts the card under the slide on show, as wide as it is on the screen; a hidden one's tab under its middle. */
  private place(): void {
    if (this.el.hidden || !this.slide || !this.editor.doc.store.isAlive(this.slide)) return;
    const b = this.editor.scene.bounds(this.slide);
    const v = this.editor.viewport;
    const left = b.x * v.zoom + v.offsetX;
    const right = (b.x + b.width) * v.zoom + v.offsetX;
    const room = this.area.clientWidth;
    let width = this.state.open ? Math.max(MIN_W, right - left) : TAB_W;
    let x = (left + right) / 2 - width / 2;
    width = Math.min(width, room - 2 * 16);
    x = Math.max(16, Math.min(room - 16 - width, x));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.width = `${Math.round(width)}px`;
  }

  /** Drags the height by the tab; down to the end the card hides, up from a hidden one it comes out. A click toggles. */
  private dragHeight(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const tab = this.tab;
    tab.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = this.state.open ? this.state.height : 0;
    const wasOpen = this.state.open;
    const keep = this.state.height;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 3) return;
      moved = true;
      const want = startH + startY - ev.clientY;
      this.state.open = want >= HIDE_AT;
      // Hidden, the card keeps the height it had: it comes back to it on a click.
      this.state.height = this.state.open ? Math.round(Math.min(this.maxHeight(), Math.max(MIN_H, want))) : keep;
      this.layout();
    };
    const up = () => {
      tab.removeEventListener('pointermove', move);
      tab.removeEventListener('pointerup', up);
      tab.removeEventListener('pointercancel', up);
      if (!moved) this.setOpen(!wasOpen);
      else {
        this.remember();
        if (this.state.open && !wasOpen) this.text.focus();
      }
    };
    tab.addEventListener('pointermove', move);
    tab.addEventListener('pointerup', up);
    tab.addEventListener('pointercancel', up);
  }

  private remember(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // Not remembered — the next time it opens shown, 120 px high.
    }
  }
}
