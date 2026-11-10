// Server files without a network (Figma users' complaint: no internet — no
// work). Every server file this person opens is kept here too, with the
// changes the server has not confirmed yet. Without a network the editor opens
// that copy; the changes wait here (closing the tab does not lose them) and go
// to the server on the next connection — the document core merges them with
// whatever others did meanwhile, like any other operations.
// Also remembered: who was signed in, so the app starts as them while offline.

import type { Op } from '#core';
import type { Role } from './storage.ts';

const DB = 'canvas-studio-offline';
const STORE = 'files';
const USER_KEY = 'cs.offline.user';

export interface OfflineFile {
  id: string;
  /** Account the copy belongs to (another account on this computer does not see it). */
  userId: string;
  name: string;
  snapshot: string;
  /** Server version the copy started from (the server sends what changed since). */
  version: number;
  role: Role;
  savedAt: number;
  /** Changes not yet confirmed by the server. */
  pending: Op[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
    });
  } finally {
    db.close();
  }
}

/**
 * How a copy is kept: the unconfirmed changes as one JSON text. IndexedDB
 * clones what it stores on the main thread; thousands of small objects (one
 * big paste) took the tab away for minutes, one string is copied at once.
 */
type Stored = Omit<OfflineFile, 'pending'> & { pending?: Op[]; pendingText?: string };

function toStored(file: OfflineFile): Stored {
  const { pending, ...rest } = file;
  return { ...rest, pendingText: JSON.stringify(pending) };
}

function fromStored(stored: Stored): OfflineFile {
  const { pendingText, pending, ...rest } = stored;
  let ops: Op[] = pending ?? [];
  if (pendingText) {
    try {
      ops = JSON.parse(pendingText) as Op[];
    } catch {
      ops = [];
    }
  }
  return { ...rest, pending: ops };
}

/** Writes are queued per file, so a slow write never lands after a newer one. */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  queues.set(id, next.catch(() => undefined));
  return next;
}

export const offline = {
  async get(id: string, userId: string): Promise<OfflineFile | null> {
    try {
      const f = await run('readonly', (s) => s.get(id) as IDBRequest<Stored | undefined>);
      return f && f.userId === userId ? fromStored(f) : null;
    } catch {
      return null;
    }
  },
  put(file: OfflineFile): Promise<void> {
    return queued(file.id, () => run('readwrite', (s) => s.put(toStored(file))).then(() => undefined)).catch(() => undefined);
  },
  /** Changes part of the copy (pending changes, a newer snapshot). */
  update(id: string, userId: string, patch: Partial<Omit<OfflineFile, 'id' | 'userId'>>): Promise<void> {
    return queued(id, async () => {
      const cur = await run('readonly', (s) => s.get(id) as IDBRequest<Stored | undefined>);
      if (!cur || cur.userId !== userId) return;
      const { pending, ...rest } = patch;
      await run('readwrite', (s) => s.put({ ...cur, ...rest, ...(pending ? { pending: undefined, pendingText: JSON.stringify(pending) } : {}) }));
    }).catch(() => undefined);
  },
  remove(id: string): Promise<void> {
    return queued(id, () => run('readwrite', (s) => s.delete(id)).then(() => undefined)).catch(() => undefined);
  },
  /** Copies of this account, newest first (the file list without a network). */
  async list(userId: string): Promise<OfflineFile[]> {
    try {
      const all = await run('readonly', (s) => s.getAll() as IDBRequest<Stored[]>);
      return all.filter((f) => f.userId === userId).map(fromStored).sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  },
};

/** The account last seen signed in here, to start as it without a network. */
export function rememberUser(user: { id: string; email: string; name: string; avatar?: string } | null): void {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // not remembered: offline start shows the browser files
  }
}

export function rememberedUser(): { id: string; email: string; name: string; avatar?: string } | null {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as { id?: unknown; email?: unknown; name?: unknown; avatar?: unknown } | null;
    if (!u || typeof u.id !== 'string' || typeof u.email !== 'string') return null;
    const avatar = typeof u.avatar === 'string' && /^https?:\/\//i.test(u.avatar) ? u.avatar : undefined;
    return { id: u.id, email: u.email, name: String(u.name ?? ''), ...(avatar ? { avatar } : {}) };
  } catch {
    return null;
  }
}
