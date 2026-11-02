// PostgreSQL backend for Simmetrika storage (reporting). Same surface as JsonStore / FileBlobs.
// Driver: npm package `pg` (ставится в Docker-образе reporting). Без CS_DATABASE_URL — не используется.

import { randomBytes } from 'node:crypto';
import { isSafeId, type BlobStore } from './storage.ts';

export type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end: () => Promise<void>;
};

type PgModule = {
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
};

let pgModule: PgModule | null = null;

async function loadPg(): Promise<PgModule> {
  if (pgModule) return pgModule;
  try {
    pgModule = (await import('pg')) as unknown as PgModule;
  } catch {
    throw new Error(
      'Модуль pg не установлен. В образе canvas-studio нужен: npm install pg. Либо уберите CS_DATABASE_URL.',
    );
  }
  return pgModule;
}

export async function createPgPool(connectionString: string): Promise<PgPool> {
  const { Pool } = await loadPg();
  const pool = new Pool({ connectionString, max: 10 });
  await pool.query('SELECT 1');
  return pool;
}

/** Идемпотентно создаёт таблицы (на случай старта canvas до миграции backend). */
export async function ensureSimmetrikaSchema(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS simmetrika_kv (
      bucket TEXT NOT NULL,
      id TEXT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bucket, id)
    );
    CREATE INDEX IF NOT EXISTS ix_simmetrika_kv_bucket ON simmetrika_kv (bucket);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_simmetrika_users_email
      ON simmetrika_kv (lower(payload->>'email'))
      WHERE bucket = 'users' AND payload->>'email' IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_simmetrika_sessions_user
      ON simmetrika_kv ((payload->>'userId'))
      WHERE bucket = 'sessions';
    CREATE TABLE IF NOT EXISTS simmetrika_blob (
      file_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (file_id, name)
    );
    CREATE INDEX IF NOT EXISTS ix_simmetrika_blob_file ON simmetrika_blob (file_id);
    CREATE TABLE IF NOT EXISTS simmetrika_secret (
      id TEXT PRIMARY KEY DEFAULT 'default',
      value BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/** Serialises async work per key (as on disk). */
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

export class PgJsonStore<T> {
  private readonly pool: PgPool;
  private readonly bucket: string;
  private readonly cache = new Map<string, T>();
  private readonly queue = new KeyedQueue();
  private known: Set<string> | null = null;
  onWrite: ((id: string, before: T | null, after: T | null) => void) | null = null;

  constructor(pool: PgPool, bucket: string) {
    this.pool = pool;
    this.bucket = bucket;
  }

  async get(id: string): Promise<T | null> {
    if (!id) return null;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const res = await this.pool.query('SELECT payload FROM simmetrika_kv WHERE bucket = $1 AND id = $2', [
      this.bucket,
      id,
    ]);
    if (!res.rows[0]) return null;
    const value = res.rows[0].payload as T;
    this.cache.set(id, value);
    return value;
  }

  async put(id: string, value: T): Promise<void> {
    return this.queue.run(id, async () => {
      const before = this.onWrite ? await this.get(id) : null;
      await this.pool.query(
        `INSERT INTO simmetrika_kv (bucket, id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (bucket, id) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [this.bucket, id, JSON.stringify(value)],
      );
      this.cache.set(id, value);
      this.known?.add(id);
      this.onWrite?.(id, before, value);
    });
  }

  async update(id: string, fn: (current: T | null) => T | null | undefined): Promise<T | null> {
    return this.queue.run(id, async () => {
      const current = await this.get(id);
      const next = fn(current);
      if (next === undefined) return current;
      if (next === null) {
        await this.pool.query('DELETE FROM simmetrika_kv WHERE bucket = $1 AND id = $2', [this.bucket, id]);
        this.cache.delete(id);
        this.known?.delete(id);
        this.onWrite?.(id, current, null);
        return null;
      }
      await this.pool.query(
        `INSERT INTO simmetrika_kv (bucket, id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (bucket, id) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [this.bucket, id, JSON.stringify(next)],
      );
      this.cache.set(id, next);
      this.known?.add(id);
      this.onWrite?.(id, current, next);
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    return this.queue.run(id, async () => {
      const before = this.onWrite ? await this.get(id) : null;
      await this.pool.query('DELETE FROM simmetrika_kv WHERE bucket = $1 AND id = $2', [this.bucket, id]);
      this.cache.delete(id);
      this.known?.delete(id);
      if (before) this.onWrite?.(id, before, null);
    });
  }

  async ids(): Promise<string[]> {
    if (this.known) return [...this.known];
    const res = await this.pool.query('SELECT id FROM simmetrika_kv WHERE bucket = $1', [this.bucket]);
    const found = res.rows.map((r) => String(r.id));
    this.known = new Set(found);
    for (const id of this.cache.keys()) this.known.add(id);
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

  /** Lookup by JSON field (e.g. email) without loading the whole bucket. */
  async findIdByField(field: string, value: string): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT id FROM simmetrika_kv
       WHERE bucket = $1 AND lower(payload->>$2) = lower($3)
       LIMIT 1`,
      [this.bucket, field, value],
    );
    return res.rows[0] ? String(res.rows[0].id) : null;
  }
}

export class PgFileBlobs implements BlobStore {
  private readonly pool: PgPool;
  private readonly queue = new KeyedQueue();
  /** Для Versions.statfs — каталог с запасным местом на ФС контейнера. */
  readonly root: string;

  constructor(pool: PgPool, root: string) {
    this.pool = pool;
    this.root = root;
  }

  /** Blobs live in PostgreSQL — local `/data` free space must not gate versions. */
  async freeSpaceBytes(): Promise<number> {
    return Number.POSITIVE_INFINITY;
  }

  async read(id: string, name: string): Promise<string | null> {
    const bytes = await this.readBytes(id, name);
    return bytes ? bytes.toString('utf8') : null;
  }

  async readBytes(id: string, name: string): Promise<Buffer | null> {
    if (!isSafeId(id) || !name) return null;
    const res = await this.pool.query('SELECT content FROM simmetrika_blob WHERE file_id = $1 AND name = $2', [
      id,
      name,
    ]);
    const row = res.rows[0];
    if (!row) return null;
    const content = row.content;
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    // node-pg may return Buffer-like or hex depending on types
    if (typeof content === 'string') return Buffer.from(content, 'hex');
    return Buffer.from(content as ArrayBuffer);
  }

  async write(id: string, name: string, data: string | Uint8Array): Promise<void> {
    if (!isSafeId(id)) throw new Error(`Недопустимый идентификатор: ${id.slice(0, 40)}`);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return this.queue.run(`${id}/${name}`, async () => {
      await this.pool.query(
        `INSERT INTO simmetrika_blob (file_id, name, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (file_id, name) DO UPDATE
           SET content = EXCLUDED.content, updated_at = NOW()`,
        [id, name, buf],
      );
    });
  }

  async update(id: string, name: string, fn: (current: string | null) => string | undefined): Promise<string | null> {
    if (!isSafeId(id)) throw new Error(`Недопустимый идентификатор: ${id.slice(0, 40)}`);
    return this.queue.run(`${id}/${name}`, async () => {
      const current = await this.read(id, name);
      const next = fn(current);
      if (next === undefined) return current;
      const buf = Buffer.from(next, 'utf8');
      await this.pool.query(
        `INSERT INTO simmetrika_blob (file_id, name, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (file_id, name) DO UPDATE
           SET content = EXCLUDED.content, updated_at = NOW()`,
        [id, name, buf],
      );
      return next;
    });
  }

  async list(id: string): Promise<string[]> {
    if (!isSafeId(id)) return [];
    const res = await this.pool.query('SELECT name FROM simmetrika_blob WHERE file_id = $1', [id]);
    return res.rows.map((r) => String(r.name));
  }

  async sizeOf(id: string, name: string): Promise<number> {
    if (!isSafeId(id)) return 0;
    const res = await this.pool.query(
      'SELECT octet_length(content) AS n FROM simmetrika_blob WHERE file_id = $1 AND name = $2',
      [id, name],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async removeFile(id: string, name: string): Promise<void> {
    if (!isSafeId(id)) return;
    return this.queue.run(`${id}/${name}`, async () => {
      await this.pool.query('DELETE FROM simmetrika_blob WHERE file_id = $1 AND name = $2', [id, name]);
    });
  }

  async remove(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    return this.queue.run(id, async () => {
      await this.pool.query('DELETE FROM simmetrika_blob WHERE file_id = $1', [id]);
    });
  }
}

export async function loadOrCreatePgSecret(pool: PgPool, makeKey: (n: number) => Buffer = randomBytes): Promise<Uint8Array> {
  const existing = await pool.query(`SELECT value FROM simmetrika_secret WHERE id = 'default'`);
  if (existing.rows[0]?.value) {
    const v = existing.rows[0].value;
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array);
    if (buf.length >= 32) return buf;
  }
  const key = makeKey(32);
  await pool.query(
    `INSERT INTO simmetrika_secret (id, value, updated_at)
     VALUES ('default', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key],
  );
  return key;
}

export type PgStorageBundle = {
  pool: PgPool;
  users: PgJsonStore<unknown>;
  sessions: PgJsonStore<unknown>;
  files: PgJsonStore<unknown>;
  codes: PgJsonStore<unknown>;
  projects: PgJsonStore<unknown>;
  teams: PgJsonStore<unknown>;
  blobs: PgFileBlobs;
  secretLoader: () => Promise<Uint8Array>;
};

/** Open PostgreSQL stores for Simmetrika (CS_DATABASE_URL). */
export async function openPgStorage(connectionString: string, dataDir: string): Promise<PgStorageBundle> {
  const pool = await createPgPool(connectionString);
  await ensureSimmetrikaSchema(pool);
  return {
    pool,
    users: new PgJsonStore(pool, 'users'),
    sessions: new PgJsonStore(pool, 'sessions'),
    files: new PgJsonStore(pool, 'files-meta'),
    codes: new PgJsonStore(pool, 'codes'),
    projects: new PgJsonStore(pool, 'projects'),
    teams: new PgJsonStore(pool, 'teams'),
    blobs: new PgFileBlobs(pool, dataDir),
    secretLoader: () => loadOrCreatePgSecret(pool),
  };
}

export async function pgHealthCheck(pool: PgPool): Promise<{ ok: true; storage: 'postgres' }> {
  await pool.query('SELECT 1 FROM simmetrika_kv LIMIT 0');
  return { ok: true, storage: 'postgres' };
}
