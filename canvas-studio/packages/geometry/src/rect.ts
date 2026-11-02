export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle. Width and height are never negative. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** Rectangle spanned by two arbitrary corners. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function rectFromCorners(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { ...EMPTY_RECT };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function right(r: Rect): number {
  return r.x + r.width;
}

export function bottom(r: Rect): number {
  return r.y + r.height;
}

export function centerX(r: Rect): number {
  return r.x + r.width / 2;
}

export function centerY(r: Rect): number {
  return r.y + r.height / 2;
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

export function unionAll(rects: readonly Rect[]): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) out = out ? union(out, r) : { ...r };
  return out;
}

/** Overlap test; touching edges count as intersecting. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= right(b) && b.x <= right(a) && a.y <= bottom(b) && b.y <= bottom(a);
}

/** Whether `inner` lies fully inside `outer`. */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 };
}

export function rectEquals(a: Rect, b: Rect, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon
  );
}

/** Point inside an axis-aligned ellipse inscribed in `r`. */
export function ellipseContains(r: Rect, p: Point): boolean {
  const rx = r.width / 2;
  const ry = r.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (p.x - (r.x + rx)) / rx;
  const dy = (p.y - (r.y + ry)) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Distance from point to a segment. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}
