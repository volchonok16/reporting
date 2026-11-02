// Document: the store plus transactions, local undo/redo and change events.
//
// - Every edit happens inside a transaction; one transaction = one undo step (FR-DOC-009).
// - Undo is local to the user: it only reverts this session's own steps (FR-DOC-010).
// - A step whose target was changed afterwards by someone else is skipped, and the
//   caller learns how many steps were skipped (FR-DOC-011).
// - Continuous gestures (dragging, resizing) are applied live but recorded as one step.

import { tr } from './i18n.ts';
import { bytesToBase64, sha256 } from './hash.ts';
import { LamportClock } from './clock.ts';
import { keyBetween } from './fractional-index.ts';
import { IdGenerator, type NodeId } from './ids.ts';
import { ChangeSet, type Op } from './ops.ts';
import { cloneValue, valueEquals, type NodeProps, type NodeType, type PropKey } from './schema.ts';
import { DocumentStore } from './store.ts';

export type ChangeSource = 'local' | 'remote' | 'undo' | 'redo' | 'load';

export type Position =
  | { at: 'end' }
  | { at: 'start' }
  | { before: NodeId }
  | { after: NodeId }
  | { index: number }
  /** A precomputed fractional order key (bulk inserts compute keys in sequence instead of re-sorting siblings). */
  | { key: string };

type Step =
  | { kind: 'set'; id: NodeId; key: PropKey; before: unknown; after: unknown }
  | { kind: 'move'; id: NodeId; before: Place; after: Place };

interface Place {
  parent: NodeId;
  index: string;
}

export interface HistoryEntry {
  label: string;
  steps: Step[];
  /** Opaque editor state (e.g. selection) captured before and after the change. */
  metaBefore: unknown;
  metaAfter: unknown;
  /** When the step was last written (for merging quick repeats). */
  at?: number;
}

/** Repeats of the same edit closer than this become one undo step (dragging in a colour square, scrubbing a number). */
const MERGE_MS = 800;

function stepKey(s: Step): string {
  return s.kind === 'set' ? `s\u0000${s.id}\u0000${s.key}` : `m\u0000${s.id}`;
}

export interface UndoResult {
  entry: HistoryEntry;
  skipped: number;
}

export interface TransactOptions {
  label?: string;
  /** Record in undo history (default true). */
  undoable?: boolean;
  metaBefore?: unknown;
  metaAfter?: unknown;
}

export type ChangeListener = (changes: ChangeSet, source: ChangeSource) => void;
export type OpsListener = (ops: readonly Op[]) => void;

const HISTORY_LIMIT = 500;

export class Document {
  readonly store = new DocumentStore();
  readonly ids: IdGenerator;
  readonly clock: LamportClock;

  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly historyListeners = new Set<() => void>();
  private readonly opsListeners = new Set<OpsListener>();
  private active: Transaction | null = null;
  private gesture: Gesture | null = null;

  constructor(sessionId?: string) {
    this.ids = new IdGenerator(sessionId);
    this.clock = new LamportClock(this.ids.sessionId);
  }

  /** A new document with a root and one empty page. */
  static createEmpty(name = tr('Без названия'), sessionId?: string, page: Partial<NodeProps> = {}): Document {
    const doc = new Document(sessionId);
    doc.transact(
      (tx) => {
        const root = tx.createRoot(name);
        tx.create('PAGE', root, { name: tr('Страница 1'), ...page });
      },
      { undoable: false },
    );
    return doc;
  }

  get rootId(): NodeId {
    return this.store.rootId;
  }

  get<K extends PropKey>(id: NodeId, key: K): NodeProps[K] {
    return this.store.get(id, key);
  }

  type(id: NodeId): NodeType {
    return this.store.type(id);
  }

  parent(id: NodeId): NodeId | null {
    return this.store.parent(id);
  }

  children(id: NodeId): readonly NodeId[] {
    return this.store.children(id);
  }

  /** Children in the order they are drawn, bottom first: reversed in a row or column with "first on top". */
  paintChildren(id: NodeId): readonly NodeId[] {
    const children = this.store.children(id);
    if (children.length < 2 || !this.store.get(id, 'itemReverseZIndex')) return children;
    const mode = this.store.get(id, 'layoutMode');
    return mode === 'HORIZONTAL' || mode === 'VERTICAL' ? [...children].reverse() : children;
  }

