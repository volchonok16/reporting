// The person's own neural network (6 November): an address of an OpenAI-compatible
// API, a model and a key, set in «Настройки → Нейросеть». Used only by them,
// for layouts by description, texts, speaker notes and layer names, instead of
// Simmetrika's server — so these work without our server (the macOS app, a
// file host) and without its daily limits.
//
// Where it lives: in the macOS app the key is in the Keychain and the app adds it
// to each request itself (apps/macos/Sources/OwnAi.swift; the page asks
// simmetrika://app/ai-own/chat/completions and never holds the key after saving).
// In a browser it is in this browser's storage only (never synced with the
// account, never sent to our server), and the page asks the API directly: the
// server lets the page reach that one origin by a cookie with it (static.ts
// aiOrigin), which takes effect with the next page load.

import { AiError, type AiConfig } from '../../core/src/ai-layout.ts';
import { askText, parseAnswer } from '../../core/src/ai-text.ts';
import { tr } from '#core';

export interface OwnAiSettings {
  url: string;
  model: string;
  /** In a browser: the key itself; in the app it stays there and this is '' (see hasKey). */
  key: string;
  hasKey: boolean;
}

/** Ready-made addresses: a click fills the address and the model. */
export const OWN_AI_PRESETS: { name: string; url: string; model: string }[] = [
  { name: 'DeepSeek', url: 'https://api.deepseek.com/', model: 'deepseek-chat' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/', model: 'deepseek/deepseek-chat' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1/', model: 'gpt-4.1-mini' },
];

const STORE_KEY = 'cs.own-ai';
const COOKIE = 'cs-ai-origin';

interface AppBridge {
  postMessage(message: { op: 'get' } | { op: 'set'; url: string; model: string; key?: string } | { op: 'clear' }): Promise<unknown>;
}
const app = (): AppBridge | null => (globalThis as unknown as { webkit?: { messageHandlers?: { csAi?: AppBridge } } }).webkit?.messageHandlers?.csAi ?? null;

/** Whether the key is kept by the macOS app (the Keychain) rather than by this page. */
export const keyInApp = (): boolean => app() !== null;

let cached: OwnAiSettings | null | undefined;

/** The address as the API's base, ending in «/» («https://api.deepseek.com» → «https://api.deepseek.com/»). */
export function normalizeUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  url.search = '';
  url.hash = '';
  // A pasted endpoint is taken as its base.
  url.pathname = url.pathname.replace(/chat\/completions\/?$/, '');
  return url.pathname.endsWith('/') ? url.href : `${url.href}/`;
}

/** The settings, or null when none are set (then the server is asked, as before). */
export async function ownAi(): Promise<OwnAiSettings | null> {
  if (cached !== undefined) return cached;
  const bridge = app();
  if (bridge) {
    try {
      const v = (await bridge.postMessage({ op: 'get' })) as { url?: string; model?: string; hasKey?: boolean } | null;
      cached = v?.url && v.model && v.hasKey ? { url: v.url, model: v.model, key: '', hasKey: true } : null;
    } catch {
      cached = null;
    }
    return cached;
  }
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { url?: string; model?: string; key?: string } | null;
    cached = v?.url && v.model && v.key ? { url: v.url, model: v.model, key: v.key, hasKey: true } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** What the form shows: the address and model even without a key yet. */
export async function ownAiDraft(): Promise<{ url: string; model: string; hasKey: boolean }> {
  const bridge = app();
  if (bridge) {
    try {
      const v = (await bridge.postMessage({ op: 'get' })) as { url?: string; model?: string; hasKey?: boolean } | null;
      return { url: v?.url ?? '', model: v?.model ?? '', hasKey: !!v?.hasKey };
    } catch {
      return { url: '', model: '', hasKey: false };
    }
  }
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { url?: string; model?: string; key?: string } | null;
    return { url: v?.url ?? '', model: v?.model ?? '', hasKey: !!v?.key };
  } catch {
    return { url: '', model: '', hasKey: false };
  }
}

function setCookie(origin: string | null): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = origin ? `${COOKIE}=${encodeURIComponent(origin)}; Path=/; Max-Age=31536000; SameSite=Strict${secure}` : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  } catch {
    // no cookies: the page keeps its rules
  }
}

