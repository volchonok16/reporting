import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { blocksOf, fitToFormats } from '#components';
import { ApproximateTextMeasurer } from '#layout';
import { Editor } from '../src/editor.ts';

const solid = (r: number) => [{ type: 'SOLID' as const, color: { r, g: r, b: r, a: 1 }, opacity: 1, visible: true }];

function banner() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const page = editor.pageId;
  const ids = editor.commit('setup', (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Баннер', width: 1080, height: 1080 });
    const bg = tx.create('RECTANGLE', frame, { name: 'Фон', width: 1080, height: 1080, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] as never });
    const title = tx.create('TEXT', frame, { name: 'Заголовок', x: 80, y: 120, width: 700, height: 80, characters: 'Распродажа', fontSize: 72 });
    const sub = tx.create('TEXT', frame, { name: 'Подзаголовок', x: 80, y: 210, width: 600, height: 40, characters: 'до −50% на всё', fontSize: 32 });
    const logo = tx.create('ELLIPSE', frame, { name: 'Лого', x: 900, y: 900, width: 100, height: 100, fills: solid(0.2) });
    const other = tx.create('FRAME', page, { name: 'Сосед', x: 1200, y: 0, width: 300, height: 300 });
    return { frame, bg, title, sub, logo, other };
  });
  return { doc, editor, ...ids };
}

test('formats: blocks of close layers — a title with its subtitle is one block, a far logo another', () => {
  const blocks = blocksOf(
    [
      { x: 80, y: 120, w: 700, h: 80 },
      { x: 80, y: 210, w: 600, h: 40 },
      { x: 900, y: 900, w: 100, h: 100 },
    ],
    43,
  );
  assert.deepEqual(blocks.map((b) => b.sort()).sort(), [[0, 1], [2]]);
  // A column: left edges in line, gaps wider than «close» — still one block; a far corner stays apart.
  const column = blocksOf(
    [
      { x: 80, y: 120, w: 900, h: 100 },
      { x: 80, y: 320, w: 560, h: 41 },
      { x: 80, y: 410, w: 300, h: 84 },
      { x: 900, y: 900, w: 100, h: 100 },
    ],
    43,
    { width: 1080, height: 1080 },
  );
  assert.deepEqual(column.map((b) => b.sort()).sort(), [[0, 1, 2], [3]]);
  // A decorative circle 19 px under the subtitle stays apart; a badge lying on it joins it.
  const decor = blocksOf(
    [
      { x: 80, y: 320, w: 560, h: 41 },
      { x: 620, y: 380, w: 380, h: 380 },
      { x: 700, y: 500, w: 100, h: 40 },
    ],
    43,
    { width: 1080, height: 1080 },
    [false, true, false],
  );
  assert.deepEqual(decor.map((b) => b.sort()).sort(), [[0], [1, 2]]);
});

test('formats: a square banner as a story and a VK cover — background stretched, blocks kept together and inside', () => {
  const { doc, editor, frame, title, sub, other } = banner();
  const [story, cover] = editor.commit('formats', (tx) =>
    fitToFormats(doc, tx, frame, [
      { width: 1080, height: 1920, label: 'Сторис' },
      { width: 1920, height: 768, label: 'Обложка VK' },
    ]),
  );
  // Past the row (the neighbour included), one after another.
  assert.equal(doc.get(story!, 'x'), 1500 + 100);
  assert.equal(doc.get(cover!, 'x'), 1600 + 1080 + 100);
  assert.equal(doc.get(story!, 'name'), 'Баннер — Сторис');
  assert.equal(doc.get(story!, 'height'), 1920);
  const kids = (f: string) => {
    const all = new Map(doc.children(f as never).map((c) => [String(doc.get(c, 'name')), c]));
    return (name: string) => all.get(name)!;
  };
  for (const [f, W, H] of [[story!, 1080, 1920], [cover!, 1920, 768]] as const) {
    const k = kids(f);
    // The background covers the new frame.
    assert.equal(doc.get(k('Фон'), 'width'), W);
    assert.equal(doc.get(k('Фон'), 'height'), H);
    // Everything else inside the frame.
    for (const name of ['Заголовок', 'Подзаголовок', 'Лого']) {
      const id = k(name);
      assert.ok(doc.get(id, 'x') >= -0.01 && doc.get(id, 'x') + doc.get(id, 'width') <= W + 0.01, `${name} inside by x in ${W}×${H}`);
      assert.ok(doc.get(id, 'y') >= -0.01 && doc.get(id, 'y') + doc.get(id, 'height') <= H + 0.01, `${name} inside by y in ${W}×${H}`);
    }
    // The title and its subtitle stay a block: the same gap, scaled.
    const kf = Math.min(W / 1080, H / 1080);
    const gap = doc.get(k('Подзаголовок'), 'y') - doc.get(k('Заголовок'), 'y');
    assert.ok(Math.abs(gap - 90 * kf) < 0.5, `gap ${gap} in ${W}×${H}`);
    assert.ok(Math.abs(doc.get(k('Заголовок'), 'fontSize') - 72 * kf) < 0.05);
  }
  // The original is untouched; one undo step takes all copies away.
  assert.equal(doc.get(title, 'fontSize'), 72);
  assert.equal(doc.get(sub, 'y'), 210);
  editor.undo();
  assert.deepEqual(doc.children(editor.pageId), [frame, other]);
});

test('formats: an auto layout frame is scaled to fit and takes the new size', () => {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const frame = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', editor.pageId, { width: 1080, height: 1080, layoutMode: 'VERTICAL', paddingTop: 40, paddingLeft: 40, itemSpacing: 20 });
    tx.create('TEXT', f, { characters: 'Заголовок', fontSize: 60 });
    return f;
  });
  const [wide] = editor.commit('formats', (tx) => fitToFormats(doc, tx, frame, [{ width: 1280, height: 720, label: 'YouTube' }]));
  assert.equal(doc.get(wide!, 'width'), 1280);
  assert.equal(doc.get(wide!, 'height'), 720);
  const k = 720 / 1080;
  assert.ok(Math.abs(doc.get(wide!, 'paddingTop') - 40 * k) < 0.02);
  assert.ok(Math.abs(doc.get(doc.children(wide!)[0]!, 'fontSize') - 60 * k) < 0.02);
});
