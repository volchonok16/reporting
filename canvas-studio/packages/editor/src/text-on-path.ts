// Putting a text on a path and taking it off (Figma Draw). The path's line
// moves into the text (the text then lies where the path was) and the path
// layer goes: one step to undo. The text keeps its words and styles.

import { tr, type NodeId, type VectorPath } from '#core';
import { flattenPaths, nodeTransform, transformPaths } from '#geometry';
import { nodePaths, vectorDrawing } from '#layout';
import type { Editor } from './editor.ts';

const LINE_TYPES = new Set(['VECTOR', 'LINE', 'ELLIPSE', 'RECTANGLE', 'POLYGON', 'STAR']);

/** The text and the path of the selection, when it is exactly one of each. */
export function textAndPath(editor: Editor): { text: NodeId; path: NodeId } | null {
  const d = editor.doc;
  const sel = editor.topLevelSelection();
  if (sel.length !== 2) return null;
  const text = sel.find((id) => d.type(id) === 'TEXT');
  const path = sel.find((id) => LINE_TYPES.has(d.type(id)));
  return text && path ? { text, path } : null;
}

const bounds = (paths: readonly VectorPath[]) => {
  const xs = paths.flatMap((p) => p.points.flatMap((q) => [q.x, q.in?.x ?? q.x, q.out?.x ?? q.x]));
  const ys = paths.flatMap((p) => p.points.flatMap((q) => [q.y, q.in?.y ?? q.y, q.out?.y ?? q.y]));
  return { x: Math.min(...xs), y: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/** Runs the selected text along the selected path. */
export function putTextOnPath(editor: Editor): boolean {
  const pair = textAndPath(editor);
  if (!pair) {
    editor.toast(tr('Выделите текст и линию (контур, фигуру) — текст пойдёт вдоль неё'));
    return false;
  }
  const d = editor.doc;
  const { text, path } = pair;
  const drawing = d.type(path) === 'VECTOR' ? vectorDrawing(d, path) : null;
  const own = drawing ? drawing.stroke : nodePaths(d, path);
  if (own.length === 0 || own.every((p) => p.points.length < 2)) return false;
  const parent = d.parent(path)!;
  // The path in its parent's space (it may be turned), then in the text's new box.
  const inParent = transformPaths(own, nodeTransform(d.get(path, 'x'), d.get(path, 'y'), d.get(path, 'rotation')));
  const b = bounds(inParent);
  const pad = Math.ceil(d.get(text, 'fontSize') * 1.2);
  const x = Math.round(b.x - pad);
  const y = Math.round(b.y - pad);
  const { paths: local, offset } = readable(transformPaths(inParent, nodeTransform(-x, -y, 0)));
  editor.commit(tr('Текст по контуру'), (tx) => {
    if (d.parent(text) !== parent) tx.move(text, parent, { before: path });
    tx.update(text, { x, y, rotation: 0, width: Math.round(b.x1 - b.x + pad * 2), height: Math.round(b.y1 - b.y + pad * 2), textAutoResize: 'NONE', textPath: local, textPathOffset: offset, textAlignH: 'CENTER', maxLines: 0 });
    tx.delete(path);
  }, () => [text]);
  return true;
}

/** Back to an ordinary line of text (the path is not restored: ⌘Z does that). */
export function takeTextOffPath(editor: Editor): void {
  const d = editor.doc;
  const ids = editor.topLevelSelection().filter((id) => d.type(id) === 'TEXT' && d.get(id, 'textPath'));
  if (ids.length === 0) return;
  editor.commit(tr('Снять текст с контура'), (tx) => {
    for (const id of ids) tx.update(id, { textPath: null, textAutoResize: 'WIDTH_AND_HEIGHT', textAlignH: 'LEFT' });
  });
}

/** The text to the other side of its path (the path's direction reversed). */
export function flipTextOnPath(editor: Editor): void {
  const d = editor.doc;
  const ids = editor.topLevelSelection().filter((id) => d.type(id) === 'TEXT' && d.get(id, 'textPath'));
  if (ids.length === 0) return;
  editor.commit(tr('Перевернуть текст на контуре'), (tx) => {
    for (const id of ids) {
      const reversed = d.get(id, 'textPath')!.map(reverse);
      tx.update(id, { textPath: reversed, textPathOffset: 1 - d.get(id, 'textPathOffset') });
    }
  });
}

/** The path the other way round; a closed one keeps its starting point (so a distance d becomes length − d). */
const reverse = (p: VectorPath): VectorPath => {
  const turned = [...p.points].reverse();
  const order = p.closed ? [turned[turned.length - 1]!, ...turned.slice(0, -1)] : turned;
  return { closed: p.closed, points: order.map((q) => ({ x: q.x, y: q.y, ...(q.out ? { in: q.out } : {}), ...(q.in ? { out: q.in } : {}) })) };
};

/**
 * The way a text reads on a path, as in Figma: on a closed shape — over its top,
 * left to right; on a line — from its left end (a line drawn right to left is turned round).
 */
function readable(paths: VectorPath[]): { paths: VectorPath[]; offset: number } {
  const first = paths[0]!;
  const line = flattenPaths([first], 0.5)[0];
  if (!line || line.points.length < 2) return { paths, offset: 0.5 };
  const pts = line.points;
  if (!first.closed) {
    const turned = pts[pts.length - 1]!.x < pts[0]!.x;
    return { paths: turned ? [reverse(first), ...paths.slice(1)] : paths, offset: 0.5 };
  }
  // The topmost point, and which way the outline runs there.
  let top = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.y < pts[top]!.y) top = i;
  const next = pts[(top + 1) % pts.length]!;
  const prev = pts[(top - 1 + pts.length) % pts.length]!;
  const leftToRight = next.x - prev.x >= 0;
  const use = leftToRight ? first : reverse(first);
  const run = flattenPaths([use], 0.5)[0]!.points;
  let at = 0;
  let total = 0;
  let topAt = 0;
  let best = Infinity;
  for (let i = 0; i < run.length; i++) {
    if (i > 0) total += Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.y - run[i - 1]!.y);
    if (run[i]!.y < best) {
      best = run[i]!.y;
      topAt = total;
    }
  }
  at = total + Math.hypot(run[0]!.x - run[run.length - 1]!.x, run[0]!.y - run[run.length - 1]!.y);
  return { paths: [use, ...paths.slice(1)], offset: at > 0 ? topAt / at : 0.5 };
}
