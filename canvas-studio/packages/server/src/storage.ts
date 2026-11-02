// Storage on disk (own format, no database): every record is a JSON file,
// written atomically — to a temporary file, flushed, then renamed over the old
// one — so a crash or power loss leaves either the old or the new version,
// never a half-written file. Writes to the same key are queued so they never
// interleave. Ids are checked against a strict pattern before touching the
// file system: no path can escape the data directory.
//
// Layout:
//   <root>/users/<id>.json             account
//   <root>/sessions/<tokenHash>.json   login session
//   <root>/files-meta/<id>.json        file record (owner, name, version)
//   <root>/files/<id>/snapshot.json    the document
//   <root>/files/<id>/thumbnail        preview for the file browser (PNG/JPEG/WebP)
//   <root>/files/<id>/comments.json    discussions on the canvas
//   <root>/files/<id>/versions.json    version history; v<hex>.json — each version
//   <root>/projects/<id>.json          project (a folder of files)
//   <root>/codes/<purpose>_<user>.json one-time code from a letter (email check, password reset)

import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9_-]{6,128}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

function assertId(id: string): void {
  if (!isSafeId(id)) throw new Error(`Недопустимый идентификатор: ${id.slice(0, 40)}`);
}

/** Writes a file atomically: temp file, fsync, rename. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

/** Serialises async work per key. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** A directory of JSON records with an in-memory cache. */
export class JsonStore<T> {
  private readonly dir: string;
  private readonly cache = new Map<string, T>();
  private readonly queue = new KeyedQueue();
  private ready: Promise<void> | null = null;
  /** Ids on disk, read once (PERF-006): every list asked the directory again. Kept by put, update and delete. */
  private known: Set<string> | null = null;
  /** Told after every write of a record (null — deleted): indexes of the API follow. */
  onWrite: ((id: string, before: T | null, after: T | null) => void) | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private init(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  private path(id: string): string {
    assertId(id);
    return join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<T | null> {
    if (!isSafeId(id)) return null;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    await this.init();
    const text = await readText(this.path(id));
    if (text === null) return null;
    const value = JSON.parse(text) as T;
    this.cache.set(id, value);
    return value;
  }

  async put(id: string, value: T): Promise<void> {
    const path = this.path(id);
    return this.queue.run(id, async () => {
      await this.init();
      const before = this.onWrite ? await this.get(id) : null;
      await writeAtomic(path, JSON.stringify(value));
      this.cache.set(id, value);
      this.known?.add(id);
      this.onWrite?.(id, before, value);
    });
  }

  /** Read-modify-write under the key's queue; return null to delete, undefined to leave as is. */
  async update(id: string, fn: (current: T | null) => T | null | undefined): Promise<T | null> {
    const path = this.path(id);
    return this.queue.run(id, async () => {
      await this.init();
      const text = this.cache.has(id) ? null : await readText(path);
      const current = this.cache.get(id) ?? (text === null ? null : (JSON.parse(text) as T));
      const next = fn(current);
      if (next === undefined) return current;
      if (next === null) {
        await rm(path, { force: true });
        this.cache.delete(id);
        this.known?.delete(id);
        this.onWrite?.(id, current, null);
        return null;
      }
      await writeAtomic(path, JSON.stringify(next));
      this.cache.set(id, next);
      this.known?.add(id);
      this.onWrite?.(id, current, next);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    const path = this.path(id);
    return this.queue.run(id, async () => {
      const before = this.onWrite ? await this.get(id) : null;
      await rm(path, { force: true });
      this.cache.delete(id);
      this.known?.delete(id);
      if (before) this.onWrite?.(id, before, null);
    });
  }

  async ids(): Promise<string[]> {
    if (this.known) return [...this.known];
    await this.init();
    const names = await readdir(this.dir);
    const found = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter(isSafeId);
    // Records written while the directory was being read are in the cache: they count too.
    if (!this.known) {
      this.known = new Set(found);
      for (const id of this.cache.keys()) this.known.add(id);
    }
    return [...this.known];
  }

  async all(): Promise<T[]> {
    const out: T[] = [];
    for (const id of await this.ids()) {
      const v = await this.get(id);
      if (v !== null) out.push(v);
    }
    return out;
  }
}

/** Blob backend (disk FileBlobs or PostgreSQL PgFileBlobs). */
export interface BlobStore {
  readonly root: string;
  /**
   * Free bytes for version GC. When omitted, Versions uses `statfs(root)`.
   * PostgreSQL returns Infinity — disk of `/data` is not the blob store.
   */
  freeSpaceBytes?(): Promise<number>;
  read(id: string, name: string): Promise<string | null>;
  readBytes(id: string, name: string): Promise<Buffer | null>;
  write(id: string, name: string, data: string | Uint8Array): Promise<void>;
  update(id: string, name: string, fn: (current: string | null) => string | undefined): Promise<string | null>;
  list(id: string): Promise<string[]>;
  sizeOf(id: string, name: string): Promise<number>;
  removeFile(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Large documents: one directory per file with its meta record and snapshot. */
export class FileBlobs implements BlobStore {
  private readonly dir: string;
  private readonly queue = new KeyedQueue();

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(id: string, name: string): string {
    assertId(id);
    return join(this.dir, id, name);
  }

  async read(id: string, name: string): Promise<string | null> {
    if (!isSafeId(id)) return null;
    return readText(this.path(id, name));
  }

  async readBytes(id: string, name: string): Promise<Buffer | null> {
    if (!isSafeId(id)) return null;
    try {
      return await readFile(this.path(id, name));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(id: string, name: string, data: string | Uint8Array): Promise<void> {
    const path = this.path(id, name);
    return this.queue.run(`${id}/${name}`, async () => {
      await mkdir(join(this.dir, id), { recursive: true });
      await writeAtomic(path, data);
    });
  }

  /** Read-modify-write of a text file under its queue; return undefined to leave it as is. */
  async update(id: string, name: string, fn: (current: string | null) => string | undefined): Promise<string | null> {
    const path = this.path(id, name);
    return this.queue.run(`${id}/${name}`, async () => {
      const current = await readText(path);
      const next = fn(current);
      if (next === undefined) return current;
      await mkdir(join(this.dir, id), { recursive: true });
      await writeAtomic(path, next);
      return next;
    });
  }

  /** The directory all records live in (for free-space checks). */
  get root(): string {
    return this.dir;
  }

  /** Names of the files of a record. */
  async list(id: string): Promise<string[]> {
    if (!isSafeId(id)) return [];
    try {
      return await readdir(join(this.dir, id));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Size of one file of a record in bytes (0 when there is none). */
  async sizeOf(id: string, name: string): Promise<number> {
    if (!isSafeId(id)) return 0;
    try {
      return (await stat(this.path(id, name))).size;
    } catch {
      return 0;
    }
  }

  /** Removes one file of a record (a dropped version). */
  async removeFile(id: string, name: string): Promise<void> {
    const path = this.path(id, name);
    return this.queue.run(`${id}/${name}`, () => rm(path, { force: true }));
  }

  async remove(id: string): Promise<void> {
    assertId(id);
    return this.queue.run(id, () => rm(join(this.dir, id), { recursive: true, force: true }));
  }
}
