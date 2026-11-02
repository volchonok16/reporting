// Constraints (FR-LYR-020): how children of a frame without auto layout react
// when the frame is resized.

import { isFrameLike, isGroupLike, type ConstraintType, type Document, type Effect, type Length, type NodeId, type NodeProps, type Transaction, type VectorPath } from '#core';
import { mapNetwork } from '#geometry';

interface Span {
  start: number;
  size: number;
}

/** New position and size of a child span when the parent goes from `oldSize` to `newSize`. */
export function constrainSpan(type: ConstraintType, child: Span, oldSize: number, newSize: number): Span {
  const delta = newSize - oldSize;
  switch (type) {
    case 'MIN':
      return child;
    case 'MAX':
      return { start: child.start + delta, size: child.size };
    case 'STRETCH':
      return { start: child.start, size: Math.max(0, child.size + delta) };
    case 'CENTER':
      return { start: child.start + delta / 2, size: child.size };
    case 'SCALE': {
      const k = oldSize === 0 ? 1 : newSize / oldSize;
      return { start: child.start * k, size: child.size * k };
    }
  }
}

/**
 * Resizes `frame` to `width` × `height` and repositions its children by their constraints.
 * Children of auto layout frames are handled by the layout engine instead.
 */
export function resizeWithConstraints(doc: Document, tx: Transaction, frame: NodeId, width: number, height: number): void {
  const oldW = doc.get(frame, 'width');
  const oldH = doc.get(frame, 'height');
  const type = doc.type(frame);
  if (isGroupLike(type)) {
    // Groups scale their content (their size is their children's box).
    scaleChildren(doc, tx, frame, oldW === 0 ? 1 : width / oldW, oldH === 0 ? 1 : height / oldH);
    tx.set(frame, 'width', width);
    tx.set(frame, 'height', height);
    return;
  }
  tx.set(frame, 'width', width);
  tx.set(frame, 'height', height);
  if (type === 'VECTOR') {
    // Vector points live in the node's box: they scale with it.
    const sx = oldW === 0 ? 1 : width / oldW;
    const sy = oldH === 0 ? 1 : height / oldH;
    if (sx !== 1 || sy !== 1) {
      const net = doc.get(frame, 'vectorNetwork');
      if (net) tx.set(frame, 'vectorNetwork', mapNetwork(net, (p) => ({ x: p.x * sx, y: p.y * sy })));
      else tx.set(frame, 'vectorPaths', scalePaths(doc.get(frame, 'vectorPaths'), sx, sy));
    }
    return;
  }
  if (!isFrameLike(type) || doc.get(frame, 'layoutMode') !== 'NONE') return;
  for (const child of doc.children(frame)) {
    const c = doc.get(child, 'constraints');
    const h = constrainSpan(c.horizontal, { start: doc.get(child, 'x'), size: doc.get(child, 'width') }, oldW, width);
    const v = constrainSpan(c.vertical, { start: doc.get(child, 'y'), size: doc.get(child, 'height') }, oldH, height);
    tx.update(child, { x: h.start, y: v.start });
    if (h.size !== doc.get(child, 'width') || v.size !== doc.get(child, 'height')) {
      resizeWithConstraints(doc, tx, child, h.size, v.size);
    }
  }
}

function scalePaths(paths: VectorPath[], sx: number, sy: number): VectorPath[] {
  const f = (v: { x: number; y: number }) => ({ x: v.x * sx, y: v.y * sy });
  return paths.map((path) => ({
    closed: path.closed,
    points: path.points.map((p) => ({ ...f(p), ...(p.in ? { in: f(p.in) } : {}), ...(p.out ? { out: f(p.out) } : {}) })),
  }));
}

