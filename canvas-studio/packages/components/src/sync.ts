// Instance synchronisation and the override model (section 10.4 of the spec).
//
// An instance is materialised: every layer it shows is a real node in the
// document, so selection, layout, rendering, export and collaboration work on
// instances with no special cases. Each layer of an instance records
//   componentKey — the layer it mirrors (its "source"), and
//   overrides    — the properties the user changed locally.
// Synchronisation copies every non-overridden property from the source and
// keeps the layer tree identical to the source tree.
//
// Sources form chains. A top-level instance mirrors its main component. A
// layer inside it mirrors the matching layer of the component. An instance
// nested in a component (B inside C) is itself synced from B; an instance of C
// then mirrors C's copy of it — so overrides made inside C reach instances of C,
// and overrides made on an instance of C stay local (FR-CMP-032).
//
// Matching uses stable layer keys, never names first (FR-CMP-030/031): a
// variant created by duplicating another shares its layer keys, so swapping
// variants keeps every override whose layer still exists. Overrides of layers
// that disappear are parked on the instance and restored when a layer with the
// same key comes back. Names are only a fallback for components built
// independently.
//
// All writes go through the caller's transaction: they are undoable together
// with the user's edit and are broadcast to collaborators as ordinary ops.

import { type Document, type NodeId, type NodeProps, type NodeType, type PropKey, type Transaction, PROP_KEYS, cloneValue, valueEquals } from '#core';
import { constrainSpan } from '#layout';

/** Never copied from a source and never overridable. */
const LOCAL_KEYS: ReadonlySet<string> = new Set(['deleted', 'overrides', 'componentKey', 'parkedOverrides', 'componentProps', 'description', 'layerKey']);
const GEOMETRY_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height', 'rotation']);
/** Properties copied from the source (geometry is handled separately). */
const COPY_KEYS: readonly PropKey[] = PROP_KEYS.filter((k) => !LOCAL_KEYS.has(k) && !GEOMETRY_KEYS.has(k));

const MAX_ROUNDS = 32;
const MAX_DEPTH = 64;

export type Ctx = {
  doc: Document;
  tx: Transaction;
  /** Nodes written by synchronisation in the current round. */
  modified: Set<NodeId>;
  structural: boolean;
};

// ---------- queries ----------

export function alive(doc: Document, id: NodeId | null | undefined): id is NodeId {
  return !!id && doc.store.has(id) && doc.store.isAlive(id);
}

/** A layer of an instance (anything that mirrors a source layer). */
export function isInstanceLayer(doc: Document, id: NodeId): boolean {
  return doc.get(id, 'componentKey') !== null;
}

/** An instance that is not itself a layer of another instance. */
export function isTopLevelInstance(doc: Document, id: NodeId): boolean {
  return doc.type(id) === 'INSTANCE' && doc.get(id, 'componentKey') === null;
}

/** Nearest COMPONENT ancestor-or-self. */
export function owningComponent(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'COMPONENT') return current;
    current = doc.parent(current);
  }
  return null;
}

/** The component set a component belongs to, if any. */
export function componentSetOf(doc: Document, component: NodeId): NodeId | null {
  const parent = doc.parent(component);
  return parent !== null && doc.type(parent) === 'COMPONENT_SET' ? parent : null;
}

/** Top-most instance that contains `id` (the instance the user placed). */
export function outerInstance(doc: Document, id: NodeId): NodeId | null {
  let found: NodeId | null = null;
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'INSTANCE') found = current;
    if (doc.type(current) === 'PAGE') break;
    current = doc.parent(current);
  }
  return found;
}

/** Whether the node is an instance layer or inside an instance (its structure follows a component). */
export function insideInstance(doc: Document, id: NodeId): boolean {
  let current = doc.parent(id);
  while (current !== null) {
    if (doc.type(current) === 'INSTANCE') return true;
    if (doc.type(current) === 'PAGE') return false;
    current = doc.parent(current);
  }
  return false;
}

/** Key used to match a layer across variants: explicit layer key or the node id. */
export function keyOf(doc: Document, id: NodeId): string {
  return doc.get(id, 'layerKey') ?? id;
}

/**
 * The node a layer is synced from.
 * - plain layer: its componentKey;
 * - instance that follows its source (not swapped): the source instance;
 * - top-level or swapped instance: its main component.
 */
export function sourceOf(doc: Document, id: NodeId): NodeId | null {
  const key = doc.get(id, 'componentKey');
  if (doc.type(id) === 'INSTANCE') {
    const main = doc.get(id, 'mainComponent');
    if (alive(doc, key) && doc.type(key) === 'INSTANCE' && doc.get(key, 'mainComponent') === main) return key;
    return alive(doc, main) && doc.type(main) === 'COMPONENT' ? main : null;
  }
  return alive(doc, key) ? key : null;
}