/** The origin this page may reach as it was loaded: the cookie then. A new one needs a reload (the rules come with the page). */
const loadedOrigin = (() => {
  try {
    const m = /(?:^|;\s*)cs-ai-origin=([^;]*)/.exec(document.cookie);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
})();

/** In a browser a new address works after a reload: the page's rules (CSP) allow the origin it was opened with. Not in the app. */
export function needsReload(url: string): boolean {
  if (app()) return false;
  try {
    return new URL(url).origin !== loadedOrigin;
  } catch {
    return false;
  }
}

/** Tells open windows (the layout dialog's note) that the settings changed. */
const changed = (): void => void dispatchEvent(new Event('cs:ai'));

/** Saves the settings; `key` undefined keeps the saved key (the form shows none). Throws with words for the person. */
export async function saveOwnAi(urlText: string, modelText: string, key: string | undefined): Promise<void> {
  const url = normalizeUrl(urlText);
  if (!url) throw new Error(tr('Адрес должен начинаться с https://, например https://api.deepseek.com/'));
  const model = modelText.trim();
  if (!model) throw new Error(tr('Укажите модель, например deepseek-chat'));
  const k = key?.trim();
  const bridge = app();
  cached = undefined;
  if (bridge) {
    await bridge.postMessage(k ? { op: 'set', url, model, key: k } : { op: 'set', url, model });
    return changed();
  }
  let old = '';
  try {
    old = (JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { key?: string } | null)?.key ?? '';
  } catch {
    old = '';
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ url, model, key: k || old }));
  } catch {
    throw new Error(tr('Браузер не дал сохранить настройки (приватный режим?)'));
  }
  setCookie(new URL(url).origin);
  changed();
}

/** Forgets the address, model and key: the server is asked again. */
export async function clearOwnAi(): Promise<void> {
  cached = undefined;
  const bridge = app();
  if (bridge) {
    await bridge.postMessage({ op: 'clear' });
    return changed();
  }
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // nothing kept
  }
  setCookie(null);
  changed();
}

/** The config for core's requests and the fetch that carries them: in the app through the app (it adds the key). */
let ownUrl = '';
export function ownTransport(s: OwnAiSettings): { config: AiConfig; fetcher: typeof fetch } {
  ownUrl = s.url;
  // Beget's gateway knows «reasoning: off»; OpenAI and others refuse an unknown field.
  const config: AiConfig = { url: s.url, key: s.key, model: s.model, reasoningOff: /(^|\.)beget\.com$/i.test(new URL(s.url).hostname) };
  if (!app()) return { config, fetcher: fetch.bind(globalThis) };
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete('Authorization');
    headers.set('X-CS', '1');
    return fetch('/ai-own/chat/completions', { ...init, headers, credentials: 'same-origin' });
  }) as typeof fetch;
  return { config, fetcher };
}

/** Words for the person from a failed request to their own API. */
export function ownAiMessage(error: unknown): string {
  if (error instanceof AiError) {
    if (error.message === 'aborted') return tr('Остановлено');
    switch (error.upstream) {
      case 401:
      case 403:
        return tr('Ваша нейросеть не приняла ключ. Проверьте его в Настройках → Нейросеть.');
      case 402:
        return tr('На счёте вашей нейросети закончились деньги.');
      case 404:
        return tr('По адресу из настроек нет такой модели. Проверьте адрес и название модели.');
      case 400:
      case 422:
        return tr('Ваша нейросеть отклонила запрос: {0}', error.message.replace(/^gateway \d+:\s*/, '').slice(0, 200));
      case 429:
        return tr('Ваша нейросеть просит подождать: слишком много запросов. Попробуйте через минуту.');
      case undefined:
        if (!app() && needsReload(ownUrl)) return tr('Обновите страницу: новый адрес нейросети заработает после перезагрузки.');
        return tr('Ваша нейросеть не отвечает. Проверьте адрес в Настройках → Нейросеть и интернет.');
      default:
        return tr('Ваша нейросеть ответила ошибкой {0}', error.upstream);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** No neural network at all: the server has none (or there is no server) and no own one is set. The dialogs offer to set one. */
export class AiMissingError extends Error {
  constructor(message = tr('Это делает нейросеть, а её здесь пока нет. Укажите адрес и ключ своей нейросети в Настройках, и всё заработает.')) {
    super(message);
  }
}

/** Opens «Настройки» at the neural network section (the app listens). */
export function openAiSettings(): void {
  dispatchEvent(new CustomEvent('cs:settings', { detail: { section: 'ai' } }));
}

/** A failed request told in a toast; with no neural network at all — with «Подключить нейросеть…». */
export function toastAiError(editor: { toast(message: string, kind?: 'info' | 'error', action?: { label: string; run: () => void }): void }, error: unknown, prefix = ''): void {
  const message = prefix + (error instanceof Error ? error.message : String(error));
  if (error instanceof AiMissingError) editor.toast(message, 'info', { label: tr('Подключить нейросеть…'), run: openAiSettings });
  else editor.toast(message);
}

/** A small request to the saved neural network: does the address, model and key work. Resolves with words for the person. */
export async function checkOwnAi(): Promise<string> {
  const own = await ownAi();
  if (!own) throw new Error(tr('Сначала укажите адрес, модель и ключ'));
  const { config, fetcher } = ownTransport(own);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const text = await askText(config, { task: 'names', lang: 'ru', items: [{ id: '0', type: 'FRAME', w: 120, h: 40, texts: ['Купить'], children: ['Купить'], parent: '', name: 'Frame 1', hint: '' }] }, ctl.signal, fetcher);
    if (!parseAnswer(text)) return tr('Нейросеть отвечает, но не в том виде, что нужен. Попробуйте другую модель.');
    return tr('Работает: {0} отвечает.', own.model);
  } catch (error) {
    throw new Error(ownAiMessage(error));
  } finally {
    clearTimeout(timer);
  }
}
