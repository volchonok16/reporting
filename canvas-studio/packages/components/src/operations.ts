// Component operations used by the editor: create, instantiate, detach, and
// component properties (FR-CMP-001…043). All functions write through the
// caller's transaction; synchronisation then fills instances in.

import { tr } from '#core';
import { randomId, type ComponentPropDef, type ComponentPropType, type Document, type NodeId, type NodeProps, type Position, type PropBinding, type Transaction } from '#core';
import { alive, componentSetOf, ensureLayerKeys, isInstanceLayer, isTopLevelInstance, owningComponent, wouldCreateCycle } from './sync.ts';

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
