// Interface settings follow the account. Each setting is still read from
// localStorage (the app starts before the network answers), but for someone
// signed in the server keeps the master copy: on start the account's values
// are written over the local ones, and every change goes back to the server.
// Without an account the settings stay in this browser, as before.

import { lang, LANG_KEY, switchLang, type Lang } from '#core';
import { applyTheme } from './theme.ts';

/** Kept with the account; the same list is checked by the server. */
export const SYNCED_PREFS = [LANG_KEY, 'cs-theme', 'cs-ui-scale', 'cs-dock-place', 'cs.view', 'cs.panels', 'cs.mail-comments', 'cs-context-bar', 'cs-nudge', 'cs.content-sets', 'cs.board-templates'] as const;

/** How far the arrows move layers (Figma's «Nudge amount»): an arrow and Shift+arrow, stored as "1,10". */
export const NUDGE_KEY = 'cs-nudge';
export const DEFAULT_NUDGE = { small: 1, big: 10 };

export function savedNudge(): { small: number; big: number } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NUDGE_KEY);
  } catch {
    raw = null;
  }
  const [small, big] = (raw ?? '').split(',').map(Number);
  const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1000;
  return { small: ok(small) ? small : DEFAULT_NUDGE.small, big: ok(big) ? big : DEFAULT_NUDGE.big };
}

let signedIn = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function localValues(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of SYNCED_PREFS) {
    try {
      out[key] = localStorage.getItem(key);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

function send(keepalive = false): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return fetch('/api/me/prefs', {
    method: 'PUT',
    credentials: 'same-origin',
    keepalive,
    headers: { 'X-CS': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs: localValues() }),
  }).then(
    () => undefined,
    () => undefined, // offline: the next change sends everything again
  );
}

/**
 * The account's settings arrived (start, sign-in). An account without any yet
 * takes this browser's. Returns true when the language differs from the page's
 * (the page must reload to rebuild every text).
 */
export function adoptAccountPrefs(prefs: Record<string, string> | undefined): boolean {
  signedIn = true;
  if (!prefs || Object.keys(prefs).length === 0) {
    void send();
    return false;
  }
  try {
    for (const key of SYNCED_PREFS) {
      const value = prefs[key];
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  } catch {
    return false;
  }
  applyTheme();
  const wanted = prefs[LANG_KEY];
  return (wanted === 'ru' || wanted === 'en') && wanted !== lang;
}

/** Settings go to an account (someone is signed in): account-only settings are shown. */
export function prefsSignedIn(): boolean {
  return signedIn;
}

/** A setting changed in localStorage: send the settings to the account soon. */
export function prefsChanged(): void {
  if (!signedIn) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void send(), 800);
}

/** Sends a pending change at once (before a reload). */
export function flushPrefs(): Promise<void> {
  return signedIn ? send() : Promise.resolve();
}

/**
 * Another interface language: the account gets it first, then the page reloads in it.
 * The menu's «Interface language: English» only wrote it in this browser — the account's
 * «ru» came back with the reload and nothing changed (1 November).
 */
export function changeLang(next: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // not remembered here: the account still gets it
  }
  void flushPrefs().then(() => switchLang(next));
}

/** Signed out: settings stay in this browser only. */
export function forgetAccountPrefs(): void {
  signedIn = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

if (typeof window !== 'undefined') {
  // Closing the tab right after a change: the change still goes out.
  window.addEventListener('pagehide', () => {
    if (timer) void send(true);
  });
}
