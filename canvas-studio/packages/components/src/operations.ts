// Component operations used by the editor: create, instantiate, detach, and
// component properties (FR-CMP-001…043). All functions write through the
// caller's transaction; synchronisation then fills instances in.

import { tr } from '#core';
import { isPropKey, randomId, type ComponentPropDef, type ComponentPropType, type Document, type NodeId, type NodeProps, type Position, type PropBinding, type Transaction } from '#core';
import { alive, componentSetOf, countOverrides, ensureLayerKeys, isInstanceLayer, isOverridable, isTopLevelInstance, keyOf, owningComponent, sourceOf, wouldCreateCycle } from './sync.ts';

/** Properties that describe a component link; never carried into plain layers. */
const LINK_KEYS = ['componentKey', 'overrides', 'parkedOverrides', 'mainComponent', 'propValues'] as const;

/**
 * Turns a frame into a component in place: a COMPONENT node takes the frame's
 * place, properties and children (node types are immutable, so the frame is replaced).
 */
export function convertFrameToComponent(doc: Document, tx: Transaction, frame: NodeId): NodeId {
  const parent = doc.parent(frame);
  if (!parent) throw new Error('Frame has no parent');
  const props = structuredClone(doc.store.record(frame)!.props);
  delete props.deleted;
  const component = tx.create('COMPONENT', parent, props, { after: frame });
  for (const child of [...doc.children(frame)]) tx.move(child, component, { at: 'end' });
  tx.delete(frame);
  ensureLayerKeys(doc, tx, component);
  return component;
}

/** Creates an instance of `component` under `parent`. Synchronisation fills in its layers. */
export function createInstance(doc: Document, tx: Transaction, component: NodeId, parent: NodeId, props: Partial<NodeProps> = {}, position: Position = { at: 'end' }): NodeId {
  if (doc.type(component) !== 'COMPONENT') throw new Error('Not a component');
  if (wouldCreateCycle(doc, component, parent)) throw new Error(tr('Компонент не может содержать сам себя'));
  return tx.create(
    'INSTANCE',
    parent,
    {
      mainComponent: component,
      width: doc.get(component, 'width'),
      height: doc.get(component, 'height'),
      ...props,
    },
    position,
  );
}

/**
 * Detaches an instance (FR-CMP-041): a plain frame takes its place with the
 * current look; nested instances stay instances of their own components.
 */
export function detachInstance(doc: Document, tx: Transaction, instance: NodeId): NodeId {
  const parent = doc.parent(instance);
  if (!parent || doc.type(instance) !== 'INSTANCE') throw new Error('Not an instance');
  const props = structuredClone(doc.store.record(instance)!.props) as Record<string, unknown>;
  for (const key of [...LINK_KEYS, 'deleted', 'layerKey']) delete props[key];
  const frame = tx.create('FRAME', parent, props as Partial<NodeProps>, { after: instance });
  for (const child of [...doc.children(instance)]) {
    tx.move(child, frame, { at: 'end' });
    unlink(doc, tx, child);
  }
  tx.delete(instance);
  return frame;
}

/** Strips instance links from a layer tree; nested instances become top-level instances. */
function unlink(doc: Document, tx: Transaction, id: NodeId): void {
  tx.set(id, 'componentKey', null);
  tx.set(id, 'parkedOverrides', null);
  if (doc.type(id) === 'INSTANCE') return; // its layers still mirror its component
  tx.set(id, 'overrides', []);
  for (const child of doc.children(id)) unlink(doc, tx, child);
}

/**
 * Brings back the deleted main component of a top-level instance (step 6, Figma's «Restore component»), with
 * its own id, so every instance of it is linked again at once.
 * - Deleted in this session (its record is still in the file): it is made alive where it was — inside its
 *   set if the set was deleted with it; if its place is gone too, at `place`.
 * - Gone from the file (deleted, then saved and opened again): it is rebuilt from the instance of it with
 *   the fewest overrides — each layer under its old id (the instances' links), its properties from the
 *   bindings its layers keep — at `place`.
 * Returns the component, or null when the instance's component is alive or unknown.
 */
