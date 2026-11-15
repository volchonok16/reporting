// «Подогнать под форматы» (FEAT-224, other editors, item 6; as Magic Resize in Canva): one banner → a post, a story,
// a VK cover, a YouTube preview… Each format is a copy of its own, placed past the row, then edited apart.
// Rules, no network:
//   auto layout   the frame is scaled to fit and takes the new size; its layout places the rest;
//   background    a layer covering the frame is stretched to the new frame (a picture fills and crops);
//   the rest      layers close to each other form a block (a title with its subtitle, a logo, a button); a block is
//                 scaled as a whole by min(W′/W, H′/H); a block at an edge keeps its margin (scaled), others are
//                 set at the same relative point of the new frame; all kept inside it.

import { cloneValue, type Document, type NodeId, type NodeProps, type Transaction } from '#core';
import { resizeWithConstraints, scaleNode } from '#layout';

export interface Format {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const FORMATS: readonly Format[] = [
  { id: 'square', label: 'Пост 1:1', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Пост 4:5', width: 1080, height: 1350 },
  { id: 'story', label: 'Сторис', width: 1080, height: 1920 },
  { id: 'vk-cover', label: 'Обложка VK', width: 1920, height: 768 },
  { id: 'telegram', label: 'Пост Telegram', width: 1280, height: 720 },
  { id: 'youtube', label: 'Превью YouTube', width: 1280, height: 720 },
  { id: 'wide', label: 'Баннер 16:9', width: 1920, height: 1080 },
];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A deep copy of a layer under `parent`; a main component becomes its instance. */
function cloneLayer(doc: Document, tx: Transaction, id: NodeId, parent: NodeId, position: Parameters<Transaction['create']>[3], extra: Partial<NodeProps> = {}): NodeId {
  const record = doc.store.record(id)!;
  const props = cloneValue(record.props) as Record<string, unknown>;
  delete props.deleted;
  // A copy of a format is a frame of its own, not another width of a breakpoint set.
  delete props.breakpoint;
  delete props.bpKey;
  if (record.type === 'COMPONENT' || record.type === 'COMPONENT_SET') {
    for (const key of ['componentProps', 'description', 'layerKey'] as const) delete props[key];
    return tx.create('INSTANCE', parent, { ...props, mainComponent: record.type === 'COMPONENT' ? id : (doc.children(id)[0] ?? null), ...extra } as Partial<NodeProps>, position);
  }
  const copy = tx.create(record.type, parent, { ...props, ...extra } as Partial<NodeProps>, position);
  for (const c of doc.children(id)) if (!doc.get(c, 'repeatCopy')) cloneLayer(doc, tx, c, copy, { at: 'end' });
  return copy;
}

/** Plain shapes: decoration unless a picture is in them. */
const DECOR = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION']);

const boxOf = (doc: Document, id: NodeId): Box => ({ x: doc.get(id, 'x'), y: doc.get(id, 'y'), w: doc.get(id, 'width'), h: doc.get(id, 'height') });

/** A layer that is the frame's background: covers almost all of it. */
function isBackground(doc: Document, id: NodeId, W: number, H: number): boolean {
  if (doc.get(id, 'rotation') !== 0) return false;
  const b = boxOf(doc, id);
  const ix = Math.max(0, Math.min(b.x + b.w, W) - Math.max(b.x, 0));
  const iy = Math.max(0, Math.min(b.y + b.h, H) - Math.max(b.y, 0));
  return ix >= W * 0.95 && iy >= H * 0.95;
}

/**
 * Blocks: layers that read as one thing (union-find over pairs) — boxes within `gap` of each other, or a column
 * (left edges, centres or right edges in line, the vertical gap under `stack`) or a row (tops, middles or bottoms in
 * line, the horizontal gap under `stack`): a title, its subtitle and the button under them move together.
 */
export function blocksOf(boxes: readonly Box[], gap: number, frame?: { width: number; height: number }, decor: readonly boolean[] = []): number[][] {
  const W = frame?.width ?? 0;
  const H = frame?.height ?? 0;
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
      const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
      const column = frame && dy <= H * 0.12 && (near(a.x, b.x, W * 0.02) || near(a.x + a.w / 2, b.x + b.w / 2, W * 0.02) || near(a.x + a.w, b.x + b.w, W * 0.02));
      const row = frame && dx <= W * 0.12 && (near(a.y, b.y, H * 0.02) || near(a.y + a.h / 2, b.y + b.h / 2, H * 0.02) || near(a.y + a.h, b.y + b.h, H * 0.02));
      // A plain shape (a circle, a blob of colour) is decoration: it joins a block only lying over it.
      if (decor[i] || decor[j]) {
        if (dx === 0 && dy === 0 && Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)) parent[find(i)] = find(j);
        continue;
      }
      if ((dx <= gap && dy <= gap) || column || row) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()];
}

