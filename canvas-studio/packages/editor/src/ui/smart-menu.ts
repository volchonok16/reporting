// The ✦ menu over the tool dock: smart actions that fit the selection
// (smart.ts), each with a line saying what exactly it will do.

import { tr } from '#core';
import type { Command } from '../commands.ts';
import type { Editor } from '../editor.ts';
import { formatShortcut } from '../keyboard.ts';
import { smartActions, type SmartAction } from '../smart.ts';
import { h, sparkles } from './dom.ts';

/** Opens the menu next to the ✦ button; returns a function that closes it. */
export function openSmartMenu(anchor: HTMLElement, place: string, editor: Editor, commands: Map<string, Command>, onClose: () => void): () => void {
  const menu = smartActions(editor);
  const el = h('div', { class: 'smart-menu', role: 'menu', 'aria-label': tr('Умные действия') });
  el.append(h('div', { class: 'smart-menu-head' }, sparkles(16), h('span', {}, menu.heading)));
  const items: HTMLButtonElement[] = [];
  for (const a of menu.actions) {
    const key = formatShortcut(commands.get(a.command)?.keys?.[0] ?? '');
    const item = h(
      'button',
      { class: `smart-item${a.primary ? ' primary' : ''}`, type: 'button', role: 'menuitem' },
      h('span', { class: 'smart-item-text' }, h('span', { class: 'smart-item-title' }, a.title), h('span', { class: 'smart-item-desc' }, a.desc)),
      key ? h('span', { class: 'smart-item-key' }, key) : '',
    );
    item.addEventListener('click', () => {
      if (a.ask) return askFirst(a.title, a.ask);
      close();
      commands.get(a.command)?.run();
    });
    items.push(item);
    el.append(item);
  }
  if (!items.length) el.append(h('p', { class: 'smart-empty' }, menu.empty));
  el.append(h('p', { class: 'smart-foot' }, tr('«Привести в порядок» работает на этом компьютере. Нейросети уходят только тексты и описание, не файл.')));

  // An action that needs a few words: the menu becomes a field with ready wishes.
  function askFirst(title: string, ask: NonNullable<SmartAction['ask']>): void {
    const input = h('input', { class: 'field-input smart-ask-input', type: 'text', placeholder: ask.placeholder, maxlength: 300, 'aria-label': ask.placeholder }) as HTMLInputElement;
    const go = () => {
      close();
      ask.run(input.value.trim());
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      else if (e.key === 'Escape') close();
    });
    // A wish is added once; pressed again it is taken back out.
    const wishes = () => input.value.split(',').map((w) => w.trim()).filter(Boolean);
    const chips = ask.chips.map((c) => {
      const chip = h('button', { class: 'smart-ask-chip', type: 'button', 'aria-pressed': 'false' }, c) as HTMLButtonElement;
      chip.addEventListener('click', () => {
        const now = wishes();
        const at = now.findIndex((w) => w.toLowerCase() === c.toLowerCase());
        const text = (at >= 0 ? now.filter((_, i) => i !== at) : [...now, c.toLowerCase()]).join(', ');
        input.value = text.charAt(0).toUpperCase() + text.slice(1);
        sync();
        input.focus();
      });
      return chip;
    });
    const sync = () => {
      const now = wishes().map((w) => w.toLowerCase());
      for (const chip of chips) chip.setAttribute('aria-pressed', String(now.includes(chip.textContent!.toLowerCase())));
    };
    input.addEventListener('input', sync);
    el.replaceChildren(
      h('div', { class: 'smart-menu-head' }, sparkles(16), h('span', {}, title)),
      h('div', { class: 'smart-ask' }, input, h('div', { class: 'smart-ask-chips' }, ...chips), h('button', { class: 'text-button primary smart-ask-go', type: 'button', onclick: go }, ask.button)),
    );
    items.length = 0;
    input.focus();
  }
  document.body.append(el);

  // Towards the canvas, as the dock's other lists: up from a bottom dock, down from a top one, right from a left one.
  const r = anchor.getBoundingClientRect();
  const mr = el.getBoundingClientRect();
  const clampX = (x: number) => Math.max(8, Math.min(window.innerWidth - mr.width - 8, x));
  const clampY = (y: number) => Math.max(8, Math.min(window.innerHeight - mr.height - 8, y));
  if (place === 'left') {
    el.style.left = `${r.right + 8}px`;
    el.style.top = `${clampY(r.top + r.height / 2 - mr.height / 2)}px`;
  } else {
    el.style.left = `${clampX(r.left + r.width / 2 - mr.width / 2)}px`;
    el.style.top = `${clampY(place === 'top' ? r.bottom + 8 : r.top - mr.height - 8)}px`;
  }

  let active = 0;
  const focus = () => items[active]?.focus();
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
      anchor.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
      e.stopPropagation();
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      focus();
    }
  };
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    onClose();
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  focus();
  return close;
}