/** Type a mirror of `source` must have. */
function mirrorType(type: NodeType): NodeType {
  return type === 'COMPONENT' ? 'INSTANCE' : type;
}

/** Components used by `component`, directly or through nested instances. */
export function componentDependencies(doc: Document, component: NodeId): Set<NodeId> {
  const out = new Set<NodeId>();
  const visit = (root: NodeId) => {
    doc.store.walk(root, (id) => {
      if (doc.type(id) !== 'INSTANCE') return;
      const main = doc.get(id, 'mainComponent');
      if (main && !out.has(main) && alive(doc, main)) {
        out.add(main);
        visit(main);
      }
    });
  };
  visit(component);
  return out;
}

/** Whether placing an instance of `component` inside `parent` would make a component contain itself. */
export function wouldCreateCycle(doc: Document, component: NodeId, parent: NodeId): boolean {
  const host = owningComponent(doc, parent);
  if (host === null) return false;
  return host === component || componentDependencies(doc, component).has(host);
}

// ---------- index ----------

/** source id → nodes synced from it. Rebuilt per transaction that touches components. */
export class SourceIndex {
  private readonly bySource = new Map<NodeId, NodeId[]>();

  constructor(doc: Document) {
    for (const record of doc.store.allRecords()) {
      if (record.props.deleted === true) continue;
      if (record.props.componentKey == null && record.type !== 'INSTANCE') continue;
      if (!doc.store.isAlive(record.id)) continue;
      const source = sourceOf(doc, record.id);
      if (!source) continue;
      let list = this.bySource.get(source);
      if (!list) {
        list = [];
        this.bySource.set(source, list);
      }
      list.push(record.id);
    }
  }

  dependents(source: NodeId): readonly NodeId[] {
    return this.bySource.get(source) ?? [];
  }
}

// ---------- overrides ----------

/** Whether a user change of `key` on `id` becomes an override. */
export function isOverridable(doc: Document, id: NodeId, key: string): boolean {
  if (LOCAL_KEYS.has(key) || key === 'propRefs') return false;
  if (isTopLevelInstance(doc, id)) {
    // The instance's own position and choices are not overrides; its size is (the user resized it).
    return !['x', 'y', 'rotation', 'mainComponent', 'propValues'].includes(key);
  }
  if (!isInstanceLayer(doc, id)) return false;
  return !GEOMETRY_KEYS.has(key);
}

/**
 * Marks properties the user changed on instance layers as overrides.
 * `changed` must be the user's own changes, captured before synchronisation runs.
 */
export function markOverrides(doc: Document, tx: Transaction, changed: ReadonlyMap<NodeId, ReadonlySet<PropKey>>): void {
  for (const [id, keys] of changed) {
    if (!alive(doc, id)) continue;
    if (!isInstanceLayer(doc, id) && doc.type(id) !== 'INSTANCE') continue;
    const current = doc.get(id, 'overrides');
    const next = new Set(current);
    for (const key of keys) if (isOverridable(doc, id, key)) next.add(key);
    if (next.size !== current.length) tx.set(id, 'overrides', [...next]);
  }
}

/** Clears overrides (all, or the given keys) of one layer; synchronisation restores source values. */
export function resetOverrides(doc: Document, tx: Transaction, id: NodeId, keys?: readonly string[]): void {
  const current = doc.get(id, 'overrides');
  const next = keys ? current.filter((k) => !keys.includes(k)) : [];
  if (next.length !== current.length) tx.set(id, 'overrides', next);
}

/** Clears every override inside an instance, including property values and parked overrides. */
export function resetInstance(doc: Document, tx: Transaction, instance: NodeId): void {
  resetOverrides(doc, tx, instance);
  if (isTopLevelInstance(doc, instance)) tx.set(instance, 'propValues', null);
  tx.set(instance, 'parkedOverrides', null);
  doc.store.walk(instance, (id) => {
    resetOverrides(doc, tx, id);
  });
}

/** Number of overridden properties in an instance subtree. */
export function countOverrides(doc: Document, instance: NodeId): number {
  let n = doc.get(instance, 'overrides').length + Object.keys(doc.get(instance, 'propValues') ?? {}).length * (isTopLevelInstance(doc, instance) ? 1 : 0);
  doc.store.walk(instance, (id) => {
    n += doc.get(id, 'overrides').length;
  });
  return n;
}

// ---------- synchronisation ----------

