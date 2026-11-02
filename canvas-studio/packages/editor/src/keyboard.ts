// Keyboard shortcuts. Shortcuts are written as "Mod+Shift+K" where Mod is Cmd on
// macOS and Ctrl elsewhere (spec 1.4). Letters and digits match the physical key
// (KeyboardEvent.code), so shortcuts work on the Russian layout too.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Parsed {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  codes: string[];
}

const NAMED: Record<string, string[]> = {
  '=': ['Equal', 'NumpadAdd'],
  '+': ['Equal', 'NumpadAdd'],
  '-': ['Minus', 'NumpadSubtract'],
  '[': ['BracketLeft'],
  ']': ['BracketRight'],
  '\\': ['Backslash', 'IntlBackslash'],
  '/': ['Slash'],
  ',': ['Comma'],
  '.': ['Period'],
  "'": ['Quote'],
  Delete: ['Delete', 'Backspace'],
  Backspace: ['Backspace'],
  Enter: ['Enter', 'NumpadEnter'],
  Escape: ['Escape'],
  Tab: ['Tab'],
  Space: ['Space'],
  ArrowUp: ['ArrowUp'],
  ArrowDown: ['ArrowDown'],
  ArrowLeft: ['ArrowLeft'],
  ArrowRight: ['ArrowRight'],
  PageUp: ['PageUp'],
  PageDown: ['PageDown'],
};

function parse(shortcut: string): Parsed {
  const parts = shortcut.split('+').filter((p, i, all) => p !== '' || i === all.length - 1);
  // "Mod++" style is not used; "+" is written as "=" or "Plus".
  const key = parts.pop() ?? '';
  const parsed: Parsed = { mod: false, shift: false, alt: false, ctrl: false, codes: [] };
  for (const p of parts) {
    if (p === 'Mod') parsed.mod = true;
    else if (p === 'Shift') parsed.shift = true;
    else if (p === 'Alt') parsed.alt = true;
    else if (p === 'Ctrl') {
      // On Windows and Linux Ctrl is the Mod key itself.
      if (IS_MAC) parsed.ctrl = true;
      else parsed.mod = true;
    }
  }
  if (key === 'Plus') parsed.codes = NAMED['+']!;
  else if (NAMED[key]) parsed.codes = NAMED[key]!;
  else if (/^[A-Z]$/i.test(key)) parsed.codes = [`Key${key.toUpperCase()}`];
  else if (/^[0-9]$/.test(key)) parsed.codes = [`Digit${key}`, `Numpad${key}`];
  else parsed.codes = [key];
  return parsed;
}

const cache = new Map<string, Parsed>();

export function matches(event: KeyboardEvent, shortcut: string): boolean {
  let p = cache.get(shortcut);
  if (!p) {
    p = parse(shortcut);
    cache.set(shortcut, p);
  }
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  const ctrlExtra = IS_MAC ? event.ctrlKey : false;
  if (p.mod !== mod) return false;
  if (p.shift !== event.shiftKey) return false;
  if (p.alt !== event.altKey) return false;
  if (p.ctrl !== ctrlExtra) return false;
  return p.codes.includes(event.code);
}

/** Human-readable shortcut for the current platform. */
export function formatShortcut(shortcut: string): string {
  if (!shortcut) return '';
  const symbols: Record<string, string> = IS_MAC
    ? { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Delete: '⌫', Enter: '↵', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
    : { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl', Delete: 'Del', Enter: 'Enter', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const raw = shortcut.split('+');
  const key = raw.pop() ?? '';
  // Apple order is ⌃⌥⇧⌘; elsewhere Ctrl+Alt+Shift.
  const order = IS_MAC ? ['Ctrl', 'Alt', 'Shift', 'Mod'] : ['Mod', 'Ctrl', 'Alt', 'Shift'];
  const mods = order.filter((m) => raw.includes(m)).map((m) => symbols[m] ?? m);
  const parts = [...mods, symbols[key] ?? (key === 'Plus' ? '+' : key)];
  return IS_MAC ? parts.join('') : parts.join('+');
}

/** Whether keyboard focus is in a text field (shortcuts must not fire there). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'color', 'range'].includes(target.type);
  }
  return target instanceof HTMLSelectElement;
}

// Russian ЙЦУКЕН ↔ English QWERTY, for searching commands typed in the wrong layout (FR-UI-020).
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю';
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";

export function switchLayout(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const ri = RU.indexOf(ch);
    if (ri >= 0) {
      out += EN.charAt(ri);
      continue;
    }
    const ei = EN.indexOf(ch);
    out += ei >= 0 ? RU.charAt(ei) : ch;
  }
  return out;
}