  /** Pages people work on: without the hidden page of library components. */
  pages(): readonly NodeId[] {
    return this.store.children(this.rootId).filter((id) => this.store.type(id) === 'PAGE' && this.store.get(id, 'libraryPage') !== true);
  }

  /** The hidden page with components taken from libraries, if the file has one. */
  libraryPage(): NodeId | null {
    return this.store.children(this.rootId).find((id) => this.store.type(id) === 'PAGE' && this.store.get(id, 'libraryPage') === true) ?? null;
  }

  /** Variable collections in their order (FR-VAR-010). */
  collections(): readonly NodeId[] {
    return this.store.children(this.rootId).filter((id) => this.store.type(id) === 'VARIABLE_COLLECTION');
  }

  /** Document styles in their order (FR-STY-001). */
  styles(): readonly NodeId[] {
    return this.store.children(this.rootId).filter((id) => this.store.type(id) === 'STYLE');
  }

  /** The page that contains a node. */
  pageOf(id: NodeId): NodeId | null {
    let current: NodeId | null = id;
    while (current !== null) {
      if (this.store.type(current) === 'PAGE') return current;
      current = this.store.parent(current);
    }
    return null;
  }

  subscribe(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * The undo or redo history changed. Change listeners run before an edit
   * enters the history (and a finished gesture tells nothing at all): the
   * Undo and Redo buttons listen here.
   */
  onHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  private historyChanged(): void {
    for (const listener of this.historyListeners) listener();
  }

  /** Operations produced locally, for the sync layer to send to the server. */
  onLocalOps(listener: OpsListener): () => void {
    this.opsListeners.add(listener);
    return () => this.opsListeners.delete(listener);
  }

  /**
   * View-only file (the person may look, not edit): user edits are reverted at
   * once and reported through `onBlockedEdit`; work that is not an edit
   * (`undoable: false` — loading, re-measuring text) still runs.
   */
  readOnly = false;
  onBlockedEdit: (() => void) | null = null;

  /** Runs `fn` as one transaction. Nested calls join the outer transaction. */
  transact<T>(fn: (tx: Transaction) => T, options: TransactOptions = {}): T {
    if (this.active) return fn(this.active);
    const tx = new Transaction(this);
    this.active = tx;
    let result: T;
    try {
      result = fn(tx);
    } catch (error) {
      // A failed edit must not leave half of its changes behind: publish what was
      // applied and immediately revert it, outside the undo history.
      this.active = null;
      this.finish(tx, 'local');
      if (tx.steps.length > 0) this.replay(tx.steps.slice().reverse(), 'before', 'local');
      throw error;
    } finally {
      this.active = null;
    }
    this.finish(tx, 'local');
    if (this.readOnly && options.undoable !== false && tx.steps.length > 0) {
      this.replay(tx.steps.slice().reverse(), 'before', 'local');
      this.onBlockedEdit?.();
      return result;
    }
    if (tx.steps.length > 0 && options.undoable !== false) {
      this.pushHistory({
        label: options.label ?? '',
        steps: tx.steps,
        metaBefore: options.metaBefore,
        metaAfter: options.metaAfter,
      });
    }
    return result;
  }

  /**
   * Starts a continuous gesture: `update` can be called many times (each call is
   * applied and broadcast immediately), and the whole gesture becomes one undo step.
   */
  beginGesture(label: string, metaBefore?: unknown): Gesture {
    if (this.gesture) this.gesture.commit();
    this.gesture = new Gesture(this, label, metaBefore);
    return this.gesture;
  }

  /** Applies operations received from other participants. They never enter local history. */
  applyRemote(ops: readonly Op[]): ChangeSet {
    const changes = new ChangeSet();
    for (const op of ops) {
      this.clock.observe(op.time);
      this.store.apply(op, changes);
    }
    if (!changes.isEmpty) this.emit(changes, 'remote');
    return changes;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): UndoResult | null {
    this.gesture?.commit();
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const { applied, skipped } = this.replay(entry.steps.slice().reverse(), 'before', 'undo');
    if (applied.length > 0) {
      this.redoStack.push({ ...entry, steps: applied.reverse() });
    } else if (entry.steps.length > 0 && this.undoStack.length > 0) {
      // Nothing could be undone (everything was changed by others): try the previous step.
      return this.undo();
    }
    this.historyChanged();
    return { entry, skipped };
  }

  redo(): UndoResult | null {
    this.gesture?.commit();
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const { applied, skipped } = this.replay(entry.steps, 'after', 'redo');
    if (applied.length > 0) this.undoStack.push({ ...entry, steps: applied });
    this.historyChanged();
    return { entry, skipped };
  }

  /**
   * Undo history for display: steps that can be undone (oldest first) and
   * steps that can be redone (the next one first).
   */
  history(): { undo: { label: string; at: number; size: number }[]; redo: { label: string; at: number; size: number }[] } {
    const view = (e: HistoryEntry) => ({ label: e.label, at: e.at ?? 0, size: new Set(e.steps.map((s) => s.id)).size });
    return { undo: this.undoStack.map(view), redo: this.redoStack.map(view).reverse() };
  }

  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.historyChanged();
  }

