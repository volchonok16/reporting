// Version history (stage 8, part 5). A version is a copy of the file's
// snapshot with when, who changed it since the previous one, and — for a
// version someone saved on purpose — a name and a description.
//
// Storage, so that history does not eat the disk:
//   files/<id>/versions.json   the list (with the pictures each version uses)
//   files/<id>/v<hex>.gz       a version's document, gzip, without pictures
//   files/<id>/b<sha256>       each picture once, as bytes, shared by all versions
// Pictures are most of a file's weight and rarely change between versions:
// kept once, a version of an ordinary layout weighs tens of kilobytes.
// Older versions written as whole snapshots (v<hex>.json) are still read and
// are converted the next time a version is added.
//
// Automatic versions: when the last person leaves the file, and at most every
// ten minutes while people work; none while the disk is nearly full (named
// ones still are). They are thinned with age (one a day after a month, at most
// 200); named versions are kept until the file is deleted. Pictures no
// version uses any more are removed.

import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { BlobStore } from './storage.ts';

export interface VersionEntry {
  id: string;
  at: number;
  /** Who changed the file since the previous version. */
  authors: string[];
  /** Saved on purpose (kept forever); none — automatic. */
  name?: string;
  description?: string;
  /** Who saved it on purpose. */
  by?: string;
  /** Pictures of the version (b<hash> files); absent — an old whole-snapshot version. */
  blobs?: string[];
}

export const AUTO_EVERY = 10 * 60_000;
const AUTO_LIMIT = 200;
const DAY = 86_400_000;
const MB = 1024 * 1024;
/** Below this, automatic versions wait; below twice this, the log warns. */
export const DISK_RESERVE = 500 * MB;
const HASH = /^[a-f0-9]{64}$/;

export function parseVersions(text: string | null): VersionEntry[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list as VersionEntry[]) : [];
  } catch {
    return [];
  }
}

/** Which automatic versions to drop: older than a month — one a day; never more than the limit. */
export function thin(list: readonly VersionEntry[], now = Date.now()): VersionEntry[] {
  const keep: VersionEntry[] = [];
  const days = new Set<number>();
  // Newest first, so the last version of each old day is the one kept.
  for (const v of [...list].sort((a, b) => b.at - a.at)) {
    if (v.name) {
      keep.push(v);
      continue;
    }
    if (now - v.at > 30 * DAY) {
      const day = Math.floor(v.at / DAY);
      if (days.has(day)) continue;
      days.add(day);
    }
    keep.push(v);
  }
  const autos = keep.filter((v) => !v.name);
  const drop = new Set(autos.slice(AUTO_LIMIT).map((v) => v.id));
  return keep.filter((v) => !drop.has(v.id)).sort((a, b) => a.at - b.at);
}

interface StoredSnapshot {
  blobs?: Record<string, { mime: string; data: string }>;
  /** Pictures taken out to b<hash> files: their types. */
  blobMimes?: Record<string, string>;
  [key: string]: unknown;
}

export class Versions {
  private readonly files: BlobStore;
  private readonly log: (line: string) => void;
  private disk: { at: number; free: number } | null = null;
  /** Changes of one file's history run one after another (a clean-up must not remove a picture just written). */
  private readonly queues = new Map<string, Promise<unknown>>();

