// Hand-drawn accents (FEAT-164): underline, loop round, arrow, sparks, sparkle star,
// marker, tick. Each is drawn along a plain shape (a line, an ellipse, a curve),
// shaken a little by a seeded random and smoothed — so it looks drawn by hand, and
// the same settings always give the same stroke. With something selected the
// underline, the loop and the marker take its size; the rest stand by its corner.

import { hexToColor, solid, tr, type NodeId, type Paint, type VectorPath, type VectorPoint } from '#core';
import { mapPaths, pathsBounds, type Point } from '#geometry';
import type { Editor } from '../editor.ts';

export type DoodleKind = 'underline' | 'circle' | 'arrow' | 'sparks' | 'sparkle' | 'marker' | 'tick';

export const DOODLE_KINDS: readonly DoodleKind[] = ['underline', 'circle', 'arrow', 'sparks', 'sparkle', 'marker', 'tick'];

export interface DoodleSettings {
  kind: DoodleKind;
  /** How shaky the hand is, 0–100. */
  wobble: number;
  /** Line width, px (the marker is as thick as the box is high). */
  weight: number;
  /** Seed of the random: the same seed — the same stroke. */
  seed: number;
  /** #RRGGBB */
  color: string;
}

export const DEFAULT_DOODLE: DoodleSettings = { kind: 'underline', wobble: 40, weight: 4, seed: 1, color: '#FF5A36' };

