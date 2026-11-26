/** Move the outer workspace only; the table retains its independent scroll position. */
export function scrollToArchivePreview(owner: HTMLElement, target: HTMLElement, duration = 1000) {
  let frame = 0, stopped = false;
  const focus = () => (target.querySelector<HTMLElement>('.table-region') ?? target).focus({ preventScroll: true });
  const from = owner.scrollTop;
  const margin = parseFloat(getComputedStyle(target).scrollMarginBlockStart) || 24;
  const ownerTop = typeof document !== 'undefined' && owner === document.scrollingElement ? 0 : owner.getBoundingClientRect().top;
  const destination = Math.max(0, Math.min(owner.scrollHeight - owner.clientHeight,
    from + target.getBoundingClientRect().top - ownerTop - margin));
  function cancel() {
    stopped = true; cancelAnimationFrame(frame);
    window.removeEventListener('wheel', cancel); window.removeEventListener('touchstart', cancel);
    window.removeEventListener('pointerdown', cancel); window.removeEventListener('keydown', cancel);
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(destination - from) < 1) {
    owner.scrollTop = destination; focus(); return cancel;
  }
  window.addEventListener('wheel', cancel, { passive: true }); window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('pointerdown', cancel); window.addEventListener('keydown', cancel);
  let started: number | undefined;
  function advance(now: number) {
    if (stopped) return;
    started ??= now;
    const progress = Math.min(1, (now - started) / duration);
    const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    owner.scrollTop = from + (destination - from) * eased;
    if (progress < 1) frame = requestAnimationFrame(advance);
    else { cancel(); focus(); }
  }
  frame = requestAnimationFrame(advance);
  return cancel;
}
