// Copy and paste of node subtrees (FR-CMP-033: everything is copied with its properties).

import { base64ToBytes, bytesToBase64, isAlias, isExpression, valueRefs, type Document, type NodeId, type NodeProps, type NodeType, type Position, type Transaction, type VariableMode, type VariableValue } from '#core';
import { insideInstance, mapReferences, sanitizePasted } from '#components';

export const CLIPBOARD_FORMAT = 'canvas-studio/clipboard';

export interface ClipNode {
  type: NodeType;
  props: Partial<NodeProps>;
  children: ClipNode[];
}

export interface ClipboardData {
  format: typeof CLIPBOARD_FORMAT;
  version: 1;
  nodes: ClipNode[];
  /** Ids of the copied layers in their file: pasting while one of them is selected puts the copy next to it, not inside. */
  sources?: NodeId[];
  /** Styles the copied layers use, so they survive pasting into another file. */
  styles?: { id: NodeId; props: Partial<NodeProps> }[];
  /** Variables the layers and styles use (with alias targets) and their collections. */
  variables?: { id: NodeId; collection: NodeId; props: Partial<NodeProps> }[];
  collections?: { id: NodeId; name: string; modes: VariableMode[] }[];
  /** Картинки слоёв: в другом файле их хешей нет, без байтов вставка становится пустой. */
  blobs?: { hash: string; mime: string; data: string }[];
}

const BINDING_KEYS = ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId'] as const;

function ownProps(doc: Document, id: NodeId): Partial<NodeProps> {
  const props = structuredClone(doc.store.record(id)!.props);
  delete props.deleted;
  return props;
}

function collectStyles(doc: Document, nodes: readonly ClipNode[], out: Map<NodeId, Partial<NodeProps>>): void {
  for (const n of nodes) {
    for (const k of BINDING_KEYS) {
      const id = n.props[k];
      if (id && !out.has(id) && doc.store.isAlive(id) && doc.type(id) === 'STYLE') out.set(id, ownProps(doc, id));
    }
    collectStyles(doc, n.children, out);
  }
}

/** Variables referenced by bindings, plus everything their aliases point to. */
function collectVariables(doc: Document, bindings: Iterable<Record<string, string> | null | undefined>): Set<NodeId> {
  const out = new Set<NodeId>();
  const add = (v: string) => {
    if (out.has(v) || !doc.store.isAlive(v) || doc.type(v) !== 'VARIABLE') return;
    out.add(v);
    for (const value of Object.values(doc.get(v, 'varValues'))) for (const id of valueRefs(value)) add(id);
  };
  for (const b of bindings) for (const v of Object.values(b ?? {})) add(v);
  return out;
}

function* allBindings(nodes: readonly ClipNode[]): Generator<Record<string, string> | null | undefined> {
  for (const n of nodes) {
    yield n.props.boundVariables;
    yield* allBindings(n.children);
  }
}

/**
 * Makes the copied variables available in `doc`: an existing variable keeps its
 * id; otherwise the collection is matched by id or name (or created with the
 * same modes) and the variable by name and type (or created). Returns the id map
 * for variables and collections; mode ids are mapped by id, name, then position.
 */
