import assert from 'node:assert/strict';
import { test } from 'node:test';

// Node has no ImageData: a plain stand-in with the same shape.
class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as { ImageData?: unknown }).ImageData ??= FakeImageData;

const { adjustPixels, luminanceMask, noiseTile, plusDarker, roughen, vectorMask, NO_FILTERS } = await import('../src/pixels.ts');

const px = (...rgba: number[]) => {
  const img = new ImageData(rgba.length / 4, 1);
  img.data.set(rgba);
  return img;
};

test('plus darker: base + blend − 1; white changes nothing, black gives black', () => {
  const base = px(255, 128, 0, 255, 200, 200, 200, 255);
  plusDarker(base, px(255, 255, 255, 255, 100, 100, 100, 255));
  assert.deepEqual([...base.data], [255, 128, 0, 255, 45, 45, 45, 255]);
});

test('masks by outline and by brightness', () => {
  const v = px(0, 0, 0, 40, 0, 0, 0, 0);
  vectorMask(v);
  assert.equal(v.data[3], 255);
  assert.equal(v.data[7], 0);
  const l = px(255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 200);
  luminanceMask(l);
  assert.deepEqual([l.data[3], l.data[7]], [255, 0]);
  assert.ok(Math.abs(l.data[11]! - 100) <= 1);
});

test('image adjustments: zero changes nothing, saturation −1 gives grey, warmth adds red', () => {
  const same = px(200, 100, 50, 255);
  adjustPixels(same, NO_FILTERS);
  assert.deepEqual([...same.data], [200, 100, 50, 255]);
  const grey = px(200, 100, 50, 255);
  adjustPixels(grey, { ...NO_FILTERS, saturation: -1 });
  assert.ok(grey.data[0] === grey.data[1] && grey.data[1] === grey.data[2]);
  const warm = px(128, 128, 128, 255);
  adjustPixels(warm, { ...NO_FILTERS, temperature: 1 });
  assert.ok(warm.data[0]! > 128 && warm.data[2]! < 128);
});

test('noise tiles: density sets how many pixels are drawn; the tile is the same every time', () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const count = (img: ImageData) => {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
    return n;
  };
  const half = noiseTile('MONO', 0.5, black, black, 1, 64);
  assert.ok(Math.abs(count(half) / (64 * 64) - 0.5) < 0.05);
  assert.equal(count(noiseTile('MONO', 0, black, black, 1, 64)), 0);
  assert.deepEqual([...noiseTile('DUO', 0.3, black, black, 1, 16).data], [...noiseTile('DUO', 0.3, black, black, 1, 16).data]);
});

test('texture: without radius the picture stays; with it pixels move, the same way each time', () => {
  const src = new ImageData(20, 20);
  for (let i = 0; i < src.data.length; i += 4) src.data[i + 3] = (i / 4) % 20 < 10 ? 255 : 0;
  assert.deepEqual([...roughen(src, 4, 0, 0, 0).data], [...src.data]);
  const a = roughen(src, 4, 3, 0, 0);
  assert.notDeepEqual([...a.data], [...src.data]);
  assert.deepEqual([...roughen(src, 4, 3, 0, 0).data], [...a.data]);
});
