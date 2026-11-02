// Smart animate (FR-PRT-020): layers of the two screens are matched by their
// name path inside the screen ("Card/Title"; repeated names are told apart by
// their order), and matched layers morph from the old state to the new one —
// position, size, rotation, opacity, corner radius, stroke weight and a solid
// fill colour. New layers fade in, layers that disappear fade out.
//
// The viewer plays it on its private copy of the document: every frame writes
// interpolated values into the destination screen and renders it with the
// normal renderer, then the exact final values are restored.

import type { Color, Document, NodeId, Paint } from '#core';

const NUMERIC = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'cornerRadius', 'strokeWeight'] as const;
type NumericKey = (typeof NUMERIC)[number];
type Values = Record<NumericKey, number> & { fill: { color: Color; opacity: number } | null };

export interface SmartPlan {
  from: NodeId;
  to: NodeId;
  /** Destination layer → its matched source layer, with both states. */
  matched: { id: NodeId; source: NodeId; a: Values; b: Values }[];
  /** New layers (outermost only) and their final opacity. */
  fadeIn: { id: NodeId; opacity: number }[];
  /** Layers of the old screen that have no match (outermost only). */
  fadeOut: NodeId[];
  /** The screens' own fill. */
  screenFill: { a: Values['fill']; b: Values['fill'] };
}

/** Name-path keys of every layer inside a screen (the screen itself excluded). */
export function layerKeys(doc: Document, screen: NodeId): Map<string, NodeId> {
  const keys = new Map<string, NodeId>();
  const walk = (parent: NodeId, prefix: string) => {
    const seen = new Map<string, number>();
    for (const id of doc.children(parent)) {
      const name = doc.get(id, 'name');
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      const key = `${prefix}/${name}${n > 0 ? `#${n}` : ''}`;
      keys.set(key, id);
      walk(id, key);
    }
  };
  walk(screen, '');
  return keys;
}

function solidFill(paints: readonly Paint[]): Values['fill'] {
  const visible = paints.filter((p) => p.visible);
  if (visible.length !== 1) return null;
  const p = visible[0]!;
  return p.type === 'SOLID' ? { color: p.color, opacity: p.opacity } : null;
}

function values(doc: Document, id: NodeId): Values {
  const out = { fill: solidFill(doc.get(id, 'fills')) } as Values;
  for (const k of NUMERIC) out[k] = doc.get(id, k);
  return out;
}

