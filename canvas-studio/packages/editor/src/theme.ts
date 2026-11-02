// Light or dark interface: as the system (default), or chosen in Settings.
// The choice is kept in this browser and set as <html data-theme>; the
// stylesheet reads it, and the canvas asks `isDark()` when it draws.

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'cs-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Whether the interface is dark now. */
export function isDark(): boolean {
  const set = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  if (set === 'dark') return true;
  if (set === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

/** Applies a choice (and remembers it when asked); everyone drawing by theme hears 'cs-theme'. */
export function applyTheme(choice: ThemeChoice = savedTheme(), remember = false): void {
  if (remember) {
    try {
      if (choice === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch {
      // works for this page only
    }
  }
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', choice === 'system' ? 'light dark' : choice);
  window.dispatchEvent(new Event('cs-theme'));
}

/** Calls back whenever the interface switches between light and dark (by the system or by choice). */
export function onThemeChange(fn: () => void): void {
  if (typeof matchMedia === 'function') matchMedia(DARK_QUERY).addEventListener('change', fn);
  window.addEventListener('cs-theme', fn);
}
