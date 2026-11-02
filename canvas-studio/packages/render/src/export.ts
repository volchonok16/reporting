// Raster export (FR-EXP-001): renders a node with the same renderer as the canvas.

import { tr } from '#core';
import type { Document, NodeId } from '#core';
import { hasFilters } from './pixels.ts';
import { inflate, warpExtent, type Rect } from '#geometry';
import type { Canvas2DRenderer } from './canvas-renderer.ts';
import type { SceneGraph } from './scene.ts';

export interface ExportOptions {
  scale: number;
  format: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number;
  /** Background for formats without alpha. */
  background?: string;
}

/** Renders a node (with strokes and shadows) into an offscreen canvas at `scale`. */
export async function rasterize(renderer: Canvas2DRenderer, scene: SceneGraph, id: NodeId, scale: number, background?: string, options: { children?: boolean } = {}): Promise<{ canvas: OffscreenCanvas; bounds: Rect }> {
  scene.ensure();
  const bounds = inflate(scene.renderBounds(id), 0);
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(tr('Canvas 2D недоступен'));
  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
    // Position the context in the node's parent space.
    const parent = scene.doc.parent(id);
    if (parent && scene.doc.type(parent) !== 'PAGE') {
      const m = scene.world(parent);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    renderer.renderNode(ctx, scene, id, bounds, scale, options);
  };
  draw();
  // Image fills decode asynchronously: wait for them and draw again so the file has the real pixels.
  await renderer.images.settled();
  draw();
  return { canvas, bounds };
}

export async function exportNode(renderer: Canvas2DRenderer, scene: SceneGraph, id: NodeId, options: ExportOptions): Promise<Blob> {
  const background = options.background ?? (options.format === 'image/jpeg' ? '#FFFFFF' : undefined);
  const { canvas } = await rasterize(renderer, scene, id, options.scale, background);
  return canvas.convertToBlob({ type: options.format, quality: options.quality });
}

/**
 * Draws a node scaled to fit a small canvas (asset thumbnails). Works for nodes
 * on any page: transforms are computed on demand for nodes outside the scene's page.
 */
export function renderThumbnail(renderer: Canvas2DRenderer, scene: SceneGraph, id: NodeId, canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, padding = 4): void {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bounds = scene.bounds(id);
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const k = Math.min((cssWidth - padding * 2) / bounds.width, (cssHeight - padding * 2) / bounds.height, 4);
  const ox = (cssWidth - bounds.width * k) / 2;
  const oy = (cssHeight - bounds.height * k) / 2;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (ox - bounds.x * k), dpr * (oy - bounds.y * k));
  const parent = scene.doc.parent(id);
  if (parent && scene.doc.type(parent) !== 'PAGE') {
    const m = scene.world(parent);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  }
  renderer.renderNode(ctx, scene, id, bounds, k * dpr);
}

/**
 * Looks vector formats cannot express, so the layer goes into SVG, PDF and PPTX as its
 * picture: a warp, glass, texture, coloured noise, Plus darker / lighter, a pattern, an
 * adjusted or turned image, a mask by outline or brightness.
 */
export function needsPicture(doc: Document, id: NodeId): boolean {
  if (doc.get(id, 'warp')) return true;
  if (doc.get(id, 'effects').some((e) => e.visible && (e.type === 'GLASS' || e.type === 'TEXTURE' || (e.type === 'NOISE' && !!e.noiseType)))) return true;
  const blend = doc.get(id, 'blendMode');
  if (blend === 'PLUS_DARKER' || blend === 'PLUS_LIGHTER') return true;
  const paints = [...doc.get(id, 'fills'), ...doc.get(id, 'strokes')];
  if (paints.some((p) => p.visible && (p.type === 'PATTERN' || (p.type === 'IMAGE' && (!!p.rotation || !!p.flipX || !!p.flipY || hasFilters(p.filters)))))) return true;
  return doc.children(id).some((c) => doc.get(c, 'isMask') && doc.get(c, 'maskType') !== 'ALPHA');
}

/**
 * A layer's picture for SVG (`SvgOptions.picture`), for what `needsPicture` lists: drawn
 * as on the canvas at `scale`, with where it lies in the layer's own space. Null outside a browser.
 */
export function layerPicture(renderer: Canvas2DRenderer, scene: SceneGraph, id: NodeId, scale = 2): { href: string; x: number; y: number; width: number; height: number } | null {
  const d = scene.doc;
  if (typeof document === 'undefined') return null;
  scene.ensure();
  const w = d.get(id, 'width');
  const h = d.get(id, 'height');
  const warp = d.get(id, 'warp');
  const e = warp ? warpExtent(warp) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const m = scene.paintMargins(id);
  const rect = { x: e.minX * w - m.left, y: e.minY * h - m.top, width: (e.maxX - e.minX) * w + m.left + m.right, height: (e.maxY - e.minY) * h + m.top + m.bottom };
  const side = Math.max(rect.width, rect.height);
  const k = Math.min(scale, 4096 / Math.max(1, side));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.ceil(rect.width * k)), height: Math.max(1, Math.ceil(rect.height * k)) });
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // The layer's own space: drawing it puts it at its place, so that place is undone first.
  ctx.setTransform(k, 0, 0, k, -rect.x * k, -rect.y * k);
  ctx.rotate((-d.get(id, 'rotation') * Math.PI) / 180);
  ctx.translate(-d.get(id, 'x'), -d.get(id, 'y'));
  renderer.renderNode(ctx, scene, id, scene.renderBounds(id), k);
  return { href: canvas.toDataURL('image/png'), ...rect };
}
