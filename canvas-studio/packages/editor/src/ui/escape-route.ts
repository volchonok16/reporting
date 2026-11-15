// Esc for the top window, wherever the focus is (BUG-177).
//
// Each window closes itself on Esc from its own keydown listener — on the window
// element, so the key reaches it only while the focus is inside. Safari (and the
// macOS app, WebKit) does not focus a clicked button: after a click on «Проверить»
// or «Импортировать» the focus is on the page, Esc went past the window to the
// editor behind it (deselecting layers there) and the window stayed open.
//
// So, before every other listener (installed first, window, capture phase): an
// Esc whose target is outside the top open window is stopped and sent again from
// inside that window, as if the focus were there. The window's own rules apply
// unchanged (busy, a popover of its own, a field being edited).

const WINDOWS = '.dialog-overlay, .vars-overlay, .versions-view';

/** The window on top: the last one in the page that is shown (a layout being made in the background keeps its hidden). */
function topWindow(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>(WINDOWS)].filter((el) => !el.hidden && el.isConnected && el.getClientRects().length > 0);
  return open.at(-1) ?? null;
}

let installed = false;

export function routeEscapeToTopWindow(): void {
  if (installed) return;
  installed = true;
  addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const top = topWindow();
      if (!top) return;
      const target = e.target instanceof Node ? e.target : null;
      if (target && top.contains(target)) return;
      // A popover or menu outside the window (a font list, a color picker) holds the focus: it closes first, by itself.
      if (target instanceof Element && target.closest('[role=menu], [role=listbox], .popover, [class*=popover]')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      // The window itself: every one is the overlay's only child, its listeners there or on the overlay.
      const inside = (top.firstElementChild as HTMLElement | null) ?? top;
      inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
    },
    true,
  );
}
