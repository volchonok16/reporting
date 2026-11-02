// Outlines of layers as vector paths in their own coordinates: built-in shapes,
// vectors, and the live result of boolean operations (computed from children,
// cached until one of them changes).

import { SHAPE_TYPES, type Document, type NodeId, type VectorNetwork, type VectorPath } from '#core';
import { booleanAll, flattenPaths, networkFromPaths, networkPaths, roundNetwork, strokeChains, variableStrokeOutline, nodeTransform, shapePaths, transformPaths, type NetworkPart, type Region } from '#geometry';

/** How a vector network is drawn: what is filled, what is stroked, and how. */
export interface VectorDrawing {
  fill: VectorPath[];
  stroke: VectorPath[];
  evenOdd: boolean;
  /** Regions with paints of their own, drawn over the fill. */
  parts: NetworkPart[];
  /**
   * Some segments are outside every region (lines, tails): the stroke follows
   * every segment once, centred. Otherwise it follows the regions' outlines
   * and the layer's stroke alignment.
   */
  strokeCentered: boolean;
}

const drawings = new WeakMap<VectorNetwork, { radius: number; drawing: VectorDrawing }>();

/** The drawing of a vector made of a network; null for vectors kept as contours (and other layers). */
export function vectorDrawing(doc: Document, id: NodeId): VectorDrawing | null {
  if (doc.type(id) !== 'VECTOR') return null;
  const stored = doc.get(id, 'vectorNetwork');
  if (!stored) return null;
  // Rounded corners (the points' own radii or the layer's) are part of the drawing, not of the points.
  const radius = doc.get(id, 'cornerRadius');
  const cached = drawings.get(stored);
  let d = cached && cached.radius === radius ? cached.drawing : undefined;
  if (!d) {
    const net = roundNetwork(stored, radius);
    const { fill, stroke, evenOdd, parts, outline } = networkPaths(net);
    const inRegions = new Set(net.regions.flatMap((r) => r.loops.flat()));
    const all = net.segments.every((_, i) => inRegions.has(i));
    d = all && outline.length > 0 ? { fill, stroke: outline, evenOdd, parts, strokeCentered: false } : { fill, stroke, evenOdd, parts, strokeCentered: true };
    drawings.set(stored, { radius, drawing: d });
  }
  return d;
}

const booleanCache = new Map<NodeId, { key: string; paths: VectorPath[] }>();

/** Outline of a layer in its own space; empty for layers without one (text, frames…). */
export function nodePaths(doc: Document, id: NodeId): VectorPath[] {
  const type = doc.type(id);
  if (type === 'VECTOR') {
    const d = vectorDrawing(doc, id);
    if (!d) {
      const radius = doc.get(id, 'cornerRadius');
      const paths = doc.get(id, 'vectorPaths');
      // Rounded as a network: joins of curves round too (as in Figma), not only of straight lines.
      return radius > 0 ? paths.map((p) => strokeChains(roundNetwork(networkFromPaths([p]), radius))[0] ?? p) : paths;
    }
    return d.strokeCentered ? [...d.fill, ...d.parts.flatMap((p) => p.fill), ...d.stroke] : d.stroke;
  }
  if (type === 'BOOLEAN_OPERATION') return booleanPaths(doc, id);
  if (type === 'GROUP') return childPaths(doc, id).flatMap((c) => c.paths);
  if (!SHAPE_TYPES.includes(type) && type !== 'FRAME') return [];
  return shapePaths(type, {
    width: doc.get(id, 'width'),
    height: doc.get(id, 'height'),
    cornerRadius: doc.get(id, 'cornerRadius'),
    cornerRadii: doc.get(id, 'cornerRadii'),
    pointCount: doc.get(id, 'pointCount'),
    innerRadius: doc.get(id, 'innerRadius'),
    arc: type === 'ELLIPSE' ? doc.get(id, 'arc') : null,
  });
}

/** Children's outlines in the parent's space, with their fill rules. */
function childPaths(doc: Document, parent: NodeId): { paths: VectorPath[]; rule: 'NONZERO' | 'EVENODD' }[] {
  return doc
    .children(parent)
    .filter((c) => doc.get(c, 'visible'))
    .map((c) => ({
      paths: transformPaths(nodePaths(doc, c), nodeTransform(doc.get(c, 'x'), doc.get(c, 'y'), doc.get(c, 'rotation'))),
      rule: doc.type(c) === 'VECTOR' ? doc.get(c, 'windingRule') : ('NONZERO' as const),
    }))
    .filter((c) => c.paths.length > 0);
}

/** Region (polygons) of an outline: curves flattened finely enough for any zoom used in practice. */
export function regionOf(paths: readonly VectorPath[], rule: 'NONZERO' | 'EVENODD' = 'NONZERO'): Region {
  return { contours: flattenPaths(paths, 0.05).filter((p) => p.points.length >= 3).map((p) => p.points), rule };
}

function booleanPaths(doc: Document, id: NodeId): VectorPath[] {
  const children = childPaths(doc, id);
  const op = doc.get(id, 'booleanOp');
  const key = op + JSON.stringify(children);
  const cached = booleanCache.get(id);
  if (cached && cached.key === key) return cached.paths;
  const result = booleanAll(
    op,
    children.map((c) => regionOf(c.paths, c.rule)),
  );
  const paths: VectorPath[] = result.contours.map((contour) => ({ closed: true, points: contour.map((p) => ({ x: p.x, y: p.y })) }));
  booleanCache.set(id, { key, paths });
  if (booleanCache.size > 2000) booleanCache.clear();
  return paths;
}

/** The lines a layer's stroke follows (a vector's stroke chains; a shape's outline). */
export function strokeLinePaths(d: Document, id: NodeId): VectorPath[] {
  const drawing = d.type(id) === 'VECTOR' ? vectorDrawing(d, id) : null;
  return drawing ? drawing.stroke : nodePaths(d, id);
}

/** The stroke shape of a layer with a width profile or a brush (its own seed: the same look every time). */
export function variableStrokeOf(d: Document, id: NodeId): VectorPath[] {
  const paths = strokeLinePaths(d, id);
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (Math.imul(seed, 31) + id.charCodeAt(i)) | 0;
  const cap = d.get(id, 'strokeCap');
  return variableStrokeOutline(paths, { weight: d.get(id, 'strokeWeight'), profile: d.get(id, 'strokeProfile'), points: d.get(id, 'widthPoints'), custom: d.get(id, 'customBrush'), brush: d.get(id, 'brush'), roundCaps: cap === 'ROUND' || d.get(id, 'brush') !== 'NONE', seed });
}