/** Scales a group's children proportionally (groups have no size of their own). */
export function scaleChildren(doc: Document, tx: Transaction, group: NodeId, sx: number, sy: number): void {
  // A repeat's spacing grows with it, or the copies would shrink while the circle stays.
  // Round a circle the copies point every way: they keep their proportions.
  const repeat = doc.get(group, 'repeat');
  if (repeat?.kind === 'RADIAL') sx = sy = Math.sqrt(sx * sy);
  if (repeat) {
    const k = repeat.kind === 'RADIAL' ? Math.sqrt(sx * sy) : repeat.direction === 'HORIZONTAL' ? sx : sy;
    tx.set(group, 'repeat', { ...repeat, radius: repeat.kind === 'RADIAL' ? Math.round(repeat.radius * k * 100) / 100 : repeat.radius, gap: repeat.kind === 'LINEAR' ? Math.round(repeat.gap * k * 100) / 100 : repeat.gap });
  }
  for (const child of doc.children(group)) {
    tx.update(child, {
      x: doc.get(child, 'x') * sx,
      y: doc.get(child, 'y') * sy,
    });
    // A turned layer is stretched along the group's axes: its own sides take the scale of the direction they point in.
    const angle = (doc.get(child, 'rotation') * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const w = doc.get(child, 'width') * (angle === 0 ? sx : Math.hypot(sx * cos, sy * sin));
    const h = doc.get(child, 'height') * (angle === 0 ? sy : Math.hypot(sx * sin, sy * cos));
    resizeWithConstraints(doc, tx, child, w, h);
  }
}

/**
 * Scales a layer and everything in it by `k` (Figma's scale tool, K): the box, and
 * with it what has a size of its own — stroke weights, corner radii, font sizes and
 * spacing, auto layout gaps and padding, effects, dashes, vector points. The
 * layer's own position is left to the caller; its children keep their places in it.
 */
export function scaleNode(doc: Document, tx: Transaction, id: NodeId, k: number): void {
  if (!(k > 0) || k === 1) return;
  const s = (v: number) => Math.round(v * k * 100) / 100;
  const g = <K extends keyof NodeProps>(key: K) => doc.get(id, key);
  const len = (l: Length | null): Length | null => (l && l.unit === 'PX' ? { unit: 'PX', value: s(l.value) } : l);
  const props: Partial<NodeProps> = {
    width: s(g('width')),
    height: s(g('height')),
    strokeWeight: s(g('strokeWeight')),
    cornerRadius: s(g('cornerRadius')),
    itemSpacing: s(g('itemSpacing')),
    counterAxisSpacing: s(g('counterAxisSpacing')),
    paddingTop: s(g('paddingTop')),
    paddingRight: s(g('paddingRight')),
    paddingBottom: s(g('paddingBottom')),
    paddingLeft: s(g('paddingLeft')),
    gridColumnGap: s(g('gridColumnGap')),
    gridRowGap: s(g('gridRowGap')),
    minWidth: len(g('minWidth')),
    maxWidth: len(g('maxWidth')),
    minHeight: len(g('minHeight')),
    maxHeight: len(g('maxHeight')),
    dashPattern: g('dashPattern').map(s),
    effects: g('effects').map((e): Effect => {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') return { ...e, offset: { x: s(e.offset.x), y: s(e.offset.y) }, radius: s(e.radius), spread: s(e.spread) };
      if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return { ...e, radius: s(e.radius) };
      if (e.type === 'TEXTURE') return { ...e, size: s(e.size), radius: s(e.radius) };
      if (e.type === 'NOISE') return { ...e, size: s(e.size) };
      return e;
    }),
  };
  const weights = g('strokeWeights');
  if (weights) props.strokeWeights = weights.map(s) as [number, number, number, number];
  const radii = g('cornerRadii');
  if (radii) props.cornerRadii = radii.map(s) as [number, number, number, number];
  if (doc.type(id) === 'TEXT') {
    const lh = g('lineHeight');
    const ls = g('letterSpacing');
    Object.assign(props, {
      fontSize: s(g('fontSize')),
      lineHeight: lh.unit === 'PX' ? { unit: 'PX', value: s(lh.value) } : lh,
      letterSpacing: ls.unit === 'PX' ? { unit: 'PX', value: s(ls.value) } : ls,
      paragraphSpacing: s(g('paragraphSpacing')),
      paragraphIndent: s(g('paragraphIndent')),
      textRuns: g('textRuns').map((r) => ({
        ...r,
        style: {
          ...r.style,
          ...(r.style.fontSize !== undefined ? { fontSize: s(r.style.fontSize) } : {}),
          ...(r.style.letterSpacing?.unit === 'PX' ? { letterSpacing: { unit: 'PX' as const, value: s(r.style.letterSpacing.value) } } : {}),
        },
      })),
    });
    const path = g('textPath');
    if (path) props.textPath = scalePaths(path, k, k);
  }
  if (doc.type(id) === 'VECTOR') {
    const net = g('vectorNetwork');
    if (net) props.vectorNetwork = { ...mapNetwork(net, (p) => ({ x: p.x * k, y: p.y * k })), vertices: net.vertices.map((v) => ({ ...v, x: v.x * k, y: v.y * k, ...(v.cornerRadius !== undefined ? { cornerRadius: s(v.cornerRadius) } : {}) })) };
    else props.vectorPaths = scalePaths(g('vectorPaths'), k, k);
  }
  tx.update(id, props);
  for (const child of doc.children(id)) {
    tx.update(child, { x: Math.round(doc.get(child, 'x') * k * 100) / 100, y: Math.round(doc.get(child, 'y') * k * 100) / 100 });
    scaleNode(doc, tx, child, k);
  }
}
