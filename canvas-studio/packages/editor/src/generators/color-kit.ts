// Colour kit (as the Color Kit plugin): rows of colours made from one — lighter,
// darker and muted steps, the 50–900 scale, and the classic harmonies — all in
// OKLCH, where equal steps look equal. Each colour knows its contrast with white
// and black (WCAG 2).

import { tr, type Color } from '#core';
import { contrast, fromOklch, shades, toOklab, toOklch } from '../color-math.ts';

export interface KitRow {
  id: string;
  title: string;
  /** What the row is, in a few words (a tooltip). */
  hint: string;
  colors: Color[];
}

const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** A colour `t` of the way from `a` to `b` in OKLab (smooth, no muddy middle). */
function mix(a: Color, b: Color, t: number): Color {
  const p = toOklab(a);
  const q = toOklab(b);
  const L = p[0] + (q[0] - p[0]) * t;
  const A = p[1] + (q[1] - p[1]) * t;
  const B = p[2] + (q[2] - p[2]) * t;
  const c = Math.hypot(A, B);
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return fromOklch({ l: L, c, h: h < 0 ? h + 360 : h });
}

/** `steps` colours from the colour towards `to`, the colour itself first, never quite reaching `to`. */
function ramp(c: Color, to: Color, steps: number, reach = 0.9): Color[] {
  return Array.from({ length: steps }, (_, i) => (i === 0 ? { ...c, a: 1 } : mix(c, to, (reach * i) / (steps - 1))));
}

/** The colour with its hue turned by `deg`, lightness and chroma kept (as far as sRGB allows). */
export function turnHue(c: Color, deg: number): Color {
  const p = toOklch(c);
  return fromOklch({ l: p.l, c: p.c, h: (((p.h + deg) % 360) + 360) % 360 });
}

/** All rows for a colour; `steps` — how many colours in the lighter/darker/muted rows (3–10). */
export function colorKit(c: Color, steps: number): KitRow[] {
  const n = Math.max(3, Math.min(10, Math.round(steps)));
  const base = { ...c, a: 1 };
  const p = toOklch(base);
  const grey = fromOklch({ l: p.l, c: 0, h: p.h });
  const turn = (degs: number[]) => degs.map((d) => (d === 0 ? base : turnHue(base, d)));
  return [
    { id: 'scale', title: tr('Шкала 50–900'), hint: tr('Десять оттенков для системы цветов: от почти белого к почти чёрному'), colors: shades(base).map((s) => s.color) },
    { id: 'tints', title: tr('Светлее'), hint: tr('Цвет, смешанный с белым'), colors: ramp(base, WHITE, n) },
    { id: 'shades', title: tr('Темнее'), hint: tr('Цвет, смешанный с чёрным'), colors: ramp(base, BLACK, n) },
    { id: 'tones', title: tr('Приглушённые'), hint: tr('Цвет, смешанный с серым той же светлоты'), colors: ramp(base, grey, n, 1) },
    { id: 'complementary', title: tr('Дополнительный'), hint: tr('Напротив на цветовом круге: самый сильный контраст оттенков'), colors: turn([0, 180]) },
    { id: 'analogous', title: tr('Аналогичные'), hint: tr('Соседи на круге (±30°): спокойное сочетание'), colors: turn([-30, 0, 30]) },
    { id: 'triad', title: tr('Триада'), hint: tr('Три цвета через 120°: ярко и уравновешенно'), colors: turn([0, 120, 240]) },
    { id: 'split', title: tr('Раздельно-дополнительный'), hint: tr('Цвет и два соседа его дополнительного (±30°): контрастно, но мягче'), colors: turn([0, 150, 210]) },
    { id: 'square', title: tr('Квадрат'), hint: tr('Четыре цвета через 90°: богатая палитра, нужен один главный'), colors: turn([0, 90, 180, 270]) },
  ];
}

/**
 * Contrast with white and black, and the text colour that reads better on it.
 * One of the two always reaches 4.58 (√21), so the better text is AA at least.
 */
export function readability(c: Color): { onWhite: number; onBlack: number; text: 'white' | 'black'; best: number; level: 'AAA' | 'AA' } {
  const onWhite = contrast(c, WHITE);
  const onBlack = contrast(c, BLACK);
  const text = onWhite >= onBlack ? 'white' : 'black';
  const best = Math.max(onWhite, onBlack);
  const level = best >= 7 ? 'AAA' : 'AA';
  return { onWhite, onBlack, text, best, level };
}
