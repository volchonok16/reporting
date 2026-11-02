// «Контент» (as Content Reel): sets of plausible data next to the tool panel.
// A click on a set fills the selected layers, each with its own value (texts —
// the text, shapes — the picture); ▸ shows the set's values, a click on one puts
// that value into every selected layer. Nothing selected — a new layer. A set
// dragged onto a layer fills it. «Мои наборы»: lists pasted by hand or from a
// table (a set per column) and pictures from the disk.

import { lang as uiLang, plural, tr, type NodeId } from '#core';
import type { Point } from '#geometry';
import type { Editor } from '../editor.ts';
import { builtInSets, contentTargets, newPicture, newText, parseOwnList, pickValues, putPictures, putTexts, type ContentCategory, type ContentLang, type ContentSet, type OwnTextSet, type PictureBytes } from '../content-reel.ts';
import { pictureBytes, pictureThumb } from '../content-pictures.ts';
import { asPicture, deleteOwnPictureSet, ownPictureSets, ownTextSets, saveOwnPictureSet, saveOwnTextSets, shrinkPicture, type OwnPictureSet } from '../content-store.ts';
import { pickFiles } from '../images.ts';
import { h, icon } from './dom.ts';

/** What a dragged set carries to the canvas: its id. */
export const CONTENT_DRAG_TYPE = 'application/x-simmetrika-content';

const OPTIONS_KEY = 'cs-content-options';
/** The whole of the own text sets kept with the account (the server's limit is 30 000). */
const OWN_TEXT_LIMIT = 28_000;

const CATEGORIES = (): [ContentCategory | 'all', string][] => [
  ['all', tr('Все')],
  ['people', tr('Люди')],
  ['places', tr('Места')],
  ['time', tr('Время')],
  ['numbers', tr('Числа и деньги')],
  ['texts', tr('Тексты')],
  ['web', tr('Интернет')],
  ['images', tr('Картинки')],
  ['mine', tr('Мои наборы')],
];

/** A set as the panel shows it: built in or the user's. */
interface Entry {
  set: ContentSet;
  /** Own text set (editable), own picture set (editable), or built in. */
  own?: { kind: 'text'; data: OwnTextSet } | { kind: 'image'; data: OwnPictureSet };
}

interface Options {
  shuffle: boolean;
  lang: ContentLang;
}

function savedOptions(): Options {
  try {
    const v = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<Options> | null;
    return { shuffle: v?.shuffle ?? true, lang: v?.lang === 'en' || v?.lang === 'ru' ? v.lang : uiLang };
  } catch {
    return { shuffle: true, lang: uiLang };
  }
}

