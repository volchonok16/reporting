import assert from 'node:assert/strict';
import { test } from 'node:test';
import { area, booleanAll, booleanRegions, flattenPaths, insertPoint, nearestOnPath, pathsBounds, pathsToSvg, shapePaths, winding, type Region } from '../src/index.ts';

const square = (x: number, y: number, s: number): Region => ({ contours: [[{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]], rule: 'NONZERO' });
const totalArea = (r: Region) => Math.abs(r.contours.reduce((n, c) => n + area(c), 0));

test('boolean operations on overlapping squares', () => {
  const a = square(0, 0, 10);
  const b = square(5, 5, 10);
  assert.equal(Math.round(totalArea(booleanRegions('UNION', a, b))), 175);
  assert.equal(Math.round(totalArea(booleanRegions('SUBTRACT', a, b))), 75);
  assert.equal(Math.round(totalArea(booleanRegions('INTERSECT', a, b))), 25);
  assert.equal(Math.round(totalArea(booleanRegions('EXCLUDE', a, b))), 150);
});

test('subtracting an inner square leaves a hole; touching and identical shapes', () => {
  const hole = booleanRegions('SUBTRACT', square(0, 0, 10), square(3, 3, 4));
  assert.equal(hole.contours.length, 2);
  assert.equal(Math.round(totalArea(hole)), 84);
  assert.equal(winding(hole.contours, { x: 5, y: 5 }), 0, 'centre is outside');
  assert.notEqual(winding(hole.contours, { x: 1, y: 1 }), 0);
  const touching = booleanRegions('UNION', square(0, 0, 10), square(10, 0, 10));
  assert.equal(touching.contours.length, 1);
  assert.equal(Math.round(totalArea(touching)), 200);
  const same = booleanRegions('UNION', square(0, 0, 10), square(0, 0, 10));
  assert.equal(Math.round(totalArea(same)), 100);
  assert.equal(booleanRegions('INTERSECT', square(0, 0, 10), square(20, 0, 5)).contours.length, 0);
  assert.equal(Math.round(totalArea(booleanAll('SUBTRACT', [square(0, 0, 10), square(0, 0, 5), square(5, 5, 5)]))), 50);
});

test('vector paths: shapes, bounds, flattening, inserting points, SVG', () => {
  const ellipse = shapePaths('ELLIPSE', { width: 100, height: 50 });
  const b = pathsBounds(ellipse)!;
  assert.ok(Math.abs(b.width - 100) < 1e-6 && Math.abs(b.height - 50) < 1e-6);
  const poly = flattenPaths(ellipse, 0.1)[0]!;
  assert.ok(Math.abs(Math.abs(area(poly.points)) - Math.PI * 50 * 25) < 15, 'flattened ellipse area');
  const rect = shapePaths('RECTANGLE', { width: 100, height: 60, cornerRadius: 10 });
  assert.equal(rect[0]!.points.length, 8);
  const near = nearestOnPath(ellipse[0]!, { x: 100, y: 25 })!;
  assert.ok(near.distance < 1e-6);
  const withPoint = insertPoint(ellipse[0]!, 0, 0.5);
  assert.equal(withPoint.points.length, 5);
  assert.ok(Math.abs(pathsBounds([withPoint])!.width - 100) < 1e-6, 'inserting a point keeps the shape');
  assert.match(pathsToSvg(shapePaths('RECTANGLE', { width: 10, height: 10 })), /^M0 0L10 0L10 10L0 10L0 0Z$/);
});

test('precision: grid tracks, measurements, equal spacing, side strokes, caps', async () => {
  const { gridTracks, gridSnapLines, measureRects, equalSpacingSnap, sideStrokeRegion, capShape, openEnds, pathsBounds } = await import('../src/index.ts');
  const color = { r: 1, g: 0, b: 0, a: 0.1 };
  // 12 stretched columns, margin 20, gutter 20 in 1000 px: (1000 - 40 - 220) / 12.
  const t = gridTracks({ pattern: 'COLUMNS', count: 12, alignment: 'STRETCH', sectionSize: 0, offset: 20, gutterSize: 20, color, visible: true }, 1000, 500)!;
  assert.equal(t.tracks.length, 12);
  assert.ok(Math.abs(t.tracks[0]![1] - t.tracks[0]![0] - 740 / 12) < 1e-9);
  assert.ok(Math.abs(t.tracks[11]![1] - 980) < 1e-9);
  // Fixed rows from the bottom, as many as fit.
  const rows = gridTracks({ pattern: 'ROWS', count: 0, alignment: 'MAX', sectionSize: 40, offset: 10, gutterSize: 10, color, visible: true }, 100, 200)!;
  assert.equal(rows.tracks.length, 4, '4 × 40 + 3 × 10 = 190 fits in 200 − 10');
  assert.equal(rows.tracks[3]![1], 190);
  assert.equal(rows.tracks[0]![0], 0);
  assert.equal(gridSnapLines({ pattern: 'GRID', sectionSize: 8, color, visible: true }, 32, 16).x.length, 5);
  // Inside a parent: four distances.
  const inside = measureRects({ x: 10, y: 20, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(inside.lines.map((l) => l.value).sort((a, b) => a - b), [10, 20, 50, 60]);
  // A neighbour to the right with a gap of 15.
  const gap = measureRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 25, y: 50, width: 10, height: 10 });
  assert.deepEqual(gap.lines.map((l) => l.value), [15, 40]);
  assert.equal(gap.helpers.length, 2);
  // Equal spacing: boxes at 0 and 30 (10 wide, gap 20); moving box near 60 snaps to 60.
  const snap = equalSpacingSnap({ x: 57, y: 0, width: 10, height: 10 }, [{ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 0, width: 10, height: 10 }], 'x', 5)!;
  assert.equal(snap.offset, 3);
  assert.equal(snap.match.value, 20);
  assert.equal(snap.match.gaps.length, 2);
  // Side strokes: only the bottom, inside, 2 px.
  const region = sideStrokeRegion(100, 50, [0, 0, 0, 0], [0, 0, 2, 0], 'INSIDE');
  assert.equal(region.length, 1);
  assert.deepEqual(pathsBounds(region), { x: 0, y: 48, width: 100, height: 2 });
  // Only the left side: one band, no contour along the zero sides (no hairlines there).
  const left = sideStrokeRegion(100, 50, [0, 0, 0, 0], [0, 0, 0, 2], 'INSIDE');
  assert.equal(left.length, 1);
  assert.deepEqual(pathsBounds(left), { x: 0, y: 0, width: 2, height: 50 });
  const outside = sideStrokeRegion(100, 50, [0, 0, 0, 0], [4, 4, 4, 4], 'OUTSIDE');
  assert.equal(outside.length, 4);
  assert.deepEqual(pathsBounds(outside), { x: -4, y: -4, width: 108, height: 58 });
  // Rounded corners: still the outer and inner contours.
  const round = sideStrokeRegion(100, 50, [8, 8, 8, 8], [0, 0, 2, 0], 'INSIDE');
  assert.equal(round.length, 2);
  assert.deepEqual(pathsBounds([round[1]!]), { x: 0, y: 0, width: 100, height: 48 });
  // Caps point along the line.
  const arrow = capShape('ARROW', { x: 100, y: 0 }, 0, 2)!;
  assert.ok(arrow.filled && pathsBounds(arrow.paths)!.x < 100);
  const ends = openEnds([{ closed: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }]);
  assert.equal(ends[0]!.end.angle, 0);
  assert.equal(Math.abs(ends[0]!.start.angle), Math.PI);
});

test('variable stroke: a taper is thin at the ends and full in the middle; a closed path gives a ring', async () => {
  const { variableStrokeOutline, isVariableStroke } = await import('../src/variable-stroke.ts');
  const line = [{ closed: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }];
  const [shape] = variableStrokeOutline(line, { weight: 10, profile: 'TAPER_BOTH', brush: 'NONE', roundCaps: false });
  const at = (x: number) => shape!.points.filter((p) => Math.abs(p.x - x) < 1.5).map((p) => Math.abs(p.y));
  assert.ok(Math.max(...at(50)) > 4.8, 'full width in the middle');
  assert.ok(Math.max(...at(0)) < 0.5, 'nothing at the start');
  const ring = variableStrokeOutline([{ closed: true, points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] }], { weight: 4, profile: 'UNIFORM', brush: 'PENCIL', roundCaps: true });
  assert.equal(ring.length, 2);
  assert.equal(isVariableStroke('UNIFORM', 'NONE'), false);
  assert.deepEqual(variableStrokeOutline(line, { weight: 10, profile: 'WAVE', brush: 'INK', roundCaps: true, seed: 3 }), variableStrokeOutline(line, { weight: 10, profile: 'WAVE', brush: 'INK', roundCaps: true, seed: 3 }), 'the same stroke every time');
});
