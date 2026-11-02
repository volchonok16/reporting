// Running a session on a board (FEAT-086): the shared timer and the vote, in
// the top bar. Both live in the document (outside the undo history), so
// everyone in the file sees the same countdown and the same vote.

import { tr, type BoardTimer, type NodeId } from '#core';
import { clearVotes, objectLabel, setBoardState, usedVotes, votesOf } from '../board.ts';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

const TIMER_PRESETS = [1, 3, 5, 10, 15];
const VOTE_PRESETS = [3, 5, 10];

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** A small menu under a button; closes on a click outside or Esc. */
function popover(anchor: HTMLElement, content: HTMLElement[], onClose: () => void): () => void {
  document.querySelector('.bs-pop')?.remove();
  const el = h('div', { class: 'bs-pop', role: 'dialog' }, ...content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth))}px`;
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    onClose();
  };
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  return close;
}

export class BoardSession {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly toast: (text: string) => void;
  private readonly timerButton: HTMLButtonElement;
  private readonly voteButton: HTMLButtonElement;
  private readonly sectionsButton: HTMLButtonElement;
  private tick = 0;
  /** Timers whose end was already announced here (one chime per run). */
  private readonly rang = new Set<string>();
  private closePop: (() => void) | null = null;
  private popFor: 'timer' | 'vote' | 'sections' | null = null;
  /** Shows the objects with the most votes: set by the app (zooms to them). */
  show: (id: NodeId) => void = () => {};

  constructor(editor: Editor, toast: (text: string) => void) {
    this.editor = editor;
    this.toast = toast;
    this.timerButton = h('button', { class: 'bs-button bs-timer', type: 'button' });
    this.voteButton = h('button', { class: 'bs-button bs-vote', type: 'button' });
    this.timerButton.addEventListener('click', () => this.toggle('timer'));
    this.voteButton.addEventListener('click', () => this.toggle('vote'));
    this.sectionsButton = h('button', { class: 'bs-button bs-sections', type: 'button', title: tr('Разделы доски: перейти к разделу') }, icon('section', 14), h('span', {}, tr('Разделы')));
    this.sectionsButton.addEventListener('click', () => this.toggle('sections'));
    this.el = h('div', { class: 'board-session' }, this.sectionsButton, this.timerButton, this.voteButton);
    editor.events.on('change', ({ changes }) => {
      if (changes.updated.has(editor.doc.rootId) || changes.structural) this.render();
    });
    editor.events.on('document', () => this.render());
    this.render();
  }

  private get timer(): BoardTimer | null {
    return this.editor.doc.get(this.editor.doc.rootId, 'boardTimer');
  }

  private left(t: BoardTimer): number {
    return t.endsAt !== null ? Math.max(0, t.endsAt - Date.now()) : t.left;
  }

  /** Opens (or closes) the list of sections. */
  toggleSections(): void {
    this.toggle('sections');
  }

  private toggle(which: 'timer' | 'vote' | 'sections'): void {
    if (this.closePop && this.popFor === which) {
      this.closePop();
      this.closePop = null;
      return;
    }
    this.closePop?.();
    this.popFor = which;
    const anchor = which === 'timer' ? this.timerButton : which === 'vote' ? this.voteButton : this.sectionsButton;
    this.closePop = popover(anchor, which === 'timer' ? this.timerMenu() : which === 'vote' ? this.voteMenu() : this.sectionsMenu(), () => {
      this.closePop = null;
      this.popFor = null;
    });
  }

  private refreshPop(): void {
    if (!this.closePop || !this.popFor) return;
    const which = this.popFor;
    this.closePop();
    this.toggle(which);
  }

  private render(): void {
    this.renderTimer();
    this.renderVote();
    // Someone else changed the timer or the vote: an open menu shows the new state.
    if (this.popFor) this.refreshPopSoon();
  }

  /** The timer's button; ticks four times a second while it runs. */
  private renderTimer(): void {
    const readOnly = this.editor.doc.readOnly;
    const t = this.timer;
    clearInterval(this.tick);
    if (t) {
      const left = this.left(t);
      const running = t.endsAt !== null && left > 0;
      this.timerButton.replaceChildren(icon('clock', 14), h('span', { class: 'bs-time' }, left === 0 ? tr('Время вышло') : mmss(left)), t.endsAt === null && left > 0 ? h('span', { class: 'bs-paused' }, tr('пауза')) : '');
      this.timerButton.classList.toggle('alert', left === 0 || (running && left <= 10_000));
      this.timerButton.title = tr('Таймер для всех в файле');
      if (running) this.tick = window.setInterval(() => this.renderTimer(), 250);
      if (left === 0 && t.endsAt !== null && !this.rang.has(`${t.id}:${t.endsAt}`)) {
        this.rang.add(`${t.id}:${t.endsAt}`);
        // Only for a timer that ran out while the file was open (not for one found finished).
        if (Date.now() - t.endsAt < 5000) {
          chime();
          this.toast(tr('Время вышло'));
        }
      }
    } else {
      this.timerButton.replaceChildren(icon('clock', 14), h('span', {}, tr('Таймер')));
      this.timerButton.classList.remove('alert');
      this.timerButton.title = tr('Таймер для всех в файле: 1–15 минут');
    }
    this.timerButton.hidden = readOnly && !t;
  }

  private renderVote(): void {
    const d = this.editor.doc;
    const readOnly = d.readOnly;
    const v = d.get(d.rootId, 'boardVoting');
    if (v?.open) {
      const left = v.perPerson - usedVotes(d, v.id, this.editor.boardPrefs.voter);
      this.voteButton.replaceChildren(icon('stamp', 14), h('span', {}, readOnly ? tr('Идёт голосование') : tr('Голосов: {0} из {1}', left, v.perPerson)));
      this.voteButton.classList.add('on');
    } else if (v) {
      this.voteButton.replaceChildren(icon('stamp', 14), h('span', {}, tr('Итоги голосования')));
      this.voteButton.classList.add('on');
    } else {
      this.voteButton.replaceChildren(icon('stamp', 14), h('span', {}, tr('Голосование')));
      this.voteButton.classList.remove('on');
    }
    this.voteButton.hidden = readOnly && !v;
  }

  private popTimer = 0;
  private refreshPopSoon(): void {
    if (this.popTimer) return;
    this.popTimer = window.setTimeout(() => {
      this.popTimer = 0;
      this.refreshPop();
    }, 0);
  }

  private timerMenu(): HTMLElement[] {
    const t = this.timer;
    const set = (value: BoardTimer | null) => {
      setBoardState(this.editor, 'boardTimer', value);
      this.refreshPop();
    };
    if (this.editor.doc.readOnly) return [h('p', { class: 'bs-hint' }, tr('Таймер запускают участники, которые могут редактировать.'))];
    const start = (min: number) => set({ id: newId(), total: min * 60_000, endsAt: Date.now() + min * 60_000, left: min * 60_000 });
    const presets = h('div', { class: 'bs-row' }, ...TIMER_PRESETS.map((m) => h('button', { class: 'bs-chip', type: 'button', onclick: () => start(m) }, tr('{0} мин', m))));
    if (!t) return [h('div', { class: 'bs-title' }, tr('Таймер для всех в файле')), presets, h('p', { class: 'bs-hint' }, tr('Обратный отсчёт видят все, кто открыл доску; в конце — звук.'))];
    const left = this.left(t);
    const running = t.endsAt !== null && left > 0;
    // Read the timer again at the click: the menu may have been open for a while (or someone changed it).
    const now = () => {
      const cur = this.timer;
      return cur ? { cur, left: this.left(cur) } : null;
    };
    const pause = () => {
      const n = now();
      if (!n) return;
      set(n.cur.endsAt !== null ? { ...n.cur, endsAt: null, left: n.left } : { ...n.cur, endsAt: Date.now() + n.left });
    };
    const more = () => {
      const n = now();
      if (!n) return;
      set(n.cur.endsAt !== null && n.left > 0 ? { ...n.cur, endsAt: n.cur.endsAt + 60_000 } : n.cur.endsAt === null && n.left > 0 ? { ...n.cur, left: n.left + 60_000 } : { ...n.cur, id: newId(), endsAt: Date.now() + 60_000, left: 60_000 });
    };
    const actions = h(
      'div',
      { class: 'bs-row' },
      left > 0 ? h('button', { class: 'bs-chip', type: 'button', onclick: pause }, running ? tr('Пауза') : tr('Продолжить')) : null,
      h('button', { class: 'bs-chip', type: 'button', onclick: more }, tr('+1 мин')),
      h('button', { class: 'bs-chip', type: 'button', onclick: () => set(null) }, tr('Сбросить')),
    );
    return [h('div', { class: 'bs-title' }, tr('Таймер: {0}', mmss(left))), actions, h('div', { class: 'bs-sub' }, tr('Заново')), presets];
  }

  /** The board's sections in reading order (nested ones under theirs), each a jump to it. */
  private sectionsMenu(): HTMLElement[] {
    const e = this.editor;
    const d = e.doc;
    const rows: HTMLElement[] = [];
    const walk = (parent: NodeId, depth: number) => {
      const sections = d.children(parent).filter((id) => d.type(id) === 'SECTION');
      // Rows by top, then left — as one reads the board.
      sections.sort((a, b) => {
        const ay = d.get(a, 'y');
        const by = d.get(b, 'y');
        return Math.abs(ay - by) > 40 ? ay - by : d.get(a, 'x') - d.get(b, 'x');
      });
      for (const id of sections) {
        const inside = d.children(id).filter((c) => d.type(c) !== 'SECTION').length;
        const name = d.get(id, 'name').trim() || tr('Раздел без названия');
        rows.push(h('li', {}, h('button', { class: 'bs-result', type: 'button', style: { paddingLeft: `${6 + depth * 16}px` }, onclick: () => {
          this.closePop?.();
          this.show(id);
        } }, h('span', { class: 'bs-label' }, name), h('span', { class: 'bs-muted' }, String(inside)))));
        walk(id, depth + 1);
      }
    };
    walk(e.pageId, 0);
    if (rows.length === 0) return [h('div', { class: 'bs-title' }, tr('Разделы')), h('p', { class: 'bs-hint' }, tr('Разделов пока нет. Shift+S — нарисуйте раздел рамкой на доске.'))];
    return [h('div', { class: 'bs-title' }, tr('Разделы')), h('ol', { class: 'bs-results' }, ...rows)];
  }

  private voteMenu(): HTMLElement[] {
    const e = this.editor;
    const d = e.doc;
    const v = d.get(d.rootId, 'boardVoting');
    if (!v) {
      if (d.readOnly) return [h('p', { class: 'bs-hint' }, tr('Голосование начинают участники, которые могут редактировать.'))];
      return [
        h('div', { class: 'bs-title' }, tr('Голосование')),
        h('p', { class: 'bs-hint' }, tr('У каждого — несколько голосов: щелчок по стикеру или фигуре ставит голос, Alt+щелчок — убирает. Чужих голосов не видно до конца.')),
        h('div', { class: 'bs-sub' }, tr('Голосов у каждого')),
        h('div', { class: 'bs-row' }, ...VOTE_PRESETS.map((n) => h('button', { class: 'bs-chip', type: 'button', onclick: () => {
          setBoardState(e, 'boardVoting', { id: newId(), perPerson: n, by: e.boardPrefs.voter, open: true });
          e.setTool('select');
          this.refreshPop();
        } }, String(n)))),
      ];
    }
    const votes = [...votesOf(d, v.id, e.boardPrefs.voter).entries()].filter(([id]) => d.store.isAlive(id));
    if (v.open) {
      const left = v.perPerson - usedVotes(d, v.id, e.boardPrefs.voter);
      const voters = new Set<string>();
      for (const r of d.store.allRecords()) if (r.props.board?.kind === 'VOTE' && r.props.board.session === v.id && d.store.isAlive(r.id)) voters.add(r.props.board.voter);
      return [
        h('div', { class: 'bs-title' }, tr('Идёт голосование')),
        h('p', { class: 'bs-hint' }, d.readOnly ? tr('Голосуют участники, которые могут редактировать.') : tr('У вас осталось голосов: {0} из {1}. Щелчок по стикеру или фигуре — голос, Alt+щелчок — убрать.', left, v.perPerson)),
        h('p', { class: 'bs-hint' }, tr('Проголосовали: {0}', voters.size)),
        d.readOnly ? h('span') : h('div', { class: 'bs-row' }, h('button', { class: 'bs-chip primary', type: 'button', onclick: () => {
          setBoardState(e, 'boardVoting', { ...v, open: false });
          this.refreshPop();
        } }, tr('Закончить и показать итоги'))),
      ];
    }
    votes.sort((a, b) => b[1].total - a[1].total);
    const list = votes.length
      ? h('ol', { class: 'bs-results' }, ...votes.slice(0, 10).map(([id, n]) => {
          const li = h('li', {}, h('button', { class: 'bs-result', type: 'button', onclick: () => this.show(id) }, h('span', { class: 'bs-count' }, String(n.total)), h('span', { class: 'bs-label' }, objectLabel(d, id))));
          return li;
        }))
      : h('p', { class: 'bs-hint' }, tr('Голосов нет.'));
    return [
      h('div', { class: 'bs-title' }, tr('Итоги голосования')),
      list,
      d.readOnly
        ? h('span')
        : h(
            'div',
            { class: 'bs-row' },
            h('button', { class: 'bs-chip', type: 'button', onclick: () => {
              clearVotes(e, v.id);
              this.refreshPop();
            } }, tr('Убрать голоса')),
          ),
    ];
  }
}

/** A short two-note chime (no file needed). */
function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t0 = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.55);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    // no sound: the toast says it
  }
}
