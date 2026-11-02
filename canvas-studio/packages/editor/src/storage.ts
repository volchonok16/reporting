// Local persistence in IndexedDB (FR-OFF-002): the open file survives reloads,
// crashes and network loss. A tiny wrapper over the raw API — no libraries.

import type { BranchMeta } from './cloud.ts';
import { locale, snapshotKind, tr } from '#core';
const DB_NAME = 'canvas-studio';
const STORE = 'files';
/** Small records for the file list, so listing never loads whole documents. */
const META = 'meta';
const VERSION = 2;

export interface FileMeta {
  id: string;
  name: string;
  savedAt: number;
  createdAt: number;
  /** Project the file is in; none — "Drafts". */
  projectId?: string | null;
  /** Preview for the file browser: an image URL (a data: URL in this browser). */
  thumb?: string;
  /** What this person may do with the file (server files; none — own file). */
  role?: Role;
  /** Owner's name, for files shared with this person. */
  ownerName?: string;
  /** Others have access (people, invitations or a link). */
  shared?: boolean;
  /** A team file the team does not see (only the people of the file and team admins). */
  restricted?: boolean;
  /** Open branches of the file (server). */
  branches?: number;
  /** A board (FEAT-083); none — a design. */
  kind?: 'board' | 'diagram' | 'slides';
}

export type Role = 'viewer' | 'commenter' | 'editor' | 'owner';

/** A folder of files on the home screen, as projects in Figma. */
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  /** The team the project belongs to (server); none — one's own project. */
  teamId?: string;
}

export interface StoredFile {
  id: string;
  name: string;
  snapshot: string;
  viewport?: { zoom: number; offsetX: number; offsetY: number };
  pageId?: string;
  savedAt: number;
  /** Project for a new file (an existing file keeps its place). */
  projectId?: string | null;
  /** Set on load from the server: what this person may do, and whether they are signed in. */
  role?: Role;
  signedIn?: boolean;
  ownerName?: string;
  /** A branch of another file (server). */
  branch?: BranchMeta;
  /** Server file opened from the copy in this browser (no network). */
  offline?: boolean;
  /** Changes made earlier that the server has not confirmed yet (sent when the file opens). */
  pending?: unknown[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: 'id' });
        // Files saved before the list existed get their records now.
        const files = request.transaction!.objectStore(STORE);
        const cursor = files.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const f = c.value as StoredFile;
          meta.put({ id: f.id, name: f.name, savedAt: f.savedAt, createdAt: f.savedAt } satisfies FileMeta);
          c.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(tr('IndexedDB недоступен')));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, name = STORE): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = fn(tx.objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(tr('Ошибка IndexedDB')));
    });
  } finally {
    db.close();
  }
}

export const storage = {
  load(id: string): Promise<StoredFile | undefined> {
    return run('readonly', (s) => s.get(id) as IDBRequest<StoredFile | undefined>);
  },
  async save(file: StoredFile): Promise<IDBValidKey> {
    const old = await run('readonly', (s) => s.get(file.id) as IDBRequest<FileMeta | undefined>, META);
    const { projectId, role: _role, signedIn: _signedIn, ownerName: _ownerName, ...record } = file;
    await run('readwrite', (s) => s.put({ ...old, id: file.id, name: file.name, savedAt: file.savedAt, createdAt: old?.createdAt ?? file.savedAt, projectId: old ? (old.projectId ?? null) : (projectId ?? null), ...(snapshotKind(file.snapshot) ? { kind: snapshotKind(file.snapshot)! } : {}) } satisfies FileMeta), META);
    return run('readwrite', (s) => s.put(record));
  },
  /** Changes the list record only (project, preview): not an edit of the document. */
  async setMeta(id: string, patch: Partial<Pick<FileMeta, 'projectId' | 'thumb'>>): Promise<void> {
    const old = await run('readonly', (s) => s.get(id) as IDBRequest<FileMeta | undefined>, META);
    if (old) await run('readwrite', (s) => s.put({ ...old, ...patch }), META);
  },
  async remove(id: string): Promise<undefined> {
    await run('readwrite', (s) => s.delete(id) as IDBRequest<undefined>, META);
    return run('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  },
  /** Every stored file, most recently saved first (FR-FIL file list). */
  async list(): Promise<FileMeta[]> {
    const all = await run('readonly', (s) => s.getAll() as IDBRequest<FileMeta[]>, META);
    return all.sort((a, b) => b.savedAt - a.savedAt);
  },
  async rename(id: string, name: string): Promise<void> {
    const file = await storage.load(id);
    if (!file) return;
    // The name lives in the document too: rewrite it in the snapshot's root.
    const snapshot = JSON.parse(file.snapshot) as { nodes: { parent: string | null; props: { name?: string } }[] };
    const root = snapshot.nodes.find((n) => n.parent === null);
    if (root) root.props.name = name;
    await storage.save({ ...file, name, snapshot: JSON.stringify(snapshot), savedAt: Date.now() });
  },
};

const PROJECTS = 'cs.projects';

/** Projects of files kept in this browser (a short list: localStorage is enough). */
export const localProjects = {
  list(): ProjectMeta[] {
    try {
      const all = JSON.parse(localStorage.getItem(PROJECTS) ?? '[]') as ProjectMeta[];
      return all.sort((a, b) => a.name.localeCompare(b.name, locale()));
    } catch {
      return [];
    }
  },
  write(all: ProjectMeta[]): void {
    localStorage.setItem(PROJECTS, JSON.stringify(all));
  },
  create(name: string): ProjectMeta {
    const project = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, name, createdAt: Date.now() };
    localProjects.write([...localProjects.list(), project]);
    return project;
  },
  rename(id: string, name: string): void {
    localProjects.write(localProjects.list().map((p) => (p.id === id ? { ...p, name } : p)));
  },
  async remove(id: string): Promise<void> {
    // The files stay: they move to Drafts.
    for (const f of await storage.list()) if (f.projectId === id) await storage.setMeta(f.id, { projectId: null });
    localProjects.write(localProjects.list().filter((p) => p.id !== id));
  },
};

/** A new unique file id. */
export function newFileId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Debounced autosave: waits for a quiet period, never runs two saves at once. */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending = false;
  private readonly delay: number;
  private readonly save: () => Promise<void>;
  onState: ((state: 'saving' | 'saved' | 'error' | 'unsaved', detail?: string) => void) | null = null;
  /** Whether a timed save may run now (not in the middle of a drag); flush() saves regardless. */
  ready: () => boolean = () => true;

  constructor(save: () => Promise<void>, delay = 600) {
    this.save = save;
    this.delay = delay;
  }

  schedule(): void {
    this.onState?.('unsaved');
    if (this.timer) clearTimeout(this.timer);
    const tick = () => {
      if (!this.ready()) {
        this.timer = setTimeout(tick, 300);
        return;
      }
      void this.flush();
    };
    this.timer = setTimeout(tick, this.delay);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.onState?.('saving');
    try {
      await this.save();
      this.onState?.('saved');
    } catch (error) {
      this.onState?.('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        void this.flush();
      }
    }
  }
}
