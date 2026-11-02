// Operations (FR-DOC-008): every change to a document is one of three
// serializable operations. Local edits, undo/redo, remote edits from other
// participants and offline replays all travel through the same channel.

import type { Timestamp } from './clock.ts';
import type { NodeId } from './ids.ts';
import type { NodeProps, NodeType, PropKey } from './schema.ts';

export interface CreateOp {
  kind: 'create';
  id: NodeId;
  type: NodeType;
  parent: NodeId | null;
  index: string;
  props: Partial<NodeProps>;
  time: Timestamp;
}

export interface SetOp {
  kind: 'set';
  id: NodeId;
  key: PropKey;
  value: unknown;
  time: Timestamp;
}

export interface MoveOp {
  kind: 'move';
  id: NodeId;
  parent: NodeId;
  index: string;
  time: Timestamp;
}

/** An immutable binary resource (image), addressed by the SHA-256 of its bytes (FR-DOC-003). */
export interface BlobOp {
  kind: 'blob';
  hash: string;
  mime: string;
  /** Base64 of the bytes. */
  data: string;
  time: Timestamp;
}

export type Op = CreateOp | SetOp | MoveOp | BlobOp;

/** What changed after applying a batch of operations; consumers use it to invalidate caches. */
export class ChangeSet {
  readonly created = new Set<NodeId>();
  readonly moved = new Set<NodeId>();
  /** Parents a node was moved out of: their auto layout and groups must close the gap (BUG-089). */
  readonly left = new Set<NodeId>();
  readonly updated = new Map<NodeId, Set<PropKey>>();
  /** Hashes of binary resources that became available. */
  readonly blobs = new Set<string>();

  markUpdated(id: NodeId, key: PropKey): void {
    let keys = this.updated.get(id);
    if (!keys) {
      keys = new Set();
      this.updated.set(id, keys);
    }
    keys.add(key);
  }

  get isEmpty(): boolean {
    return this.created.size === 0 && this.moved.size === 0 && this.updated.size === 0 && this.blobs.size === 0;
  }

  /** True when the tree shape or sibling order changed. */
  get structural(): boolean {
    if (this.created.size > 0 || this.moved.size > 0) return true;
    for (const keys of this.updated.values()) if (keys.has('deleted')) return true;
    return false;
  }

  /** Every node touched by this change set. */
  touched(): Set<NodeId> {
    const all = new Set<NodeId>([...this.created, ...this.moved, ...this.left]);
    for (const id of this.updated.keys()) all.add(id);
    return all;
  }

  merge(other: ChangeSet): void {
    for (const id of other.created) this.created.add(id);
    for (const id of other.moved) this.moved.add(id);
    for (const id of other.left) this.left.add(id);
    for (const [id, keys] of other.updated) for (const key of keys) this.markUpdated(id, key);
    for (const hash of other.blobs) this.blobs.add(hash);
  }
}
