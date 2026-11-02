// Waves (as the Get Waves plugin): layers of waves across an area, each a closed
// shape — the wave on top, the area's bottom below. Crest heights come from a seeded
// random, so the same settings always give the same waves. Colours go from the
// first (the back layer) to the second (the front one).

import { colorToHex, hexToColor, isFrameLike, solid, tr, type Color, type NodeId, type VectorPath, type VectorPoint } from '#core';
import { mapPaths, pathsBounds, type Point } from '#geometry';
import type { Editor } from '../editor.ts';

/** Waves proper, and section dividers (FEAT-163): zigzag, arc, slope, torn edge, clouds. */
export type WaveStyle = 'smooth' | 'peaks' | 'steps' | 'zigzag' | 'arc' | 'slope' | 'torn' | 'clouds';

export interface WaveSettings {
  /** Number of layers, 1–6. */
  layers: number;
  /** How high the waves rise, 0–100. */
  height: number;
  /** Number of crests across, 2–20. */
  frequency: number;
  style: WaveStyle;
  /** Seed of the random: the same seed — the same waves. */
  seed: number;
  /** The area, px. */
  width: number;
  areaHeight: number;
  /** Waves hang from the top instead of rising from the bottom. */
  flip: boolean;
  /** #RRGGBB: the back layer. */
  color: string;
  /** #RRGGBB: the front layer. */
  color2: string;
}

export const DEFAULT_WAVES: WaveSettings = { layers: 3, height: 60, frequency: 6, style: 'smooth', seed: 1, width: 1440, areaHeight: 320, flip: false, color: '#C9CDF4', color2: '#4F5BD5' };

/** A small fast seeded random (mulberry32): numbers in [0, 1). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The layers' contours, back to front, in the area's own space (0, 0 — its top left). */
export function wavePaths(s: Omit<WaveSettings, 'color' | 'color2'>): VectorPath[] {
  const n = clamp(Math.round(s.layers), 1, 6);
  const crests = clamp(Math.round(s.frequency), 2, 20);
  const W = Math.max(1, s.width);
  const H = Math.max(1, s.areaHeight);
  const random = seeded(s.seed);
  // Each layer has a band of its own: the next one starts lower, so all of them show.
  const band = H / (n + 1);
  const amp = (clamp(s.height, 0, 100) / 100) * band * 1.6;
  const paths: VectorPath[] = [];
  for (let layer = 0; layer < n; layer++) {
    const base = band * (layer + 1);
    const crest: Point[] = [];
    for (let j = 0; j <= crests; j++) crest.push({ x: (W * j) / crests, y: clamp(base + (random() - 0.5) * amp, 0, H) });
    let wave: VectorPoint[];
    if (s.style === 'zigzag') {
      // Even teeth: the random only shifts the layer a little.
      const shift = (random() - 0.5) * band * 0.4;
      wave = crest.map((p, j) => ({ x: p.x, y: clamp(base + shift + (j % 2 ? 0.5 : -0.5) * amp, 0, H) }));
    } else if (s.style === 'arc') {
      // One bend across, as a quadratic curve written as a cubic: the ends low, the middle up.
      const rise = amp * (0.6 + random() * 0.4);
      const y0 = clamp(base + rise / 2, 0, H);
      const control = { x: W / 2, y: 2 * clamp(base - rise / 2, 0, H) - y0 };
      wave = [
        { x: 0, y: y0, out: { x: (2 / 3) * control.x, y: y0 + (2 / 3) * (control.y - y0) } },
        { x: W, y: y0, in: { x: W + (2 / 3) * (control.x - W), y: y0 + (2 / 3) * (control.y - y0) } },
      ];
    } else if (s.style === 'slope') {
      const tilt = (random() < 0.5 ? -1 : 1) * amp * (0.6 + random() * 0.4);
      wave = [
        { x: 0, y: clamp(base - tilt / 2, 0, H) },
        { x: W, y: clamp(base + tilt / 2, 0, H) },
      ];
    } else if (s.style === 'torn') {
      // A ragged paper edge: many small random teeth.
      const teeth = clamp(crests * 6, 12, 120);
      wave = Array.from({ length: teeth + 1 }, (_, j) => ({ x: (W * j) / teeth, y: clamp(base + (random() - 0.5) * amp * 0.35, 0, H) }));
    } else if (s.style === 'clouds') {
      // Round bumps between the points: each one a half-circle-ish cubic of its own height.
      const xs = [0];
      for (let j = 1; j < crests; j++) xs.push((W * (j + (random() - 0.5) * 0.5)) / crests);
      xs.push(W);
      const ys = xs.map(() => clamp(base + (random() - 0.5) * amp * 0.25, 0, H));
      wave = xs.map((x, j) => ({ x, y: ys[j]! }) as VectorPoint);
      for (let j = 0; j < xs.length - 1; j++) {
        const bump = Math.min(((xs[j + 1]! - xs[j]!) / 2) * (0.6 + random() * 0.5), ys[j]!, ys[j + 1]!) * (4 / 3);
        wave[j]!.out = { x: xs[j]!, y: ys[j]! - bump };
        wave[j + 1]!.in = { x: xs[j + 1]!, y: ys[j + 1]! - bump };
      }
    } else if (s.style === 'steps') {
      wave = [];
      crest.forEach((p, j) => {
        if (j > 0) wave.push({ x: p.x, y: crest[j - 1]!.y });
        wave.push({ x: p.x, y: p.y });
      });
    } else if (s.style === 'peaks') {
      wave = crest.map((p) => ({ x: p.x, y: p.y }));
    } else {
      // Catmull-Rom through the crests; the ends are level so the edge meets the next tile of a repeat.
      wave = crest.map((p, j) => {
        const prev = crest[j - 1] ?? { x: p.x - (crest[1]!.x - crest[0]!.x), y: p.y };
        const next = crest[j + 1] ?? { x: p.x + (p.x - crest[j - 1]!.x), y: p.y };
        const tx = (next.x - prev.x) / 6;
        const ty = (next.y - prev.y) / 6;
        const q: VectorPoint = { x: p.x, y: p.y };
        if (j > 0) q.in = { x: p.x - tx, y: p.y - ty };
        if (j < crests) q.out = { x: p.x + tx, y: p.y + ty };
        return q;
      });
    }
    const points: VectorPoint[] = [...wave, { x: W, y: H }, { x: 0, y: H }];
    const flipY = (v: Point) => ({ x: round2(v.x), y: round2(s.flip ? H - v.y : v.y) });
    paths.push({
      closed: true,
      points: points.map((p) => ({ ...flipY(p), ...(p.in ? { in: flipY(p.in) } : {}), ...(p.out ? { out: flipY(p.out) } : {}) })),
    });
  }
  return paths;
}

