import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { SceneGraph } from '../src/scene.ts';
import { Viewport } from '../src/viewport.ts';

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  const page = doc.pages()[0]!;
  const scene = new SceneGraph(doc, page);
  doc.subscribe((changes) => scene.invalidate(changes));
  return { doc, page, scene };
}

test('world bounds follow nested transforms', () => {
  const { doc, page, scene } = setup();
  const { frame, rect } = doc.transact((tx) => {
    const frame = tx.create('FRAME', page, { x: 100, y: 50, width: 400, height: 300 });
    const rect = tx.create('RECTANGLE', frame, { x: 10, y: 20, width: 30, height: 40 });
    return { frame, rect };
  });
  scene.ensure();
  assert.deepEqual(scene.bounds(rect), { x: 110, y: 70, width: 30, height: 40 });
  doc.transact((tx) => tx.set(frame, 'x', 0));
  scene.ensure();
  assert.deepEqual(scene.bounds(rect), { x: 10, y: 70, width: 30, height: 40 });
});

test('rotation produces the axis-aligned bounds of the rotated box', () => {
  const { doc, page, scene } = setup();
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 0, y: 0, width: 100, height: 100, rotation: 90 }));
  scene.ensure();
  const b = scene.bounds(rect);
  assert.ok(Math.abs(b.x + 100) < 1e-9 && Math.abs(b.width - 100) < 1e-9);
});

test('hit test returns top-most first and respects clipping', () => {
  const { doc, page, scene } = setup();
  const { frame, inside, outside, top } = doc.transact((tx) => {
    const frame = tx.create('FRAME', page, { x: 0, y: 0, width: 100, height: 100, clipsContent: true });
    const inside = tx.create('RECTANGLE', frame, { x: 10, y: 10, width: 50, height: 50 });
    const outside = tx.create('RECTANGLE', frame, { x: 90, y: 90, width: 50, height: 50 });
    const top = tx.create('ELLIPSE', page, { x: 20, y: 20, width: 20, height: 20 });
    return { frame, inside, outside, top };
  });
  assert.deepEqual(scene.hitTest({ x: 30, y: 30 }), [top, inside, frame]);
  assert.deepEqual(scene.hitTest({ x: 120, y: 120 }), [], 'clipped part is not hittable');
  doc.transact((tx) => tx.set(frame, 'clipsContent', false));
  assert.deepEqual(scene.hitTest({ x: 120, y: 120 }), [outside]);
  // Ellipse corners are outside the ellipse.
  assert.equal(scene.hitTest({ x: 21, y: 21 }).includes(top), false);
});

test('render bounds include unclipped overflow; queries find nodes', () => {
  const { doc, page, scene } = setup();
  const frame = doc.transact((tx) => {
    const frame = tx.create('FRAME', page, { width: 100, height: 100, clipsContent: false });
    tx.create('RECTANGLE', frame, { x: 150, y: 0, width: 50, height: 50 });
    return frame;
  });
  scene.ensure();
  assert.equal(scene.renderBounds(frame).width, 200);
  assert.equal(scene.queryRect({ x: 160, y: 10, width: 1, height: 1 }).length, 1, 'index holds own boxes, not render bounds');
});

test('viewport zoom keeps the anchor point fixed', () => {
  const vp = new Viewport();
  vp.panBy(100, 50);
  const anchor = { x: 300, y: 200 };
  const before = vp.screenToWorld(anchor);
  vp.zoomAt(anchor, 4);
  const after = vp.screenToWorld(anchor);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(vp.stepZoom(1), 8);
  assert.equal(vp.stepZoom(-1), 2);
});

test('PDF writer: valid structure, correct xref offsets, one page per image (FEAT-016)', async () => {
  const { buildPdf } = await import('../src/pdf.ts');
  const px = (w: number, h: number, alpha: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? alpha : 128)) });
  const bytes = await buildPdf(
    [
      { width: 20, height: 10, pixels: px(40, 20, 255) },
      { width: 5, height: 5, pixels: px(10, 10, 100) },
    ],
    'Макет',
  );
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 20 10\]/);
  assert.match(text, /\/SMask/, 'transparent page gets an alpha mask');
  const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(startxref).startsWith('xref'));
  const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  entries.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
});

test('damage: the old and the new place of a moved layer, everything after a page change, deleted layers too', () => {
  const { doc, page, scene } = setup();
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 10, y: 10, width: 20, height: 20 }));
  const far = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 1000, y: 1000, width: 20, height: 20 }));
  assert.equal(scene.takeDamage().all, true, 'a new scene: nothing drawn yet is trustworthy');
  assert.deepEqual(scene.takeDamage(), { all: false, rects: [] });
  doc.transact((tx) => tx.set(rect, 'x', 100));
  const moved = scene.takeDamage();
  assert.equal(moved.all, false);
  assert.deepEqual(moved.rects, [{ x: 10, y: 10, width: 20, height: 20 }, { x: 100, y: 10, width: 20, height: 20 }]);
  // A shadow widens what is painted, so the damage too.
  doc.transact((tx) => tx.set(rect, 'effects', [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 6, spread: 0, visible: true }]));
  const shadow = scene.takeDamage();
  assert.deepEqual(shadow.rects.at(-1), { x: 94, y: 8, width: 32, height: 32 }, "radius 6, moved 4 down: 2 above, 10 below");
  doc.transact((tx) => tx.delete(far));
  assert.deepEqual(scene.takeDamage().rects, [{ x: 1000, y: 1000, width: 20, height: 20 }], 'a deleted layer leaves its old place to redraw');
  scene.damageEverything();
  assert.equal(scene.takeDamage().all, true);
});

