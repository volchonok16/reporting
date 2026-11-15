// Export of an animated frame to Lottie (step 8; Figma Motion exports Lottie too). Our own writer of the
// open Lottie JSON format, nothing borrowed. Each animated layer becomes a picture layer that moves by Lottie's own
// keyframes; what does not move becomes pictures too, in the same layer order (a frame's own fill under its
// children, a still layer between moving ones). Pictures keep the look exactly — texts, gradients, shadows, effects
// — while the motion stays real motion. The motion is sampled 60 times a second and keyframes lying on a straight
// line are dropped, so any curve (springs too) plays as on the canvas with few keyframes. A layer moving inside a
// moving layer is parented to it, as in After Effects. Not carried: clipping by a frame inside the animated frame
// (the composition clips to the frame itself).

import { MOTION_PROPS, type Document, type NodeId } from '#core';
import { invert, multiply, nodeTransform, scale as scaleBy, translate, type Matrix } from '#geometry';
import type { Pose } from '#render';
import { fullPose } from './model.ts';

/** A piece of the picture: a moving layer (with what does not move inside it), a frame's own look under its children, or a still layer. */
export interface LottieUnit {
  id: NodeId;
  kind: 'layer' | 'own' | 'still';
  /** The moving layer it moves with (null — the frame itself). */
  container: NodeId | null;
}

/** A unit drawn: its picture and where the picture sits in the layer's own space. */
export interface UnitPicture {
  url: string;
  /** Pixels. */
  width: number;
  height: number;
  /** Top-left corner of the picture in the layer's own coordinates. */
  x: number;
  y: number;
  /** Pixels per unit of the layer. */
  k: number;
}

export const LOTTIE_FPS = 60;

function hasKeys(doc: Document, id: NodeId): boolean {
  const keys = doc.get(id, 'keyframes');
  return !!keys && MOTION_PROPS.some((p) => (keys[p]?.length ?? 0) > 0);
}

/** The pieces of a frame's picture, bottom first, as they are painted. */
export function lottieUnits(doc: Document, root: NodeId): LottieUnit[] {
  const out: LottieUnit[] = [];
  const moving = new Set<NodeId>();
  doc.store.walk(root, (id) => {
    if (id !== root && hasKeys(doc, id)) moving.add(id);
    return true;
  });
  const holdsMoving = (id: NodeId): boolean => {
    let found = false;
    doc.store.walk(id, (n) => {
      if (n !== id && moving.has(n)) found = true;
      return !found;
    });
    return found;
  };
  const shown = (id: NodeId) => doc.get(id, 'visible') !== false;
  // Inside a moving layer: what does not move is in its picture; moving layers are units of their own.
  const inside = (id: NodeId, container: NodeId) => {
    if (!shown(id)) return;
    if (moving.has(id)) return walk(id, container);
    for (const c of doc.children(id)) inside(c, container);
  };
  const walk = (id: NodeId, container: NodeId | null): void => {
    if (!shown(id)) return;
    if (id === root || (!moving.has(id) && holdsMoving(id))) {
      out.push({ id, kind: 'own', container });
      for (const c of doc.children(id)) walk(c, container);
    } else if (moving.has(id)) {
      out.push({ id, kind: 'layer', container });
      for (const c of doc.children(id)) inside(c, id);
    } else out.push({ id, kind: 'still', container });
  };
  walk(root, null);
  return out;
}

/** What a unit's picture leaves out: moving layers inside a moving one, everything inside a frame's own look. */
export function unitHides(doc: Document, root: NodeId, unit: LottieUnit): NodeId[] {
  if (unit.kind === 'own') return [...doc.children(unit.id)];
  if (unit.kind === 'still') return [];
  const out: NodeId[] = [];
  doc.store.walk(unit.id, (n) => {
    if (n !== unit.id && hasKeys(doc, n)) {
      out.push(n);
      return false;
    }
    return true;
  });
  return out.filter((n) => n !== root);
}

/** A layer's place in its parent at a pose: position, turn, scale around its centre. */
function localMatrix(doc: Document, id: NodeId, p: Pose | undefined): Matrix {
  let m = nodeTransform(p?.x ?? doc.get(id, 'x'), p?.y ?? doc.get(id, 'y'), p?.rotation ?? doc.get(id, 'rotation'));
  const s = p?.scale ?? 1;
  if (s !== 1) {
    const cx = doc.get(id, 'width') / 2;
    const cy = doc.get(id, 'height') / 2;
    m = multiply(m, multiply(translate(cx, cy), multiply(scaleBy(s), translate(-cx, -cy))));
  }
  return m;
}

