import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultWarp, isometricCorners, squareToQuad, warpExtent, warpMap } from '../src/index.ts';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('perspective sends the square corners to the quad and keeps straight lines straight', () => {
  const quad: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 0.8 },
  ];
  const map = squareToQuad(quad);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = map(u!, v!);
    assert.ok(near(p.x, quad[i]!.x) && near(p.y, quad[i]!.y), `corner ${i}`);
  });
  // The middle of the top edge lies on the segment between its corners.
  const a = map(0, 0);
  const b = map(1, 0);
  const m = map(0.5, 0);
  assert.ok(near((b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x), 0));
  // Untouched corners change nothing.
  const flat = warpMap(defaultWarp('PERSPECTIVE'));
  const p = flat(0.3, 0.7);
  assert.ok(near(p.x, 0.3) && near(p.y, 0.7));
});

test('a cylinder keeps the box, squeezes the sides and bends the edges as seen from above', () => {
  const map = warpMap({ type: 'CYLINDER', axis: 'VERTICAL', bend: 140, tilt: 0.2, taper: 0, shade: 0 });
  assert.ok(near(map(0, 0).x, 0) && near(map(1, 0).x, 1) && near(map(0.5, 0).x, 0.5));
  // Near the side a step across covers less of the screen than at the front.
  assert.ok(map(0.1, 0).x - map(0, 0).x < map(0.55, 0).x - map(0.45, 0).x);
  // Seen from above the front of the top edge is lower than its ends; nothing leaves the box.
  assert.ok(map(0.5, 0).y > map(0, 0).y);
  const e = warpExtent({ type: 'CYLINDER', axis: 'VERTICAL', bend: 140, tilt: 0.2, taper: 0.2, shade: 0 });
  assert.ok(near(e.minX, 0) && near(e.minY, 0) && near(e.maxX, 1) && near(e.maxY, 1));
  // A cone: narrower at the bottom.
  const cone = warpMap({ type: 'CYLINDER', axis: 'VERTICAL', bend: 0, tilt: 0, taper: 0.2, shade: 0 });
  assert.ok(near(cone(0, 1).x, 0.1) && near(cone(1, 1).x, 0.9) && near(cone(0, 0).x, 0));
  // Lying: the same across the other axis.
  const tube = warpMap({ type: 'CYLINDER', axis: 'HORIZONTAL', bend: 140, tilt: 0, taper: 0, shade: 0 });
  assert.ok(near(tube(0.3, 0.5).x, 0.3) && near(tube(0.3, 0.5).y, 0.5));
  assert.ok(tube(0.5, 0.1).y < 0.1, 'squeezed towards the edge');
});

test('isometric corners fit the box at 30°', () => {
  const c = isometricCorners('FLAT', 200, 200);
  for (const p of c) assert.ok(p.x >= -1e-9 && p.x <= 1 + 1e-9 && p.y >= -1e-9 && p.y <= 1 + 1e-9);
  // Top edge rises 30° to the right (in pixels of the 200 × 200 box).
  const angle = (Math.atan2(-(c[1].y - c[0].y) * 200, (c[1].x - c[0].x) * 200) * 180) / Math.PI;
  assert.ok(near(angle, 30, 0.05), String(angle));
  const left = isometricCorners('LEFT', 300, 200);
  assert.ok(near(left[0].x, left[3].x), 'vertical edges stay vertical');
});

