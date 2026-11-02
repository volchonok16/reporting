// Cropping a picture (October list): the geometry, without the DOM. The kept
// part is a rectangle in shares of the whole picture (0..1), so it does not
// depend on how large the picture is shown.

import type { ImageCrop } from '#core';

export type CropRect = Omit<ImageCrop, 'source'>;
export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const FULL: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Moves an edge, a corner or the whole rectangle by (dx, dy) shares of the
 * picture. `ratio` — width/height to keep, in shares (pixel aspect × H/W), or null.
 * The result stays inside the picture and is never smaller than `min`.
 */
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number, ratio: number | null, min = 0.02): CropRect {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - min);
  if (handle.includes('e')) right = clamp(right + dx, left + min, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min, 1);
  if (ratio === null) return { x: left, y: top, width: right - left, height: bottom - top };
  // Keep the proportion: the dragged side leads, the other follows (from the opposite corner,
  // or around the middle for an edge), and both shrink if the picture's border is reached.
  const horizontal = handle === 'e' || handle === 'w';
  const vertical = handle === 'n' || handle === 's';
  let width = right - left;
  let height = bottom - top;
  if (horizontal) height = width / ratio;
  else if (vertical) width = height * ratio;
  else if (width / height > ratio) height = width / ratio;
  else width = height * ratio;
  const anchorX = handle.includes('w') ? right : handle.includes('e') ? left : (left + right) / 2;
  const anchorY = handle.includes('n') ? bottom : handle.includes('s') ? top : (top + bottom) / 2;
  const roomX = handle.includes('w') ? anchorX : handle.includes('e') ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX);
  const roomY = handle.includes('n') ? anchorY : handle.includes('s') ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY);
  const k = Math.min(1, roomX / width, roomY / height);
  width *= k;
  height *= k;
  const x = handle.includes('w') ? anchorX - width : handle.includes('e') ? anchorX : anchorX - width / 2;
  const y = handle.includes('n') ? anchorY - height : handle.includes('s') ? anchorY : anchorY - height / 2;
  return { x, y, width, height };
}

/** The largest rectangle of a proportion inside `within`, centred in it. */
export function fitRatio(within: CropRect, ratio: number): CropRect {
  let width = within.width;
  let height = width / ratio;
  if (height > within.height) {
    height = within.height;
    width = height * ratio;
  }
  return { x: within.x + (within.width - width) / 2, y: within.y + (within.height - height) / 2, width, height };
}

/**
 * Where the layer goes after a new crop, so the picture stays where it was on
 * the canvas and only the kept part shows (as Figma does). A rotated layer
 * keeps its place and only changes size.
 */
export function layerAfterCrop(layer: { x: number; y: number; width: number; height: number; rotation: number }, before: CropRect, after: CropRect): { x: number; y: number; width: number; height: number } {
  const sx = layer.width / before.width;
  const sy = layer.height / before.height;
  const width = after.width * sx;
  const height = after.height * sy;
  if (layer.rotation !== 0) return { x: layer.x, y: layer.y, width, height };
  return { x: layer.x + (after.x - before.x) * sx, y: layer.y + (after.y - before.y) * sy, width, height };
}

/** Whether a rectangle keeps (almost) the whole picture. */
export function isFull(r: CropRect): boolean {
  return r.x < 0.001 && r.y < 0.001 && r.width > 0.999 && r.height > 0.999;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
