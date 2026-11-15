// Breakpoints (as in Framer, Webflow): one screen in several widths — 1440, 768, 390. Every width is an
// ordinary top frame marked `breakpoint` with the set it belongs to; the same layer in every width carries
// the same `bpKey` (layers inside instances are matched by their component key, as the instances match them).
//
// What is one for all widths — texts, colours, pictures, strokes, effects, corners, names — is copied to the
// other widths after every edit, from whichever width it was made in. What is each width's own — place, size,
// auto layout, constraints, font size and spacing, visibility, order, instances' variants, prototype links —
// stays where it was changed. A layer added in one width appears in all (at the same place among its
// siblings, after the nearest one that is there); a layer deleted in one width goes from all; moved to
// another parent — moves in all. A frame copied by hand from a width is a new screen of its own.

import { cloneValue, valueEquals, type Document, type NodeId, type NodeProps, type PropKey, type Transaction } from '#core';
import { resizeWithConstraints } from '#layout';

/** One for all widths. */
const SHARED: readonly PropKey[] = [
  'name', 'opacity', 'blendMode', 'fills', 'strokes', 'strokeWeight', 'strokeWeights', 'strokeAlign', 'dashPattern', 'strokeCap', 'strokeJoin',
  'effects', 'cornerRadius', 'cornerRadii', 'cornerSmoothing', 'pointCount', 'innerRadius', 'arc', 'booleanOp', 'isMask', 'maskType', 'sketch', 'startCap', 'endCap',
  'characters', 'fontFamily', 'fontWeight', 'italic', 'textRuns', 'textCase', 'textDecoration', 'decorationStyle', 'fontFeatures',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'a11yRole', 'a11yLabel', 'code',
];
const SHARED_SET: ReadonlySet<string> = new Set(SHARED);

/** The width frame a layer is in (the layer itself when it is one), or null. */
export function breakpointFrameOf(doc: Document, id: NodeId): NodeId | null {
  for (const a of [id, ...doc.store.ancestors(id)]) {
    if (!doc.store.has(a)) return null;
    const bp = doc.get(a, 'breakpoint');
    if (bp && isTop(doc, a)) return a;
  }
  return null;
}

function isTop(doc: Document, id: NodeId): boolean {
  const parent = doc.parent(id);
  if (!parent) return false;
  const t = doc.type(parent);
  return t === 'PAGE' || t === 'SECTION';
}

/** Every width of the set `frame` is in, `frame` among them, narrowest last. */
export function breakpointFrames(doc: Document, frame: NodeId): NodeId[] {
  const bp = doc.get(frame, 'breakpoint');
  const page = doc.pageOf(frame);
  if (!bp || !page) return [frame];
  const out: NodeId[] = [];
  const walk = (parent: NodeId) => {
    for (const id of doc.children(parent)) {
      if (doc.type(id) === 'SECTION') walk(id);
      else if (doc.get(id, 'breakpoint')?.set === bp.set) out.push(id);
    }
  };
  walk(page);
  return out.sort((a, b) => doc.get(b, 'width') - doc.get(a, 'width'));
}

/** Whether a layer is inside an instance below the frame (its match is by component key, not by its own). */
function insideInstance(doc: Document, id: NodeId, frame: NodeId): boolean {
  for (const a of doc.store.ancestors(id)) {
    if (a === frame) return false;
    if (doc.type(a) === 'INSTANCE') return true;
  }
  return false;
}

/** Layers of a frame by their key; built once per frame and step. */
class Keys {
  private readonly cache = new Map<NodeId, Map<string, NodeId>>();
  private readonly doc: Document;
  constructor(doc: Document) {
    this.doc = doc;
  }

  of(frame: NodeId): Map<string, NodeId> {
    let map = this.cache.get(frame);
    if (!map) {
      map = new Map();
      const walk = (id: NodeId) => {
        for (const c of this.doc.children(id)) {
          const k = this.doc.get(c, 'bpKey');
          if (k && !map!.has(k)) map!.set(k, c);
          walk(c);
        }
      };
      walk(frame);
      this.cache.set(frame, map);
    }
    return map;
  }