/** What a doodle is drawn in: its contours, and whether they are filled instead of stroked. */
export interface Doodle {
  paths: VectorPath[];
  filled: boolean;
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

/** Catmull-Rom through the points as cubic handles: a smooth open (or closed) curve. */
function smooth(pts: Point[], closed = false): VectorPath {
  const n = pts.length;
  const points: VectorPoint[] = pts.map((p, i) => {
    const prev = pts[closed ? (i + n - 1) % n : Math.max(0, i - 1)]!;
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const tx = (next.x - prev.x) / 6;
    const ty = (next.y - prev.y) / 6;
    const q: VectorPoint = { x: p.x, y: p.y };
    if (closed || i > 0) q.in = { x: p.x - tx, y: p.y - ty };
    if (closed || i < n - 1) q.out = { x: p.x + tx, y: p.y + ty };
    return q;
  });
  return { closed, points };
}

const line = (pts: Point[]): VectorPath => ({ closed: false, points: pts.map((p) => ({ x: p.x, y: p.y })) });

/**
 * The doodle in a box `width` × `height` (the box is only a guide: a loop goes a little
 * past it, as by hand). Coordinates are in the box's space.
 */
export function doodle(s: Pick<DoodleSettings, 'kind' | 'wobble' | 'seed'>, width: number, height: number): Doodle {
  const random = seeded(s.seed);
  const k = clamp(s.wobble, 0, 100) / 100;
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const jitter = (scale: number) => (random() - 0.5) * 2 * scale * k;
  switch (s.kind) {
    case 'underline': {
      // A quick stroke: a little rise to the right, the hand lifting at the end.
      const n = 7;
      const lift = H * (0.2 + random() * 0.3);
      const pts = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return { x: W * t + jitter(W * 0.01), y: H / 2 + lift * (0.5 - t) * 0.6 + Math.sin(t * Math.PI) * lift * 0.3 + jitter(H * 0.35) };
      });
      return { paths: [smooth(pts)], filled: false };
    }
    case 'circle': {
      // A loop round the box: a bit more than one turn, the end passing the start.
      const n = 18;
      const turn = Math.PI * 2 * (1.08 + random() * 0.1);
      const start = -Math.PI * (0.55 + random() * 0.2);
      const pts = Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n;
        const r = 1 + t * 0.07 + jitter(0.04);
        const a = start + turn * t;
        return { x: W / 2 + (Math.cos(a) * W * r) / 2, y: H / 2 + (Math.sin(a) * H * r) / 2 };
      });
      return { paths: [smooth(pts)], filled: false };
    }
    case 'arrow': {
      // From the bottom left up to the top right, bent one way; a two-stroke head.
      const bend = (random() < 0.5 ? -1 : 1) * (0.15 + random() * 0.15);
      const n = 6;
      const pts = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        const x = W * t;
        const y = H * (1 - t);
        return { x: x + Math.sin(t * Math.PI) * bend * H + jitter(W * 0.02), y: y + Math.sin(t * Math.PI) * bend * W + jitter(H * 0.02) };
      });
      const tip = pts[n - 1]!;
      const from = pts[n - 2]!;
      const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
      const head = Math.min(W, H) * 0.22 + Math.max(W, H) * 0.04;
      const wing = (side: number) => {
        const a = angle + Math.PI + side * (0.5 + jitter(0.12));
        return { x: tip.x + Math.cos(a) * head, y: tip.y + Math.sin(a) * head };
      };
      return { paths: [smooth(pts), line([wing(-1), tip, wing(1)])], filled: false };
    }
    case 'sparks': {
      // Three short rays out of the bottom left corner, as round a thing that shines.
      const paths = [0.1, 0.5, 0.9].map((f) => {
        const a = -Math.PI / 2 + f * (Math.PI / 2) + jitter(0.12);
        const r0 = 0.25 + random() * 0.1;
        const r1 = 0.85 + random() * 0.15;
        const at = (r: number) => ({ x: Math.cos(a) * W * r, y: H + Math.sin(a) * H * r });
        return line([at(r0), at(r1)]);
      });
      return { paths, filled: false };
    }
    case 'sparkle': {
      // A four-pointed star with hollow sides, and a small one beside it.
      const star = (cx: number, cy: number, rx: number, ry: number): VectorPath => {
        const tips = [0, 1, 2, 3].map((i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / 2;
          const r = 1 + jitter(0.12);
          return { x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r };
        });
        // Each side bows in toward the middle: both handles pulled to the centre.
        const pull = 0.85;
        return {
          closed: true,
          points: tips.map((p, i) => {
            const prev = tips[(i + 3) % 4]!;
            const next = tips[(i + 1) % 4]!;
            return {
              x: p.x,
              y: p.y,
              in: { x: p.x + (cx - p.x) * pull + (prev.x - p.x) * 0.05, y: p.y + (cy - p.y) * pull + (prev.y - p.y) * 0.05 },
              out: { x: p.x + (cx - p.x) * pull + (next.x - p.x) * 0.05, y: p.y + (cy - p.y) * pull + (next.y - p.y) * 0.05 },
            };
          }),
        };
      };
      return { paths: [star(W * 0.38, H * 0.6, W * 0.38, H * 0.4), star(W * 0.86, H * 0.16, W * 0.14, H * 0.16)], filled: true };
    }
    case 'marker': {
      // A broad marker pass along the middle, a touch slanted.
      const n = 5;
      const tilt = jitter(H * 0.15);
      const pts = Array.from({ length: n }, (_, i) => {
        const t = i / (n - 1);
        return { x: W * t, y: H / 2 + tilt * (t - 0.5) + jitter(H * 0.06) };
      });
      return { paths: [smooth(pts)], filled: false };
    }
    case 'tick': {
      const pts = [
        { x: 0, y: H * 0.55 + jitter(H * 0.05) },
        { x: W * 0.36 + jitter(W * 0.04), y: H + jitter(H * 0.03) },
        { x: W + jitter(W * 0.03), y: jitter(H * 0.05) + H * 0.02 },
      ];
      return { paths: [line(pts)], filled: false };
    }
  }
}

/** The box a doodle is drawn in when nothing is selected. */
export function doodleBox(kind: DoodleKind): { width: number; height: number } {
  switch (kind) {
    case 'underline':
      return { width: 240, height: 24 };
    case 'circle':
      return { width: 240, height: 110 };
    case 'arrow':
      return { width: 160, height: 120 };
    case 'marker':
      return { width: 240, height: 36 };
    case 'tick':
      return { width: 64, height: 56 };
    default:
      return { width: 72, height: 72 };
  }
}

/** Fills, strokes and stroke width of the doodle's vector. */
export function doodlePaints(s: DoodleSettings, box: { height: number }, filled: boolean): { fills: Paint[]; strokes: Paint[]; strokeWeight: number } {
  const c = hexToColor(s.color) ?? hexToColor(DEFAULT_DOODLE.color)!;
  if (filled) return { fills: [solid(c)], strokes: [], strokeWeight: 1 };
  if (s.kind === 'marker') return { fills: [], strokes: [{ ...solid(c), opacity: 0.4, blendMode: 'MULTIPLY' }], strokeWeight: Math.max(4, round2(box.height * 0.9)) };
  return { fills: [], strokes: [solid(c)], strokeWeight: clamp(s.weight, 1, 40) };
}

