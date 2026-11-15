// Motion, stage 2 (Figma Motion): a frame's timeline. A frame with `motion` plays for its duration; each layer
// inside it may hold keyframes of its position, turn, scale and opacity. Between two keyframes the value follows
// the curve of the first one (its own text, or an EASING variable in the mode in effect at the frame); before
// the first and after the last it holds. A property without keyframes keeps the document's value. What a moment
// looks like is a pose the scene shows; the document changes only when keyframes are set.

import { MOTION_PROPS, parseEasing, type Document, type Easing, type Keyframe, type LayerKeyframes, type MotionProp, type MotionSettings, type NodeId, type Transaction } from '#core';
import { resolveVariable } from '#components';
import type { Pose } from '#render';
import { easingFunction } from '../prototype/easing.ts';

export const DEFAULT_MOTION: MotionSettings = { duration: 2000, loop: true };
/** The curve a new keyframe gets (as in Figma's default). */
export const DEFAULT_EASE = 'ease-in-out';
export const MIN_DURATION = 100;
export const MAX_DURATION = 60_000;
/** Two keyframes closer than this are the same moment. */
const SAME_MOMENT = 1;

/** The frame whose timeline a layer is on: itself or the nearest frame around it with `motion`. */
export function motionFrameOf(doc: Document, id: NodeId): NodeId | null {
  for (let at: NodeId | null = id; at !== null && doc.type(at) !== 'PAGE'; at = doc.parent(at)) {
    if (doc.get(at, 'motion')) return at;
  }
  return null;
}

/** The frame a timeline can be made for: the selected layer's outermost frame on the page (Figma: motion mode per frame). */
export function timelineCandidate(doc: Document, id: NodeId): NodeId | null {
  const own = motionFrameOf(doc, id);
  if (own) return own;
  let top: NodeId | null = null;
  for (let at: NodeId | null = id; at !== null && doc.type(at) !== 'PAGE'; at = doc.parent(at)) {
    if (['FRAME', 'COMPONENT'].includes(doc.type(at))) top = at;
  }
  return top;
}

/** The curve from a keyframe to the next. */
export function keyframeEasing(doc: Document, k: Keyframe, modeNode: NodeId | null): Easing {
  if (k.easeVar && doc.store.isAlive(k.easeVar)) {
    const v = resolveVariable(doc, k.easeVar, modeNode);
    const e = typeof v === 'string' ? parseEasing(v) : null;
    if (e) return e;
  }
  return (k.ease ? parseEasing(k.ease) : null) ?? parseEasing(DEFAULT_EASE)!;
}

/** A property's value at `t` from its keyframes (in time order). */
export function valueAt(doc: Document, keys: readonly Keyframe[], t: number, modeNode: NodeId | null): number | undefined {
  if (keys.length === 0) return undefined;
  if (t <= keys[0]!.t) return keys[0]!.v;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]!.t <= t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const { ease } = easingFunction(keyframeEasing(doc, a, modeNode), span);
  return a.v + (b.v - a.v) * ease((t - a.t) / span);
}

/**
 * The layers of a frame's timeline that hold keyframes (the frame itself too), in layer order. A frame with a
 * timeline of its own inside (an animated component's instance) is on this one with its own keyframes only:
 * what is inside it plays on its own timeline (stage 4).
 */
export function animatedLayers(doc: Document, frame: NodeId, withRoot = true): NodeId[] {
  const out: NodeId[] = [];
  if (withRoot && doc.get(frame, 'keyframes')) out.push(frame);
  doc.store.walk(frame, (id) => {
    if (doc.get(id, 'keyframes')) out.push(id);
    return !doc.get(id, 'motion');
  });
  return out;
}

/** Frames with timelines of their own inside `root` (not inside each other). */
export function nestedTimelines(doc: Document, root: NodeId): NodeId[] {
  const out: NodeId[] = [];
  doc.store.walk(root, (id) => {
    if (!doc.get(id, 'motion')) return true;
    out.push(id);
    return false;
  });
  return out;
}

/** A moment of a timeline from the time it has played: round again when it loops, else held at its end. */
export function localTime(settings: MotionSettings, played: number): number {
  if (played <= 0) return 0;
  return settings.loop ? played % settings.duration : Math.min(played, settings.duration);
}

/**
 * Everything that moves under `root` at once (stage 4): its own timeline at `played(root)`, and every timeline
 * inside it — animated components' instances — at theirs, each round its own duration.
 */
export function fullPose(doc: Document, root: NodeId, played: (id: NodeId) => number, into = new Map<NodeId, Pose>(), nested = false): Map<NodeId, Pose> {
  const own = doc.get(root, 'motion');
  // A nested timeline's own keyframes belong to the timeline around it (where it moves), not to its own.
  for (const [id, p] of poseAt(doc, root, own ? localTime(own, played(root)) : played(root), !nested)) into.set(id, { ...into.get(id), ...p });
  for (const n of nestedTimelines(doc, root)) fullPose(doc, n, played, into, true);
  return into;
}

