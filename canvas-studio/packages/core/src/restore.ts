// Restoring a version (stage 8, part 5): the version is another Document read
// from a saved snapshot. Node ids are the same in every version of a file, so
// the current document is brought to the version node by node, as ordinary
// operations: everyone in the file sees it at once, one undo step takes it back.
// The whole file, or only some layers (a frame from an hour ago).

import type { Document, Transaction } from './document.ts';
import { base64ToBytes } from './hash.ts';
import type { NodeId } from './ids.ts';
import { valueEquals, type PropKey } from './schema.ts';

export interface RestoreResult {
  /** Nodes brought back, changed or removed. */
  changed: number;
}

function subtree(doc: Document, root: NodeId): NodeId[] {
  const out = [root];
  doc.store.walk(root, (id) => void out.push(id));
  return out;
}

/**
 * Brings `current` to `version` inside a transaction. `roots` — only these
 * layers of the version (with everything inside); a layer whose place no
 * longer exists goes to `fallbackParent` (the open page). Without `roots` —
 * the whole file, except its name.
 */
export function restoreVersion(tx: Transaction, current: Document, version: Document, roots: readonly NodeId[] | null, fallbackParent: NodeId): RestoreResult {
  let changed = 0;
  const wanted = new Set<NodeId>();
  const order: NodeId[] = [];
  const starts = roots ?? version.children(version.rootId);
  for (const r of starts) {
    if (!version.store.isAlive(r)) continue;
    for (const id of subtree(version, r)) {
      wanted.add(id);
      order.push(id);
    }
  }
  // Pictures of the version that this file no longer has.
  for (const [hash, blob] of version.store.blobs) if (!current.store.blobs.has(hash)) tx.addBlob(base64ToBytes(blob.data), blob.mime);

  for (const id of order) {
    const v = version.store.record(id)!;
    let parent = v.parent!;
    const isRoot = roots?.includes(id) ?? false;
    if (isRoot && !current.store.isAlive(parent)) parent = fallbackParent;
    const cur = current.store.record(id);
    const alive = current.store.isAlive(id) && cur?.props.deleted !== true;
    if (!cur || cur.props.deleted === true) {
      if (!tx.revive(id, v.type, parent, v.index, v.props)) continue;
      changed++;
    } else if (!alive && cur) {
      // Alive itself but inside something deleted: the parent comes back first (it is earlier in the order).
      tx.move(id, parent, { key: v.index });
    }
    const now = current.store.record(id);
    if (!now) continue;
    // Every property as in the version (also those the version had at their defaults).
    const keys = new Set([...Object.keys(now.props), ...Object.keys(v.props)] as PropKey[]);
    let touched = false;
    for (const key of keys) {
      if (key === 'deleted') continue;
      const target = version.get(id, key);
      if (!valueEquals(current.get(id, key), target)) {
        tx.set(id, key, target as never);
        touched = true;
      }
    }
    if (now.parent !== parent || now.index !== v.index) {
      tx.move(id, parent, { key: v.index });
      touched = true;
    }
    if (touched) changed++;
  }

  // What appeared after the version, within what is restored.
  const scope = roots ? roots.filter((r) => current.store.isAlive(r)).flatMap((r) => subtree(current, r)) : current.children(current.rootId).flatMap((r) => subtree(current, r));
  for (const id of scope) {
    if (wanted.has(id) || !current.store.isAlive(id)) continue;
    tx.delete(id);
    changed++;
  }
  return { changed };
}

/** Top-level layers of a page that differ between two versions: added, removed, changed. */
export function compareTopLevel(before: Document, after: Document, page: NodeId): { added: NodeId[]; removed: NodeId[]; changed: NodeId[] } {
  const list = (d: Document) => (d.store.isAlive(page) ? [...d.children(page)] : []);
  const a = new Set(list(before));
  const b = new Set(list(after));
  const fingerprint = (d: Document, root: NodeId) => {
    const parts: string[] = [];
    for (const id of subtree(d, root)) {
      const r = d.store.record(id)!;
      const props = Object.keys(r.props)
        .filter((k) => k !== 'deleted')
        .sort()
        .map((k) => `${k}=${JSON.stringify((r.props as Record<string, unknown>)[k])}`);
      parts.push(`${id}|${r.parent}|${r.index}|${props.join(';')}`);
    }
    return parts.join('\n');
  };
  return {
    added: [...b].filter((id) => !a.has(id)),
    removed: [...a].filter((id) => !b.has(id)),
    changed: [...b].filter((id) => a.has(id) && fingerprint(before, id) !== fingerprint(after, id)),
  };
}
