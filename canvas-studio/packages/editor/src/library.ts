// Libraries (FR-LIB): the components of one file used in others.
//
// Publishing takes every component and component set of the file (with the
// components their layers are copies of, the styles and variables they use and
// their images) into a payload the server keeps next to the file. A file that
// uses a component of the library gets it on a hidden page ("libraryPage"),
// with the very same node ids: copies inside it, keys of instance layers and
// overrides keep working as they are, and taking a newer publication simply
// writes the new values over the old ones (revive), deleting what the library
// no longer has. One undo step brings the old version back.
//
// Library components are not edited in the file that uses them: "go to the
// component" opens the library itself.

import { base64ToBytes, BASE_DEFAULTS, tr, type Document, type LibraryRef, type NodeId, type NodeProps, type NodeType, type PropKey, type Transaction, type VariableMode } from '#core';
import { applyStyleValues, type StyleBinding } from '#components';
import { freeSpotOnBoard } from './board.ts';
import { toClipboard } from './clipboard.ts';
import type { Editor } from './editor.ts';

export interface LibraryNode {
  id: NodeId;
  type: NodeType;
  /** Parent in the library file; null — a top-level component or set (goes to the hidden page). */
  parent: NodeId | null;
  index: string;
  props: Partial<NodeProps>;
}

export interface LibraryComponent {
  /** The component or set offered (the root of a unit). */
  id: NodeId;
  /** Component to place: the first variant of a set. */
  component: NodeId;
  name: string;
  description: string;
  variants: number;
  /** Page of the library it is on (for grouping). */
  page: string;
  /** Small PNG picture (data URL), made when publishing. */
  thumb?: string;
}

export interface LibraryPayload {
  version: 1;
  /** Set by the server. */
  fileId?: string;
  name?: string;
  publishedAt?: number;
  components: LibraryComponent[];
  /** Every node of every unit (offered ones and those they depend on), parents before children. */
  nodes: LibraryNode[];
  styles: { id: NodeId; props: Partial<NodeProps> }[];
  variables: { id: NodeId; collection: NodeId; props: Partial<NodeProps> }[];
  collections: { id: NodeId; name: string; modes: VariableMode[] }[];
  blobs: { hash: string; mime: string; data: string }[];
}

/** The unit a component belongs to: its set for a variant, else itself. */
function unitOf(doc: Document, component: NodeId): NodeId {
  const parent = doc.parent(component);
  return parent && doc.type(parent) === 'COMPONENT_SET' ? parent : component;
}

function isUnit(doc: Document, id: NodeId): boolean {
  const t = doc.type(id);
  return t === 'COMPONENT_SET' || (t === 'COMPONENT' && doc.type(doc.parent(id)!) !== 'COMPONENT_SET');
}

/** Components of the file's own pages (not those taken from other libraries), as units. */
export function ownUnits(doc: Document): NodeId[] {
  const out: NodeId[] = [];
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      if (isUnit(doc, id) && !doc.get(id, 'libraryRef')) out.push(id);
      // Definitions are never inside instances or other components.
      const t = doc.type(id);
      return t !== 'INSTANCE' && t !== 'COMPONENT';
    });
  }
  return out;
}

/** Units the given ones depend on through copies inside them (closure, the given ones first). */
function withDependencies(doc: Document, units: readonly NodeId[]): NodeId[] {
  const out = new Set<NodeId>(units);
  const queue = [...units];
  while (queue.length) {
    const unit = queue.shift()!;
    doc.store.walk(unit, (id) => {
      if (doc.type(id) === 'INSTANCE') {
        const main = doc.get(id, 'mainComponent');
        if (main && doc.store.isAlive(main)) {
          const u = unitOf(doc, main);
          if (!out.has(u)) {
            out.add(u);
            queue.push(u);
          }
        }
      }
      return true;
    });
  }
  return [...out];
}

function nodesOf(doc: Document, unit: NodeId): LibraryNode[] {
  const out: LibraryNode[] = [];
  const visit = (id: NodeId, parent: NodeId | null) => {
    const record = doc.store.record(id)!;
    const props = structuredClone(record.props);
    delete props.deleted;
    out.push({ id, type: record.type, parent, index: record.index ?? 'a0', props });
    for (const child of doc.children(id)) visit(child, id);
  };
  visit(unit, null);
  return out;
}