export function planSmartAnimate(doc: Document, from: NodeId, to: NodeId): SmartPlan {
  const fromKeys = layerKeys(doc, from);
  const toKeys = layerKeys(doc, to);
  const sourceOf = new Map<NodeId, NodeId>();
  for (const [key, id] of toKeys) {
    const source = fromKeys.get(key);
    if (source !== undefined && doc.type(source) === doc.type(id)) sourceOf.set(id, source);
  }
  const matchedSources = new Set(sourceOf.values());
  const plan: SmartPlan = { from, to, matched: [], fadeIn: [], fadeOut: [], screenFill: { a: solidFill(doc.get(from, 'fills')), b: solidFill(doc.get(to, 'fills')) } };
  // Only the outermost unmatched layer fades: its children go with it.
  const outermost = (id: NodeId, screen: NodeId, isMatched: (x: NodeId) => boolean) => {
    const parent = doc.parent(id)!;
    return parent === screen || isMatched(parent);
  };
  for (const id of toKeys.values()) {
    const source = sourceOf.get(id);
    if (source !== undefined) plan.matched.push({ id, source, a: values(doc, source), b: values(doc, id) });
    else if (outermost(id, to, (x) => sourceOf.has(x))) plan.fadeIn.push({ id, opacity: doc.get(id, 'opacity') });
  }
  for (const id of fromKeys.values()) {
    if (!matchedSources.has(id) && outermost(id, from, (x) => matchedSources.has(x))) plan.fadeOut.push(id);
  }
  return plan;
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function lerpAngle(a: number, b: number, p: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (Math.abs(d) < 1e-9) d = 0;
  return a + d * p;
}

function lerpFill(a: Values['fill'], b: Values['fill'], p: number): Values['fill'] {
  if (!a || !b) return null;
  // Springs overshoot: colours and opacity stay within their range.
  const q = Math.max(0, Math.min(1, p));
  const c = (x: number, y: number) => Math.max(0, Math.min(1, lerp(x, y, q)));
  return { color: { r: c(a.color.r, b.color.r), g: c(a.color.g, b.color.g), b: c(a.color.b, b.color.b), a: c(a.color.a, b.color.a) }, opacity: c(a.opacity, b.opacity) };
}

function withFill(doc: Document, id: NodeId, fill: NonNullable<Values['fill']>): Paint[] {
  return doc.get(id, 'fills').map((paint) => (paint.visible && paint.type === 'SOLID' ? { ...paint, color: fill.color, opacity: fill.opacity } : paint));
}

/**
 * Writes the state at progress p (0 → 1, may overshoot with springs) into the
 * destination screen. p = 1 restores the exact destination values.
 */
export function applySmartAnimate(doc: Document, plan: SmartPlan, p: number): void {
  const end = p >= 1;
  doc.transact(
    (tx) => {
      for (const m of plan.matched) {
        if (!doc.store.isAlive(m.id)) continue;
        const props: Record<string, unknown> = {};
        for (const k of NUMERIC) {
          const v = end ? m.b[k] : k === 'rotation' ? lerpAngle(m.a[k], m.b[k], p) : lerp(m.a[k], m.b[k], p);
          // Sizes and opacity cannot go negative even when a spring overshoots.
          props[k] = k === 'width' || k === 'height' || k === 'cornerRadius' || k === 'strokeWeight' ? Math.max(0, v) : k === 'opacity' ? Math.max(0, Math.min(1, v)) : v;
        }
        const fill = end ? m.b.fill : lerpFill(m.a.fill, m.b.fill, p);
        if (fill) props.fills = withFill(doc, m.id, fill);
        tx.update(m.id, props);
      }
      for (const f of plan.fadeIn) if (doc.store.isAlive(f.id)) tx.set(f.id, 'opacity', end ? f.opacity : f.opacity * Math.max(0, Math.min(1, p)));
      const screenFill = end ? plan.screenFill.b : lerpFill(plan.screenFill.a, plan.screenFill.b, p);
      if (screenFill) tx.set(plan.to, 'fills', withFill(doc, plan.to, screenFill));
    },
    { undoable: false },
  );
}

/** Values of a layer tree before a change ("Change to" with smart animate): key → type and values. */
export type SmartSnapshot = Map<string, { type: string; values: Values }>;

export function snapshotLayers(doc: Document, root: NodeId): SmartSnapshot {
  const snap: SmartSnapshot = new Map([['', { type: doc.type(root), values: values(doc, root) }]]);
  for (const [key, id] of layerKeys(doc, root)) snap.set(key, { type: doc.type(id), values: values(doc, id) });
  return snap;
}

/**
 * Plan from a snapshot of the same layer before a change: matched layers
 * (the root too — a variant may differ in size and colour) morph, new ones fade in.
 * Layers that are gone no longer exist to be drawn, so they simply disappear.
 */
export function planFromSnapshot(doc: Document, snap: SmartSnapshot, root: NodeId): SmartPlan {
  const plan: SmartPlan = { from: root, to: root, matched: [], fadeIn: [], fadeOut: [], screenFill: { a: null, b: null } };
  const rootBefore = snap.get('');
  const matched = new Set<NodeId>();
  if (rootBefore && rootBefore.type === doc.type(root)) {
    plan.matched.push({ id: root, source: root, a: rootBefore.values, b: values(doc, root) });
    matched.add(root);
  }
  for (const [key, id] of layerKeys(doc, root)) {
    const before = snap.get(key);
    if (before && before.type === doc.type(id)) {
      plan.matched.push({ id, source: id, a: before.values, b: values(doc, id) });
      matched.add(id);
    } else if (matched.has(doc.parent(id)!)) plan.fadeIn.push({ id, opacity: doc.get(id, 'opacity') });
  }
  return plan;
}