  /** Order key after the last child of `parent` (for appending many nodes: pass the result on with keyAfter). */
  lastChildKey(parent: NodeId): string | null {
    const children = this.store.children(parent);
    const last = children[children.length - 1];
    return last === undefined ? null : (this.store.record(last)?.index ?? null);
  }

  /** Order key for inserting a child of `parent` at `position`. */
  indexFor(parent: NodeId, position: Position = { at: 'end' }, exclude?: NodeId): string {
    if ('key' in position) return position.key;
    const siblings = this.store.children(parent).filter((id) => id !== exclude);
    const key = (id: NodeId | undefined) => (id === undefined ? null : (this.store.record(id)?.index ?? null));
    const between = (i: number) => {
      const lo = key(siblings[i - 1]);
      const hi = key(siblings[i]);
      // Concurrent inserts can produce equal keys; never ask for a key between equal bounds.
      if (lo !== null && hi !== null && lo >= hi) return keyBetween(lo, null);
      return keyBetween(lo, hi);
    };
    if ('at' in position) return position.at === 'start' ? between(0) : between(siblings.length);
    if ('index' in position) return between(Math.max(0, Math.min(siblings.length, position.index)));
    const anchor = 'before' in position ? position.before : position.after;
    const i = siblings.indexOf(anchor);
    if (i < 0) return between(siblings.length);
    return between('before' in position ? i : i + 1);
  }

  // ---------- internals ----------

  /** @internal Applies an op created by a local transaction. */
  applyLocal(tx: Transaction, op: Op): boolean {
    const result = this.store.apply(op, tx.changes);
    if (result === 'rejected') return false;
    tx.ops.push(op);
    return true;
  }

  /** @internal */
  finish(tx: Transaction, source: ChangeSource): void {
    if (tx.ops.length > 0) for (const listener of this.opsListeners) listener(tx.ops);
    if (!tx.changes.isEmpty) this.emit(tx.changes, source);
  }

  /** @internal */
  pushHistory(entry: HistoryEntry): void {
    const now = Date.now();
    const prev = this.undoStack[this.undoStack.length - 1];
    // The same edit of the same properties again, right after the last one: extend that step.
    if (prev && entry.label && prev.label === entry.label && now - (prev.at ?? 0) < MERGE_MS && prev.steps.length === entry.steps.length) {
      const byKey = new Map(prev.steps.map((st) => [stepKey(st), st]));
      if (entry.steps.every((st) => byKey.has(stepKey(st)))) {
        for (const st of entry.steps) (byKey.get(stepKey(st))! as { after: unknown }).after = st.after;
        prev.metaAfter = entry.metaAfter;
        prev.at = now;
        this.redoStack.length = 0;
        this.historyChanged();
        return;
      }
    }
    entry.at = now;
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.historyChanged();
  }

  /** @internal Runs a function inside a transaction without recording history. */
  withTransaction(fn: (tx: Transaction) => void, source: ChangeSource): Transaction {
    const tx = new Transaction(this);
    const previous = this.active;
    this.active = tx;
    try {
      fn(tx);
    } finally {
      this.active = previous;
    }
    this.finish(tx, source);
    return tx;
  }

  /** @internal */
  endGesture(gesture: Gesture): void {
    if (this.gesture === gesture) this.gesture = null;
  }

  private replay(steps: Step[], target: 'before' | 'after', source: ChangeSource) {
    const applied: Step[] = [];
    let skipped = 0;
    this.withTransaction((tx) => {
      for (const step of steps) {
        if (!this.store.has(step.id)) {
          skipped++;
          continue;
        }
        const expected = target === 'before' ? step.after : step.before;
        const wanted = target === 'before' ? step.before : step.after;
        if (step.kind === 'set') {
          if (!valueEquals(this.store.get(step.id, step.key), expected)) {
            skipped++;
            continue;
          }
          tx.rawSet(step.id, step.key, wanted);
        } else {
          const exp = expected as Place;
          const want = wanted as Place;
          const record = this.store.record(step.id);
          if (!record || record.parent !== exp.parent || record.index !== exp.index) {
            skipped++;
            continue;
          }
          if (!tx.rawMove(step.id, want.parent, want.index)) {
            skipped++;
            continue;
          }
        }
        applied.push(step);
      }
    }, source);
    return { applied, skipped };
  }