/** Image hashes used by paints in the nodes. */
function imageHashes(nodes: readonly LibraryNode[]): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) {
    for (const key of ['fills', 'strokes'] as const) {
      for (const p of n.props[key] ?? []) if (p.type === 'IMAGE') out.add(p.imageHash);
    }
  }
  return out;
}

/**
 * What a library publication carries. `thumb` draws a component's picture
 * (the editor passes a canvas renderer; tests do without).
 */
export function buildLibrary(doc: Document, thumb?: (unit: NodeId) => string | undefined): LibraryPayload {
  const offered = ownUnits(doc);
  const units = withDependencies(doc, offered);
  const nodes = units.flatMap((u) => nodesOf(doc, u));
  const clip = toClipboard(doc, units);
  const blobs = [...imageHashes(nodes)].flatMap((hash) => {
    const blob = doc.store.blobs.get(hash);
    return blob ? [{ hash, mime: blob.mime, data: blob.data }] : [];
  });
  return {
    version: 1,
    components: offered.map((id) => {
      const set = doc.type(id) === 'COMPONENT_SET';
      return {
        id,
        component: set ? (doc.children(id).find((c) => doc.type(c) === 'COMPONENT') ?? id) : id,
        name: String(doc.get(id, 'name')),
        description: String(doc.get(id, 'description') ?? ''),
        variants: set ? doc.children(id).length : 0,
        page: String(doc.get(doc.pageOf(id)!, 'name')),
        ...(thumb ? { thumb: thumb(id) } : {}),
      };
    }),
    nodes,
    styles: clip.styles ?? [],
    variables: clip.variables ?? [],
    collections: clip.collections ?? [],
    blobs,
  };
}

/** The hidden page for library components, made when first needed. */
function libraryPage(tx: Transaction, doc: Document): NodeId {
  return doc.libraryPage() ?? tx.create('PAGE', doc.rootId, { name: 'Библиотеки', libraryPage: true });
}

/** Units of the payload that `roots` need (themselves and what copies inside them point to). */
function neededUnits(payload: LibraryPayload, roots: readonly NodeId[]): NodeId[] {
  const unitOfNode = new Map<NodeId, NodeId>();
  const byUnit = new Map<NodeId, LibraryNode[]>();
  let current: NodeId | null = null;
  for (const n of payload.nodes) {
    if (n.parent === null) current = n.id;
    unitOfNode.set(n.id, current!);
    byUnit.set(current!, [...(byUnit.get(current!) ?? []), n]);
  }
  const out = new Set<NodeId>();
  const queue = roots.filter((r) => byUnit.has(r));
  for (const r of queue) out.add(r);
  while (queue.length) {
    for (const n of byUnit.get(queue.shift()!) ?? []) {
      const main = n.type === 'INSTANCE' ? n.props.mainComponent : null;
      const u = main ? unitOfNode.get(main) : undefined;
      if (u && !out.has(u)) {
        out.add(u);
        queue.push(u);
      }
    }
  }
  return [...out];
}

/**
 * Takes components of a library into the file (or brings them up to date):
 * `roots` — units to take; with dependencies. Styles, variables and images
 * they use come too. Returns false when nothing could be taken.
 */
