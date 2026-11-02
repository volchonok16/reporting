// Moving files kept in this browser (work done without signing in) to the
// server once signed in. Each file goes once: the ids already taken are
// remembered per account. The files stay in the browser too.

import { tr } from '#core';
import { CloudBackend, newCloudId, type FileBackend } from './cloud.ts';
import { storage } from './storage.ts';

function uploadedKey(backend: CloudBackend): string {
  return `cs.uploaded.${backend.user?.id ?? 'guest'}`;
}

function uploaded(backend: CloudBackend): string[] {
  try {
    return JSON.parse(localStorage.getItem(uploadedKey(backend)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Local files this account has not taken to the server yet. */
export async function localFilesToUpload(backend: FileBackend): Promise<string[]> {
  if (!(backend instanceof CloudBackend) || !backend.user) return [];
  const done = uploaded(backend);
  return (await storage.list()).map((f) => f.id).filter((id) => !done.includes(id));
}

/** Copies the browser's files to the server; returns how many went and the problems met. */
export async function uploadLocalFiles(backend: FileBackend): Promise<{ done: number; errors: string[] }> {
  if (!(backend instanceof CloudBackend) || !backend.user) return { done: 0, errors: [] };
  const taken = uploaded(backend);
  const errors: string[] = [];
  let done = 0;
  for (const id of await localFilesToUpload(backend)) {
    const file = await storage.load(id);
    if (!file) continue;
    try {
      await backend.save({ ...file, id: newCloudId() });
    } catch (error) {
      errors.push(tr('Не удалось перенести «{0}»: {1}', file.name, error instanceof Error ? error.message : String(error)));
      continue;
    }
    taken.push(id);
    done++;
  }
  try {
    localStorage.setItem(uploadedKey(backend), JSON.stringify(taken));
  } catch {
    // the offer may show again
  }
  return { done, errors };
}
