// Shape builder (as in Figma): the selected shapes cut one another into areas;
// a click takes an area out into its own layer, a drag across several merges
// them into one, Alt+click removes an area. It changes the layers for good
// (undo brings them back), like Figma's.

import { type Document, type NodeId, type Transaction, type VectorPath } from '#core';
import { area, booleanRegions, insideRegion, nodeTransform, transformPaths, type Point, type Region } from '#geometry';
import { nodePaths, regionOf } from '#layout';

/** One area: the part of the plane covered by exactly these layers (bottom to top), all in one piece. */
export interface BuilderCell {
  region: Region;
  owners: NodeId[];
}

const EMPTY: Region = { contours: [], rule: 'NONZERO' };

/** Areas smaller than this (square px) are slivers of rounding along shared edges, not areas. */
const SLIVER = 0.5;

/** A layer's filled area in its parent's coordinates. */
export function layerRegion(doc: Document, id: NodeId): Region {
  const paths = transformPaths(nodePaths(doc, id), nodeTransform(doc.get(id, 'x'), doc.get(id, 'y'), doc.get(id, 'rotation')));
  const closed = paths.filter((p) => p.closed);
  const rule = doc.type(id) === 'VECTOR' ? doc.get(id, 'windingRule') : 'NONZERO';
  // Normalised: contours oriented, overlaps resolved.
  return clean(booleanRegions('UNION', regionOf(closed, rule), EMPTY));
}

const sizeOf = (r: Region) => Math.abs(r.contours.reduce((s, c) => s + area(c), 0));

/** The sign of the area of an outer contour in a boolean result (holes have the other one). */
const OUTER_SIGN = Math.sign(area(booleanRegions('UNION', { contours: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]], rule: 'NONZERO' }, EMPTY).contours[0]!));

/**
 * A region in its pieces: each outer contour with the holes right inside it.
 * A contour inside an even number of others is an outer one, an odd — a hole.
 * Booleans of shapes that only touch along a shared edge can leave a contour
 * running the wrong way round (an outer as a hole, or the other way): such
 * leftovers are dropped.
 */
export function pieces(r: Region): Region[] {
  const all = r.contours.filter((c) => c.length >= 3);
  const within = (c: readonly Point[], o: Point[]) => insideRegion({ contours: [o], rule: 'NONZERO' }, c[0]!);
  const around = all.map((c) => all.filter((o) => o !== c && within(c, o)));
  const outer = (i: number) => around[i]!.length % 2 === 0;
  const right = (i: number) => Math.sign(area(all[i]!)) === (outer(i) ? OUTER_SIGN : -OUTER_SIGN);
  const result: Region[] = [];
  all.forEach((c, i) => {
    if (!outer(i) || !right(i)) return;
    const depth = around[i]!.length;
    const holes = all.filter((_, j) => around[j]!.length === depth + 1 && around[j]!.includes(c) && right(j));
    result.push({ contours: [c, ...holes], rule: 'NONZERO' });
  });
  return result.filter((p) => sizeOf(p) > SLIVER);
}

/** A boolean result without the leftovers `pieces` drops. */
function clean(r: Region): Region {
  return { contours: pieces(r).flatMap((p) => p.contours), rule: 'NONZERO' };
}

/** The areas the layers (in paint order, bottom first) cut one another into. */
export function builderCells(doc: Document, ids: readonly NodeId[]): BuilderCell[] {
  let cells: BuilderCell[] = [];
  let covered: Region = EMPTY;
  for (const id of ids) {
    const r = layerRegion(doc, id);
    if (sizeOf(r) <= SLIVER) continue;
    const next: BuilderCell[] = [];
    for (const c of cells) {
      const both = clean(booleanRegions('INTERSECT', c.region, r));
      const only = clean(booleanRegions('SUBTRACT', c.region, r));
      if (sizeOf(both) > SLIVER) next.push({ region: both, owners: [...c.owners, id] });
      if (sizeOf(only) > SLIVER) next.push({ region: only, owners: c.owners });
    }
    const fresh = clean(booleanRegions('SUBTRACT', r, covered));
    if (sizeOf(fresh) > SLIVER) next.push({ region: fresh, owners: [id] });
    covered = clean(booleanRegions('UNION', covered, r));
    cells = next;
  }
  return cells.flatMap((c) => pieces(c.region).map((region) => ({ region, owners: c.owners })));
}

/** The area under a point (parent coordinates); -1 — none. */
export function cellAt(cells: readonly BuilderCell[], p: Point): number {
  for (let i = cells.length - 1; i >= 0; i--) if (insideRegion(cells[i]!.region, p)) return i;
  return -1;
}

export function regionPaths(r: Region): VectorPath[] {
  return r.contours.map((c) => ({ closed: true, points: c.map((q) => ({ x: q.x, y: q.y })) }));
}

/**
 * Applies the builder to the chosen areas: each layer under them loses them
 * (a layer left empty goes); unless `remove`, they become one new layer above
 * the top one of them, styled as that layer. `make` creates a vector from a
 * layer's look and paths (and normalises it).
 *
 * The areas are not cut again from the changed layers: a stored vector is
 * rounded, and edges two layers share would no longer meet exactly. A layer's
 * new shape is the union of its remaining areas (their shared edges are the
 * same points), and the areas carry on with new owners.
 */
export function applyBuilder(
  doc: Document,
  tx: Transaction,
  ids: readonly NodeId[],
  cells: readonly BuilderCell[],
  chosen: readonly number[],
  remove: boolean,
  make: (tx: Transaction, like: NodeId, paths: VectorPath[], after: NodeId) => NodeId,
): { ids: NodeId[]; cells: BuilderCell[] } {
  const picked = new Set(chosen.filter((i) => cells[i]));
  if (picked.size === 0) return { ids: [...ids], cells: [...cells] };
  let taken: Region = EMPTY;
  for (const i of picked) taken = clean(booleanRegions('UNION', taken, cells[i]!.region));
  const touched = new Set([...picked].flatMap((i) => cells[i]!.owners));
  const rest = cells.filter((_, i) => !picked.has(i));
  // The new layer looks like the top layer of the chosen areas.
  const top = ids.filter((id) => touched.has(id)).at(-1)!;
  const renamed = new Map<NodeId, NodeId | null>();
  const result: NodeId[] = [];
  let made: NodeId | null = null;
  for (const id of ids) {
    if (!touched.has(id)) {
      result.push(id);
      continue;
    }
    let left: Region = EMPTY;
    for (const c of rest) if (c.owners.includes(id)) left = clean(booleanRegions('UNION', left, c.region));
    const keep = sizeOf(left) > SLIVER ? make(tx, id, regionPaths(left), id) : null;
    renamed.set(id, keep);
    if (keep) result.push(keep);
    if (id === top && !remove) {
      made = make(tx, id, regionPaths(taken), keep ?? id);
      result.push(made);
    }
    tx.delete(id);
  }
  const next: BuilderCell[] = rest.map((c) => ({ region: c.region, owners: c.owners.map((o) => (renamed.has(o) ? renamed.get(o)! : o)).filter((o): o is NodeId => o !== null) }));
  if (made) next.push({ region: taken, owners: [made] });
  return { ids: result, cells: next.filter((c) => c.owners.length > 0) };
}
