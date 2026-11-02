// Timing curve preview and editor for prototype transitions (FR-PRT-021).
// The curve is drawn by sampling the real easing function, so what is shown is
// exactly what plays. For a custom Bézier the two control points can be
// dragged; the change is committed when the drag ends (the panel rebuilds on
// every committed change, so it must not happen mid-drag).

import { tr } from '#core';
import type { Easing } from '#core';
import { h } from '../ui/dom.ts';
import { easingFunction, type Bezier } from './easing.ts';

const W = 220;
const H = 132;
/** Room above and below for curves that overshoot (back easings, springs). */
const PAD_X = 12;
const PAD_Y = 30;

export function curveEditor(easing: Easing, onCommit: (bezier: Bezier) => void): HTMLElement {
  const canvas = h('canvas', { class: 'curve-canvas', width: W, height: H, 'aria-label': easing.type === 'CUSTOM_BEZIER' ? tr('Кривая: перетащите синие точки') : tr('Кривая анимации') });
  const editable = easing.type === 'CUSTOM_BEZIER';
  let bezier: Bezier = easing.type === 'CUSTOM_BEZIER' ? [...easing.bezier] : [0, 0, 1, 1];
  const label = h('span', { class: 'curve-values' });
  const x = (v: number) => PAD_X + v * (W - PAD_X * 2);
  const y = (v: number) => H - PAD_Y - v * (H - PAD_Y * 2);
  const fromX = (px: number) => (px - PAD_X) / (W - PAD_X * 2);
  const fromY = (py: number) => (H - PAD_Y - py) / (H - PAD_Y * 2);

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== W * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const styles = getComputedStyle(canvas);
    const muted = styles.getPropertyValue('--text-faint').trim() || '#9a9a9a';
    const text = styles.getPropertyValue('--text').trim() || '#1e1e1e';
    const accent = styles.getPropertyValue('--accent').trim() || '#4f5bd5';
    // Start and end levels.
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(0), y(0) + 0.5);
    ctx.lineTo(x(1), y(0) + 0.5);
    ctx.moveTo(x(0), y(1) + 0.5);
    ctx.lineTo(x(1), y(1) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    const current: Easing = editable ? { type: 'CUSTOM_BEZIER', bezier } : easing;
    const { ease, duration } = easingFunction(current, 300);
    ctx.strokeStyle = text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const v = Math.max(-0.5, Math.min(1.5, ease(t)));
      if (i === 0) ctx.moveTo(x(t), y(v));
      else ctx.lineTo(x(t), y(v));
    }
    ctx.stroke();
    if (editable) {
      const [x1, y1, x2, y2] = bezier;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(0), y(0));
      ctx.lineTo(x(x1), y(y1));
      ctx.moveTo(x(1), y(1));
      ctx.lineTo(x(x2), y(y2));
      ctx.stroke();
      for (const [px, py] of [[x1, y1], [x2, y2]] as const) {
        ctx.beginPath();
        ctx.arc(x(px), y(py), 5, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      label.textContent = `cubic-bezier(${bezier.map((v) => +v.toFixed(2)).join(', ')})`;
    } else if (easing.type === 'SPRING') {
      label.textContent = tr('≈ {0} мс', duration);
    } else {
      label.textContent = '';
    }
  };

  if (editable) {
    let drag: 0 | 1 | null = null;
    const point = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const p = point(e);
      const d1 = Math.hypot(p.x - x(bezier[0]), p.y - y(bezier[1]));
      const d2 = Math.hypot(p.x - x(bezier[2]), p.y - y(bezier[3]));
      drag = d1 <= d2 ? 0 : 1;
      canvas.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e: PointerEvent) => {
      if (drag === null) return;
      const p = point(e);
      // x stays in [0, 1] so time runs forward; y may overshoot for back-like curves.
      const px = Math.round(Math.max(0, Math.min(1, fromX(p.x))) * 100) / 100;
      const py = Math.round(Math.max(-0.5, Math.min(1.5, fromY(p.y))) * 100) / 100;
      if (drag === 0) bezier = [px, py, bezier[2], bezier[3]];
      else bezier = [bezier[0], bezier[1], px, py];
      draw();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', () => {
      if (drag === null) return;
      drag = null;
      onCommit(bezier);
    });
    canvas.classList.add('editable');
  }
  // Drawn once attached, when theme colours are known.
  requestAnimationFrame(draw);
  return h('div', { class: 'curve-editor' }, canvas, label);
}