export function importFromLibrary(tx: Transaction, doc: Document, payload: LibraryPayload, roots: readonly NodeId[], withAssets = false): boolean {
  const fileId = payload.fileId ?? '';
  const ref: LibraryRef = { fileId, name: payload.name ?? '', publishedAt: payload.publishedAt ?? 0 };
  const units = new Set(neededUnits(payload, roots));
  // `withAssets`: styles and variables come even when no component is taken (a library swap).
  if (units.size === 0 && !withAssets) return false;
  for (const b of payload.blobs) if (!doc.store.blobs.has(b.hash)) tx.addBlob(base64ToBytes(b.data), b.mime);
  // Variables and styles first: layers point to them. Ones already here keep their place in the lists.
  const at = (id: NodeId, parent: NodeId) => doc.store.record(id)?.index ?? doc.indexFor(parent);
  for (const c of payload.collections) tx.revive(c.id, 'VARIABLE_COLLECTION', doc.rootId, at(c.id, doc.rootId), { name: c.name, modes: c.modes, libraryRef: ref });
  for (const v of payload.variables) tx.revive(v.id, 'VARIABLE', v.collection, at(v.id, v.collection), v.props);
  for (const s of payload.styles) tx.revive(s.id, 'STYLE', doc.rootId, at(s.id, doc.rootId), { ...s.props, libraryRef: ref });
  const page = libraryPage(tx, doc);
  let unit: NodeId | null = null;
  const kept = new Map<NodeId, Set<NodeId>>();
  for (const n of payload.nodes) {
    if (n.parent === null) unit = n.id;
    if (!unit || !units.has(unit)) continue;
    if (!kept.has(unit)) kept.set(unit, new Set());
    kept.get(unit)!.add(n.id);
    const parent = n.parent ?? page;
    const props = n.parent === null ? { ...n.props, libraryRef: ref } : n.props;
    // Creates it, or writes the library's values over it (and moves it where the library has it).
    tx.revive(n.id, n.type, parent, n.index, props);
  }
  // What the library no longer has.
  for (const [u, ids] of kept) {
    const stale: NodeId[] = [];
    doc.store.walk(u, (id) => {
      if (!ids.has(id)) {
        stale.push(id);
        return false;
      }
      return true;
    });
    for (const id of stale) tx.delete(id);
  }
  return true;
}

/** Library units taken into the file, by library file id. */
export function takenUnits(doc: Document): Map<string, { id: NodeId; ref: LibraryRef }[]> {
  const out = new Map<string, { id: NodeId; ref: LibraryRef }[]>();
  const page = doc.libraryPage();
  if (!page) return out;
  for (const id of doc.children(page)) {
    const ref = doc.get(id, 'libraryRef');
    if (!ref || !doc.store.isAlive(id)) continue;
    out.set(ref.fileId, [...(out.get(ref.fileId) ?? []), { id, ref }]);
  }
  return out;
}

/** The library a node of the file comes from (the component of a copy, its set), or null. */
export function libraryOf(doc: Document, id: NodeId): LibraryRef | null {
  let current: NodeId | null = id;
  while (current) {
    const ref = doc.get(current, 'libraryRef');
    if (ref) return ref;
    const parent: NodeId | null = doc.parent(current);
    if (!parent || doc.type(parent) === 'PAGE') return null;
    current = parent;
  }
  return null;
}

/** Places a copy of a library component in the middle of the view (taking it into the file first). */
export function placeFromLibrary(editor: Editor, payload: LibraryPayload, entry: LibraryComponent, at?: { x: number; y: number }): NodeId | null {
  // Taken once; later publications come with "Update".
  if (!editor.doc.store.isAlive(entry.component)) editor.commit(`Компонент из библиотеки «${payload.name ?? ''}»`, (tx) => importFromLibrary(tx, editor.doc, payload, [entry.id]));
  if (!editor.doc.store.isAlive(entry.component)) return null;
  const w = editor.doc.get(entry.component, 'width');
  const h = editor.doc.get(entry.component, 'height');
  const center = at ?? editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
  // On a board (no point given) — beside what is there, not over it.
  const spot = !at && editor.isBoardFile() ? freeSpotOnBoard(editor, center, w, h) : { x: center.x - w / 2, y: center.y - h / 2 };
  return editor.placeInstance(entry.component, { x: Math.round(spot.x), y: Math.round(spot.y) });
}

/** Brings every component taken from a library up to its newest publication. Returns how many were updated. */
export function updateFromLibrary(editor: Editor, payload: LibraryPayload): number {
  const taken = takenUnits(editor.doc).get(payload.fileId ?? '') ?? [];
  const roots = taken.map((t) => t.id).filter((id) => payload.nodes.some((n) => n.id === id && n.parent === null));
  if (roots.length === 0) return 0;
  editor.commit(`Обновить библиотеку «${payload.name ?? ''}»`, (tx) => importFromLibrary(tx, editor.doc, payload, roots));
  return roots.length;
}

