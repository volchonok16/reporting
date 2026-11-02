// Soft backgrounds (FEAT-162): «Сетка» — soft colour spots, each an ellipse with a
// radial gradient fading to clear, over a base colour (a mesh gradient look);
// «Аврора» — blobs blurred into one another. Spot places come from a seeded random,
// so the same settings always give the same background. The result is a clipping
// frame of ordinary layers: every spot can be moved, recoloured or deleted.

import { hexToColor, isFrameLike, solid, tr, type Color, type NodeId, type Paint, type VectorPath } from '#core';
import { mapPaths, pathsBounds, type Point } from '#geometry';
import type { Editor } from '../editor.ts';
import { blobPath } from './blob.ts';

export type BackdropStyle = 'mesh' | 'aurora';

export interface BackdropSettings {
  style: BackdropStyle;
  /** Number of spots, 2–8. */
  spots: number;
  /** How soft the spots' edges are, 0–100. */
  softness: number;
  /** Seed of the random: the same seed — the same background. */
  seed: number;
  /** The area, px. */
  width: number;
  height: number;
  /** #RRGGBB: under the spots. */
  base: string;
  /** #RRGGBB: the spots take them in turn. */
  colors: string[];
}

export const DEFAULT_BACKDROP: BackdropSettings = {
  style: 'mesh',
  spots: 5,
  softness: 60,
  seed: 1,
  width: 1920,
  height: 1080,
  base: '#F4F1FF',
  colors: ['#7C5CFF', '#FF7EB6', '#3CC6F0'],
};

/** One spot in the area's own space (0, 0 — its top left). */
export interface BackdropSpot {
  x: number;
  y: number;
  width: number;
  height: number;
  color: Color;
  /** «Аврора»: the blob's contour, in the spot's own box; «Сетка» — none (an ellipse). */
  path?: VectorPath;
}

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

function colorsOf(s: Pick<BackdropSettings, 'colors'>): Color[] {
  const list = s.colors.map((c) => hexToColor(c)).filter((c): c is Color => !!c);
  return list.length ? list : DEFAULT_BACKDROP.colors.map((c) => hexToColor(c)!);
}

/** The spots, back to front. */
export function backdropSpots(s: Omit<BackdropSettings, 'base'>): BackdropSpot[] {
  const n = clamp(Math.round(s.spots), 2, 8);
  const W = Math.max(1, s.width);
  const H = Math.max(1, s.height);
  const random = seeded(s.seed);
  const colors = colorsOf(s);
  const big = Math.max(W, H);
  // Spots stand on a jittered grid, so they cover the area instead of bunching up.
  const cols = Math.ceil(Math.sqrt((n * W) / H));
  const rows = Math.ceil(n / cols);
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  const spots: BackdropSpot[] = [];
  for (let i = 0; i < n; i++) {
    const cell = cells[i]!;
    const cx = ((cell % cols) + 0.15 + random() * 0.7) * (W / cols);
    const cy = (Math.floor(cell / cols) + 0.15 + random() * 0.7) * (H / rows);
    const color = colors[i % colors.length]!;
    if (s.style === 'aurora') {
      const size = big * (0.35 + random() * 0.25);
      const path = blobPath({ complexity: 5 + Math.floor(random() * 3), spread: 55, seed: Math.floor(random() * 999_999) + 1, size });
      const box = pathsBounds([path])!;
      spots.push({ x: round2(cx - box.width / 2), y: round2(cy - box.height / 2), width: round2(box.width), height: round2(box.height), color, path });
    } else {
      // A circle: the radial gradient is round, so on a stretched ellipse it would meet the edge un-faded.
      const d = big * (0.55 + random() * 0.45);
      spots.push({ x: round2(cx - d / 2), y: round2(cy - d / 2), width: round2(d), height: round2(d), color });
    }
  }
  return spots;
}

/** «Сетка»: the spot's fill — its colour in the middle, clear at the edge. */
export function spotGradient(color: Color, softness: number): Paint {
  const solidPart = (1 - clamp(softness, 0, 100) / 100) * 0.6;
  return {
    type: 'GRADIENT_RADIAL',
    from: { x: 0.5, y: 0.5 },
    to: { x: 1, y: 0.5 },
    stops: [
      { position: 0, color: { ...color, a: 1 } },
      { position: round2(solidPart), color: { ...color, a: 1 } },
      { position: 1, color: { ...color, a: 0 } },
    ],
    opacity: 1,
    visible: true,
  };
}

/** «Аврора»: how much the blobs are blurred, px. */
export function auroraBlur(s: Pick<BackdropSettings, 'softness' | 'width' | 'height'>): number {
  return Math.round(12 + (clamp(s.softness, 0, 100) / 100) * Math.min(s.width, s.height) * 0.18);
}

/**
 * Puts the background on the canvas: a clipping frame «Градиентный фон» with the
 * base colour and the spots. With a frame selected it fills that frame, behind
 * everything in it, and stretches with it; otherwise — in the middle of the view.
 */
export function insertBackdrop(editor: Editor, s: BackdropSettings): NodeId | null {
  const d = editor.doc;
  if (d.readOnly) return null;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  const inFrame = !!only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only);
  let parent: NodeId;
  let origin: Point;
  let width = s.width;
  let height = s.height;
  if (inFrame) {
    parent = only;
    width = d.get(only, 'width');
    height = d.get(only, 'height');
    origin = { x: 0, y: 0 };
  } else {
    const centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    parent = editor.containerAt(centre);
    const local = editor.toParentSpace(parent, centre);
    origin = { x: Math.round(local.x - width / 2), y: Math.round(local.y - height / 2) };
  }
  const spots = backdropSpots({ ...s, width, height });
  const base = hexToColor(s.base) ?? hexToColor(DEFAULT_BACKDROP.base)!;
  const blur = auroraBlur({ ...s, width, height });
  const scale = { horizontal: 'SCALE' as const, vertical: 'SCALE' as const };
  let top: NodeId | null = null;
  editor.commit(
    tr('Градиентный фон'),
    (tx) => {
      top = tx.create(
        'FRAME',
        parent,
        { name: tr('Градиентный фон'), x: origin.x, y: origin.y, width, height, fills: [solid(base)], clipsContent: true, ...(inFrame ? { constraints: scale } : {}), ...(inFrame && d.get(parent, 'layoutMode') !== 'NONE' ? { positioning: 'ABSOLUTE' as const } : {}) },
        inFrame ? { at: 'start' } : { at: 'end' },
      );
      spots.forEach((spot, i) => {
        const common = { name: tr('Пятно {0}', i + 1), x: spot.x, y: spot.y, width: spot.width, height: spot.height, strokes: [], constraints: scale };
        if (spot.path) {
          tx.create('VECTOR', top!, { ...common, vectorPaths: [spot.path], fills: [solid(spot.color)], opacity: 0.9, effects: [{ type: 'LAYER_BLUR', radius: blur, visible: true }] });
        } else {
          tx.create('ELLIPSE', top!, { ...common, fills: [spotGradient(spot.color, s.softness)] });
        }
      });
    },
    () => (top ? [top] : []),
  );
  if (top) editor.appear([top]);
  return top;
}

/** The blob's contour moved to its spot (for the preview). */
export function spotPath(spot: BackdropSpot): VectorPath | null {
  return spot.path ? mapPaths([spot.path], (p) => ({ x: p.x + spot.x, y: p.y + spot.y }))[0]! : null;
}
