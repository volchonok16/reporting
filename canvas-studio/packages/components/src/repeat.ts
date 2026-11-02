// Repeat groups (Figma Draw's repeat transforms): a group keeps its own layers
// and copies of them, in a row or round a circle. The copies are ordinary
// layers marked `repeatCopy`, brought up to date after every edit inside the group
// (updated in place, so they keep their ids and only what changed is drawn again), so the
// canvas, the exports and the hit test need nothing of their own; editing the
// group's own layers changes every copy (non-destructive, as in Figma).

import type { Document, NodeId, Transaction } from '#core';
import { multiply, nodeTransform, type Matrix } from '#geometry';

/** The repeat group a layer belongs to (itself, or the nearest such group above it). */
export function repeatGroupOf(doc: Document, id: NodeId): NodeId | null {
  for (const a of [id, ...doc.store.ancestors(id)]) if (doc.store.isAlive(a) && doc.type(a) === 'GROUP' && doc.get(a, 'repeat')) return a;
  return null;
}

/** Whether a layer is (inside) a copy made by a repeat group. */
export function isRepeatCopy(doc: Document, id: NodeId): boolean {
  return [id, ...doc.store.ancestors(id)].some((a) => doc.store.isAlive(a) && doc.get(a, 'repeatCopy'));
}

function clone(doc: Document, tx: Transaction, id: NodeId, parent: NodeId, props: Record<string, unknown>): NodeId {
  const record = doc.store.record(id)!;
  const own = structuredClone(record.props) as Record<string, unknown>;
  delete own.deleted;
  const copy = tx.create(record.type, parent, { ...own, ...props } as never);
  for (const child of doc.children(id)) clone(doc, tx, child, copy, {});
  return copy;
}

/** Rebuilds the copies of every repeat group the edit touched; copies left outside a repeat group become plain layers. */
export function syncRepeats(doc: Document, tx: Transaction, touched: Iterable<NodeId>): void {
  const groups = new Set<NodeId>();
  for (const id of touched) {
    if (!doc.store.isAlive(id)) {
      const parent = doc.store.record(id)?.parent;
      const g = parent && doc.store.isAlive(parent) ? repeatGroupOf(doc, parent) : null;
      if (g) groups.add(g);
      continue;
    }
    // A copy taken out of its group (ungrouped, dragged away) is an ordinary layer now.
    if (doc.get(id, 'repeatCopy') && !(doc.parent(id) && doc.get(doc.parent(id)!, 'repeat'))) tx.set(id, 'repeatCopy', false);
    if (isRepeatCopy(doc, id) && !doc.get(id, 'repeatCopy')) continue;
    const g = repeatGroupOf(doc, id);
    // The group itself moved, turned or faded: its copies stay as they are (rebuilt only when its settings change).
    if (g === id && !tx.changes.created.has(id) && !tx.changes.updated.get(id)?.has('repeat')) continue;
    if (g) groups.add(g);
  }
  for (const g of groups) rebuild(doc, tx, g);
}

/** Where a copy stands; it is otherwise the same as its layer. */
const PLACE_KEYS = new Set(['x', 'y', 'rotation', 'repeatCopy', 'deleted']);

/**
 * Makes `copy` the same as `source` (and its layers the same as source's), placed by `props`.
 * Updated in place — the copy keeps its id, so only what changed is drawn again; false — the
 * layers inside differ in number or kind, the copy has to be made anew.
 */
function update(doc: Document, tx: Transaction, copy: NodeId, source: NodeId, props: Record<string, unknown>): boolean {
  if (doc.type(copy) !== doc.type(source)) return false;
  const from = doc.children(source);
  const to = doc.children(copy);
  if (from.length !== to.length || from.some((c, i) => doc.type(c) !== doc.type(to[i]!))) return false;
  const keys = new Set([...Object.keys(doc.store.record(source)!.props), ...Object.keys(doc.store.record(copy)!.props)]);
  const patch: Record<string, unknown> = {};
  for (const key of keys) if (!PLACE_KEYS.has(key)) patch[key] = structuredClone(doc.get(source, key as never));
  tx.update(copy, { ...patch, ...props } as never);
  return from.every((c, i) => update(doc, tx, to[i]!, c, { x: doc.get(c, 'x'), y: doc.get(c, 'y'), rotation: doc.get(c, 'rotation') }));
}

function rebuild(doc: Document, tx: Transaction, group: NodeId): void {
  const settings = doc.get(group, 'repeat');
  const kids = doc.children(group);
  // The copies there are, in the order they were made: kept and updated where they still fit.
  const old = kids.filter((c) => doc.get(c, 'repeatCopy'));
  const own = kids.filter((c) => !doc.get(c, 'repeatCopy') && doc.store.isAlive(c));
  if (!settings || own.length === 0) {
    for (const c of old) tx.delete(c);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of own) {
    minX = Math.min(minX, doc.get(c, 'x'));
    minY = Math.min(minY, doc.get(c, 'y'));
    maxX = Math.max(maxX, doc.get(c, 'x') + doc.get(c, 'width'));
    maxY = Math.max(maxY, doc.get(c, 'y') + doc.get(c, 'height'));
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const count = Math.max(1, Math.min(200, Math.round(settings.count)));
  for (let k = 1; k < count; k++) {
    let place: (c: NodeId) => { x: number; y: number; rotation: number };
    if (settings.kind === 'LINEAR') {
      const dx = settings.direction === 'HORIZONTAL' ? k * (w + settings.gap) : 0;
      const dy = settings.direction === 'VERTICAL' ? k * (h + settings.gap) : 0;
      place = (c) => ({ x: doc.get(c, 'x') + dx, y: doc.get(c, 'y') + dy, rotation: doc.get(c, 'rotation') });
    } else {
      // Round the centre below the layers, turned evenly.
      const cx = minX + w / 2;
      const cy = minY + h / 2 + settings.radius;
      const turn = (360 / count) * k;
      const about: Matrix = multiply(multiply(nodeTransform(cx, cy, 0), nodeTransform(0, 0, turn)), nodeTransform(-cx, -cy, 0));
      place = (c) => {
        const m = multiply(about, nodeTransform(doc.get(c, 'x'), doc.get(c, 'y'), doc.get(c, 'rotation')));
        return { x: Math.round(m.e * 100) / 100, y: Math.round(m.f * 100) / 100, rotation: doc.get(c, 'rotation') + turn };
      };
    }
    own.forEach((c, i) => {
      const props = { ...place(c), repeatCopy: true };
      const existing = old[(k - 1) * own.length + i];
      if (existing && update(doc, tx, existing, c, props)) return;
      if (existing) tx.delete(existing);
      clone(doc, tx, c, group, props);
    });
  }
  // Fewer copies than before: the rest go.
  for (const c of old.slice((count - 1) * own.length)) tx.delete(c);
}
