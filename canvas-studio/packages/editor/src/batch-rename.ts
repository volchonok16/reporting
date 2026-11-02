// Renaming several layers at once (⌘R with more than one selected, as in
// Figma): a pattern for the new name — `$&` the current name, `$n` a number
// (`$nn`, `$nnn` padded with zeros), `$N` counting down — and an optional
// find-and-replace inside the names (plain text, or a regular expression with
// $1… groups in the replacement). Numbers follow the layers panel, top down.
// And «select matching layers» (⌥⌘A): layers of the page that look like the
// selected one.

import { tr, type Document, type NodeId } from '#core';
import type { Editor } from './editor.ts';

export interface RenameRule {
  /** The new name; empty — the current one (only the replacement applies). */
  pattern: string;
  find: string;
  replace: string;
  /** `find` is a regular expression (every match; `$1`… in `replace` are its groups). */
  regex?: boolean;
  /** The first number for `$n`. */
  start: number;
}

/** Why `find` is not a regular expression; null — it is (or the rule is plain text). */
export function regexError(rule: Pick<RenameRule, 'find' | 'regex'>): string | null {
  if (!rule.regex || !rule.find) return null;
  try {
    new RegExp(rule.find, 'gu');
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** New names for `names` (in the order they are numbered). A broken expression replaces nothing. */
export function renameAll(names: readonly string[], rule: RenameRule): string[] {
  const total = names.length;
  const re = rule.regex && rule.find && !regexError(rule) ? new RegExp(rule.find, 'gu') : null;
  return names.map((name, i) => {
    const own = !rule.find ? name : re ? name.replace(re, rule.replace) : rule.regex ? name : name.split(rule.find).join(rule.replace);
    if (!rule.pattern) return own;
    const up = rule.start + i;
    const down = rule.start + total - 1 - i;
    return rule.pattern
      .replace(/\$(n+)/g, (_, n: string) => String(up).padStart(n.length, '0'))
      .replace(/\$(N+)/g, (_, n: string) => String(down).padStart(n.length, '0'))
      .replace(/\$&/g, () => own);
  });
}

/** The selected layers in the layers panel's order (top down: front first). */
export function panelOrder(editor: Editor, ids: readonly NodeId[]): NodeId[] {
  return editor.sortedByPaintOrder(ids).reverse();
}

/** Renames the selected layers by the rule, one step to undo. */
export function renameSelection(editor: Editor, rule: RenameRule): number {
  const ids = panelOrder(editor, editor.selection);
  const next = renameAll(ids.map((id) => editor.doc.get(id, 'name')), rule);
  const changed = ids.filter((id, i) => next[i]!.trim() !== '' && next[i] !== editor.doc.get(id, 'name'));
  if (changed.length === 0) return 0;
  editor.commit(tr('Переименовать слои'), (tx) => {
    ids.forEach((id, i) => {
      if (changed.includes(id)) tx.set(id, 'name', next[i]!.trim());
    });
  });
  return changed.length;
}

// ---------- matching layers ----------

/** What makes two layers "the same" for ⌥⌘A: type, then what the eye sees. */
function signature(doc: Document, id: NodeId): string {
  const type = doc.type(id);
  const g = (k: Parameters<Document['get']>[1]) => JSON.stringify(doc.get(id, k));
  if (type === 'INSTANCE') return `INSTANCE|${doc.get(id, 'mainComponent')}`;
  if (type === 'TEXT') return ['TEXT', g('textStyleId'), g('fontFamily'), g('fontWeight'), g('fontSize'), g('italic'), g('fills'), g('fillStyleId')].join('|');
  return [type, Math.round(doc.get(id, 'width')), Math.round(doc.get(id, 'height')), g('fills'), g('fillStyleId'), g('strokes'), g('strokeWeight'), g('cornerRadius'), g('effects')].join('|');
}

/**
 * Layers of the current page that match the selected ones (same component;
 * same text style; same type, size, fill, stroke, corners and effects). Locked
 * and hidden layers and layers inside instances are left out.
 */
export function matchingLayers(editor: Editor): NodeId[] {
  const d = editor.doc;
  const sel = editor.selection.filter((id) => d.store.isAlive(id));
  if (sel.length === 0) return [];
  const wanted = new Set(sel.map((id) => signature(d, id)));
  const out: NodeId[] = [];
  const walk = (parent: NodeId) => {
    for (const id of d.children(parent)) {
      if (!d.get(id, 'visible') || d.get(id, 'locked')) continue;
      if (wanted.has(signature(d, id))) out.push(id);
      // Inside an instance everything follows the component: not picked one by one.
      if (d.type(id) !== 'INSTANCE') walk(id);
    }
  };
  walk(editor.pageId);
  return out;
}

export function selectMatching(editor: Editor): void {
  const found = matchingLayers(editor);
  if (found.length <= editor.selection.length) {
    editor.toast(editor.selection.length === 0 ? tr('Выделите слой — найдутся такие же на странице') : tr('Других таких же слоёв на странице нет'));
    return;
  }
  editor.setSelection(found);
  editor.toast(tr('Выделено таких же слоёв: {0}', found.length));
}