function write(ctx: Ctx, id: NodeId, key: PropKey, value: unknown): void {
  if (valueEquals(ctx.doc.get(id, key), value)) return;
  ctx.tx.set(id, key, cloneValue(value) as never);
  ctx.modified.add(id);
}

/** Value of a component property for a layer: nearest instance ancestor that sets it wins. */
function propertyValue(doc: Document, layer: NodeId, propId: string): string | boolean | undefined {
  let current = doc.parent(layer);
  while (current !== null && doc.type(current) !== 'PAGE') {
    if (doc.type(current) === 'INSTANCE') {
      const values = doc.get(current, 'propValues');
      if (values && Object.prototype.hasOwnProperty.call(values, propId)) return values[propId];
    }
    current = doc.parent(current);
  }
  return undefined;
}

/** Display name of a top-level instance: the component set's name for variants. */
function instanceName(doc: Document, component: NodeId): string {
  const set = componentSetOf(doc, component);
  return doc.get(set ?? component, 'name');
}

/** For an instance that follows its source, resolve which component it shows (override > property > source). */
function resolveMain(ctx: Ctx, id: NodeId): void {
  const { doc } = ctx;
  if (doc.type(id) !== 'INSTANCE') return;
  const key = doc.get(id, 'componentKey');
  if (!alive(doc, key) || doc.get(id, 'overrides').includes('mainComponent')) return;
  let main = doc.type(key) === 'INSTANCE' ? doc.get(key, 'mainComponent') : null;
  const ref = doc.get(key, 'propRefs')?.mainComponent;
  if (ref) {
    const value = propertyValue(doc, id, ref);
    if (typeof value === 'string' && alive(doc, value) && doc.type(value) === 'COMPONENT') main = value;
  }
  if (main) write(ctx, id, 'mainComponent', main);
}

function syncProps(ctx: Ctx, id: NodeId, source: NodeId): void {
  const { doc } = ctx;
  const overrides = new Set(doc.get(id, 'overrides'));
  const fromComponent = doc.type(source) === 'COMPONENT';
  const refs = doc.get(source, 'propRefs');
  for (const key of COPY_KEYS) {
    if (overrides.has(key)) continue;
    // An instance mirroring a component keeps its own choice of component, property
    // values, and its binding to a property of an outer component.
    if (fromComponent && (key === 'mainComponent' || key === 'propValues' || key === 'propRefs')) continue;
    // How an instance behaves inside a scrolling frame is about where it is placed, like its position (FR-PRT-031).
    if (fromComponent && key === 'scrollBehavior') continue;
    if (key === 'mainComponent' && doc.type(id) === 'INSTANCE') continue; // resolved in resolveMain
    let value: unknown = doc.get(source, key);
    if (fromComponent && key === 'name') value = instanceName(doc, source);
    const ref = refs?.[key as 'characters' | 'visible'];
    if (ref && !fromComponent) {
      const v = propertyValue(doc, id, ref);
      if (key === 'characters' && typeof v === 'string') value = v;
      if (key === 'visible' && typeof v === 'boolean') value = v;
    }
    write(ctx, id, key, value);
  }
  const layerKey = keyOf(doc, source);
  if (doc.get(id, 'layerKey') !== layerKey && !fromComponent) write(ctx, id, 'layerKey', layerKey);
}

function syncGeometry(ctx: Ctx, id: NodeId, source: NodeId): void {
  const { doc } = ctx;
  const overrides = doc.get(id, 'overrides');
  const slot = doc.get(id, 'componentKey');
  const fromComponent = doc.type(source) === 'COMPONENT';
  if (fromComponent) {
    // Size follows the component unless the user resized a top-level instance.
    if (!overrides.includes('width')) write(ctx, id, 'width', doc.get(source, 'width'));
    if (!overrides.includes('height')) write(ctx, id, 'height', doc.get(source, 'height'));
    // A top-level instance owns its position. A swapped nested instance keeps the place of its slot.
    if (!alive(doc, slot)) return;
  }
  const place = fromComponent ? slot! : source;
  write(ctx, id, 'rotation', doc.get(place, 'rotation'));
  const parent = doc.parent(id);
  const sourceParent = doc.parent(place);
  const flows = parent !== null && doc.get(parent, 'layoutMode') !== 'NONE' && doc.get(id, 'positioning') === 'AUTO';
  if (flows || parent === null || sourceParent === null) {
    // Auto layout positions the layer; the stored size matters for fixed sizing.
    write(ctx, id, 'x', doc.get(place, 'x'));
    write(ctx, id, 'y', doc.get(place, 'y'));
    if (!fromComponent) {
      write(ctx, id, 'width', doc.get(place, 'width'));
      write(ctx, id, 'height', doc.get(place, 'height'));
    }
    return;
  }
  // Constraints map the source layer from its parent's size to this parent's size.
  const c = doc.get(place, 'constraints');
  const h = constrainSpan(c.horizontal, { start: doc.get(place, 'x'), size: doc.get(place, 'width') }, doc.get(sourceParent, 'width'), doc.get(parent, 'width'));
  const v = constrainSpan(c.vertical, { start: doc.get(place, 'y'), size: doc.get(place, 'height') }, doc.get(sourceParent, 'height'), doc.get(parent, 'height'));
  write(ctx, id, 'x', round(h.start));
  write(ctx, id, 'y', round(v.start));
  if (!fromComponent) {
    write(ctx, id, 'width', round(h.size));
    write(ctx, id, 'height', round(v.size));
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Instance whose `parkedOverrides` collects overrides of layers removed under `id`. */
function parkingRoot(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'INSTANCE' && sourceOf(doc, current) !== null && doc.type(sourceOf(doc, current)!) === 'COMPONENT') return current;
    if (doc.type(current) === 'PAGE') return null;
    current = doc.parent(current);
  }
  return null;
}