  forget(frame: NodeId): void {
    this.cache.delete(frame);
  }
}

/** The same layer in another width, or null. */
function counterpart(doc: Document, keys: Keys, id: NodeId, from: NodeId, to: NodeId): NodeId | null {
  if (id === from) return to;
  const k = doc.store.record(id)?.props.bpKey as string | null | undefined;
  if (k) {
    const found = keys.of(to).get(k) ?? null;
    return found && doc.store.isAlive(found) ? found : null;
  }
  const ck = doc.get(id, 'componentKey');
  const parent = doc.store.record(id)?.parent;
  if (!ck || !parent) return null;
  const pp = counterpart(doc, keys, parent, from, to);
  return pp ? (doc.children(pp).find((c) => doc.get(c, 'componentKey') === ck) ?? null) : null;
}

/** The value of a shared property as another width takes it: run sizes and spacing stay each width's own. */
function sharedValue(doc: Document, id: NodeId, key: PropKey): unknown {
  const value = cloneValue(doc.get(id, key));
  if (key === 'textRuns' && Array.isArray(value)) {
    for (const run of value as unknown as { style: Record<string, unknown> }[]) {
      delete run.style.fontSize;
      delete run.style.letterSpacing;
    }
  }
  return value;
}

/** Gives a layer and the layers inside it keys of their own (inside instances — none: they match by component key). */
function rekey(doc: Document, tx: Transaction, id: NodeId, frame: NodeId, taken: Set<string>): void {
  if (!insideInstance(doc, id, frame) && !doc.get(id, 'repeatCopy')) {
    const k = doc.get(id, 'bpKey');
    if (!k || taken.has(k)) tx.set(id, 'bpKey', id);
    taken.add(doc.get(id, 'bpKey')!);
  }
  if (doc.type(id) === 'INSTANCE') return;
  for (const c of doc.children(id)) rekey(doc, tx, c, frame, taken);
}

/**
 * A copy of a layer with its layers (keys and all) under `parent`. A main component is not copied — the copy is
 * its instance; what a repeat group or an instance makes is made again by them.
 */
function cloneInto(doc: Document, tx: Transaction, id: NodeId, parent: NodeId, position: Parameters<Transaction['create']>[3], extra: Partial<NodeProps> = {}): NodeId {
  const record = doc.store.record(id)!;
  const props = cloneValue(record.props) as Record<string, unknown>;
  delete props.deleted;
  if (record.type === 'COMPONENT' || record.type === 'COMPONENT_SET') {
    for (const key of ['componentProps', 'description', 'layerKey'] as const) delete props[key];
    return tx.create('INSTANCE', parent, { ...props, mainComponent: record.type === 'COMPONENT' ? id : (doc.children(id)[0] ?? null), ...extra } as Partial<NodeProps>, position);
  }
  const copy = tx.create(record.type, parent, { ...props, ...extra } as Partial<NodeProps>, position);
  for (const c of doc.children(id)) if (!doc.get(c, 'repeatCopy')) cloneInto(doc, tx, c, copy, { at: 'end' });
  return copy;
}

/** Where a layer added in one width goes in another: after the nearest earlier sibling that is there. */
function placeFor(doc: Document, keys: Keys, id: NodeId, from: NodeId, to: NodeId, parent: NodeId): Parameters<Transaction['create']>[3] {
  const siblings = doc.children(doc.parent(id)!);
  for (let i = siblings.indexOf(id) - 1; i >= 0; i--) {
    const c = counterpart(doc, keys, siblings[i]!, from, to);
    if (c && doc.parent(c) === parent) return { after: c };
  }
  return { at: 'start' };
}