test('angular and diamond gradients: where a point falls and its colour', async () => {
  const { gradientT, colorAt, gradientPixels } = await import('../src/gradients.ts');
  const stops = [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
  const angular = { type: 'GRADIENT_ANGULAR' as const, stops, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, opacity: 1, visible: true };
  // A 100 × 100 box: the start points right, a quarter turn clockwise (screen y down) is straight down.
  assert.ok(Math.abs(gradientT(angular, 90, 50, 100, 100)) < 1e-9);
  assert.ok(Math.abs(gradientT(angular, 50, 90, 100, 100) - 0.25) < 1e-9);
  assert.ok(Math.abs(gradientT(angular, 10, 50, 100, 100) - 0.5) < 1e-9);
  const diamond = { ...angular, type: 'GRADIENT_DIAMOND' as const };
  assert.ok(Math.abs(gradientT(diamond, 75, 50, 100, 100) - 0.5) < 1e-9, 'half way to the tip');
  assert.ok(Math.abs(gradientT(diamond, 75, 75, 100, 100) - 1) < 1e-9, 'the diamond edge, off the axis');
  assert.deepEqual(colorAt({ ...angular, opacity: 0.5 }, 0.5), { r: 0.5, g: 0.5, b: 0.5, a: 0.5 });
  const px = gradientPixels(diamond, 100, 100, 4, 4);
  assert.equal(px.length, 64);
  assert.ok(px[0]! > px[(1 * 4 + 1) * 4]!, 'a corner is lighter (farther) than a pixel near the centre');
});

test('font file: Inter — features with names, axes, outlines that follow the weight axis', async () => {
  const { readFile } = await import('node:fs/promises');
  const { FontFile } = await import('../src/font-file.ts');
  const font = new FontFile(new Uint8Array(await readFile(new URL('../../../apps/web/fonts/inter/InterVariable.ttf', import.meta.url).pathname)));
  const info = font.info;
  assert.equal(info.family, 'Inter Variable');
  assert.equal(info.unitsPerEm, 2048);
  for (const f of ['calt', 'tnum', 'ss01', 'cv01', 'frac', 'zero', 'kern']) assert.ok(info.features.includes(f), f);
  assert.ok(Object.keys(info.featureNames).length > 0, 'stylistic sets have names');
  const wght = info.axes.find((a) => a.tag === 'wght');
  assert.deepEqual(wght && [wght.min, wght.default, wght.max], [100, 400, 900]);
  assert.ok(info.capHeight > 1400 && info.capHeight < 1600, `cap height ${info.capHeight}`);
  const regular = font.outline('H'.codePointAt(0)!);
  const black = font.outline('H'.codePointAt(0)!, { wght: 900 });
  assert.ok(regular && regular.path.startsWith('M') && regular.advance > 0);
  assert.notEqual(regular!.path, black!.path, 'the weight axis changes the outline');
  // The stem gets thicker: the H's left stem's right edge moves right.
  const xs = (p: string) => [...p.matchAll(/[MLQ](-?[\d.]+) /g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...xs(black!.path)) >= Math.max(...xs(regular!.path)));
  assert.ok(font.outline(' '.codePointAt(0)!)?.path === '', 'a space has no outline');
});

test('a warped layer is hit where its picture is, and its content is not hit apart', () => {
  const { doc, page, scene } = setup();
  const { frame, inner } = doc.transact((tx) => {
    const frame = tx.create('FRAME', page, { x: 0, y: 0, width: 100, height: 100 });
    const inner = tx.create('RECTANGLE', frame, { x: 0, y: 0, width: 20, height: 20 });
    // A corner pulled out beyond the box, the opposite one pulled in.
    tx.set(frame, 'warp', { type: 'PERSPECTIVE', corners: [{ x: 0.3, y: 0.3 }, { x: 1, y: 0 }, { x: 1.5, y: 1.5 }, { x: 0, y: 1 }] });
    return { frame, inner };
  });
  scene.ensure();
  assert.deepEqual(scene.hitTest({ x: 10, y: 10 }), [], 'the pulled-in corner leaves the place empty');
  assert.deepEqual(scene.hitTest({ x: 120, y: 120 }), [frame], 'beyond the box, inside the picture');
  assert.ok(!scene.hitTest({ x: 60, y: 60 }).includes(inner));
  assert.ok(scene.renderBounds(frame).width >= 150);
});

test('a layer blur reaches 3 radii out, so a tile next to it does not cull its glow (BUG-129)', () => {
  const { doc, page, scene } = setup();
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 0, y: 0, width: 100, height: 100, effects: [{ type: 'LAYER_BLUR', radius: 20, visible: true }] }));
  scene.ensure();
  assert.deepEqual(scene.renderBounds(rect), { x: -60, y: -60, width: 220, height: 220 });
});
