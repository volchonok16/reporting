// Connects the layout engine to the document: after a change, the affected
// auto layout trees are recomputed and the resulting geometry is written back
// in the same transaction, so collaborators, exports and undo all see it.

import { isFrameLike, isGroupLike, type Document, type NodeId, type Transaction } from '#core';
import { warpOutline, type Point } from '#geometry';
import { LayoutEngine } from './engine.ts';
import { nodePaths } from './node-paths.ts';
import type { TextMeasurer } from './text-measure.ts';

const EPS = 0.001;

/**
 * The node from which layout must be recomputed when `id` changes:
 * the top-most ancestor in an unbroken chain of auto layout frames.
 */
export function layoutRootFor(doc: Document, id: NodeId): NodeId | null {
  if (!doc.store.has(id)) return null;
  const type = doc.type(id);
  const isAuto = (n: NodeId) => isFrameLike(doc.type(n)) && doc.get(n, 'layoutMode') !== 'NONE';
  let root: NodeId | null = isAuto(id) || type === 'TEXT' ? id : null;
  let current = id;
  for (;;) {
    const parent = doc.parent(current);
    if (parent === null || !isAuto(parent)) break;
    root = parent;
    current = parent;
  }
  return root;
}

/** Recomputes layout for everything affected by `changed` and writes the results through `tx`. */
export function applyLayout(doc: Document, tx: Transaction, changed: Iterable<NodeId>, measurer: TextMeasurer): void {
  const roots = new Set<NodeId>();
  for (const id of changed) {
    if (!doc.store.isAlive(id)) {
      // A removed child still affects its former auto layout parent.
      const parent = doc.store.record(id)?.parent;
      if (parent && doc.store.isAlive(parent)) {
        const root = layoutRootFor(doc, parent);
        if (root) roots.add(root);
      }
      continue;
    }
    const root = layoutRootFor(doc, id);
    if (root) roots.add(root);
    const parent = doc.parent(id);
    if (parent) {
      const parentRoot = layoutRootFor(doc, parent);
      if (parentRoot && isFrameLike(doc.type(parent)) && doc.get(parent, 'layoutMode') !== 'NONE') roots.add(parentRoot);
    }
  }
  // Every root is the top of its own chain of auto layout frames, so no outer pass reaches it: an auto
  // layout frame inside a plain frame inside another auto layout frame is laid out by itself (BUG-090).
  for (const root of roots) {
    const engine = new LayoutEngine(doc, measurer);
    for (const [id, box] of engine.layoutRoot(root)) {
      if (Math.abs(doc.get(id, 'x') - box.x) > EPS) tx.set(id, 'x', round(box.x));
      if (Math.abs(doc.get(id, 'y') - box.y) > EPS) tx.set(id, 'y', round(box.y));
      if (Math.abs(doc.get(id, 'width') - box.width) > EPS) tx.set(id, 'width', round(box.width));
      if (Math.abs(doc.get(id, 'height') - box.height) > EPS) tx.set(id, 'height', round(box.height));
    }
  }
}

/**
 * A frame cannot hug a layer that fills it along its flow (as in Figma): a
 * layer set to fill makes its row wider or its column taller by itself, so the
 * row or column becomes fixed on that axis, and a frame set to hug makes its
 * filling layers fixed. Across the flow filling a hugging frame is fine: the
 * layer stretches to the tallest neighbour (a divider in a row).
 * Sizes stay as they are on screen.
 */
export function settleSizing(doc: Document, tx: Transaction): void {
  const MAIN = { HORIZONTAL: 'sizingH', VERTICAL: 'sizingV' } as const;
  const flex = (id: NodeId, key: 'sizingH' | 'sizingV') => {
    const mode = isFrameLike(doc.type(id)) ? doc.get(id, 'layoutMode') : 'NONE';
    return (mode === 'HORIZONTAL' || mode === 'VERTICAL') && MAIN[mode] === key;
  };
  const fills = (id: NodeId, key: 'sizingH' | 'sizingV') => {
    const mode = doc.get(id, key).mode;
    return (mode === 'FILL' || mode === 'FR') && doc.get(id, 'positioning') === 'AUTO';
  };
  for (const [id, keys] of [...tx.changes.updated]) {
    if (!doc.store.isAlive(id)) continue;
    for (const key of ['sizingH', 'sizingV'] as const) {
      if (!keys.has(key)) continue;
      const parent = doc.parent(id);
      if (fills(id, key) && parent && flex(parent, key) && doc.get(parent, key).mode === 'HUG') tx.set(parent, key, { mode: 'FIXED' });
      if (doc.get(id, key).mode === 'HUG' && flex(id, key)) {
        for (const child of doc.children(id)) if (fills(child, key)) tx.set(child, key, { mode: 'FIXED' });
      }
    }
  }
}

/**
 * Groups have no size of their own (FR-LYR-013): their box is the union of their
 * children. After children change, the group's origin moves to the union's
 * top-left corner and the children are shifted back so nothing moves on screen.
 * Rotated children count by their turned corners, warped ones by where their picture is.
 */
export function fitGroups(doc: Document, tx: Transaction, changed: Iterable<NodeId>): void {
  const groups = new Set<NodeId>();
  for (const id of changed) {
    const parent = doc.store.record(id)?.parent;
    if (parent && doc.store.isAlive(parent) && isGroupLike(doc.type(parent))) groups.add(parent);
    if (doc.store.isAlive(id) && isGroupLike(doc.type(id))) groups.add(id);
  }
  // Innermost groups first so outer groups see final child boxes.
  const ordered = [...groups].sort((a, b) => doc.store.ancestors(b).length - doc.store.ancestors(a).length);
  for (const group of ordered) {
    const children = doc.children(group);
    if (children.length === 0) {
      tx.delete(group);
      continue;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // A boolean operation is as large as its result, not its shapes (as in Figma): what is subtracted adds nothing.
    if (doc.type(group) === 'BOOLEAN_OPERATION') {
      for (const path of nodePaths(doc, group)) {
        for (const p of path.points) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (minX === Infinity) {
      for (const c of children) {
        for (const p of childOutline(doc, c)) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
      }
    }
    if (Math.abs(minX) > EPS || Math.abs(minY) > EPS) {
      for (const c of children) tx.update(c, { x: round(doc.get(c, 'x') - minX), y: round(doc.get(c, 'y') - minY) });
      tx.update(group, { x: round(doc.get(group, 'x') + minX), y: round(doc.get(group, 'y') + minY) });
    }
    tx.update(group, { width: round(maxX - minX), height: round(maxY - minY) });
    const parent = doc.parent(group);
    if (parent && isGroupLike(doc.type(parent))) groups.add(parent);
  }
}

/** A child's box in its parent's space: the corners turned with it, or the outline of its warped picture. */
function childOutline(doc: Document, id: NodeId): Point[] {
  const x = doc.get(id, 'x');
  const y = doc.get(id, 'y');
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const warp = doc.get(id, 'warp');
  const local = warp && w > 0 && h > 0 ? warpOutline(warp).map((q) => ({ x: q.x * w, y: q.y * h })) : [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const angle = (doc.get(id, 'rotation') * Math.PI) / 180;
  if (angle === 0) return local.map((p) => ({ x: x + p.x, y: y + p.y }));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return local.map((p) => ({ x: x + p.x * cos - p.y * sin, y: y + p.x * sin + p.y * cos }));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
