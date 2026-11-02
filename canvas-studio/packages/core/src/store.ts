// The document store: an in-memory tree of nodes that applies operations.
// Rules (FR-DOC-008):
//  - properties are last-writer-wins registers ordered by Lamport timestamps;
//  - a node's place in the tree (parent + order key) is one more such register;
//  - a move that would create a cycle or break containment rules is rejected;
//  - create is idempotent, so replaying an operation log is safe.

import { compareTime, ZERO_TIME, type Timestamp } from './clock.ts';
import type { NodeId } from './ids.ts';
import { ChangeSet, type CreateOp, type MoveOp, type Op, type SetOp } from './ops.ts';
import {
  canContain,
  cloneValue,
  defaultProp,
  isPropKey,
  valueEquals,
  type NodeProps,
  type NodeType,
  type PropKey,
} from './schema.ts';

export interface NodeRecord {
  readonly id: NodeId;
  readonly type: NodeType;
  parent: NodeId | null;
  index: string;
  /** Only values that differ from the type defaults. */
  props: Partial<NodeProps>;
  times: Map<PropKey, Timestamp>;
  placeTime: Timestamp;
}

export type ApplyResult = 'applied' | 'stale' | 'rejected' | 'noop';

export class DocumentStore {
  private readonly nodes = new Map<NodeId, NodeRecord>();
  private readonly childSets = new Map<NodeId, Set<NodeId>>();
  private readonly sortedChildren = new Map<NodeId, NodeId[]>();
  private rootNode: NodeId | null = null;
  /** Binary resources by content hash. Immutable, so merging is a plain union. */
  readonly blobs = new Map<string, { mime: string; data: string }>();

  get rootId(): NodeId {
    if (this.rootNode === null) throw new Error('Document has no root');
    return this.rootNode;
  }

