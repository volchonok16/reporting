// Timing curves for prototype transitions (FR-PRT-021): cubic Bézier curves
// (the CSS presets and custom ones) and a damped spring. Own implementation:
// a Bézier is solved for x by Newton's method with a bisection fallback; the
// spring is the closed-form solution of a damped oscillator.

import { tr } from '#core';
import type { Easing, Transition, TransitionType } from '#core';

export type Bezier = [number, number, number, number];

export const BEZIER_PRESETS: Record<'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT' | 'EASE_IN_BACK' | 'EASE_OUT_BACK', Bezier> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.36, 0, 0.66, -0.56],
  EASE_OUT_BACK: [0.34, 1.56, 0.64, 1],
};

export interface SpringParams {
  mass: number;
  stiffness: number;
  damping: number;
}

/** Spring presets from the spec: gentle, quick, bouncy (plus slow). */
export const SPRING_PRESETS: Record<'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW', SpringParams> = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

/** y(x) of a cubic Bézier from (0,0) to (1,1) with control points (x1,y1), (x2,y2). */
export function cubicBezier([x1, y1, x2, y2]: Bezier): (x: number) => number {
  // Polynomial coefficients of B(t) = 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Newton did not converge (flat slope): bisection always does, x(t) is monotonic for x1, x2 in [0, 1].
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solve(x));
  };
}

/**
 * Position (0 → 1) of a damped spring released at 0 with rest at 1, at time t
 * seconds. Under-, critically and over-damped cases.
 */
export function springAt({ mass, stiffness, damping }: SpringParams, t: number): number {
  const m = Math.max(0.01, mass);
  const k = Math.max(0.01, stiffness);
  const c = Math.max(0, damping);
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  // x(t) = 1 + A e^{r1 t} + B e^{r2 t}, x(0) = 0, x'(0) = 0.
  const A = r2 / (r1 - r2);
  const B = -r1 / (r1 - r2);
  return 1 + A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
}

/** How long a spring takes to settle within 0.1 % of rest (ms), capped at 10 s. */
export function springDuration(params: SpringParams): number {
  const step = 1 / 120;
  let quiet = 0;
  for (let t = 0; t < 10; t += step) {
    const settled = Math.abs(1 - springAt(params, t)) < 0.001 && Math.abs(springAt(params, t + step) - springAt(params, t)) < 0.0005;
    quiet = settled ? quiet + step : 0;
    if (quiet >= 0.1) return Math.round((t - quiet + step) * 1000);
  }
  return 10000;
}

/** A timing function over [0, 1] and the duration it runs for. */
export function easingFunction(easing: Easing, duration: number): { ease: (p: number) => number; duration: number } {
  if (easing.type === 'SPRING') {
    const ms = springDuration(easing);
    return { ease: (p) => (p >= 1 ? 1 : springAt(easing, (p * ms) / 1000)), duration: ms };
  }
  const bezier = easing.type === 'CUSTOM_BEZIER' ? easing.bezier : BEZIER_PRESETS[easing.type];
  return { ease: cubicBezier(bezier), duration: clampDuration(duration) };
}

export function clampDuration(ms: number): number {
  return Math.max(1, Math.min(10000, Math.round(Number.isFinite(ms) ? ms : 300)));
}

const OPPOSITE = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as const;
const REVERSE_TYPE: Partial<Record<TransitionType, TransitionType>> = { MOVE_IN: 'MOVE_OUT', MOVE_OUT: 'MOVE_IN', SLIDE_IN: 'SLIDE_OUT', SLIDE_OUT: 'SLIDE_IN' };

/** The transition "Back" plays: the same motion run the other way. */
export function reverseTransition(t: Transition | null): Transition | null {
  if (!t) return null;
  return { ...t, type: REVERSE_TYPE[t.type] ?? t.type, direction: t.direction ? OPPOSITE[t.direction] : t.direction };
}

/** Transitions that move in a direction. */
export const DIRECTIONAL: ReadonlySet<TransitionType> = new Set(['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT']);

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  INSTANT: tr('Мгновенно'),
  DISSOLVE: tr('Растворение'),
  SMART_ANIMATE: tr('Умная анимация'),
  MOVE_IN: tr('Въезд'),
  MOVE_OUT: tr('Выезд'),
  PUSH: tr('Сдвиг'),
  SLIDE_IN: tr('Наплыв'),
  SLIDE_OUT: tr('Уплыв'),
};