/** Lays out the frame's content for the new size `W2`×`H2` (the frame itself already has it or gets it here). */
function adapt(doc: Document, tx: Transaction, frame: NodeId, W: number, H: number, W2: number, H2: number): void {
  const k = Math.min(W2 / W, H2 / H);
  if (doc.get(frame, 'layoutMode') !== 'NONE') {
    scaleNode(doc, tx, frame, k);
    tx.set(frame, 'width', W2);
    tx.set(frame, 'height', H2);
    return;
  }
  tx.set(frame, 'width', W2);
  tx.set(frame, 'height', H2);
  const kids = doc.children(frame);
  const content: NodeId[] = [];
  for (const id of kids) {
    if (isBackground(doc, id, W, H)) {
      const b = boxOf(doc, id);
      // Its overhang past the frame scales with the frame.
      const sx = W2 / W;
      const sy = H2 / H;
      tx.set(id, 'x', Math.round(b.x * sx * 100) / 100);
      tx.set(id, 'y', Math.round(b.y * sy * 100) / 100);
      if (doc.children(id).length) resizeWithConstraints(doc, tx, id, b.w * sx, b.h * sy);
      else {
        tx.set(id, 'width', Math.round(b.w * sx * 100) / 100);
        tx.set(id, 'height', Math.round(b.h * sy * 100) / 100);
      }
    } else content.push(id);
  }
  const boxes = content.map((id) => boxOf(doc, id));
  const gap = Math.min(W, H) * 0.04;
  const decor = content.map((id) => DECOR.has(doc.type(id)) && !doc.get(id, 'fills').some((f) => f.visible && f.type === 'IMAGE'));
  for (const block of blocksOf(boxes, gap, { width: W, height: H }, decor)) {
    const bx = Math.min(...block.map((i) => boxes[i]!.x));
    const by = Math.min(...block.map((i) => boxes[i]!.y));
    const bw = Math.max(...block.map((i) => boxes[i]!.x + boxes[i]!.w)) - bx;
    const bh = Math.max(...block.map((i) => boxes[i]!.y + boxes[i]!.h)) - by;
    // Near an edge (under 10 % of the side, nearer than the other; not centred) — the same margin, scaled;
    // otherwise the block's centre at the same relative point. Kept inside the frame as far as it fits.
    const nw = bw * k;
    const nh = bh * k;
    const place = (start: number, size: number, D: number, D2: number, n: number) => {
      const before = start;
      const after = D - start - size;
      // Centred (margins alike) stays centred.
      if (Math.abs(before - after) > D * 0.02) {
        if (before < D * 0.1 && before < after) return before * k;
        if (after < D * 0.1 && after < before) return D2 - after * k - n;
      }
      return ((start + size / 2) / D) * D2 - n / 2;
    };
    const clamp = (v: number, n: number, D2: number) => (n <= D2 ? Math.min(Math.max(v, 0), D2 - n) : v);
    const nx = clamp(place(bx, bw, W, W2, nw), nw, W2);
    const ny = clamp(place(by, bh, H, H2, nh), nh, H2);
    for (const i of block) {
      const id = content[i]!;
      const b = boxes[i]!;
      scaleNode(doc, tx, id, k);
      tx.set(id, 'x', Math.round((nx + (b.x - bx) * k) * 100) / 100);
      tx.set(id, 'y', Math.round((ny + (b.y - by) * k) * 100) / 100);
    }
  }
}

/** Copies of `frame` in the given sizes, one after another past its row; returns them in order. */
export function fitToFormats(doc: Document, tx: Transaction, frame: NodeId, formats: readonly { width: number; height: number; label: string }[]): NodeId[] {
  const parent = doc.parent(frame)!;
  const W = doc.get(frame, 'width');
  const H = doc.get(frame, 'height');
  const top = doc.get(frame, 'y');
  const bottom = top + H;
  const row = doc.children(parent).filter((c) => doc.get(c, 'y') < bottom && doc.get(c, 'y') + doc.get(c, 'height') > top);
  let x = Math.max(...row.map((f) => doc.get(f, 'x') + doc.get(f, 'width'))) + 100;
  const out: NodeId[] = [];
  let after = row.reduce((a, f) => (doc.get(f, 'x') > doc.get(a, 'x') ? f : a), frame);
  const base = String(doc.get(frame, 'name')).replace(/ — .*$/, '');
  for (const f of formats) {
    const copy = cloneLayer(doc, tx, frame, parent, { after }, { name: `${base} — ${f.label}`, x, y: top });
    adapt(doc, tx, copy, W, H, f.width, f.height);
    out.push(copy);
    after = copy;
    x += f.width + 100;
  }
  return out;
}
