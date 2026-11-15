// What comes from outside — a file opened from disk, edits of co-editors (on the client and on the server) —
// is checked before it enters a document: whatever a hand-written JSON holds, the document gets only values of
// the kinds its schema knows. The schema is the default values (schema.ts BASE_DEFAULTS): a property whose
// default is a number takes only a finite number, a string only a string (an enum — only a plain word), a flag
// only true/false, a list or an object only plain JSON data — bounded in depth, size and string length, with
// no "__proto__"-like keys. Unknown properties are dropped. A value that does not fit is dropped too (the
// property keeps its default), never the whole file: one broken layer does not cost a person their work.
//
// This is the one gate for the whole class of «a file put something where code expected something else»
// (BUG-169, BUG-170 closed such holes field by field); escaping at output (cssString, safeLink, cssNoTags)
// stays as the second line.

import type { Timestamp } from './clock.ts';
import type { Op } from './ops.ts';
import { BASE_DEFAULTS, isPropKey, type NodeProps, type NodeType, type PropKey } from './schema.ts';

export const LIMITS = {
  /** A file opened from disk. */
  fileBytes: 200 * 1024 * 1024,
  nodes: 500_000,
  /** Ids, indexes, hashes, enum words. */
  idLength: 200,
  /** Any string inside a value (text of a layer included). */
  stringLength: 2_000_000,
  /** Items of one array, keys of one object. */
  items: 200_000,
  depth: 24,
  /** Primitive values inside one property value (a big vector network fits). */
  cells: 2_000_000,
} as const;

const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
  'DOCUMENT', 'PAGE', 'FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'RECTANGLE', 'ELLIPSE',
  'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'TEXT', 'SLICE', 'STYLE', 'VARIABLE_COLLECTION', 'VARIABLE',
]);

/** A node type this editor knows. */
export const isNodeType = (v: unknown): v is NodeType => typeof v === 'string' && NODE_TYPES.has(v);

const BAD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const ENUM_DEFAULT = /^[A-Z][A-Z0-9_]*$/;
const ENUM_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

/** Properties whose default is a value but which a file may hold as null («not set»). */
const NULLABLE: ReadonlySet<string> = new Set<string>([]);

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idLength;

/** Plain JSON data within the limits (a copy is not made: JSON.parse output is plain already). */
export function plainData(value: unknown): boolean {
  let cells = 0;
  const ok = (v: unknown, depth: number): boolean => {
    if (++cells > LIMITS.cells) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= LIMITS.stringLength;
    if (depth >= LIMITS.depth || typeof v !== 'object') return false;
    if (Array.isArray(v)) {
      if (v.length > LIMITS.items) return false;
      for (const x of v) if (!ok(x, depth + 1)) return false;
      return true;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(v);
    if (keys.length > LIMITS.items) return false;
    for (const k of keys) {
      if (BAD_KEYS.has(k) || k.length > LIMITS.idLength) return false;
      const x = (v as Record<string, unknown>)[k];
      // A field left undefined is no field (JSON never has one; the editor's own objects may).
      if (x !== undefined && !ok(x, depth + 1)) return false;
    }
    return true;
  };
  return ok(value, 0);
}

/** Whether `value` may be the value of `key` (by the kind of its default). */
export function validProp(key: PropKey, value: unknown): boolean {
  const def = (BASE_DEFAULTS as unknown as Record<string, unknown>)[key];
  if (value === null) return def === null || NULLABLE.has(key);
  switch (typeof def) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      if (typeof value !== 'string') return false;
      return ENUM_DEFAULT.test(def) ? ENUM_VALUE.test(value) : value.length <= LIMITS.stringLength;
    default:
      if (def === null) return plainData(value);
      if (Array.isArray(def)) return Array.isArray(value) && plainData(value);
      return typeof value === 'object' && !Array.isArray(value) && plainData(value);
  }
}

/** The properties of a create, only those that fit (unknown keys and values that do not fit are left out). */
export function validProps(props: unknown): Partial<NodeProps> {
  const out: Record<string, unknown> = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!isPropKey(key) || value === undefined) continue;
    if (validProp(key, value)) out[key] = value;
  }
  return out as Partial<NodeProps>;
}

function validTime(t: unknown): t is Timestamp {
  return !!t && typeof t === 'object' && Number.isSafeInteger((t as Timestamp).counter) && (t as Timestamp).counter >= 0 && typeof (t as Timestamp).session === 'string' && (t as Timestamp).session.length <= LIMITS.idLength;
}

/**
 * An operation from outside as it may be applied: its shape checked, its values only those that fit — or null
 * (not applied at all) when its very shape is wrong.
 */
export function validOp(op: unknown): Op | null {
  if (!op || typeof op !== 'object') return null;
  const o = op as Record<string, unknown>;
  if (!validTime(o.time)) return null;
  switch (o.kind) {
    case 'create':
      if (!isId(o.id) || typeof o.type !== 'string' || !NODE_TYPES.has(o.type) || !(o.parent === null || isId(o.parent)) || !isId(o.index)) return null;
      return { kind: 'create', id: o.id, type: o.type as NodeType, parent: o.parent as string | null, index: o.index, props: validProps(o.props), time: o.time };
    case 'set':
      if (!isId(o.id) || typeof o.key !== 'string' || !isPropKey(o.key)) return null;
      // «deleted» is a flag like any other; a value that does not fit is not set at all.
      if (o.value === undefined || !validProp(o.key, o.value)) return null;
      return { kind: 'set', id: o.id, key: o.key, value: o.value, time: o.time };
    case 'move':
      if (!isId(o.id) || !isId(o.parent) || !isId(o.index)) return null;
      return { kind: 'move', id: o.id, parent: o.parent, index: o.index, time: o.time };
    case 'blob':
      if (!isId(o.hash) || typeof o.mime !== 'string' || o.mime.length > LIMITS.idLength || typeof o.data !== 'string') return null;
      return { kind: 'blob', hash: o.hash, mime: o.mime, data: o.data, time: o.time };
    default:
      return null;
  }
}

/** A batch from outside: the operations that may be applied. */
export function validOps(ops: readonly unknown[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const v = validOp(op);
    if (v) out.push(v);
  }
  return out;
}
