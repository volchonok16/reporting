// Abstract shapes (as the Blobs plugin): points round a circle, each pushed in and
// turned a little by a seeded random, joined by a smooth closed curve. The same
// settings always give the same shape, so a liked one can be found again by its seed.

import { hexToColor, isFrameLike, solid, tr, type NodeId, type Paint, type VectorPath } from '#core';
import { mapPaths, pathsBounds, type Point } from '#geometry';
import type { Editor } from '../editor.ts';

export type BlobPaint = 'solid' | 'gradient' | 'outline';

export interface BlobSettings {
  /** Number of bulges, 3–12. */
  complexity: number;
  /** How uneven the shape is, 0–100. */
  spread: number;
  /** Seed of the random: the same seed — the same shape. */
  seed: number;
  /** Longer side of the shape, px. */
  size: number;
  paint: BlobPaint;
  /** #RRGGBB */
  color: string;
  /** Second colour of the gradient, #RRGGBB. */
  color2: string;
}

export const DEFAULT_BLOB: BlobSettings = { complexity: 6, spread: 50, seed: 1, size: 240, paint: 'solid', color: '#4F5BD5', color2: '#E85D9A' };

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

/** A new seed for «Другая форма». */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_999);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The shape as one closed contour, its longer side `size`, its box starting at (0, 0). */
export function blobPath(s: Pick<BlobSettings, 'complexity' | 'spread' | 'seed' | 'size'>): VectorPath {
  const n = Math.max(3, Math.min(12, Math.round(s.complexity)));
  const k = Math.max(0, Math.min(100, s.spread)) / 100;
  const random = seeded(s.seed);
  const step = (Math.PI * 2) / n;
  const corners: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = i * step + (random() - 0.5) * step * 0.5 * k - Math.PI / 2;
    const radius = 1 - k * 0.6 * random();
    corners.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  // Catmull-Rom through the points, as cubic handles: the curve is smooth at every point.
  const points = corners.map((p, i) => {
    const prev = corners[(i + n - 1) % n]!;
    const next = corners[(i + 1) % n]!;
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    return { x: p.x, y: p.y, in: { x: p.x - tx, y: p.y - ty }, out: { x: p.x + tx, y: p.y + ty } };
  });
  const raw: VectorPath = { closed: true, points };
  const box = pathsBounds([raw])!;
  const scale = s.size / Math.max(box.width, box.height, 1e-9);
  return mapPaths([raw], (p) => ({ x: round2((p.x - box.x) * scale), y: round2((p.y - box.y) * scale) }))[0]!;
}

/** SVG path data of a contour (for the preview). */
export function pathData(path: VectorPath): string {
  const pts = path.points;
  if (pts.length === 0) return '';
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  const count = path.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c1 = a.out ?? a;
    const c2 = b.in ?? b;
    d += `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
  }
  return path.closed ? `${d}Z` : d;
}

/** Fills and strokes of the shape. */
export function blobPaints(s: BlobSettings): { fills: Paint[]; strokes: Paint[] } {
  const c1 = hexToColor(s.color) ?? hexToColor(DEFAULT_BLOB.color)!;
  const c2 = hexToColor(s.color2) ?? hexToColor(DEFAULT_BLOB.color2)!;
  if (s.paint === 'outline') return { fills: [], strokes: [solid(c1)] };
  if (s.paint === 'gradient') {
    return { fills: [{ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, stops: [{ position: 0, color: c1 }, { position: 1, color: c2 }], opacity: 1, visible: true }], strokes: [] };
  }
  return { fills: [solid(c1)], strokes: [] };
}

/**
 * Puts the shape centred at `at` (world); without it — into the selected frame (its
 * middle) or the middle of the view. Selects it; returns the vector.
 */
export function insertBlob(editor: Editor, s: BlobSettings, at?: Point): NodeId | null {
  const d = editor.doc;
  if (d.readOnly) return null;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  let parent: NodeId;
  let centre: Point;
  if (at) {
    centre = at;
    parent = editor.containerAt(at);
  } else if (only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only)) {
    const b = editor.scene.bounds(only);
    centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    parent = only;
  } else {
    centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    parent = editor.containerAt(centre);
  }
  const path = blobPath(s);
  const box = pathsBounds([path])!;
  const local = editor.toParentSpace(parent, centre);
  const { fills, strokes } = blobPaints(s);
  let id: NodeId | null = null;
  editor.commit(
    tr('Клякса'),
    (tx) => {
      id = tx.create('VECTOR', parent, {
        name: tr('Клякса'),
        x: Math.round(local.x - box.width / 2),
        y: Math.round(local.y - box.height / 2),
        width: round2(box.width),
        height: round2(box.height),
        vectorPaths: [path],
        fills,
        strokes,
        strokeWeight: 2,
        strokeAlign: 'CENTER',
        strokeJoin: 'ROUND',
      });
    },
    () => (id ? [id] : []),
  );
  if (id) editor.appear([id]);
  return id;
}
