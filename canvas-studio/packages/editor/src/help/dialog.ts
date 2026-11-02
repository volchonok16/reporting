// Help window (F1, "?" in the top bar, "?" next to panel sections): articles
// by section with search. Search matches every word of the query (by its
// beginning, so «переменной» finds «переменные») in titles, keywords and text;
// titles weigh most. "Mod"/"Alt" are written for this computer.

import { lang, tr } from '#core';
import type { Command } from '../commands.ts';
import { formatShortcut } from '../keyboard.ts';
import { clear, h, icon } from '../ui/dom.ts';
import { ARTICLES_EN } from './articles-en.ts';
import { ARTICLES_RU } from './articles-ru.ts';
import { diagramArticles } from './diagram-articles.ts';
import type { Article, Block } from './types.ts';

const mac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const keys = (text: string) => text.replace(/\bMod\b/g, mac() ? '⌘' : 'Ctrl').replace(/\bAlt\b/g, mac() ? '⌥' : 'Alt');

export function articles(): Article[] {
  const base = lang === 'en' && ARTICLES_EN.length ? ARTICLES_EN : ARTICLES_RU;
  // How to write each kind of diagram: right after the article on diagrams.
  const at = base.findIndex((a) => a.id === 'diagrams');
  return at < 0 ? [...base, ...diagramArticles()] : [...base.slice(0, at + 1), ...diagramArticles(), ...base.slice(at + 1)];
}

const plainOf = (b: Block): string =>
  'p' in b ? b.p : 'h' in b ? b.h : 'tip' in b ? b.tip : 'list' in b ? b.list.join(' ') : 'steps' in b ? b.steps.join(' ') : 'html' in b ? b.html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : '';

/** Word start, a little shortened, so Russian endings do not break the match. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, w.length - 2) : w);

export function searchArticles(list: readonly Article[], query: string): { article: Article; snippet: string }[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((w) => w.length > 1).map(stem);
  if (!words.length) return [];
  const results: { article: Article; snippet: string; score: number }[] = [];
  for (const a of list) {
    const title = a.title.toLowerCase();
    const kw = (a.keywords ?? '').toLowerCase();
    const body = a.blocks.map(plainOf).join(' \n ');
    const lower = body.toLowerCase();
    let score = 0;
    let ok = true;
    for (const w of words) {
      const s = (title.includes(w) ? 10 : 0) + (kw.includes(w) ? 4 : 0) + (lower.includes(w) ? 1 : 0);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    // The sentence with the first body match is shown under the title.
    const at = Math.max(0, ...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).slice(0, 1));
    const start = Math.max(0, body.lastIndexOf('.', at) + 1);
    const snippet = body.slice(start, start + 140).trim();
    results.push({ article: a, snippet, score });
  }
  return results.sort((x, y) => y.score - x.score);
}

function mark(text: string, query: string): (string | HTMLElement)[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((w) => w.length > 1).map(stem);
  if (!words.length) return [text];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

/** Where the help is the list or the article (as in the styles). */
const PHONE = '(max-width: 640px)';

export class HelpDialog {
  private readonly overlay: HTMLElement;
  private readonly list = articles();
  private readonly nav: HTMLElement;
  private readonly content: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly commands: readonly Command[];
  private current: string;
  private readonly dialog: HTMLElement;