/** Colour of each layer, back to front. */
export function waveColors(s: Pick<WaveSettings, 'layers' | 'color' | 'color2'>): Color[] {
  const n = clamp(Math.round(s.layers), 1, 6);
  const a = hexToColor(s.color) ?? hexToColor(DEFAULT_WAVES.color)!;
  const b = hexToColor(s.color2) ?? hexToColor(DEFAULT_WAVES.color2)!;
  if (n === 1) return [b];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
  });
}

/** The colours as hex, for the preview. */
export function waveHexColors(s: Pick<WaveSettings, 'layers' | 'color' | 'color2'>): string[] {
  return waveColors(s).map((c) => colorToHex(c));
}

/**
 * Puts the waves on the canvas. With a frame selected they take its width and sit
 * at its bottom (at its top when flipped), stretching with it; otherwise — in the
 * middle of the view. A group «Волны» (one layer — just the vector). Selects it.
 */
export function insertWaves(editor: Editor, s: WaveSettings): NodeId | null {
  const d = editor.doc;
  if (d.readOnly) return null;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  const inFrame = !!only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only);
  let parent: NodeId;
  let origin: Point;
  let width = s.width;
  if (inFrame) {
    parent = only;
    width = d.get(only, 'width');
    origin = { x: 0, y: s.flip ? 0 : d.get(only, 'height') - s.areaHeight };
  } else {
    const centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    parent = editor.containerAt(centre);
    const local = editor.toParentSpace(parent, centre);
    origin = { x: Math.round(local.x - width / 2), y: Math.round(local.y - s.areaHeight / 2) };
  }
  const paths = wavePaths({ ...s, width });
  const colors = waveColors(s);
  const constraints = inFrame ? { horizontal: 'SCALE' as const, vertical: s.flip ? ('MIN' as const) : ('MAX' as const) } : undefined;
  let top: NodeId | null = null;
  editor.commit(
    tr('Волны'),
    (tx) => {
      const holder = paths.length > 1 ? tx.create('GROUP', parent, { name: tr('Волны'), ...(constraints ? { constraints } : {}) }) : parent;
      paths.forEach((path, i) => {
        // The layer's box is its contour's: a wave that does not reach the area's top starts lower.
        const box = pathsBounds([path])!;
        const id = tx.create('VECTOR', holder, {
          name: paths.length > 1 ? tr('Волна {0}', i + 1) : tr('Волна'),
          x: round2(origin.x + box.x),
          y: round2(origin.y + box.y),
          width: round2(box.width),
          height: round2(box.height),
          vectorPaths: mapPaths([path], (p) => ({ x: round2(p.x - box.x), y: round2(p.y - box.y) })),
          fills: [solid(colors[i]!)],
          strokes: [],
          ...(constraints && paths.length === 1 ? { constraints } : {}),
        });
        if (paths.length === 1) top = id;
      });
      if (paths.length > 1) top = holder;
    },
    () => (top ? [top] : []),
  );
  if (top) editor.appear([top]);
  return top;
}