export function restoreMainComponent(doc: Document, tx: Transaction, instance: NodeId, place: { parent: NodeId; x: number; y: number }): NodeId | null {
  if (!isTopLevelInstance(doc, instance)) return null;
  const main = doc.get(instance, 'mainComponent');
  if (!main || alive(doc, main)) return null;
  const record = doc.store.record(main);
  if (record) {
    if (record.type !== 'COMPONENT') return null;
    const parent = record.parent;
    const set = parent !== null && doc.store.record(parent)?.type === 'COMPONENT_SET' ? parent : null;
    if (parent !== null && doc.store.isAlive(parent)) {
      tx.set(main, 'deleted', false);
    } else if (set && doc.store.get(set, 'deleted') === true && doc.store.record(set)!.parent !== null && doc.store.isAlive(doc.store.record(set)!.parent!)) {
      tx.set(set, 'deleted', false);
      tx.set(main, 'deleted', false);
    } else {
      tx.move(main, place.parent, { at: 'end' });
      tx.set(main, 'x', place.x);
      tx.set(main, 'y', place.y);
      tx.set(main, 'deleted', false);
    }
    return alive(doc, main) ? main : null;
  }
  // Rebuilt: from the instance that repeats the component most closely.
  const instances: NodeId[] = [];
  for (const r of doc.store.allRecords()) if (r.type === 'INSTANCE' && r.props.mainComponent === main && doc.store.isAlive(r.id) && isTopLevelInstance(doc, r.id)) instances.push(r.id);
  const from = instances.sort((a, b) => countOverrides(doc, a) - countOverrides(doc, b))[0] ?? instance;
  const props = structuredClone(doc.store.record(from)!.props) as Partial<NodeProps>;
  for (const key of [...LINK_KEYS, 'deleted', 'layerKey', 'componentProps'] as const) delete props[key];
  props.x = place.x;
  props.y = place.y;
  const defs: ComponentPropDef[] = [];
  if (!tx.revive(main, 'COMPONENT', place.parent, doc.indexFor(place.parent), props)) return null;
  for (const child of doc.children(from)) rebuildLayer(doc, tx, child, main, null, defs);
  if (defs.length) tx.set(main, 'componentProps', defs);
  return main;
}

const TYPE_FOR: Record<PropBinding, ComponentPropType> = { characters: 'TEXT', visible: 'BOOLEAN', mainComponent: 'INSTANCE_SWAP' };

/**
 * A layer of the rebuilt component (or of an instance nested in it) under the id the instance's copy links
 * to. `source` — what the new layer's parent is synced from (null for the component's own layers).
 */
function rebuildLayer(doc: Document, tx: Transaction, copy: NodeId, parent: NodeId, parentSource: NodeId | null, defs: ComponentPropDef[]): void {
  const id = doc.get(copy, 'componentKey');
  if (!id || doc.store.has(id)) return;
  const props = structuredClone(doc.store.record(copy)!.props) as Partial<NodeProps>;
  for (const key of ['deleted', 'overrides', 'parkedOverrides'] as const) delete props[key];
  const key = doc.get(copy, 'layerKey') ?? id;
  // Inside a nested instance: synced from the layer of its source with the same key.
  const source = parentSource ? (doc.children(parentSource).find((c) => keyOf(doc, c) === key) ?? null) : null;
  props.componentKey = source;
  if (!parentSource) {
    props.layerKey = key;
    if (doc.type(copy) !== 'INSTANCE') delete props.propValues;
    // The component's properties, from what its layers are bound to (names as when a property is added).
    for (const [binding, propId] of Object.entries(props.propRefs ?? {}) as [PropBinding, string][]) {
      if (!propId || defs.some((d) => d.id === propId)) continue;
      const type = TYPE_FOR[binding];
      if (type) defs.push({ id: propId, name: uniqueName(defs, type === 'BOOLEAN' ? tr('Показать «{0}»', String(props.name ?? '')) : String(props.name ?? '')), type });
    }
  }
  if (!tx.revive(id, doc.type(copy), parent, doc.indexFor(parent), props)) return;
  const main = doc.get(copy, 'mainComponent');
  const childSource = doc.type(copy) === 'INSTANCE' && !parentSource ? (alive(doc, main) ? main : null) : source;
  for (const child of doc.children(copy)) rebuildLayer(doc, tx, child, id, childSource, defs);
}

