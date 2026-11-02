// Command palette (FR-UI-020/021): fuzzy search across commands, layers and
// pages; understands queries typed in the wrong keyboard layout.

import { tr } from '#core';
import type { NodeId } from '#core';
import type { Command } from '../commands.ts';
import type { Editor } from '../editor.ts';
import { formatShortcut, switchLayout } from '../keyboard.ts';
import { clear, h, icon } from './dom.ts';

interface Item {
  label: string;
  hint: string;
  group: string;
  run: () => void;
  score: number;
}

const RECENT_LIMIT = 5;

/** Subsequence match score: higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || t.charAt(direct - 1) === ' ' ? 100 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

/** Commands that fit the selection: an image, several layers, a frame, text, an instance… */
export function suggestionsFor(editor: Editor): string[] {
  const d = editor.doc;
  const ids = editor.topLevelSelection();
  if (!ids.length) return [];
  const out: string[] = [];
  const types = ids.map((id) => d.type(id));
  if (ids.some((id) => d.get(id, 'fills').some((p) => p.visible && p.type === 'IMAGE'))) out.push('image.crop', 'image.erase', 'image.removeBg');
  if (types.every((t) => t === 'INSTANCE')) out.push('component.goToMain', 'component.reset', 'component.detach');
  if (ids.length > 1) {
    out.push('object.autoLayout', 'object.group', 'object.frame');
    if (types.every((t) => t === 'RECTANGLE' || t === 'ELLIPSE' || t === 'POLYGON' || t === 'STAR' || t === 'VECTOR' || t === 'BOOLEAN_OPERATION')) out.push('shape.union', 'shape.subtract', 'shape.intersect', 'shape.exclude', 'shape.builder', 'shape.mask');
    out.push('align.distributeH', 'align.distributeV', 'object.tidyUp');
  } else if (types[0] === 'FRAME') {
    out.push(d.get(ids[0]!, 'layoutMode') === 'NONE' ? 'object.autoLayout' : 'grid.add', 'component.create', 'file.exportPptx');
  }
  if (types.every((t) => t === 'TEXT')) out.push('text.translate', 'text.bold', 'text.alignCenter', 'shape.flatten');
  if (ids.length === 1 && (types[0] === 'FRAME' || types[0] === 'GROUP')) out.push('component.similar');
  if (types.some((t) => t === 'FRAME' || t === 'GROUP')) out.push('object.autoName');
  out.push('file.export', 'edit.copyPng');
  return [...new Set(out)].slice(0, 7);
}

export class CommandPalette {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly commands: Command[];
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private items: Item[] = [];
  private active = 0;
  private recent: string[] = [];
  private restoreFocus: HTMLElement | null = null;

