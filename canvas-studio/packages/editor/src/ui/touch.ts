// Phones (item 1 of the October list): a file opens for viewing only — no
// tools or panels — and the canvas moves with the fingers: one finger pans,
// two pinch to zoom. Editing stays on a computer or a tablet.

import type { Editor } from '../editor.ts';

/** A phone: a narrow screen, or a touch screen held sideways. */
export const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';

export function isPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;
}

/** Calls back when the window crosses the phone boundary (resized, turned). */
export function onPhoneChange(fn: (phone: boolean) => void): void {
  if (typeof matchMedia === 'function') matchMedia(PHONE_QUERY).addEventListener('change', (e) => fn(e.matches));
}

/** Safari's gesture events (not in the DOM typings): `scale` since the gesture began. */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/**
 * Safari zooms the page itself on a pinch unless told not to: on an iPad two
 * fingers raised the page's zoom (or did nothing) and the canvas got only
 * pointercancel. The page's pinch is stopped here — gesture events and
 * two-finger touchmove — while pointer events still reach the canvas. A
 * trackpad pinch in Safari (a Mac, an iPad with a keyboard) sends gesture
 * events and no ctrl+wheel: it zooms the canvas, unless fingers already do.
 */
function stopSafariZoom(el: HTMLElement, editor: Editor, fingers: () => number): () => void {
  let scale = 1;
  const local = (e: GestureEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const start = (e: Event) => {
    e.preventDefault();
    scale = (e as GestureEvent).scale || 1;
  };
  const change = (e: Event) => {
    e.preventDefault();
    const g = e as GestureEvent;
    if (!g.scale) return;
    if (fingers() === 0) {
      const vp = editor.viewport;
      vp.zoomAt(local(g), vp.zoom * (g.scale / scale));
      editor.requestViewport();
    }
    scale = g.scale;
  };
  const end = (e: Event) => e.preventDefault();
  const touch = (e: TouchEvent) => {
    if (e.touches.length > 1 && e.cancelable) e.preventDefault();
  };
  el.addEventListener('gesturestart', start);
  el.addEventListener('gesturechange', change);
  el.addEventListener('gestureend', end);
  el.addEventListener('touchstart', touch, { passive: false });
  el.addEventListener('touchmove', touch, { passive: false });
  return () => {
    el.removeEventListener('gesturestart', start);
    el.removeEventListener('gesturechange', change);
    el.removeEventListener('gestureend', end);
    el.removeEventListener('touchstart', touch);
    el.removeEventListener('touchmove', touch);
  };
}

/**
 * Pan and pinch for touch pointers on `el`. Runs before the canvas's own
 * handlers (capture phase) and keeps touches from selecting or moving layers.
 */
export function attachTouchViewing(el: HTMLElement, editor: Editor): () => void {
  const points = new Map<number, { x: number; y: number }>();
  let last: { cx: number; cy: number; dist: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const gesture = () => {
    const p = [...points.values()];
    if (p.length === 0) return null;
    const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
    const cy = p.reduce((s, q) => s + q.y, 0) / p.length;
    const dist = p.length > 1 ? Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y) : 0;
    return { cx, cy, dist };
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    points.set(e.pointerId, local(e));
    last = gesture();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !points.has(e.pointerId)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    points.set(e.pointerId, local(e));
    const now = gesture();
    if (!now || !last) return;
    const vp = editor.viewport;
    if (now.dist > 0 && last.dist > 0) vp.zoomAt({ x: last.cx, y: last.cy }, vp.zoom * (now.dist / last.dist));
    vp.panBy(now.cx - last.cx, now.cy - last.cy);
    editor.requestViewport();
    last = now;
  };
  const up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !points.has(e.pointerId)) return;
    e.stopImmediatePropagation();
    points.delete(e.pointerId);
    last = gesture();
  };
  el.addEventListener('pointerdown', down, true);
  el.addEventListener('pointermove', move, true);
  el.addEventListener('pointerup', up, true);
  el.addEventListener('pointercancel', up, true);
  const unSafari = stopSafariZoom(el, editor, () => points.size);
  return () => {
    unSafari();
    el.removeEventListener('pointerdown', down, true);
    el.removeEventListener('pointermove', move, true);
    el.removeEventListener('pointerup', up, true);
    el.removeEventListener('pointercancel', up, true);
  };
}

/**
 * A tablet: one finger works as a mouse (the hand tool pans, the pen draws), two
 * fingers pinch and pan in any tool, as in Figma on an iPad. The second finger
 * undoes what the first one began (`cancel`); the fingers are the view's until all are lifted.
 */
export function attachTouchPinch(el: HTMLElement, editor: Editor, cancel: () => void): () => void {
  const points = new Map<number, { x: number; y: number }>();
  let pinching = false;
  let last: { cx: number; cy: number; dist: number } | null = null;
  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const gesture = () => {
    const p = [...points.values()].slice(0, 2);
    if (p.length < 2) return null;
    return { cx: (p[0]!.x + p[1]!.x) / 2, cy: (p[0]!.y + p[1]!.y) / 2, dist: Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y) };
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    points.set(e.pointerId, local(e));
    if (points.size < 2 && !pinching) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!pinching) {
      pinching = true;
      cancel();
    }
    el.setPointerCapture?.(e.pointerId);
    last = gesture();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !points.has(e.pointerId)) return;
    points.set(e.pointerId, local(e));
    if (!pinching) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const now = gesture();
    if (now && last && last.dist > 0) {
      const vp = editor.viewport;
      vp.zoomAt({ x: last.cx, y: last.cy }, vp.zoom * (now.dist / last.dist));
      vp.panBy(now.cx - last.cx, now.cy - last.cy);
      editor.requestViewport();
    }
    last = now;
  };
  const up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !points.has(e.pointerId)) return;
    points.delete(e.pointerId);
    if (!pinching) return;
    e.stopImmediatePropagation();
    last = gesture();
    if (points.size === 0) pinching = false;
  };
  el.addEventListener('pointerdown', down, true);
  el.addEventListener('pointermove', move, true);
  el.addEventListener('pointerup', up, true);
  el.addEventListener('pointercancel', up, true);
  const unSafari = stopSafariZoom(el, editor, () => points.size);
  return () => {
    unSafari();
    el.removeEventListener('pointerdown', down, true);
    el.removeEventListener('pointermove', move, true);
    el.removeEventListener('pointerup', up, true);
    el.removeEventListener('pointercancel', up, true);
  };
}
