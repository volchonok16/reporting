import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { flattenPaths, shapePaths, sketchPaths } from '#geometry';
import { ApproximateTextMeasurer, isSketched, sketchOf } from '#layout';
import { SceneGraph } from '../src/scene.ts';
import { exportSvg } from '../src/svg.ts';

const solid = [{ type: 'SOLID' as const, color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1, visible: true }];

test('«От руки»: the same outline every time, close to the exact one, filled once and stroked twice', () => {
  const rect = shapePaths('RECTANGLE', { width: 200, height: 100 });
  const a = sketchPaths(rect, 42, 100);
  const b = sketchPaths(rect, 42, 100);
  assert.deepEqual(a, b, 'deterministic');
  assert.notDeepEqual(sketchPaths(rect, 43, 100), a, 'another layer — another hand');
  assert.equal(a.fill.length, 1);
  assert.ok(a.fill[0]!.closed);
  // Four sides, two passes each, open lines.
  assert.equal(a.stroke.length, 8);
  assert.ok(a.stroke.every((p) => !p.closed));
  // Every point within a few units of the rectangle's edge.
  const off = (x: number, y: number) => Math.min(Math.abs(x), Math.abs(x - 200), Math.abs(y), Math.abs(y - 100));
  for (const p of [...a.fill, ...a.stroke]) for (const q of p.points) assert.ok(off(q.x, q.y) < 6, `${q.x},${q.y} strays`);
  // It is not the exact rectangle: some points left the edge.
  assert.ok(a.fill[0]!.points.some((q) => off(q.x, q.y) > 0.3));
  // A circle has no corners: one edge round in each pass.
  const circle = sketchPaths(shapePaths('ELLIPSE', { width: 100, height: 100 }), 7, 100);
  assert.equal(circle.stroke.length, 2);
  assert.ok(flattenPaths(circle.fill).length === 1);
});

test('«От руки» goes to everything inside a layer, screens stay straight; SVG has the same hand-drawn outline', () => {
  const doc = Document.createEmpty('Тест', 'test');
  const page = doc.pages()[0]!;
  const scene = new SceneGraph(doc, page);
  doc.subscribe((changes) => scene.invalidate(changes));
  const ids = doc.transact((tx) => {
    const screen = tx.create('FRAME', page, { width: 390, height: 600, fills: solid });
    const card = tx.create('FRAME', screen, { x: 20, y: 20, width: 200, height: 120, fills: solid, strokes: solid, strokeWeight: 2 });
    const button = tx.create('RECTANGLE', card, { x: 10, y: 10, width: 80, height: 32, fills: solid });
    const text = tx.create('TEXT', card, { x: 10, y: 60, characters: 'Привет' });
    const loose = tx.create('RECTANGLE', page, { x: 500, width: 50, height: 50, fills: solid });
    return { screen, card, button, text, loose };
  });
  assert.equal(isSketched(doc, ids.button), false, 'off by default');
  doc.transact((tx) => tx.set(ids.screen, 'sketch', true));
  assert.equal(isSketched(doc, ids.screen), false, 'a screen is paper');
  assert.equal(isSketched(doc, ids.card), true, 'a card inside');
  assert.equal(isSketched(doc, ids.button), true, 'a shape deeper inside');
  assert.equal(isSketched(doc, ids.text), false, 'text keeps its letters');
  assert.equal(isSketched(doc, ids.loose), false);
  scene.ensure();
  // Room for lines past the corners.
  const rb = scene.renderBounds(ids.button);
  const b = scene.bounds(ids.button);
  assert.ok(rb.x <= b.x - 8 && rb.width >= b.width + 16);
  const svg = exportSvg(scene, new ApproximateTextMeasurer(), [ids.screen]).svg;
  doc.transact((tx) => tx.set(ids.screen, 'sketch', false));
  scene.ensure();
  const plain = exportSvg(scene, new ApproximateTextMeasurer(), [ids.screen]).svg;
  assert.notEqual(svg, plain);
  const most = (x: string) => Math.max(...[...x.matchAll(/ d="([^"]*)"/g)].map((m) => (m[1]!.match(/M/g) ?? []).length));
  assert.ok(most(svg) >= 8 && most(plain) < 8, 'the card stroke: four sides twice, each a line of its own');
  assert.ok(sketchOf(doc, ids.card).stroke.length === 8);
});