  constructor(editor: Editor, commands: Command[]) {
    this.editor = editor;
    this.commands = commands.filter((c) => !c.hidden);
    this.input = h('input', { class: 'palette-input', type: 'text', placeholder: tr('Команда, слой или страница…'), spellcheck: false, 'aria-label': tr('Поиск команд') });
    this.list = h('div', { class: 'palette-list', role: 'listbox' });
    const dialog = h('div', { class: 'palette', role: 'dialog', 'aria-label': tr('Палитра команд') }, h('div', { class: 'palette-search' }, icon('command'), this.input), this.list);
    this.el = h('div', { class: 'palette-backdrop', hidden: true }, dialog);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') this.move(1, e);
      else if (e.key === 'ArrowUp') this.move(-1, e);
      else if (e.key === 'Enter') {
        e.preventDefault();
        this.runActive();
      }
    });
    try {
      this.recent = JSON.parse(localStorage.getItem('cs.palette.recent') ?? '[]') as string[];
    } catch {
      this.recent = [];
    }
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.hidden = false;
    this.input.value = '';
    this.search();
    this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.restoreFocus?.focus();
  }

  private move(step: number, e: KeyboardEvent): void {
    e.preventDefault();
    if (this.items.length === 0) return;
    this.setActive((this.active + step + this.items.length) % this.items.length, true);
  }

  /**
   * Moves the highlight without rebuilding the list. Rebuilding on hover reset
   * the scroll: while scrolling, rows pass under the pointer, each one
   * re-rendered the list and scrolled back to the highlighted row.
   */
  private setActive(i: number, reveal: boolean): void {
    const rows = this.list.children;
    rows[this.active]?.classList.remove('active');
    rows[this.active]?.setAttribute('aria-selected', 'false');
    this.active = i;
    rows[i]?.classList.add('active');
    rows[i]?.setAttribute('aria-selected', 'true');
    if (reveal) rows[i]?.scrollIntoView({ block: 'nearest' });
  }

  private runActive(): void {
    const item = this.items[this.active];
    if (!item) return;
    this.close();
    item.run();
  }

  private search(): void {
    const raw = this.input.value;
    const queries = raw.trim() ? [raw, switchLayout(raw)] : [];
    const editor = this.editor;
    const out: Item[] = [];
    const best = (text: string) => (queries.length === 0 ? 0 : Math.max(...queries.map((q) => fuzzyScore(q, text))));

    // Nothing typed and something selected: the actions that fit it come first (FEAT-046).
    const suggested = queries.length === 0 ? suggestionsFor(editor) : [];
    for (const id of suggested) {
      const command = this.commands.find((c) => c.id === id);
      if (!command) continue;
      out.push({ label: command.label, hint: formatShortcut(command.keys?.[0] ?? ''), group: tr('Для выделения'), score: 50_000 - out.length, run: () => { this.remember(command.id); command.run(); } });
    }
    for (const command of this.commands) {
      if (suggested.includes(command.id)) continue;
      // Synonyms count, a little less than the label itself.
      // Synonyms count only as a whole-word-start match (fuzzy matching a long word list would match anything).
      const kw = command.keywords && queries.some((q) => q.trim().length > 1 && new RegExp(`(^|\\s)${q.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(command.keywords!.toLowerCase())) ? 900 : -1;
      const score = Math.max(best(`${command.label} ${command.group}`), kw);
      if (score < 0) continue;
      const recentIndex = this.recent.indexOf(command.id);
      const boost = queries.length === 0 ? (recentIndex >= 0 ? 10_000 - recentIndex : -command.label.length) : 0;
      out.push({
        label: command.label,
        hint: formatShortcut(command.keys?.[0] ?? ''),
        group: recentIndex >= 0 && queries.length === 0 ? tr('Недавние') : command.group,
        score: score + boost,
        run: () => {
          this.remember(command.id);
          command.run();
        },
      });
    }
    if (queries.length > 0) {
      for (const page of editor.doc.pages()) {
        const name = editor.doc.get(page, 'name');
        const score = best(name);
        if (score >= 0) out.push({ label: name, hint: tr('страница'), group: tr('Страницы'), score: score - 5, run: () => editor.setPage(page) });
      }
      const layers: Item[] = [];
      editor.doc.store.walk(editor.pageId, (id: NodeId) => {
        if (layers.length > 200) return false;
        const name = editor.doc.get(id, 'name');
        const score = best(name);
        if (score >= 0) {
          layers.push({
            label: name,
            hint: tr('слой'),
            group: tr('Слои'),
            score: score - 10,
            run: () => {
              editor.setSelection([id]);
              editor.zoomToSelection();
            },
          });
        }
        return true;
      });
      out.push(...layers);
    }
    out.sort((a, b) => b.score - a.score);
    this.items = out.slice(0, 60);
    this.active = 0;
    this.renderList();
  }

  private renderList(): void {
    clear(this.list);
    if (this.items.length === 0) {
      this.list.append(h('div', { class: 'palette-empty' }, tr('Ничего не найдено')));
      return;
    }
    this.items.forEach((item, i) => {
      const row = h(
        'div',
        { class: `palette-item${i === this.active ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === this.active) },
        h('span', { class: 'palette-label' }, item.label),
        h('span', { class: 'palette-group' }, item.group),
        item.hint ? h('kbd', {}, item.hint) : null,
      );
      row.addEventListener('pointermove', () => {
        if (this.active !== i) this.setActive(i, false);
      });
      row.addEventListener('click', () => {
        this.active = i;
        this.runActive();
      });
      this.list.append(row);
    });
    this.list.scrollTop = 0;
  }

  private remember(id: string): void {
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT);
    try {
      localStorage.setItem('cs.palette.recent', JSON.stringify(this.recent));
    } catch {
      // Storage unavailable: recent commands are kept for this session only.
    }
  }
}