/** Where a doodle goes round a selected box `b` (world): its own box, in world space. */
function placeBy(kind: DoodleKind, b: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const pad = Math.max(6, Math.min(b.width, b.height) * 0.12);
  switch (kind) {
    case 'underline': {
      const h = clamp(b.height * 0.3, 10, 40);
      return { x: b.x, y: b.y + b.height + 4 + b.height * 0.06, width: b.width, height: h };
    }
    case 'circle':
      return { x: b.x - pad * 2, y: b.y - pad, width: b.width + pad * 4, height: b.height + pad * 2 };
    case 'marker':
      return { x: b.x - pad / 2, y: b.y + b.height * 0.1, width: b.width + pad, height: b.height * 0.8 };
    case 'arrow': {
      // Pointing at the box from below on the left.
      const size = clamp(Math.max(b.width, b.height) * 0.5, 60, 240);
      return { x: b.x - size - 8, y: b.y + b.height * 0.5, width: size, height: size * 0.75 };
    }
    case 'tick': {
      const size = clamp(b.height, 24, 96);
      return { x: b.x - size * 1.3, y: b.y + (b.height - size * 0.9) / 2, width: size, height: size * 0.9 };
    }
    default: {
      // Sparks and the star sit above the top right corner.
      const size = clamp(Math.min(b.width, b.height) * 0.5, 28, 120);
      return { x: b.x + b.width - size * 0.2, y: b.y - size * 0.8, width: size, height: size };
    }
  }
}

const NAMES: Record<DoodleKind, string> = {
  underline: 'Подчёркивание',
  circle: 'Обводка',
  arrow: 'Стрелка от руки',
  sparks: 'Искры',
  sparkle: 'Звёздочка',
  marker: 'Маркер',
  tick: 'Галочка',
};

/** The kind's name, translated. */
export function doodleName(kind: DoodleKind): string {
  return tr(NAMES[kind]);
}

/**
 * Puts the doodle on the canvas. With something selected — round it (the marker goes
 * behind it, in the same parent); otherwise — in the middle of the view. Selects it.
 */
export function insertDoodle(editor: Editor, s: DoodleSettings): NodeId | null {
  const d = editor.doc;
  if (d.readOnly) return null;
  const sel = editor.topLevelSelection();
  const around = sel.length ? editor.selectionBounds() : null;
  let world: { x: number; y: number; width: number; height: number };
  let parent: NodeId;
  if (around) {
    world = placeBy(s.kind, around);
    parent = d.parent(sel[0]!) ?? editor.pageId;
  } else {
    const box = doodleBox(s.kind);
    const centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    world = { x: centre.x - box.width / 2, y: centre.y - box.height / 2, ...box };
    parent = editor.containerAt(centre);
  }
  const { paths, filled } = doodle(s, world.width, world.height);
  const bounds = pathsBounds(paths)!;
  const local = editor.toParentSpace(parent, { x: world.x + bounds.x, y: world.y + bounds.y });
  const { fills, strokes, strokeWeight } = doodlePaints(s, world, filled);
  const behind = around && s.kind === 'marker' ? sel[0]! : null;
  let id: NodeId | null = null;
  editor.commit(
    doodleName(s.kind),
    (tx) => {
      id = tx.create(
        'VECTOR',
        parent,
        {
          name: doodleName(s.kind),
          x: round2(local.x),
          y: round2(local.y),
          width: round2(Math.max(bounds.width, 0.01)),
          height: round2(Math.max(bounds.height, 0.01)),
          vectorPaths: mapPaths(paths, (p) => ({ x: round2(p.x - bounds.x), y: round2(p.y - bounds.y) })),
          fills,
          strokes,
          strokeWeight,
          strokeAlign: 'CENTER',
          strokeCap: 'ROUND',
          strokeJoin: 'ROUND',
          // In an auto layout the doodle stays where it was drawn instead of joining the row.
          ...(d.get(parent, 'layoutMode') !== 'NONE' ? { positioning: 'ABSOLUTE' as const } : {}),
        },
        behind ? { before: behind } : { at: 'end' },
      );
    },
    () => (id ? [id] : []),
  );
  if (id) editor.appear([id]);
  return id;
}
