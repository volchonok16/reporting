// Interface language (item 6 of the October list): Russian and English.
// The Russian text is the key, as in gettext: `tr('Файл')` gives "File" in
// English and the text itself in Russian — and wherever a translation is
// missing, so nothing is ever blank. Placeholders are {0}, {1}…
// The language is chosen once per page load (a switch reloads the page), so
// texts computed when modules load are translated too.

import { EN } from './i18n-en.ts';

export type Lang = 'ru' | 'en';

export const LANG_KEY = 'cs-lang';

function detect(): Lang {
  try {
    const saved = globalThis.localStorage?.getItem(LANG_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // storage unavailable
  }
  const nav = (globalThis.navigator?.languages ?? [globalThis.navigator?.language ?? 'ru']).join(',');
  // Russian for Russian, Ukrainian, Belarusian, Kazakh speakers; English for everyone else. No browser (tests, server): Russian.
  if (typeof document === 'undefined') return 'ru';
  return /(^|,)(ru|uk|be|kk)\b/i.test(nav) ? 'ru' : 'en';
}

export let lang: Lang = detect();

/** For tests: switch the language without a page reload. */
export function setLangForTests(next: Lang): void {
  lang = next;
}

/** Translated text with {0}, {1}… filled in. */
export function tr(text: string, ...args: unknown[]): string {
  const s = lang === 'en' ? (EN[text] ?? text) : text;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;
}

/** A count with its noun: Russian has three forms (1 слайд, 2 слайда, 5 слайдов), English two. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === 'en') return n === 1 ? tr(one) : tr(many);
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** The product's name (Latin letters in the English interface). */
export function brand(): string {
  return lang === 'en' ? 'Simmetrika' : 'Симметрика';
}

/** Locale for dates, times and sorting. */
export function locale(): string {
  return lang === 'en' ? 'en-US' : 'ru-RU';
}

/** Saves the choice and reloads, so every text is built in the new language. */
export function switchLang(next: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // not remembered: the browser language decides next time
  }
  location.reload();
}
