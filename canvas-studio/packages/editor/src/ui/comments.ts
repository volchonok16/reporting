// Comments (stage 8, part 4): discussions pinned to the canvas. The "C" tool
// drops a pin where one clicks — on the top-level frame under the pointer (the
// pin then moves with it) or on the page — and opens a box for the first
// comment. A pin opens its discussion: replies, "Resolved", editing and
// deleting one's own comments. The "Comments" tab on the left lists every
// discussion of the file with a filter and takes you to it.
// Discussions are kept by the server, not in the document: they arrive with
// the file and every change reaches everyone in the file at once.
// "@" in a box lists the people of the file; those called get a letter
// (the server decides who else is told) and are highlighted in the text.

import { locale, plural, tr } from '#core';
import { boardObjectOf } from '../board.ts';
import type { Point } from '#geometry';
import { comments as api, CloudError, type CommentItem, type CommentPlace, type CommentThread, type Person, type ThreadChange } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import type { Role } from '../storage.ts';
import { askConfirm } from './dialog.ts';
import { clear, h, icon } from './dom.ts';

export interface CommentsHost {
  /** The open file on the server, or null (comments need the server). */
  fileId(): string | null;
  role(): Role;
  userId(): string | null;
  toast(text: string, kind?: 'error'): void;
}

type Filter = 'open' | 'resolved' | 'all';

/** Pins are drawn with their tail at the point: the bubble sits above and to the right. */
const PIN = 28;

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** The "@word" being typed right before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** People whose "@Name" is in the text ("@Оля Петрова" calls her, not another "Оля"). */
export function mentionedIn(text: string, people: readonly Person[]): string[] {
  const called = new Set(
    splitMentions(
      text,
      people.map((p) => p.name),
    )
      .filter((part) => part.mention)
      .map((part) => part.text.slice(1)),
  );
  return people.filter((p) => called.has(p.name)).map((p) => p.id);
}

/** The text split into plain parts and "@Name" of the people called (longer names first). */
export function splitMentions(text: string, names: readonly string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: { text: string; mention: boolean }[] = [];
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const name = text[i] === '@' ? sorted.find((n) => text.startsWith(n, i + 1)) : undefined;
    if (name) {
      if (plain) out.push({ text: plain, mention: false });
      plain = '';
      out.push({ text: `@${name}`, mention: true });
      i += name.length + 1;
    } else plain += text[i++];
  }
  if (plain) out.push({ text: plain, mention: false });
  return out;
}

