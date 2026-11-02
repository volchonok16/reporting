// Sorting stickies on a board (BUG-071, instead of ✦ of FEAT-086): the
// selected stickies go into named sections — one per colour, author or number
// of votes; a list of lines becomes stickies. Rules, no AI; one step to undo.

import { hexToColor, plural, solid, tr, type NodeId } from '#core';

const n = (count: number, one: string, few: string, many: string) => `${count} ${plural(count, tr(one), tr(few), tr(many))}`;
import { boardTextOf, roleOf, worldBox } from '#components';
import type { Point } from '#geometry';
import { createSticky, STICKY_COLORS, votesOf } from './board.ts';
import type { Editor } from './editor.ts';

const GAP = 24;
/** Room inside a section around its stickies; more at the top, under the section's name. */
const PAD = 40;
const PAD_TOP = 72;

/** The selected stickies (sorting never touches what is not selected). */
function selectedStickies(editor: Editor): NodeId[] {
  return editor.topLevelSelection().filter((id) => roleOf(editor.doc, id)?.kind === 'STICKY');
}

/** Reading order: rows by top, then left. */
function readingOrder(editor: Editor, ids: NodeId[]): NodeId[] {
  const d = editor.doc;
  const boxes = new Map(ids.map((id) => [id, worldBox(d, id)]));
  return [...ids].sort((a, b) => {
    const A = boxes.get(a)!;
    const B = boxes.get(b)!;
    if (Math.abs(A.y - B.y) > Math.min(A.height, B.height) / 2) return A.y - B.y;
    return A.x - B.x;
  });
}