/**
 * «Перенести изменения в компонент» (step 6, Figma's Push changes to main component): the overrides of a
 * top-level instance become the values of its main component — each overridden property is written to the
 * layer it mirrors (a layer of the component, or of an instance nested in it, where it becomes that nested
 * instance's override) and the instance's own override is cleared. The instance looks the same; the other
 * instances take the change unless they override that property themselves. Property values (propValues) are
 * the instance's choices and stay. Returns how many properties were carried over.
 */
export function pushOverridesToMain(doc: Document, tx: Transaction, instance: NodeId): number {
  if (!isTopLevelInstance(doc, instance)) return 0;
  const main = doc.get(instance, 'mainComponent');
  if (!alive(doc, main) || doc.type(main) !== 'COMPONENT') return 0;
  let pushed = 0;
  const carry = (layer: NodeId, target: NodeId) => {
    const all = doc.get(layer, 'overrides');
    if (all.length === 0) return;
    // The instance's own name is what it is called where it stands, not the component's name.
    const keys = layer === instance ? all.filter((k) => k !== 'name') : all;
    for (const key of keys) {
      if (!isPropKey(key)) continue;
      tx.set(target, key, structuredClone(doc.get(layer, key)) as never);
      pushed++;
    }
    // A layer of an instance nested in the component: the value is that nested instance's override.
    if (target !== main) {
      const own = new Set(doc.get(target, 'overrides'));
      for (const key of keys) if (isOverridable(doc, target, key)) own.add(key);
      if (own.size !== doc.get(target, 'overrides').length) tx.set(target, 'overrides', [...own]);
    }
    tx.set(layer, 'overrides', all.filter((k) => !keys.includes(k)));
  };
  carry(instance, main);
  doc.store.walk(instance, (id) => {
    const source = sourceOf(doc, id);
    // Only into this component (a swapped nested instance mirrors another component: not changed from here).
    if (source && owningComponent(doc, source) === main) carry(id, source);
  });
  return pushed;
}

/** Main component of an instance (or of the instance containing a layer). */
export function mainComponentOf(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'INSTANCE') {
      const main = doc.get(current, 'mainComponent');
      return alive(doc, main) ? main : null;
    }
    if (doc.type(current) === 'PAGE') return null;
    current = doc.parent(current);
  }
  return null;
}

/** All components and component sets in the file, in page order. */
export function listComponents(doc: Document): { id: NodeId; page: NodeId; set: NodeId | null }[] {
  const out: { id: NodeId; page: NodeId; set: NodeId | null }[] = [];
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      const type = doc.type(id);
      if (type === 'COMPONENT') out.push({ id, page, set: componentSetOf(doc, id) });
      // Instances are not searched: they never contain definitions.
      return type !== 'INSTANCE';
    });
  }
  return out;
}

// ---------- component properties ----------

/** The node that declares properties for a component: its set for variants. */
export function propertyOwner(doc: Document, component: NodeId): NodeId {
  return componentSetOf(doc, component) ?? component;
}

export function propertyDefs(doc: Document, component: NodeId): ComponentPropDef[] {
  return doc.get(propertyOwner(doc, component), 'componentProps');
}

const BINDING_FOR: Record<ComponentPropType, PropBinding> = {
  TEXT: 'characters',
  BOOLEAN: 'visible',
  INSTANCE_SWAP: 'mainComponent',
};

/**
 * Exposes a layer of a component as a component property (FR-CMP-010):
 * text content, visibility or the component of a nested instance.
 * In a set, the same layer (by layer key) is bound in every variant.
 */
