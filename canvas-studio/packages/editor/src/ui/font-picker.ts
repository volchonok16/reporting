// Font family picker (FEAT-005): searchable list with previews in each font.
// Sources: fonts already used in the file, a list of common families that are
// actually installed on this computer, and — where the browser allows (Local
// Font Access API) — every font installed on the computer. No web fonts are
// downloaded, so the editor stays independent of external services.

import { tr } from '#core';
import type { Document } from '#core';
import { embeddedFonts, embedFontFiles, embedGoogleFamilies, embedLocalFamily } from '../fonts.ts';
import { isBrandFamily } from '../t2-fonts.ts';
import { fontTraits, type FontKind } from '../font-kinds.ts';
import { pickFiles } from '../images.ts';
import { switchLayout } from '../keyboard.ts';
import { clear, h, icon } from './dom.ts';
import { MIXED, mixedOption, type Field, type Mixed } from './fields.ts';

const COMMON_FAMILIES = [
  'Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Manrope', 'PT Sans', 'PT Serif', 'PT Mono', 'Noto Sans', 'Noto Serif', 'Source Sans Pro', 'Source Serif Pro',
  'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'Fira Sans', 'Fira Code', 'JetBrains Mono', 'Ubuntu', 'Golos Text', 'Raleway', 'Nunito', 'Rubik', 'Playfair Display',
  'Merriweather', 'Oswald', 'Arial', 'Arial Black', 'Helvetica', 'Helvetica Neue', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New',
  'Impact', 'Comic Sans MS', 'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel', 'Franklin Gothic Medium', 'Garamond', 'Palatino Linotype',
  'SF Pro Text', 'SF Pro Display', 'SF Pro Rounded', 'SF Mono', 'New York', 'Avenir', 'Avenir Next', 'Futura', 'Gill Sans', 'Optima', 'Palatino', 'Baskerville',
  'Didot', 'Hoefler Text', 'American Typewriter', 'Menlo', 'Monaco', 'Charter', 'Rockwell', 'Copperplate', 'Papyrus', 'Marker Felt', 'Chalkboard', 'T2 Rooftop', 'T2 Rooftop Medium', 'T2 Halvar Breit', 'T2 Halvar Breit ExtraBold', 'DejaVu Sans',
  'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Cantarell',
];

let installedCommon: string[] | null = null;
let systemFamilies: string[] | null = null;

/**
 * Whether a font family is installed: text in "Family, fallback" must measure
 * differently from the fallback alone for at least one of three fallbacks.
 */
const availability = new Map<string, boolean>();
let probe: CanvasRenderingContext2D | null = null;