// ---------- Swapping a library for another (step 6, Figma's «Swap library») ----------
//
// Everything the file uses from one library is pointed at the same-named things of another: copies get the
// component of the same name (a variant — the same «axis=value» pairs), layers the style of the same kind and
// name, bindings the variable of the same collection and name, frames the mode of the same name. Overrides of
// the copies stay: synchronisation matches layers by key, then by a unique name. What the old library gave and
// nothing uses any more leaves the file. One undo step.

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
/** A variant name as its «axis=value» pairs: order, case and spaces do not matter. */
const variantKey = (s: string) =>
  s
    .split(',')
    .map((p) => p.split('=').map(norm).join('='))
    .sort()
    .join(',');

/** Properties that point at components, styles, variables or collections by id. */
const REF_PROPS = ['mainComponent', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId', 'boundVariables', 'propValues', 'componentProps', 'varValues', 'varOverrides', 'reactions', 'extendsCollection'] as const satisfies readonly PropKey[];
const STYLE_PROPS = new Set<string>(['fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId']);
const ID = /"([0-9a-z]+:\d+)"/g;
const EXPR_ID = /\{\s*#([0-9a-z]+:\d+)\s*\}/g;

/** A value with the ids of `ids` replaced (a JSON string: ids are «session:counter», whole strings only). */
function replaceIds<T>(value: T, ids: ReadonlyMap<NodeId, NodeId>): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return (ids.get(value) ?? value) as T;
  const json = JSON.stringify(value);
  const out = json.replace(ID, (m, id: string) => (ids.has(id) ? `"${ids.get(id)}"` : m)).replace(EXPR_ID, (m, id: string) => (ids.has(id) ? `{#${ids.get(id)}}` : m));
  return out === json ? value : (JSON.parse(out) as T);
}

export interface LibrarySwapPlan {
  fromFileId: string;
  /** Old id → new id: components (and sets), styles, variables, collections. */
  ids: Map<NodeId, NodeId>;
  /** Old collection → (old mode id → new mode id). */
  modes: Map<NodeId, Map<string, string>>;
  /** Units of the new library to take in. */
  units: NodeId[];
  /** What is used in the file and found in the new library / used and not found. */
  found: { components: number; styles: number; variables: number };
  /** Copies in the file that will show the new library's components. */
  instances: number;
  missing: string[];
}

/** The old library's things in the file: its units (and every node in them), styles, collections and variables. */
function libraryThings(doc: Document, fileId: string): { units: NodeId[]; unitNodes: Set<NodeId>; styles: NodeId[]; collections: NodeId[]; variables: NodeId[] } {
  const units = (takenUnits(doc).get(fileId) ?? []).map((t) => t.id);
  const unitNodes = new Set<NodeId>();
  for (const u of units) {
    unitNodes.add(u);
    doc.store.walk(u, (id) => (unitNodes.add(id), true));
  }
  const fromHere = (id: NodeId) => doc.get(id, 'libraryRef')?.fileId === fileId;
  const styles = [...doc.children(doc.rootId)].filter((id) => doc.type(id) === 'STYLE' && fromHere(id));
  const collections = doc.collections().filter(fromHere);
  const variables = collections.flatMap((c) => [...doc.children(c)]);
  return { units, unitNodes, styles, collections, variables };
}

/** Ids every node outside `skip` refers to (through REF_PROPS and variable modes). */
function referencedIds(doc: Document, skip: ReadonlySet<NodeId>): Set<string> {
  const out = new Set<string>();
  doc.store.walk(doc.rootId, (id) => {
    if (skip.has(id)) return false;
    // A layer of a copy takes its values from the source, save what was changed in the copy.
    const own = doc.get(id, 'componentKey') === null ? null : new Set<string>(doc.get(id, 'overrides'));
    for (const k of REF_PROPS) {
      if (own && !own.has(k)) continue;
      const v = doc.get(id, k);
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      const json = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
      for (const m of json.matchAll(ID)) out.add(m[1]!);
      for (const m of json.matchAll(EXPR_ID)) out.add(m[1]!);
    }
    if (!own || own.has('variableModes')) for (const c of Object.keys(doc.get(id, 'variableModes') ?? {})) out.add(c);
    return true;
  });
  return out;
}

/** What swapping library `fromFileId` for `to` would do (nothing is changed). */
export function planLibrarySwap(doc: Document, fromFileId: string, to: LibraryPayload): LibrarySwapPlan {
  const old = libraryThings(doc, fromFileId);
  const skip = new Set([...old.unitNodes, ...old.styles, ...old.collections, ...old.variables]);
  const used = referencedIds(doc, skip);
  const ids = new Map<NodeId, NodeId>();
  const modes = new Map<NodeId, Map<string, string>>();
  const missing: string[] = [];
  const found = { components: 0, styles: 0, variables: 0 };
  // Components: by name; variants of a set by their «axis=value» pairs.
  const tops = to.nodes.filter((n) => n.parent === null);
  const childrenOf = (id: NodeId) => to.nodes.filter((n) => n.parent === id && n.type === 'COMPONENT');
  const topNamed = (type: NodeType, name: string) => tops.find((n) => n.type === type && norm(String(n.props.name ?? '')) === norm(name));
  const newUnits = new Set<NodeId>();
  for (const u of old.units) {
    const name = doc.get(u, 'name');
    const comps = doc.type(u) === 'COMPONENT_SET' ? [...doc.children(u)].filter((c) => doc.type(c) === 'COMPONENT') : [u];
    const set = doc.type(u) === 'COMPONENT_SET' ? topNamed('COMPONENT_SET', name) : undefined;
    const single = doc.type(u) === 'COMPONENT' ? (topNamed('COMPONENT', name) ?? topNamed('COMPONENT_SET', name)) : undefined;
    for (const c of comps) {
      let target: NodeId | undefined;
      if (set) target = childrenOf(set.id).find((v) => variantKey(String(v.props.name ?? '')) === variantKey(doc.get(c, 'name')))?.id;
      else if (single?.type === 'COMPONENT') target = single.id;
      else if (single) target = childrenOf(single.id)[0]?.id;
      const isUsed = used.has(c);
      if (target) {
        ids.set(c, target);
        newUnits.add((set ?? single)!.id);
        if (isUsed) found.components++;
      } else if (isUsed) missing.push(doc.type(u) === 'COMPONENT_SET' ? `${name} / ${doc.get(c, 'name')}` : name);
    }
    if (set) ids.set(u, set.id);
  }
  // Styles: the same kind and name.
  for (const st of old.styles) {
    const match = to.styles.find((s) => (s.props.styleType ?? BASE_DEFAULTS.styleType) === doc.get(st, 'styleType') && norm(String(s.props.name ?? '')) === norm(doc.get(st, 'name')));
    if (match) {
      ids.set(st, match.id);
      if (used.has(st)) found.styles++;
    } else if (used.has(st)) missing.push(doc.get(st, 'name'));
  }
  // Variables: the collection of the same name, the variable of the same name and type; modes by name.
  for (const col of old.collections) {
    const match = to.collections.find((c) => norm(c.name) === norm(doc.get(col, 'name')));
    if (!match) {
      for (const v of doc.children(col)) if (used.has(v)) missing.push(`${doc.get(col, 'name')} / ${doc.get(v, 'name')}`);
      continue;
    }
    ids.set(col, match.id);
    const modeMap = new Map<string, string>();
    for (const m of doc.get(col, 'modes')) {
      const nm = match.modes.find((x) => norm(x.name) === norm(m.name));
      if (nm) modeMap.set(m.id, nm.id);
    }
    modes.set(col, modeMap);
    for (const v of doc.children(col)) {
      const nv = to.variables.find((x) => x.collection === match.id && norm(String(x.props.name ?? '')) === norm(doc.get(v, 'name')) && (x.props.varType ?? BASE_DEFAULTS.varType) === doc.get(v, 'varType'));
      if (nv) {
        ids.set(v, nv.id);
        if (used.has(v)) found.variables++;
      } else if (used.has(v)) missing.push(`${doc.get(col, 'name')} / ${doc.get(v, 'name')}`);
    }
  }
  let instances = 0;
  doc.store.walk(doc.rootId, (id) => {
    if (skip.has(id)) return false;
    if (doc.type(id) === 'INSTANCE' && doc.get(id, 'componentKey') === null && ids.has(doc.get(id, 'mainComponent') ?? '')) instances++;
    return true;
  });
  return { fromFileId, ids, modes, units: [...newUnits], found, instances, missing };
}

/** Swaps the library (one undo step). Returns how many layers now point at the new library. */
export function swapLibrary(editor: Editor, plan: LibrarySwapPlan, to: LibraryPayload): number {
  let changed = 0;
  editor.commit(tr('Заменить библиотеку «{0}»', to.name ?? ''), (tx) => (changed = relink(tx, editor.doc, plan, to, 'swap')));
  return changed;
}

/**
 * Points what the file uses from `plan.fromFileId` at `to` by `plan.ids` (inside the caller's transaction).
 * `swap` — the new library replaces the old one in the list, and unused old parts leave; `move` — the old library
 * stays linked (other components may still come from it), and only the moved parts leave once unused.
 */
function relink(tx: Transaction, doc: Document, plan: LibrarySwapPlan, to: LibraryPayload, mode: 'swap' | 'move'): number {
  const toId = to.fileId ?? '';
  let changed = 0;
  importFromLibrary(tx, doc, to, plan.units, true);
  const old = libraryThings(doc, plan.fromFileId);
  // A library made as a copy of the old one has the same ids: those nodes are the new library's now.
  const fresh = new Set<NodeId>([...to.nodes.map((n) => n.id), ...to.styles.map((s) => s.id), ...to.variables.map((v) => v.id), ...to.collections.map((c) => c.id)]);
  const skip = new Set([...old.unitNodes, ...old.styles, ...old.collections, ...old.variables].filter((id) => !fresh.has(id)));
  const newUnitNodes = new Set<NodeId>();
  for (const u of plan.units) {
    if (!doc.store.isAlive(u)) continue;
    newUnitNodes.add(u);
    doc.store.walk(u, (id) => (newUnitNodes.add(id), true));
  }
  doc.store.walk(doc.rootId, (id) => {
    if (skip.has(id) || newUnitNodes.has(id)) return false;
    // Layers of copies follow their source, unless the user changed that property in the copy.
    const own = doc.get(id, 'componentKey') === null ? null : new Set(doc.get(id, 'overrides'));
    let touched = false;
    for (const k of REF_PROPS) {
      if (own && !own.has(k)) continue;
      const v = doc.get(id, k);
      const next = replaceIds(v, plan.ids);
      if (next === v) continue;
      tx.set(id, k, next as never);
      touched = true;
      if (STYLE_PROPS.has(k) && typeof next === 'string') applyStyleValues(doc, tx, id, k as StyleBinding, next);
    }
    const vm = doc.get(id, 'variableModes');
    if (vm && (!own || own.has('variableModes'))) {
      const next: Record<string, string> = {};
      let differs = false;
      for (const [c, m] of Object.entries(vm)) {
        const nc = plan.ids.get(c);
        const nm = nc ? plan.modes.get(c)?.get(m) : undefined;
        if (nc && nm) {
          next[nc] = nm;
          differs = differs || nc !== c || nm !== m;
        } else next[c] = m;
      }
      if (differs) {
        tx.set(id, 'variableModes', next);
        touched = true;
      }
    }
    if (touched) changed++;
    return true;
  });
  // The list of linked libraries.
  const links = doc.get(doc.rootId, 'libraries') ?? [];
  if (mode === 'swap') tx.set(doc.rootId, 'libraries', [...links.filter((l) => l.fileId !== plan.fromFileId && l.fileId !== toId), { fileId: toId, name: to.name ?? '' }]);
  else if (!links.some((l) => l.fileId === toId)) tx.set(doc.rootId, 'libraries', [...links, { fileId: toId, name: to.name ?? '' }]);
  // What the old library gave and nothing uses any more (on a move — only what moved).
  const may = (id: NodeId) => !fresh.has(id) && (mode === 'swap' || plan.ids.has(id));
  const used = referencedIds(doc, skip);
  for (const u of old.units) {
    if (!may(u)) continue;
    // `walk` visits the descendants; the unit itself counts too.
    const nodes: NodeId[] = [u];
    doc.store.walk(u, (id) => (nodes.push(id), true));
    if (!nodes.some((id) => used.has(id))) tx.delete(u);
  }
  for (const st of old.styles) if (may(st) && !used.has(st)) tx.delete(st);
  if (mode === 'swap') for (const c of old.collections) if (!fresh.has(c) && !used.has(c) && ![...doc.children(c)].some((v) => used.has(v))) tx.delete(c);
  return changed;
}

// ---------- Following components and styles moved to another library (step 6) ----------
//
// A component (set, style) cut from library A and pasted into library B carries `movedFrom: {A, its id}`. When A
// is published without it, a file using it from A finds it among the other libraries by that mark, and its
// copies and layers are pointed at B — with their own changes (layers match by key, then by a unique name).

export interface LibraryMove {
  to: LibraryPayload;
  plan: LibrarySwapPlan;
}

/**
 * Where the parts of library `from` (its newest publication) that the file uses but `from` no longer has went:
 * by the marks of `others`. Empty when nothing moved.
 */
export function planMoves(doc: Document, from: LibraryPayload, others: readonly LibraryPayload[]): LibraryMove[] {
  const fromId = from.fileId ?? '';
  const old = libraryThings(doc, fromId);
  const still = new Set<NodeId>([...from.nodes.map((n) => n.id), ...from.styles.map((st) => st.id)]);
  const gone = new Set([...old.unitNodes, ...old.styles].filter((id) => !still.has(id)));
  if (gone.size === 0) return [];
  const skip = new Set([...old.unitNodes, ...old.styles, ...old.collections, ...old.variables]);
  const used = referencedIds(doc, skip);
  const out: LibraryMove[] = [];
  for (const to of others) {
    if (!to.fileId || to.fileId === fromId) continue;
    const ids = new Map<NodeId, NodeId>();
    const units = new Set<NodeId>();
    let unit: NodeId | null = null;
    for (const n of to.nodes) {
      if (n.parent === null) unit = n.id;
      const m = n.props.movedFrom;
      if (m?.fileId === fromId && gone.has(m.id)) {
        ids.set(m.id, n.id);
        if (unit) units.add(unit);
      }
    }
    for (const st of to.styles) {
      const m = st.props.movedFrom;
      if (m?.fileId === fromId && gone.has(m.id)) ids.set(m.id, st.id);
    }
    if (ids.size === 0) continue;
    const isComp = (id: NodeId) => doc.store.has(id) && doc.type(id) === 'COMPONENT';
    let instances = 0;
    doc.store.walk(doc.rootId, (id) => {
      if (skip.has(id)) return false;
      if (doc.type(id) === 'INSTANCE' && doc.get(id, 'componentKey') === null && ids.has(doc.get(id, 'mainComponent') ?? '')) instances++;
      return true;
    });
    const found = { components: [...ids.keys()].filter((id) => isComp(id) && used.has(id)).length, styles: [...ids.keys()].filter((id) => doc.store.has(id) && doc.type(id) === 'STYLE' && used.has(id)).length, variables: 0 };
    out.push({ to, plan: { fromFileId: fromId, ids, modes: new Map(), units: [...units], found, instances, missing: [] } });
  }
  return out;
}

/** Points the file at the new homes of moved parts (one undo step). Returns how many layers changed. */
export function followMoves(editor: Editor, moves: readonly LibraryMove[]): number {
  if (moves.length === 0) return 0;
  let changed = 0;
  editor.commit(tr('Компоненты переехали в другую библиотеку'), (tx) => {
    for (const m of moves) changed += relink(tx, editor.doc, m.plan, m.to, 'move');
  });
  return changed;
}
