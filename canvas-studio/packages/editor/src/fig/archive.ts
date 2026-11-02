// A .fig file from "Save local copy": a ZIP with canvas.fig (the document),
// images/<sha1> (pictures by their hash), meta.json and a preview. Older
// copies are canvas.fig alone. canvas.fig is "fig-kiwi", a version and
// length-prefixed chunks: the schema, then the document, each compressed
// with deflate or zstd.

import { decodeMessage, decodeSchema } from './kiwi.ts';
import { isZstd, zstdDecompress } from './zstd.ts';

export class FigError extends Error {}

export interface FigArchive {
  /** The document as the schema describes it ({nodeChanges, blobs, …}). */
  message: Record<string, unknown>;
  /** Pictures by the hex of their hash. */
  images: Map<string, Uint8Array>;
  /** FigJam boards are not design files. */
  kind: 'design' | 'figjam';
  version: number;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries of a ZIP by name (stored or deflated), read through the central directory. */
export async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FigError('broken ZIP: no central directory');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new FigError('broken ZIP entry');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !wanted(name)) continue;
    if (dv.getUint32(local, true) !== 0x04034b50) throw new FigError('broken ZIP entry');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new FigError(`unsupported ZIP compression ${method}`);
  }
  return out;
}

async function unpackChunk(chunk: Uint8Array): Promise<Uint8Array> {
  if (isZstd(chunk)) return zstdDecompress(chunk);
  return inflateRaw(chunk);
}

/** Reads canvas.fig: the header, the schema and the document. */
export async function readCanvas(bytes: Uint8Array): Promise<{ message: Record<string, unknown>; kind: 'design' | 'figjam'; version: number }> {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  if (head !== 'fig-kiwi' && head !== 'fig-jam.') throw new FigError('not a Figma file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let p = 12;
  while (p + 4 <= bytes.length) {
    const n = dv.getUint32(p, true);
    if (p + 4 + n > bytes.length) throw new FigError('truncated Figma file');
    chunks.push(bytes.subarray(p + 4, p + 4 + n));
    p += 4 + n;
  }
  if (chunks.length < 2) throw new FigError('no document in the Figma file');
  const schema = decodeSchema(await unpackChunk(chunks[0]!));
  const message = decodeMessage(schema, await unpackChunk(chunks[1]!));
  return { message, kind: head === 'fig-jam.' ? 'figjam' : 'design', version };
}

/** Opens a .fig (ZIP or a bare canvas). */
export async function readFig(bytes: Uint8Array): Promise<FigArchive> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  let canvas = bytes;
  const images = new Map<string, Uint8Array>();
  if (isZip) {
    const files = await unzip(bytes, (name) => name === 'canvas.fig' || name.startsWith('images/'));
    const c = files.get('canvas.fig');
    if (!c) throw new FigError('no canvas.fig in the archive');
    canvas = c;
    for (const [name, data] of files) if (name.startsWith('images/')) images.set(name.slice(7).toLowerCase(), data);
  }
  const { message, kind, version } = await readCanvas(canvas);
  return { message, images, kind, version };
}