  private queued<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(fileId) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(fileId, tail);
    void tail.then(() => {
      if (this.queues.get(fileId) === tail) this.queues.delete(fileId);
    });
    return next;
  }

  constructor(files: BlobStore, log: (line: string) => void = () => undefined) {
    this.files = files;
    this.log = log;
  }

  async list(fileId: string): Promise<VersionEntry[]> {
    return parseVersions(await this.files.read(fileId, 'versions.json'));
  }

  /** A version as a whole snapshot (pictures put back), or null. */
  async snapshot(fileId: string, versionId: string): Promise<string | null> {
    if (!/^v[a-f0-9]{12}$/.test(versionId)) return null;
    const packed = await this.files.readBytes(fileId, `${versionId}.gz`);
    if (!packed) return this.files.read(fileId, `${versionId}.json`);
    const doc = JSON.parse(gunzipSync(packed).toString('utf8')) as StoredSnapshot;
    const mimes = doc.blobMimes ?? {};
    delete doc.blobMimes;
    const blobs: Record<string, { mime: string; data: string }> = {};
    for (const [hash, mime] of Object.entries(mimes)) {
      const bytes = HASH.test(hash) ? await this.files.readBytes(fileId, `b${hash}`) : null;
      if (bytes) blobs[hash] = { mime, data: bytes.toString('base64') };
    }
    if (Object.keys(blobs).length) doc.blobs = blobs;
    return JSON.stringify(doc);
  }

  /** Writes a version's document without its pictures (each picture stored once). Returns the picture hashes. */
  private async store(fileId: string, versionId: string, snapshot: string): Promise<string[]> {
    const doc = JSON.parse(snapshot) as StoredSnapshot;
    const blobs = doc.blobs ?? {};
    delete doc.blobs;
    const mimes: Record<string, string> = {};
    const have = new Set(await this.files.list(fileId));
    for (const [hash, blob] of Object.entries(blobs)) {
      if (!HASH.test(hash)) continue;
      mimes[hash] = blob.mime;
      if (!have.has(`b${hash}`)) await this.files.write(fileId, `b${hash}`, Buffer.from(blob.data, 'base64'));
    }
    if (Object.keys(mimes).length) doc.blobMimes = mimes;
    await this.files.write(fileId, `${versionId}.gz`, gzipSync(JSON.stringify(doc), { level: 9 }));
    return Object.keys(mimes);
  }

  /** Free space for version GC; checked at most every ten minutes. */
  private async freeSpace(): Promise<number> {
    const now = Date.now();
    if (!this.disk || now - this.disk.at > 10 * 60_000) {
      try {
        if (this.files.freeSpaceBytes) {
          this.disk = { at: now, free: await this.files.freeSpaceBytes() };
        } else {
          const s = await statfs(this.files.root);
          this.disk = { at: now, free: s.bavail * s.bsize };
          if (this.disk.free < DISK_RESERVE * 2) {
            this.log(
              `мало места на диске: свободно ${Math.round(this.disk.free / MB)} МБ — автоматические версии ${this.disk.free < DISK_RESERVE ? 'не сохраняются' : 'скоро перестанут сохраняться'}`,
            );
          }
        }
      } catch {
        this.disk = { at: now, free: Number.POSITIVE_INFINITY };
      }
    }
    return this.disk.free;
  }

  /**
   * Keeps the snapshot as a version. An automatic one is skipped when the
   * previous version is younger than ten minutes (unless `force`, e.g. the
   * last person left), nobody changed anything, or the disk is nearly full.
   */
  add(fileId: string, snapshot: string, entry: { authors: string[]; name?: string; description?: string; by?: string; force?: boolean }, now = Date.now()): Promise<VersionEntry | null> {
    return this.queued(fileId, () => this.addNow(fileId, snapshot, entry, now));
  }

  private async addNow(fileId: string, snapshot: string, entry: { authors: string[]; name?: string; description?: string; by?: string; force?: boolean }, now: number): Promise<VersionEntry | null> {
    const list = await this.list(fileId);
    const last = list[list.length - 1];
    if (!entry.name) {
      if (entry.authors.length === 0 && last) return null;
      if (!entry.force && last && now - last.at < AUTO_EVERY) return null;
      if ((await this.freeSpace()) < DISK_RESERVE) return null;
    }
    const id = `v${randomBytes(6).toString('hex')}`;
    const blobs = await this.store(fileId, id, snapshot);
    const version: VersionEntry = {
      id,
      at: now,
      authors: [...new Set(entry.authors)],
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.by ? { by: entry.by } : {}),
      blobs,
    };
    await this.update(fileId, (all) => [...all, version], now);
    await this.compact(fileId);
    return version;
  }

  /** Changes the list, thins it, and removes the files of dropped versions and unused pictures. */
  private async update(fileId: string, fn: (list: VersionEntry[]) => VersionEntry[], now = Date.now()): Promise<void> {
    let dropped: VersionEntry[] = [];
    let kept: VersionEntry[] = [];
    await this.files.update(fileId, 'versions.json', (text) => {
      const all = fn(parseVersions(text));
      kept = thin(all, now);
      const ids = new Set(kept.map((v) => v.id));
      dropped = all.filter((v) => !ids.has(v.id));
      return JSON.stringify(kept);
    });
    for (const v of dropped) {
      await this.files.removeFile(fileId, `${v.id}.gz`);
      await this.files.removeFile(fileId, `${v.id}.json`);
    }
    if (dropped.length) await this.collect(fileId, kept);
  }

  /** Removes pictures no version uses any more. */
  private async collect(fileId: string, kept: readonly VersionEntry[]): Promise<void> {
    const used = new Set(kept.flatMap((v) => v.blobs ?? []));
    for (const name of await this.files.list(fileId)) {
      if (name.startsWith('b') && HASH.test(name.slice(1)) && !used.has(name.slice(1))) await this.files.removeFile(fileId, name);
    }
  }

  /** Old whole-snapshot versions (v<hex>.json) become the compact form. */
  private async compact(fileId: string): Promise<void> {
    const list = await this.list(fileId);
    const old = list.filter((v) => !v.blobs);
    if (!old.length) return;
    const converted = new Map<string, string[]>();
    for (const v of old) {
      const text = await this.files.read(fileId, `${v.id}.json`);
      if (!text) continue;
      try {
        converted.set(v.id, await this.store(fileId, v.id, text));
      } catch (error) {
        this.log(`версия ${fileId}/${v.id} не переведена в сжатый вид: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.files.update(fileId, 'versions.json', (text) => JSON.stringify(parseVersions(text).map((v) => (converted.has(v.id) ? { ...v, blobs: converted.get(v.id) } : v))));
    for (const id of converted.keys()) await this.files.removeFile(fileId, `${id}.json`);
  }

  /** Names (or renames) a version; a named version is kept forever. */
  async rename(fileId: string, versionId: string, name: string, description: string | undefined, by: string): Promise<VersionEntry | null> {
    let found: VersionEntry | null = null;
    await this.files.update(fileId, 'versions.json', (text) => {
      const list = parseVersions(text);
      const v = list.find((x) => x.id === versionId);
      if (!v) return undefined;
      v.name = name;
      if (description !== undefined) v.description = description || undefined;
      v.by ??= by;
      found = v;
      return JSON.stringify(list);
    });
    return found;
  }

  /** Bytes the history of a file takes (for the record and future limits). */
  async size(fileId: string): Promise<number> {
    let total = 0;
    for (const name of await this.files.list(fileId)) {
      if (name === 'versions.json' || /^v[a-f0-9]{12}\.(gz|json)$/.test(name) || /^b[a-f0-9]{64}$/.test(name)) {
        total += await this.files.sizeOf(fileId, name);
      }
    }
    return total;
  }
}
