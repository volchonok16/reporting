// Drawing of prototype connections on the canvas (FR-PRT-001): blue arrows from
// layers to the screens they open, flow start flags, and the "+" handle that is
// dragged onto a screen to connect. Only drawn while the right panel is on the
// "Prototype" tab. Everything here only draws or measures; canvas-view owns input.

import type { NodeId } from '#core';
import type { Point, Rect } from '#geometry';
import type { Editor } from '../editor.ts';
import { connections } from './model.ts';

export const PROTO_COLOR = '#4F5BD5';
export const CONNECT_HANDLE = 14;

type Ctx = CanvasRenderingContext2D;

function screenRect(editor: Editor, r: Rect): Rect {
  const a = editor.viewport.worldToScreen({ x: r.x, y: r.y });
  const z = editor.viewport.zoom;
  return { x: a.x, y: a.y, width: r.width * z, height: r.height * z };
}

/** Start and end of an arrow between two screen-space boxes, leaving the side that faces the target. */
export function arrowEnds(from: Rect, to: Rect): { a: Point; b: Point; dir: 1 | -1 } {
  const forward = to.x + to.width / 2 >= from.x + from.width / 2;
  const a = { x: forward ? from.x + from.width : from.x, y: from.y + from.height / 2 };
  const inset = Math.min(24, to.height / 2);
  const y = Math.max(to.y + inset, Math.min(to.y + to.height - inset, a.y));
  const b = { x: forward ? to.x : to.x + to.width, y };
  return { a, b, dir: forward ? 1 : -1 };
}

/** A smooth arrow from a to b, leaving and arriving horizontally. */
export function drawArrow(ctx: Ctx, a: Point, b: Point, dir: 1 | -1, color: string, width: number, dashed = false): void {
  const reach = Math.max(40, Math.abs(b.x - a.x) / 2);
  ctx.save();
  if (dashed) ctx.setLineDash([5, 4]);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.bezierCurveTo(a.x + reach * dir, a.y, b.x - reach * dir, b.y, b.x - 6 * dir, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  // Arrow head and the dot at the start.
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - 8 * dir, b.y - 4.5);
  ctx.lineTo(b.x - 8 * dir, b.y + 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * All connections of the page. With a selection, the selection's own arrows are
 * drawn strong and the others faint, so the picture stays readable on big files.
 */
export function drawConnections(ctx: Ctx, editor: Editor): void {
  const { doc, scene } = editor;
  const list = connections(doc, editor.pageId);
  if (list.length === 0) return;
  const selected = new Set(editor.selection);
  const isSelected = (id: NodeId) => selected.has(id) || doc.store.ancestors(id).some((a) => selected.has(a));
  const any = selected.size > 0;
  // Faint ones first, highlighted on top.
  const sorted = [...list].sort((x, y) => Number(isSelected(x.source)) - Number(isSelected(y.source)));
  for (const c of sorted) {
    if (!doc.get(c.source, 'visible')) continue;
    const from = screenRect(editor, scene.bounds(c.source));
    const to = screenRect(editor, scene.bounds(c.destination));
    const { a, b, dir } = arrowEnds(from, to);
    const strong = !any || isSelected(c.source);
    ctx.globalAlpha = strong ? 1 : 0.35;
    // Overlays are drawn dashed: they open over the screen instead of replacing it.
    drawArrow(ctx, a, b, dir, PROTO_COLOR, strong && any ? 2 : 1.5, c.overlay);
    ctx.globalAlpha = 1;
  }
}

/** Where the "+" handle of a layer sits: the middle of its right edge, in screen space. */
export function connectHandlePoint(editor: Editor, id: NodeId): Point {
  const r = screenRect(editor, editor.scene.bounds(id));
  return { x: r.x + r.width, y: r.y + r.height / 2 };
}

export function drawConnectHandle(ctx: Ctx, p: Point, active: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, CONNECT_HANDLE / 2, 0, Math.PI * 2);
  ctx.fillStyle = active ? PROTO_COLOR : '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = PROTO_COLOR;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = active ? '#FFFFFF' : PROTO_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.x - 3.5, p.y);
  ctx.lineTo(p.x + 3.5, p.y);
  ctx.moveTo(p.x, p.y - 3.5);
  ctx.lineTo(p.x, p.y + 3.5);
  ctx.stroke();
  ctx.restore();
}

/** The connection being dragged out of a handle; the screen under the pointer is outlined. */
export function drawPendingConnection(ctx: Ctx, editor: Editor, from: Point, to: Point, target: NodeId | null): void {
  if (target) {
    const r = screenRect(editor, editor.scene.bounds(target));
    ctx.save();
    ctx.strokeStyle = PROTO_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.restore();
    const { b, dir } = arrowEnds({ x: from.x, y: from.y, width: 0, height: 0 }, r);
    drawArrow(ctx, from, b, dir, PROTO_COLOR, 2);
    return;
  }
  drawArrow(ctx, from, to, to.x >= from.x ? 1 : -1, PROTO_COLOR, 2);
}

/** Blue flag with the flow name, drawn instead of the plain frame title (FR-PRT-002). */
export function drawFlowFlag(ctx: Ctx, p: Point, name: string, maxWidth: number): number {
  ctx.save();
  ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  let text = name;
  while (text.length > 1 && ctx.measureText(text).width > maxWidth - 26) text = text.slice(0, -1);
  if (text !== name) text += '…';
  const w = ctx.measureText(text).width + 24;
  ctx.fillStyle = PROTO_COLOR;
  ctx.beginPath();
  ctx.roundRect(p.x, p.y - 20, w, 17, 4);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.moveTo(p.x + 7, p.y - 15.5);
  ctx.lineTo(p.x + 13, p.y - 11.5);
  ctx.lineTo(p.x + 7, p.y - 7.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillText(text, p.x + 17, p.y - 11);
  ctx.restore();
  return w;
}
