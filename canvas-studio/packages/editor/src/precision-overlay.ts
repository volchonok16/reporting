// Drawing of precision overlays on the canvas (stage "Precision"): layout
// grids of frames, the pixel grid, ruler guides, rulers, equal-gap markers,
// distance labels and the eyedropper loupe. Kept apart from canvas-view so the
// interaction code stays readable; everything here only draws.

import { colorToHex, type Color } from '#core';
import { gridTracks, intersects, type Measurement, type Point, type Rect, type SpacingMatch } from '#geometry';
import type { Editor } from './editor.ts';

export const RULER = 20;
export const MEASURE_COLOR = '#F24822';
export const SPACING_COLOR = '#FF00A8';
export const GUIDE_COLOR = '#F24822';
const FONT = '10px system-ui, -apple-system, "Segoe UI", sans-serif';

type Ctx = CanvasRenderingContext2D;

function css(c: Color): string {
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
}

/** Layout grids of frames in view (FR-GRD-001), drawn over the content. */
export function drawLayoutGrids(ctx: Ctx, editor: Editor): void {
  if (!editor.view.layoutGrids) return;
  const { doc, scene, viewport } = editor;
  const visible = viewport.visibleRect(editor.screenSize.width, editor.screenSize.height);
  const z = viewport.zoom;
  for (const id of editor.layoutGridFrames()) {
    const grids = doc.get(id, 'layoutGrids');
    if (grids.length === 0 || !doc.store.isAlive(id) || !intersects(scene.bounds(id), visible)) continue;
    const m = scene.world(id);
    if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9) continue;
    const w = doc.get(id, 'width');
    const h = doc.get(id, 'height');
    const o = viewport.worldToScreen({ x: m.e, y: m.f });
    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, w * z, h * z);
    ctx.clip();
    for (const grid of grids) {
      if (!grid.visible) continue;
      if (grid.pattern === 'GRID') {
        const step = Math.max(1, grid.sectionSize) * z;
        if (step < 4) continue; // too dense to be useful at this zoom
        ctx.strokeStyle = css(grid.color);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= w * z + 0.5; x += step) {
          ctx.moveTo(Math.round(o.x + x) + 0.5, o.y);
          ctx.lineTo(Math.round(o.x + x) + 0.5, o.y + h * z);
        }
        for (let y = 0; y <= h * z + 0.5; y += step) {
          ctx.moveTo(o.x, Math.round(o.y + y) + 0.5);
          ctx.lineTo(o.x + w * z, Math.round(o.y + y) + 0.5);
        }
        ctx.stroke();
        continue;
      }
      const t = gridTracks(grid, w, h);
      if (!t) continue;
      ctx.fillStyle = css(grid.color);
      for (const [a, b] of t.tracks) {
        if (t.axis === 'x') ctx.fillRect(o.x + a * z, o.y, (b - a) * z, h * z);
        else ctx.fillRect(o.x, o.y + a * z, w * z, (b - a) * z);
      }
    }
    ctx.restore();
  }
}