/** "just now", "5 minutes ago", "yesterday", then the date. */
export function when(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return tr('только что');
  const rel = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (minutes < 60) return rel.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rel.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 7) return rel.format(-days, 'day');
  return new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export class Comments {
  /** Pins and the open discussion, over the canvas. */
  readonly overlay: HTMLElement;
  /** The "Comments" tab of the left panel. */
  readonly panel: HTMLElement;
  private readonly editor: Editor;
  private readonly host: CommentsHost;
  private threads = new Map<string, CommentThread>();
  private filter: Filter = 'open';
  private panelVisible = false;
  /** The discussion shown in the popover. */
  private openId: string | null = null;
  /** A new discussion being written: where, and its text. */
  private draft: { place: CommentPlace; text: string } | null = null;
  /** Comment being edited in the open discussion. */
  private editing: string | null = null;
  /** Reply being typed (kept across re-renders). */
  private reply = '';
  private loadedFor: string | null = null;
  /** People of the file for "@" (loaded when first needed). */
  private people: Person[] | null = null;
  private peopleLoading: Promise<Person[]> | null = null;
  /** A discussion to open once the list arrives (a link from a letter). */
  private pendingShow: string | null = null;
  private frame = 0;
  private busy = false;
  private readonly list: HTMLElement;
  private readonly filterSelect: HTMLSelectElement;
  /** A pin being dragged to a new place. */
  private drag: { id: string; start: Point; at: Point; moved: boolean } | null = null;

  constructor(editor: Editor, host: CommentsHost) {
    this.editor = editor;
    this.host = host;
    this.overlay = h('div', { class: 'comment-overlay' });
    for (const event of ['viewport', 'change', 'page', 'tool'] as const) editor.events.on(event, () => this.request());
    this.filterSelect = h(
      'select',
      { class: 'field-select comments-filter', 'aria-label': tr('Какие обсуждения показывать') },
      h('option', { value: 'open' }, tr('Открытые')),
      h('option', { value: 'resolved' }, tr('Решённые')),
      h('option', { value: 'all' }, tr('Все')),
    );
    this.filterSelect.addEventListener('change', () => {
      this.filter = this.filterSelect.value as Filter;
      this.request();
    });
    this.list = h('div', { class: 'comments-list', role: 'list' });
    const add = h('button', { class: 'icon-button', type: 'button', title: tr('Новый комментарий (C)'), onclick: () => editor.setTool('comment') }, icon('comment'));
    this.panel = h('div', { class: 'comments-panel' }, h('div', { class: 'comments-bar' }, h('div', { class: 'select-wrap' }, this.filterSelect), add), this.list);
    // Esc closes the open discussion before anything else; a click on the canvas closes it too.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || (!this.openId && !this.draft)) return;
        e.stopPropagation();
        this.close();
      },
      true,
    );
  }

  /** The canvas element the overlay sits in: clicks on it close the popover. */
  attach(canvas: HTMLElement): void {
    canvas.append(this.overlay);
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (this.overlay.contains(e.target as Node)) return;
        if ((this.openId || this.draft) && this.editor.tool !== 'comment') this.close();
      },
      true,
    );
  }

  /** Draws again (the role changed: replying and resolving may be allowed now, or not). */
  refresh(): void {
    this.request();
  }

  /**
   * Pins on the canvas with any tool (as in Figma); Shift+C hides them and
   * brings them back — remembered in this browser.
   */
  private pinsHidden = (() => {
    try {
      return localStorage.getItem('cs-comments-hidden') === '1';
    } catch {
      return false;
    }
  })();

  togglePins(): boolean {
    this.pinsHidden = !this.pinsHidden;
    try {
      localStorage.setItem('cs-comments-hidden', this.pinsHidden ? '1' : '0');
    } catch {
      // for this visit only
    }
    this.request();
    return !this.pinsHidden;
  }

  setPanelVisible(visible: boolean): void {
    this.panelVisible = visible;
    this.request();
  }

  // ---------- data ----------

  /** Loads the discussions of the open file (again after a reconnect: changes may have been missed). */
  async load(): Promise<void> {
    const id = this.host.fileId();
    if (id !== this.loadedFor) {
      this.threads.clear();
      this.openId = null;
      this.draft = null;
      this.loadedFor = id;
      this.people = null;
      this.peopleLoading = null;
    }
    if (!id) return this.request();
    try {
      const list = await api.list(id);
      if (this.host.fileId() !== id) return;
      this.threads = new Map(list.map((t) => [t.id, t]));
      if (this.openId && !this.threads.has(this.openId)) this.openId = null;
      const pending = this.pendingShow;
      this.pendingShow = null;
      if (pending && this.threads.has(pending)) requestAnimationFrame(() => this.show(pending));
      else if (pending) this.host.toast(tr('Обсуждение не найдено: его удалили.'));
    } catch {
      // No comments shown; the file itself still works.
    }
    this.request();
  }

  /** A change from the server (an answer to one's own request, or someone else's). */
  apply(change: ThreadChange): void {
    if ('deleted' in change) {
      this.threads.delete(change.id);
      if (this.openId === change.id) this.openId = null;
    } else {
      this.threads.set(change.thread.id, change.thread);
    }
    this.request();
  }

  private canComment(): boolean {
    const role = this.host.role();
    return !!this.host.userId() && (role === 'owner' || role === 'editor' || role === 'commenter');
  }

  private async call(fn: (fileId: string) => Promise<ThreadChange>): Promise<boolean> {
    const fileId = this.host.fileId();
    if (!fileId || this.busy) return false;
    this.busy = true;
    try {
      this.apply(await fn(fileId));
      return true;
    } catch (error) {
      this.host.toast(error instanceof CloudError ? error.message : tr('Не получилось сохранить комментарий'), 'error');
      return false;
    } finally {
      this.busy = false;
    }
  }

  // ---------- placing ----------

  /**
   * Where a click puts a pin: on the object under it, so the pin travels with
   * it (BUG-080: it stayed behind when a sticky or a button inside a screen was
   * moved). On a board — the sticky, shape or stamp (or the section); in a
   * design — the layer under the cursor (a text or a button inside a screen
   * too). Over nothing — on the page.
   */
  private placeAt(world: Point): CommentPlace {
    const editor = this.editor;
    const d = editor.doc;
    const round = (n: number) => Math.round(n * 10) / 10;
    const hit = editor.scene.hitTest(world, { tolerance: 2 / editor.viewport.zoom })[0];
    const target = hit ? (boardObjectOf(d, hit) ?? hit) : null;
    if (target && target !== editor.pageId) {
      const b = editor.scene.bounds(target);
      return { pageId: editor.pageId, nodeId: target, x: round(world.x - b.x), y: round(world.y - b.y) };
    }
    return { pageId: editor.pageId, nodeId: null, x: round(world.x), y: round(world.y) };
  }

  /** World point of a pin on the current page (null — another page, or its layer is gone). */
  private anchor(t: Pick<CommentThread, 'pageId' | 'nodeId' | 'x' | 'y'>): Point | null {
    const editor = this.editor;
    if (t.pageId !== editor.pageId) return null;
    if (!t.nodeId) return { x: t.x, y: t.y };
    if (!editor.doc.store.isAlive(t.nodeId) || editor.doc.pageOf(t.nodeId) !== editor.pageId) return null;
    const b = editor.scene.bounds(t.nodeId);
    return { x: b.x + t.x, y: b.y + t.y };
  }

  /** A click with the comment tool. */
  startAt(world: Point): void {
    if (!this.host.fileId()) return this.host.toast(tr('Комментарии работают в файлах на сервере.'));
    if (!this.canComment()) return this.host.toast(this.host.userId() ? tr('У вас доступ только на просмотр: комментировать нельзя.') : tr('Войдите, чтобы комментировать.'));
    this.openId = null;
    this.draft = { place: this.placeAt(world), text: '' };
    this.request();
  }

  /** Opens a discussion when the comments of the file have arrived (a link from a letter). */
  showWhenLoaded(id: string): void {
    if (this.threads.has(id)) this.show(id);
    else this.pendingShow = id;
  }

  /** The people of the file, once per file; none for those who cannot comment (the @ list of board texts takes it too). */
  loadPeople(): Promise<Person[]> {
    const fileId = this.host.fileId();
    if (this.people) return Promise.resolve(this.people);
    if (!fileId || !this.canComment()) return Promise.resolve([]);
    this.peopleLoading ??= api.people(fileId).then(
      (list) => {
        if (this.host.fileId() === fileId) this.people = list;
        return list;
      },
      () => {
        this.peopleLoading = null;
        return [];
      },
    );
    return this.peopleLoading;
  }

  /** Ids of the people called in a text being sent. */
  private async mentions(text: string): Promise<string[]> {
    return text.includes('@') ? mentionedIn(text, await this.loadPeople()) : [];
  }

  /** Shows a discussion: its page, the pin in the middle of the screen, the popover. */
  show(id: string): void {
    const t = this.threads.get(id);
    if (!t) return;
    const editor = this.editor;
    if (t.pageId !== editor.pageId && editor.doc.store.isAlive(t.pageId)) editor.setPage(t.pageId);
    const at = this.anchor(t);
    if (at) {
      const { width, height } = editor.screenSize;
      const s = editor.viewport.worldToScreen(at);
      editor.viewport.panBy(width / 2 - s.x, height / 2 - s.y);
      editor.requestViewport();
    }
    this.draft = null;
    this.open(id);
  }

  private open(id: string): void {
    if (this.openId !== id) {
      this.reply = '';
      this.editing = null;
    }
    this.openId = id;
    this.request();
  }

  close(): void {
    this.openId = null;
    this.draft = null;
    this.editing = null;
    this.request();
  }

  private visible(t: CommentThread): boolean {
    return this.filter === 'all' || (this.filter === 'resolved') === t.resolved;
  }

  // ---------- drawing ----------

  private request(): void {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    this.renderList();
    const editor = this.editor;
    const vp = editor.viewport;
    const showPins = !this.pinsHidden || editor.tool === 'comment' || this.panelVisible || this.openId !== null;
    const nodes: HTMLElement[] = [];
    // Keep focus and the caret in a box being typed in across re-renders.
    const focused = document.activeElement instanceof HTMLTextAreaElement && this.overlay.contains(document.activeElement) ? document.activeElement.dataset.box : null;
    if (showPins) {
      for (const t of this.threads.values()) {
        if (!this.visible(t) && t.id !== this.openId) continue;
        const at = this.drag?.id === t.id ? this.drag.at : this.anchor(t);
        if (!at) continue;
        nodes.push(this.pin(t, vp.worldToScreen(at)));
      }
    }
    if (this.draft) {
      const at = this.anchor(this.draft.place);
      if (at) {
        const s = vp.worldToScreen(at);
        nodes.push(h('div', { class: 'comment-pin draft', style: { transform: `translate(${s.x}px, ${s.y - PIN}px)` } }, '+'));
        nodes.push(this.composer(s));
      } else this.draft = null;
    }
    const open = this.openId ? this.threads.get(this.openId) : undefined;
    if (open) {
      const at = this.anchor(open);
      if (at) nodes.push(this.popover(open, vp.worldToScreen(at)));
    }
    this.overlay.replaceChildren(...nodes);
    if (focused) {
      const box = this.overlay.querySelector<HTMLTextAreaElement>(`textarea[data-box="${focused}"]`);
      if (box) {
        box.focus({ preventScroll: true });
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  private pin(t: CommentThread, s: Point): HTMLElement {
    const first = t.comments[0];
    const replies = t.comments.length - 1;
    const el = h(
      'button',
      {
        class: `comment-pin${t.resolved ? ' resolved' : ''}${t.id === this.openId ? ' active' : ''}`,
        type: 'button',
        style: { transform: `translate(${s.x}px, ${s.y - PIN}px)` },
        title: first ? `${first.author}: ${first.text.slice(0, 120)}` : '',
        'aria-label': tr('Обсуждение: {0}', first?.author ?? ''),
      },
      initial(first?.author ?? '?'),
      replies > 0 ? h('span', { class: 'comment-pin-count' }, String(replies)) : null,
    );
    // Click opens; dragging moves the pin (its author or an editor).
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const canMove = this.canComment() && (first?.authorId === this.host.userId() || this.host.role() === 'owner' || this.host.role() === 'editor');
      const start = this.editor.viewport.screenToWorld(this.screenPoint(e));
      this.drag = canMove ? { id: t.id, start, at: this.anchor(t) ?? start, moved: false } : null;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== t.id) return;
      const p = this.editor.viewport.screenToWorld(this.screenPoint(e));
      const origin = this.anchor(t) ?? d.start;
      const zoom = this.editor.viewport.zoom;
      if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) * zoom < 4) return;
      d.moved = true;
      d.at = { x: origin.x + p.x - d.start.x, y: origin.y + p.y - d.start.y };
      // Moved in place: re-rendering would replace the element and lose the pointer.
      const s = this.editor.viewport.worldToScreen(d.at);
      el.style.transform = `translate(${s.x}px, ${s.y - PIN}px)`;
    });
    el.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (d?.moved) {
        const place = this.placeAt(d.at);
        void this.call((f) => api.move(f, t.id, place));
        return;
      }
      if (this.openId === t.id) this.close();
      else {
        this.draft = null;
        this.open(t.id);
      }
    });
    return el;
  }

  private screenPoint(e: PointerEvent): Point {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** A box positioned next to a pin, kept inside the canvas. */
  private box(s: Point, cls: string, ...children: (HTMLElement | null)[]): HTMLElement {
    const width = 300;
    const { width: W, height: H } = this.editor.screenSize;
    const left = Math.max(8, Math.min(s.x + PIN + 8, W - width - 8));
    const top = Math.max(8, Math.min(s.y - PIN, H - 120));
    const el = h('div', { class: `comment-popover ${cls}`, style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${Math.max(160, H - top - 16)}px` } }, ...children);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());
    return el;
  }

  /**
   * A text box: Enter sends, Shift+Enter starts a new line, Esc closes.
   * "@" opens the list of people: arrows choose, Enter or Tab puts the name in.
   */
  private textBox(name: string, value: string, placeholder: string, onInput: (v: string) => void, onSend: () => void): HTMLElement {
    const box = h('textarea', { class: 'comment-input', rows: 1, placeholder: this.canComment() ? `${placeholder} · ${tr('@ — упомянуть')}` : placeholder, dataset: { box: name }, maxLength: 5000, 'aria-label': placeholder });
    box.value = value;
    const list = h('div', { class: 'mention-list', role: 'listbox', 'aria-label': tr('Упомянуть'), hidden: true });
    let found: Person[] = [];
    let index = 0;
    let at: { start: number; query: string } | null = null;
    const fit = () => {
      box.style.height = 'auto';
      box.style.height = `${Math.min(160, box.scrollHeight)}px`;
    };
    const hide = () => {
      at = null;
      found = [];
      list.hidden = true;
    };
    const pick = (p: Person) => {
      if (!at) return;
      const end = at.start + 1 + at.query.length;
      const insert = `@${p.name} `;
      box.value = box.value.slice(0, at.start) + insert + box.value.slice(end);
      const caret = at.start + insert.length;
      box.setSelectionRange(caret, caret);
      hide();
      onInput(box.value);
      fit();
      box.focus({ preventScroll: true });
    };
    const draw = () => {
      clear(list);
      found.forEach((p, i) => {
        const row = h('div', { class: `mention-item${i === index ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === index) }, h('span', { class: 'comment-avatar' }, initial(p.name)), h('span', {}, p.name));
        // pointerdown, not click: the box must not lose focus first.
        row.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          pick(p);
        });
        list.append(row);
      });
      list.hidden = found.length === 0;
    };
    const suggest = () => {
      at = mentionQuery(box.value, box.selectionStart ?? box.value.length);
      if (!at) return hide();
      const query = at.query.toLocaleLowerCase();
      void this.loadPeople().then((people) => {
        if (!at || at.query.toLocaleLowerCase() !== query) return;
        const me = this.host.userId();
        // Any word of the name may be typed: "@ива" finds "Иван Петров" and "Мария Иванова".
        found = people.filter((p) => p.id !== me && p.name.toLocaleLowerCase().split(/\s+/).some((w) => w.startsWith(query))).slice(0, 8);
        index = 0;
        draw();
      });
    };
    box.addEventListener('input', () => {
      onInput(box.value);
      fit();
      suggest();
    });
    box.addEventListener('blur', () => hide());
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (found.length && !list.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          index = (index + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
          return draw();
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
          e.preventDefault();
          return pick(found[index]!);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          return hide();
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        onSend();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    queueMicrotask(fit);
    // The list sits in the flow above the box: the popover clips anything outside it.
    return h('div', { class: 'comment-box' }, list, box);
  }

  private composer(s: Point): HTMLElement {
    const draft = this.draft!;
    const send = () => {
      const text = draft.text.trim();
      if (!text) return;
      void this.mentions(text).then((ids) => this.call((f) => api.create(f, draft.place, text, ids))).then((ok) => {
        if (!ok) return;
        this.draft = null;
        this.request();
      });
    };
    const box = this.textBox('new', draft.text, tr('Добавьте комментарий'), (v) => (draft.text = v), send);
    queueMicrotask(() => {
      const input = box.querySelector('textarea');
      if (input && document.activeElement !== input && !this.overlay.querySelector('textarea:focus')) input.focus({ preventScroll: true });
    });
    return this.box(s, 'composer', h('div', { class: 'comment-reply' }, box, h('button', { class: 'comment-send', type: 'button', title: tr('Отправить (Enter)'), onclick: send }, '↑')));
  }

  private popover(t: CommentThread, s: Point): HTMLElement {
    const me = this.host.userId();
    const owner = this.host.role() === 'owner';
    const can = this.canComment();
    const resolve = can
      ? h(
          'button',
          {
            class: `icon-button comment-resolve${t.resolved ? ' on' : ''}`,
            type: 'button',
            title: t.resolved ? tr('Открыть снова') : tr('Отметить как решённое'),
            'aria-pressed': String(t.resolved),
            onclick: () => void this.call((f) => api.resolve(f, t.id, !t.resolved)).then((ok) => ok && !t.resolved && this.filter === 'open' && this.close()),
          },
          icon('check'),
        )
      : null;
    const header = h(
      'div',
      { class: 'comment-head' },
      h('span', { class: 'comment-title' }, t.resolved ? tr('Решено · {0}', t.resolvedBy ?? '') : tr('Обсуждение')),
      resolve,
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), onclick: () => this.close() }, '×'),
    );
    const items = t.comments.map((c, i) => {
      const mine = !!me && c.authorId === me;
      const actions: HTMLElement[] = [];
      if (mine && can) actions.push(h('button', { class: 'link-button', type: 'button', onclick: () => ((this.editing = c.id), this.request()) }, tr('Изменить')));
      if ((mine || owner) && can) actions.push(h('button', { class: 'link-button', type: 'button', onclick: () => void this.remove(t, c.id, i === 0) }, tr('Удалить')));
      let body: HTMLElement;
      if (this.editing === c.id) {
        let text = c.text;
        const save = () => {
          if (!text.trim() || text.trim() === c.text) return void ((this.editing = null), this.request());
          const trimmed = text.trim();
          void this.mentions(trimmed)
            .then((ids) => this.call((f) => api.edit(f, t.id, c.id, trimmed, ids)))
            .then((ok) => ok && ((this.editing = null), this.request()));
        };
        body = h(
          'div',
          { class: 'comment-edit' },
          this.textBox(`edit-${c.id}`, text, tr('Комментарий'), (v) => (text = v), save),
          h('div', { class: 'comment-edit-actions' }, h('button', { class: 'link-button', type: 'button', onclick: () => ((this.editing = null), this.request()) }, tr('Отмена')), h('button', { class: 'link-button primary', type: 'button', onclick: save }, tr('Сохранить'))),
        );
      } else {
        body = this.text(c);
      }
      return h(
        'div',
        { class: 'comment-item' },
        h(
          'div',
          { class: 'comment-meta' },
          h('span', { class: 'comment-avatar' }, initial(c.author)),
          h('span', { class: 'comment-author' }, c.author || tr('Без имени')),
          h('time', { class: 'comment-time', datetime: new Date(c.createdAt).toISOString(), title: new Date(c.createdAt).toLocaleString(locale()) }, when(c.createdAt) + (c.editedAt ? ` · ${tr('изменено')}` : '')),
        ),
        body,
        actions.length ? h('div', { class: 'comment-actions' }, ...actions) : null,
      );
    });
    const send = () => {
      const text = this.reply.trim();
      if (!text) return;
      void this.mentions(text).then((ids) => this.call((f) => api.reply(f, t.id, text, ids))).then((ok) => {
        if (!ok) return;
        this.reply = '';
        this.request();
      });
    };
    const footer = can
      ? h('div', { class: 'comment-reply' }, this.textBox('reply', this.reply, tr('Ответить'), (v) => (this.reply = v), send), h('button', { class: 'comment-send', type: 'button', title: tr('Отправить (Enter)'), onclick: send }, '↑'))
      : h('p', { class: 'comment-note' }, this.host.userId() ? tr('Отвечать могут те, у кого есть доступ на комментирование.') : tr('Войдите, чтобы отвечать.'));
    const node = t.nodeId && this.editor.doc.store.isAlive(t.nodeId) ? String(this.editor.doc.get(t.nodeId, 'name') ?? '') : '';
    return this.box(s, 'thread', header, node ? h('div', { class: 'comment-on' }, tr('На слое «{0}»', node)) : null, h('div', { class: 'comment-items' }, ...items), footer);
  }

  /** A comment's text with the people called highlighted (oneself more strongly). */
  private text(c: CommentItem): HTMLElement {
    const mentions = c.mentions ?? [];
    if (!mentions.length) return h('p', { class: 'comment-text' }, c.text);
    const me = this.host.userId();
    const mine = new Set(mentions.filter((m) => m.id === me).map((m) => m.name));
    const parts = splitMentions(
      c.text,
      mentions.map((m) => m.name),
    ).map((part) => (part.mention ? h('span', { class: `comment-mention${mine.has(part.text.slice(1)) ? ' me' : ''}` }, part.text) : document.createTextNode(part.text)));
    return h('p', { class: 'comment-text' }, ...parts);
  }

  private async remove(t: CommentThread, commentId: string, first: boolean): Promise<void> {
    if (first) {
      const ok = await askConfirm({ title: tr('Удалить обсуждение?'), message: tr('Удалится первый комментарий и все ответы на него.'), confirm: tr('Удалить'), danger: true });
      if (!ok) return;
    }
    await this.call((f) => api.remove(f, t.id, commentId));
  }

  // ---------- the list on the left ----------

  private renderList(): void {
    if (!this.panelVisible) return;
    clear(this.list);
    if (!this.host.fileId()) {
      this.list.append(h('p', { class: 'comments-empty' }, tr('Комментарии работают в файлах на сервере.')));
      return;
    }
    const all = [...this.threads.values()];
    const shown = all.filter((t) => this.visible(t)).sort((a, b) => (b.comments.at(-1)?.createdAt ?? b.createdAt) - (a.comments.at(-1)?.createdAt ?? a.createdAt));
    if (shown.length === 0) {
      const text = all.length === 0 ? tr('Комментариев пока нет. Нажмите C и щёлкните по холсту.') : this.filter === 'open' ? tr('Все обсуждения решены.') : tr('Нет обсуждений.');
      this.list.append(h('p', { class: 'comments-empty' }, text));
      return;
    }
    const pages = new Map(this.editor.doc.pages().map((p) => [p, String(this.editor.doc.get(p, 'name') ?? '')]));
    for (const t of shown) {
      const first = t.comments[0];
      if (!first) continue;
      const replies = t.comments.length - 1;
      const last = t.comments.at(-1)!;
      const lost = t.nodeId !== null && !this.editor.doc.store.isAlive(t.nodeId);
      const meta = [
        pages.get(t.pageId) ?? tr('Страница удалена'),
        replies > 0 ? `${replies} ${plural(replies, tr('ответ'), tr('ответа'), tr('ответов'))}` : '',
        lost ? tr('слой удалён') : '',
        t.resolved ? tr('решено') : '',
      ].filter(Boolean);
      const row = h(
        'button',
        { class: `comment-row${t.id === this.openId ? ' active' : ''}${t.resolved ? ' resolved' : ''}`, type: 'button', role: 'listitem', onclick: () => this.show(t.id) },
        h('span', { class: 'comment-avatar' }, initial(first.author)),
        h(
          'span',
          { class: 'comment-row-body' },
          h('span', { class: 'comment-row-head' }, h('span', { class: 'comment-author' }, first.author || tr('Без имени')), h('span', { class: 'comment-time' }, when(last.createdAt))),
          h('span', { class: 'comment-row-text' }, first.text),
          h('span', { class: 'comment-row-meta' }, meta.join(' · ')),
        ),
      );
      this.list.append(row);
    }
  }
}
