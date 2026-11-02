// ✦ «Почистить слои»: the clutter files collect (especially after an import
// from Figma), removed without changing how anything looks —
//   empty    groups with nothing inside; frames with nothing inside and nothing
//            of their own to show (no fill, stroke or effect), unless they hold
//            a place in an auto layout (a spacer);
//   single   groups of one layer — the layer takes the group's place;
//   wrapper  frames around one layer with nothing of their own (no fill,
//            stroke, effect, auto layout, rotation) and the same bounds.
// Hidden layers stay: people hide things on purpose. One undo step.

import { tr, type Document, type NodeId } from '#core';
import type { Editor } from './editor.ts';

export interface CleanupPlan {
  empty: NodeId[];
  single: NodeId[];
  wrappers: NodeId[];
}

const plain = (doc: Document, id: NodeId) =>
  !doc.get(id, 'fills').some((p) => p.visible && p.opacity > 0) && !doc.get(id, 'strokes').some((p) => p.visible) && !doc.get(id, 'effects').some((e) => e.visible);

export function planCleanup(editor: Editor, roots: readonly NodeId[]): CleanupPlan {
  const doc = editor.doc;
  const plan: CleanupPlan = { empty: [], single: [], wrappers: [] };
  const visit = (id: NodeId) => {
    const t = doc.type(id);
    if (t === 'INSTANCE' || t === 'COMPONENT' || t === 'COMPONENT_SET' || editor.isInstanceLayer(id)) return;
    const kids = doc.children(id);
    for (const c of kids) visit(c);
    if (t === 'GROUP' && kids.length === 0) plan.empty.push(id);
    else if (t === 'FRAME' && kids.length === 0 && plain(doc, id) && !editor.inAutoLayoutParent(id)) plan.empty.push(id);
    else if (t === 'GROUP' && kids.length === 1) plan.single.push(id);
    else if (t === 'FRAME' && kids.length === 1 && plain(doc, id) && doc.get(id, 'layoutMode') === 'NONE' && !doc.get(id, 'rotation') && doc.get(id, 'opacity') === 1 && !editor.inAutoLayoutParent(id)) {
      const a = editor.scene.bounds(id);
      const b = editor.scene.bounds(kids[0]!);
      const same = Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
      if (same) plan.wrappers.push(id);
    }
  };
  roots.forEach(visit);
  return plan;
}

export function cleanupCount(plan: CleanupPlan): number {
  return plan.empty.length + plan.single.length + plan.wrappers.length;
}

/** Does the plan in one undo step. */
export function applyCleanup(editor: Editor, roots: readonly NodeId[]): CleanupPlan {
  const doc = editor.doc;
  const plan = planCleanup(editor, roots);
  if (!cleanupCount(plan)) return plan;
  editor.commit(tr('Почистить слои'), (tx) => {
    // Innermost first (the plan lists children before parents): a wrapper of a wrapper unwraps in turn.
    for (const id of [...plan.single, ...plan.wrappers]) {
      if (!doc.store.isAlive(id)) continue;
      const parent = doc.parent(id)!;
      for (const child of [...doc.children(id)]) editor.reparentKeepingPosition(tx, child, parent, { before: id });
      tx.delete(id);
    }
    for (const id of plan.empty) if (doc.store.isAlive(id)) tx.delete(id);
  });
  return plan;
}
