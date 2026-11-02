import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VectorNetwork, VectorPath } from '#core';
import { refillPart, filledAt, cutNetworkSegment, deleteVertices, detachVertex, findFaces, networkFromPaths, networkPaths, regionAt, simplifyNetwork, splitNetworkSegment, strokeChains, toggleRegionAt } from '../src/network.ts';
import { cubicAt, flattenPaths, shapePaths } from '../src/vector.ts';
import { winding } from '../src/boolean.ts';

const square = (x: number, y: number, s: number): VectorPath => ({ closed: true, points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] });

test('network: contours in, the same contours out (fill and stroke)', () => {
  const circle = shapePaths('ELLIPSE', { width: 100, height: 100, cornerRadius: 0, cornerRadii: null, pointCount: 0, innerRadius: 0 });
  const line: VectorPath = { closed: false, points: [{ x: 0, y: 200 }, { x: 50, y: 220 }, { x: 100, y: 200 }] };
  const net = networkFromPaths([...circle, line]);
  assert.equal(net.regions.length, 1, 'the closed contour is filled');
  const { fill, stroke } = networkPaths(net);
  assert.equal(fill.length, 1);
  assert.equal(fill[0]!.points.length, circle[0]!.points.length);
  assert.equal(stroke.length, 2);
  assert.equal(stroke.find((p) => !p.closed)!.points.length, 3);
  // The curve is kept exactly.
  const before = flattenPaths(circle, 0.5)[0]!.points;
  const after = flattenPaths([fill[0]!], 0.5)[0]!.points;
  assert.equal(before.length, after.length);
});

/** θ: a circle-like square with a bar across the middle — two faces. */
function theta(): VectorNetwork {
  const net = networkFromPaths([square(0, 0, 100)]);
  net.regions = [];
  // Split the left and right sides at the middle and join them.
  let r = splitNetworkSegment(net, 3, 0.5); // left side (3 → 0), middle at (0, 50)
  const left = r.vertex;
  r = splitNetworkSegment(r.net, 1, 0.5); // right side (1 → 2), middle at (100, 50)
  const right = r.vertex;
  r.net.segments.push({ a: left, b: right });
  return r.net;
}

test('network: a point with three segments; faces; the paint bucket fills what is under the pointer', () => {
  const net = theta();
  assert.equal(net.vertices.length, 6);
  const junctions = net.vertices.filter((_, v) => net.segments.filter((s) => s.a === v || s.b === v).length === 3);
  assert.equal(junctions.length, 2, 'two points where three segments meet');
  const faces = findFaces(net);
  assert.equal(faces.length, 2, 'top half and bottom half');
  assert.deepEqual(faces.map((f) => Math.round(Math.abs(f.area))).sort(), [5000, 5000]);
  const top = toggleRegionAt(net, { x: 50, y: 25 })!;
  assert.equal(top.regions.length, 1);
  const fillTop = flattenPaths(networkPaths(top).fill, 0.5)[0]!.points;
  assert.ok(fillTop.every((p) => p.y <= 50 + 1e-9), 'only the top half is filled');
  const both = toggleRegionAt(top, { x: 50, y: 75 })!;
  assert.equal(both.regions.length, 2);
  const again = toggleRegionAt(both, { x: 50, y: 25 })!;
  assert.equal(again.regions.length, 1, 'a second click empties it');
  assert.equal(toggleRegionAt(net, { x: 500, y: 500 }), null, 'outside: nothing');
  // Each segment is stroked once, even the ones two regions share.
  const chains = strokeChains(both);
  const segCount = chains.reduce((n, c) => n + (c.closed ? c.points.length : c.points.length - 1), 0);
  assert.equal(segCount, both.segments.length);
});

test('network: a ring is filled with its hole', () => {
  const net = networkFromPaths([square(0, 0, 100), square(30, 30, 40)]);
  net.regions = [];
  const r = regionAt(net, { x: 10, y: 10 })!;
  assert.equal(r.loops.length, 2, 'outline and hole');
  assert.equal(r.windingRule, 'EVENODD');
  const inner = regionAt(net, { x: 50, y: 50 })!;
  // A loose tail inside a face does not break its outline.
  const tailed = networkFromPaths([square(0, 0, 100)]);
  tailed.regions = [];
  tailed.vertices.push({ x: 50, y: 50 });
  tailed.segments.push({ a: 0, b: 4 });
  const withTail = toggleRegionAt(tailed, { x: 80, y: 20 })!;
  assert.equal(withTail.regions[0]!.loops[0]!.length, 4, 'the four sides, not the tail');
  assert.equal(networkPaths(withTail).fill.length, 1);
  assert.equal(inner.loops.length, 1, 'inside the hole: just the small square');
});

