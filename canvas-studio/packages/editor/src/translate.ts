// Translate text layers (October list, "AI without AI"): the browser's own
// on-device translator (Chrome 138+, the Translator API) — free, private,
// no server. Where the browser has none, the command says so.

import { tr } from '#core';

interface TranslatorLike {
  translate(text: string): Promise<string>;
}
interface TranslatorApi {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<TranslatorLike>;
}

export const TARGET_LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['ru', 'Русский'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['uk', 'Українська'],
  ['kk', 'Қазақша'],
  ['zh', '中文'],
  ['ja', '日本語'],
  ['tr', 'Türkçe'],
];

function api(): TranslatorApi | null {
  return ((globalThis as { Translator?: TranslatorApi }).Translator as TranslatorApi | undefined) ?? null;
}

interface DetectorApi {
  create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }>;
}

/**
 * The language of a text by the browser's own detector (LanguageDetector API,
 * the same browsers); without it — the rough guess below.
 */
async function detector(): Promise<(text: string) => Promise<string>> {
  const D = (globalThis as { LanguageDetector?: DetectorApi }).LanguageDetector;
  if (!D) return async (t) => guessLanguage(t);
  try {
    const d = await D.create();
    return async (t) => {
      const best = (await d.detect(t))[0];
      return best && best.confidence >= 0.5 && best.detectedLanguage !== 'und' ? best.detectedLanguage.split('-')[0]! : guessLanguage(t);
    };
  } catch {
    return async (t) => guessLanguage(t);
  }
}

export function canTranslate(): boolean {
  return api() !== null;
}

/** Rough source language when the browser cannot tell: Cyrillic → Russian (Ukrainian letters → Ukrainian), otherwise English. */
export function guessLanguage(text: string): string {
  if (/[іїєґ]/i.test(text)) return 'uk';
  if (/[а-яё]/i.test(text)) return 'ru';
  return 'en';
}

/** Translates texts; groups them by source language. Throws a readable error. */
export async function translateTexts(texts: string[], target: string, onProgress: (text: string) => void = () => {}): Promise<string[]> {
  const T = api();
  if (!T) throw new Error(tr('Этот браузер не умеет переводить на устройстве. Перевод работает в Chrome 138 и новее.'));
  const out = texts.slice();
  const bySource = new Map<string, number[]>();
  const detect = await detector();
  for (const [i, t] of texts.entries()) {
    const src = await detect(t);
    if (src !== target) bySource.set(src, [...(bySource.get(src) ?? []), i]);
  }
  for (const [source, indexes] of bySource) {
    const status = await T.availability({ sourceLanguage: source, targetLanguage: target });
    if (status === 'unavailable') throw new Error(tr('Браузер не умеет переводить с «{0}» на «{1}».', source, target));
    if (status !== 'available') onProgress(tr('Скачиваю языковую модель браузера…'));
    const translator = await T.create({ sourceLanguage: source, targetLanguage: target });
    for (const i of indexes) out[i] = await translator.translate(texts[i]!);
  }
  return out;
}
