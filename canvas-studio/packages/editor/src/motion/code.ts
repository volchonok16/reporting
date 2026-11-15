// Motion, stage 5: a frame's timeline as code (Figma Motion's Dev Mode: CSS and JSON). CSS keeps it exact: each
// property of each layer is an animation of its own — x and y through registered custom properties (so they move
// on their own keyframes and curves), rotate, scale and opacity through their own properties; each keyframe holds
// the curve to the next one (a spring as `linear(…)` points). JSON is the timeline itself, curves resolved.

import { MOTION_PROPS, type Document, type Easing, type MotionProp, type NodeId } from '#core';
import { slug } from '../dev-code.ts';
import { BEZIER_PRESETS, springAt, springDuration } from '../prototype/easing.ts';
import { animatedLayers, baseValue, keyframeEasing, nestedTimelines } from './model.ts';

const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** A curve as a CSS timing function. */
export function cssTiming(e: Easing): string {
  if (e.type === 'LINEAR') return 'linear';
  if (e.type === 'SPRING') {
    // A spring has no Bézier: its course as points of linear(), the time it takes to settle.
    const ms = springDuration(e);
    // Ends exactly where it goes: a settled spring is at 1.
    const points = Array.from({ length: 21 }, (_, i) => (i === 20 ? '1' : num(springAt(e, ((i / 20) * ms) / 1000))));
    return `linear(${points.join(', ')})`;
  }
  const b = e.type === 'CUSTOM_BEZIER' ? e.bezier : BEZIER_PRESETS[e.type];
  return `cubic-bezier(${b.map(num).join(', ')})`;
}

const VALUE: Record<MotionProp, (v: number, base: number) => string> = {
  x: (v, base) => `--cs-x: ${num(v - base)}px`,
  y: (v, base) => `--cs-y: ${num(v - base)}px`,
  rotation: (v, base) => `rotate: ${num(v - base)}deg`,
  scale: (v) => `scale: ${num(v)}`,
  opacity: (v) => `opacity: ${num(Math.max(0, Math.min(1, v)))}`,
};

/** The layers of a frame's timeline and those of the timelines inside it, with the frame each plays on. */
function layersWithFrames(doc: Document, frame: NodeId): { id: NodeId; frame: NodeId }[] {
  const out = animatedLayers(doc, frame).map((id) => ({ id, frame }));
  for (const n of nestedTimelines(doc, frame)) out.push(...layersWithFrames(doc, n).filter((l) => l.id !== n));
  return out;
}

/** The frame's timeline as CSS: a class per animated layer, its animations and @keyframes. */
export function motionCss(doc: Document, frame: NodeId): string {
  const out: string[] = [
    '/* Положение — через --cs-x и --cs-y, чтобы X и Y двигались каждый по своим кадрам */',
    "@property --cs-x { syntax: '<length>'; inherits: false; initial-value: 0px; }",
    "@property --cs-y { syntax: '<length>'; inherits: false; initial-value: 0px; }",
  ];
  const used = new Map<string, number>();
  for (const { id, frame: on } of layersWithFrames(doc, frame)) {
    const motion = doc.get(on, 'motion');
    const keys = doc.get(id, 'keyframes');
    if (!motion || !keys) continue;
    let name = slug(doc.get(id, 'name')) || 'layer';
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}-${n}`;
    const seconds = `${num(motion.duration / 1000)}s`;
    const repeat = motion.loop ? 'infinite' : '1 both';
    const animations: string[] = [];
    const frames: string[] = [];
    for (const prop of MOTION_PROPS) {
      const list = keys[prop];
      if (!list?.length) continue;
      const anim = `${name}-${prop === 'rotation' ? 'rotate' : prop}`;
      animations.push(`${anim} ${seconds} ${repeat}`);
      const base = baseValue(doc, id, prop);
      const at = (t: number) => `${num((t / motion.duration) * 100)}%`;
      const steps: string[] = [];
      if (list[0]!.t > 0) steps.push(`  0% { ${VALUE[prop](list[0]!.v, base)}; }`);
      list.forEach((k, i) => {
        const timing = i < list.length - 1 ? ` animation-timing-function: ${cssTiming(keyframeEasing(doc, k, on))};` : '';
        steps.push(`  ${at(k.t)} { ${VALUE[prop](k.v, base)};${timing} }`);
      });
      if (list[list.length - 1]!.t < motion.duration) steps.push(`  100% { ${VALUE[prop](list[list.length - 1]!.v, base)}; }`);
      frames.push(`@keyframes ${anim} {\n${steps.join('\n')}\n}`);
    }
    if (!animations.length) continue;
    const moves = keys.x?.length || keys.y?.length;
    out.push(`\n/* ${doc.get(id, 'name').replace(/\*\//g, '* /').replace(/</g, '\\3c ')} */\n.${name} {\n${moves ? '  translate: var(--cs-x) var(--cs-y);\n' : ''}  transform-origin: center;\n  animation: ${animations.join(', ')};\n}\n${frames.join('\n')}`);
  }
  return out.join('\n');
}

/** The frame's timeline as JSON: duration, looping, each layer's keyframes with their curves as CSS writes them. */
export function motionJson(doc: Document, frame: NodeId): string {
  const motion = doc.get(frame, 'motion');
  const layers = layersWithFrames(doc, frame).map(({ id, frame: on }) => {
    const keys = doc.get(id, 'keyframes') ?? {};
    const props: Record<string, { t: number; v: number; ease?: string }[]> = {};
    for (const prop of MOTION_PROPS) {
      const list = keys[prop];
      if (list?.length) props[prop] = list.map((k, i) => ({ t: k.t, v: k.v, ...(i < list.length - 1 ? { ease: cssTiming(keyframeEasing(doc, k, on)) } : {}) }));
    }
    return { id, name: doc.get(id, 'name'), timeline: on === frame ? undefined : doc.get(on, 'name'), keyframes: props };
  });
  return JSON.stringify({ name: doc.get(frame, 'name'), duration: motion?.duration ?? 0, loop: motion?.loop ?? false, layers }, null, 2);
}
