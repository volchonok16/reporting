// Colour arithmetic for the smart actions (✦): WCAG contrast, OKLab/OKLCH
// (a space where equal steps look equal — shades, dark themes, clustering),
// Russian names of hues, k-means for the main colours of a picture.
// Colours are { r, g, b, a } in 0…1, as everywhere in the document.

import { tr, type Color } from '#core';

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Relative luminance (WCAG 2). */
export function luminance(c: Color): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Contrast ratio 1…21 (WCAG 2). */
export function contrast(a: Color, b: Color): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `top` with its alpha (times `opacity`) laid over an opaque `under`. */
export function over(top: Color, under: Color, opacity = 1): Color {
  const a = clamp01(top.a * opacity);
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function toOklab(c: Color): [number, number, number] {
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → sRGB; null when the colour is outside sRGB. */
function fromOklabRaw(L: number, A: number, B: number): Color | null {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const b = gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  const e = 1e-4;
  if ([r, g, b].some((v) => !(v >= -e && v <= 1 + e))) return null;
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: 1 };
}

export function toOklch(c: Color): Oklch {
  const [l, a, b] = toOklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

/** OKLCH → sRGB; chroma is lowered until the colour fits (hue and lightness kept). */
export function fromOklch(p: Oklch, alpha = 1): Color {
  const L = clamp01(p.l);
  const rad = (p.h * Math.PI) / 180;
  let c = Math.max(0, p.c);
  for (let i = 0; i < 40; i++) {
    const out = fromOklabRaw(L, c * Math.cos(rad), c * Math.sin(rad));
    if (out) return { ...out, a: alpha };
    c *= 0.9;
  }
  const grey = fromOklabRaw(L, 0, 0) ?? { r: L, g: L, b: L, a: 1 };
  return { ...grey, a: alpha };
}

/** Contrast WCAG asks of a text: 3:1 from 24 px (or 18.66 px bold), 4.5:1 below. */
export function neededContrast(fontSize: number, fontWeight: number): number {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

/**
 * The closest colour to `fg` (same hue, chroma as possible) that reaches
 * `target` against `bg`: darker on a light background, lighter on a dark one.
 */
export function fixContrast(fg: Color, bg: Color, target: number): Color {
  if (contrast(fg, bg) >= target) return fg;
  const p = toOklch(fg);
  const darker = luminance(bg) > 0.18;
  for (let step = 1; step <= 100; step++) {
    const l = darker ? p.l - step * 0.01 : p.l + step * 0.01;
    const c = fromOklch({ l, c: p.c, h: p.h }, fg.a);
    if (contrast(c, bg) >= target + 0.05) return c;
    if (l <= 0 || l >= 1) break;
  }
  return darker ? { r: 0, g: 0, b: 0, a: fg.a } : { r: 1, g: 1, b: 1, a: fg.a };
}

/** A Russian name of a colour: «Синий», «Песочный», «Серый»… */
export function hueName(c: Color): string {
  const p = toOklch(c);
  if (p.c < 0.035) return p.l > 0.93 ? tr('Белый') : p.l < 0.25 ? tr('Чёрный') : tr('Серый');
  const h = p.h;
  if (h >= 50 && h < 100 && p.c < 0.1 && p.l > 0.6) return tr('Песочный');
  if (h >= 30 && h < 70 && p.l < 0.5) return tr('Коричневый');
  const bins: [number, string][] = [
    [15, tr('Розовый')],
    [40, tr('Красный')],
    [75, tr('Оранжевый')],
    [110, tr('Жёлтый')],
    [165, tr('Зелёный')],
    [215, tr('Бирюзовый')],
    [268, tr('Синий')],
    [320, tr('Фиолетовый')],
    [345, tr('Малиновый')],
    [361, tr('Розовый')],
  ];
  return bins.find(([edge]) => h < edge)![1];
}

/** Lightness of the shades 50…900 (OKLab L), light to dark. */
const SHADE_L = [0.975, 0.94, 0.885, 0.81, 0.72, 0.63, 0.54, 0.45, 0.37, 0.29];
export const SHADE_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/**
 * Ten shades of one colour, 50…900. The colour itself takes the stop closest to
 * its lightness, unchanged; the others keep its hue, with less chroma towards
 * white and black.
 */
export function shades(c: Color): { stop: number; color: Color; source: boolean }[] {
  const p = toOklch(c);
  let near = 0;
  SHADE_L.forEach((l, i) => {
    if (Math.abs(l - p.l) < Math.abs(SHADE_L[near]! - p.l)) near = i;
  });
  return SHADE_STOPS.map((stop, i) => {
    if (i === near) return { stop, color: { ...c, a: 1 }, source: true };
    const l = SHADE_L[i]!;
    const k = Math.max(0.15, 1 - Math.abs(l - p.l) * 1.1);
    return { stop, color: fromOklch({ l, c: p.c * k, h: p.h }), source: false };
  });
}

/**
 * The colour of a dark theme for a colour of a light one: neutrals swap their
 * lightness (white background → near black, dark text → near white); colourful
 * accents keep their hue and become a little lighter, to stand out on dark.
 */
export function darkVariant(c: Color): Color {
  const p = toOklch(c);
  if (p.c < 0.06) return fromOklch({ l: Math.min(0.95, Math.max(0.14, 1.1 - p.l)), c: p.c * 0.8, h: p.h }, c.a);
  return fromOklch({ l: Math.min(0.82, Math.max(0.6, p.l + 0.08)), c: p.c * 0.92, h: p.h }, c.a);
}

/**
 * The main colours of a picture: k-means in OKLab over its pixels (RGBA bytes,
 * transparent ones skipped), the biggest first; clusters under 3 % and near
 * repeats are dropped.
 */
export function mainColors(rgba: Uint8ClampedArray | Uint8Array, k = 6): { color: Color; share: number }[] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    pts.push(toOklab({ r: rgba[i]! / 255, g: rgba[i + 1]! / 255, b: rgba[i + 2]! / 255, a: 1 }));
  }
  if (pts.length === 0) return [];
  const d2 = (p: number[], q: number[]) => (p[0]! - q[0]!) ** 2 + (p[1]! - q[1]!) ** 2 + (p[2]! - q[2]!) ** 2;
  // Deterministic k-means++: start from the mean, then the farthest points.
  const mean = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / pts.length) as [number, number, number];
  const centers: [number, number, number][] = [mean];
  while (centers.length < Math.min(k, pts.length)) {
    let best = pts[0]!;
    let far = -1;
    for (const p of pts) {
      const dist = Math.min(...centers.map((c) => d2(p, c)));
      if (dist > far) {
        far = dist;
        best = p;
      }
    }
    if (far <= 1e-6) break;
    centers.push([...best]);
  }
  let counts: number[] = [];
  for (let iter = 0; iter < 15; iter++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = centers.map(() => 0);
    for (const p of pts) {
      let bi = 0;
      for (let i = 1; i < centers.length; i++) if (d2(p, centers[i]!) < d2(p, centers[bi]!)) bi = i;
      sums[bi]![0]! += p[0];
      sums[bi]![1]! += p[1];
      sums[bi]![2]! += p[2];
      counts[bi]!++;
    }
    centers.forEach((c, i) => {
      if (counts[i]) for (let j = 0; j < 3; j++) c[j] = sums[i]![j]! / counts[i]!;
    });
  }
  const out: { lab: [number, number, number]; share: number }[] = centers
    .map((lab, i) => ({ lab, share: counts[i]! / pts.length }))
    .filter((c) => c.share >= 0.03)
    .sort((a, b) => b.share - a.share);
  const kept: typeof out = [];
  for (const c of out) if (kept.every((o) => d2(o.lab, c.lab) > 0.0036)) kept.push(c);
  return kept.map((c) => {
    const [L, A, B] = c.lab;
    const rgb = fromOklabRaw(L, A, B) ?? fromOklch({ l: L, c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI });
    return { color: rgb, share: c.share };
  });
}