export function addPropertyFromLayer(doc: Document, tx: Transaction, layer: NodeId, type: ComponentPropType, name?: string): string {
  const component = owningComponent(doc, layer);
  if (!component || isInstanceLayer(doc, layer)) throw new Error(tr('Слой должен принадлежать компоненту'));
  if (type === 'TEXT' && doc.type(layer) !== 'TEXT') throw new Error(tr('Текстовое свойство привязывается к текстовому слою'));
  if (type === 'INSTANCE_SWAP' && doc.type(layer) !== 'INSTANCE') throw new Error(tr('Свойство замены привязывается к вложенному экземпляру'));
  const owner = propertyOwner(doc, component);
  ensureLayerKeys(doc, tx, component);
  const id = `p_${randomId(8)}`;
  const label = name ?? defaultPropName(doc, layer, type);
  tx.set(owner, 'componentProps', [...doc.get(owner, 'componentProps'), { id, name: uniqueName(doc.get(owner, 'componentProps'), label), type }]);
  const binding = BINDING_FOR[type];
  for (const target of sameLayerInVariants(doc, layer)) {
    tx.set(target, 'propRefs', { ...(doc.get(target, 'propRefs') ?? {}), [binding]: id });
  }
  return id;
}

function defaultPropName(doc: Document, layer: NodeId, type: ComponentPropType): string {
  const name = doc.get(layer, 'name');
  if (type === 'BOOLEAN') return tr('Показать «{0}»', name);
  return name;
}

function uniqueName(defs: readonly ComponentPropDef[], name: string): string {
  if (!defs.some((d) => d.name === name)) return name;
  let i = 2;
  while (defs.some((d) => d.name === `${name} ${i}`)) i++;
  return `${name} ${i}`;
}

/** The layer itself and, in a component set, the layers with the same key in other variants. */
export function sameLayerInVariants(doc: Document, layer: NodeId): NodeId[] {
  const component = owningComponent(doc, layer);
  const set = component ? componentSetOf(doc, component) : null;
  if (!set) return [layer];
  const key = doc.get(layer, 'layerKey') ?? layer;
  const out: NodeId[] = [];
  for (const variant of doc.children(set)) {
    doc.store.walk(variant, (id) => {
      if ((doc.get(id, 'layerKey') ?? id) === key) out.push(id);
      return doc.type(id) !== 'INSTANCE';
    });
  }
  return out.length > 0 ? out : [layer];
}

export function renameProperty(doc: Document, tx: Transaction, owner: NodeId, propId: string, name: string): void {
  tx.set(owner, 'componentProps', doc.get(owner, 'componentProps').map((p) => (p.id === propId ? { ...p, name } : p)));
}

/** The preferred components of a swap property (step 6): kept in the given order, without repeats. */
export function setPreferredValues(doc: Document, tx: Transaction, owner: NodeId, propId: string, components: readonly NodeId[]): void {
  const list = [...new Set(components)];
  tx.set(owner, 'componentProps', doc.get(owner, 'componentProps').map((p) => (p.id === propId ? (list.length ? { ...p, preferred: list } : (({ preferred: _, ...rest }) => rest)(p)) : p)));
}

/**
 * The preferred components for swapping `instance` (a nested instance bound to a swap property of the
 * component its outer instance shows), alive ones only; [] when it is not bound or has none.
 */
export function preferredFor(doc: Document, instance: NodeId): NodeId[] {
  const source = doc.get(instance, 'componentKey');
  if (!alive(doc, source)) return [];
  const propId = doc.get(source, 'propRefs')?.mainComponent;
  const component = owningComponent(doc, source);
  if (!propId || !component) return [];
  const def = propertyDefs(doc, component).find((d) => d.id === propId);
  return (def?.preferred ?? []).filter((id) => alive(doc, id) && doc.type(id) === 'COMPONENT');
}

/** Instances placed in a component (not the layers of other instances), in layer order — those that can be exposed. */
export function nestedInstancesOf(doc: Document, component: NodeId): NodeId[] {
  const out: NodeId[] = [];
  doc.store.walk(component, (id) => {
    if (doc.type(id) !== 'INSTANCE') return true;
    out.push(id);
    return false;
  });
  return out;
}

/** Shows (or stops showing) a nested instance's properties in the component's instances; the same layer in every variant. */
export function setExposed(doc: Document, tx: Transaction, layer: NodeId, on: boolean): void {
  for (const target of sameLayerInVariants(doc, layer)) if (doc.type(target) === 'INSTANCE') tx.set(target, 'exposedInstance', on);
}