test('network: deleting a point joins its neighbours; a junction takes its segments; scissors open the shape', () => {
  const net = networkFromPaths([square(0, 0, 100)]);
  const fewer = deleteVertices(net, new Set([1]));
  assert.equal(fewer.vertices.length, 3);
  assert.equal(fewer.segments.length, 3);
  assert.equal(fewer.regions.length, 1, 'still closed: a triangle');
  assert.equal(networkPaths(fewer).fill[0]!.points.length, 3);
  const t = theta();
  const junction = t.vertices.findIndex((_, v) => t.segments.filter((s) => s.a === v || s.b === v).length === 3);
  const noBar = deleteVertices(t, new Set([junction]));
  assert.equal(noBar.segments.length, t.segments.length - 3);
  const cut = cutNetworkSegment(net, 0, 0.5);
  assert.equal(cut.regions.length, 0, 'no longer closed');
  assert.equal(cut.vertices.length, 6);
  const chains = strokeChains(cut);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]!.closed, false);
  const loose = detachVertex(net, 0);
  assert.equal(loose.vertices.length, 5);
  assert.equal(strokeChains(loose).length, 1, 'one open chain from one copy of the point to the other');
});

test('network: simplify keeps the look with fewer points, and keeps corners', () => {
  // A circle drawn with 64 straight segments.
  const pts = Array.from({ length: 64 }, (_, i) => ({ x: 50 + 50 * Math.cos((i / 64) * Math.PI * 2), y: 50 + 50 * Math.sin((i / 64) * Math.PI * 2) }));
  const many = networkFromPaths([{ closed: true, points: pts }]);
  const few = simplifyNetwork(many, 0.5);
  assert.ok(few.vertices.length < 16, `points: ${few.vertices.length}`);
  assert.equal(few.regions.length, 1);
  const path = networkPaths(few).fill[0]!;
  for (const p of flattenPaths([path], 0.25)[0]!.points) assert.ok(Math.abs(Math.hypot(p.x - 50, p.y - 50) - 50) < 1, 'within the tolerance of the circle');
  const sq = simplifyNetwork(networkFromPaths([square(0, 0, 100)]), 0.5);
  assert.equal(sq.vertices.length, 4, 'corners stay');
  assert.ok(sq.segments.every((s) => !s.ca && !s.cb), 'straight sides stay straight');
  void cubicAt;
});

test('network: a filled square cut in two keeps both halves filled; the bucket then empties one half', () => {
  const square4 = networkFromPaths([square(0, 0, 100)]);
  let r = splitNetworkSegment(square4, 3, 0.5);
  const left = r.vertex;
  r = splitNetworkSegment(r.net, 1, 0.5);
  const right = r.vertex;
  const barred = { ...r.net, segments: [...r.net.segments, { a: left, b: right }] };
  const refilled = refillPart(square4, barred, left);
  assert.equal(refilled.regions.length, 2, 'two filled halves instead of one square');
  assert.ok(filledAt(refilled, { x: 50, y: 25 }) && filledAt(refilled, { x: 50, y: 75 }));
  const topEmpty = toggleRegionAt(refilled, { x: 50, y: 25 })!;
  assert.equal(filledAt(topEmpty, { x: 50, y: 25 }), false, 'the top half is empty now');
  assert.equal(filledAt(topEmpty, { x: 50, y: 75 }), true, 'the bottom half stays');
});

test('network: regions as Figma fills them — open loops closed, nested loops with holes, own paints apart', () => {
  // An open chain in a region is closed by a straight line back to its start.
  const v: VectorNetwork = {
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    segments: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }],
    regions: [{ loops: [[0, 1, 2]], windingRule: 'NONZERO' }],
  };
  const open = networkPaths(v).fill;
  assert.equal(open.length, 1);
  assert.equal(open[0]!.points.length, 4);
  // Two even-odd regions: the second is a ring (outline + hole), the first lies in its hole.
  const ring = networkFromPaths([square(0, 0, 100), square(25, 25, 50)], 'EVENODD');
  const dot = networkFromPaths([square(40, 40, 20)]);
  const off = ring.vertices.length;
  const segOff = ring.segments.length;
  const both: VectorNetwork = {
    vertices: [...ring.vertices, ...dot.vertices],
    segments: [...ring.segments, ...dot.segments.map((s) => ({ a: s.a + off, b: s.b + off }))],
    regions: [{ loops: ring.regions.map((r) => r.loops[0]!), windingRule: 'EVENODD' }, { loops: dot.regions[0]!.loops.map((l) => l.map((si) => si + segOff)), windingRule: 'EVENODD' }],
  };
  const all = networkPaths(both);
  assert.equal(all.evenOdd, false, 'several regions are drawn as non-zero');
  const polys = flattenPaths(all.fill, 0.5).map((p) => p.points);
  const filled = (x: number, y: number) => winding(polys, { x, y }) !== 0;
  assert.ok(filled(10, 10), 'the ring');
  assert.ok(!filled(30, 30), 'its hole');
  assert.ok(filled(50, 50), 'the region inside the hole');
  // A region with its own paints is drawn apart; one with none is not filled.
  both.regions[1]!.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];
  const parts = networkPaths(both);
  assert.equal(parts.parts.length, 1);
  assert.ok(parts.evenOdd, 'one region left: drawn with its own rule');
  assert.equal(winding(flattenPaths(parts.fill, 0.5).map((p) => p.points), { x: 50, y: 50 }) % 2, 0, 'the part is not in the layer\'s fill');
  assert.equal(parts.outline.length, all.fill.length, 'the stroke still follows every region');
  both.regions[1]!.fills = [];
  assert.equal(networkPaths(both).parts.length, 0);
});