/** Families that ship with the editor via @font-face. */
function isBundled(family: string): boolean {
  if (typeof document === 'undefined' || !document.fonts) return false;
  for (const face of document.fonts) if (face.family.replace(/["']/g, '') === family && face.status !== 'error') return true;
  return false;
}

/** Fonts were added to the page (embedded in the file): check these families again. */
export function fontsChanged(families: readonly string[]): void {
  for (const f of families) availability.delete(f);
  installedCommon = null;
}

/** Families Google Fonts turned out not to have (this session): the button offers a font file instead. */
const notOnGoogle = new Set<string>();

/** Fonts nearly every computer has: no need to embed them. */
const EVERYWHERE = new Set(['system-ui', 'Inter', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New', 'Tahoma', 'Trebuchet MS']);

/** Asks for font files and embeds them; returns a message for the person. */
export async function addFontFiles(doc: Document): Promise<string> {
  const files = await pickFiles('.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2', true);
  if (!files.length) return '';
  if (doc.readOnly) return tr('Только просмотр: изменения не сохраняются.');
  const res = await embedFontFiles(doc, await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  const done = res.families.length ? tr('Шрифт в файле: {0}. Его увидят все, кто откроет файл.', res.families.join(', ')) : '';
  return [done, ...res.errors].filter(Boolean).join(' ');
}

export function isFontAvailable(family: string): boolean {
  if (isBrandFamily(family)) return true;
  const known = availability.get(family);
  if (known !== undefined) return known;
  if (isBundled(family)) {
    availability.set(family, true);
    return true;
  }
  probe ??= document.createElement('canvas').getContext('2d');
  const ctx = probe;
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmlliWWЖщфы0123456789';
  const result = ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx.font = `72px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
  availability.set(family, result);
  return result;
}

function commonInstalled(): string[] {
  installedCommon ??= COMMON_FAMILIES.filter(isFontAvailable);
  return installedCommon;
}

/** Every installed family via the Local Font Access API (Chrome, Edge); asks the user for permission. */
async function loadSystemFonts(): Promise<string[] | null> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) return null;
  try {
    const fonts = await query();
    systemFamilies = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    return systemFamilies;
  } catch {
    return null;
  }
}

function familiesInFile(doc: Document): string[] {
  const used = new Set<string>();
  doc.store.walk(doc.rootId, (id) => {
    if (doc.type(id) === 'TEXT') used.add(doc.get(id, 'fontFamily'));
  });
  return [...used].sort((a, b) => a.localeCompare(b));
}

export interface FontPickerOptions {
  /** A name to show instead of the family (e.g. «Как в интерфейсе» for system-ui). */
  label?: (family: string) => string | null;
  /** Groups shown before the usual ones (title, families). */
  first?: [string, string[]][];
  /** Live preview (FEAT-153): the family the pointer is on, shown on the canvas; null — back to what it was. */
  preview?: (family: string | null) => void;
  /** The text of the selected layer, for «Образец: текст слоя». */
  sample?: () => string | null;
}

type SampleMode = 'name' | 'layer' | 'custom';
type KindFilter = 'all' | FontKind;

/** The picker's own settings in this browser: sample, filters, favourites, recent. */
interface PickerPrefs {
  sample: SampleMode;
  custom: string;
  kind: KindFilter;
  cyrillic: boolean;
  favorites: string[];
  recent: string[];
}
const PREFS_KEY = 'cs-font-picker';

function pickerPrefs(): PickerPrefs {
  const base: PickerPrefs = { sample: 'name', custom: tr('Съешь же ещё этих мягких французских булок'), kind: 'all', cyrillic: false, favorites: [], recent: [] };
  try {
    return { ...base, ...((JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<PickerPrefs> | null) ?? {}) };
  } catch {
    return base;
  }
}

function savePickerPrefs(p: PickerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // not kept
  }
}

export class FontPicker implements Field {
  readonly el: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly name: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly read: () => Mixed<string> | null;
  private readonly write: (family: string) => void;
  private readonly doc: () => Document;
  private popover: HTMLElement | null = null;
  private readonly action: HTMLButtonElement;
  private actionKind: 'embed' | 'google' | 'file' | null = null;

  private readonly options: FontPickerOptions;

  constructor(doc: () => Document, read: () => Mixed<string> | null, write: (family: string) => void, options: FontPickerOptions = {}) {
    this.options = options;
    this.doc = doc;
    this.read = read;
    this.write = write;
    this.name = h('span', { class: 'font-name' });
    this.button = h('button', { class: 'field font-button', type: 'button', title: tr('Выбрать шрифт'), 'aria-haspopup': 'listbox', onclick: () => this.toggle() }, this.name, icon('chevronDown', 14));
    this.warning = h('p', { class: 'warning font-warning', hidden: true });
    this.action = h('button', { class: 'link-button font-action', type: 'button', hidden: true });
    this.action.addEventListener('click', () => void this.runAction());
    this.el = h('div', { class: 'font-picker' }, this.button, this.warning, this.action);
    this.refresh();
  }

  refresh(): void {
    const value = this.read();
    this.button.disabled = value === null;
    const family = value === null ? '' : value === MIXED ? tr('Смешанное') : (this.options.label?.(value) ?? value);
    this.name.textContent = family;
    this.name.style.fontFamily = value && value !== MIXED ? `"${value}", system-ui` : '';
    const doc = this.doc();
    const single = typeof value === 'string' ? value : null;
    const inFile = !!single && embeddedFonts(doc).some((f) => f.family === single);
    const missing = !!single && single !== 'system-ui' && !inFile && !isFontAvailable(single);
    // Installed here but not in the file: others may see a substitute.
    const localOnly = !!single && !missing && !inFile && !EVERYWHERE.has(single) && !doc.readOnly;
    this.warning.hidden = !missing && !localOnly;
    this.warning.classList.toggle('subtle', localOnly);
    this.warning.textContent = missing
      ? tr('Шрифт «{0}» не установлен на этом компьютере — показан похожим.', single)
      : localOnly
        ? tr('Шрифт есть на этом компьютере, у других его может не быть.')
        : '';
    // A missing font: Google Fonts first (unless it was not there), then a font file.
    const fromGoogle = !!single && !notOnGoogle.has(single);
    this.actionKind = missing && !doc.readOnly ? (fromGoogle ? 'google' : 'file') : localOnly ? 'embed' : null;
    this.action.hidden = !this.actionKind;
    this.action.textContent = this.actionKind === 'embed' ? tr('Встроить в файл') : this.actionKind === 'google' ? tr('Загрузить из Google Fonts') : tr('Добавить файл шрифта…');
  }

  private async runAction(): Promise<void> {
    const family = this.read();
    if (typeof family !== 'string') return;
    this.action.disabled = true;
    try {
      if (this.actionKind === 'file') {
        const message = await addFontFiles(this.doc());
        if (message) this.warning.textContent = message;
        return;
      }
      // Google Fonts serves every browser (the local fonts API is Chrome and Edge only).
      const g = await embedGoogleFamilies(this.doc(), [family]);
      if (g.embedded.length) return;
      if (g.missing.length) notOnGoogle.add(family);
      if (this.actionKind === 'google') {
        this.warning.textContent = g.missing.length ? tr('Шрифта «{0}» нет в Google Fonts — добавьте файл шрифта.', family) : tr('Не удалось загрузить шрифт: нет связи с сервером. Можно добавить файл шрифта.');
        this.actionKind = 'file';
        this.action.textContent = tr('Добавить файл шрифта…');
        return;
      }
      const res = await embedLocalFamily(this.doc(), family);
      if (res.error) {
        this.warning.textContent = res.error;
        this.action.textContent = tr('Добавить файл шрифта…');
        this.actionKind = 'file';
      }
    } finally {
      this.action.disabled = false;
    }
  }

  dispose(): void {
    this.close();
  }

  private toggle(): void {
    if (this.popover) this.close();
    else this.open();
  }

  /** Ends the live preview (the canvas shows what it was); set while the list is open. */
  private endPreview: () => void = () => {};

  private close(): void {
    this.endPreview();
    this.endPreview = () => {};
    this.popover?.remove();
    this.popover = null;
    document.removeEventListener('pointerdown', this.outside, true);
  }

  private readonly outside = (e: PointerEvent) => {
    if (this.popover && !this.popover.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.close();
  };

  private open(): void {
    const prefs = pickerPrefs();
    const search = h('input', { class: 'font-search', type: 'search', placeholder: tr('Поиск шрифта'), spellcheck: false, 'aria-label': tr('Поиск шрифта') });
    const list = h('div', { class: 'font-list', role: 'listbox' });
    const footer = h('div', { class: 'font-footer' });
    // Filters and the sample (FEAT-153).
    const kinds: [KindFilter, string, string][] = [
      ['all', tr('Все'), tr('Все шрифты')],
      ['sans', tr('Гротески'), tr('Без засечек')],
      ['serif', tr('Антиквы'), tr('С засечками')],
      ['mono', tr('Моно'), tr('Моноширинные: все знаки одной ширины')],
      ['display', tr('Акцидентные'), tr('Рукописные и декоративные — для заголовков')],
    ];
    const chips = h('div', { class: 'font-chips', role: 'radiogroup', 'aria-label': tr('Вид шрифта') });
    const chipEls = kinds.map(([value, label, title]) => {
      const b = h('button', { class: 'font-chip', type: 'button', role: 'radio', title }, label);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        prefs.kind = value;
        savePickerPrefs(prefs);
        syncChips();
        render();
      });
      chips.append(b);
      return b;
    });
    const cyr = h('input', { type: 'checkbox', checked: prefs.cyrillic }) as HTMLInputElement;
    cyr.addEventListener('change', () => {
      prefs.cyrillic = cyr.checked;
      savePickerPrefs(prefs);
      render();
    });
    const syncChips = () => chipEls.forEach((b, i) => {
      b.classList.toggle('on', kinds[i]![0] === prefs.kind);
      b.setAttribute('aria-checked', String(kinds[i]![0] === prefs.kind));
    });
    syncChips();
    const sampleSelect = h(
      'select',
      { class: 'field-select font-sample-mode', 'aria-label': tr('Образец'), title: tr('Чем показывать шрифты в списке') },
      h('option', { value: 'name', selected: prefs.sample === 'name' }, tr('Название')),
      h('option', { value: 'layer', selected: prefs.sample === 'layer', disabled: !this.options.sample?.() }, tr('Текст слоя')),
      h('option', { value: 'custom', selected: prefs.sample === 'custom' }, tr('Свой текст')),
    ) as HTMLSelectElement;
    const customInput = h('input', { class: 'font-search font-sample-text', type: 'text', value: prefs.custom, spellcheck: false, 'aria-label': tr('Свой текст образца'), hidden: prefs.sample !== 'custom' }) as HTMLInputElement;
    sampleSelect.addEventListener('change', () => {
      prefs.sample = sampleSelect.value as SampleMode;
      customInput.hidden = prefs.sample !== 'custom';
      savePickerPrefs(prefs);
      render();
      if (prefs.sample === 'custom') customInput.focus();
    });
    customInput.addEventListener('input', () => {
      prefs.custom = customInput.value;
      savePickerPrefs(prefs);
      render();
    });
    customInput.addEventListener('keydown', (e) => e.stopPropagation());
    sampleSelect.addEventListener('keydown', (e) => e.stopPropagation());
    const tools = h(
      'div',
      { class: 'font-tools' },
      chips,
      h('div', { class: 'font-tools-row' }, h('label', { class: 'font-cyr' }, cyr, h('span', {}, tr('С кириллицей'))), sampleSelect),
      customInput,
    );
    const popover = h('div', { class: 'font-popover' }, h('div', { class: 'font-search-wrap' }, icon('text', 14), search), tools, list, footer);
    this.popover = popover;
    document.body.append(popover);
    const r = this.button.getBoundingClientRect();
    const width = Math.max(320, r.width);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width))}px`;
    // On the side with more room, never taller than that room: it opened below with 320 px free and,
    // 420 px tall, ran off the screen («Заменить шрифты» low in the window — 1 November).
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const down = below >= 420 || below >= above;
    if (down) popover.style.top = `${r.bottom + 4}px`;
    else popover.style.bottom = `${window.innerHeight - r.top + 4}px`;
    popover.style.maxHeight = `${Math.max(200, Math.min(420, down ? below : above))}px`;
    document.addEventListener('pointerdown', this.outside, true);

    let active = 0;
    let items: HTMLElement[] = [];
    let families: string[] = [];
    const current = this.read();
    // Live preview: the family under the pointer (or the keyboard), shown on the canvas.
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    let previewing: string | null = null;
    const preview = (family: string | null) => {
      if (!this.options.preview) return;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = null;
        if (family === previewing) return;
        previewing = family;
        this.options.preview?.(family);
      }, family ? 70 : 0);
    };
    this.endPreview = () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = null;
      if (previewing !== null) this.options.preview?.(null);
      previewing = null;
    };
    list.addEventListener('pointerleave', () => preview(null));
    const sampleText = (family: string, label: string) => {
      if (prefs.sample === 'custom' && prefs.custom.trim()) return prefs.custom;
      if (prefs.sample === 'layer') {
        const t = this.options.sample?.()?.replace(/\s+/g, ' ').trim();
        if (t) return t.length > 48 ? `${t.slice(0, 48)}…` : t;
      }
      return label || family;
    };
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const alt = switchLayout(q);
      const label = (f: string) => this.options.label?.(f) ?? f;
      const match = (f: string) => !q || [f, label(f)].some((s) => s.toLowerCase().includes(q) || s.toLowerCase().includes(alt));
      // Filters read the letters of installed fonts only (a missing one would measure as its fallback).
      const filtered = (f: string) => {
        if (prefs.kind === 'all' && !prefs.cyrillic) return true;
        if (f === 'system-ui') return prefs.kind === 'all' || prefs.kind === 'sans';
        if (!isFontAvailable(f)) return false;
        const t = fontTraits(f);
        return (prefs.kind === 'all' || t.kind === prefs.kind) && (!prefs.cyrillic || t.cyrillic);
      };
      const groups: [string, string[]][] = [
        [tr('Избранные'), prefs.favorites],
        [tr('Недавние'), prefs.recent],
        ...(this.options.first ?? []),
        [tr('Встроены в файл'), [...new Set(embeddedFonts(this.doc()).map((f) => f.family))]],
        [tr('В этом файле'), familiesInFile(this.doc())],
        [tr('Встроены в редактор'), ['Inter']],
        [tr('Установлены на компьютере'), systemFamilies ?? commonInstalled()],
      ];
      clear(list);
      items = [];
      const seen = new Set<string>();
      families = [];
      for (const [title, group] of groups) {
        const shown = group.filter((f) => match(f) && !seen.has(f) && filtered(f));
        if (shown.length === 0) continue;
        list.append(h('div', { class: 'font-group' }, title));
        for (const family of shown) {
          seen.add(family);
          const available = family === 'system-ui' || isFontAvailable(family);
          const starred = prefs.favorites.includes(family);
          const star = h('button', { class: `font-star${starred ? ' on' : ''}`, type: 'button', title: starred ? tr('Убрать из избранных') : tr('В избранные'), 'aria-label': starred ? tr('Убрать из избранных') : tr('В избранные'), 'aria-pressed': String(starred) }, starred ? '★' : '☆');
          star.addEventListener('pointerdown', (e) => e.preventDefault());
          star.addEventListener('click', (e) => {
            e.stopPropagation();
            prefs.favorites = starred ? prefs.favorites.filter((f) => f !== family) : [...prefs.favorites, family];
            savePickerPrefs(prefs);
            render();
          });
          const shownLabel = label(family);
          const text = sampleText(family, shownLabel);
          const item = h(
            'div',
            { class: `font-item${family === current ? ' selected' : ''}${available ? '' : ' missing'}${text !== shownLabel ? ' with-sample' : ''}`, role: 'option', 'aria-selected': String(family === current), title: available ? family : tr('{0} — не установлен', family) },
            h('span', { class: 'font-preview', style: { fontFamily: `"${family}", system-ui` } }, text),
            text !== shownLabel ? h('span', { class: 'font-caption' }, shownLabel) : null,
            available ? null : h('span', { class: 'font-missing' }, tr('нет')),
            star,
          );
          item.addEventListener('pointerdown', (e) => e.preventDefault());
          item.addEventListener('click', () => this.choose(family));
          item.addEventListener('pointerenter', () => available && preview(family));
          items.push(item);
          families.push(family);
          list.append(item);
        }
      }
      // A name typed exactly but not in the lists can still be used (e.g. a font installed later).
      const typed = search.value.trim();
      if (typed && !seen.has(typed)) {
        const item = h('div', { class: 'font-item' }, h('span', { class: 'font-preview', style: { fontFamily: `"${typed}", system-ui` } }, tr('Использовать «{0}»', typed)));
        item.addEventListener('click', () => this.choose(typed));
        items.push(item);
        list.append(item);
      }
      if (items.length === 0) list.append(h('p', { class: 'hint' }, tr('Ничего не найдено')));
      active = Math.max(0, items.findIndex((i) => i.classList.contains('selected')));
      highlight();
    };
    const highlight = (show = false) => {
      items.forEach((item, i) => item.classList.toggle('active', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
      // Walking the list with the arrows previews each family, as the pointer does.
      const family = families[active];
      if (show && family && (family === 'system-ui' || isFontAvailable(family))) preview(family);
    };
    search.addEventListener('input', () => {
      render();
      active = 0;
      highlight();
    });
    search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        highlight(true);
      } else if (e.key === 'Enter') {
        items[active]?.click();
      } else if (e.key === 'Escape') {
        this.close();
        this.button.focus();
      }
    });
    const addFile = h('button', { class: 'text-button wide', type: 'button' }, h('span', {}, tr('Добавить шрифт из файла…')));
    addFile.addEventListener('click', async () => {
      const message = await addFontFiles(this.doc());
      if (message) footer.append(h('p', { class: 'hint small' }, message));
      render();
    });
    footer.append(addFile);
    const hasApi = 'queryLocalFonts' in window;
    if (hasApi && !systemFamilies) {
      const more = h('button', { class: 'text-button wide', type: 'button' }, h('span', {}, tr('Показать все шрифты компьютера')));
      more.addEventListener('click', async () => {
        more.disabled = true;
        const result = await loadSystemFonts();
        if (result) {
          more.remove();
          render();
        } else {
          more.disabled = false;
          footer.append(h('p', { class: 'hint small' }, tr('Браузер не дал доступ к списку шрифтов. Разрешите «Шрифты» в настройках сайта.')));
        }
      });
      footer.append(more);
    } else if (!hasApi) {
      footer.append(h('p', { class: 'hint small' }, tr('Показаны распространённые шрифты, найденные на компьютере. Полный список доступен в Chrome и Edge.')));
    }
    render();
    search.focus();
  }

  private choose(family: string): void {
    this.close();
    // Recent families first, eight at most.
    const prefs = pickerPrefs();
    prefs.recent = [family, ...prefs.recent.filter((f) => f !== family)].slice(0, 8);
    savePickerPrefs(prefs);
    this.write(family);
    this.button.focus();
  }
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

const weightCache = new Map<string, Set<number>>();

/**
 * Weights that the family really has on this computer: each real face has its own
 * glyph widths, while a missing weight falls back to a neighbour (same widths) or
 * is imitated by the browser. Bundled variable fonts have every weight.
 */
export function realWeights(family: string): Set<number> {
  const cached = weightCache.get(family);
  if (cached) return cached;
  const all = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  let result: Set<number>;
  if (family === 'Inter' || typeof document === 'undefined') result = new Set(all);
  else {
    probe ??= document.createElement('canvas').getContext('2d');
    const ctx = probe;
    if (!ctx) result = new Set(all);
    else {
      const sample = tr('The quick brown fox jumps 0123456789 Съешь же ещё');
      const widths = all.map((w) => {
        ctx.font = `${w} 64px "${family}", monospace`;
        return ctx.measureText(sample).width;
      });
      result = new Set<number>([400]);
      all.forEach((w, i) => {
        // A weight is real if it differs from the neighbour it would fall back to.
        const fallback = w < 400 ? widths[i + 1]! : w > 400 ? widths[i - 1]! : null;
        if (fallback !== null && Math.abs(widths[i]! - fallback) > 0.5) result.add(w);
      });
    }
  }
  weightCache.set(family, result);
  return result;
}

/** Weight select listing the family's real weights; others are marked as imitated. */
export class WeightField implements Field {
  readonly el: HTMLElement;
  private readonly select: HTMLSelectElement;
  private family: string | null = null;
  private readonly readFamily: () => Mixed<string> | null;
  private readonly read: () => Mixed<number> | null;

  constructor(readFamily: () => Mixed<string> | null, read: () => Mixed<number> | null, write: (weight: number) => void) {
    this.readFamily = readFamily;
    this.read = read;
    this.select = h('select', { class: 'field-select', 'aria-label': tr('Начертание'), title: tr('Начертание') });
    this.select.addEventListener('change', () => write(Number(this.select.value)));
    this.select.addEventListener('keydown', (e) => e.stopPropagation());
    this.el = h('div', { class: 'field select-wrap' }, this.select);
    this.refresh();
  }

  refresh(): void {
    const familyValue = this.readFamily();
    const family = typeof familyValue === 'string' ? familyValue : '';
    if (family !== this.family) {
      this.family = family;
      clear(this.select);
      const real = family ? realWeights(family) : new Set(Object.keys(WEIGHT_NAMES).map(Number));
      for (const [w, name] of Object.entries(WEIGHT_NAMES)) {
        const has = real.has(Number(w));
        this.select.append(h('option', { value: w }, has ? `${name} ${w}` : tr('{0} {1} — имитация', name, w)));
      }
    }
    const value = this.read();
    this.select.disabled = value === null;
    mixedOption(this.select, value === MIXED);
    this.select.value = value === null ? '' : value === MIXED ? '__mixed' : String(Math.round(value / 100) * 100);
  }
}

type RunReader = <K extends 'fontWeight' | 'italic' | 'textDecoration' | 'baseline'>(key: K) => unknown;

/** Bold, italic, underline, strikethrough, superscript and subscript toggles. */
export class TextStyleButtons implements Field {
  readonly el: HTMLElement;
  private readonly buttons: { el: HTMLButtonElement; active: () => boolean }[] = [];
  private readonly run: RunReader;

  constructor(editor: { toggleTextStyle(kind: 'bold' | 'italic' | 'underline' | 'strike'): void; applyTextStyle(patch: { baseline: 'NORMAL' | 'SUPER' | 'SUB' }, label?: string): void }, run: RunReader) {
    this.run = run;
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
    const make = (label: string, title: string, cls: string, onclick: () => void, active: () => boolean) => {
      const el = h('button', { class: `segment text-style ${cls}`, type: 'button', title, 'aria-label': title, onclick }, label);
      el.addEventListener('pointerdown', (e) => e.preventDefault());
      this.buttons.push({ el, active });
      return el;
    };
    const baseline = (value: 'SUPER' | 'SUB') => () => editor.applyTextStyle({ baseline: this.run('baseline') === value ? 'NORMAL' : value }, value === 'SUPER' ? tr('Верхний индекс') : tr('Нижний индекс'));
    this.el = h(
      'div',
      { class: 'segmented text-styles', role: 'group', 'aria-label': tr('Начертание и оформление') },
      make('B', tr('Жирный ({0}B)', mod), 'bold', () => editor.toggleTextStyle('bold'), () => { const w = this.run('fontWeight'); return typeof w === 'number' && w >= 600; }),
      make('I', tr('Курсив ({0}I)', mod), 'italic', () => editor.toggleTextStyle('italic'), () => this.run('italic') === true),
      make('U', tr('Подчёркнутый ({0}U)', mod), 'underline', () => editor.toggleTextStyle('underline'), () => this.run('textDecoration') === 'UNDERLINE'),
      make('S', tr('Зачёркнутый ({0}Shift+X)', mod), 'strike', () => editor.toggleTextStyle('strike'), () => this.run('textDecoration') === 'STRIKETHROUGH'),
      make('x²', tr('Верхний индекс (для выделенной части текста)'), 'sup', baseline('SUPER'), () => this.run('baseline') === 'SUPER'),
      make('x₂', tr('Нижний индекс (для выделенной части текста)'), 'sub', baseline('SUB'), () => this.run('baseline') === 'SUB'),
    );
    this.refresh();
  }

  refresh(): void {
    for (const b of this.buttons) b.el.classList.toggle('active', b.active());
  }
}
