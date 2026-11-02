// Branches (FR-BR-004): a three-way merge of two states of one file that
// share an ancestor — the main file and its branch, with the main file as it
// was when the branch was made (or last took its changes). Node ids are the
// same on every side, so the merge goes node by node and property by
// property: what only one side changed is taken from it; the same property
// changed differently on both sides is a conflict the person decides. The
// place in the tree (parent and order) counts as one property; a layer
// deleted on one side and changed (or with something changed inside it) on
// the other is a conflict about whether it stays.
//
// The result is a snapshot. It is put into a live document by restoreVersion,
// as ordinary operations, so everyone in the file sees the merge and Mod+Z
// takes it back. Undoing a merge is the same merge the other way round:
// base — the file right after the merge, incoming — right before it.

import type { NodeId } from './ids.ts';
import { defaultProp, isPropKey, valueEquals, type PropKey, type TextRun } from './schema.ts';
import type { Snapshot, SnapshotNode } from './serialize.ts';

/** Which side a conflict is decided for: the document the merge goes into, or the one it comes from. */
export type MergeSide = 'ours' | 'theirs';
/** A decision: a side, or (for text) the text written by hand. */
export type MergeChoice = MergeSide | { text: string };

export interface MergeConflict {
  /** Stable key for the decision: `<id>|<prop>`, `<id>|@place` or `<id>|@exists`. */
  key: string;
  id: NodeId;
  kind: 'prop' | 'place' | 'exists';
  prop?: PropKey;
  /** The layer's name and where it is (page / frame / …), from whichever side has it. */
  name: string;
  path: string[];
  /** The values on each side; for 'exists' — whether the layer is there; for 'place' — the parent's name. */
  ours: unknown;
  theirs: unknown;
}

export interface MergeResult {
  /** The merged file; null when it would be broken (`error` says why). */
  snapshot: Snapshot | null;
  conflicts: MergeConflict[];
  /** Layers the incoming side changes in the result (added, changed, moved, removed). */
  incoming: NodeId[];
  error?: string;
}

type Nodes = Map<NodeId, SnapshotNode>;

function byId(s: Snapshot): Nodes {
  return new Map(s.nodes.map((n) => [n.id, n]));
}

function propValue(n: SnapshotNode, key: string): unknown {
  const v = (n.props as Record<string, unknown>)[key];
  if (v !== undefined) return v;
  return isPropKey(key) ? defaultProp(n.type, key) : undefined;
}

function propKeys(...nodes: (SnapshotNode | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const n of nodes) if (n) for (const k of Object.keys(n.props)) if (k !== 'deleted') keys.add(k);
  return [...keys];
}

function samePlace(a: SnapshotNode, b: SnapshotNode): boolean {
  return a.parent === b.parent && a.index === b.index;
}

/** Whether a node differs from its ancestor version (anything: a property or its place). */
function changed(base: SnapshotNode, now: SnapshotNode): boolean {
  if (!samePlace(base, now)) return true;
  for (const k of propKeys(base, now)) if (!valueEquals(propValue(base, k), propValue(now, k))) return true;
  return false;
}

/** Nodes of one side that changed since the base, and every ancestor of theirs on that side ("something inside changed"). */
function touched(base: Nodes, side: Nodes): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const [id, n] of side) {
    const b = base.get(id);
    if (b && !changed(b, n)) continue;
    for (let at: NodeId | null = id; at && !out.has(at); at = side.get(at)?.parent ?? null) out.add(at);
  }
  return out;
}

/** The topmost layer of a deleted subtree that `id` belongs to (deleted on that side, ancestors taken from the base). */
function deletionRoot(base: Nodes, side: Nodes, id: NodeId): NodeId {
  let root = id;
  for (let at = base.get(id)?.parent ?? null; at && base.has(at) && !side.has(at); at = base.get(at)?.parent ?? null) root = at;
  return root;
}

function nameOf(...nodes: (SnapshotNode | undefined)[]): string {
  for (const n of nodes) {
    const name = n ? propValue(n, 'name') : undefined;
    if (typeof name === 'string' && name) return name;
  }
  return '';
}