/** The nested instances of `instance` whose properties its panel shows (exposed in their components), outermost first. */
export function exposedIn(doc: Document, instance: NodeId): NodeId[] {
  const out: NodeId[] = [];
  // The flag of the layer it mirrors decides (a swapped variant syncs from its own component, which has none).
  const exposed = (id: NodeId): boolean => {
    for (let at: NodeId | null = id, n = 0; at && n < 64; at = doc.get(at, 'componentKey'), n++) if (doc.get(at, 'exposedInstance')) return true;
    return false;
  };
  doc.store.walk(instance, (id) => {
    if (doc.type(id) === 'INSTANCE' && isInstanceLayer(doc, id) && exposed(id)) out.push(id);
    return true;
  });
  return out;
}

/** Removes a property and its bindings; instance values are dropped. */
export function removeProperty(doc: Document, tx: Transaction, owner: NodeId, propId: string): void {
  tx.set(owner, 'componentProps', doc.get(owner, 'componentProps').filter((p) => p.id !== propId));
  const roots = doc.type(owner) === 'COMPONENT_SET' ? [...doc.children(owner)] : [owner];
  for (const root of roots) {
    doc.store.walk(root, (id) => {
      const refs = doc.get(id, 'propRefs');
      if (refs && Object.values(refs).includes(propId)) {
        const next = Object.fromEntries(Object.entries(refs).filter(([, v]) => v !== propId));
        tx.set(id, 'propRefs', Object.keys(next).length > 0 ? next : null);
      }
      return doc.type(id) !== 'INSTANCE';
    });
  }
  for (const record of [...doc.store.allRecords()]) {
    if (record.type !== 'INSTANCE' || record.props.deleted === true) continue;
    const values = record.props.propValues;
    if (values && propId in values) {
      const next = { ...values };
      delete next[propId];
      tx.set(record.id, 'propValues', Object.keys(next).length > 0 ? next : null);
    }
  }
}

/** Unbinds one layer from a property (the property itself stays). */
export function unbindLayer(doc: Document, tx: Transaction, layer: NodeId, binding: PropBinding): void {
  for (const target of sameLayerInVariants(doc, layer)) {
    const refs = { ...(doc.get(target, 'propRefs') ?? {}) };
    delete refs[binding];
    tx.set(target, 'propRefs', Object.keys(refs).length > 0 ? refs : null);
  }
}

/** Current value of a component property on an instance (its own value or the component default). */
export function instancePropertyValue(doc: Document, instance: NodeId, def: ComponentPropDef): string | boolean | null {
  const values = doc.get(instance, 'propValues');
  if (values && def.id in values) return values[def.id]!;
  const main = doc.get(instance, 'mainComponent');
  if (!alive(doc, main)) return null;
  let value: string | boolean | null = null;
  doc.store.walk(main, (id) => {
    if (value !== null) return false;
    const refs = doc.get(id, 'propRefs');
    if (refs?.characters === def.id) value = doc.get(id, 'characters');
    else if (refs?.visible === def.id) value = doc.get(id, 'visible');
    else if (refs?.mainComponent === def.id) value = doc.get(id, 'mainComponent');
    return doc.type(id) !== 'INSTANCE';
  });
  return value;
}

export function setInstanceProperty(doc: Document, tx: Transaction, instance: NodeId, propId: string, value: string | boolean): void {
  tx.set(instance, 'propValues', { ...(doc.get(instance, 'propValues') ?? {}), [propId]: value });
}

// ---------- clipboard ----------

/**
 * Makes a copied layer tree valid at its new place (FR-CMP-033): a copy of an
 * instance keeps its overrides; a copy of an instance's inner layer becomes a
 * plain layer; anything pasted into an instance is refused by the editor.
 */
export function sanitizePasted(props: Partial<NodeProps>, type: string, insideInstance: boolean): Partial<NodeProps> {
  if (insideInstance) return props;
  const out = { ...props };
  delete out.componentKey;
  delete out.parkedOverrides;
  if (type !== 'INSTANCE') delete out.overrides;
  return out;
}

export { isTopLevelInstance };
