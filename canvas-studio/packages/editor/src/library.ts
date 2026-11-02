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

import { base64ToBytes, type Document, type LibraryRef, type NodeId, type NodeProps, type NodeType, type Transaction, type VariableMode } from '#core';
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
export function importFromLibrary(tx: Transaction, doc: Document, payload: LibraryPayload, roots: readonly NodeId[]): boolean {
  const fileId = payload.fileId ?? '';
  const ref: LibraryRef = { fileId, name: payload.name ?? '', publishedAt: payload.publishedAt ?? 0 };
  const units = new Set(neededUnits(payload, roots));
  if (units.size === 0) return false;
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