  private emit(changes: ChangeSet, source: ChangeSource): void {
    for (const listener of this.changeListeners) listener(changes, source);
  }
}

/** A unit of change. Methods apply immediately, so later reads inside the transaction see them. */
export class Transaction {
  readonly doc: Document;
  readonly ops: Op[] = [];
  readonly steps: Step[] = [];
  readonly changes = new ChangeSet();
  /** Step per node and property, so repeated writes collapse in O(1). */
  private readonly stepIndex = new Map<string, Step>();

  constructor(doc: Document) {
    this.doc = doc;
  }

  /** @internal Creates the document root. */
  createRoot(name: string): NodeId {
    const id = this.doc.ids.next();
    this.doc.applyLocal(this, {
      kind: 'create',
      id,
      type: 'DOCUMENT',
      parent: null,
      index: 'a0',
      props: { name },
      time: this.doc.clock.tick(),
    });
    return id;
  }

  create(type: NodeType, parent: NodeId, props: Partial<NodeProps> = {}, position: Position = { at: 'end' }): NodeId {
    const id = this.doc.ids.next();
    const ok = this.doc.applyLocal(this, {
      kind: 'create',
      id,
      type,
      parent,
      index: this.doc.indexFor(parent, position),
      props: cloneValue(props),
      time: this.doc.clock.tick(),
    });
    if (!ok) throw new Error(`Cannot create ${type} inside ${this.doc.type(parent)}`);
    // Creation is recorded as "deleted: true → false" so undo simply deletes the node.
    this.recordSet(id, 'deleted', true, false);
    return id;
  }

  set<K extends PropKey>(id: NodeId, key: K, value: NodeProps[K]): void {
    const before = this.doc.store.get(id, key);
    if (valueEquals(before, value)) return;
    if (this.rawSet(id, key, value)) this.recordSet(id, key, cloneValue(before), cloneValue(value));
  }

  update(id: NodeId, props: Partial<NodeProps>): void {
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined) this.set(id, key as PropKey, value as never);
    }
  }

  delete(id: NodeId): void {
    if (this.doc.store.record(id)?.parent === null) throw new Error('Cannot delete the document root');
    this.set(id, 'deleted', true);
  }

  /**
   * Brings a node back with its own id (restoring a version): created where
   * it is missing, made alive where it was deleted. Every property is written
   * again with a fresh time, so participants who still hold the deleted node
   * take the restored values. One undo step deletes it again.
   */
  revive(id: NodeId, type: NodeType, parent: NodeId, index: string, props: Partial<NodeProps>): boolean {
    const existed = this.doc.store.has(id);
    if (!existed) {
      const ok = this.doc.applyLocal(this, { kind: 'create', id, type, parent, index, props: cloneValue(props), time: this.doc.clock.tick() });
      if (!ok) return false;
    }
    const wasDeleted = !existed || this.doc.store.get(id, 'deleted') === true;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'deleted' || value === undefined) continue;
      if (existed) this.set(id, key as PropKey, value as never);
      else this.rawSet(id, key as PropKey, value);
    }
    if (existed) {
      const record = this.doc.store.record(id)!;
      if (record.parent !== parent || record.index !== index) this.move(id, parent, { key: index });
    } else {
      this.rawMove(id, parent, index);
    }
    if (wasDeleted) {
      this.rawSet(id, 'deleted', false);
      this.recordSet(id, 'deleted', true, false);
    }
    return true;
  }

  /** Moves a node under `parent` at `position`. Returns false if the move is not allowed (cycles, containment). */
  move(id: NodeId, parent: NodeId, position: Position = { at: 'end' }): boolean {
    const record = this.doc.store.record(id);
    if (!record || record.parent === null) return false;
    if (!this.doc.store.canMove(id, parent)) return false;
    const before: Place = { parent: record.parent, index: record.index };
    const index = this.doc.indexFor(parent, position, id);
    if (before.parent === parent && before.index === index) return true;
    if (!this.rawMove(id, parent, index)) return false;
    this.recordMove(id, before, { parent, index });
    return true;
  }

  /**
   * Stores an image (or any binary resource) in the document and returns its
   * content hash. Identical bytes are stored once; no undo step is needed
   * because resources are immutable and only referenced from paints.
   */
  addBlob(bytes: Uint8Array, mime: string): string {
    const hash = sha256(bytes);
    if (!this.doc.store.blobs.has(hash)) {
      this.doc.applyLocal(this, { kind: 'blob', hash, mime, data: bytesToBase64(bytes), time: this.doc.clock.tick() });
    }
    return hash;
  }

  /** @internal Applies a set without recording an undo step. */
  rawSet(id: NodeId, key: PropKey, value: unknown): boolean {
    return this.doc.applyLocal(this, { kind: 'set', id, key, value: cloneValue(value), time: this.doc.clock.tick() });
  }

  /** @internal Applies a move without recording an undo step. */
  rawMove(id: NodeId, parent: NodeId, index: string): boolean {
    return this.doc.applyLocal(this, { kind: 'move', id, parent, index, time: this.doc.clock.tick() });
  }

  private recordSet(id: NodeId, key: PropKey, before: unknown, after: unknown): void {
    // Several writes to one property collapse into one step: first "before", last "after".
    const k = `${id}\u0000${key}`;
    const existing = this.stepIndex.get(k);
    if (existing && existing.kind === 'set') {
      existing.after = after;
      return;
    }
    const step: Step = { kind: 'set', id, key, before, after };
    this.stepIndex.set(k, step);
    this.steps.push(step);
  }

  private recordMove(id: NodeId, before: Place, after: Place): void {
    const k = `${id}\u0000\u0000move`;
    const existing = this.stepIndex.get(k);
    if (existing && existing.kind === 'move') {
      existing.after = after;
      return;
    }
    const step: Step = { kind: 'move', id, before, after };
    this.stepIndex.set(k, step);
    this.steps.push(step);
  }
}

