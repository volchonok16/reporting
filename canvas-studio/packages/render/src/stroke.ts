// Stroke helpers shared by the canvas renderer and the SVG and PDF exporters.

import { lineDash, lineKindOf, type Document, type NodeId } from '#core';

/** Types whose strokes can have different weights per side (FR-DRW-060). */
export const RECT_LIKE: ReadonlySet<string> = new Set(['RECTANGLE', 'SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** Corner radii [tl, tr, br, bl] of a rectangle or frame. */
export function rectRadii(d: Document, id: NodeId, w: number, h: number): [number, number, number, number] {
  const max = Math.min(w, h) / 2;
  const radii = d.get(id, 'cornerRadii');
  const r = d.get(id, 'cornerRadius');
  return (radii ?? [r, r, r, r]).map((v) => Math.min(Math.max(0, v), max)) as [number, number, number, number];
}

/**
 * Dashes to draw. A board line (a connector, a shape's outline) keeps its kind
 * and the steps follow its weight: boards saved before BUG-082 hold 6/6 at any
 * weight, which a thick line with round ends closes up into a solid one.
 */
export function dashOf(d: Document, id: NodeId): number[] {
  const dash = d.get(id, 'dashPattern');
  if (dash.length === 0 || !d.get(id, 'board')) return [...dash];
  return lineDash(lineKindOf(dash), d.get(id, 'strokeWeight'), d.get(id, 'strokeCap') !== 'NONE');
}

/** Per-side weights of a node, or null when the stroke is uniform or the type has no sides. */
export function sideWeights(d: Document, id: NodeId): [number, number, number, number] | null {
  const sides = d.get(id, 'strokeWeights');
  return sides && RECT_LIKE.has(d.type(id)) ? sides : null;
}