test('only convex corners make a perspective', async () => {
  const { isConvexQuad } = await import('../src/index.ts');
  assert.ok(isConvexQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]));
  assert.ok(!isConvexQuad([{ x: 0.6, y: 0.6 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 'a corner pulled past the diagonal');
  assert.ok(!isConvexQuad([{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 'crossed');
});

test('rounded corners of a polygon: arcs of the radius, smaller where the sides are short', async () => {
  const { roundCorners, shapePaths } = await import('../src/index.ts');
  const square = { closed: true, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
  const r = roundCorners(square, 10);
  assert.equal(r.points.length, 8);
  assert.ok(near(r.points[0]!.x, 0) && near(r.points[0]!.y, 10));
  assert.ok(near(r.points[1]!.x, 10) && near(r.points[1]!.y, 0));
  // Same handles as a rounded rectangle (κ ≈ 0.5523 of the radius).
  assert.ok(near(r.points[0]!.out!.y, 10 - 10 * 0.55228, 1e-3));
  // A radius larger than the sides allow stops at their middles.
  const big = roundCorners(square, 500);
  assert.ok(near(big.points[0]!.y, 50) && near(big.points[1]!.x, 50));
  // Curved joins are left alone; no radius — the same path.
  assert.equal(roundCorners(square, 0), square);
  const tri = shapePaths('POLYGON', { width: 100, height: 100, pointCount: 3, cornerRadius: 12 });
  assert.equal(tri[0]!.points.length, 6);
  assert.equal(shapePaths('POLYGON', { width: 100, height: 100, pointCount: 3 })[0]!.points.length, 3);
});

test('rounded corners of a vector network: every corner of a drawn triangle, a point of its own radius', async () => {
  const { networkFromPaths, roundNetwork, networkPaths } = await import('../src/index.ts');
  const tri = networkFromPaths([{ closed: true, points: [{ x: 50, y: 0 }, { x: 100, y: 90 }, { x: 0, y: 90 }] }]);
  const round = roundNetwork(tri, 10);
  assert.equal(round.segments.length, tri.segments.length + 3, 'an arc at each corner');
  const fill = networkPaths(round).fill;
  assert.equal(fill.length, 1);
  assert.equal(fill[0]!.points.length, 6);
  // Only the first point rounded (its own radius), the layer's radius is 0.
  const one = roundNetwork({ ...tri, vertices: tri.vertices.map((v, i) => (i === 0 ? { ...v, cornerRadius: 8 } : v)) }, 0);
  assert.equal(one.segments.length, tri.segments.length + 1);
  // A point set to 0 stays sharp under a layer radius.
  const sharp = roundNetwork({ ...tri, vertices: tri.vertices.map((v, i) => (i === 0 ? { ...v, cornerRadius: 0 } : v)) }, 10);
  assert.equal(sharp.segments.length, tri.segments.length + 2);
  // Nothing to round: the same network.
  assert.equal(roundNetwork(tri, 0), tri);
});

test('corner radius rounds joins of curves too (as in Figma); a smooth join stays as it is', async () => {
  const { networkFromPaths, roundNetwork, cubicAt, cubicOf } = await import('../src/index.ts');
  // A leaf: two curves meeting at sharp corners left and right.
  const leaf = networkFromPaths([{ closed: true, points: [{ x: 0, y: 100, in: { x: 60, y: 220 }, out: { x: 60, y: -20 } }, { x: 300, y: 100, in: { x: 240, y: -20 }, out: { x: 240, y: 220 } }] }]);
  const round = roundNetwork(leaf, 40);
  assert.equal(round.segments.length, leaf.segments.length + 2);
  // The corner points moved in along the curves; nothing reaches the old tips any more.
  const xs = round.segments.flatMap((s) => [0, 0.25, 0.5, 0.75, 1].map((t) => cubicAt(cubicOf(round, s), t).x));
  assert.ok(Math.min(...xs) > 3 && Math.max(...xs) < 297, `${Math.min(...xs)}..${Math.max(...xs)}`);
  assert.equal(round.regions[0]!.loops[0]!.length, 4);
  // A circle's smooth points are not corners.
  const circle = networkFromPaths([{ closed: true, points: [{ x: 50, y: 0, in: { x: 22, y: 0 }, out: { x: 78, y: 0 } }, { x: 50, y: 100, in: { x: 78, y: 100 }, out: { x: 22, y: 100 } }] }]);
  assert.equal(roundNetwork(circle, 20), circle);
});
