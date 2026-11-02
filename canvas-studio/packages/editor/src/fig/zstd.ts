// Zstandard decompression (RFC 8878), own code: Figma compresses the documents
// in .fig files with it, and browsers have no zstd of their own. Decoding
// only — frames, raw / RLE / compressed blocks, Huffman literals, FSE
// sequences with repeat offsets; no dictionaries (Figma does not use them).
// The whole output is kept, so the window size does not matter.

export class ZstdError extends Error {}

const MAGIC = 0xfd2fb528;

// ---------- bit readers ----------

/** Reads a stream written backwards: from the last bit (after the padding 1) towards the first. */
class BackwardBits {
  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  /** Bits not read yet; below zero — read past the start (zeros come back). */
  bits: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    if (end <= start) throw new ZstdError('empty bitstream');
    const last = bytes[end - 1]!;
    if (last === 0) throw new ZstdError('bad bitstream padding');
    this.bytes = bytes;
    this.start = start;
    this.end = end;
    this.bits = (end - 1 - start) * 8 + (31 - Math.clz32(last));
  }

  /** `n` bits ending at bit `p + n` (bits before the start read as zeros); n ≤ 24. */
  private peekAt(p: number, n: number): number {
    if (n === 0) return 0;
    if (p < 0) {
      if (p + n <= 0) return 0;
      return this.peekAt(0, n + p) * 2 ** -p;
    }
    const i = this.start + (p >> 3);
    const b = this.bytes;
    const word = (i < this.end ? b[i]! : 0) | ((i + 1 < this.end ? b[i + 1]! : 0) << 8) | ((i + 2 < this.end ? b[i + 2]! : 0) << 16) | ((i + 3 < this.end ? b[i + 3]! : 0) << 24);
    return ((word >>> (p & 7)) & ((1 << n) - 1)) >>> 0;
  }

  peek(n: number): number {
    return this.peekAt(this.bits - n, n);
  }

  skip(n: number): void {
    this.bits -= n;
  }

  read(n: number): number {
    if (n === 0) return 0;
    if (n > 24) {
      const high = this.read(n - 24);
      return high * 0x1000000 + this.read(24);
    }
    this.bits -= n;
    return this.peekAt(this.bits, n);
  }
}

/** Reads a stream forwards, lowest bits first (FSE table descriptions). */
class ForwardBits {
  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  pos = 0;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.start = start;
    this.end = end;
  }

  peek(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const p = this.pos + k;
      const i = this.start + (p >> 3);
      const bit = i < this.end ? (this.bytes[i]! >> (p & 7)) & 1 : 0;
      v |= bit << k;
    }
    return v >>> 0;
  }

  read(n: number): number {
    const v = this.peek(n);
    this.pos += n;
    return v;
  }

  /** Bytes used so far, the last one counted whole. */
  get bytesUsed(): number {
    return (this.pos + 7) >> 3;
  }
}

// ---------- FSE ----------

interface FseTable {
  log: number;
  symbol: Uint8Array;
  bits: Uint8Array;
  base: Uint32Array;
}

function highBit(v: number): number {
  return 31 - Math.clz32(v);
}

/** Builds the decoding table from normalized counts (−1: "less than one"). */
function buildFse(counts: readonly number[], log: number): FseTable {
  const size = 1 << log;
  const symbol = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint32Array(size);
  const next = new Array<number>(counts.length).fill(0);
  let high = size - 1;
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === -1) {
      symbol[high--] = s;
      next[s] = 1;
    } else {
      next[s] = counts[s]!;
    }
  }
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let pos = 0;
  for (let s = 0; s < counts.length; s++) {
    for (let i = 0; i < counts[s]!; i++) {
      symbol[pos] = s;
      do pos = (pos + step) & mask;
      while (pos > high);
    }
  }
  if (pos !== 0) throw new ZstdError('bad FSE distribution');
  for (let u = 0; u < size; u++) {
    const s = symbol[u]!;
    const n = next[s]!++;
    const b = log - highBit(n);
    bits[u] = b;
    base[u] = (n << b) - size;
  }
  return { log, symbol, bits, base };
}