const newId = () => `own-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export class ContentPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly dock: HTMLElement;
  private category: ContentCategory | 'all' = 'all';
  private query = '';
  private options = savedOptions();
  private readonly search: HTMLInputElement;
  private readonly chips: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private ownPictures: OwnPictureSet[] = [];
  /** Where «in a row» continues for each set: the next click gives the next values. */
  private readonly cursor = new Map<string, number>();
  /** The set whose values are open (▸). */
  private open: string | null = null;
  /** The form of a new or edited own set. */
  private editing: { id: string | null } | null = null;

  constructor(editor: Editor, dock: HTMLElement) {
    this.editor = editor;
    this.dock = dock;
    this.search = h('input', { class: 'ip-search', type: 'search', placeholder: tr('Найти набор: имя, цена, дата, аватар…'), 'aria-label': tr('Найти набор') }) as HTMLInputElement;
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.fill();
    });
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      // Enter fills with the first set found.
      if (e.key === 'Enter') {
        const first = this.entries()[0];
        if (first) void this.apply(first);
      }
    });
    this.chips = h('div', { class: 'ip-cats', role: 'tablist', 'aria-label': tr('Разделы контента') });
    this.list = h('div', { class: 'cr-list', role: 'list' });
    this.status = h('span', { class: 'fp-hint cr-status' });
    const head = h(
      'div',
      { class: 'ip-head' },
      icon('search', 14),
      this.search,
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close')),
    );
    this.el = h('div', { class: 'frame-presets icons-panel content-panel', role: 'dialog', 'aria-label': tr('Контент'), hidden: true }, head, this.chips, this.list, this.optionsRow());
    window.addEventListener('resize', () => this.place());
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      // The canvas stays usable while the panel is open: layers are selected there to be filled.
      if (this.el.hidden || !t || this.el.contains(t) || this.dock.contains(t) || (t as Element).closest?.('canvas, .dialog-overlay')) return;
      this.close();
    });
    for (const ev of ['selection', 'document'] as const) editor.events.on(ev, () => this.showStatus());
  }

  toggle(): void {
    if (this.editor.doc.readOnly) return;
    this.el.hidden = !this.el.hidden;
    if (this.el.hidden) return;
    this.fillChips();
    this.fill();
    this.place();
    this.search.focus();
    this.search.select();
    void ownPictureSets().then((sets) => {
      this.ownPictures = sets;
      this.fill();
    });
  }

  close(): void {
    this.el.hidden = true;
    this.editing = null;
  }

  // ---------- the sets ----------

  private all(): Entry[] {
    const own: Entry[] = [
      ...ownTextSets().map((data): Entry => ({ set: { kind: 'text', id: data.id, cat: 'mine', name: data.name, items: () => data.items }, own: { kind: 'text', data } })),
      ...this.ownPictures.map((data): Entry => ({ set: { kind: 'image', id: data.id, cat: 'mine', name: data.name, count: data.pictures.length, shape: 'rect', width: 0, height: 0 }, own: { kind: 'image', data } })),
    ];
    return [...builtInSets().map((set) => ({ set })), ...own];
  }

  /** The sets of the chosen section that match the search (by name and by values: «Казань» finds «Город»). */
  private entries(): Entry[] {
    const words = this.query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    return this.all().filter(({ set }) => {
      if (this.category !== 'all' && set.cat !== this.category) return false;
      if (!words.length) return true;
      const values = set.kind === 'text' ? set.items(this.options.lang).slice(0, 6).join(' ') : '';
      const hay = `${set.name} ${set.id} ${values}`.toLowerCase().replace(/ё/g, 'е');
      return words.every((w) => hay.includes(w));
    });
  }

  private fillChips(): void {
    this.chips.replaceChildren(
      ...CATEGORIES().map(([value, label]) => {
        const on = value === this.category;
        const b = h('button', { class: `fp-group${on ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on) }, h('span', {}, label));
        b.addEventListener('click', () => {
          this.category = value;
          this.editing = null;
          this.fillChips();
          this.fill();
        });
        return b;
      }),
    );
  }

  private fill(): void {
    const rows: HTMLElement[] = [];
    if (this.category === 'mine') {
      if (this.editing) rows.push(this.form());
      else rows.push(h('button', { class: 'cr-add', type: 'button', onclick: () => this.edit(null) }, icon('plus', 14), h('span', {}, tr('Новый набор: список, таблица или картинки'))));
    }
    const entries = this.entries();
    for (const entry of entries) {
      rows.push(this.row(entry));
      if (this.open === entry.set.id) rows.push(this.values(entry));
    }
    if (entries.length === 0 && this.category !== 'mine') rows.push(h('p', { class: 'ip-empty' }, tr('Ничего не нашлось — попробуйте другое слово')));
    if (entries.length === 0 && this.category === 'mine' && !this.editing)
      rows.push(h('p', { class: 'ip-empty' }, tr('Свои наборы: вставьте список (по значению в строке) или таблицу из Excel и Google Таблиц — набор на каждый столбец; или выберите картинки.')));
    this.list.replaceChildren(...rows);
    this.showStatus();
    // Opened values or the form change the height: the panel stays by the tool panel.
    this.place();
  }

  private row(entry: Entry): HTMLElement {
    const { set } = entry;
    const sample = h('span', { class: 'cr-sample' });
    if (set.kind === 'text') sample.textContent = set.items(this.options.lang).slice(0, 3).join(' · ');
    else sample.append(...this.thumbs(entry, 4));
    const fillButton = h('button', { class: 'cr-fill', type: 'button', title: tr('Заполнить выделенное'), draggable: 'true' }, h('span', { class: 'cr-name' }, set.name), sample);
    fillButton.addEventListener('click', () => void this.apply(entry));
    fillButton.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(CONTENT_DRAG_TYPE, set.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    const opened = this.open === set.id;
    const more = h('button', { class: 'icon-button cr-more', type: 'button', title: opened ? tr('Скрыть значения') : tr('Показать значения'), 'aria-label': tr('Значения набора'), 'aria-expanded': String(opened) }, icon(opened ? 'chevronDown' : 'chevronRight', 14));
    more.addEventListener('click', () => {
      this.open = opened ? null : set.id;
      this.fill();
    });
    const tools: HTMLElement[] = [];
    if (entry.own) {
      tools.push(h('button', { class: 'icon-button', type: 'button', title: tr('Изменить набор'), 'aria-label': tr('Изменить набор'), onclick: () => this.edit(set.id) }, icon('pencil', 14)));
      tools.push(h('button', { class: 'icon-button', type: 'button', title: tr('Удалить набор'), 'aria-label': tr('Удалить набор'), onclick: () => void this.remove(entry) }, icon('close', 14)));
    }
    return h('div', { class: 'cr-row', role: 'listitem' }, fillButton, ...tools, more);
  }

  private thumbs(entry: Entry, n: number): HTMLElement[] {
    const { set } = entry;
    if (set.kind !== 'image') return [];
    const out: HTMLElement[] = [];
    for (let i = 0; i < Math.min(n, set.count); i++) {
      let src: string;
      if (entry.own?.kind === 'image') {
        const p = entry.own.data.pictures[i]!;
        src = URL.createObjectURL(new Blob([p.bytes as BlobPart], { type: p.mime }));
      } else src = pictureThumb(set.id, i, set.shape === 'circle' ? 48 : 64, set.shape === 'circle' ? 48 : 40, this.options.lang);
      out.push(h('img', { class: `cr-thumb${set.shape === 'circle' ? ' round' : ''}`, src, alt: '' }));
    }
    return out;
  }

  /** The values of a set: a click puts that one value into every selected layer. */
  private values(entry: Entry): HTMLElement {
    const { set } = entry;
    const box = h('div', { class: `cr-values${set.kind === 'image' ? ' pictures' : ''}` });
    if (set.kind === 'text') {
      for (const value of set.items(this.options.lang)) {
        const b = h('button', { class: 'cr-value', type: 'button', title: value }, value);
        b.addEventListener('click', () => void this.apply(entry, [value]));
        box.append(b);
      }
    } else {
      this.thumbs(entry, set.count).forEach((img, i) => {
        const b = h('button', { class: 'cr-value picture', type: 'button', 'aria-label': `${set.name} ${i + 1}` }, img);
        b.addEventListener('click', () => void this.apply(entry, undefined, [i]));
        box.append(b);
      });
    }
    return box;
  }

  // ---------- filling ----------

  /** What a click would do, under the list. */
  private showStatus(): void {
    if (this.el.hidden) return;
    const texts = contentTargets(this.editor, 'text').length;
    const shapes = contentTargets(this.editor, 'image').length;
    if (!this.editor.selection.length) this.status.textContent = tr('Ничего не выделено — щелчок добавит новый слой');
    else if (texts || shapes)
      this.status.textContent = [texts ? `${texts} ${plural(texts, tr('текст'), tr('текста'), tr('текстов'))}` : '', shapes ? `${shapes} ${plural(shapes, tr('фигура'), tr('фигуры'), tr('фигур'))}` : ''].filter(Boolean).join(', ') + tr(' — заполнятся по щелчку');
    else this.status.textContent = tr('В выделении нет текстов и фигур — щелчок добавит новый слой');
  }

  /**
   * Fills the selected layers (or `ids`, or a new layer at `at`) from the set: each its own value,
   * or `only` values when one was chosen; `indexes` — chosen pictures.
   */
  async apply(entry: Entry, only?: readonly string[], indexes?: readonly number[], ids?: readonly NodeId[], at?: Point): Promise<void> {
    const editor = this.editor;
    if (editor.doc.readOnly) return;
    const { set } = entry;
    const targets = contentTargets(editor, set.kind, ids ?? (at ? [] : editor.selection));
    const n = Math.max(1, targets.length);
    const label = tr('Контент: {0}', set.name);
    if (set.kind === 'text') {
      const list = set.items(this.options.lang);
      const values = only ?? this.take(set.id, list, n);
      if (!values.length) return;
      if (targets.length) putTexts(editor, targets, values, label);
      else newText(editor, values[0]!, label, at);
    } else {
      const count = entry.own?.kind === 'image' ? entry.own.data.pictures.length : set.count;
      const picks = indexes ?? this.take(set.id, Array.from({ length: count }, (_, i) => i), n);
      if (!picks.length) return;
      const pictures = await Promise.all(picks.map((i) => this.picture(entry, i)));
      if (targets.length) putPictures(editor, targets, pictures, label);
      else {
        const own = entry.own?.kind === 'image' ? entry.own.data.pictures[picks[0]!]! : null;
        // An own picture keeps its proportions at up to 320 px.
        const k = own ? Math.min(1, 320 / Math.max(own.width, own.height)) : 1;
        newPicture(editor, pictures[0]!, set.shape, own ? Math.round(own.width * k) : set.width, own ? Math.round(own.height * k) : set.height, set.name, label, at);
      }
    }
    editor.setTool('select');
  }

  /** The next values of a set: shuffled, or in a row continuing from the last click. */
  private take<T>(id: string, list: readonly T[], n: number): T[] {
    const start = this.cursor.get(id) ?? 0;
    this.cursor.set(id, start + n);
    return pickValues(list, n, start, this.options.shuffle);
  }

  private picture(entry: Entry, i: number): Promise<PictureBytes> {
    if (entry.own?.kind === 'image') return Promise.resolve(asPicture(entry.own.data.pictures[i % entry.own.data.pictures.length]!));
    const set = entry.set as Extract<ContentSet, { kind: 'image' }>;
    return pictureBytes(set.id, i, set.width, set.height, this.options.lang);
  }

  /** A set dropped onto the canvas: into the layer under the point (into the whole selection when that layer is selected), else a new layer there. */
  drop(id: string, world: Point): boolean {
    const entry = this.all().find((e) => e.set.id === id);
    if (!entry) return false;
    const editor = this.editor;
    const kind = entry.set.kind;
    const hit = editor.scene.hitTest(world, { tolerance: 2 / editor.viewport.zoom }).find((h) => contentTargets(editor, kind, [h]).length > 0);
    if (hit && editor.selection.includes(hit)) void this.apply(entry);
    else if (hit) void this.apply(entry, undefined, undefined, [hit]);
    else void this.apply(entry, undefined, undefined, undefined, world);
    return true;
  }

  // ---------- own sets ----------

  private edit(id: string | null): void {
    this.category = 'mine';
    this.editing = { id };
    this.fillChips();
    this.fill();
  }

  private form(): HTMLElement {
    const id = this.editing?.id ?? null;
    const text = id ? ownTextSets().find((s) => s.id === id) : undefined;
    const pictures = id ? this.ownPictures.find((s) => s.id === id) : undefined;
    const name = h('input', { class: 'cr-input', type: 'text', placeholder: tr('Название набора'), value: text?.name ?? pictures?.name ?? '', 'aria-label': tr('Название набора') }) as HTMLInputElement;
    const items = h('textarea', { class: 'cr-input cr-items', rows: '6', placeholder: tr('По значению в строке. Таблица из Excel, Google Таблиц или CSV — набор на каждый столбец, первая строка — названия.'), 'aria-label': tr('Значения') }) as HTMLTextAreaElement;
    items.value = text?.items.join('\n') ?? '';
    for (const field of [name, items]) field.addEventListener('keydown', (e) => e.stopPropagation());
    const save = h('button', { class: 'text-button primary', type: 'button' }, tr('Сохранить'));
    save.addEventListener('click', () => {
      const fallback = name.value.trim() || tr('Мой набор');
      const parsed = parseOwnList(items.value, fallback);
      if (!parsed.length) return this.editor.toast(tr('Добавьте значения — по одному в строке'));
      const others = ownTextSets().filter((s) => s.id !== id);
      // One list keeps the given name; a table gives a set per column, named by its headings.
      const made = parsed.map((p, i) => ({ id: i === 0 && id ? id : newId(), name: parsed.length === 1 ? fallback : p.name, items: p.items }));
      const next = [...others, ...made];
      if (JSON.stringify(next).length > OWN_TEXT_LIMIT) return this.editor.toast(tr('Наборы получаются слишком большими: оставьте до 25 000 знаков на все свои наборы'), 'error');
      saveOwnTextSets(next);
      this.editing = null;
      this.fill();
      this.editor.toast(made.length > 1 ? tr('Наборов из таблицы: {0}', made.length) : tr('Набор «{0}» сохранён', made[0]!.name));
    });
    const addPictures = h('button', { class: 'text-button', type: 'button' }, icon('image', 14), h('span', {}, pictures ? tr('Добавить картинки…') : tr('Набор из картинок…')));
    addPictures.addEventListener('click', () => {
      void pickFiles('image/*', true).then(async (files) => {
        if (!files.length) return;
        const shrunk = (await Promise.all(files.map((f) => shrinkPicture(f)))).filter((p): p is NonNullable<typeof p> => !!p);
        if (!shrunk.length) return this.editor.toast(tr('Эти файлы не открылись как картинки'), 'error');
        const set: OwnPictureSet = pictures ? { ...pictures, name: name.value.trim() || pictures.name, pictures: [...pictures.pictures, ...shrunk] } : { id: newId(), name: name.value.trim() || tr('Мои картинки'), pictures: shrunk };
        await saveOwnPictureSet(set);
        this.ownPictures = await ownPictureSets();
        this.editing = null;
        this.fill();
        this.editor.toast(tr('Картинок в наборе «{0}»: {1}', set.name, set.pictures.length));
      });
    });
    const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => ((this.editing = null), this.fill()) }, tr('Отмена'));
    const body: HTMLElement[] = [name];
    // A picture set is renamed or given more pictures; its text box is not needed.
    if (!pictures) body.push(items);
    if (pictures) {
      const rename = h('button', { class: 'text-button primary', type: 'button' }, tr('Сохранить'));
      rename.addEventListener('click', () => {
        void saveOwnPictureSet({ ...pictures, name: name.value.trim() || pictures.name }).then(async () => {
          this.ownPictures = await ownPictureSets();
          this.editing = null;
          this.fill();
        });
      });
      body.push(h('div', { class: 'cr-form-actions' }, addPictures, h('span', { class: 'cr-spacer' }), cancel, rename));
      body.push(h('p', { class: 'fp-hint' }, tr('Картинки хранятся в этом браузере.')));
    } else {
      body.push(h('div', { class: 'cr-form-actions' }, text ? null : addPictures, h('span', { class: 'cr-spacer' }), cancel, save));
      body.push(h('p', { class: 'fp-hint' }, tr('Списки запоминаются в вашем аккаунте, картинки — в этом браузере.')));
    }
    queueMicrotask(() => name.focus());
    return h('div', { class: 'cr-form' }, ...body);
  }

  private async remove(entry: Entry): Promise<void> {
    if (!entry.own) return;
    if (entry.own.kind === 'text') saveOwnTextSets(ownTextSets().filter((s) => s.id !== entry.set.id));
    else {
      await deleteOwnPictureSet(entry.set.id);
      this.ownPictures = await ownPictureSets();
    }
    this.fill();
    this.editor.toast(tr('Набор «{0}» удалён', entry.set.name));
  }

  // ---------- options ----------

  private optionsRow(): HTMLElement {
    const save = () => {
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.options));
      } catch {
        // not remembered
      }
    };
    const shuffle = h('input', { type: 'checkbox', checked: this.options.shuffle }) as HTMLInputElement;
    shuffle.addEventListener('change', () => {
      this.options.shuffle = shuffle.checked;
      this.cursor.clear();
      save();
    });
    const language = h('select', { class: 'ip-select', 'aria-label': tr('Язык данных'), title: tr('Язык данных') }, h('option', { value: 'ru', selected: this.options.lang === 'ru' }, 'Русский'), h('option', { value: 'en', selected: this.options.lang === 'en' }, 'English')) as HTMLSelectElement;
    language.addEventListener('change', () => {
      this.options.lang = language.value === 'en' ? 'en' : 'ru';
      save();
      this.fill();
    });
    return h(
      'div',
      { class: 'ip-look' },
      h('label', { class: 'ip-field' }, shuffle, h('span', {}, tr('Вперемешку'))),
      h('label', { class: 'ip-field' }, h('span', {}, tr('Язык')), language),
      this.status,
    );
  }

  private place(): void {
    if (this.el.hidden) return;
    const area = this.el.parentElement;
    if (!area) return;
    const a = area.getBoundingClientRect();
    const d = this.dock.getBoundingClientRect();
    const where = this.dock.dataset.place ?? 'bottom';
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    if (where === 'left') {
      this.el.style.left = `${d.right - a.left + 8}px`;
      this.el.style.top = `${Math.max(8, d.top - a.top + d.height / 2 - hh / 2)}px`;
    } else {
      this.el.style.left = `${Math.max(8, Math.min(a.width - w - 8, d.left - a.left + d.width / 2 - w / 2))}px`;
      this.el.style.top = `${where === 'top' ? d.bottom - a.top + 8 : Math.max(8, d.top - a.top - hh - 8)}px`;
    }
  }
}