  constructor(options: { commands: readonly Command[]; onExample: () => void; article?: string }) {
    this.commands = options.commands;
    this.current = options.article && this.list.some((a) => a.id === options.article) ? options.article : this.list[0]!.id;
    this.search = h('input', { class: 'help-search', type: 'search', placeholder: tr('Поиск по справке: например, «тёмная тема» или «обрезать картинку»'), 'aria-label': tr('Поиск по справке'), spellcheck: 'false' });
    this.search.addEventListener('input', () => {
      this.dialog.classList.remove('reading');
      this.renderNav();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = searchArticles(this.list, this.search.value)[0];
        if (first) this.open(first.article.id);
      }
    });
    this.nav = h('nav', { class: 'help-nav', 'aria-label': tr('Разделы справки') });
    this.content = h('article', { class: 'help-content' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const example = h('button', { class: 'text-button', type: 'button', onclick: () => { this.close(); options.onExample(); } }, tr('Открыть пример'));
    const dialog = (this.dialog = h(
      'div',
      { class: 'dialog help-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Справка') },
      h('header', { class: 'dialog-header help-header' }, h('h2', {}, tr('Справка')), h('label', { class: 'help-search-wrap' }, icon('search', 14), this.search), example, close),
      h('div', { class: 'help-body' }, this.nav, this.content),
    ));
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        if (this.search.value) {
          this.search.value = '';
          this.renderNav();
        } else this.close();
      }
    });
    document.body.append(this.overlay);
    this.renderNav();
    this.open(this.current);
    // A phone shows the list or the article, not both (styles): the list first, unless an article was asked for;
    // and no keyboard over it at once.
    if (!options.article) dialog.classList.remove('reading');
    if (!matchMedia(PHONE).matches) this.search.focus();
  }

  close(): void {
    this.overlay.remove();
  }

  private renderNav(): void {
    clear(this.nav);
    const q = this.search.value.trim();
    if (q) {
      const found = searchArticles(this.list, q);
      if (!found.length) {
        this.nav.append(h('p', { class: 'help-empty' }, tr('Ничего не нашлось. Попробуйте другое слово или посмотрите разделы.')));
        return;
      }
      for (const { article, snippet } of found) {
        const item = h('button', { class: 'help-result', type: 'button', onclick: () => this.open(article.id) }, h('strong', {}, ...mark(article.title, q)), h('small', {}, article.section), h('span', {}, ...mark(keys(snippet), q)));
        this.nav.append(item);
      }
      return;
    }
    let section = '';
    for (const a of this.list) {
      if (a.section !== section) {
        section = a.section;
        this.nav.append(h('div', { class: 'help-section' }, section));
      }
      this.nav.append(h('button', { class: `help-nav-item${a.id === this.current ? ' active' : ''}`, type: 'button', dataset: { id: a.id }, onclick: () => this.open(a.id) }, a.title));
    }
  }

  open(id: string): void {
    const a = this.list.find((x) => x.id === id);
    if (!a) return;
    this.current = id;
    this.nav.querySelectorAll<HTMLElement>('.help-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    // An article opened from elsewhere (a diagram's «?») is shown in the list too.
    this.nav.querySelector<HTMLElement>('.help-nav-item.active')?.scrollIntoView({ block: 'nearest' });
    clear(this.content);
    this.dialog.classList.add('reading');
    const q = this.search.value.trim();
    const back = h('button', { class: 'help-back', type: 'button', onclick: () => this.dialog.classList.remove('reading') }, icon('chevronLeft', 14), q ? tr('Результаты поиска') : tr('Все разделы'));
    this.content.append(back, h('div', { class: 'help-crumb' }, a.section), h('h3', {}, a.title));
    for (const b of a.blocks) {
      if ('p' in b) this.content.append(h('p', {}, ...mark(keys(b.p), q)));
      else if ('h' in b) this.content.append(h('h4', {}, keys(b.h)));
      else if ('tip' in b) this.content.append(h('p', { class: 'help-tip' }, h('strong', {}, tr('Совет. ')), ...mark(keys(b.tip), q)));
      else if ('list' in b) this.content.append(h('ul', {}, ...b.list.map((l) => h('li', {}, ...mark(keys(l), q)))));
      else if ('steps' in b) this.content.append(h('ol', { class: 'help-steps' }, ...b.steps.map((l) => h('li', {}, ...mark(keys(l), q)))));
      else if ('shortcuts' in b) this.content.append(this.shortcutTable());
      else if ('html' in b) {
        const box = h('div', { class: 'help-html dg-reference' });
        box.innerHTML = b.html;
        this.content.append(box);
      }
    }
    const related = (a.related ?? []).map((r) => this.list.find((x) => x.id === r)).filter((x): x is Article => !!x);
    if (related.length) {
      this.content.append(
        h('div', { class: 'help-related' }, h('h4', {}, tr('Смотрите также')), ...related.map((r) => h('button', { class: 'help-link', type: 'button', onclick: () => this.open(r.id) }, r.title))),
      );
    }
    this.content.scrollTop = 0;
  }

  /** Every command with a shortcut, by menu group. */
  private shortcutTable(): HTMLElement {
    const wrap = h('div', { class: 'help-shortcuts' });
    const groups = new Map<string, Command[]>();
    for (const c of this.commands) {
      if (!c.keys?.length) continue;
      groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    }
    for (const [group, list] of groups) {
      wrap.append(h('h4', {}, group));
      const dl = h('dl', { class: 'help-keys' });
      for (const c of list) dl.append(h('dt', {}, ...c.keys!.flatMap((k, i) => (i ? [' ', h('kbd', {}, formatShortcut(k))] : [h('kbd', {}, formatShortcut(k))]))), h('dd', {}, c.label));
      wrap.append(dl);
    }
    return wrap;
  }
}
