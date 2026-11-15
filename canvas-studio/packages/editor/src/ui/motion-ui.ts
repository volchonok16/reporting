// Motion of the interface around the canvas (UI-010, after UI-009): what CSS
// alone cannot do.
//
// · The plate of a segmented control («Свойства | Код», «px | rem») glides from
//   the old choice to the new one instead of jumping. Panels often rebuild the
//   control on a click, so the glide is a separate plate laid over the page for
//   a moment, from the old segment's box to the new one's, with the new
//   segment's own look; the segment itself shows its plate when the glide ends.
// · Menus, popovers and dialogs fade out when they close: a still copy of the
//   closing element stays where it was for a tenth of a second and fades. The
//   element itself goes at once, as before — nothing waits for the animation.
//
// · A fold of the panel opened by a click eases in; an arrow in the layers
//   panel turns (that one is in layers-panel.ts and CSS).
//
// All stay still with «Анимации интерфейса» off or the system's «reduce motion».

export function motionAllowed(): boolean {
  if (typeof document === 'undefined' || document.documentElement.dataset.motion === 'off') return false;
  return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

/** A still copy of `el` fades where it stands; call right before the element is removed or hidden. */
export function fadeAway(el: Element | null | undefined, duration = 110): void {
  if (!el || !(el instanceof HTMLElement) || !el.isConnected || el.hidden || !motionAllowed()) return;
  if (typeof el.animate !== 'function') return;
  const copy = el.cloneNode(true) as HTMLElement;
  // What the clone does not carry: typed values and drawn canvases.
  const from = el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLCanvasElement>('input, textarea, select, canvas');
  const to = copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLCanvasElement>('input, textarea, select, canvas');
  from.forEach((src, i) => {
    const dst = to[i];
    if (!dst) return;
    if (src instanceof HTMLCanvasElement && dst instanceof HTMLCanvasElement) {
      try {
        if (src.width && src.height) dst.getContext('2d')?.drawImage(src, 0, 0);
      } catch {
        // a WebGL or tainted canvas: the copy shows it empty for a tenth of a second
      }
    } else if (!(src instanceof HTMLCanvasElement) && !(dst instanceof HTMLCanvasElement)) {
      dst.value = src.value;
    }
  });
  copy.removeAttribute('id');
  for (const n of copy.querySelectorAll('[id]')) n.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.style.pointerEvents = 'none';
  copy.style.animation = 'none';
  copy.classList.add('fading-copy');
  el.after(copy);
  // Children with their own entrance animation must not replay it in the copy.
  for (const n of copy.querySelectorAll<HTMLElement>('*')) n.style.animation = 'none';
  const run = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: EASE, fill: 'forwards' });
  const done = () => copy.remove();
  run.onfinish = done;
  run.oncancel = done;
  // Never left behind, whatever happens to the animation.
  setTimeout(done, duration + 200);
}

let installed = false;

/** Installs the motion of the whole page: gliding plates of segmented controls, folds opening (UI-010, UI-011). */
export function installSegmentGlide(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // A fold of the panel opened by a click (not one rebuilt open with the panel): its content eases in.
  document.addEventListener(
    'click',
    (e) => {
      const summary = e.target instanceof Element ? e.target.closest('summary') : null;
      const details = summary?.parentElement;
      if (!(details instanceof HTMLDetailsElement) || details.open || !motionAllowed()) return;
      requestAnimationFrame(() => {
        if (!details.open) return;
        details.classList.add('fold-in');
        setTimeout(() => details.classList.remove('fold-in'), 300);
      });
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.segment') : null;
      const group = target?.closest<HTMLElement>('.segmented');
      if (!target || !group || target.classList.contains('active') || !motionAllowed()) return;
      const old = group.querySelector<HTMLElement>('.segment.active');
      if (!old) return;
      const was = old.getBoundingClientRect();
      const box = group.getBoundingClientRect();
      const index = [...group.querySelectorAll('.segment')].indexOf(target);
      // The panel marks the new choice a frame or so later, and may rebuild the control: watch for it, and
      // glide before that frame is painted. The control is found again by where it stood.
      let watcher: MutationObserver | null = null;
      const stop = () => {
        watcher?.disconnect();
        watcher = null;
      };
      const check = () => {
        let now: HTMLElement | null = group.isConnected ? group : null;
        if (!now) {
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          now = hit?.closest<HTMLElement>('.segmented') ?? null;
        }
        const active = now?.querySelector<HTMLElement>('.segment.active');
        if (!now || !active || [...now.querySelectorAll('.segment')].indexOf(active) !== index) return;
        stop();
        glide(now, active, was);
      };
      watcher = new MutationObserver(check);
      watcher.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      setTimeout(stop, 500);
    },
    true,
  );
}

function glide(group: HTMLElement, active: HTMLElement, from: DOMRect): void {
  const to = active.getBoundingClientRect();
  if (!to.width || (Math.abs(to.left - from.left) < 1 && Math.abs(to.width - from.width) < 1)) return;
  // Its final look, not a step of its own colour transition (UI-009 fades segment backgrounds).
  const transition = active.style.transition;
  active.style.transition = 'none';
  const style = getComputedStyle(active);
  const look = { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow, borderRadius: style.borderRadius };
  active.style.transition = transition;
  const box = group.getBoundingClientRect();
  const plate = document.createElement('div');
  plate.className = 'segment-glide';
  plate.setAttribute('aria-hidden', 'true');
  // Inside the control, under the labels (CSS lifts the segments above it).
  Object.assign(plate.style, {
    left: `${to.left - box.left - group.clientLeft}px`,
    top: `${to.top - box.top - group.clientTop}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
    background: look.backgroundColor,
    boxShadow: look.boxShadow,
    borderRadius: look.borderRadius,
  });
  group.classList.add('segmented-gliding');
  active.classList.add('segment-gliding');
  group.prepend(plate);
  const run = plate.animate(
    [
      { transform: `translate(${from.left - to.left + (from.width - to.width) / 2}px, ${from.top - to.top}px) scaleX(${from.width / to.width})` },
      { transform: 'none' },
    ],
    { duration: 180, easing: EASE },
  );
  const done = () => {
    plate.remove();
    group.classList.remove('segmented-gliding');
    active.classList.remove('segment-gliding');
  };
  run.onfinish = done;
  run.oncancel = done;
  setTimeout(done, 400);
}
