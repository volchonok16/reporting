// Kiwi — the binary format Figma keeps its documents in. A .fig carries its
// own schema (the list of types and fields) before the data, so the reader
// needs no knowledge of Figma's types: it builds plain objects by the schema.
//
// Schema: count, then definitions — name, kind (enum / struct / message),
// fields: name, type (negative — built-in), array flag, value (enum value or
// field id). Data: structs list every field in order; messages list
// "field id, value" pairs ending with 0; arrays are a length and the items.

const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'] as const;
const BUILTIN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'] as const;

export interface KiwiField {
  name: string;
  /** A built-in type name or the index of a definition. */
  type: string | number;
  isArray: boolean;
  value: number;
}

export interface KiwiDefinition {
  name: string;
  kind: (typeof KINDS)[number];
  fields: KiwiField[];
}

export interface KiwiSchema {
  definitions: KiwiDefinition[];
  byName: Map<string, number>;
}

export class KiwiError extends Error {}

class Reader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  private static readonly utf8 = new TextDecoder();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  byte(): number {
    if (this.pos >= this.bytes.length) throw new KiwiError('unexpected end of data');
    return this.bytes[this.pos++]!;
  }

  uint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 127) * 2 ** shift;
      if (!(b & 128) || shift >= 35) break;
      shift += 7;
    }
    return value >>> 0;
  }

  int(): number {
    const v = this.uint();
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  /** 64-bit values as numbers: enough for ids and counters in a document. */
  uint64(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 127) * 2 ** shift;
      if (!(b & 128) || shift >= 56) break;
      shift += 7;
    }
    return value;
  }

  int64(): number {
    const v = this.uint64();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  /** Floats are stored with the exponent first: zero takes one byte. */
  float(): number {
    const first = this.byte();
    if (first === 0) return 0;
    if (this.pos + 3 > this.bytes.length) throw new KiwiError('unexpected end of data');
    let bits = first | (this.bytes[this.pos]! << 8) | (this.bytes[this.pos + 1]! << 16) | (this.bytes[this.pos + 2]! << 24);
    this.pos += 3;
    bits = (bits << 23) | (bits >>> 9);
    return f32(bits);
  }

  string(): string {
    const start = this.pos;
    const end = this.bytes.indexOf(0, start);
    if (end < 0) throw new KiwiError('unterminated string');
    this.pos = end + 1;
    return Reader.utf8.decode(this.bytes.subarray(start, end));
  }

  bytesOf(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) throw new KiwiError('unexpected end of data');
    const out = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

const F32 = new DataView(new ArrayBuffer(4));
function f32(bits: number): number {
  F32.setUint32(0, bits >>> 0);
  return F32.getFloat32(0);
}

export function decodeSchema(bytes: Uint8Array): KiwiSchema {
  const r = new Reader(bytes);
  const count = r.uint();
  const definitions: KiwiDefinition[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const kind = KINDS[r.byte()];
    if (!kind) throw new KiwiError(`bad kind of ${name}`);
    const fields: KiwiField[] = [];
    const n = r.uint();
    for (let j = 0; j < n; j++) {
      const fieldName = r.string();
      const t = r.int();
      const isArray = r.byte() === 1;
      const value = r.uint();
      fields.push({ name: fieldName, type: t < 0 ? BUILTIN[~t]! : t, isArray, value });
    }
    definitions.push({ name, kind, fields });
  }
  for (const d of definitions) {
    for (const f of d.fields) if (typeof f.type === 'number' && !definitions[f.type]) throw new KiwiError(`bad type of ${d.name}.${f.name}`);
  }
  return { definitions, byName: new Map(definitions.map((d, i) => [d.name, i])) };
}

/** Reads a value of the named type (Figma's documents are a "Message"). */
export function decodeMessage(schema: KiwiSchema, bytes: Uint8Array, root = 'Message'): Record<string, unknown> {
  const index = schema.byName.get(root);
  if (index === undefined) throw new KiwiError(`no type ${root}`);
  const r = new Reader(bytes);
  return readDefinition(schema, index, r) as Record<string, unknown>;
}

function readDefinition(schema: KiwiSchema, index: number, r: Reader): unknown {
  const def = schema.definitions[index]!;
  if (def.kind === 'ENUM') {
    const v = r.uint();
    return def.fields.find((f) => f.value === v)?.name ?? v;
  }
  const out: Record<string, unknown> = {};
  if (def.kind === 'STRUCT') {
    for (const f of def.fields) out[f.name] = readField(schema, f, r);
    return out;
  }
  for (;;) {
    const id = r.uint();
    if (id === 0) return out;
    const f = def.fields.find((x) => x.value === id);
    if (!f) throw new KiwiError(`unknown field ${id} in ${def.name}`);
    out[f.name] = readField(schema, f, r);
  }
}

function readField(schema: KiwiSchema, f: KiwiField, r: Reader): unknown {
  if (f.isArray) {
    const n = r.uint();
    if (f.type === 'byte') return r.bytesOf(n);
    const items: unknown[] = new Array(n);
    for (let i = 0; i < n; i++) items[i] = readValue(schema, f.type, r);
    return items;
  }
  return readValue(schema, f.type, r);
}

function readValue(schema: KiwiSchema, type: string | number, r: Reader): unknown {
  switch (type) {
    case 'bool':
      return r.byte() !== 0;
    case 'byte':
      return r.byte();
    case 'int':
      return r.int();
    case 'uint':
      return r.uint();
    case 'float':
      return r.float();
    case 'string':
      return r.string();
    case 'int64':
      return r.int64();
    case 'uint64':
      return r.uint64();
    default:
      return readDefinition(schema, type as number, r);
  }
}
