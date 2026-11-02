// A pad of stickies, as in Miro: the sticky button of a board's tool panel is
// a little stack in the colour of the next sticky, and a sticky is torn off it
// — drag from the button (or from a colour of the strip over it) and let go on
// the board: the sticky lands there, ready for its text. A click still just
// picks the tool (or the colour).

import { createSticky } from '../board.ts';
import type { Editor } from '../editor.ts';
import { STICKY_SIZE } from '#components';
import { h } from './dom.ts';

export interface PadHost {
  editor: Editor;
  /** The canvas element (its box turns the pointer into a page point). */
  canvas: () => HTMLElement;
  /** Opens a new sticky for typing. */
  edit: (id: string) => void;
}

/** Makes `source` a pad: dragging from it tears off a sticky of `color()`. */
export function tearOff(source: HTMLElement, host: PadHost, color: () => string): void {
  source.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || host.editor.doc.readOnly) return;
    let ghost: HTMLElement | null = null;
    const startX = down.clientX;
    const startY = down.clientY;
    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        // Torn off: a sheet under the pointer, the size it will have on the board.
        const size = Math.max(40, Math.min(260, STICKY_SIZE * host.editor.viewport.zoom));
        ghost = h('div', { class: 'sticky-ghost', style: { width: `${size}px`, height: `${size}px`, background: color() } });
        document.body.append(ghost);
        document.body.classList.add('tearing-sticky');
      }
      ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%) rotate(-2deg)`;
    };
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('tearing-sticky');
      // The click that ends the drag must not also pick the tool or the colour.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 0);
      if (e.type !== 'pointerup') return;
      const canvas = host.canvas();
      const r = canvas.getBoundingClientRect();
      const over = document.elementFromPoint(e.clientX, e.clientY);
      // Let go over a panel or outside the board: nothing is put.
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      if (over && over.closest('.tool-dock, .board-options, .context-bar, .topbar, .dialog')) return;
      const editor = host.editor;
      const world = editor.viewport.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
      const id = createSticky(editor, world, color());
      editor.setTool('select');
      host.edit(id);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  });
}

/** The button's face: three sheets in the colour of the next sticky. */
export function padFace(color: string): HTMLElement {
  const face = h('span', { class: 'sticky-pad', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  face.style.setProperty('--pad', color);
  return face;
}