  get size(): number {
    return this.nodes.size;
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  record(id: NodeId): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  type(id: NodeId): NodeType {
    return this.require(id).type;
  }

  parent(id: NodeId): NodeId | null {
    return this.require(id).parent;
  }

  /** Current value of a property, falling back to the type default. Treat the result as immutable. */
  get<K extends PropKey>(id: NodeId, key: K): NodeProps[K] {
    const node = this.require(id);
    const value = node.props[key];
    return (value !== undefined ? value : defaultProp(node.type, key)) as NodeProps[K];
  }

  /** Whether the node exists and neither it nor an ancestor is deleted. */
  isAlive(id: NodeId): boolean {
    let current: NodeId | null = id;
    while (current !== null) {
      const node = this.nodes.get(current);
      if (!node || node.props.deleted === true) return false;
      current = node.parent;
    }
    return true;
  }

  /** Live children in paint order (first = bottom-most). */
  children(id: NodeId): readonly NodeId[] {
    let sorted = this.sortedChildren.get(id);
    if (!sorted) {
      const set = this.childSets.get(id);
      sorted = set ? [...set].filter((c) => this.nodes.get(c)?.props.deleted !== true) : [];
      sorted.sort((a, b) => this.compareSiblings(a, b));
      this.sortedChildren.set(id, sorted);
    }
    return sorted;
  }

  /** Whether `ancestor` is `id` itself or one of its ancestors. */
  isAncestorOrSelf(ancestor: NodeId, id: NodeId): boolean {
    let current: NodeId | null = id;
    while (current !== null) {
      if (current === ancestor) return true;
      current = this.nodes.get(current)?.parent ?? null;
    }
    return false;
  }

  /** Ancestors from the parent up to the root. */
  ancestors(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    let current = this.nodes.get(id)?.parent ?? null;
    while (current !== null) {
      out.push(current);
      current = this.nodes.get(current)?.parent ?? null;
    }
    return out;
  }

  /** Depth-first walk over live descendants in paint order. Return false from visit to skip a subtree. */
  walk(id: NodeId, visit: (id: NodeId, depth: number) => boolean | void, depth = 0): void {
    for (const child of this.children(id)) {
      if (visit(child, depth) === false) continue;
      this.walk(child, visit, depth + 1);
    }
  }

  apply(op: Op, changes: ChangeSet): ApplyResult {
    switch (op.kind) {
      case 'create':
        return this.applyCreate(op, changes);
      case 'set':
        return this.applySet(op, changes);
      case 'move':
        return this.applyMove(op, changes);
      case 'blob':
        if (this.blobs.has(op.hash)) return 'noop';
        this.blobs.set(op.hash, { mime: op.mime, data: op.data });
        changes.blobs.add(op.hash);
        return 'applied';
    }
  }

  /** Whether a move is structurally allowed right now (used before emitting the op). */
  canMove(id: NodeId, parent: NodeId): boolean {
    const node = this.nodes.get(id);
    const target = this.nodes.get(parent);
    if (!node || !target) return false;
    if (!canContain(target.type, node.type)) return false;
    return !this.isAncestorOrSelf(id, parent);
  }

  private applyCreate(op: CreateOp, changes: ChangeSet): ApplyResult {
    if (this.nodes.has(op.id)) return 'noop';
    if (op.parent === null) {
      if (op.type !== 'DOCUMENT' || this.rootNode !== null) return 'rejected';
    } else {
      const parent = this.nodes.get(op.parent);
      if (!parent || !canContain(parent.type, op.type)) return 'rejected';
    }
    const props: Partial<NodeProps> = {};
    const times = new Map<PropKey, Timestamp>();
    for (const [key, value] of Object.entries(op.props)) {
      if (!isPropKey(key) || value === undefined) continue;
      if (!valueEquals(value, defaultProp(op.type, key))) {
        (props as Record<string, unknown>)[key] = cloneValue(value);
      }
      times.set(key, op.time);
    }
    const record: NodeRecord = {
      id: op.id,
      type: op.type,
      parent: op.parent,
      index: op.index,
      props,
      times,
      placeTime: op.time,
    };
    this.nodes.set(op.id, record);
    if (op.parent === null) this.rootNode = op.id;
    else this.attach(op.id, op.parent);
    changes.created.add(op.id);
    return 'applied';
  }

  private applySet(op: SetOp, changes: ChangeSet): ApplyResult {
    const node = this.nodes.get(op.id);
    if (!node) return 'rejected';
    if (!isPropKey(op.key)) return 'rejected';
    const previous = node.times.get(op.key) ?? ZERO_TIME;
    if (compareTime(op.time, previous) < 0) return 'stale';
    node.times.set(op.key, op.time);
    const current = node.props[op.key] !== undefined ? node.props[op.key] : defaultProp(node.type, op.key);
    if (valueEquals(current, op.value)) return 'noop';
    if (valueEquals(op.value, defaultProp(node.type, op.key))) {
      delete node.props[op.key];
    } else {
      (node.props as Record<string, unknown>)[op.key] = cloneValue(op.value);
    }
    if (op.key === 'deleted' && node.parent !== null) this.sortedChildren.delete(node.parent);
    changes.markUpdated(op.id, op.key);
    return 'applied';
  }

  private applyMove(op: MoveOp, changes: ChangeSet): ApplyResult {
    const node = this.nodes.get(op.id);
    if (!node || node.parent === null) return 'rejected';
    if (compareTime(op.time, node.placeTime) < 0) return 'stale';
    if (!this.canMove(op.id, op.parent)) return 'rejected';
    node.placeTime = op.time;
    if (node.parent === op.parent && node.index === op.index) return 'noop';
    if (node.parent !== op.parent) changes.left.add(node.parent);
    this.detach(op.id, node.parent);
    node.parent = op.parent;
    node.index = op.index;
    this.attach(op.id, op.parent);
    changes.moved.add(op.id);
    return 'applied';
  }

  private attach(id: NodeId, parent: NodeId): void {
    let set = this.childSets.get(parent);
    if (!set) {
      set = new Set();
      this.childSets.set(parent, set);
    }
    set.add(id);
    this.sortedChildren.delete(parent);
  }

  private detach(id: NodeId, parent: NodeId): void {
    this.childSets.get(parent)?.delete(id);
    this.sortedChildren.delete(parent);
  }

  /** Sibling order: by order key, ties (concurrent inserts) broken by id. */
  private compareSiblings(a: NodeId, b: NodeId): number {
    const ia = this.nodes.get(a)?.index ?? '';
    const ib = this.nodes.get(b)?.index ?? '';
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private require(id: NodeId): NodeRecord {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node ${id}`);
    return node;
  }

  /** All records, including deleted ones (for snapshots). */
  allRecords(): IterableIterator<NodeRecord> {
    return this.nodes.values();
  }
}
