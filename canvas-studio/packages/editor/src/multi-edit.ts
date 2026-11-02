// Multi-edit variants (Q, as in Figma): a layer of one variant is matched in the other variants of
// its set by its place — the names of the layers down from the variant and, among siblings with the
// same name, the order.
import type { Document, NodeId } from '#core';

/** The variant (a component right in a component set) that holds the layer, the variant itself included. */
export function variantOf(doc: Document, id: NodeId): NodeId | null {
  for (let at: NodeId | null = id; at; at = doc.parent(at)) {
    const parent = doc.parent(at);
    if (parent && doc.type(parent) === 'COMPONENT_SET' && doc.type(at) === 'COMPONENT') return at;
  }
  return null;
}

/** The component set the layer belongs to: the set itself, a variant or a layer inside one. */
export function variantSetOf(doc: Document, id: NodeId): NodeId | null {
  if (doc.type(id) === 'COMPONENT_SET') return id;
  const variant = variantOf(doc, id);
  return variant ? doc.parent(variant) : null;
}

type Step = { name: string; nth: number };

function pathIn(doc: Document, variant: NodeId, id: NodeId): Step[] {
  const steps: Step[] = [];
  for (let at = id; at !== variant; at = doc.parent(at)!) {
    const name = doc.get(at, 'name');
    const same = doc.children(doc.parent(at)!).filter((c) => doc.get(c, 'name') === name);
    steps.unshift({ name, nth: same.indexOf(at) });
  }
  return steps;
}

function follow(doc: Document, variant: NodeId, steps: readonly Step[]): NodeId | null {
  let at = variant;
  for (const { name, nth } of steps) {
    const next = doc.children(at).filter((c) => doc.get(c, 'name') === name)[nth];
    if (!next) return null;
    at = next;
  }
  return at;
}

/** The layer and the layers in the same place in the other variants of its set (the layer comes first). */
export function matchingInVariants(doc: Document, id: NodeId): NodeId[] {
  const variant = variantOf(doc, id);
  if (!variant) return [id];
  const steps = pathIn(doc, variant, id);
  const others = doc.children(doc.parent(variant)!).filter((v) => v !== variant && doc.type(v) === 'COMPONENT');
  return [id, ...others.map((v) => follow(doc, v, steps)).filter((m): m is NodeId => m !== null)];
}
