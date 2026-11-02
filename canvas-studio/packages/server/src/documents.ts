// How a file's document is kept on disk.
//
//   files/<id>/snapshot.json   the document without its pictures, with "blobMimes": {hash: type}
//   files/<id>/i<sha256>       each picture once, as bytes
//
// Pictures are most of a file's weight and almost never change, while the
// document changes all the time: the live room writes only the document
// (a few hundred kilobytes instead of megabytes every few seconds), and the
// pictures are put back only when the whole file is needed — opening it,
// sending it to a newcomer, a version. Files written before (pictures inside
// snapshot.json) are read as they are and take this form on the next save.

import { fromSnapshot, toSnapshot, type Document, type Snapshot } from '../../core/src/index.ts';
import type { BlobStore } from './storage.ts';

const HASH = /^[a-f0-9]{64}$/;

type Stored = Snapshot & { blobMimes?: Record<string, string> };

export const imageName = (hash: string) => `i${hash}`;

export class Documents {
  private readonly files: BlobStore;

  constructor(files: BlobStore) {
    this.files = files;
  }

  /** The whole document with its pictures (as a client loads it), or null. */
  async read(id: string): Promise<string | null> {
    const raw = await this.files.read(id, 'snapshot.json');
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    if (!stored.blobMimes) return raw;
    const mimes = stored.blobMimes;
    delete stored.blobMimes;
    return this.withPictures(id, JSON.stringify(stored), Object.entries(mimes).map(([hash, mime]) => ({ hash, mime, data: null })));
  }

  /**
   * Puts pictures after a document text without them. Pictures given with
   * data are used as they are; the others are read from disk.
   */
  async withPictures(id: string, head: string, pictures: { hash: string; mime: string; data: string | null }[]): Promise<string> {
    if (pictures.length === 0) return head;
    const parts: string[] = [];
    for (const p of pictures) {
      const data = p.data || (HASH.test(p.hash) ? (await this.files.readBytes(id, imageName(p.hash)))?.toString('base64') : null);
      if (data) parts.push(`${JSON.stringify(p.hash)}:${JSON.stringify({ mime: p.mime, data })}`);
    }
    return `${head.slice(0, -1)},"blobs":{${parts.join(',')}}}`;
  }

  /** Saves a whole document (from a client): pictures to their files, the rest to snapshot.json. */
  async write(id: string, text: string): Promise<void> {
    const snap = JSON.parse(text) as Stored;
    const blobs = snap.blobs ?? {};
    delete snap.blobs;
    const have = new Set(await this.files.list(id));
    const mimes: Record<string, string> = { ...(snap.blobMimes ?? {}) };
    for (const [hash, blob] of Object.entries(blobs)) {
      if (!HASH.test(hash)) continue;
      mimes[hash] = blob.mime;
      if (!have.has(imageName(hash))) await this.files.write(id, imageName(hash), Buffer.from(blob.data, 'base64'));
    }
    if (Object.keys(mimes).length) snap.blobMimes = mimes;
    await this.files.write(id, 'snapshot.json', JSON.stringify(snap));
  }

  /** A picture's bytes are kept (once). */
  async putPicture(id: string, hash: string, data: string): Promise<void> {
    if (!HASH.test(hash)) return;
    await this.files.write(id, imageName(hash), Buffer.from(data, 'base64'));
  }

  async pictureData(id: string, hash: string): Promise<string | null> {
    const bytes = HASH.test(hash) ? await this.files.readBytes(id, imageName(hash)) : null;
    return bytes ? bytes.toString('base64') : null;
  }

  /**
   * Opens a document for the live room: without picture data when the file is
   * in the new form (the room only needs to know which pictures exist).
   * `inline` — pictures that were inside an old snapshot (to be written out).
   */
  async open(id: string): Promise<{ doc: Document; inline: [string, { mime: string; data: string }][] } | null> {
    const raw = await this.files.read(id, 'snapshot.json');
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    const mimes = stored.blobMimes ?? {};
    delete stored.blobMimes;
    const doc = fromSnapshot(stored);
    for (const [hash, mime] of Object.entries(mimes)) if (!doc.store.blobs.has(hash)) doc.store.blobs.set(hash, { mime, data: '' });
    return { doc, inline: [...doc.store.blobs].filter(([, b]) => b.data !== '') };
  }

  /** The document text as stored: without picture data, with their types. */
  static stored(doc: Document): string {
    const snap = toSnapshot(doc) as Stored;
    const blobs = snap.blobs ?? {};
    delete snap.blobs;
    const mimes = Object.fromEntries(Object.entries(blobs).map(([hash, b]) => [hash, b.mime]));
    if (Object.keys(mimes).length) snap.blobMimes = mimes;
    return JSON.stringify(snap);
  }
}