function resolvePastedVariables(tx: Transaction, doc: Document, data: ClipboardData): Map<string, string> {
  const map = new Map<string, string>();
  const vars = data.variables ?? [];
  if (vars.length === 0) return map;
  const modeMaps = new Map<NodeId, Map<string, string>>();
  const collectionFor = (source: { id: NodeId; name: string; modes: VariableMode[] }): NodeId => {
    if (map.has(source.id)) return map.get(source.id)!;
    let target: NodeId | undefined = doc.store.isAlive(source.id) && doc.type(source.id) === 'VARIABLE_COLLECTION' ? source.id : doc.collections().find((c) => doc.get(c, 'name') === source.name);
    if (!target) target = tx.create('VARIABLE_COLLECTION', doc.rootId, { name: source.name, modes: structuredClone(source.modes) });
    const targetModes = doc.get(target, 'modes');
    const modes = new Map<string, string>();
    source.modes.forEach((m, i) => {
      const hit = targetModes.find((t) => t.id === m.id) ?? targetModes.find((t) => t.name === m.name) ?? targetModes[i] ?? targetModes[0];
      if (hit) modes.set(m.id, hit.id);
    });
    modeMaps.set(target, modes);
    map.set(source.id, target);
    return target;
  };
  const pending: { id: NodeId; target: NodeId; values: Record<string, VariableValue> }[] = [];
  for (const v of vars) {
    if (doc.store.isAlive(v.id) && doc.type(v.id) === 'VARIABLE') continue;
    const source = data.collections?.find((c) => c.id === v.collection);
    if (!source) continue;
    const collection = collectionFor(source);
    const existing = doc.children(collection).find((o) => doc.get(o, 'name') === v.props.name && doc.get(o, 'varType') === (v.props.varType ?? 'COLOR'));
    if (existing) {
      map.set(v.id, existing);
      continue;
    }
    const modes = modeMaps.get(collection)!;
    const values: Record<string, VariableValue> = {};
    for (const [mode, value] of Object.entries(v.props.varValues ?? {})) {
      const m = modes.get(mode);
      if (m) values[m] = value;
    }
    const id = tx.create('VARIABLE', collection, { ...v.props, varValues: values });
    map.set(v.id, id);
    pending.push({ id, target: collection, values });
  }
  // Aliases and expressions of created variables point at the pasted copies.
  for (const p of pending) {
    let changed = false;
    const values = Object.fromEntries(
      Object.entries(p.values).map(([mode, value]) => {
        if (isAlias(value) && map.has(value.id)) {
          changed = true;
          return [mode, { ...value, id: map.get(value.id)! }];
        }
        if (isExpression(value) && valueRefs(value).some((id) => map.has(id))) {
          changed = true;
          return [mode, { ...value, expr: mapReferences(value.expr, (ref) => (ref.startsWith('#') && map.has(ref.slice(1)) ? `#${map.get(ref.slice(1))}` : null)) }];
        }
        return [mode, value];
      }),
    );
    if (changed) tx.set(p.id, 'varValues', values);
  }
  return map;
}

function remapBindings(props: Partial<NodeProps>, map: ReadonlyMap<string, string>): Partial<NodeProps> {
  if (map.size === 0) return props;
  const next = { ...props };
  if (props.boundVariables) next.boundVariables = Object.fromEntries(Object.entries(props.boundVariables).map(([f, v]) => [f, map.get(v) ?? v]));
  if (props.variableModes) next.variableModes = Object.fromEntries(Object.entries(props.variableModes).map(([c, m]) => [map.get(c) ?? c, m]));
  return next;
}

/**
 * Makes the copied styles and variables available in `doc` and rewrites the
 * nodes' bindings: a style that exists keeps its id; otherwise a local style
 * with the same name and kind is reused, or the style is created (as Figma does
 * when pasting between files). Variables follow the same rule.
 */
export function resolvePastedStyles(tx: Transaction, doc: Document, data: ClipboardData): ClipNode[] {
  const map = resolvePastedVariables(tx, doc, data);
  for (const s of data.styles ?? []) {
    if (doc.store.isAlive(s.id) && doc.type(s.id) === 'STYLE') continue;
    const same = doc.styles().find((id) => doc.get(id, 'name') === s.props.name && doc.get(id, 'styleType') === (s.props.styleType ?? 'FILL'));
    map.set(s.id, same ?? tx.create('STYLE', doc.rootId, remapBindings(s.props, map)));
  }
  const rewrite = (n: ClipNode): ClipNode => {
    const props = remapBindings({ ...n.props }, map);
    for (const k of BINDING_KEYS) {
      const id = props[k];
      if (id && map.has(id)) props[k] = map.get(id)!;
    }
    return { ...n, props, children: n.children.map(rewrite) };
  };
  return data.nodes.map(rewrite);
}

export function copySubtree(doc: Document, id: NodeId): ClipNode {
  const record = doc.store.record(id);
  if (!record) throw new Error(`Unknown node ${id}`);
  const props = structuredClone(record.props);
  delete props.deleted;
  return {
    type: record.type,
    props,
    children: doc.children(id).map((child) => copySubtree(doc, child)),
  };
}

function imageHashes(node: ClipNode, out: Set<string>): void {
  for (const key of ['fills', 'strokes'] as const) {
    const paints = node.props[key];
    if (!Array.isArray(paints)) continue;
    for (const paint of paints) {
      if (paint && typeof paint === 'object' && (paint as { type?: string }).type === 'IMAGE') {
        const hash = (paint as { imageHash?: string }).imageHash;
        if (hash) out.add(hash);
      }
    }
  }
  for (const child of node.children) imageHashes(child, out);
}

