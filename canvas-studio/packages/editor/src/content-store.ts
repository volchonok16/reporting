// The user's own «Контент» sets. Text sets live with the interface settings —
// in localStorage and, signed in, with the account (prefs.ts) — so they follow
// the person to another computer. Picture sets are heavy: they stay in this
// browser (IndexedDB), each picture shrunk to at most 800 px.

import { prefsChanged } from './prefs.ts';
import type { OwnTextSet, PictureBytes } from './content-reel.ts';

export const OWN_TEXT_KEY = 'cs.content-sets';

export interface OwnPictureSet {
  id: string;
  name: string;
  pictures: { bytes: Uint8Array; mime: string; width: number; height: number }[];
}

export function ownTextSets(): OwnTextSet[] {
  try {
    const v = JSON.parse(localStorage.getItem(OWN_TEXT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((s): s is OwnTextSet => !!s && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.items)) : [];
  } catch {
    return [];
  }
}

export function saveOwnTextSets(sets: readonly OwnTextSet[]): void {
  try {
    localStorage.setItem(OWN_TEXT_KEY, JSON.stringify(sets));
  } catch {
    // not remembered
  }
  prefsChanged();
}

const DB = 'cs-content';
const STORE = 'pictures';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = work(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function ownPictureSets(): Promise<OwnPictureSet[]> {
  return run('readonly', (s) => s.getAll() as IDBRequest<OwnPictureSet[]>).catch(() => []);
}

export function saveOwnPictureSet(set: OwnPictureSet): Promise<void> {
  return run('readwrite', (s) => s.put(set)).then(() => undefined);
}

export function deleteOwnPictureSet(id: string): Promise<void> {
  return run('readwrite', (s) => s.delete(id)).then(() => undefined);
}

/** A picture file shrunk to at most `max` px on its long side (JPEG for photos, PNG when it has transparency). */
export async function shrinkPicture(file: Blob, max = 800): Promise<OwnPictureSet['pictures'][number] | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const png = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif' || file.type === 'image/svg+xml';
  const mime = png ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, mime, 0.88));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime, width, height };
}

export function asPicture(p: OwnPictureSet['pictures'][number]): PictureBytes {
  return { bytes: p.bytes, mime: p.mime };
}