/** From `id`'s own space to `root`'s, as the document holds it (no pose). */
function toRoot(doc: Document, root: NodeId, id: NodeId): Matrix {
  let m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (let at: NodeId | null = id; at !== null && at !== root; at = doc.parent(at)) m = multiply(localMatrix(doc, at, undefined), m);
  return m;
}

const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Keeps the samples a straight line between kept ones cannot stand for (within `tol`): the end points always. */
export function simplify(values: readonly number[][], tol: number): number[] {
  const keep = new Set<number>([0, values.length - 1]);
  const off = (i: number, a: number, b: number) => {
    const t = (i - a) / (b - a);
    return Math.max(...values[i]!.map((v, d) => Math.abs(v - (values[a]![d]! + (values[b]![d]! - values[a]![d]!) * t))));
  };
  const split = (a: number, b: number) => {
    if (b - a < 2) return;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const o = off(i, a, b);
      if (o > worst) [worst, at] = [o, i];
    }
    if (worst > tol) {
      keep.add(at);
      split(a, at);
      split(at, b);
    }
  };
  split(0, values.length - 1);
  return [...keep].sort((x, y) => x - y);
}

/** A Lottie property from samples: still when it never changes, else linear keyframes at the kept frames. */
function property(samples: number[][], tol: number, scalar = false): object {
  const first = samples[0]!;
  if (samples.every((s) => s.every((v, d) => Math.abs(v - first[d]!) <= tol))) return { a: 0, k: scalar ? round(first[0]!) : first.map((v) => round(v)) };
  const kept = simplify(samples, tol);
  const dims = first.length;
  const k = kept.map((frame, i) => {
    const s = samples[frame]!.map((v) => round(v));
    if (i === kept.length - 1) return { t: frame, s };
    return { t: frame, s, o: { x: Array(dims).fill(0), y: Array(dims).fill(0) }, i: { x: Array(dims).fill(1), y: Array(dims).fill(1) } };
  });
  return { a: 1, k };
}

const angleOf = (m: Matrix) => (Math.atan2(m.b, m.a) * 180) / Math.PI;
const sizeOf = (m: Matrix) => Math.hypot(m.a, m.b);

/** Turns kept between −180 and 180 would jump at the seam: each sample goes the short way from the one before. */
function unwrap(list: number[]): number[] {
  for (let i = 1; i < list.length; i++) {
    while (list[i]! - list[i - 1]! > 180) list[i]! -= 360;
    while (list[i]! - list[i - 1]! < -180) list[i]! += 360;
  }
  return list;
}

/**
 * The frame's animation as a Lottie composition. `picture` draws a unit (null — nothing to see, left out).
 * The size is the frame's own; one round of its timeline.
 */