function pathOf(id: NodeId, sides: Nodes[], root: NodeId): string[] {
  const out: string[] = [];
  const seen = new Set<NodeId>();
  let at: NodeId | null = sides.map((s) => s.get(id)?.parent).find((p) => p) ?? null;
  while (at && at !== root && !seen.has(at)) {
    seen.add(at);
    const n = sides.map((s) => s.get(at!)).find(Boolean);
    if (!n) break;
    out.unshift(nameOf(n));
    at = n.parent;
  }
  return out;
}

/** Text runs that still fit a text written by hand. */
function fitRuns(runs: unknown, length: number): TextRun[] {
  if (!Array.isArray(runs)) return [];
  return (runs as TextRun[]).filter((r) => r.start < length).map((r) => ({ ...r, end: Math.min(r.end, length) }));
}

/**
 * Merges `theirs` into `ours`, both descended from `base`. `choices` decide
 * conflicts by key; an undecided conflict keeps `ours` (the preview shows the
 * file as it would be with the decisions taken so far).
 */
export function mergeSnapshots(base: Snapshot, ours: Snapshot, theirs: Snapshot, choices: ReadonlyMap<string, MergeChoice> = new Map()): MergeResult {
  const B = byId(base);
  const O = byId(ours);
  const T = byId(theirs);
  const rootNode = ours.nodes.find((n) => n.parent === null);
  if (!rootNode) return { snapshot: null, conflicts: [], incoming: [], error: 'no-root' };
  const root = rootNode.id;
  const touchedO = touched(B, O);
  const touchedT = touched(B, T);
  const conflicts: MergeConflict[] = [];
  const incoming = new Set<NodeId>();
  const sides = [O, T, B];
  const pick = (key: string): MergeChoice => choices.get(key) ?? 'ours';

  // Deletions, decided once per deleted subtree (at its topmost layer).
  const keepDeleted = new Map<NodeId, boolean>();
  const deletion = (id: NodeId, deletedOn: Nodes, other: Nodes, otherTouched: Set<NodeId>, deletedIsOurs: boolean): boolean => {
    let top = deletionRoot(B, deletedOn, id);
    // The deleted parent is gone on the other side too, but this layer was moved out of it there: decide for the layer itself.
    if (!other.has(top)) top = id;
    let keep = keepDeleted.get(top);
    if (keep === undefined) {
      // Unchanged on the other side (itself and everything in it): the deletion stands.
      const contested = other.has(top) && otherTouched.has(top);
      if (!contested) keep = false;
      else {
        const key = `${top}|@exists`;
        conflicts.push({ key, id: top, kind: 'exists', name: nameOf(B.get(top), other.get(top)), path: pathOf(top, sides, root), ours: !deletedIsOurs, theirs: deletedIsOurs });
        const side = pick(key);
        // Keep the layer when the decision is for the side where it is still there.
        keep = deletedIsOurs ? side === 'theirs' : side === 'ours';
      }
      keepDeleted.set(top, keep);
    }
    return keep;
  };

  const result: Nodes = new Map();
  const ids = new Set<NodeId>([...B.keys(), ...O.keys(), ...T.keys()]);
  ids.delete(root);
  for (const id of ids) {
    const b = B.get(id);
    const o = O.get(id);
    const t = T.get(id);
    if (!b) {
      // Made on one side after the common ancestor.
      if (o) result.set(id, structuredClone(o));
      else if (t) {
        result.set(id, structuredClone(t));
        incoming.add(id);
      }
      continue;
    }
    if (!o && !t) continue;
    if (!o) {
      if (deletion(id, O, T, touchedT, true)) {
        result.set(id, structuredClone(t!));
        incoming.add(id);
      }
      continue;
    }
    if (!t) {
      if (deletion(id, T, O, touchedO, false)) result.set(id, structuredClone(o));
      else incoming.add(id);
      continue;
    }
    // On both sides: property by property, and the place.
    const merged: SnapshotNode = structuredClone(o);
    const props = merged.props as Record<string, unknown>;
    let fromTheirs = false;
    let custom: string | null = null;
    for (const key of propKeys(b, o, t)) {
      const bv = propValue(b, key);
      const ov = propValue(o, key);
      const tv = propValue(t, key);
      if (valueEquals(ov, tv) || valueEquals(tv, bv)) continue;
      if (valueEquals(ov, bv)) {
        props[key] = structuredClone(tv);
        fromTheirs = true;
        continue;
      }
      const ck = `${id}|${key}`;
      conflicts.push({ key: ck, id, kind: 'prop', prop: key as PropKey, name: nameOf(o, t), path: pathOf(id, sides, root), ours: ov, theirs: tv });
      const choice = pick(ck);
      if (choice === 'theirs') {
        props[key] = structuredClone(tv);
        fromTheirs = true;
      } else if (typeof choice === 'object' && key === 'characters') {
        props[key] = choice.text;
        custom = choice.text;
        fromTheirs = true;
      }
    }
    if (custom !== null) props.textRuns = fitRuns(props.textRuns, custom.length);
    if (!samePlace(o, t) && !samePlace(t, b)) {
      if (samePlace(o, b)) {
        merged.parent = t.parent;
        merged.index = t.index;
        fromTheirs = true;
      } else {
        const ck = `${id}|@place`;
        const parentName = (n: SnapshotNode) => nameOf(...sides.map((s) => s.get(n.parent ?? '')));
        conflicts.push({ key: ck, id, kind: 'place', name: nameOf(o, t), path: pathOf(id, sides, root), ours: parentName(o), theirs: parentName(t) });
        if (pick(ck) === 'theirs') {
          merged.parent = t.parent;
          merged.index = t.index;
          fromTheirs = true;
        }
      }
    }
    result.set(id, merged);
    if (fromTheirs) incoming.add(id);
  }

  // A layer whose parent did not survive the merge (added into something deleted) goes with it.
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const [id, n] of result) {
      if (n.parent === root || (n.parent && result.has(n.parent))) continue;
      result.delete(id);
      dropped = true;
    }
  }

  // Parents before children; a layer that cannot be reached from the root is inside a loop.
  const children = new Map<NodeId, SnapshotNode[]>();
  for (const n of result.values()) {
    const list = children.get(n.parent!) ?? [];
    list.push(n);
    children.set(n.parent!, list);
  }
  const ordered: SnapshotNode[] = [structuredClone(rootNode)];
  const stack = [root];
  while (stack.length) {
    const at = stack.pop()!;
    for (const child of children.get(at) ?? []) {
      ordered.push(child);
      stack.push(child.id);
    }
  }
  if (ordered.length !== result.size + 1) {
    const lost = [...result.values()].find((n) => !ordered.includes(n));
    return { snapshot: null, conflicts, incoming: [...incoming], error: `cycle:${lost ? nameOf(lost) || lost.id : ''}` };
  }
  const blobs = { ...(theirs.blobs ?? {}), ...(ours.blobs ?? {}) };
  const snapshot: Snapshot = { format: ours.format, schemaVersion: Math.max(ours.schemaVersion, theirs.schemaVersion), savedAt: new Date().toISOString(), nodes: ordered };
  if (Object.keys(blobs).length) snapshot.blobs = blobs;
  return { snapshot, conflicts, incoming: [...incoming], error: undefined };
}

/** How many layers one side changed since the base (added, changed, moved, deleted) — "the main file changed (N)". */
export function countChanges(base: Snapshot, now: Snapshot): number {
  const B = byId(base);
  const N = byId(now);
  let n = 0;
  for (const [id, node] of N) {
    // The document itself (its name differs in a branch) is not a layer.
    if (node.parent === null) continue;
    const b = B.get(id);
    if (!b || changed(b, node)) n++;
  }
  for (const id of B.keys()) if (!N.has(id)) n++;
  return n;
}
