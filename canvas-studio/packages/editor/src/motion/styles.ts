// Motion, stage 3: animation styles (Figma Motion's fade, move, scale presets, and styles of one's own, which
// Figma has as «coming soon»). A style is keyframes relative to where a layer is: position and turn as offsets
// from its place at the start, scale and opacity as they are; times as parts of the style's duration. Applied at
// the playhead, several at one moment play together (a move with a fade); «after the previous» puts one after the
// layer's last keyframe. Styles of one's own live in the file (the document's `animationStyles`).

import { MOTION_PROPS, tr, type AnimationStyle, type Document, type MotionProp, type NodeId, type Transaction } from '#core';
import { DEFAULT_MOTION, MAX_DURATION, removeKeyframe, setKeyframe, setKeyframeEase, setMotion, shownValue } from './model.ts';

/** Position and turn are offsets from where the layer is; scale and opacity are values. */
export const OFFSET_PROPS: ReadonlySet<MotionProp> = new Set<MotionProp>(['x', 'y', 'rotation']);

const fade = (from: number, to: number) => [{ t: 0, v: from }, { t: 1, v: to }];

/** The ready styles (ids start with «builtin:»). */
export const BUILTIN_STYLES: readonly AnimationStyle[] = [
  { id: 'builtin:fade-in', name: tr('Появление'), duration: 400, ease: 'ease-out', tracks: { opacity: fade(0, 1) } },
  { id: 'builtin:fade-out', name: tr('Исчезновение'), duration: 400, ease: 'ease-in', tracks: { opacity: fade(1, 0) } },
  { id: 'builtin:move-left', name: tr('Сдвиг слева'), duration: 500, ease: 'ease-out', tracks: { x: [{ t: 0, v: -80 }, { t: 1, v: 0 }], opacity: fade(0, 1) } },
  { id: 'builtin:move-right', name: tr('Сдвиг справа'), duration: 500, ease: 'ease-out', tracks: { x: [{ t: 0, v: 80 }, { t: 1, v: 0 }], opacity: fade(0, 1) } },
  { id: 'builtin:move-up', name: tr('Сдвиг снизу'), duration: 500, ease: 'ease-out', tracks: { y: [{ t: 0, v: 60 }, { t: 1, v: 0 }], opacity: fade(0, 1) } },
  { id: 'builtin:move-down', name: tr('Сдвиг сверху'), duration: 500, ease: 'ease-out', tracks: { y: [{ t: 0, v: -60 }, { t: 1, v: 0 }], opacity: fade(0, 1) } },
  { id: 'builtin:scale-in', name: tr('Увеличение'), duration: 500, ease: 'ease-out-back', tracks: { scale: fade(0.6, 1), opacity: fade(0, 1) } },
  { id: 'builtin:scale-out', name: tr('Уменьшение'), duration: 400, ease: 'ease-in', tracks: { scale: fade(1, 0.6), opacity: fade(1, 0) } },
  { id: 'builtin:pulse', name: tr('Пульс'), duration: 600, ease: 'ease-in-out', tracks: { scale: [{ t: 0, v: 1 }, { t: 0.5, v: 1.1 }, { t: 1, v: 1 }] } },
  { id: 'builtin:wiggle', name: tr('Покачивание'), duration: 600, ease: 'ease-in-out', tracks: { rotation: [{ t: 0, v: 0 }, { t: 0.25, v: -8 }, { t: 0.75, v: 8 }, { t: 1, v: 0 }] } },
];

/** Every style offered: the ready ones, then the file's own. */
export function allStyles(doc: Document): AnimationStyle[] {
  return [...BUILTIN_STYLES, ...ownStyles(doc)];
}

export function ownStyles(doc: Document): AnimationStyle[] {
  return doc.get(doc.rootId, 'animationStyles');
}

/** The moment a layer's last keyframe is at (0 without any). */
export function lastKeyTime(doc: Document, id: NodeId): number {
  const keys = doc.get(id, 'keyframes') ?? {};
  return Math.max(0, ...MOTION_PROPS.flatMap((p) => (keys[p] ?? []).map((k) => k.t)));
}

/**
 * Puts a style's keyframes on layers of a timeline: from `start` (or after each layer's last keyframe), offsets
 * from where each layer is then; keyframes already inside that span of those properties give way. The frame's
 * timeline grows when the style runs past its end.
 */
export function applyStyle(doc: Document, tx: Transaction, frame: NodeId, ids: readonly NodeId[], style: AnimationStyle, start: number, after: boolean): void {
  let end = 0;
  for (const id of ids) {
    const t0 = Math.round(after ? lastKeyTime(doc, id) : start);
    const t1 = t0 + style.duration;
    end = Math.max(end, t1);
    for (const prop of MOTION_PROPS) {
      const frames = style.tracks[prop];
      if (!frames?.length) continue;
      const base = shownValue(doc, id, prop, t0);
      for (const k of doc.get(id, 'keyframes')?.[prop] ?? []) if (k.t > t0 && k.t <= t1) removeKeyframe(doc, tx, id, prop, k.t);
      for (const f of frames) {
        const t = t0 + Math.round(f.t * style.duration);
        setKeyframe(doc, tx, id, prop, t, OFFSET_PROPS.has(prop) ? base + f.v : f.v);
        setKeyframeEase(doc, tx, id, prop, t, { text: f.ease ?? style.ease });
      }
    }
  }
  const motion = doc.get(frame, 'motion') ?? DEFAULT_MOTION;
  if (end > motion.duration) setMotion(doc, tx, frame, { ...motion, duration: Math.min(MAX_DURATION, end) });
}

/**
 * A style of one's own from a layer's keyframes: their span is its duration; position and turn become offsets
 * from the value at the span's start, scale and opacity stay as they are; each keyframe's curve goes with it.
 */
export function styleFromLayer(doc: Document, id: NodeId, name: string, newId: string): AnimationStyle | null {
  const keys = doc.get(id, 'keyframes');
  if (!keys) return null;
  const all = MOTION_PROPS.flatMap((p) => (keys[p] ?? []).map((k) => k.t));
  if (all.length < 2) return null;
  const t0 = Math.min(...all);
  const duration = Math.max(...all) - t0;
  if (duration <= 0) return null;
  const tracks: AnimationStyle['tracks'] = {};
  for (const prop of MOTION_PROPS) {
    const list = keys[prop];
    if (!list?.length) continue;
    const from = list[0]!.v;
    tracks[prop] = list.map((k) => ({ t: Math.round(((k.t - t0) / duration) * 1e6) / 1e6, v: OFFSET_PROPS.has(prop) ? k.v - from : k.v, ...(k.ease ? { ease: k.ease } : {}) }));
  }
  return { id: newId, name, duration, ease: 'ease-in-out', tracks };
}

export function saveStyle(doc: Document, tx: Transaction, style: AnimationStyle): void {
  tx.set(doc.rootId, 'animationStyles', [...ownStyles(doc).filter((s) => s.id !== style.id), style]);
}

export function renameStyle(doc: Document, tx: Transaction, id: string, name: string): void {
  tx.set(doc.rootId, 'animationStyles', ownStyles(doc).map((s) => (s.id === id ? { ...s, name } : s)));
}

export function deleteStyle(doc: Document, tx: Transaction, id: string): void {
  tx.set(doc.rootId, 'animationStyles', ownStyles(doc).filter((s) => s.id !== id));
}
