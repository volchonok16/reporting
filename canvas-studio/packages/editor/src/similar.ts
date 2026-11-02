// Find similar components (October list, "AI without AI"): how much a layer
// looks like each component of the file, from its structure, size, colours and
// texts — no image model. Finds the button that was copied and detached
// instead of used as an instance, so it can go back to the design system.

import { colorToHex, type Document, type NodeId } from '#core';

/** What a layer is made of, as multisets of tokens. */
function profile(doc: Document, root: NodeId): { shape: Map<string, number>; colors: Set<string>; words: Set<string>; w: number; h: number } {
  const shape = new Map<string, number>();
  const colors = new Set<string>();
  const words = new Set<string>();
  const add = (k: string) => shape.set(k, (shape.get(k) ?? 0) + 1);
  const walk = (id: NodeId, depth: number) => {
    if (!doc.get(id, 'visible')) return;
    const t = doc.type(id) === 'INSTANCE' || doc.type(id) === 'COMPONENT' ? 'FRAME' : doc.type(id);
    add(`${depth}:${t}`);
    if (t === 'FRAME' && doc.get(id, 'layoutMode') !== 'NONE') add(`${depth}:al:${doc.get(id, 'layoutMode')}`);
    for (const p of [...doc.get(id, 'fills'), ...doc.get(id, 'strokes')]) if (p.visible && p.type === 'SOLID') colors.add(colorToHex(p.color));
    if (t === 'TEXT') for (const word of doc.get(id, 'characters').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word.length > 1) words.add(word);
    for (const c of doc.children(id)) walk(c, depth + 1);
  };
  walk(root, 0);
  return { shape, colors, words, w: doc.get(root, 'width'), h: doc.get(root, 'height') };
}

function jaccardBag(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let union = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    inter += Math.min(a.get(k) ?? 0, b.get(k) ?? 0);
    union += Math.max(a.get(k) ?? 0, b.get(k) ?? 0);
  }
  return union ? inter / union : 1;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity 0..1: structure weighs most, then size and colours, then text. */
export function similarity(doc: Document, a: NodeId, b: NodeId): number {
  const pa = profile(doc, a);
  const pb = profile(doc, b);
  const size = Math.min(pa.w, pb.w) / Math.max(pa.w, pb.w, 1) * (Math.min(pa.h, pb.h) / Math.max(pa.h, pb.h, 1));
  return 0.5 * jaccardBag(pa.shape, pb.shape) + 0.2 * Math.sqrt(size) + 0.2 * jaccard(pa.colors, pb.colors) + 0.1 * jaccard(pa.words, pb.words);
}

/** Components of the file most like a layer, best first (at least `min` similar). */
export function similarComponents(doc: Document, id: NodeId, min = 0.45): { component: NodeId; score: number }[] {
  const out: { component: NodeId; score: number }[] = [];
  const own = doc.type(id) === 'INSTANCE' ? doc.get(id, 'mainComponent') : null;
  const walk = (n: NodeId) => {
    for (const c of doc.children(n)) {
      if (doc.type(c) === 'COMPONENT' && c !== id && c !== own) out.push({ component: c, score: similarity(doc, id, c) });
      if (doc.type(c) === 'PAGE' || doc.type(c) === 'SECTION' || doc.type(c) === 'COMPONENT_SET' || doc.type(c) === 'FRAME') walk(c);
    }
  };
  walk(doc.rootId);
  return out.filter((r) => r.score >= min).sort((x, y) => y.score - x.score);
}
