// Viewport: maps world (canvas) coordinates to screen pixels (CSS px).
// screen = world * zoom + offset

import type { Point, Rect } from '#geometry';

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 256;

/** Zoom presets used by +/- (FR-CNV-011). */
export const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.06, 0.12, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

export class Viewport {
  zoom = 1;
  offsetX = 0;
  offsetY = 0;

  screenToWorld(p: Point): Point {
    return { x: (p.x - this.offsetX) / this.zoom, y: (p.y - this.offsetY) / this.zoom };
  }

  worldToScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.offsetX, y: p.y * this.zoom + this.offsetY };
  }

  /** World-space rectangle visible in a screen of the given size. */
  visibleRect(width: number, height: number): Rect {
    const tl = this.screenToWorld({ x: 0, y: 0 });
    return { x: tl.x, y: tl.y, width: width / this.zoom, height: height / this.zoom };
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }

  /** Zooms so that the world point under `screen` stays under it. */
  zoomAt(screen: Point, zoom: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const world = this.screenToWorld(screen);
    this.zoom = next;
    this.offsetX = screen.x - world.x * next;
    this.offsetY = screen.y - world.y * next;
  }

  /** Next preset above or below the current zoom. */
  stepZoom(direction: 1 | -1): number {
    if (direction > 0) return ZOOM_STEPS.find((z) => z > this.zoom + 1e-9) ?? MAX_ZOOM;
    return [...ZOOM_STEPS].reverse().find((z) => z < this.zoom - 1e-9) ?? MIN_ZOOM;
  }

  /** Fits a world rectangle into the screen with padding; never zooms past `maxZoom`. */
  fit(target: Rect, screenWidth: number, screenHeight: number, padding = 64, maxZoom = 1): void {
    const w = Math.max(1, target.width);
    const h = Math.max(1, target.height);
    const zoom = Math.min(maxZoom, (screenWidth - padding * 2) / w, (screenHeight - padding * 2) / h);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.offsetX = screenWidth / 2 - (target.x + target.width / 2) * this.zoom;
    this.offsetY = screenHeight / 2 - (target.y + target.height / 2) * this.zoom;
  }

  toJSON() {
    return { zoom: this.zoom, offsetX: this.offsetX, offsetY: this.offsetY };
  }

  restore(state: { zoom: number; offsetX: number; offsetY: number }): void {
    this.zoom = state.zoom;
    this.offsetX = state.offsetX;
    this.offsetY = state.offsetY;
  }
}
