// 2D affine transform:
//  | a c e |
//  | b d f |
//  | 0 0 1 |
// Same convention as Canvas 2D and SVG, so it maps onto both without conversion.

import { rectFromCorners, type Point, type Rect } from './rect.ts';

export interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translate(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scale(sx: number, sy = sx): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Rotation by `degrees`, clockwise on screen (y axis points down). */
export function rotate(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** m1 · m2: applies m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function invert(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Axis-aligned bounds of a rectangle after transformation. */
export function transformRect(m: Matrix, r: Rect): Rect {
  return rectFromCorners([
    apply(m, { x: r.x, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y + r.height }),
    apply(m, { x: r.x, y: r.y + r.height }),
  ]);
}

/** The four corners of a rectangle after transformation (top-left, top-right, bottom-right, bottom-left). */
export function transformCorners(m: Matrix, r: Rect): [Point, Point, Point, Point] {
  return [
    apply(m, { x: r.x, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y }),
    apply(m, { x: r.x + r.width, y: r.y + r.height }),
    apply(m, { x: r.x, y: r.y + r.height }),
  ];
}

/** Local transform of a node: translate to (x, y), then rotate around that point. */
export function nodeTransform(x: number, y: number, rotationDegrees: number): Matrix {
  if (rotationDegrees === 0) return translate(x, y);
  return multiply(translate(x, y), rotate(rotationDegrees));
}

export function isAxisAligned(m: Matrix): boolean {
  return Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
}
