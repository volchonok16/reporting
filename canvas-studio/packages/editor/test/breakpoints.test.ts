import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { addBreakpoint, breakpointFrames, unlinkBreakpoint } from '#components';
import { ApproximateTextMeasurer } from '#layout';
import { Editor } from '../src/editor.ts';

const solid = (r: number) => [{ type: 'SOLID' as const, color: { r, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const page = editor.pageId;
  const ids = editor.commit('setup', (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Главная', width: 1440, height: 900 });
    const title = tx.create('TEXT', frame, { name: 'Заголовок', x: 100, y: 80, width: 600, height: 60, characters: 'Привет', fontSize: 64 });
    const card = tx.create('FRAME', frame, { name: 'Карточка', x: 100, y: 200, width: 400, height: 300, fills: solid(1) });
    const pic = tx.create('RECTANGLE', card, { name: 'Фото', width: 400, height: 200 });
    return { frame, title, card, pic };
  });
  return { doc, editor, page, ...ids };
}

test('breakpoints: a width shares texts, colours and names; place, size, font size and visibility stay its own', () => {
  const { doc, editor, frame, title, card, pic } = setup();
  const mobile = editor.commit('390', (tx) => addBreakpoint(doc, tx, frame, 390));
  assert.deepEqual(breakpointFrames(doc, frame), [frame, mobile]);
  assert.equal(doc.get(frame, 'name'), 'Главная — 1440');
  assert.equal(doc.get(mobile, 'name'), 'Главная — 390');
  assert.equal(doc.get(mobile, 'width'), 390);
  assert.ok(doc.get(mobile, 'x') >= 1440 + 100, 'to the right of the screen');
  const [mTitle, mCard] = doc.children(mobile);
  const mPic = doc.children(mCard!)[0]!;
  assert.equal(doc.get(mTitle!, 'bpKey'), doc.get(title, 'bpKey'));

  editor.commit('text', (tx) => tx.set(mTitle!, 'characters', 'Здравствуйте'));
  assert.equal(doc.get(title, 'characters'), 'Здравствуйте', 'a text edited in the narrow width changes in the wide one');
  editor.commit('fill', (tx) => tx.set(pic, 'fills', solid(0.5)));
  assert.deepEqual(doc.get(mPic, 'fills'), solid(0.5));
  editor.commit('own', (tx) => {
    tx.set(mTitle!, 'fontSize', 32);
    tx.set(mCard!, 'x', 16);
    tx.set(mCard!, 'visible', false);
  });
  assert.equal(doc.get(title, 'fontSize'), 64);
  assert.equal(doc.get(card, 'x'), 100);
  assert.equal(doc.get(card, 'visible'), true);
  editor.commit('rename', (tx) => tx.set(mobile, 'name', 'Телефон'));
  assert.equal(doc.get(frame, 'name'), 'Главная — 1440', 'a width keeps its own name');
});

test('breakpoints: a layer added, moved or deleted in one width is added, moved or deleted in all; a hand copy is a screen of its own', () => {
  const { doc, editor, frame, title, card } = setup();
  const tablet = editor.commit('768', (tx) => addBreakpoint(doc, tx, frame, 768));
  const mobile = editor.commit('390', (tx) => addBreakpoint(doc, tx, frame, 390));
  assert.deepEqual(breakpointFrames(doc, mobile), [frame, tablet, mobile]);
  const button = editor.commit('add', (tx) => tx.create('RECTANGLE', frame, { name: 'Кнопка', x: 1000, y: 700, width: 200, height: 48 }, { after: title }));
  for (const w of [tablet, mobile]) {
    const copy = doc.children(w).find((c) => doc.get(c, 'name') === 'Кнопка');
    assert.ok(copy, 'added in every width');
    assert.equal(doc.children(w).indexOf(copy!), 1, 'in the same place among its siblings');
    assert.ok(doc.get(copy!, 'x') + doc.get(copy!, 'width') <= doc.get(w, 'width') + 1, 'its share of the width, not its pixels');
  }
  // Duplicated inside a width: a new layer everywhere, not a second copy of the same.
  const dup = editor.commit('dup', (tx) => tx.create('RECTANGLE', mobile, { name: 'Кнопка 2', bpKey: doc.get(button, 'bpKey'), width: 10, height: 10 }));
  assert.notEqual(doc.get(dup, 'bpKey'), doc.get(button, 'bpKey'));
  assert.ok(doc.children(frame).some((c) => doc.get(c, 'name') === 'Кнопка 2'));

  editor.commit('move', (tx) => tx.move(button, card));
  for (const w of [tablet, mobile]) {
    const wCard = doc.children(w).find((c) => doc.get(c, 'name') === 'Карточка')!;
    assert.ok(doc.children(wCard).some((c) => doc.get(c, 'name') === 'Кнопка'), 'moved in every width');
  }
  editor.commit('delete', (tx) => tx.delete(doc.children(doc.children(tablet).find((c) => doc.get(c, 'name') === 'Карточка')!).find((c) => doc.get(c, 'name') === 'Кнопка')!));
  assert.equal(doc.store.isAlive(button), false, 'deleted in every width');

  // Cmd+D of a width: an ordinary new screen.
  const copy = editor.commit('copy', (tx) => tx.create('FRAME', doc.parent(mobile)!, { ...doc.store.record(mobile)!.props, deleted: false }));
  assert.equal(doc.get(copy, 'breakpoint'), null);
  assert.equal(breakpointFrames(doc, frame).length, 3);

  editor.commit('unlink', (tx) => unlinkBreakpoint(doc, tx, mobile));
  assert.equal(doc.get(mobile, 'breakpoint'), null);
  editor.commit('text', (tx) => tx.set(title, 'characters', 'Только здесь'));
  assert.notEqual(doc.get(doc.children(mobile)[0]!, 'characters'), 'Только здесь', 'unlinked: on its own');
  assert.equal(doc.get(doc.children(tablet)[0]!, 'characters'), 'Только здесь');
  editor.commit('unlink', (tx) => unlinkBreakpoint(doc, tx, tablet));
  assert.equal(doc.get(frame, 'breakpoint'), null, 'a set of one is no set');
  // Undo brings the whole set back as it was.
  editor.undo();
  assert.equal(breakpointFrames(doc, frame).length, 2);
});

test('breakpoints: a text inside a component instance is one for all widths; a swap stays the width\'s own', async () => {
  const { createInstance } = await import('#components');
  const { doc, editor, page, frame } = setup();
  const comp = editor.commit('comp', (tx) => {
    const c = tx.create('COMPONENT', page, { name: 'Кнопка', x: 0, y: 2000, width: 200, height: 48 });
    tx.create('TEXT', c, { name: 'Подпись', characters: 'Купить', width: 100, height: 20 });
    return c;
  });
  const other = editor.commit('comp2', (tx) => tx.create('COMPONENT', page, { name: 'Иконка', x: 400, y: 2000, width: 48, height: 48 }));
  const inst = editor.commit('inst', (tx) => createInstance(doc, tx, comp, frame, { x: 100, y: 600 }));
  const mobile = editor.commit('390', (tx) => addBreakpoint(doc, tx, frame, 390));
  const mInst = doc.children(mobile).find((c) => doc.type(c) === 'INSTANCE')!;
  assert.ok(mInst);
  const mLabel = doc.children(mInst)[0]!;
  editor.commit('override', (tx) => tx.set(mLabel, 'characters', 'В корзину'));
  assert.equal(doc.get(doc.children(inst)[0]!, 'characters'), 'В корзину');
  assert.ok(doc.get(doc.children(inst)[0]!, 'overrides').includes('characters'), 'an override in the wide width too');
  editor.commit('swap', (tx) => tx.set(mInst, 'mainComponent', other));
  assert.equal(doc.get(inst, 'mainComponent'), comp, 'a swap is the width\'s own');
});

test('breakpoints: a new width goes past the other screens of its row', () => {
  const { doc, editor, page, frame } = setup();
  const next = editor.commit('next', (tx) => tx.create('FRAME', page, { name: 'Корзина', x: 1540, y: 0, width: 1440, height: 900 }));
  const mobile = editor.commit('390', (tx) => addBreakpoint(doc, tx, frame, 390));
  assert.ok(doc.get(mobile, 'x') >= doc.get(next, 'x') + doc.get(next, 'width'));
});