function park(ctx: Ctx, root: NodeId, layer: NodeId): void {
  const { doc } = ctx;
  const parked = { ...(doc.get(root, 'parkedOverrides') ?? {}) };
  let changed = false;
  const visit = (id: NodeId) => {
    const keys = doc.get(id, 'overrides');
    if (keys.length > 0) {
      const values: Record<string, unknown> = { __overrides: [...keys] };
      for (const k of keys) values[k] = cloneValue(doc.get(id, k as PropKey));
      parked[keyOf(doc, id)] = values;
      changed = true;
    }
    for (const child of doc.children(id)) visit(child);
  };
  visit(layer);
  if (changed) write(ctx, root, 'parkedOverrides', parked);
}

function unpark(ctx: Ctx, root: NodeId | null, layer: NodeId): void {
  const { doc } = ctx;
  if (!root) return;
  const parked = doc.get(root, 'parkedOverrides');
  const key = keyOf(doc, layer);
  const entry = parked?.[key];
  if (!parked || !entry) return;
  const keys = (entry.__overrides as string[] | undefined) ?? [];
  for (const k of keys) if (k in entry) write(ctx, layer, k as PropKey, entry[k]);
  write(ctx, layer, 'overrides', keys);
  const rest = { ...parked };
  delete rest[key];
  write(ctx, root, 'parkedOverrides', Object.keys(rest).length > 0 ? rest : null);
}

/** Finds the existing layer that should mirror `sourceChild`: same source, then same layer key, then a unique same name. */
function matchChild(doc: Document, candidates: readonly NodeId[], used: ReadonlySet<NodeId>, sourceChild: NodeId, sourceSiblings: readonly NodeId[]): NodeId | null {
  const type = mirrorType(doc.type(sourceChild));
  const free = candidates.filter((c) => !used.has(c) && doc.type(c) === type);
  const byKey = free.find((c) => doc.get(c, 'componentKey') === sourceChild);
  if (byKey) return byKey;
  const key = keyOf(doc, sourceChild);
  const byLayerKey = free.find((c) => keyOf(doc, c) === key);
  if (byLayerKey) return byLayerKey;
  const name = doc.get(sourceChild, 'name');
  if (sourceSiblings.filter((s) => doc.get(s, 'name') === name).length !== 1) return null;
  const byName = free.filter((c) => doc.get(c, 'name') === name);
  return byName.length === 1 ? byName[0]! : null;
}

function createMirror(ctx: Ctx, parent: NodeId, source: NodeId, depth: number): NodeId {
  const { doc, tx } = ctx;
  const id = tx.create(mirrorType(doc.type(source)), parent, {
    componentKey: source,
    layerKey: keyOf(doc, source),
    mainComponent: doc.type(source) === 'INSTANCE' ? doc.get(source, 'mainComponent') : null,
  });
  ctx.modified.add(id);
  ctx.structural = true;
  unpark(ctx, parkingRoot(doc, parent), id);
  syncNode(ctx, id, true, depth + 1);
  return id;
}

