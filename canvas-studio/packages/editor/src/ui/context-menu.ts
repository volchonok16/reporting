// Context menu (right click, two-finger tap on a trackpad, Ctrl+click on macOS).
// Keyboard: arrows to move, Enter to run, → / ← for submenus, Esc to close.

import { formatShortcut } from '../keyboard.ts';
import { clear, h, icon } from './dom.ts';

export type MenuItem =
  | { kind: 'action'; label: string; shortcut?: string; disabled?: boolean; run: () => void }
  | { kind: 'submenu'; label: string; items: MenuItem[]; disabled?: boolean }
  | { kind: 'separator' };

export class ContextMenu {
  private readonly layer: HTMLElement;
  private menus: HTMLElement[] = [];
  private restoreFocus: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.layer = h('div', { class: 'menu-layer', hidden: true });
    host.append(this.layer);
    this.layer.addEventListener('pointerdown', (e) => {
      if (e.target === this.layer) this.close();
    });
    this.layer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target === this.layer) this.close();
    });
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
  }

  get isOpen(): boolean {
    return !this.layer.hidden;
  }

  open(x: number, y: number, items: MenuItem[]): void {
    this.close();
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.layer.hidden = false;
    this.openMenu(x, y, items, 0);
  }

  close(): void {
    if (this.layer.hidden) return;
    this.layer.hidden = true;
    clear(this.layer);
    this.menus = [];
    this.restoreFocus?.focus({ preventScroll: true });
  }

  private openMenu(x: number, y: number, items: MenuItem[], depth: number, anchor?: DOMRect): void {
    for (const m of this.menus.splice(depth)) m.remove();
    const menu = h('div', { class: 'menu', role: 'menu', tabindex: -1 });
    const rows: HTMLElement[] = [];
    items.forEach((item) => {
      if (item.kind === 'separator') {
        // No leading, trailing or doubled separators.
        const last = menu.lastElementChild;
        if (last && !last.classList.contains('menu-separator')) menu.append(h('div', { class: 'menu-separator', role: 'separator' }));
        return;
      }
      const row = h(
        'div',
        { class: `menu-item${item.disabled ? ' disabled' : ''}`, role: 'menuitem', 'aria-disabled': String(!!item.disabled), tabindex: -1 },
        h('span', { class: 'menu-label' }, item.label),
        item.kind === 'action' && item.shortcut ? h('span', { class: 'menu-shortcut' }, formatShortcut(item.shortcut)) : null,
        item.kind === 'submenu' ? icon('chevronRight', 12) : null,
      );
      const activate = () => {
        if (item.disabled) return;
        if (item.kind === 'action') {
          this.close();
          item.run();
        } else {
          this.openMenu(0, 0, item.items, depth + 1, row.getBoundingClientRect());
          (this.menus[depth + 1]?.querySelector('.menu-item:not(.disabled)') as HTMLElement | null)?.focus();
        }
      };
      row.addEventListener('click', activate);
      row.addEventListener('pointerenter', () => {
        row.focus({ preventScroll: true });
        if (item.kind === 'submenu' && !item.disabled) this.openMenu(0, 0, item.items, depth + 1, row.getBoundingClientRect());
        else for (const m of this.menus.splice(depth + 1)) m.remove();
      });
      row.addEventListener('keydown', (e) => {
        e.stopPropagation();
        const i = rows.indexOf(row);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          for (let k = 1; k <= rows.length; k++) {
            const next = rows[(i + step * k + rows.length * k) % rows.length];
            if (next && !next.classList.contains('disabled')) {
              next.focus();
              break;
            }
          }
        } else if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && item.kind === 'submenu')) {
          e.preventDefault();
          activate();
        } else if (e.key === 'ArrowLeft' && depth > 0) {
          e.preventDefault();
          for (const m of this.menus.splice(depth)) m.remove();
          (this.menus[depth - 1]?.querySelector('.menu-item:focus-within, .menu-item') as HTMLElement | null)?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });
      rows.push(row);
      menu.append(row);
    });
    if (menu.lastElementChild?.classList.contains('menu-separator')) menu.lastElementChild.remove();
    this.layer.append(menu);
    this.menus[depth] = menu;

    // Keep the menu inside the window; submenus open to the right, or to the left if there is no room.
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (anchor) {
      left = anchor.right + rect.width > vw - 4 ? anchor.left - rect.width : anchor.right;
      top = anchor.top - 4;
    } else if (left + rect.width > vw - 4) {
      left = Math.max(4, left - rect.width);
    }
    if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${top}px`;
    if (depth === 0) menu.focus({ preventScroll: true });
    menu.addEventListener('keydown', (e) => {
      if (e.target !== menu) return;
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (menu.querySelector('.menu-item:not(.disabled)') as HTMLElement | null)?.focus();
      }
    });
  }
}
