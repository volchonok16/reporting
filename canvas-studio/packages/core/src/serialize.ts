// Open file format (FR-DOC-004): a versioned JSON snapshot of the node tree.
// Deleted nodes are not written. Loading replays the snapshot as create
// operations with zero timestamps, so any later edit wins over loaded values.

import { tr } from './i18n.ts';
import { ZERO_TIME } from './clock.ts';
import { Document } from './document.ts';
import type { NodeId } from './ids.ts';
import { ChangeSet } from './ops.ts';
import { SCHEMA_VERSION, type NodeProps, type NodeType } from './schema.ts';

export const FORMAT_ID = 'canvas-studio/document';

export interface SnapshotNode {
  id: NodeId;
  type: NodeType;
  parent: NodeId | null;
  index: string;
  props: Partial<NodeProps>;
}

export interface Snapshot {
  format: typeof FORMAT_ID;
  schemaVersion: number;
  savedAt: string;
  nodes: SnapshotNode[];
  /** Images by content hash (FR-DOC-003); absent in files without images. */
  blobs?: Record<string, { mime: string; data: string }>;
}

export function toSnapshot(doc: Document): Snapshot {
  const nodes: SnapshotNode[] = [];
  const visit = (id: NodeId) => {
    const record = doc.store.record(id);
    if (!record || record.props.deleted === true) return;
    nodes.push({
      id: record.id,
      type: record.type,
      parent: record.parent,
      index: record.index,
      props: structuredClone(record.props),
    });
    for (const child of doc.store.children(id)) visit(child);
  };
  visit(doc.rootId);
  const snapshot: Snapshot = { format: FORMAT_ID, schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), nodes };
  if (doc.store.blobs.size > 0) snapshot.blobs = Object.fromEntries(doc.store.blobs);
  return snapshot;
}

export function fromSnapshot(snapshot: Snapshot, sessionId?: string): Document {
  if (snapshot.format !== FORMAT_ID) throw new Error(tr('Неизвестный формат файла'));
  if (snapshot.schemaVersion > SCHEMA_VERSION) {
    throw new Error(tr('Файл создан в более новой версии (схема {0}); обновите приложение', snapshot.schemaVersion));
  }
  const doc = new Document(sessionId);
  const changes = new ChangeSet();
  // Parents always precede children in a snapshot written by toSnapshot.
  for (const node of snapshot.nodes) {
    const result = doc.store.apply(
      { kind: 'create', id: node.id, type: node.type, parent: node.parent, index: node.index, props: node.props, time: ZERO_TIME },
      changes,
    );
    if (result === 'rejected') throw new Error(tr('Повреждённый файл: узел {0} не может быть восстановлен', node.id));
  }
  for (const [hash, blob] of Object.entries(snapshot.blobs ?? {})) {
    doc.store.apply({ kind: 'blob', hash, mime: blob.mime, data: blob.data, time: ZERO_TIME }, changes);
  }
  if (!doc.store.has(doc.rootId)) throw new Error(tr('Повреждённый файл: нет корня документа'));
  return doc;
}

export function serialize(doc: Document): string {
  return JSON.stringify(toSnapshot(doc));
}

export function deserialize(text: string, sessionId?: string): Document {
  return fromSnapshot(JSON.parse(text) as Snapshot, sessionId);
}
