// «Как видит человек с дальтонизмом» (FEAT-222, as the Stark plugin): the canvas through a colour matrix — the
// file does not change. Light: the editor's start loads it.

import { tr } from '#core';

export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';

export const VISIONS: readonly (readonly [Vision, string])[] = [
  ['normal', tr('Обычное зрение')],
  ['protanopia', tr('Протанопия')],
  ['deuteranopia', tr('Дейтеранопия')],
  ['tritanopia', tr('Тританопия')],
  ['achromatopsia', tr('Монохром')],
];

/** 3×3 matrices on linear RGB: Machado, Oliveira, Fernandes (2009), full severity; monochrome — luminance. */
export const VISION_MATRICES: Record<Exclude<Vision, 'normal'>, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
  achromatopsia: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
};

/** An SVG colour filter for CSS `filter: url(#…)`; it works in linear RGB, as the matrices want. */
export function ensureVisionFilters(): void {
  if (typeof document === 'undefined' || document.getElementById('cs-vision-filters')) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = 'cs-vision-filters';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  for (const [name, m] of Object.entries(VISION_MATRICES)) {
    const f = document.createElementNS(ns, 'filter');
    f.id = `cs-vision-${name}`;
    f.setAttribute('color-interpolation-filters', 'linearRGB');
    const cm = document.createElementNS(ns, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', `${m.slice(0, 3).join(' ')} 0 0 ${m.slice(3, 6).join(' ')} 0 0 ${m.slice(6, 9).join(' ')} 0 0 0 0 0 1 0`);
    f.append(cm);
    svg.append(f);
  }
  document.body.append(svg);
}

/** CSS filter for a way of seeing (empty — none). */
export function visionFilter(v: Vision): string {
  if (v === 'normal') return '';
  ensureVisionFilters();
  return `url(#cs-vision-${v})`;
}