/** Lines between device pixels from 800 % zoom up. */
export function drawPixelGrid(ctx: Ctx, editor: Editor): void {
  const z = editor.viewport.zoom;
  if (!editor.view.pixelGrid || z < 8) return;
  const { width, height } = editor.screenSize;
  const tl = editor.viewport.screenToWorld({ x: 0, y: 0 });
  const startX = Math.floor(tl.x);
  const startY = Math.floor(tl.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; ; x++) {
    const sx = editor.viewport.worldToScreen({ x, y: 0 }).x;
    if (sx > width) break;
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, height);
  }
  for (let y = startY; ; y++) {
    const sy = editor.viewport.worldToScreen({ x: 0, y }).y;
    if (sy > height) break;
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(width, Math.round(sy) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Ruler guides of the page and of frames (FR-CNV-044). `active` is highlighted (being dragged or hovered). */
export function drawGuides(ctx: Ctx, editor: Editor, active: { owner: string; index: number } | null): void {
  const { width, height } = editor.screenSize;
  ctx.save();
  ctx.lineWidth = 1;
  for (const g of editor.worldGuides()) {
    const on = active && active.owner === g.owner && active.index === g.index;
    ctx.strokeStyle = on ? '#4F5BD5' : GUIDE_COLOR;
    ctx.globalAlpha = on ? 1 : 0.85;
    ctx.beginPath();
    if (g.axis === 'X') {
      const x = Math.round(editor.viewport.worldToScreen({ x: g.at, y: 0 }).x) + 0.5;
      const span = g.span ? [editor.viewport.worldToScreen({ x: 0, y: g.span.y }).y, editor.viewport.worldToScreen({ x: 0, y: g.span.y + g.span.height }).y] : [0, height];
      ctx.moveTo(x, span[0]!);
      ctx.lineTo(x, span[1]!);
    } else {
      const y = Math.round(editor.viewport.worldToScreen({ x: 0, y: g.at }).y) + 0.5;
      const span = g.span ? [editor.viewport.worldToScreen({ x: g.span.x, y: 0 }).x, editor.viewport.worldToScreen({ x: g.span.x + g.span.width, y: 0 }).x] : [0, width];
      ctx.moveTo(span[0]!, y);
      ctx.lineTo(span[1]!, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** A guide being dragged out of a ruler, with its position. */
export function drawNewGuide(ctx: Ctx, editor: Editor, axis: 'X' | 'Y', at: number): void {
  const { width, height } = editor.screenSize;
  ctx.save();
  ctx.strokeStyle = '#4F5BD5';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (axis === 'X') {
    const x = Math.round(editor.viewport.worldToScreen({ x: at, y: 0 }).x) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  } else {
    const y = Math.round(editor.viewport.worldToScreen({ x: 0, y: at }).y) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Step between ruler ticks: a "nice" number of world units ≥ 50 screen px. */
function rulerStep(zoom: number): number {
  const target = 50 / zoom;
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const k of [1, 2, 5, 10]) if (k * pow >= target) return k * pow;
  return 10 * pow;
}

/**
 * Rulers along the top and left edges (FR-CNV-044), with the selection's extent
 * highlighted and labelled, as in Figma.
 */
export function drawRulers(ctx: Ctx, editor: Editor, selection: Rect | null, dark: boolean): void {
  if (!editor.view.rulers) return;
  const { width, height } = editor.screenSize;
  const vp = editor.viewport;
  const bg = dark ? '#2C2C2C' : '#FFFFFF';
  const fg = dark ? '#B3B3B3' : '#6B6B6B';
  const line = dark ? '#444444' : '#E6E6E6';
  ctx.save();
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, RULER);
  ctx.fillRect(0, 0, RULER, height);
  // Selection extent.
  if (selection) {
    const a = vp.worldToScreen({ x: selection.x, y: selection.y });
    const b = vp.worldToScreen({ x: selection.x + selection.width, y: selection.y + selection.height });
    ctx.fillStyle = 'rgba(79, 91, 213, 0.15)';
    ctx.fillRect(a.x, 0, b.x - a.x, RULER);
    ctx.fillRect(0, a.y, RULER, b.y - a.y);
  }
  const step = rulerStep(vp.zoom);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.fillStyle = fg;
  const tl = vp.screenToWorld({ x: 0, y: 0 });
  const br = vp.screenToWorld({ x: width, y: height });
  const label = (v: number) => String(Math.round(v * 100) / 100);
  // Tick labels give way to the selection's edge labels.
  const selA = selection ? vp.worldToScreen({ x: selection.x, y: selection.y }) : null;
  const selB = selection ? vp.worldToScreen({ x: selection.x + selection.width, y: selection.y + selection.height }) : null;
  const nearX = (sx: number) => !!selA && !!selB && (Math.abs(sx - selA.x) < 34 || Math.abs(sx - selB.x) < 34);
  const nearY = (sy: number) => !!selA && !!selB && (Math.abs(sy - selA.y) < 34 || Math.abs(sy - selB.y) < 34);
  for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
    const sx = Math.round(vp.worldToScreen({ x, y: 0 }).x) + 0.5;
    if (sx < RULER) continue;
    ctx.moveTo(sx, RULER - 6);
    ctx.lineTo(sx, RULER);
    if (!nearX(sx)) ctx.fillText(label(x), sx + 3, RULER / 2 - 1);
    // Minor ticks.
    for (let k = 1; k < 5; k++) {
      const mx = Math.round(vp.worldToScreen({ x: x + (step * k) / 5, y: 0 }).x) + 0.5;
      ctx.moveTo(mx, RULER - 3);
      ctx.lineTo(mx, RULER);
    }
  }
  for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
    const sy = Math.round(vp.worldToScreen({ x: 0, y }).y) + 0.5;
    if (sy < RULER) continue;
    ctx.moveTo(RULER - 6, sy);
    ctx.lineTo(RULER, sy);
    for (let k = 1; k < 5; k++) {
      const my = Math.round(vp.worldToScreen({ x: 0, y: y + (step * k) / 5 }).y) + 0.5;
      ctx.moveTo(RULER - 3, my);
      ctx.lineTo(RULER, my);
    }
    if (!nearY(sy)) {
      ctx.save();
      ctx.translate(RULER / 2 - 1, sy - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'left';
      ctx.fillText(label(y), 0, 0);
      ctx.restore();
    }
  }
  ctx.stroke();
  // Selection edges labelled on the rulers.
  if (selection) {
    const a = vp.worldToScreen({ x: selection.x, y: selection.y });
    const b = vp.worldToScreen({ x: selection.x + selection.width, y: selection.y + selection.height });
    ctx.fillStyle = '#4F5BD5';
    for (const [sx, v] of [
      [a.x, selection.x],
      [b.x, selection.x + selection.width],
    ] as const) {
      const text = label(v);
      const tw = ctx.measureText(text).width + 6;
      ctx.fillStyle = bg;
      ctx.fillRect(sx - tw / 2, 2, tw, RULER - 4);
      ctx.fillStyle = '#4F5BD5';
      ctx.textAlign = 'center';
      ctx.fillText(text, sx, RULER / 2 - 1);
    }
    for (const [sy, v] of [
      [a.y, selection.y],
      [b.y, selection.y + selection.height],
    ] as const) {
      const text = label(v);
      const tw = ctx.measureText(text).width + 6;
      ctx.save();
      ctx.translate(RULER / 2 - 1, sy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = bg;
      ctx.fillRect(-tw / 2, -RULER / 2 + 3, tw, RULER - 4);
      ctx.fillStyle = '#4F5BD5';
      ctx.textAlign = 'center';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }
  // Borders and the corner square.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, RULER, RULER);
  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(width, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, height);
  ctx.stroke();
  ctx.restore();
}

/** A label with a number in a coloured box, centred at `p`. */
function tag(ctx: Ctx, p: Point, text: string, color: string): void {
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(p.x - w / 2, p.y - 8, w, 16, 3);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, p.x, p.y + 0.5);
  ctx.textAlign = 'left';
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Distance lines with end ticks and labels (Alt measurements, neighbour distances). */
export function drawMeasurements(ctx: Ctx, editor: Editor, lines: readonly Measurement[], helpers: readonly { from: Point; to: Point }[], color = MEASURE_COLOR): void {
  const vp = editor.viewport;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const h of helpers) {
    const a = vp.worldToScreen(h.from);
    const b = vp.worldToScreen(h.to);
    ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  for (const m of lines) {
    const a = vp.worldToScreen(m.from);
    const b = vp.worldToScreen(m.to);
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    ctx.beginPath();
    ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
    ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    // End ticks.
    for (const p of [a, b]) {
      if (horizontal) {
        ctx.moveTo(Math.round(p.x) + 0.5, p.y - 3);
        ctx.lineTo(Math.round(p.x) + 0.5, p.y + 3);
      } else {
        ctx.moveTo(p.x - 3, Math.round(p.y) + 0.5);
        ctx.lineTo(p.x + 3, Math.round(p.y) + 0.5);
      }
    }
    ctx.stroke();
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 2) tag(ctx, { x: (a.x + b.x) / 2 + (horizontal ? 0 : 0), y: (a.y + b.y) / 2 + (horizontal ? 12 : 0) }, fmt(m.value), color);
  }
  ctx.restore();
}

/** Equal gaps (pink): a bar across each gap and its size. */
export function drawSpacing(ctx: Ctx, editor: Editor, matches: readonly SpacingMatch[]): void {
  const vp = editor.viewport;
  ctx.save();
  for (const match of matches) {
    for (const g of match.gaps) {
      const a = match.axis === 'x' ? vp.worldToScreen({ x: g.from, y: g.at }) : vp.worldToScreen({ x: g.at, y: g.from });
      const b = match.axis === 'x' ? vp.worldToScreen({ x: g.to, y: g.at }) : vp.worldToScreen({ x: g.at, y: g.to });
      ctx.fillStyle = 'rgba(255, 0, 168, 0.12)';
      if (match.axis === 'x') ctx.fillRect(a.x, a.y - 6, b.x - a.x, 12);
      else ctx.fillRect(a.x - 6, a.y, 12, b.y - a.y);
      ctx.strokeStyle = SPACING_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      tag(ctx, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (match.axis === 'x' ? 14 : 0) }, fmt(match.value), SPACING_COLOR);
    }
  }
  ctx.restore();
}

/** The eyedropper's loupe: magnified pixels around the pointer with the colour under it (FR-DRW-053). */
export function drawLoupe(ctx: Ctx, at: Point, pixels: ImageData | null, color: Color | null): void {
  if (!pixels) return;
  const cells = pixels.width;
  const cell = 8;
  const size = cells * cell;
  const x = at.x + 16;
  const y = at.y + 16;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  for (let j = 0; j < pixels.height; j++) {
    for (let i = 0; i < cells; i++) {
      const k = (j * cells + i) * 4;
      ctx.fillStyle = `rgb(${pixels.data[k]}, ${pixels.data[k + 1]}, ${pixels.data[k + 2]})`;
      ctx.fillRect(x + i * cell, y + j * cell, cell, cell);
    }
  }
  // Lines between the magnified pixels, always: on a flat colour the loupe would otherwise
  // look like a plain circle and the grid show only at edges (it seemed to come and go).
  // Mid grey is seen on light and dark pixels alike.
  ctx.beginPath();
  for (let i = 1; i < cells; i++) {
    ctx.moveTo(x + i * cell + 0.5, y);
    ctx.lineTo(x + i * cell + 0.5, y + size);
  }
  for (let j = 1; j < pixels.height; j++) {
    ctx.moveTo(x, y + j * cell + 0.5);
    ctx.lineTo(x + size, y + j * cell + 0.5);
  }
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // The sampled pixel in the middle.
  const mid = Math.floor(cells / 2);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + mid * cell, y + mid * cell, cell, cell);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  if (color) tag(ctx, { x: x + size / 2, y: y + size + 14 }, colorToHex(color), '#1E1E1E');
}
