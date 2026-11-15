// Open file format (FR-DOC-004): a versioned JSON snapshot of the node tree.
// Deleted nodes are not written. Loading replays the snapshot as create
// operations with zero timestamps, so any later edit wins over loaded values.

import { tr } from './i18n.ts';
import { ZERO_TIME } from './clock.ts';
import { Document } from './document.ts';
import type { NodeId } from './ids.ts';
import { ChangeSet } from './ops.ts';
import { SCHEMA_VERSION, type NodeProps, type NodeType } from './schema.ts';
import { LIMITS, validOp } from './validate.ts';

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
  if (!snapshot || typeof snapshot !== 'object' || snapshot.format !== FORMAT_ID) throw new Error(tr('Неизвестный формат файла'));
  if (!Array.isArray(snapshot.nodes)) throw new Error(tr('Повреждённый файл: нет слоёв'));
  if (snapshot.nodes.length > LIMITS.nodes) throw new Error(tr('Файл слишком большой: больше {0} слоёв', LIMITS.nodes));
  if (snapshot.schemaVersion > SCHEMA_VERSION) {
    throw new Error(tr('Файл создан в более новой версии (схема {0}); обновите приложение', snapshot.schemaVersion));
  }
  const doc = new Document(sessionId);
  const changes = new ChangeSet();
  // Parents always precede children in a snapshot written by toSnapshot.
  for (const node of snapshot.nodes) {
    // Whatever a file holds: a layer of a known type with only the values that fit the schema (validate.ts).
    const op = validOp({ kind: 'create', id: node?.id, type: node?.type, parent: node?.parent, index: node?.index, props: node?.props, time: ZERO_TIME });
    const result = op ? doc.store.apply(op, changes) : 'rejected';
    if (result === 'rejected') throw new Error(tr('Повреждённый файл: узел {0} не может быть восстановлен', String(node?.id).slice(0, 80)));
  }
  const blobs = snapshot.blobs && typeof snapshot.blobs === 'object' ? snapshot.blobs : {};
  for (const [hash, blob] of Object.entries(blobs)) {
    const op = validOp({ kind: 'blob', hash, mime: blob?.mime, data: blob?.data, time: ZERO_TIME });
    if (op) doc.store.apply(op, changes);
  }
  if (!doc.store.has(doc.rootId)) throw new Error(tr('Повреждённый файл: нет корня документа'));
  return doc;
}

export function serialize(doc: Document, options: { anonymous?: boolean } = {}): string {
  const snapshot = toSnapshot(doc);
  return JSON.stringify(options.anonymous ? anonymize(snapshot) : snapshot);
}

/**
 * A copy to give away («Сохранить копию без авторов»): who wrote the stickies and who voted is not in it.
 * Authors are emptied (and the name shown under a sticky); each voter becomes «v1», «v2»… (their sessions too), so the counts and «one person —
 * N votes» stay right; who started a vote is emptied. The snapshot is changed in place.
 */
export function anonymize(snapshot: Snapshot): Snapshot {
  const voters = new Map<string, string>();
  const sessions = new Map<string, string>();
  const pseudonym = (seen: Map<string, string>, prefix: string, who: string) => {
    if (!seen.has(who)) seen.set(who, `${prefix}${seen.size + 1}`);
    return seen.get(who)!;
  };
  for (const node of snapshot.nodes) {
    const board = node.props.board as Record<string, unknown> | null | undefined;
    if (board && board.kind === 'STICKY' && typeof board.author === 'string') board.author = '';
    // The author's name under a sticky is a text layer of its own.
    if (board && board.kind === 'STICKY_AUTHOR') {
      node.props.characters = '';
      delete node.props.textRuns;
    }
    if (board && board.kind === 'VOTE') {
      if (typeof board.voter === 'string') board.voter = pseudonym(voters, 'v', board.voter);
      if (typeof board.session === 'string') board.session = pseudonym(sessions, 's', board.session);
    }
    const voting = node.props.boardVoting as Record<string, unknown> | null | undefined;
    if (voting && typeof voting.by === 'string') voting.by = '';
  }
  return snapshot;
}

export function deserialize(text: string, sessionId?: string): Document {
  return fromSnapshot(JSON.parse(text) as Snapshot, sessionId);
}