/** Кладёт байты картинок в файл, куда вставляют, если их там ещё нет. */
export function restoreClipboardBlobs(tx: Transaction, doc: Document, data: ClipboardData): void {
  for (const blob of data.blobs ?? []) {
    if (doc.store.blobs.has(blob.hash)) continue;
    tx.addBlob(base64ToBytes(blob.data), blob.mime);
  }
}

export function toClipboard(doc: Document, ids: readonly NodeId[]): ClipboardData {
  const nodes = ids.map((id) => copySubtree(doc, id));
  const hashes = new Set<string>();
  for (const node of nodes) imageHashes(node, hashes);
  const blobs = [...hashes].flatMap((hash) => {
    const blob = doc.store.blobs.get(hash);
    return blob ? [{ hash, mime: blob.mime, data: blob.data }] : [];
  });
  const styles = new Map<NodeId, Partial<NodeProps>>();
  collectStyles(doc, nodes, styles);
  const variables = collectVariables(doc, [...allBindings(nodes), ...[...styles.values()].map((p) => p.boundVariables)]);
  const collections = new Set([...variables].map((v) => doc.parent(v)!));
  return {
    format: CLIPBOARD_FORMAT,
    version: 1,
    nodes,
    sources: [...ids],
    ...(styles.size > 0 ? { styles: [...styles].map(([id, props]) => ({ id, props })) } : {}),
    ...(variables.size > 0
      ? {
          variables: [...variables].map((id) => ({ id, collection: doc.parent(id)!, props: ownProps(doc, id) })),
          collections: [...collections].map((id) => ({ id, name: doc.get(id, 'name'), modes: doc.get(id, 'modes') })),
        }
      : {}),
    ...(blobs.length > 0 ? { blobs } : {}),
  };
}

// The system clipboard gets two flavours, as Figma does: HTML that carries the
// layers in an attribute (other apps paste nothing visible from it) and plain
// text with what the layers say — so a chat or a notepad never shows JSON.
const HTML_MARK = 'data-canvas-studio';

/** HTML flavour: the layers, base64 in an attribute of an empty element. */
export function clipboardHtml(json: string): string {
  return `<meta charset="utf-8"><span ${HTML_MARK}="${bytesToBase64(new TextEncoder().encode(json))}"></span>`;
}

/** Plain text flavour: the text of the copied text layers, else their names. */
export function clipboardPlainText(doc: Document, ids: readonly NodeId[]): string {
  const texts: string[] = [];
  const walk = (id: NodeId) => {
    if (doc.type(id) === 'TEXT') {
      const t = doc.get(id, 'characters').trim();
      if (t) texts.push(t);
    }
    for (const c of doc.children(id)) walk(c);
  };
  ids.forEach(walk);
  return texts.length ? texts.join('\n') : ids.map((id) => doc.get(id, 'name')).join('\n');
}

/** Copied layers from either flavour: our HTML, or JSON text (older copies, other tabs). */
export function parseClipboard(text: string): ClipboardData | null {
  const marked = text.includes(HTML_MARK) ? new RegExp(`${HTML_MARK}="([A-Za-z0-9+/=]+)"`).exec(text) : null;
  if (marked) {
    try {
      return parseClipboard(new TextDecoder().decode(base64ToBytes(marked[1]!)));
    } catch {
      return null;
    }
  }
  try {
    const data = JSON.parse(text) as ClipboardData;
    return data && data.format === CLIPBOARD_FORMAT && Array.isArray(data.nodes) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Recreates a copied subtree under `parent` with fresh ids. Returns the new root id.
 * Instance links are kept for copies of whole instances and dropped for loose layers.
 */
export function pasteSubtree(tx: Transaction, node: ClipNode, parent: NodeId, position: Position = { at: 'end' }, doc?: Document, inside?: boolean): NodeId {
  const within = inside ?? (doc ? insideInstance(doc, parent) || doc.type(parent) === 'INSTANCE' : false);
  const id = tx.create(node.type, parent, sanitizePasted(node.props, node.type, within), position);
  for (const child of node.children) pasteSubtree(tx, child, id, { at: 'end' }, doc, within || node.type === 'INSTANCE');
  return id;
}