/** Reads an FSE table description; returns the table and the bytes it took. */
function readFse(bytes: Uint8Array, start: number, end: number, maxLog: number, maxSymbol: number): { table: FseTable; size: number } {
  const r = new ForwardBits(bytes, start, end);
  const log = r.read(4) + 5;
  if (log > maxLog) throw new ZstdError('FSE accuracy too high');
  let remaining = (1 << log) + 1;
  let threshold = 1 << log;
  let nbBits = log + 1;
  const counts: number[] = [];
  let previousZero = false;
  while (remaining > 1 && counts.length <= maxSymbol) {
    if (previousZero) {
      for (;;) {
        const repeat = r.read(2);
        for (let i = 0; i < repeat; i++) counts.push(0);
        if (repeat !== 3) break;
      }
      if (counts.length > maxSymbol) break;
    }
    const max = 2 * threshold - 1 - remaining;
    let count: number;
    const low = r.peek(nbBits - 1);
    if (low < max) {
      count = low;
      r.pos += nbBits - 1;
    } else {
      count = r.peek(nbBits);
      if (count >= threshold) count -= max;
      r.pos += nbBits;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    counts.push(count);
    previousZero = count === 0;
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1 || counts.length > maxSymbol + 1) throw new ZstdError('bad FSE table');
  return { table: buildFse(counts, log), size: r.bytesUsed };
}

function rleTable(symbol: number): FseTable {
  return { log: 0, symbol: Uint8Array.of(symbol), bits: Uint8Array.of(0), base: Uint32Array.of(0) };
}

// ---------- Huffman literals ----------

interface HuffTable {
  maxBits: number;
  symbol: Uint8Array;
  bits: Uint8Array;
}

/** Reads a Huffman tree description; returns the table and the bytes it took. */
function readHuffman(bytes: Uint8Array, start: number, end: number): { table: HuffTable; size: number } {
  const header = bytes[start]!;
  let weights: number[];
  let size: number;
  if (header >= 128) {
    const n = header - 127;
    size = 1 + Math.ceil(n / 2);
    weights = [];
    for (let i = 0; i < n; i++) {
      const b = bytes[start + 1 + (i >> 1)]!;
      weights.push(i & 1 ? b & 15 : b >> 4);
    }
  } else {
    size = 1 + header;
    if (start + size > end) throw new ZstdError('truncated Huffman weights');
    const { table, size: used } = readFse(bytes, start + 1, start + size, 6, 255);
    const bits = new BackwardBits(bytes, start + 1 + used, start + size);
    let s1 = bits.read(table.log);
    let s2 = bits.read(table.log);
    weights = [];
    for (;;) {
      weights.push(table.symbol[s1]!);
      s1 = table.base[s1]! + bits.read(table.bits[s1]!);
      if (bits.bits < 0) {
        weights.push(table.symbol[s2]!);
        break;
      }
      weights.push(table.symbol[s2]!);
      s2 = table.base[s2]! + bits.read(table.bits[s2]!);
      if (bits.bits < 0) {
        weights.push(table.symbol[s1]!);
        break;
      }
      if (weights.length > 255) throw new ZstdError('too many Huffman weights');
    }
  }
  let sum = 0;
  for (const w of weights) if (w > 0) sum += 1 << (w - 1);
  if (sum === 0) throw new ZstdError('empty Huffman tree');
  const maxBits = highBit(sum) + 1;
  const left = (1 << maxBits) - sum;
  if (left & (left - 1)) throw new ZstdError('bad Huffman tree');
  weights.push(highBit(left) + 1);
  if (maxBits > 11) throw new ZstdError('Huffman codes too long');
  const tableSize = 1 << maxBits;
  const symbol = new Uint8Array(tableSize);
  const nbits = new Uint8Array(tableSize);
  let pos = 0;
  for (let w = 1; w <= maxBits; w++) {
    for (let s = 0; s < weights.length; s++) {
      if (weights[s] !== w) continue;
      const span = 1 << (w - 1);
      symbol.fill(s, pos, pos + span);
      nbits.fill(maxBits + 1 - w, pos, pos + span);
      pos += span;
    }
  }
  if (pos !== tableSize) throw new ZstdError('bad Huffman tree');
  return { table: { maxBits, symbol, bits: nbits }, size };
}

function decodeHuffStream(table: HuffTable, bytes: Uint8Array, start: number, end: number, out: Uint8Array, from: number, count: number): void {
  const bits = new BackwardBits(bytes, start, end);
  const { maxBits, symbol, bits: nb } = table;
  for (let i = 0; i < count; i++) {
    const v = bits.peek(maxBits);
    out[from + i] = symbol[v]!;
    bits.skip(nb[v]!);
  }
  if (bits.bits !== 0) throw new ZstdError('Huffman stream not consumed exactly');
}

// ---------- sequences ----------

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

const LL_DEFAULT = buildFse([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
const ML_DEFAULT = buildFse([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1], 6);
const OF_DEFAULT = buildFse([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);

// ---------- output ----------

class Output {
  buf: Uint8Array;
  len = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(size, 1024));
  }

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  append(src: Uint8Array, from: number, to: number): void {
    this.ensure(to - from);
    this.buf.set(src.subarray(from, to), this.len);
    this.len += to - from;
  }

  /** Copies `length` bytes from `offset` back; the regions may overlap (repeats). */
  match(offset: number, length: number, frameStart: number): void {
    if (offset > this.len - frameStart || offset === 0) throw new ZstdError('match offset out of range');
    this.ensure(length);
    const b = this.buf;
    let src = this.len - offset;
    let dst = this.len;
    if (offset >= length) b.copyWithin(dst, src, src + length);
    else for (let i = 0; i < length; i++) b[dst++] = b[src++]!;
    this.len += length;
  }
}

/** What carries over from block to block inside a frame. */
interface FrameState {
  huffman: HuffTable | null;
  ll: FseTable | null;
  of: FseTable | null;
  ml: FseTable | null;
  rep: [number, number, number];
}

function decodeLiterals(bytes: Uint8Array, start: number, end: number, state: FrameState): { literals: Uint8Array; size: number } {
  const b0 = bytes[start]!;
  const type = b0 & 3;
  const format = (b0 >> 2) & 3;
  if (type === 0 || type === 1) {
    let regen: number;
    let header: number;
    if (format === 0 || format === 2) {
      regen = b0 >> 3;
      header = 1;
    } else if (format === 1) {
      regen = (b0 >> 4) + (bytes[start + 1]! << 4);
      header = 2;
    } else {
      regen = (b0 >> 4) + (bytes[start + 1]! << 4) + (bytes[start + 2]! << 12);
      header = 3;
    }
    if (type === 0) {
      if (start + header + regen > end) throw new ZstdError('truncated literals');
      return { literals: bytes.subarray(start + header, start + header + regen), size: header + regen };
    }
    return { literals: new Uint8Array(regen).fill(bytes[start + header]!), size: header + 1 };
  }
  let regen: number;
  let comp: number;
  let header: number;
  const streams = format === 0 ? 1 : 4;
  if (format <= 1) {
    const c = b0 | (bytes[start + 1]! << 8) | (bytes[start + 2]! << 16);
    regen = (c >> 4) & 0x3ff;
    comp = (c >> 14) & 0x3ff;
    header = 3;
  } else if (format === 2) {
    const c = (b0 | (bytes[start + 1]! << 8) | (bytes[start + 2]! << 16) | (bytes[start + 3]! << 24)) >>> 0;
    regen = (c >>> 4) & 0x3fff;
    comp = (c >>> 18) & 0x3fff;
    header = 4;
  } else {
    const low = b0 | (bytes[start + 1]! << 8) | (bytes[start + 2]! << 16);
    regen = (low >> 4) & 0x3ffff;
    comp = (bytes[start + 2]! >> 6) | (bytes[start + 3]! << 2) | (bytes[start + 4]! << 10);
    header = 5;
  }
  let p = start + header;
  const stop = p + comp;
  if (stop > end) throw new ZstdError('truncated literals');
  if (type === 2) {
    const { table, size } = readHuffman(bytes, p, stop);
    state.huffman = table;
    p += size;
  } else if (!state.huffman) {
    throw new ZstdError('literals reuse a missing Huffman table');
  }
  const table = state.huffman!;
  const literals = new Uint8Array(regen);
  if (streams === 1) {
    decodeHuffStream(table, bytes, p, stop, literals, 0, regen);
  } else {
    const s1 = bytes[p]! | (bytes[p + 1]! << 8);
    const s2 = bytes[p + 2]! | (bytes[p + 3]! << 8);
    const s3 = bytes[p + 4]! | (bytes[p + 5]! << 8);
    p += 6;
    const seg = Math.floor((regen + 3) / 4);
    const ends = [p + s1, p + s1 + s2, p + s1 + s2 + s3, stop];
    if (ends[2]! > stop) throw new ZstdError('bad literal streams');
    let from = p;
    for (let k = 0; k < 4; k++) {
      const count = k < 3 ? seg : regen - 3 * seg;
      decodeHuffStream(table, bytes, from, ends[k]!, literals, k * seg, count);
      from = ends[k]!;
    }
  }
  return { literals, size: stop - start };
}

function pickTable(mode: number, bytes: Uint8Array, p: number, end: number, fallback: FseTable, previous: FseTable | null, maxLog: number, maxSymbol: number): { table: FseTable; size: number } {
  if (mode === 0) return { table: fallback, size: 0 };
  if (mode === 1) return { table: rleTable(bytes[p]!), size: 1 };
  if (mode === 2) return readFse(bytes, p, end, maxLog, maxSymbol);
  if (!previous) throw new ZstdError('repeated table missing');
  return { table: previous, size: 0 };
}

function decodeBlock(bytes: Uint8Array, start: number, end: number, out: Output, state: FrameState, frameStart: number): void {
  const { literals, size } = decodeLiterals(bytes, start, end, state);
  let p = start + size;
  const b0 = bytes[p++]!;
  let count: number;
  if (b0 < 128) count = b0;
  else if (b0 < 255) count = ((b0 - 128) << 8) + bytes[p++]!;
  else {
    count = bytes[p]! + (bytes[p + 1]! << 8) + 0x7f00;
    p += 2;
  }
  if (count === 0) {
    out.append(literals, 0, literals.length);
    return;
  }
  const modes = bytes[p++]!;
  const ll = pickTable(modes >> 6, bytes, p, end, LL_DEFAULT, state.ll, 9, 35);
  p += ll.size;
  const of = pickTable((modes >> 4) & 3, bytes, p, end, OF_DEFAULT, state.of, 8, 31);
  p += of.size;
  const ml = pickTable((modes >> 2) & 3, bytes, p, end, ML_DEFAULT, state.ml, 9, 52);
  p += ml.size;
  state.ll = ll.table;
  state.of = of.table;
  state.ml = ml.table;
  const LL = ll.table;
  const OF = of.table;
  const ML = ml.table;
  const bits = new BackwardBits(bytes, p, end);
  let sLL = bits.read(LL.log);
  let sOF = bits.read(OF.log);
  let sML = bits.read(ML.log);
  const rep = state.rep;
  let lit = 0;
  for (let i = 0; i < count; i++) {
    const ofCode = OF.symbol[sOF]!;
    const llCode = LL.symbol[sLL]!;
    const mlCode = ML.symbol[sML]!;
    if (llCode > 35 || mlCode > 52 || ofCode > 31) throw new ZstdError('bad sequence code');
    let offset = 2 ** ofCode + bits.read(ofCode);
    const matchLength = ML_BASE[mlCode]! + bits.read(ML_BITS[mlCode]!);
    const literalLength = LL_BASE[llCode]! + bits.read(LL_BITS[llCode]!);
    if (offset > 3) {
      offset -= 3;
      rep[2] = rep[1];
      rep[1] = rep[0];
      rep[0] = offset;
    } else {
      const code = literalLength === 0 ? offset + 1 : offset;
      if (code === 1) offset = rep[0];
      else {
        offset = code === 4 ? rep[0] - 1 : rep[code - 1]!;
        if (code !== 2) rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = offset;
      }
    }
    if (lit + literalLength > literals.length) throw new ZstdError('literals overrun');
    out.append(literals, lit, lit + literalLength);
    lit += literalLength;
    out.match(offset, matchLength, frameStart);
    if (i < count - 1) {
      sLL = LL.base[sLL]! + bits.read(LL.bits[sLL]!);
      sML = ML.base[sML]! + bits.read(ML.bits[sML]!);
      sOF = OF.base[sOF]! + bits.read(OF.bits[sOF]!);
    }
  }
  if (bits.bits !== 0) throw new ZstdError('sequence stream not consumed exactly');
  out.append(literals, lit, literals.length);
}

/** Decompresses one or more zstd frames (skippable frames are passed over). */
export function zstdDecompress(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Output(bytes.length * 4);
  let p = 0;
  while (p + 4 <= bytes.length) {
    const magic = dv.getUint32(p, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      p += 8 + dv.getUint32(p + 4, true);
      continue;
    }
    if (magic !== MAGIC) throw new ZstdError('not zstd data');
    p += 4;
    const fhd = bytes[p++]!;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    if (fhd & 8) throw new ZstdError('reserved bit set');
    const checksum = (fhd >> 2) & 1;
    const dictSize = [0, 1, 2, 4][fhd & 3]!;
    if (!single) p++;
    let dict = 0;
    for (let i = 0; i < dictSize; i++) dict |= bytes[p + i]! << (8 * i);
    if (dict !== 0) throw new ZstdError('zstd dictionaries are not supported');
    p += dictSize;
    const fcsSize = fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]!;
    let contentSize = -1;
    if (fcsSize === 1) contentSize = bytes[p]!;
    else if (fcsSize === 2) contentSize = dv.getUint16(p, true) + 256;
    else if (fcsSize === 4) contentSize = dv.getUint32(p, true);
    else if (fcsSize === 8) contentSize = dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 2 ** 32;
    p += fcsSize;
    if (contentSize > 0) out.ensure(contentSize);
    const frameStart = out.len;
    const state: FrameState = { huffman: null, ll: null, of: null, ml: null, rep: [1, 4, 8] };
    for (;;) {
      if (p + 3 > bytes.length) throw new ZstdError('truncated block header');
      const h = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
      p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      if (type === 0) {
        if (p + size > bytes.length) throw new ZstdError('truncated block');
        out.append(bytes, p, p + size);
        p += size;
      } else if (type === 1) {
        out.ensure(size);
        out.buf.fill(bytes[p]!, out.len, out.len + size);
        out.len += size;
        p += 1;
      } else if (type === 2) {
        if (p + size > bytes.length) throw new ZstdError('truncated block');
        decodeBlock(bytes, p, p + size, out, state, frameStart);
        p += size;
      } else {
        throw new ZstdError('reserved block type');
      }
      if (last) break;
    }
    if (contentSize >= 0 && out.len - frameStart !== contentSize) throw new ZstdError('wrong content size');
    if (checksum) p += 4;
  }
  return out.buf.slice(0, out.len);
}

export function isZstd(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}
