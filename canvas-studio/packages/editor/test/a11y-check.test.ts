import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import { Editor } from '../src/editor.ts';
import { checkAccessibility, readingSteps } from '../src/a11y-check.ts';
import { VISION_MATRICES } from '../src/vision.ts';

const solid = (v: number) => [{ type: 'SOLID' as const, color: { r: v, g: v, b: v, a: 1 }, opacity: 1, visible: true }];
const click = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }] as never;

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const page = editor.pageId;
  const ids = editor.commit('setup', (tx) => {
    const screen = tx.create('FRAME', page, { name: 'Экран', width: 390, height: 800, fills: solid(1) });
    const title = tx.create('TEXT', screen, { name: 'Заголовок', x: 20, y: 20, width: 300, height: 40, characters: 'Корзина', fontSize: 32, fills: solid(0) });
    const pale = tx.create('TEXT', screen, { name: 'Подпись', x: 20, y: 80, width: 300, height: 14, characters: 'мелко и бледно', fontSize: 10, fills: solid(0.75) });
    const close = tx.create('FRAME', screen, { name: 'Закрыть', x: 340, y: 20, width: 24, height: 24, reactions: click });
    const pay = tx.create('FRAME', screen, { name: 'Оплатить', x: 20, y: 700, width: 350, height: 52, reactions: click });
    const photo = tx.create('RECTANGLE', screen, { name: 'Прямоугольник 3', x: 20, y: 120, width: 350, height: 200, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] as never });
    return { screen, title, pale, close, pay, photo };
  });
  editor.scene.ensure();
  return { doc, editor, ...ids };
}

test('accessibility: contrast, small text, tap size by the chosen guideline, pictures without a description', () => {
  const { editor, pale, close, photo, title } = setup();
  const kinds = (target: number) =>
    checkAccessibility(editor, undefined, target)
      .findings.map((f) => `${f.kind}:${editor.doc.get(f.id, 'name')}`)
      .sort();
  assert.deepEqual(kinds(44), ['contrast:Подпись', 'image:Прямоугольник 3', 'small:Подпись', 'target:Закрыть'].sort());
  assert.ok(!kinds(24).includes('target:Закрыть'), '24 px is enough for WCAG 2.2');
  assert.ok(kinds(48).includes('target:Закрыть') && !kinds(48).includes('target:Оплатить'), '52 px high passes 48');

  const contrast = checkAccessibility(editor).findings.find((f) => f.kind === 'contrast')!;
  assert.equal(contrast.id, pale);
  assert.ok(contrast.contrast?.fix, 'its own colour — fixable');

  // A description, a decorative layer, the role «Кнопка» on a layer without a click.
  editor.commit('a11y', (tx) => {
    tx.set(photo, 'a11yLabel', 'Товар в корзине');
    tx.set(pale, 'a11yRole', 'DECORATIVE');
    tx.set(title, 'a11yRole', 'BUTTON');
  });
  assert.deepEqual(kinds(44), ['target:Заголовок', 'target:Закрыть'], 'a 40 px high «button» is small; the decorative text is not read');
  assert.ok(close);
});

test('accessibility: reading order of a frame — rows top to bottom, what is said for each', () => {
  const { editor, screen } = setup();
  const said = readingSteps(editor, screen).map((s) => s.said);
  assert.deepEqual(said, ['Заголовок 1 уровня, Корзина', 'Кнопка, Закрыть', 'мелко и бледно', 'Изображение, без описания', 'Кнопка, Оплатить']);
});

test('colour blindness matrices keep white white (rows sum to 1)', () => {
  for (const [name, m] of Object.entries(VISION_MATRICES)) {
    for (let r = 0; r < 3; r++) assert.ok(Math.abs(m.slice(r * 3, r * 3 + 3).reduce((a, b) => a + b, 0) - 1) < 1e-3, `${name}, row ${r}`);
  }
});