/** After an edit: the other widths get what is one for all, added and deleted layers, moves. */
export function syncBreakpoints(doc: Document, tx: Transaction): void {
  const ch = tx.changes;
  if (ch.isEmpty) return;
  const keys = new Keys(doc);
  const framesOf = new Map<NodeId, NodeId[]>();
  const others = (frame: NodeId) => {
    let list = framesOf.get(frame);
    if (!list) framesOf.set(frame, (list = breakpointFrames(doc, frame).filter((f) => f !== frame)));
    return list;
  };

  // 1. New frames with a width mark: a hand-made copy of a width (the same width id as a frame already there)
  // becomes a screen of its own.
  for (const id of [...ch.created]) {
    if (!doc.store.isAlive(id) || !doc.get(id, 'breakpoint') || !isTop(doc, id)) continue;
    const bp = doc.get(id, 'breakpoint')!;
    const twin = breakpointFrames(doc, id).some((f) => f !== id && !ch.created.has(f) && doc.get(f, 'breakpoint')!.id === bp.id);
    if (twin) {
      tx.set(id, 'breakpoint', null);
      const clear = (n: NodeId) => {
        if (doc.get(n, 'bpKey')) tx.set(n, 'bpKey', null);
        for (const c of doc.children(n)) clear(c);
      };
      clear(id);
    }
  }

  // 2. Layers added in a width (or brought into it from elsewhere): their own keys, then a copy in every other width.
  const arrived: NodeId[] = [];
  for (const id of new Set([...ch.created, ...ch.moved])) {
    if (!doc.store.isAlive(id)) continue;
    const frame = breakpointFrameOf(doc, id);
    if (!frame || frame === id || insideInstance(doc, id, frame) || doc.get(id, 'repeatCopy')) continue;
    // Only the top of what was added; a width frame added with its layers brings them already matched.
    const top = doc.store.ancestors(id).every((a) => !ch.created.has(a));
    if (!top) continue;
    if (ch.moved.has(id) && !ch.created.has(id)) {
      // A move inside the same width is a move (below); from another frame it is an arrival.
      const key = doc.get(id, 'bpKey');
      if (key && keysIn(doc, frame).filter((k) => k === key).length === 1 && others(frame).every((f) => keys.of(f).has(key))) continue;
    }
    arrived.push(id);
  }
  for (const id of arrived) {
    const frame = breakpointFrameOf(doc, id)!;
    const taken = new Set(keysIn(doc, frame, id));
    rekey(doc, tx, id, frame, taken);
    keys.forget(frame);
    for (const other of others(frame)) {
      const parent = counterpart(doc, keys, doc.parent(id)!, frame, other);
      if (!parent || counterpart(doc, keys, id, frame, other)) continue;
      const extra: Partial<NodeProps> = {};
      // On a width's own canvas a layer keeps its share of the width, not its pixels.
      if (parent === other && doc.get(frame, 'layoutMode') === 'NONE') {
        const k = doc.get(other, 'width') / Math.max(1, doc.get(frame, 'width'));
        const room = doc.get(other, 'width');
        const w = Math.min(doc.get(id, 'width'), room);
        if (w !== doc.get(id, 'width')) extra.width = w;
        extra.x = Math.max(0, Math.min(Math.round(doc.get(id, 'x') * k), room - w));
      }
      cloneInto(doc, tx, id, parent, placeFor(doc, keys, id, frame, other, parent), extra);
      keys.forget(other);
    }
  }

  // 3. Deleted and moved layers.
  for (const [id, changed] of [...ch.updated]) {
    if (!changed.has('deleted') || doc.store.isAlive(id)) continue;
    const parent = doc.store.record(id)?.parent;
    if (!parent || !doc.store.isAlive(parent)) continue;
    const frame = breakpointFrameOf(doc, parent);
    if (!frame || insideInstance(doc, id, frame)) continue;
    for (const other of others(frame)) {
      const c = counterpart(doc, keys, id, frame, other);
      if (c && c !== other) tx.delete(c);
    }
  }
  for (const id of ch.moved) {
    if (ch.created.has(id) || arrived.includes(id) || !doc.store.isAlive(id)) continue;
    const frame = breakpointFrameOf(doc, id);
    if (!frame || frame === id || insideInstance(doc, id, frame)) continue;
    for (const other of others(frame)) {
      const c = counterpart(doc, keys, id, frame, other);
      const parent = counterpart(doc, keys, doc.parent(id)!, frame, other);
      if (c && parent && doc.parent(c) !== parent && !doc.store.isAncestorOrSelf(c, parent)) tx.move(c, parent, placeFor(doc, keys, id, frame, other, parent));
    }
  }

  // 4. What is one for all widths.
  for (const [id, changed] of [...ch.updated]) {
    if (!doc.store.isAlive(id) || doc.get(id, 'repeatCopy') || arrived.includes(id)) continue;
    const wanted = [...changed].filter((k) => SHARED_SET.has(k));
    if (wanted.length === 0) continue;
    const frame = breakpointFrameOf(doc, id);
    if (!frame) continue;
    for (const other of others(frame)) {
      const c = counterpart(doc, keys, id, frame, other);
      if (!c || doc.type(c) !== doc.type(id)) continue;
      for (const key of wanted) {
        // A width's own name stays its own («Главная — 390»).
        if (c === other && key === 'name') continue;
        const value = sharedValue(doc, id, key);
        if (!valueEquals(doc.get(c, key), value)) tx.set(c, key, value as never);
      }
    }
  }
}