/** What the frame looks like at `t`: the pose of every layer with keyframes. */
export function poseAt(doc: Document, frame: NodeId, t: number, withRoot = true): Map<NodeId, Pose> {
  const pose = new Map<NodeId, Pose>();
  for (const id of animatedLayers(doc, frame, withRoot)) {
    const keys = doc.get(id, 'keyframes')!;
    const p: Pose = {};
    for (const prop of MOTION_PROPS) {
      const list = keys[prop];
      if (!list || list.length === 0) continue;
      const v = valueAt(doc, list, t, frame);
      if (v !== undefined) p[prop] = prop === 'opacity' ? Math.max(0, Math.min(1, v)) : v;
    }
    if (Object.keys(p).length) pose.set(id, p);
  }
  return pose;
}

/** A property's value as the document holds it (scale is 1: it lives only on the timeline). */
export function baseValue(doc: Document, id: NodeId, prop: MotionProp): number {
  return prop === 'scale' ? 1 : doc.get(id, prop);
}

/** The value shown at `t`: from keyframes when there are any, else the document's. */
export function shownValue(doc: Document, id: NodeId, prop: MotionProp, t: number): number {
  const list = doc.get(id, 'keyframes')?.[prop];
  return list && list.length ? (valueAt(doc, list, t, motionFrameOf(doc, id)) ?? baseValue(doc, id, prop)) : baseValue(doc, id, prop);
}

// ---------- editing ----------

const sorted = (list: readonly Keyframe[]) => [...list].sort((a, b) => a.t - b.t);

function writeKeys(tx: Transaction, doc: Document, id: NodeId, prop: MotionProp, list: Keyframe[]): void {
  const all: LayerKeyframes = { ...(doc.get(id, 'keyframes') ?? {}) };
  if (list.length) all[prop] = sorted(list);
  else delete all[prop];
  tx.set(id, 'keyframes', Object.keys(all).length ? all : null);
}

/** Puts a keyframe (replacing one at the same moment; keeping its curve). */
export function setKeyframe(doc: Document, tx: Transaction, id: NodeId, prop: MotionProp, t: number, v: number): void {
  const list = [...(doc.get(id, 'keyframes')?.[prop] ?? [])];
  const at = list.findIndex((k) => Math.abs(k.t - t) < SAME_MOMENT);
  if (at >= 0) list[at] = { ...list[at]!, v };
  else list.push({ t: Math.round(t), v, ease: DEFAULT_EASE });
  writeKeys(tx, doc, id, prop, list);
}

export function removeKeyframe(doc: Document, tx: Transaction, id: NodeId, prop: MotionProp, t: number): void {
  const list = (doc.get(id, 'keyframes')?.[prop] ?? []).filter((k) => Math.abs(k.t - t) >= SAME_MOMENT);
  writeKeys(tx, doc, id, prop, list);
}

/** Moves a keyframe in time (one already at the target moment is replaced). */
export function moveKeyframe(doc: Document, tx: Transaction, id: NodeId, prop: MotionProp, from: number, to: number): void {
  const list = [...(doc.get(id, 'keyframes')?.[prop] ?? [])];
  const k = list.find((x) => Math.abs(x.t - from) < SAME_MOMENT);
  if (!k) return;
  const rest = list.filter((x) => x !== k && Math.abs(x.t - to) >= SAME_MOMENT);
  writeKeys(tx, doc, id, prop, [...rest, { ...k, t: Math.round(to) }]);
}

/** The curve of a keyframe: text, or an EASING variable (which then wins). */
export function setKeyframeEase(doc: Document, tx: Transaction, id: NodeId, prop: MotionProp, t: number, ease: { text?: string; variable?: string | null }): void {
  const list = (doc.get(id, 'keyframes')?.[prop] ?? []).map((k) => {
    if (Math.abs(k.t - t) >= SAME_MOMENT) return k;
    const { easeVar: _, ...rest } = k;
    return { ...rest, ...(ease.text ? { ease: ease.text } : {}), ...(ease.variable ? { easeVar: ease.variable } : {}) };
  });
  writeKeys(tx, doc, id, prop, list);
}

/** A frame gets a timeline (or loses it, keyframes inside it too). */
export function setMotion(doc: Document, tx: Transaction, frame: NodeId, settings: MotionSettings | null): void {
  if (settings) {
    tx.set(frame, 'motion', { duration: Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(settings.duration))), loop: settings.loop });
    return;
  }
  tx.set(frame, 'motion', null);
  for (const id of animatedLayers(doc, frame)) tx.set(id, 'keyframes', null);
}