export function buildLottie(doc: Document, root: NodeId, picture: (unit: LottieUnit) => UnitPicture | null, fps = LOTTIE_FPS): Record<string, unknown> {
  const motion = doc.get(root, 'motion');
  const duration = motion?.duration ?? 1000;
  const frames = Math.max(1, Math.round((duration / 1000) * fps));
  // The last sample is the end of the round, not the start of the next one (a looping timeline wraps at its duration).
  const at = (i: number) => Math.min(duration - 0.001, (i * 1000) / fps);
  const poses = Array.from({ length: frames + 1 }, (_, i) => fullPose(doc, root, (id) => (id === root ? at(i) : (i * 1000) / fps)));
  const units = lottieUnits(doc, root);
  const pictures = new Map<NodeId, UnitPicture>();
  const assets: object[] = [];
  const drawn: { unit: LottieUnit; pic: UnitPicture }[] = [];
  for (const unit of units) {
    // A moving layer with nothing of its own to see still carries what moves inside it: an empty null layer.
    const pic = picture(unit) ?? (unit.kind === 'layer' ? { url: '', width: 0, height: 0, x: 0, y: 0, k: 1 } : null);
    if (!pic) continue;
    if (unit.kind === 'layer') pictures.set(unit.id, pic);
    drawn.push({ unit, pic });
  }
  const rootMoves = hasKeys(doc, root);
  // Index 1 — the frame's own motion (a null layer), when it moves; then the units, top first.
  const ROOT_IND = 1;
  const indexOf = new Map<NodeId, number>();
  drawn.forEach(({ unit }, i) => unit.kind === 'layer' && indexOf.set(unit.id, i + 2));
  const ks = (p: object, a: number[], r: object, s: object, o: object) => ({ o, r, p, a: { a: 0, k: a.map((v) => round(v)) }, s });
  const layers: object[] = [];
  drawn.forEach(({ unit, pic }, i) => {
    const id = unit.id;
    const c = unit.container;
    // From the parent of the unit (as the document holds it) to the space of the layer it moves with.
    const parentToRoot = unit.kind === 'own' && id === root ? null : toRoot(doc, root, doc.parent(id)!);
    let mc: Matrix | null = parentToRoot;
    if (c && parentToRoot) {
      const cp = pictures.get(c)!;
      mc = multiply(multiply(scaleBy(cp.k), translate(-cp.x, -cp.y)), multiply(invert(toRoot(doc, root, c))!, parentToRoot));
    }
    const cx = doc.get(id, 'width') / 2;
    const cy = doc.get(id, 'height') / 2;
    const anchor = id === root ? [(0 - pic.x) * pic.k, (0 - pic.y) * pic.k] : [(cx - pic.x) * pic.k, (cy - pic.y) * pic.k];
    const pos: number[][] = [];
    const rot: number[] = [];
    const scl: number[][] = [];
    const op: number[][] = [];
    for (const pose of poses) {
      // The root's own motion is its null layer's; the root's picture sits still in it.
      const f = id === root ? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } : multiply(mc!, localMatrix(doc, id, pose.get(id)));
      const at = id === root ? { x: 0, y: 0 } : { x: f.a * cx + f.c * cy + f.e, y: f.b * cx + f.d * cy + f.f };
      pos.push([at.x, at.y]);
      rot.push(angleOf(f));
      const size = (sizeOf(f) / pic.k) * 100;
      scl.push([size, size]);
      // Lottie does not pass opacity down to children: each unit carries its own and every layer's above it.
      let alpha = 1;
      for (let at2: NodeId | null = id; at2 !== null; at2 = at2 === root ? null : doc.parent(at2)) alpha *= pose.get(at2)?.opacity ?? doc.get(at2, 'opacity');
      op.push([alpha * 100]);
    }
    unwrap(rot);
    const empty = !pic.url;
    const layer: Record<string, unknown> = {
      ddd: 0,
      ind: i + 2,
      ty: empty ? 3 : 2,
      nm: String(doc.get(id, 'name') ?? ''),
      ...(empty ? {} : { refId: `image_${i}` }),
      sr: 1,
      ks: ks(property(pos, 0.05), anchor, property(rot.map((v) => [v]), 0.05, true), property(scl, 0.05), property(op, 0.1, true)),
      ao: 0,
      ip: 0,
      op: frames,
      st: 0,
      bm: 0,
    };
    const parent = c ? indexOf.get(c) : rootMoves ? ROOT_IND : undefined;
    if (parent !== undefined) layer.parent = parent;
    layers.push(layer);
    if (!empty) assets.push({ id: `image_${i}`, w: pic.width, h: pic.height, u: '', p: pic.url, e: 1 });
  });
  layers.reverse();
  if (rootMoves) {
    // The frame moving: a null layer the rest hangs on; the composition is the frame as it stands in the file.
    const base = invert(localMatrix(doc, root, undefined))!;
    const pos: number[][] = [];
    const rot: number[] = [];
    const scl: number[][] = [];
    for (const pose of poses) {
      const f = multiply(base, localMatrix(doc, root, pose.get(root)));
      pos.push([f.e, f.f]);
      rot.push(angleOf(f));
      scl.push([sizeOf(f) * 100, sizeOf(f) * 100]);
    }
    unwrap(rot);
    layers.push({ ddd: 0, ind: ROOT_IND, ty: 3, nm: String(doc.get(root, 'name') ?? ''), sr: 1, ks: ks(property(pos, 0.05), [0, 0], property(rot.map((v) => [v]), 0.05, true), property(scl, 0.05), { a: 0, k: 100 }), ao: 0, ip: 0, op: frames, st: 0, bm: 0 });
  }
  return {
    v: '5.7.4',
    fr: fps,
    ip: 0,
    op: frames,
    w: Math.round(doc.get(root, 'width')),
    h: Math.round(doc.get(root, 'height')),
    nm: String(doc.get(root, 'name') ?? ''),
    ddd: 0,
    assets,
    layers,
    markers: [],
  };
}