/** Every key in a frame (repeats included), leaving out the layers under `skip`. */
function keysIn(doc: Document, frame: NodeId, skip?: NodeId): string[] {
  const out: string[] = [];
  const walk = (id: NodeId) => {
    for (const c of doc.children(id)) {
      if (c === skip) continue;
      const k = doc.get(c, 'bpKey');
      if (k) out.push(k);
      walk(c);
    }
  };
  walk(frame);
  return out;
}

const SUFFIX = / — \d+$/;

/** The screen's name without the width («Главная — 390» → «Главная»). */
export const breakpointBase = (name: string) => name.replace(SUFFIX, '');

/**
 * Adds a width to a screen: a copy of `frame` (or of the widest width of its set) `width` px wide, to the right
 * of the set, its layers placed by their constraints and auto layout. A frame not yet in a set starts one.
 * Returns the new frame.
 */
export function addBreakpoint(doc: Document, tx: Transaction, frame: NodeId, width: number): NodeId {
  if (!doc.get(frame, 'breakpoint')) {
    tx.set(frame, 'breakpoint', { set: frame, id: frame });
    const taken = new Set<string>();
    for (const c of doc.children(frame)) rekey(doc, tx, c, frame, taken);
    tx.set(frame, 'name', `${breakpointBase(doc.get(frame, 'name'))} — ${Math.round(doc.get(frame, 'width'))}`);
  }
  const set = breakpointFrames(doc, frame);
  const source = set[0]!;
  // Past everything in the same row (other screens included), so the new width covers nothing.
  const top = doc.get(source, 'y');
  const bottom = top + doc.get(source, 'height');
  const row = doc.children(doc.parent(source)!).filter((c) => doc.get(c, 'y') < bottom && doc.get(c, 'y') + doc.get(c, 'height') > top);
  const right = Math.max(...[...set, ...row].map((f) => doc.get(f, 'x') + doc.get(f, 'width')));
  const name = `${breakpointBase(doc.get(source, 'name'))} — ${Math.round(width)}`;
  const copy = cloneInto(doc, tx, source, doc.parent(source)!, { after: set.reduce((a, f) => (doc.get(f, 'x') > doc.get(a, 'x') ? f : a)) }, { name, x: right + 100, y: doc.get(source, 'y') });
  tx.set(copy, 'breakpoint', { set: doc.get(source, 'breakpoint')!.set, id: copy });
  resizeWithConstraints(doc, tx, copy, width, doc.get(source, 'height'));
  return copy;
}

/** Takes a width out of its set: an ordinary frame again, the others go on without it. */
export function unlinkBreakpoint(doc: Document, tx: Transaction, frame: NodeId): void {
  const clear = (id: NodeId) => {
    if (doc.get(id, 'bpKey')) tx.set(id, 'bpKey', null);
    for (const c of doc.children(id)) clear(c);
  };
  const rest = breakpointFrames(doc, frame).filter((f) => f !== frame);
  tx.set(frame, 'breakpoint', null);
  clear(frame);
  // A set of one is no set.
  if (rest.length === 1) {
    tx.set(rest[0]!, 'breakpoint', null);
    clear(rest[0]!);
  }
}