/** A live, multi-update change that becomes a single undo step on commit. */
export class Gesture {
  private readonly doc: Document;
  private readonly label: string;
  private readonly metaBefore: unknown;
  private readonly collected: Transaction;
  private readonly merged = new Map<string, Step>();
  private done = false;
  private blockedReported = false;

  constructor(doc: Document, label: string, metaBefore: unknown) {
    this.doc = doc;
    this.label = label;
    this.metaBefore = metaBefore;
    this.collected = new Transaction(doc);
  }

  get active(): boolean {
    return !this.done;
  }

  update(fn: (tx: Transaction) => void): void {
    if (this.done) throw new Error('Gesture already finished');
    this.doc.withTransaction((tx) => {
      fn(tx);
      if (this.doc.readOnly) {
        // View-only: undo this step right away, inside the same transaction.
        for (const step of tx.steps.slice().reverse()) {
          if (step.kind === 'set') tx.rawSet(step.id, step.key, step.before);
          else tx.rawMove(step.id, step.before.parent, step.before.index);
        }
        tx.steps.length = 0;
        if (!this.blockedReported) this.doc.onBlockedEdit?.();
        this.blockedReported = true;
        return;
      }
      // Merge this update's steps into the gesture: keep the earliest "before".
      for (const step of tx.steps) {
        const k = step.kind === 'set' ? `${step.id}\u0000${step.key}` : `${step.id}\u0000\u0000move`;
        const existing = this.merged.get(k);
        if (existing) existing.after = step.after as never;
        else {
          this.merged.set(k, step);
          this.collected.steps.push(step);
        }
      }
    }, 'local');
  }

  commit(metaAfter?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.doc.endGesture(this);
    const steps = this.collected.steps.filter((s) =>
      s.kind === 'set' ? !valueEquals(s.before, s.after) : s.before.parent !== s.after.parent || s.before.index !== s.after.index,
    );
    if (steps.length > 0) {
      this.doc.pushHistory({ label: this.label, steps, metaBefore: this.metaBefore, metaAfter });
    }
  }

  /** Reverts everything the gesture changed. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.doc.endGesture(this);
    const steps = this.collected.steps.slice().reverse();
    this.doc.withTransaction((tx) => {
      for (const step of steps) {
        if (step.kind === 'set') tx.rawSet(step.id, step.key, step.before);
        else tx.rawMove(step.id, step.before.parent, step.before.index);
      }
    }, 'local');
  }
}