const colorOf = (editor: Editor, id: NodeId): string => {
  const f = editor.doc.get(id, 'fills')[0];
  if (f?.type !== 'SOLID') return '';
  const p = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${p(f.color.r)}${p(f.color.g)}${p(f.color.b)}`.toUpperCase();
};

const authorOf = (editor: Editor, id: NodeId): string => {
  const r = roleOf(editor.doc, id);
  return r?.kind === 'STICKY' ? r.author.trim() : '';
};

function voteCounts(editor: Editor): Map<NodeId, number> {
  const d = editor.doc;
  const v = d.get(d.rootId, 'boardVoting');
  if (!v || v.open) return new Map();
  return new Map([...votesOf(d, v.id, editor.boardPrefs.voter).entries()].map(([id, n]) => [id, n.total]));
}

export type SortBy = 'color' | 'author' | 'votes';

/** Groups of the selected stickies with the names their sections get, biggest (or most voted) first. */
function groupsFor(editor: Editor, by: SortBy): { name: string; ids: NodeId[] }[] {
  const ids = readingOrder(editor, selectedStickies(editor));
  const votes = by === 'votes' ? voteCounts(editor) : null;
  const key = (id: NodeId) => (by === 'color' ? colorOf(editor, id) : by === 'author' ? authorOf(editor, id) : String(votes!.get(id) ?? 0));
  const groups = new Map<string, NodeId[]>();
  for (const id of ids) {
    const k = key(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(id);
  }
  const name = (k: string) => {
    if (by === 'color') return STICKY_COLORS.find((c) => c.hex.toUpperCase() === k)?.name ?? tr('Другой цвет');
    if (by === 'author') return k || tr('Без автора');
    return Number(k) === 0 ? tr('Без голосов') : n(Number(k), 'голос', 'голоса', 'голосов');
  };
  const list = [...groups.entries()].map(([k, g]) => ({ k, name: name(k), ids: g }));
  if (by === 'votes') list.sort((a, b) => Number(b.k) - Number(a.k));
  else list.sort((a, b) => b.ids.length - a.ids.length);
  return list;
}

/** What sorting the selection can do now: each with how many sections it makes (none — not offered). */
export function sortOptions(editor: Editor): { by: SortBy; label: string; groups: number }[] {
  const st = selectedStickies(editor);
  if (st.length < 2) return [];
  const out: { by: SortBy; label: string; groups: number }[] = [];
  const colors = groupsFor(editor, 'color').length;
  if (colors >= 2) out.push({ by: 'color', label: tr('По цвету: {0}', n(colors, 'раздел', 'раздела', 'разделов')), groups: colors });
  const authors = groupsFor(editor, 'author').length;
  if (authors >= 2) out.push({ by: 'author', label: tr('По автору: {0}', n(authors, 'раздел', 'раздела', 'разделов')), groups: authors });
  if (voteCounts(editor).size > 0) {
    const v = groupsFor(editor, 'votes').length;
    if (v >= 2) out.push({ by: 'votes', label: tr('По голосам: {0}', n(v, 'раздел', 'раздела', 'разделов')), groups: v });
  }
  return out;
}

/**
 * Sorts the selected stickies into sections side by side, one per colour,
 * author or number of votes, each named so: where they were, from the top
 * left of the selection. One step to undo; the new sections end up selected.
 */
export function sortIntoSections(editor: Editor, by: SortBy): void {
  const groups = groupsFor(editor, by);
  if (groups.length < 2) return;
  const d = editor.doc;
  const all = groups.flatMap((g) => g.ids);
  const boxes = all.map((id) => worldBox(d, id));
  const start = { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
  const cell = { w: Math.max(...boxes.map((b) => b.width)), h: Math.max(...boxes.map((b) => b.height)) };
  const made: NodeId[] = [];
  const labels = { color: tr('Упорядочить по цвету'), author: tr('Упорядочить по автору'), votes: tr('Упорядочить по голосам') };
  editor.commit(labels[by], (tx) => {
    let x = start.x;
    for (const g of groups) {
      const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(g.ids.length))));
      const rows = Math.ceil(g.ids.length / cols);
      const width = PAD * 2 + cols * cell.w + (cols - 1) * GAP;
      const height = PAD_TOP + PAD + rows * cell.h + (rows - 1) * GAP;
      const section = tx.create('SECTION', editor.pageId, { name: g.name, x: Math.round(x), y: Math.round(start.y), width: Math.round(width), height: Math.round(height), fills: [solid(hexToColor('#F5F5F5')!)] });
      // Into the section, at their cells (in its coordinates: it sits on the page, not turned).
      g.ids.forEach((id, i) => {
        tx.move(id, section, { at: 'end' });
        tx.update(id, { x: Math.round(PAD + (i % cols) * (cell.w + GAP)), y: Math.round(PAD_TOP + Math.floor(i / cols) * (cell.h + GAP)) });
      });
      made.push(section);
      x += width + GAP * 2;
    }
  });
  editor.setSelection(made);
}

// ---------- a list into stickies ----------

/** Lines of a text, as stickies (a numbered or bulleted list loses its marks). */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–—]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** Puts one sticky per line in a grid around a page point; returns them. */
export function stickiesFromLines(editor: Editor, lines: string[], center: Point): NodeId[] {
  const size = 200;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(lines.length))));
  const rows = Math.ceil(lines.length / cols);
  const x0 = center.x - (cols * (size + GAP)) / 2;
  const y0 = center.y - (rows * (size + GAP)) / 2;
  const made: NodeId[] = [];
  editor.commit(tr('Стикеры из списка'), () => {
    lines.forEach((line, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const id = createSticky(editor, { x: x0 + c * (size + GAP) + size / 2, y: y0 + r * (size + GAP) + size / 2 }, editor.boardPrefs.stickyColor, size);
      const t = boardTextOf(editor.doc, id);
      if (t) editor.doc.transact((tx) => tx.set(t, 'characters', line));
      made.push(id);
    });
  });
  editor.setSelection(made);
  return made;
}

/** A selected text of several lines becomes stickies next to it. */
export function textToStickies(editor: Editor): void {
  const d = editor.doc;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  if (!only || d.type(only) !== 'TEXT' || d.get(only, 'board')) return;
  const lines = linesOf(d.get(only, 'characters'));
  if (lines.length === 0) return;
  const b = worldBox(d, only);
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(lines.length))));
  stickiesFromLines(editor, lines, { x: b.x + b.width + 80 + (cols * 224) / 2, y: b.y + (Math.ceil(lines.length / cols) * 224) / 2 });
}
