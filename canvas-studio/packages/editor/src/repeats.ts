// ✦ «Повторы → компонент»: cards and buttons drawn by copying instead of from
// a component. Blocks built the same way — the same layer types and nesting,
// auto layout, colours and fonts; texts, pictures and sizes may differ — are
// found; the first becomes a component in its place, the others become its
// instances that keep their own texts, pictures and sizes (as overrides). One
// undo step.

import { colorToHex, tr, type Document, type NodeId, type Paint } from '#core';
import { convertFrameToComponent, createInstance, syncComponents } from '#components';
import type { Editor } from './editor.ts';

/** What a layer looks like when its content (texts, pictures) and size are left out. */
export function signature(doc: Document, id: NodeId): string {
  const t = doc.type(id);
  const paints = (list: readonly Paint[]) =>
    list
      .filter((p) => p.visible)
      .map((p) => (p.type === 'SOLID' ? colorToHex(p.color) : p.type === 'IMAGE' ? 'img' : p.type))
      .join(',');
  if (t === 'TEXT') return `T(${doc.get(id, 'fontFamily')} ${doc.get(id, 'fontWeight')} ${doc.get(id, 'fontSize')} ${paints(doc.get(id, 'fills'))})`;
  const own = [t, doc.get(id, 'layoutMode'), paints(doc.get(id, 'fills')), paints(doc.get(id, 'strokes')), doc.get(id, 'cornerRadius'), doc.get(id, 'visible') ? '' : 'hidden'].join('|');
  if (t === 'INSTANCE') return `${own}<${doc.get(id, 'mainComponent')}>`;
  return `${own}[${doc.children(id).map((c) => signature(doc, c)).join(';')}]`;
}

export function size(doc: Document, id: NodeId): number {
  let n = 1;
  if (doc.type(id) !== 'INSTANCE') for (const c of doc.children(id)) n += size(doc, c);
  return n;
}

/** Larger than this is a screen or a section of one, not a repeated block. */
export const MAX_BLOCK = 60;

export interface RepeatGroup {
  /** The blocks, in paint order; the first becomes the component. */
  ids: NodeId[];
  name: string;
}

/** Groups of blocks built the same way (at least 2 each, at least 3 layers each); outermost only. */
export function findRepeats(editor: Editor, roots: readonly NodeId[]): RepeatGroup[] {
  const doc = editor.doc;
  const bySig = new Map<string, NodeId[]>();
  const visit = (id: NodeId) => {
    const t = doc.type(id);
    if (t === 'INSTANCE' || t === 'COMPONENT' || t === 'COMPONENT_SET' || editor.isInstanceLayer(id)) return;
    // Blocks inside screens (cards, buttons, rows), not whole screens: two similar screens are two designs.
    const parent = doc.parent(id);
    const screen = parent === null || doc.type(parent) === 'PAGE' || doc.type(parent) === 'SECTION';
    const n = size(doc, id);
    if (t === 'FRAME' && n >= 3 && n <= MAX_BLOCK && !screen) {
      const sig = signature(doc, id);
      bySig.set(sig, [...(bySig.get(sig) ?? []), id]);
    }
    for (const c of doc.children(id)) visit(c);
  };
  roots.forEach(visit);
  const groups = [...bySig.values()].filter((ids) => ids.length >= 2).sort((a, b) => size(doc, b[0]!) - size(doc, a[0]!));
  // Outermost: a block inside a block already taken is left alone (it becomes part of the component).
  const taken = new Set<NodeId>();
  const inside = (id: NodeId) => {
    for (let p = doc.parent(id); p !== null; p = doc.parent(p)) if (taken.has(p)) return true;
    return false;
  };
  const out: RepeatGroup[] = [];
  for (const ids of groups) {
    const free = ids.filter((id) => !inside(id) && !ids.some((o) => o !== id && isAncestor(doc, o, id)));
    if (free.length < 2) continue;
    free.forEach((id) => taken.add(id));
    out.push({ ids: free, name: doc.get(free[0]!, 'name') });
  }
  return out;
}

function isAncestor(doc: Document, a: NodeId, b: NodeId): boolean {
  for (let p = doc.parent(b); p !== null; p = doc.parent(p)) if (p === a) return true;
  return false;
}

/** Layers of two trees built the same way, pair by pair. */
function pairs(doc: Document, a: NodeId, b: NodeId, out: [NodeId, NodeId][] = []): [NodeId, NodeId][] {
  out.push([a, b]);
  const ca = doc.children(a);
  const cb = doc.children(b);
  if (doc.type(a) !== 'INSTANCE') for (let i = 0; i < Math.min(ca.length, cb.length); i++) pairs(doc, ca[i]!, cb[i]!, out);
  return out;
}

/** Turns the groups into components and instances; returns the components. */
export function applyRepeats(editor: Editor, groups: readonly RepeatGroup[]): NodeId[] {
  const doc = editor.doc;
  const components: NodeId[] = [];
  editor.commit(tr('Повторы → компонент'), (tx) => {
    for (const g of groups) {
      // A group cannot be a component: it is wrapped in nothing — the first block must be a frame.
      const first = g.ids[0]!;
      if (doc.type(first) !== 'FRAME') continue;
      const component = convertFrameToComponent(doc, tx, first);
      components.push(component);
      for (const copy of g.ids.slice(1)) {
        if (doc.type(copy) !== 'FRAME' || !doc.store.isAlive(copy)) continue;
        const parent = doc.parent(copy)!;
        const instance = createInstance(doc, tx, component, parent, { name: doc.get(copy, 'name'), x: doc.get(copy, 'x'), y: doc.get(copy, 'y'), width: doc.get(copy, 'width'), height: doc.get(copy, 'height'), sizingH: doc.get(copy, 'sizingH'), sizingV: doc.get(copy, 'sizingV') }, { after: copy });
        syncComponents(doc, tx, [instance]);
        // Its own texts, pictures, visibility: overrides of the instance's layers.
        for (const [from, to] of pairs(doc, copy, instance).slice(1)) {
          const keys: string[] = [];
          const take = <K extends 'characters' | 'textRuns' | 'fills' | 'visible'>(key: K) => {
            if (JSON.stringify(doc.get(from, key)) === JSON.stringify(doc.get(to, key))) return;
            tx.set(to, key, structuredClone(doc.get(from, key)));
            keys.push(key);
          };
          if (doc.type(from) === 'TEXT' && doc.type(to) === 'TEXT') {
            take('characters');
            take('textRuns');
          }
          take('fills');
          take('visible');
          if (keys.length) tx.set(to, 'overrides', [...new Set([...doc.get(to, 'overrides'), ...keys])]);
        }
        tx.delete(copy);
      }
    }
  });
  return components;
}