function syncChildren(ctx: Ctx, id: NodeId, source: NodeId, deep: boolean, depth: number): void {
  const { doc, tx } = ctx;
  const sourceChildren = doc.children(source);
  const current = [...doc.children(id)];
  const used = new Set<NodeId>();
  const ordered: NodeId[] = [];
  for (const sc of sourceChildren) {
    const match = matchChild(doc, current, used, sc, sourceChildren);
    if (match) {
      used.add(match);
      if (doc.get(match, 'componentKey') !== sc) write(ctx, match, 'componentKey', sc);
      ordered.push(match);
      if (deep) syncNode(ctx, match, true, depth + 1);
    } else {
      ordered.push(createMirror(ctx, id, sc, depth));
    }
  }
  for (const extra of current) {
    if (used.has(extra)) continue;
    const root = parkingRoot(doc, id);
    if (root) park(ctx, root, extra);
    tx.delete(extra);
    ctx.modified.add(extra);
    ctx.structural = true;
  }
  // Keep the order of the source.
  const now = doc.children(id);
  if (now.length !== ordered.length || now.some((c, i) => c !== ordered[i])) {
    ordered.forEach((child, i) => tx.move(child, id, { index: i }));
    ctx.modified.add(id);
    ctx.structural = true;
  }
}

/** Brings one mirror in line with its source; `deep` also syncs existing children. */
export function syncNode(ctx: Ctx, id: NodeId, deep: boolean, depth = 0): void {
  const { doc } = ctx;
  if (depth > MAX_DEPTH || !alive(doc, id)) return;
  resolveMain(ctx, id);
  const source = sourceOf(doc, id);
  if (!source || source === id) return;
  // An instance must not mirror a component that contains it.
  if (doc.type(source) === 'COMPONENT' && doc.store.isAncestorOrSelf(source, id)) return;
  syncProps(ctx, id, source);
  syncGeometry(ctx, id, source);
  syncChildren(ctx, id, source, deep, depth);
}

/** Whether a change to `id` can affect any instance (cheap check that skips ordinary edits). */
function related(doc: Document, id: NodeId): boolean {
  let current: NodeId | null | undefined = id;
  while (current) {
    const record = doc.store.record(current);
    if (!record) return false;
    if (record.type === 'COMPONENT' || record.type === 'COMPONENT_SET' || record.type === 'INSTANCE') return true;
    if (record.props.componentKey != null) return true;
    current = record.parent;
  }
  return false;
}

/**
 * Propagates the changes of a transaction to every affected instance.
 * `touched` are the nodes the user's edit changed (created, moved, updated).
 */
export function syncComponents(doc: Document, tx: Transaction, touched: Iterable<NodeId>): void {
  let pending = new Set<NodeId>();
  for (const id of touched) if (related(doc, id)) pending.add(id);
  if (pending.size === 0) return;
  let index = new SourceIndex(doc);
  const ctx: Ctx = { doc, tx, modified: new Set(), structural: false };
  for (let round = 0; round < MAX_ROUNDS && pending.size > 0; round++) {
    const work = new Map<NodeId, boolean>();
    for (const t of pending) {
      // An edited instance (or instance layer) re-syncs itself; deep on the user's own edit.
      if (round === 0 && alive(doc, t) && (doc.type(t) === 'INSTANCE' || isInstanceLayer(doc, t))) work.set(t, true);
      // Everything mirroring the changed node, or its parent (for added and removed children).
      const parent = doc.store.record(t)?.parent ?? null;
      const sources = parent ? [t, parent] : [t];
      // Renaming a component set renames instances of its variants.
      if (alive(doc, t) && doc.type(t) === 'COMPONENT_SET') sources.push(...doc.children(t));
      for (const s of sources) {
        for (const dep of index.dependents(s)) if (!work.has(dep)) work.set(dep, false);
      }
    }
    ctx.modified = new Set();
    ctx.structural = false;
    // Parents before children, so constraints see the final parent size.
    const ordered = [...work].filter(([id]) => alive(doc, id)).sort((a, b) => doc.store.ancestors(a[0]).length - doc.store.ancestors(b[0]).length);
    for (const [id, deep] of ordered) syncNode(ctx, id, deep);
    if (ctx.structural) index = new SourceIndex(doc);
    pending = ctx.modified;
  }
}

/** Assigns explicit layer keys inside a component so duplicates (variants) share them. */
export function ensureLayerKeys(doc: Document, tx: Transaction, root: NodeId): void {
  const visit = (id: NodeId) => {
    if (doc.get(id, 'layerKey') === null && !isInstanceLayer(doc, id)) tx.set(id, 'layerKey', id);
    if (doc.type(id) === 'INSTANCE') return; // layers of nested instances already carry keys
    for (const child of doc.children(id)) visit(child);
  };
  for (const child of doc.children(root)) visit(child);
}

/** Props of a node as stored (non-default values only). */
export function ownProps(doc: Document, id: NodeId): Partial<NodeProps> {
  return structuredClone(doc.store.record(id)?.props ?? {});
}
