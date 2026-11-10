import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canContain, Document, type NodeId, type PrototypeAction, type Transaction } from '#core';
import { convertFrameToComponent } from '#components';
import { ApproximateTextMeasurer } from '#layout';
import { parseClipboard, pasteSubtree, toClipboard } from '../src/clipboard.ts';
import { Editor } from '../src/editor.ts';
import { switchLayout } from '../src/keyboard.ts';
import { fuzzyScore } from '../src/ui/command-palette.ts';
import { mentionedIn, mentionQuery, splitMentions } from '../src/ui/comments.ts';
import { compose, cssDecls, formatCss, htmlTree, swiftUI, variablesCss } from '../src/dev-code.ts';
import { buildLibrary, importFromLibrary, libraryOf, placeFromLibrary, takenUnits, updateFromLibrary, type LibraryPayload } from '../src/library.ts';

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  return { doc, editor, page: editor.pageId };
}

test('a top-level frame is an artboard: a click takes the outermost layer inside it, then one level deeper; Mod selects directly (BUG-104)', () => {
  const { editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const frame = tx.create('FRAME', page, { width: 400, height: 400 });
    const group = tx.create('GROUP', frame, { x: 10, y: 10, width: 100, height: 100 });
    const rect = tx.create('RECTANGLE', group, { width: 50, height: 50 });
    const card = tx.create('FRAME', frame, { x: 200, y: 200, width: 100, height: 100 });
    const inner = tx.create('RECTANGLE', card, { width: 10, height: 10 });
    const loose = tx.create('RECTANGLE', frame, { x: 150, y: 10, width: 20, height: 20 });
    return { frame, group, rect, card, inner, loose };
  });
  assert.equal(editor.isArtboard(ids.frame), true);
  assert.equal(editor.isArtboard(ids.card), false, 'a nested frame is not an artboard');
  assert.equal(editor.selectableFor(ids.loose, false), ids.loose, 'a layer right in an artboard is taken itself, as in Figma');
  assert.equal(editor.selectableFor(ids.rect, false), ids.group, 'a group in an artboard is taken whole');
  assert.equal(editor.selectableFor(ids.inner, false), ids.card, 'a nested frame is taken whole');
  assert.equal(editor.selectableFor(ids.frame, false), ids.frame);
  assert.equal(editor.selectableFor(ids.rect, true), ids.rect);
  editor.setSelection([ids.group]);
  assert.equal(editor.selectableFor(ids.rect, false), ids.rect, 'a selected group is entered');
  editor.setSelection([ids.card]);
  assert.equal(editor.selectableFor(ids.inner, false), ids.inner, 'a selected nested frame is entered');
});

test('group and ungroup keep everything in place', () => {
  const { editor, doc, page } = setup();
  const [a, b] = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { x: 100, y: 100, width: 20, height: 20 }),
    tx.create('RECTANGLE', page, { x: 200, y: 150, width: 20, height: 20 }),
  ]);
  editor.setSelection([a!, b!]);
  editor.group();
  const group = editor.selection[0]!;
  assert.equal(doc.type(group), 'GROUP');
  assert.deepEqual([doc.get(group, 'x'), doc.get(group, 'y'), doc.get(group, 'width'), doc.get(group, 'height')], [100, 100, 120, 70]);
  assert.deepEqual(editor.scene.bounds(b!), { x: 200, y: 150, width: 20, height: 20 });
  editor.ungroup();
  assert.equal(doc.parent(b!), page);
  assert.deepEqual([doc.get(b!, 'x'), doc.get(b!, 'y')], [200, 150]);
  assert.equal(doc.store.isAlive(group), false);
});

test('Shift+A infers direction and spacing from the arrangement (FR-AL-012)', () => {
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => [0, 1, 2].map((i) => tx.create('RECTANGLE', page, { x: i * 60, y: 0, width: 40, height: 40 })));
  editor.setSelection([...ids].reverse());
  editor.addAutoLayout();
  const frame = editor.selection[0]!;
  assert.equal(doc.get(frame, 'layoutMode'), 'HORIZONTAL');
  assert.equal(doc.get(frame, 'itemSpacing'), 20);
  assert.deepEqual(doc.children(frame), ids, 'children ordered left to right');
  assert.equal(doc.get(frame, 'width'), 160);
  assert.deepEqual(editor.scene.bounds(ids[2]!), { x: 120, y: 0, width: 40, height: 40 });
});

test('undo restores the previous selection', () => {
  const { editor, page } = setup();
  const rect = editor.commit('setup', (tx) => tx.create('RECTANGLE', page));
  editor.setSelection([rect]);
  editor.duplicate();
  assert.notEqual(editor.selection[0], rect);
  editor.undo();
  assert.deepEqual(editor.selection, [rect]);
});

test('alignment and distribution', () => {
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { x: 0, y: 0, width: 10, height: 10 }),
    tx.create('RECTANGLE', page, { x: 50, y: 30, width: 10, height: 10 }),
    tx.create('RECTANGLE', page, { x: 100, y: 5, width: 30, height: 10 }),
  ]);
  editor.setSelection(ids);
  editor.align('top');
  assert.deepEqual(ids.map((id) => doc.get(id, 'y')), [0, 0, 0]);
  doc.transact((tx) => tx.set(ids[1]!, 'x', 20));
  editor.distribute('x');
  assert.equal(doc.get(ids[1]!, 'x'), 50, 'equal gaps of 40');
});

test('clipboard round trip creates fresh ids with all properties', () => {
  const { editor, doc, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Карточка', layoutMode: 'VERTICAL', itemSpacing: 8 });
    tx.create('TEXT', f, { characters: 'Привет' });
    return f;
  });
  const data = parseClipboard(JSON.stringify(toClipboard(doc, [frame])))!;
  let copy: NodeId = '';
  doc.transact((tx) => {
    copy = pasteSubtree(tx, data.nodes[0]!, page);
  });
  assert.notEqual(copy, frame);
  assert.equal(doc.get(copy, 'itemSpacing'), 8);
  assert.equal(doc.get(doc.children(copy)[0]!, 'characters'), 'Привет');
  assert.equal(parseClipboard('not json'), null);
});

test('palette search: fuzzy matching and wrong keyboard layout', () => {
  assert.ok(fuzzyScore('выр', 'Выровнять по левому краю') > 0);
  assert.ok(fuzzyScore('впл', 'Выровнять по левому краю') > 0);
  assert.equal(fuzzyScore('xyz', 'Выровнять'), -1);
  assert.equal(switchLayout('ghbdtn'), 'привет');
  assert.equal(switchLayout('ыекщлу'), 'stroke');
});

test('text style shortcuts toggle on the selected text layers', () => {
  const { editor, doc, page } = setup();
  const text = editor.commit('setup', (tx) => tx.create('TEXT', page, { characters: 'Текст' }));
  editor.setSelection([text]);
  editor.toggleTextStyle('bold');
  assert.equal(doc.get(text, 'fontWeight'), 700);
  editor.toggleTextStyle('bold');
  assert.equal(doc.get(text, 'fontWeight'), 400);
  editor.toggleTextStyle('underline');
  assert.equal(doc.get(text, 'textDecoration'), 'UNDERLINE');
  editor.changeFontSize(2);
  assert.equal(doc.get(text, 'fontSize'), 18);
});

test('copy and paste properties, paste at a point', () => {
  const { editor, doc, page } = setup();
  const [a, b] = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { x: 0, y: 0, opacity: 0.5, cornerRadius: 12 }),
    tx.create('RECTANGLE', page, { x: 300, y: 0 }),
  ]);
  editor.setSelection([a!]);
  editor.copyProperties();
  editor.setSelection([b!]);
  editor.pasteProperties();
  assert.equal(doc.get(b!, 'opacity'), 0.5);
  assert.equal(doc.get(b!, 'cornerRadius'), 12);
  assert.equal(doc.get(b!, 'x'), 300, 'geometry is not copied');

  editor.setSelection([a!]);
  const text = editor.copyText();
  assert.ok(editor.pasteText(text, false, { x: 500, y: 600 }));
  const pasted = editor.selection[0]!;
  assert.deepEqual([doc.get(pasted, 'x'), doc.get(pasted, 'y')], [500, 600]);
});

test('components: create, place instance, override, reset, detach', () => {
  const { editor, doc, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Кнопка', x: 0, y: 0, width: 120, height: 40 });
    tx.create('TEXT', f, { name: 'Подпись', characters: 'OK', x: 10, y: 10, width: 50, height: 20 });
    return f;
  });
  editor.setSelection([frame]);
  editor.createComponent();
  const component = editor.selection[0]!;
  assert.equal(doc.type(component), 'COMPONENT');
  const instance = editor.placeInstance(component, { x: 300, y: 0 })!;
  assert.equal(doc.type(instance), 'INSTANCE');
  assert.equal(doc.get(instance, 'mainComponent'), component);
  const label = doc.children(instance)[0]!;
  assert.equal(doc.get(label, 'characters'), 'OK');

  // Instance layers cannot be moved or deleted on their own.
  editor.setSelection([label]);
  editor.nudge(5, 0);
  assert.equal(doc.get(label, 'x'), 10);
  editor.deleteSelection();
  assert.ok(doc.store.isAlive(label));

  // Override and reset.
  editor.commit('override', (tx) => tx.set(label, 'characters', 'Отмена'));
  assert.deepEqual(doc.get(label, 'overrides'), ['characters']);
  editor.commit('main', (tx) => tx.set(doc.children(component)[0]!, 'characters', 'Готово'));
  assert.equal(doc.get(label, 'characters'), 'Отмена', 'override survives a component change');
  editor.setSelection([instance]);
  editor.resetSelectedOverrides();
  assert.equal(doc.get(label, 'characters'), 'Готово');

  // Go to main component.
  editor.goToMainComponent();
  assert.deepEqual(editor.selection, [component]);

  // Detach.
  editor.setSelection([instance]);
  editor.detachSelection();
  const detached = editor.selection[0]!;
  assert.equal(doc.type(detached), 'FRAME');
  assert.equal(doc.get(doc.children(detached)[0]!, 'componentKey'), null);
});

test('components: variants via the editor and Alt-duplicate of a component', () => {
  const { editor, doc, page } = setup();
  const [a, b] = editor.commit('setup', (tx) => [
    tx.create('FRAME', page, { name: 'Размер=S', width: 80, height: 30 }),
    tx.create('FRAME', page, { name: 'Размер=L', x: 100, width: 160, height: 50 }),
  ]);
  const [s, l] = [a!, b!].map((id) => {
    editor.setSelection([id]);
    editor.createComponent();
    return editor.selection[0]!;
  });
  editor.setSelection([s!, l!]);
  editor.combineAsVariants();
  const set = editor.selection[0]!;
  assert.equal(doc.type(set), 'COMPONENT_SET');
  const instance = editor.placeInstance(s!, { x: 600, y: 0 })!;
  editor.switchVariant(instance, 'Размер', 'L');
  assert.equal(doc.get(instance, 'mainComponent'), l);
  assert.equal(doc.get(instance, 'width'), 160);
  editor.setSelection([l!]);
  editor.addVariant();
  assert.equal(doc.children(set).length, 3);

  // Alt-drag of a standalone component yields an instance.
  const solo = editor.commit('solo', (tx) => tx.create('FRAME', page, { name: 'Иконка', y: 300, width: 24, height: 24 }));
  editor.setSelection([solo]);
  editor.createComponent();
  const icon = editor.selection[0]!;
  const copies = editor.commit('alt-drag', (tx) => editor.duplicateInPlace(tx, [icon]));
  assert.equal(doc.type(copies[0]!), 'INSTANCE');
});

test('paste strips component links outside instances', () => {
  const { editor, doc, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { width: 100, height: 100 });
    tx.create('RECTANGLE', f, { width: 10, height: 10 });
    return f;
  });
  editor.setSelection([frame]);
  editor.createComponent();
  const component = editor.selection[0]!;
  const instance = editor.placeInstance(component, { x: 300, y: 0 })!;
  const layer = doc.children(instance)[0]!;
  editor.setSelection([layer]);
  const text = editor.copyText()!;
  editor.setSelection([]);
  assert.ok(editor.pasteText(text));
  const pasted = editor.selection[0]!;
  assert.equal(doc.parent(pasted), page);
  assert.equal(doc.get(pasted, 'componentKey'), null, 'a pasted instance layer is a plain layer');

  editor.setSelection([instance]);
  const copied = editor.copyText()!;
  editor.setSelection([]);
  editor.pasteText(copied);
  const copy = editor.selection[0]!;
  assert.equal(doc.type(copy), 'INSTANCE');
  assert.equal(doc.get(copy, 'mainComponent'), component);
  assert.ok(doc.get(doc.children(copy)[0]!, 'componentKey'), 'layers of a pasted instance stay linked');
});

test('grouping variants inside a set is refused with a message; frame removal explains itself', () => {
  const { editor, doc, page } = setup();
  const toasts: string[] = [];
  editor.events.on('toast', ({ message }) => toasts.push(message));
  const [a, b] = editor.commit('setup', (tx) => [tx.create('FRAME', page, { name: 'Вид=1', width: 20, height: 20 }), tx.create('FRAME', page, { name: 'Вид=2', x: 40, width: 20, height: 20 })]);
  const comps = [a!, b!].map((id) => {
    editor.setSelection([id]);
    editor.createComponent();
    return editor.selection[0]!;
  });
  editor.setSelection(comps);
  editor.combineAsVariants();
  const set = editor.selection[0]!;
  editor.setSelection(comps);
  editor.group();
  assert.equal(doc.children(set).length, 2);
  assert.ok(toasts.at(-1)?.includes('набора'));

  const frame = editor.commit('frame', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Подложка', y: 200, width: 100, height: 100, fills: [] });
    tx.create('RECTANGLE', f, { width: 10, height: 10 });
    return f;
  });
  editor.commit('fill', (tx) => tx.set(frame, 'fills', doc.get(set, 'strokes')));
  editor.setSelection([frame]);
  editor.ungroup();
  assert.ok(toasts.at(-1)?.includes('Подложка'));
});

test('insertImages creates rectangles with an image fill at natural size (capped)', () => {
  const { editor, doc } = setup();
  const ids = editor.insertImages(
    [
      { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 200, height: 100, name: 'Фото' },
      { bytes: new Uint8Array([4, 5]), mime: 'image/jpeg', width: 4000, height: 2000, name: 'Большое' },
    ],
    { x: 0, y: 0 },
  );
  assert.equal(ids.length, 2);
  assert.deepEqual([doc.get(ids[0]!, 'width'), doc.get(ids[0]!, 'height')], [200, 100]);
  assert.deepEqual([doc.get(ids[1]!, 'width'), doc.get(ids[1]!, 'height')], [1600, 800]);
  const fill = doc.get(ids[0]!, 'fills')[0]!;
  assert.equal(fill.type, 'IMAGE');
  assert.ok(fill.type === 'IMAGE' && doc.store.blobs.has(fill.imageHash));
  assert.deepEqual(editor.selection, ids);
});

test('insertImageTiles places a big picture at its own size, its pieces in a group (FEAT-147)', () => {
  const { editor, doc } = setup();
  const tile = (x: number, y: number, width: number, height: number, n: number) => ({ bytes: new Uint8Array([n]), mime: 'image/png', width, height, name: `Скрин, часть ${n}`, x, y });
  const group = editor.insertImageTiles('Скрин', 1440, 6000, [tile(0, 0, 1440, 4098, 1), tile(0, 4096, 1440, 1904, 2)], { x: 0, y: 0 })!;
  assert.equal(doc.type(group), 'GROUP');
  assert.equal(doc.get(group, 'name'), 'Скрин');
  const parts = doc.store.children(group);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((id) => [doc.get(id, 'x'), doc.get(id, 'y'), doc.get(id, 'width'), doc.get(id, 'height')]), [[0, 0, 1440, 4098], [0, 4096, 1440, 1904]]);
  assert.deepEqual([doc.get(group, 'x'), doc.get(group, 'y')], [-720, -3000]);
  assert.deepEqual(editor.selection, [group]);
  editor.undo();
  assert.equal(doc.store.isAlive(group), false, 'one undo step');
  // A picture that fits in one piece is a plain image layer, not scaled down.
  const one = editor.insertImageTiles('Фото', 3000, 2000, [tile(0, 0, 3000, 2000, 1)], { x: 0, y: 0 })!;
  assert.equal(doc.type(one), 'RECTANGLE');
  assert.deepEqual([doc.get(one, 'width'), doc.get(one, 'height')], [3000, 2000]);
});

test('paint type conversion keeps the colour; gradient angle round-trips (BUG-009)', async () => {
  const { convertPaint, gradientAngle, withAngle } = await import('../src/ui/paint-editor.ts');
  const solidPaint = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5, visible: true };
  const linear = convertPaint(solidPaint, 'GRADIENT_LINEAR');
  assert.equal(linear.type, 'GRADIENT_LINEAR');
  assert.ok(linear.type === 'GRADIENT_LINEAR' && linear.stops[0]!.color.r === 1 && linear.stops[1]!.color.a === 0);
  assert.equal(linear.opacity, 0.5);
  assert.ok(linear.type === 'GRADIENT_LINEAR');
  if (linear.type === 'GRADIENT_LINEAR') {
    assert.equal(gradientAngle(linear), 0);
    assert.equal(gradientAngle(withAngle(linear, 90)), 90);
    assert.equal(gradientAngle(withAngle(linear, 225)), 225);
  }
  const back = convertPaint(linear, 'SOLID');
  assert.deepEqual(back.type === 'SOLID' && back.color, { r: 1, g: 0, b: 0, a: 1 });
});

test('text editing session: styles for a range, pending style, one undo step', () => {
  const { editor, doc, page } = setup();
  const id = editor.commit('t', (tx) => tx.create('TEXT', page, { characters: 'Hello world' }));
  editor.startTextEditing(id);
  editor.setTextSelection(6, 11);
  editor.toggleTextStyle('bold');
  assert.deepEqual(doc.get(id, 'textRuns'), [{ start: 6, end: 11, style: { fontWeight: 700 } }]);
  assert.equal(editor.textStyleValue('fontWeight'), 700);
  // Typing at the end continues the bold run.
  editor.replaceText('Hello world!', 12, 12);
  assert.deepEqual(doc.get(id, 'textRuns'), [{ start: 6, end: 12, style: { fontWeight: 700 } }]);
  // Collapsed caret + italic: the next typed text gets it.
  editor.setTextSelection(5, 5);
  editor.toggleTextStyle('italic');
  editor.replaceText('Hello, world!', 6, 6);
  assert.deepEqual(doc.get(id, 'textRuns')[0], { start: 5, end: 6, style: { italic: true } });
  editor.stopTextEditing();
  assert.equal(doc.get(id, 'characters'), 'Hello, world!');
  // Whole-layer change outside editing clears the per-range overrides of that key.
  editor.setSelection([id]);
  editor.applyTextStyle({ fontWeight: 300 });
  assert.equal(doc.get(id, 'fontWeight'), 300);
  assert.ok(doc.get(id, 'textRuns').every((r) => r.style.fontWeight === undefined));
  editor.undo();
  editor.undo();
  assert.equal(doc.get(id, 'characters'), 'Hello world', 'the whole editing session is one undo step');
  assert.deepEqual(doc.get(id, 'textRuns'), []);
});

test('vectors: boolean operations, flatten, outline stroke, mask, point editing', async () => {
  const { nodePaths } = await import('#layout');
  const { area, flattenPaths, pathsBounds } = await import('#geometry');
  const { editor, doc, page } = setup();
  const [a, b] = editor.commit('s', (tx) => [
    tx.create('RECTANGLE', page, { x: 0, y: 0, width: 100, height: 100 }),
    tx.create('ELLIPSE', page, { x: 50, y: 50, width: 100, height: 100 }),
  ]);
  editor.setSelection([a!, b!]);
  editor.booleanSelection('SUBTRACT');
  const bool = editor.selection[0]!;
  assert.equal(doc.type(bool), 'BOOLEAN_OPERATION');
  assert.deepEqual(doc.children(bool), [a, b]);
  // As large as the result, not the shapes (as in Figma): the subtracted circle adds nothing.
  assert.deepEqual([doc.get(bool, 'x'), doc.get(bool, 'y'), doc.get(bool, 'width'), doc.get(bool, 'height')], [0, 0, 100, 100]);
  const areaOf = (id: string) => Math.abs(flattenPaths(nodePaths(doc, id), 0.05).reduce((n, l) => n + area(l.points), 0));
  const expected = 10000 - (Math.PI * 50 * 50) / 4;
  assert.ok(Math.abs(areaOf(bool) - expected) < 30, `subtract area ${areaOf(bool)}`);
  // Live: moving a child changes the result.
  editor.commit('move', (tx) => tx.update(b!, { x: 200 }));
  assert.ok(Math.abs(areaOf(bool) - 10000) < 1);
  editor.commit('back', (tx) => tx.update(b!, { x: 50 }));
  // Flatten keeps the shape and replaces the boolean with one vector.
  editor.setSelection([bool]);
  editor.flattenSelection();
  const vec = editor.selection[0]!;
  assert.equal(doc.type(vec), 'VECTOR');
  assert.equal(doc.store.isAlive(bool), false);
  assert.ok(Math.abs(areaOf(vec) - expected) < 30);
  const vb = pathsBounds(doc.get(vec, 'vectorPaths'))!;
  assert.ok(Math.abs(vb.x) < 1e-6 && Math.abs(vb.y) < 1e-6, 'vector points start at the box origin');
  // Resizing a vector scales its points.
  editor.commit('size', (tx) => editor.applySize(tx, vec, doc.get(vec, 'width') * 2, doc.get(vec, 'height'), true, false));
  assert.ok(Math.abs(areaOf(vec) - expected * 2) < 60);
  // Outline stroke of a line gives a filled shape of the stroke's area.
  const line = editor.commit('l', (tx) => tx.create('LINE', page, { x: 0, y: 300, width: 100, strokeWeight: 10 }));
  editor.setSelection([line]);
  editor.outlineStroke();
  const outline = editor.selection[0]!;
  assert.equal(doc.type(outline), 'VECTOR');
  assert.ok(Math.abs(areaOf(outline) - (1000 + Math.PI * 25)) < 15, `outline area ${areaOf(outline)}`);
  assert.equal(doc.get(outline, 'fills').length, 1);
  // Use as mask groups the selection with the bottom layer as the mask.
  const [m1, m2] = editor.commit('m', (tx) => [tx.create('ELLIPSE', page, { x: 0, y: 500 }), tx.create('RECTANGLE', page, { x: 20, y: 520 })]);
  editor.setSelection([m1!, m2!]);
  editor.useAsMask();
  const group = editor.selection[0]!;
  assert.equal(doc.type(group), 'GROUP');
  assert.equal(doc.get(m1!, 'isMask'), true);
  // BUG-026: a single mask wraps only the overlapping layers above it; distant layers stay untouched.
  const [c, img, far] = editor.commit('m2', (tx) => [
    tx.create('ELLIPSE', page, { x: 0, y: 1000, width: 100, height: 100 }),
    tx.create('RECTANGLE', page, { x: 50, y: 1050, width: 100, height: 100 }),
    tx.create('VECTOR', page, { x: 600, y: 1000, width: 50, height: 50 }),
  ]);
  editor.setSelection([c!]);
  editor.setMask(true);
  const mg = editor.selection[0]!;
  assert.equal(doc.type(mg), 'GROUP');
  assert.deepEqual([...doc.children(mg)], [c, img]);
  assert.equal(doc.parent(far!), page, 'non-overlapping layer is not masked');
  // A lone mask with nothing above is refused instead of hiding things.
  editor.setSelection([far!]);
  editor.setMask(true);
  assert.equal(doc.get(far!, 'isMask'), false);
  // Entering point editing converts a rectangle to a vector; deleting a point.
  const r = editor.commit('r', (tx) => tx.create('RECTANGLE', page, { x: 0, y: 700, width: 40, height: 40 }));
  editor.enterVectorEdit(r);
  const edited = editor.vectorEdit!.id;
  assert.equal(doc.type(edited), 'VECTOR');
  assert.ok(doc.get(edited, 'vectorNetwork'), 'points are edited as a vector network');
  editor.setVectorSelection(['2']);
  editor.deleteSelection();
  const net = doc.get(edited, 'vectorNetwork')!;
  assert.equal(net.vertices.length, 3);
  assert.equal(net.regions.length, 1, 'the neighbours are joined: still closed');
  assert.ok(Math.abs(areaOf(edited) - 800) < 1, 'a triangle remains');
  // Simplify and offset work on vectors too.
  editor.exitVectorEdit();
  editor.setSelection([edited]);
  editor.offsetSelection(10);
  const grown = editor.selection[0]!;
  assert.equal(doc.type(grown), 'VECTOR');
  assert.ok(areaOf(grown) > 800 + 10 * 100, 'moved out by 10 on every side');
});

test('SVG: path data, transforms, import and export round trip', async () => {
  const { parsePathData, parseTransform, parseXml, importSvg } = await import('../src/svg-import.ts');
  const { exportSvg, exportVectorPdf } = await import('#render');
  const { pathsBounds } = await import('#geometry');
  // Path data: relative commands, quadratic and arc segments.
  const paths = parsePathData('M10 10 h80 v80 H10 Z m20 20 q20 -20 40 0 t40 0 a10 10 0 0 1 -20 0');
  assert.equal(paths.length, 2);
  assert.equal(paths[0]!.closed, true);
  assert.equal(paths[0]!.points.length, 4);
  const b = pathsBounds([paths[0]!])!;
  assert.deepEqual([b.x, b.y, b.width, b.height], [10, 10, 80, 80]);
  const m = parseTransform('translate(10 20) scale(2)');
  assert.deepEqual([m.a, m.d, m.e, m.f], [2, 2, 10, 20]);
  const xml = parseXml('<?xml version="1.0"?><!-- c --><svg viewBox="0 0 10 10"><g id="a"><rect width="5" height="5"/></g></svg>');
  assert.equal(xml.children[0]!.name, 'svg');
  assert.equal(xml.children[0]!.children[0]!.children[0]!.attrs.width, '5');

  const { editor, doc } = setup();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">
    <style>.blue{fill:#0d99ff}</style>
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
    <rect class="blue" x="0" y="0" width="40" height="20" rx="4"/>
    <circle cx="70" cy="25" r="20" fill="url(#g)" stroke="black" stroke-width="2"/>
    <path d="M0 40 L100 40" stroke="#333" fill="none"/>
    <text x="5" y="48" font-size="6" font-weight="bold">Привет</text>
  </svg>`;
  const top = importSvg(editor, svg, { x: 500, y: 500 }, 'icon')!;
  assert.equal(doc.type(top), 'GROUP');
  const kids = doc.children(top);
  assert.equal(kids.length, 4);
  const rect = kids[0]!;
  assert.equal(doc.type(rect), 'VECTOR');
  assert.deepEqual([doc.get(rect, 'width'), doc.get(rect, 'height')], [80, 40], 'viewBox scale is applied');
  const rectFill = doc.get(rect, 'fills')[0]!;
  assert.ok(rectFill.type === 'SOLID' && Math.abs(rectFill.color.b - 1) < 0.01, 'class style applied');
  const circleFill = doc.get(kids[1]!, 'fills')[0]!;
  assert.equal(circleFill.type, 'GRADIENT_LINEAR');
  assert.equal(doc.get(kids[1]!, 'strokeWeight'), 4);
  assert.equal(doc.get(kids[2]!, 'fills').length, 0, 'open path without fill');
  assert.equal(doc.type(kids[3]!), 'TEXT');
  assert.equal(doc.get(kids[3]!, 'characters'), 'Привет');
  assert.equal(doc.get(kids[3]!, 'fontWeight'), 700);
  const gb = editor.scene.bounds(top);
  assert.ok(Math.abs(gb.x + gb.width / 2 - 500) < 1 && Math.abs(gb.y + gb.height / 2 - 500) < 15, 'centred at the drop point');

  // Export the imported group back to SVG and import again: same geometry.
  const { svg: out } = exportSvg(editor.scene, editor.measurer, [top]);
  assert.match(out, /<svg [^>]*viewBox=/);
  assert.match(out, /<linearGradient/);
  assert.match(out, /<tspan[^>]*font-weight="700"[^>]*>Привет<\/tspan>/);
  const again = importSvg(editor, out, { x: 900, y: 500 })!;
  const before = editor.scene.bounds(rect);
  const after = editor.scene.bounds(doc.children(doc.type(again) === 'GROUP' && doc.children(again).length === 1 ? doc.children(again)[0]! : again)[0]!);
  assert.ok(Math.abs(before.width - after.width) < 0.01 && Math.abs(before.height - after.height) < 0.01, 'round trip keeps sizes');

  // Vector PDF of shapes: real path operators, a shading for the gradient.
  const pdf = await exportVectorPdf({ images: { get: () => null } } as never, editor.scene, editor.measurer, [kids[0]!, kids[1]!]);
  const text = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/ShadingType 2/);
});

test('styles: bind, propagate, detach on direct edit, delete keeps values, undo (FR-STY)', () => {
  const { editor, doc, page } = setup();
  const red = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
  const blue = { type: 'SOLID' as const, color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true };
  const [a, b, t] = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { fills: [red] }),
    tx.create('ELLIPSE', page, { x: 200 }),
    tx.create('TEXT', page, { characters: 'Hello', fontSize: 12, textRuns: [{ start: 0, end: 2, style: { fontSize: 30, italic: true } }] }),
  ]);
  editor.setSelection([a!]);
  const style = editor.createStyle('FILL', 'fillStyleId', 'Brand/Red');
  assert.equal(doc.get(a!, 'fillStyleId'), style);
  assert.deepEqual(doc.get(style, 'fills'), [red]);
  assert.deepEqual([...doc.pages()], [page], 'styles are not pages');
  assert.deepEqual([...doc.styles()], [style]);
  // Apply to another layer (fill) and to a stroke.
  editor.setSelection([b!]);
  editor.applyStyle('fillStyleId', style);
  editor.applyStyle('strokeStyleId', style);
  assert.deepEqual(doc.get(b!, 'fills'), [red]);
  assert.deepEqual(doc.get(b!, 'strokes'), [red]);
  // Editing the style reaches every bound layer in one undo step.
  editor.updateStyle(style, { fills: [blue] });
  assert.deepEqual(doc.get(a!, 'fills'), [blue]);
  assert.deepEqual(doc.get(b!, 'strokes'), [blue]);
  editor.undo();
  assert.deepEqual(doc.get(a!, 'fills'), [red]);
  editor.redo();
  // A direct edit of a bound value detaches that layer only.
  editor.commit('edit', (tx) => tx.set(a!, 'fills', [red]));
  assert.equal(doc.get(a!, 'fillStyleId'), null);
  assert.equal(doc.get(b!, 'fillStyleId'), style);
  // Users, replace, delete.
  assert.deepEqual(editor.styleUsers(style), [b]);
  const other = editor.duplicateStyle(style);
  assert.equal(editor.replaceStyle(style, other), 2, 'fill and stroke bindings');
  assert.equal(doc.get(b!, 'strokeStyleId'), other);
  editor.deleteStyle(other);
  assert.equal(doc.get(b!, 'fillStyleId'), null, 'deleting detaches');
  assert.deepEqual(doc.get(b!, 'fills'), [blue], 'values stay');
  editor.undo();
  assert.equal(doc.get(b!, 'fillStyleId'), other, 'undo restores the link');
  // Text style: base typography follows, runs lose the props the style defines.
  editor.setSelection([t!]);
  const ts = editor.createStyle('TEXT', 'textStyleId', 'Heading');
  editor.updateStyle(ts, { fontSize: 24, fontWeight: 700 });
  assert.equal(doc.get(t!, 'fontSize'), 24);
  assert.equal(doc.get(t!, 'fontWeight'), 700);
  assert.deepEqual(doc.get(t!, 'textRuns'), [], 'run overrides of style props are removed');
  // A binding to a style of the wrong kind is refused.
  editor.applyStyle('textStyleId', style);
  assert.equal(doc.get(t!, 'textStyleId'), ts);
});

test('styles inside components: instances follow, applying a style on an instance layer is an override', () => {
  const { editor, doc, page } = setup();
  const red = { type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
  const green = { type: 'SOLID' as const, color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1, visible: true };
  const comp = editor.commit('c', (tx) => {
    const c = tx.create('COMPONENT', page, { width: 100, height: 100 });
    tx.create('RECTANGLE', c, { width: 50, height: 50 });
    return c;
  });
  const inner = doc.children(comp)[0]!;
  editor.setSelection([inner]);
  editor.commit('fill', (tx) => tx.set(inner, 'fills', [red]));
  const style = editor.createStyle('FILL', 'fillStyleId', 'Red');
  const instance = editor.placeInstance(comp)!;
  const mirror = doc.children(instance)[0]!;
  assert.equal(doc.get(mirror, 'fillStyleId'), style);
  editor.updateStyle(style, { fills: [green] });
  assert.deepEqual(doc.get(mirror, 'fills'), [green], 'instance follows the style through its component');
  // A different style on the instance layer is kept as an override.
  editor.setSelection([mirror]);
  const s2 = editor.createStyle('FILL', undefined, 'Other');
  editor.updateStyle(s2, { fills: [red] });
  editor.applyStyle('fillStyleId', s2);
  assert.deepEqual(doc.get(mirror, 'fills'), [red]);
  assert.ok(doc.get(mirror, 'overrides').includes('fillStyleId'));
  editor.updateStyle(style, { fills: [{ ...green, opacity: 0.5 }] });
  assert.deepEqual(doc.get(mirror, 'fills'), [red], 'override survives component style edits');
});

test('styles travel with copied layers into another file', () => {
  const one = setup();
  const r = one.editor.commit('r', (tx) => tx.create('RECTANGLE', one.page, {}));
  one.editor.setSelection([r]);
  const style = one.editor.createStyle('FILL', 'fillStyleId', 'Brand/Blue');
  const text = JSON.stringify(toClipboard(one.doc, [r]));
  const two = setup();
  assert.ok(two.editor.pasteText(text));
  const pasted = two.editor.selection[0]!;
  const local = two.doc.get(pasted, 'fillStyleId');
  assert.ok(local && local !== style, 'a local copy of the style is created');
  assert.equal(two.doc.get(local!, 'name'), 'Brand/Blue');
  // Pasting again reuses it instead of creating a duplicate.
  two.editor.pasteText(text);
  assert.equal(two.doc.styles().length, 1);
  assert.equal(two.doc.get(two.editor.selection[0]!, 'fillStyleId'), local);
});

test('variables: modes, aliases with opacity, bindings, inheritance, unbind on edit, delete (FR-VAR)', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Тема');
  const light = doc.get(coll, 'modes')[0]!.id;
  const dark = vars.addMode(coll, 'Тёмная');
  vars.renameMode(coll, light, 'Светлая');
  const grey = vars.createVariable(coll, 'COLOR', 'Base/Grey', { r: 0.5, g: 0.5, b: 0.5, a: 1 });
  const bg = vars.createVariable(coll, 'COLOR', 'Surface/Bg', { r: 1, g: 1, b: 1, a: 1 });
  assert.ok(vars.setValue(bg, dark, vars.parseInput('COLOR', '{base.grey} @ 50%', coll)!));
  const radius = vars.createVariable(coll, 'FLOAT', 'Radius/M', 8);
  vars.setValue(radius, dark, 12);
  // Cycle and wrong type are refused.
  assert.equal(vars.setValue(grey, dark, { type: 'ALIAS', id: bg }), false);
  assert.equal(vars.setValue(radius, dark, { r: 0, g: 0, b: 0, a: 1 }), false);

  const [frame, rect] = editor.commit('s', (tx) => {
    const f = tx.create('FRAME', page, { width: 200, height: 200 });
    const r = tx.create('RECTANGLE', f, { width: 50, height: 50 });
    return [f, r];
  });
  editor.setSelection([rect!]);
  assert.equal(vars.bind('fills/0', bg), 1);
  assert.equal(vars.bind('cornerRadius', radius), 1);
  const f0 = doc.get(rect!, 'fills')[0]!;
  assert.deepEqual(f0.type === 'SOLID' && f0.color, { r: 1, g: 1, b: 1, a: 1 });
  assert.equal(doc.get(rect!, 'cornerRadius'), 8);
  // A mode on the frame is inherited by its children.
  vars.setMode([frame!], coll, dark);
  const fill = doc.get(rect!, 'fills')[0]!;
  assert.ok(fill.type === 'SOLID' && Math.abs(fill.color.a - 0.5) < 1e-9 && fill.color.r === 0.5, 'alias with 50% opacity');
  assert.equal(doc.get(rect!, 'cornerRadius'), 12);
  editor.undo();
  assert.equal(doc.get(rect!, 'cornerRadius'), 8, 'undo of the mode switch');
  editor.redo();
  // Changing a variable reaches layers through aliases.
  vars.setValue(grey, dark, { r: 0, g: 0, b: 1, a: 1 });
  const f2 = doc.get(rect!, 'fills')[0]!;
  assert.ok(f2.type === 'SOLID' && f2.color.b === 1 && f2.color.r === 0, 'dark bg follows grey in the same mode');
  // Moving the layer out of the frame changes its mode context.
  editor.commit('move', (tx) => tx.move(rect!, page));
  assert.equal(doc.get(rect!, 'cornerRadius'), 8);
  // Editing a bound value directly unbinds just that field.
  editor.commit('edit', (tx) => tx.set(rect!, 'cornerRadius', 3));
  assert.equal(doc.get(rect!, 'boundVariables')?.cornerRadius, undefined);
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0'], bg);
  // Usages and dependencies.
  assert.deepEqual(vars.usages(grey).viaAlias.map((u) => u.id), [rect]);
  assert.deepEqual(vars.dependsOn(bg), [grey]);
  assert.deepEqual(vars.dependents(grey), [bg]);
  // Renaming keeps bindings (FR-VAR-026); deleting keeps the value and unbinds.
  vars.renameVariable(bg, 'Surface/Background');
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0'], bg);
  const before = doc.get(rect!, 'fills');
  vars.deleteVariables([bg]);
  assert.equal(doc.get(rect!, 'boundVariables'), null);
  assert.deepEqual(doc.get(rect!, 'fills'), before);
  editor.undo();
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0'], bg);
});

test('variables: parsing, TSV paste, search, bulk rename, instances keep their own mode', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Spacing');
  const m1 = doc.get(coll, 'modes')[0]!.id;
  const m2 = vars.addMode(coll, 'Dense');
  assert.equal(vars.parseInput('FLOAT', '1.5rem'), 24);
  assert.deepEqual(vars.parseInput('COLOR', 'rgba(255, 0, 0, 0.5)'), { r: 1, g: 0, b: 0, a: 0.5 });
  assert.equal(vars.parseInput('BOOLEAN', 'нет'), false);
  const s = vars.createVariable(coll, 'FLOAT', 'space/s', 4);
  assert.equal(vars.pasteTable(coll, s, 0, '8\t4\n16\t8\n24\t12\n'), 6);
  const list = doc.children(coll);
  assert.equal(list.length, 3, 'extra rows create variables');
  assert.deepEqual(vars.valuesByMode(list[2]!).map((x) => x.value), [24, 12]);
  assert.equal(vars.copyTable(list, [m1, m2]), '8\t4\n16\t8\n24\t12');
  assert.deepEqual(vars.search(coll, '16'), [list[1]]);
  assert.equal(vars.renameByPattern(list, 'space', 'gap'), 1);
  assert.equal(doc.get(s, 'name'), 'gap/s');
  // Component with a bound gap; the instance switches mode and resolves on its own.
  const comp = editor.commit('c', (tx) => tx.create('COMPONENT', page, { width: 100, height: 40, layoutMode: 'HORIZONTAL' }));
  editor.setSelection([comp]);
  vars.bind('itemSpacing', s);
  assert.equal(doc.get(comp, 'itemSpacing'), 8);
  const inst = editor.placeInstance(comp)!;
  assert.equal(doc.get(inst, 'itemSpacing'), 8);
  vars.setMode([inst], coll, m2);
  assert.equal(doc.get(inst, 'itemSpacing'), 4);
  vars.setValue(s, m1, 10);
  assert.equal(doc.get(comp, 'itemSpacing'), 10);
  assert.equal(doc.get(inst, 'itemSpacing'), 4, 'the instance stays in its own mode');
});

test('styles made of variables switch with the mode (FR-STY-002)', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Тема');
  const light = doc.get(coll, 'modes')[0]!.id;
  const dark = vars.addMode(coll, 'Тёмная');
  const brand = vars.createVariable(coll, 'COLOR', 'brand', { r: 1, g: 0, b: 0, a: 1 });
  vars.setValue(brand, dark, { r: 0, g: 0, b: 1, a: 1 });
  const style = editor.createStyle('FILL', undefined, 'Brand');
  editor.setSelection([]);
  editor.commit('bind style', (tx) => tx.set(style, 'boundVariables', { 'fills/0': brand }));
  const fill = (id: string) => {
    const p = doc.get(id, 'fills')[0]!;
    return p.type === 'SOLID' ? p.color : null;
  };
  assert.deepEqual(fill(style), { r: 1, g: 0, b: 0, a: 1 }, 'the style shows the default mode');
  const [frame, rect] = editor.commit('s', (tx) => {
    const f = tx.create('FRAME', page, { width: 100, height: 100, variableModes: { [coll]: dark } });
    return [f, tx.create('RECTANGLE', f, {})];
  });
  editor.setSelection([rect!]);
  editor.applyStyle('fillStyleId', style);
  assert.deepEqual(fill(rect!), { r: 0, g: 0, b: 1, a: 1 }, 'the layer resolves the style variable in its own mode');
  assert.equal(doc.get(rect!, 'fillStyleId'), style);
  // Strokes map fills/0 → strokes/0.
  editor.applyStyle('strokeStyleId', style);
  assert.equal(doc.get(rect!, 'boundVariables')?.['strokes/0'], brand);
  // Switching the frame back keeps the style link.
  vars.setMode([frame!], coll, light);
  assert.deepEqual(fill(rect!), { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(doc.get(rect!, 'fillStyleId'), style);
  // An unrelated edit does not detach.
  editor.commit('move', (tx) => tx.set(rect!, 'x', 30));
  assert.equal(doc.get(rect!, 'fillStyleId'), style);
  // Typing a colour on the layer detaches both the variable and the style.
  editor.commit('edit', (tx) => tx.set(rect!, 'fills', [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1, visible: true }]));
  assert.equal(doc.get(rect!, 'fillStyleId'), null);
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0'], undefined);
});

test('variables travel with copied layers into another file', () => {
  const one = setup();
  const vars = one.editor.variables;
  const coll = vars.createCollection('Тема');
  const dark = vars.addMode(coll, 'Тёмная');
  const base = vars.createVariable(coll, 'COLOR', 'base', { r: 1, g: 0, b: 0, a: 1 });
  const bg = vars.createVariable(coll, 'COLOR', 'bg', { type: 'ALIAS', id: base });
  const frame = one.editor.commit('f', (tx) => tx.create('FRAME', one.page, { variableModes: { [coll]: dark } }));
  one.editor.setSelection([frame]);
  vars.bind('fills/0', bg);
  const text = JSON.stringify(toClipboard(one.doc, [frame]));
  const two = setup();
  two.editor.pasteText(text);
  const pasted = two.editor.selection[0]!;
  const [c2] = two.doc.collections();
  assert.ok(c2 && two.doc.get(c2, 'name') === 'Тема');
  const v = two.doc.get(pasted, 'boundVariables')?.['fills/0'];
  assert.ok(v && v !== bg && two.doc.get(v, 'name') === 'bg');
  const alias = Object.values(two.doc.get(v, 'varValues'))[0];
  assert.ok(alias && typeof alias === 'object' && 'type' in alias && alias.type === 'ALIAS' && two.doc.get(alias.id, 'name') === 'base');
  assert.equal(Object.keys(two.doc.get(pasted, 'variableModes') ?? {})[0], c2, 'the mode choice points at the pasted collection');
  two.editor.pasteText(text);
  assert.equal(two.doc.children(c2!).length, 2, 'a second paste reuses the variables');
});

test('find unbound values binds unambiguous matches (FR-VAR-032)', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('T');
  const blue = vars.createVariable(coll, 'COLOR', 'blue', { r: 0, g: 0, b: 1, a: 1 });
  const r8 = vars.createVariable(coll, 'FLOAT', 'radius/8', 8);
  const s8 = vars.createVariable(coll, 'FLOAT', 'space/8', 8);
  vars.setScopes([r8], ['CORNER_RADIUS']);
  const rect = editor.commit('r', (tx) => tx.create('RECTANGLE', page, { cornerRadius: 8, strokeWeight: 8, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }] }));
  const [bound, ambiguous] = vars.bindUnbound([]);
  assert.equal(doc.get(rect, 'boundVariables')?.['fills/0'], blue);
  assert.equal(doc.get(rect, 'boundVariables')?.strokeWeight, s8, 'radius/8 is scoped to corners, so only space/8 fits');
  assert.equal(doc.get(rect, 'boundVariables')?.cornerRadius, undefined, 'both fit the corner radius: ambiguous, left alone');
  assert.ok(bound >= 1 && ambiguous >= 1);
});

test('DTCG tokens: export and import round trip with modes, aliases, styles (FR-VAR-040)', async () => {
  const { exportTokens, planImport } = await import('../src/tokens.ts');
  const one = setup();
  const vars = one.editor.variables;
  const coll = vars.createCollection('Тема');
  const light = one.doc.get(coll, 'modes')[0]!.id;
  vars.renameMode(coll, light, 'Светлая');
  const dark = vars.addMode(coll, 'Тёмная');
  const grey = vars.createVariable(coll, 'COLOR', 'base/grey', { r: 0.5, g: 0.5, b: 0.5, a: 1 });
  const bg = vars.createVariable(coll, 'COLOR', 'surface/bg', { r: 1, g: 1, b: 1, a: 1 });
  vars.setValue(bg, dark, { type: 'ALIAS', id: grey, opacity: 0.5 });
  const space = vars.createVariable(coll, 'FLOAT', 'space/m', 16);
  vars.setDetails(space, { scopes: ['GAP'], codeSyntax: { WEB: '--space-m' }, description: 'Средний отступ' });
  one.editor.setSelection([]);
  const st = one.editor.createStyle('TEXT', undefined, 'Heading/H1');
  one.editor.updateStyle(st, { fontSize: 32, fontWeight: 700 });
  const json = exportTokens(one.doc) as Record<string, any>;
  assert.equal(json['Тема'].surface.bg.$type, 'color');
  assert.equal(json['Тема'].surface.bg.$value, '#FFFFFF');
  assert.equal(json['Тема'].surface.bg.$extensions['canvas-studio'].modes['Тёмная'], '{Тема.base.grey} @ 50%');
  assert.equal(json['Стили'].Heading.H1.$type, 'typography');

  const two = setup();
  const plan = planImport(two.editor, JSON.parse(JSON.stringify(json)));
  assert.ok(plan.changes.some((c) => c.kind === 'collection' && c.added));
  assert.equal(plan.changes.filter((c) => c.kind === 'variable').length, 3);
  assert.deepEqual(plan.warnings, []);
  plan.apply();
  const c2 = two.doc.collections()[0]!;
  assert.deepEqual(two.doc.get(c2, 'modes').map((m) => m.name), ['Светлая', 'Тёмная']);
  const bg2 = two.editor.variables.findByName('surface/bg', c2)!;
  const darkValue = two.doc.get(bg2, 'varValues')[two.doc.get(c2, 'modes')[1]!.id];
  assert.ok(darkValue && typeof darkValue === 'object' && 'type' in darkValue && darkValue.type === 'ALIAS' && darkValue.opacity === 0.5);
  const space2 = two.editor.variables.findByName('space/m', c2)!;
  assert.deepEqual(two.doc.get(space2, 'scopes'), ['GAP']);
  assert.equal(two.doc.get(space2, 'description'), 'Средний отступ');
  const h1 = two.doc.styles().find((s) => two.doc.get(s, 'name') === 'Heading/H1')!;
  assert.equal(two.doc.get(h1, 'fontSize'), 32);
  // Importing the same file again changes nothing new.
  const again = planImport(two.editor, json);
  assert.equal(again.changes.filter((c) => c.added).length, 0);
  // Plain DTCG from another tool (no extension): a group type and dimensions.
  const plain = planImport(two.editor, { Spacing: { $type: 'dimension', sm: { $value: '0.5rem' }, md: { $value: '{Spacing.sm}' } } });
  plain.apply();
  const c3 = two.doc.collections().find((c) => two.doc.get(c, 'name') === 'Spacing')!;
  const sm = two.editor.variables.findByName('sm', c3)!;
  const md = two.editor.variables.findByName('md', c3)!;
  assert.equal(Object.values(two.doc.get(sm, 'varValues'))[0], 8);
  assert.deepEqual(Object.values(two.doc.get(md, 'varValues'))[0], { type: 'ALIAS', id: sm });
});

test('variable expressions: arithmetic, colour functions, conditions, per mode, errors and cycles (FR-VAR-003)', async () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Токены');
  const base = doc.get(coll, 'modes')[0]!.id;
  const dense = vars.addMode(coll, 'Плотно');
  const space = vars.createVariable(coll, 'FLOAT', 'space/base', 8);
  vars.setValue(space, dense, 4);
  const isDense = vars.createVariable(coll, 'BOOLEAN', 'isDense', false);
  vars.setValue(isDense, dense, true);
  const brand = vars.createVariable(coll, 'COLOR', 'brand', { r: 0.2, g: 0.4, b: 0.8, a: 1 });
  const gap = vars.createVariable(coll, 'FLOAT', 'space/gap');
  // Typed as people write it: names, units, no "=" needed for a number.
  const twice = vars.parseInput('FLOAT', '{space.base} * 2 + 4px', coll);
  assert.ok(twice && typeof twice === 'object' && 'type' in twice && twice.type === 'EXPRESSION');
  assert.ok(vars.setValue(gap, base, twice!));
  assert.ok(vars.setValue(gap, dense, twice!));
  assert.equal(vars.formatValue(gap, base), '= {space/base} * 2 + 4px', 'shown with names, stored by id');
  assert.match((doc.get(gap, 'varValues')[base] as { expr: string }).expr, new RegExp(`\\{#${space}\\}`));
  assert.deepEqual(vars.valuesByMode(gap).map((x) => x.value), [20, 12], 'computed in each mode');
  const pad = vars.createVariable(coll, 'FLOAT', 'pad');
  vars.setValue(pad, base, vars.parseInput('FLOAT', '{isDense} ? 8 : 12', coll)!);
  vars.setValue(pad, dense, vars.parseInput('FLOAT', '{isDense} ? 8 : 12', coll)!);
  assert.deepEqual(vars.valuesByMode(pad).map((x) => x.value), [12, 8]);
  const hover = vars.createVariable(coll, 'COLOR', 'brand/hover');
  vars.setValue(hover, base, vars.parseInput('COLOR', 'lighten({brand}, 10%)', coll)!);
  const soft = vars.createVariable(coll, 'COLOR', 'brand/soft');
  vars.setValue(soft, base, vars.parseInput('COLOR', 'alpha({brand}, 0.4)', coll)!);
  const h = vars.valuesByMode(hover)[0]!.value as { r: number; g: number; b: number };
  assert.ok(h.b > 0.8 && h.r > 0.2, 'lighter');
  assert.equal((vars.valuesByMode(soft)[0]!.value as { a: number }).a, 0.4);
  // A string expression needs "=", otherwise it is text.
  const label = vars.createVariable(coll, 'STRING', 'label');
  vars.setValue(label, base, vars.parseInput('STRING', '{space.base} px', coll)!);
  assert.equal(doc.get(label, 'varValues')[base], '{space.base} px');
  vars.setValue(label, base, vars.parseInput('STRING', '= "Отступ " + {space.base}', coll)!);
  assert.equal(vars.valuesByMode(label)[0]!.value, 'Отступ 8');

  // On layers: bound to an expression, follows the mode and the referenced variable.
  const [frame, rect] = editor.commit('s', (tx) => {
    const f = tx.create('FRAME', page, { width: 200, height: 200 });
    const r = tx.create('RECTANGLE', f, { width: 50, height: 50 });
    return [f, r];
  });
  editor.setSelection([rect!]);
  vars.bind('cornerRadius', gap);
  vars.bind('fills/0', hover);
  assert.equal(doc.get(rect!, 'cornerRadius'), 20);
  vars.setMode([frame!], coll, dense);
  assert.equal(doc.get(rect!, 'cornerRadius'), 12);
  vars.setValue(space, dense, 10);
  assert.equal(doc.get(rect!, 'cornerRadius'), 24, 'a change of a referenced variable reaches the layer');
  assert.deepEqual(vars.usages(space).viaAlias.map((u) => u.id), [rect], 'usages through expressions');
  assert.deepEqual(vars.dependsOn(gap), [space]);

  // Errors: unknown names and wrong syntax are refused when typed; a wrong result shows in the cell.
  assert.equal(vars.parseInput('FLOAT', '{nope} * 2', coll), null);
  assert.match(vars.parseError, /nope/);
  assert.equal(vars.parseInput('FLOAT', '{space.base} * ', coll), null);
  const wrong = vars.createVariable(coll, 'FLOAT', 'wrong');
  vars.setValue(wrong, base, vars.parseInput('FLOAT', '= {brand}', coll)!);
  assert.match(vars.valuesByMode(wrong)[0]!.error ?? '', /цвет/);
  // Cycles are refused.
  assert.equal(vars.setValue(space, base, vars.parseInput('FLOAT', '{space.gap} + 1', coll)!), false);
  // Deleting a referenced variable leaves an error, the layer keeps its last value.
  vars.deleteVariables([space]);
  assert.ok(vars.valuesByMode(gap)[0]!.error);
  assert.equal(doc.get(rect!, 'cornerRadius'), 24);
  editor.undo();
  assert.equal(vars.valuesByMode(gap)[0]!.value, 20);

  // Tokens: the expression travels with names and comes back with ids; $value is the result.
  const { exportTokens, planImport } = await import('../src/tokens.ts');
  const json = exportTokens(doc) as Record<string, any>;
  assert.equal(json['Токены'].space.gap.$value, 20);
  assert.equal(json['Токены'].space.gap.$extensions['canvas-studio'].modes['Режим 1'], '= {Токены.space.base} * 2 + 4px');
  const two = setup();
  planImport(two.editor, JSON.parse(JSON.stringify(json))).apply();
  const c2 = two.doc.collections()[0]!;
  const gap2 = two.editor.variables.findByName('space/gap', c2)!;
  assert.deepEqual(two.editor.variables.valuesByMode(gap2).map((x) => x.value), [20, 24]);
  assert.equal(two.editor.variables.formatValue(gap2, two.doc.get(c2, 'modes')[0]!.id), '= {space/base} * 2 + 4px');
});

test('extended collections: inherit every variable, override some, chosen like a mode (FR-VAR-013)', async () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const brand = vars.createCollection('Бренд');
  const light = doc.get(brand, 'modes')[0]!.id;
  const dark = vars.addMode(brand, 'Тёмная');
  const primary = vars.createVariable(brand, 'COLOR', 'primary', { r: 0, g: 0, b: 1, a: 1 });
  vars.setValue(primary, dark, { r: 0, g: 0, b: 0.5, a: 1 });
  const radius = vars.createVariable(brand, 'FLOAT', 'radius', 8);
  const pressed = vars.createVariable(brand, 'COLOR', 'primary/pressed');
  vars.setValue(pressed, light, vars.parseInput('COLOR', 'darken({primary}, 10%)', brand)!);
  const b = vars.createExtension(brand, 'Бренд Б');
  assert.deepEqual(doc.get(b, 'modes'), doc.get(brand, 'modes'), 'the parent\'s modes');
  assert.deepEqual(vars.variablesOf(b), [primary, radius, pressed], 'every variable of the parent');
  // Own value in one mode; the rest is inherited.
  assert.ok(vars.setValue(primary, light, { r: 1, g: 0, b: 0, a: 1 }, b));
  assert.deepEqual(doc.get(primary, 'varValues')[light], { r: 0, g: 0, b: 1, a: 1 }, 'the parent is untouched');
  const seen = vars.valuesByMode(primary, b);
  assert.deepEqual(seen.map((x) => x.own), [true, false]);
  assert.deepEqual(seen[1]!.value, { r: 0, g: 0, b: 0.5, a: 1 });
  // Expressions follow the extension's values.
  const p = vars.valuesByMode(pressed, b)[0]!.value as { r: number; b: number };
  assert.ok(p.r > 0.7 && p.b === 0, 'darken of the extension\'s red');
  // A new variable of the parent appears in the extension by itself.
  const fresh = vars.createVariable(brand, 'FLOAT', 'gap', 16);
  assert.ok(vars.variablesOf(b).includes(fresh));
  // A new mode of the parent appears too.
  const hc = vars.addMode(brand, 'Контраст');
  assert.deepEqual(doc.get(b, 'modes').map((m) => m.id), [light, dark, hc]);

  // On layers: a frame chooses the extension like a mode.
  const [frame, rect] = editor.commit('s', (tx) => {
    const f = tx.create('FRAME', page, { width: 200, height: 200 });
    const r = tx.create('RECTANGLE', f, { width: 50, height: 50 });
    return [f, r];
  });
  editor.setSelection([rect!]);
  vars.bind('fills/0', primary);
  const fillOf = () => {
    const f = doc.get(rect!, 'fills')[0]!;
    return f.type === 'SOLID' ? f.color : null;
  };
  assert.deepEqual(fillOf(), { r: 0, g: 0, b: 1, a: 1 });
  vars.setMode([frame!], b, light);
  assert.deepEqual(fillOf(), { r: 1, g: 0, b: 0, a: 1 }, 'the extension\'s own value');
  assert.deepEqual(vars.explicitChoice(frame!, brand), { scope: b, mode: light });
  vars.setMode([frame!], b, dark);
  assert.deepEqual(fillOf(), { r: 0, g: 0, b: 0.5, a: 1 }, 'inherited in the dark mode');
  // Choosing the parent replaces the extension on the same layer.
  vars.setMode([frame!], brand, light);
  assert.deepEqual(doc.get(frame!, 'variableModes'), { [brand]: light });
  assert.deepEqual(fillOf(), { r: 0, g: 0, b: 1, a: 1 });
  // A nested frame can switch back to the extension.
  vars.setMode([frame!], b, light);
  // Changing the override reaches the layer; resetting brings back the parent's.
  vars.setValue(primary, light, { r: 0, g: 1, b: 0, a: 1 }, b);
  assert.deepEqual(fillOf(), { r: 0, g: 1, b: 0, a: 1 });
  vars.resetOverride(b, [primary], light);
  assert.deepEqual(fillOf(), { r: 0, g: 0, b: 1, a: 1 });
  editor.undo();
  assert.deepEqual(fillOf(), { r: 0, g: 1, b: 0, a: 1 });
  // An extension of an extension.
  const c = vars.createExtension(b, 'Бренд В');
  vars.setValue(radius, light, 2, c);
  assert.equal(vars.valuesByMode(radius, c)[0]!.value, 2);
  assert.deepEqual(vars.valuesByMode(primary, c)[0]!.value, { r: 0, g: 1, b: 0, a: 1 }, 'through the middle one');
  // Pasting into an extension writes its own values.
  assert.equal(vars.pasteTable(b, radius, 0, '24'), 1);
  assert.equal(vars.valuesByMode(radius, b)[0]!.value, 24);
  assert.equal(doc.get(radius, 'varValues')[light], 8);

  // Tokens round trip: the extension holds only its own values.
  const { exportTokens, planImport } = await import('../src/tokens.ts');
  const json = exportTokens(doc) as Record<string, any>;
  assert.equal(json['Бренд Б'].$extensions['canvas-studio'].extends, 'Бренд');
  assert.ok(json['Бренд Б'].primary && json['Бренд Б'].radius && !json['Бренд Б'].gap);
  const two = setup();
  const plan = planImport(two.editor, JSON.parse(JSON.stringify(json)));
  assert.deepEqual(plan.warnings, []);
  plan.apply();
  const d2 = two.doc;
  const brand2 = d2.collections().find((x) => d2.get(x, 'name') === 'Бренд')!;
  const b2 = d2.collections().find((x) => d2.get(x, 'name') === 'Бренд Б')!;
  assert.equal(d2.get(b2, 'extendsCollection'), brand2);
  const radius2 = two.editor.variables.findByName('radius', brand2)!;
  assert.equal(two.editor.variables.valuesByMode(radius2, b2)[0]!.value, 24);
  assert.equal(two.editor.variables.valuesByMode(radius2)[0]!.value, 8);

  // Deleting the parent removes its extensions.
  vars.deleteCollection(brand);
  assert.equal(doc.collections().length, 0);
});

test('styles become variables with a preview, keeping every style link (FR-STY-003)', async () => {
  const { planStylesToVariables, convertStylesToVariables } = await import('../src/styles-to-variables.ts');
  const { editor, doc, page } = setup();
  editor.setSelection([]);
  const brand = editor.createStyle('FILL', undefined, 'Brand/Primary');
  editor.commit('fill', (tx) => tx.set(brand, 'fills', [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }]));
  const grad = editor.createStyle('FILL', undefined, 'Brand/Gradient');
  editor.commit('grad', (tx) => tx.set(grad, 'fills', [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }], transform: [[1, 0, 0], [0, 1, 0]], opacity: 1, visible: true } as never]));
  const h1 = editor.createStyle('TEXT', undefined, 'Heading/H1');
  editor.updateStyle(h1, { fontSize: 32, fontWeight: 700, lineHeight: { unit: 'PX', value: 40 } });
  const shadow = editor.createStyle('EFFECT', undefined, 'Shadow/M');
  editor.commit('fx', (tx) => tx.set(shadow, 'effects', [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true }]));
  const [rect, text] = editor.commit('s', (tx) => [tx.create('RECTANGLE', page, { width: 50, height: 50 }), tx.create('TEXT', page, { characters: 'Заголовок' })]);
  editor.setSelection([rect!]);
  editor.applyStyle('fillStyleId', brand);
  editor.applyStyle('effectStyleId', shadow);
  editor.setSelection([text!]);
  editor.applyStyle('textStyleId', h1);

  const plan = planStylesToVariables(doc);
  const byStyle = new Map(plan.map((p) => [p.styleName, p]));
  assert.deepEqual(byStyle.get('Brand/Primary')!.variables.map((v) => v.name), ['Brand/Primary']);
  assert.equal(byStyle.get('Brand/Gradient')!.variables.length, 0);
  assert.match(byStyle.get('Brand/Gradient')!.kept[0]!, /Градиент/);
  assert.deepEqual(byStyle.get('Heading/H1')!.variables.map((v) => [v.name, v.value]), [
    ['Heading/H1/font-family', doc.get(h1, 'fontFamily')],
    ['Heading/H1/font-size', 32],
    ['Heading/H1/font-weight', 700],
    ['Heading/H1/line-height', 40],
    ['Heading/H1/letter-spacing', 0],
  ]);
  assert.deepEqual(byStyle.get('Shadow/M')!.variables.map((v) => v.name.split('/').pop()), ['color', 'x', 'y', 'blur', 'spread']);

  const before = { fill: doc.get(rect!, 'fills'), effects: doc.get(rect!, 'effects'), size: doc.get(text!, 'fontSize') };
  const r = convertStylesToVariables(editor, plan, 'Стили');
  assert.equal(r.created, 11);
  // Nothing visible changed; every layer keeps its style.
  assert.deepEqual(doc.get(rect!, 'fills'), before.fill);
  assert.deepEqual(doc.get(rect!, 'effects'), before.effects);
  assert.equal(doc.get(text!, 'fontSize'), before.size);
  assert.equal(doc.get(rect!, 'fillStyleId'), brand);
  assert.equal(doc.get(rect!, 'effectStyleId'), shadow);
  assert.equal(doc.get(text!, 'textStyleId'), h1);
  // The style's values now come from the variables, and reach the layers.
  const vars = editor.variables;
  const size = vars.findByName('Heading/H1/font-size', r.collection)!;
  const blur = vars.findByName('Shadow/M/blur', r.collection)!;
  const dark = vars.addMode(r.collection, 'Крупно');
  vars.setValue(size, dark, 40);
  vars.setValue(blur, doc.get(r.collection, 'modes')[0]!.id, 20);
  assert.equal((doc.get(rect!, 'effects')[0] as { radius: number }).radius, 20, 'a shadow number from a variable');
  assert.equal(doc.get(rect!, 'effectStyleId'), shadow, 'still the style');
  vars.setMode([text!], r.collection, dark);
  assert.equal(doc.get(text!, 'fontSize'), 40, 'the text follows the mode through its style');
  assert.equal(doc.get(text!, 'textStyleId'), h1);
  // A second run creates nothing new: the fields are already variables.
  assert.equal(planStylesToVariables(doc).reduce((n, p) => n + p.variables.length, 0), 0);
  // Undo of the mode, two values, the new mode, then the conversion itself (one step).
  for (let i = 0; i < 4; i++) editor.undo();
  assert.notEqual(doc.get(h1, 'boundVariables'), null);
  editor.undo();
  assert.equal(doc.get(h1, 'boundVariables'), null);
  assert.equal(doc.collections().length, 0);
});

test('variables as code: every language, modes and extensions, name templates (FR-VAR-041)', async () => {
  const { defaultTokenOptions, tokenName, tokensToCode, TOKEN_FORMATS } = await import('../src/token-code.ts');
  const { editor, doc } = setup();
  const v = editor.variables;
  const c = v.createCollection('Тема');
  const light = doc.get(c, 'modes')[0]!.id;
  v.renameMode(c, light, 'Светлая');
  const dark = v.addMode(c, 'Тёмная');
  const bg = v.createVariable(c, 'COLOR', 'цвет/фон', { r: 1, g: 1, b: 1, a: 1 });
  v.setValue(bg, dark, { r: 0, g: 0, b: 0, a: 1 });
  const accent = v.createVariable(c, 'COLOR', 'color/accent', { r: 0, g: 0, b: 1, a: 1 });
  v.createVariable(c, 'COLOR', 'color/link', { type: 'ALIAS', id: accent });
  const space = v.createVariable(c, 'FLOAT', 'space/m', 16);
  const radius = v.createVariable(c, 'FLOAT', 'radius/card');
  v.setValue(radius, light, v.parseInput('FLOAT', '{space/m} / 2', c)!);
  v.setValue(radius, dark, v.parseInput('FLOAT', '{space/m} / 2', c)!);
  v.createVariable(c, 'FLOAT', 'opacity/muted', 60);
  const ext = v.createExtension(c, 'Бренд Б');
  v.setValue(accent, light, { r: 1, g: 0, b: 0, a: 1 }, ext);
  void space;

  // Names by template and case; Latin when asked.
  const o = defaultTokenOptions('css');
  assert.equal(tokenName(o, 'Тема', 'цвет/фон'), 'цвет-фон');
  assert.equal(tokenName({ ...o, latin: true, nameCase: 'constant', template: '{collection}_{path}' }, 'Тема', 'цвет/фон'), 'TEMA_TSVET_FON');
  assert.equal(tokenName({ ...o, nameCase: 'camel', template: '{name}' }, 'Тема', 'Color/Brand Primary'), 'brandPrimary');
  assert.equal(tokenName({ ...o, nameCase: 'camel' }, 'Тема', '2xl/size'), '_2xlSize');

  const code = (f: Parameters<typeof defaultTokenOptions>[0]) => tokensToCode(doc, defaultTokenOptions(f)).text;
  const css = code('css');
  assert.match(css, /:root \{[^}]*--цвет-фон: #FFFFFF;[^}]*--color-link: var\(--color-accent\);[^}]*--space-m: 16px;[^}]*--radius-card: 8px;[^}]*--opacity-muted: 60;/s);
  assert.match(css, /\[data-tema="temnaya"\] \{\n  --цвет-фон: #000000;\n\}/);
  assert.match(css, /\[data-tema-extension="brend-b"\] \{\n  --color-accent: #FF0000;\n\}/);
  // In the dark mode the extension does not override: the parent's value comes back over the light override.
  assert.match(css, /\[data-tema-extension="brend-b"\]\[data-tema="temnaya"\] \{\n  --color-accent: #0000FF;\n\}/);
  assert.match(code('scss'), /\$color-link: \$color-accent;[\s\S]*\$tema-modes: \([\s\S]*brend-b-svetlaya: \([\s\S]*color-accent: #FF0000,/);
  const js = code('js');
  assert.match(js, /export const tema = \{\n  svetlaya: \{\n    tsvetFon: "#FFFFFF",/);
  assert.match(js, /brendBSvetlaya: \{[\s\S]*colorAccent: "#FF0000"/);
  assert.match(code('ts'), /\} as const;\nexport type TemaTokens/);
  const tw = code('tailwind');
  assert.match(tw, /colors: \{\n        "tsvet-fon": "var\(--цвет-фон\)",/, 'Tailwind points at the CSS file\'s variables');
  assert.match(tw, /spacing: \{\n        "space-m": "var\(--space-m\)",/);
  assert.match(tw, /borderRadius: \{\n        "radius-card"/);
  assert.match(tw, /opacity: \{/);
  const swift = code('swift');
  assert.match(swift, /public struct TemaTokens \{\n    public let tsvetFon: Color/);
  assert.match(swift, /static let temnaya = TemaTokens\(\n        tsvetFon: Color\(red: 0, green: 0, blue: 0, opacity: 1\),/);
  const kt = code('kotlin');
  assert.match(kt, /data class TemaTokens\(\n    val tsvetFon: Color,/);
  assert.match(kt, /spaceM = 16\.dp,/);
  assert.match(kt, /opacityMuted = 60f,/);
  assert.match(kt, /val BrendBSvetlayaTemaTokens = TemaTokens\([\s\S]*colorAccent = Color\(0xFFFF0000\),/);
  const xml = code('android');
  assert.ok(xml.startsWith('<?xml'), 'the declaration first');
  assert.match(xml, /src\/main\/res\/values\/tokens\.xml[\s\S]*<color name="tsvet_fon">#FFFFFFFF<\/color>/);
  assert.match(xml, /src\/main\/res\/values-night\/tokens\.xml[\s\S]*<color name="tsvet_fon">#FF000000<\/color>/);
  assert.match(xml, /src\/brendB\/res\/values\/tokens\.xml/);
  assert.match(xml, /<item name="opacity_muted" format="float" type="dimen">60<\/item>/);
  // Every language writes something, and a name set in "names in code" wins.
  for (const f of TOKEN_FORMATS) assert.ok(code(f.id).length > 0, f.id);
  v.setDetails(bg, { codeSyntax: { WEB: 'var(--surface)', IOS: 'Color.surface', ANDROID: 'R.color.surface' } });
  assert.match(code('css'), /--surface: #FFFFFF;/);
  assert.match(code('swift'), /public let surface: Color/);
  assert.match(code('android'), /<color name="surface">/);
});

test('precision: guides on page and frames, layout grids, grid styles and variables, eyedropper', () => {
  const { editor, doc, page } = setup();
  const frame = editor.commit('f', (tx) => tx.create('FRAME', page, { x: 100, y: 50, width: 400, height: 300 }));
  // Page guide at world x = 30; a frame guide is stored relative to the frame and moves with it.
  editor.addGuide(page, 'X', 30);
  editor.setSelection([frame]);
  const owner = editor.guideOwnerAt({ x: 150, y: 100 });
  assert.equal(owner, frame, 'a guide dropped on the selected frame belongs to it');
  editor.addGuide(owner, 'Y', 80);
  assert.deepEqual(doc.get(frame, 'guides'), [{ axis: 'Y', offset: 30 }]);
  editor.commit('move', (tx) => tx.set(frame, 'y', 150));
  assert.ok(editor.worldGuides().some((g) => g.owner === frame && g.at === 180), JSON.stringify(editor.worldGuides()));
  editor.setGuideOffset(frame, 0, 40);
  assert.equal(doc.get(frame, 'guides')[0]!.offset, 40);
  editor.removeGuide(page, 0);
  assert.deepEqual(doc.get(page, 'guides'), []);
  // Layout grids: add, style, bind a variable to the column count.
  editor.addLayoutGrid('COLUMNS');
  assert.equal(doc.get(frame, 'layoutGrids').length, 1);
  const gridStyle = editor.createStyle('GRID', 'gridStyleId', 'Desktop/12');
  editor.updateStyle(gridStyle, { layoutGrids: [{ ...doc.get(gridStyle, 'layoutGrids')[0]!, count: 12 } as never] });
  const g0 = doc.get(frame, 'layoutGrids')[0]!;
  assert.ok(g0.pattern === 'COLUMNS' && g0.count === 12, 'the frame follows its grid style');
  const coll = editor.variables.createCollection('Сетки');
  const mobile = editor.variables.addMode(coll, 'Телефон');
  const cols = editor.variables.createVariable(coll, 'FLOAT', 'columns', 12);
  editor.variables.setValue(cols, mobile, 4);
  editor.applyStyle('gridStyleId', null);
  editor.variables.bind('layoutGrids/0/count', cols);
  editor.variables.setMode([frame], coll, mobile);
  const g1 = doc.get(frame, 'layoutGrids')[0]!;
  assert.ok(g1.pattern === 'COLUMNS' && g1.count === 4, 'the column count comes from the variable in the frame mode');
  // Eyedropper: the colour becomes the selection's first solid fill.
  editor.applyPickedColor({ r: 1, g: 0, b: 0, a: 1 });
  const fill = doc.get(frame, 'fills')[0]!;
  assert.ok(fill.type === 'SOLID' && fill.color.r === 1 && fill.color.g === 0);
  assert.equal(editor.tool, 'select');
});

test('equal spacing and tidy up (FR-DRW-091, 092)', () => {
  const { editor, doc, page } = setup();
  const ids = editor.commit('s', (tx) => [
    tx.create('RECTANGLE', page, { x: 0, y: 0, width: 50, height: 50 }),
    tx.create('RECTANGLE', page, { x: 70, y: 0, width: 50, height: 50 }),
    tx.create('RECTANGLE', page, { x: 140, y: 0, width: 50, height: 50 }),
  ]);
  editor.setSelection(ids);
  const eq = editor.equalSpacing()!;
  assert.equal(eq.axis, 'x');
  assert.equal(eq.gap, 20);
  editor.commit('gap', (tx) => editor.setEqualSpacing(tx, eq.axis, eq.ids, eq.boxes, 40));
  assert.deepEqual(ids.map((id) => doc.get(id, 'x')), [0, 90, 180]);
  // A messy 2×2 becomes a tidy grid with the median gap.
  const m = editor.commit('m', (tx) => [
    tx.create('RECTANGLE', page, { x: 0, y: 300, width: 40, height: 40 }),
    tx.create('RECTANGLE', page, { x: 63, y: 305, width: 40, height: 40 }),
    tx.create('RECTANGLE', page, { x: 4, y: 362, width: 40, height: 40 }),
    tx.create('RECTANGLE', page, { x: 58, y: 358, width: 40, height: 40 }),
  ]);
  editor.setSelection(m);
  editor.tidyUp();
  const pos = m.map((id) => [doc.get(id, 'x'), doc.get(id, 'y')]);
  assert.deepEqual(pos[0], [0, 300]);
  assert.equal(pos[1]![1], 300, 'same row, same top');
  assert.equal(pos[2]![0], 0, 'same column, same left');
  assert.equal(pos[1]![0], pos[3]![0], 'columns line up');
});

test('sections: placement rules, wrapping, selection inside, adopting, ungroup (FEAT-030)', () => {
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('FRAME', page, { x: 100, y: 100, width: 200, height: 100 });
    const inner = tx.create('RECTANGLE', a, { x: 10, y: 10, width: 20, height: 20 });
    const b = tx.create('RECTANGLE', page, { x: 400, y: 120, width: 50, height: 50 });
    const far = tx.create('RECTANGLE', page, { x: 2000, y: 2000, width: 10, height: 10 });
    return { a, inner, b, far };
  });
  // Sections live on the page or in sections, never inside frames, groups or components.
  assert.equal(canContain('FRAME', 'SECTION'), false);
  assert.equal(canContain('GROUP', 'SECTION'), false);
  assert.equal(canContain('COMPONENT', 'SECTION'), false);
  assert.equal(canContain('SECTION', 'SECTION'), true);
  assert.equal(canContain('SECTION', 'FRAME'), true);

  editor.setSelection([ids.a, ids.b]);
  const section = editor.sectionSelection()!;
  assert.equal(doc.type(section), 'SECTION');
  assert.deepEqual(doc.children(section), [ids.a, ids.b]);
  assert.deepEqual(editor.scene.bounds(ids.b), { x: 400, y: 120, width: 50, height: 50 }, 'wrapped layers stay in place');
  const sb = editor.scene.bounds(section);
  assert.ok(sb.x < 100 && sb.y < 100 && sb.x + sb.width > 450 && sb.y + sb.height > 170, 'the section leaves a margin');
  assert.equal(doc.get(section, 'clipsContent'), false);
  assert.equal(doc.get(section, 'devStatus'), 'NONE');
  editor.commit('status', (tx) => tx.set(section, 'devStatus', 'READY_FOR_DEV'));
  assert.equal(doc.get(section, 'devStatus'), 'READY_FOR_DEV');

  // Inside a section layers behave as on the page: a frame there is an artboard, its layers are clicked directly.
  editor.setSelection([]);
  assert.equal(editor.isArtboard(ids.a), true);
  assert.equal(editor.selectableFor(ids.inner, false), ids.inner);
  assert.equal(editor.selectableFor(ids.b, false), ids.b);
  // A click on the empty body of a section takes the section, as in Figma (BUG-103); what is inside comes first.
  assert.deepEqual(editor.pickable([ids.b, section]), [ids.b, section]);
  assert.equal(editor.selectableFor(section, false), section);
  assert.equal(editor.sectionAt({ x: sb.x + 5, y: sb.y + 5 }), section);
  assert.equal(editor.sectionAt({ x: 1500, y: 1500 }), page);

  // A section is never dropped into a frame, but frames accept other layers.
  assert.equal(editor.containerAt({ x: 150, y: 150 }, [ids.far]), ids.a);
  const other = editor.commit('s2', (tx) => tx.create('SECTION', page, { x: 1900, y: 1900, width: 50, height: 50 }));
  assert.notEqual(editor.containerAt({ x: 150, y: 150 }, [other]), ids.a);

  // Growing a section takes in what it now encloses; what falls outside leaves it.
  editor.commit('resize', (tx) => { tx.update(other, { x: 1950, y: 1950, width: 100, height: 100 }); });
  editor.commit('adopt', (tx) => editor.adoptIntoSection(tx, other));
  assert.equal(doc.parent(ids.far), other);
  assert.deepEqual(editor.scene.bounds(ids.far), { x: 2000, y: 2000, width: 10, height: 10 });
  editor.commit('resize', (tx) => { tx.update(other, { width: 20, height: 20 }); });
  editor.commit('adopt', (tx) => editor.adoptIntoSection(tx, other));
  assert.equal(doc.parent(ids.far), page);

  // Paste of a section into a selected frame lands next to it instead.
  editor.setSelection([other]);
  editor.copy();
  editor.setSelection([ids.a]);
  editor.pasteText(null);
  const pasted = editor.selection[0]!;
  assert.equal(doc.type(pasted), 'SECTION');
  assert.equal(doc.parent(pasted), section);

  // Sections are not grouped; "ungroup" removes the section and keeps its content.
  editor.setSelection([section]);
  editor.group();
  assert.equal(doc.parent(section), page);
  editor.ungroup();
  assert.equal(doc.store.isAlive(section), false);
  assert.equal(doc.parent(ids.a), page);
  assert.deepEqual(editor.scene.bounds(ids.b), { x: 400, y: 120, width: 50, height: 50 });
});

test('prototype: screens, connections, flows and a playback session (FR-PRT-001–003, 010)', async () => {
  const { editor, doc, page } = setup();
  const { connections, flows, interactiveLayers, isScreen, PrototypeSession, reachable, safeUrl, screens } = await import('../src/prototype/model.ts');
  const ids = editor.commit('setup', (tx) => {
    const home = tx.create('FRAME', page, { name: 'Home', width: 375, height: 800 });
    const button = tx.create('RECTANGLE', home, { x: 20, y: 700, width: 100, height: 40 });
    const label = tx.create('TEXT', home, { x: 30, y: 710, characters: 'Далее' });
    const section = tx.create('SECTION', page, { x: 500, y: 0, width: 900, height: 900 });
    const details = tx.create('FRAME', section, { name: 'Details', x: 20, y: 40, width: 375, height: 800 });
    const back = tx.create('RECTANGLE', details, { width: 40, height: 40 });
    const nested = tx.create('FRAME', details, { width: 10, height: 10 });
    return { home, button, label, section, details, back, nested };
  });
  assert.deepEqual(screens(doc, page), [ids.home, ids.details], 'top-level frames, also inside sections');
  assert.equal(isScreen(doc, ids.nested), false);

  editor.prototype.connect(ids.button, ids.details);
  assert.equal(connections(doc, page).length, 1);
  assert.deepEqual(flows(doc, page).map((f) => f.nodeId), [ids.home], 'the first connection starts a flow');
  editor.prototype.connect(ids.button, ids.home);
  assert.deepEqual(connections(doc, page).map((c) => c.destination), [ids.details], 'a layer cannot lead to its own screen');
  editor.prototype.connect(ids.button, ids.details);
  editor.prototype.connect(ids.button, ids.details);
  assert.equal(doc.get(ids.button, 'reactions').length, 1, 'dragging the handle again retargets, not duplicates');
  editor.commit('back', (tx) => tx.set(ids.back, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]));
  assert.deepEqual(reachable(doc, ids.home), [ids.home, ids.details]);
  assert.deepEqual(interactiveLayers(doc, ids.home), [ids.button]);

  const session = new PrototypeSession(doc, ids.home);
  assert.equal(session.fire(ids.label, 'ON_CLICK'), null, 'the label is not inside the button');
  const effects = session.fire(ids.button, 'ON_CLICK')!;
  assert.equal(effects[0]!.type, 'navigate');
  assert.equal(session.current, ids.details);
  session.fire(ids.back, 'ON_CLICK');
  assert.equal(session.current, ids.home);
  assert.equal(session.canGoBack, false);

  // Flows: add, rename, remove.
  editor.prototype.addFlow(ids.details);
  editor.prototype.updateFlow(ids.details, { name: 'Детали', description: 'Карточка' });
  assert.deepEqual(flows(doc, page).map((f) => f.name), ['Поток 1', 'Детали']);
  editor.prototype.removeFlow(ids.home);
  assert.deepEqual(flows(doc, page).map((f) => f.nodeId), [ids.details]);
  // Deleted screens drop out of flows and connections.
  editor.commit('del', (tx) => tx.delete(ids.details));
  assert.equal(flows(doc, page).length, 0);
  assert.equal(connections(doc, page).length, 0);

  assert.equal(safeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
});

test('prototype transitions: curves, springs, reverse, smart animate (FR-PRT-020, 021)', async () => {
  const { cubicBezier, BEZIER_PRESETS, easingFunction, reverseTransition, springAt, springDuration, SPRING_PRESETS } = await import('../src/prototype/easing.ts');
  const { applySmartAnimate, layerKeys, planSmartAnimate } = await import('../src/prototype/smart.ts');
  const { PrototypeSession } = await import('../src/prototype/model.ts');
  const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
  // Bézier: endpoints, linear identity, ease-in-out symmetry, known CSS value.
  const linear = cubicBezier(BEZIER_PRESETS.LINEAR);
  near(linear(0.37), 0.37);
  const inOut = cubicBezier(BEZIER_PRESETS.EASE_IN_OUT);
  near(inOut(0.5), 0.5);
  near(inOut(0.25) + inOut(0.75), 1);
  near(cubicBezier([0.25, 0.1, 0.25, 1])(0.5), 0.8024, 2e-3);
  assert.ok(cubicBezier(BEZIER_PRESETS.EASE_OUT_BACK)(0.7) > 1, 'out-back overshoots');
  // Springs settle at 1; bouncy overshoots, an overdamped one does not.
  near(springAt(SPRING_PRESETS.GENTLE, 5), 1);
  let peak = 0;
  for (let t = 0; t < 1; t += 0.005) peak = Math.max(peak, springAt(SPRING_PRESETS.BOUNCY, t));
  assert.ok(peak > 1.1, 'bouncy overshoots');
  for (let t = 0; t < 2; t += 0.01) assert.ok(springAt({ mass: 1, stiffness: 100, damping: 40 }, t) <= 1 + 1e-9);
  const quick = springDuration(SPRING_PRESETS.QUICK);
  assert.ok(quick > 100 && quick < 1500, String(quick));
  assert.ok(springDuration(SPRING_PRESETS.SLOW) > quick);
  assert.equal(easingFunction({ type: 'EASE_IN' }, 50000).duration, 10000, 'duration is clamped to 10 s');
  assert.deepEqual(reverseTransition({ type: 'MOVE_IN', direction: 'LEFT', duration: 300, easing: { type: 'LINEAR' } }), { type: 'MOVE_OUT', direction: 'RIGHT', duration: 300, easing: { type: 'LINEAR' } });

  // Smart animate: match by name path, morph, fade, and restore exactly at the end.
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('FRAME', page, { name: 'A', width: 300, height: 600 });
    const cardA = tx.create('FRAME', a, { name: 'Card', x: 10, y: 10, width: 100, height: 100, cornerRadius: 0, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] });
    const titleA = tx.create('TEXT', cardA, { name: 'Title', characters: 'A' });
    const gone = tx.create('RECTANGLE', a, { name: 'Old', width: 10, height: 10 });
    const b = tx.create('FRAME', page, { name: 'B', x: 400, width: 300, height: 600 });
    const cardB = tx.create('FRAME', b, { name: 'Card', x: 10, y: 210, width: 280, height: 300, cornerRadius: 20, rotation: 10, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }] });
    const titleB = tx.create('TEXT', cardB, { name: 'Title', characters: 'B' });
    const fresh = tx.create('RECTANGLE', b, { name: 'New', width: 10, height: 10, opacity: 0.8 });
    return { a, cardA, titleA, gone, b, cardB, titleB, fresh };
  });
  assert.deepEqual([...layerKeys(doc, ids.a).keys()], ['/Card', '/Card/Title', '/Old']);
  const plan = planSmartAnimate(doc, ids.a, ids.b);
  assert.deepEqual(plan.matched.map((m) => [m.id, m.source]), [[ids.cardB, ids.cardA], [ids.titleB, ids.titleA]]);
  assert.deepEqual(plan.fadeIn.map((f) => f.id), [ids.fresh]);
  assert.deepEqual(plan.fadeOut, [ids.gone]);
  const undoBefore = doc.canUndo();
  applySmartAnimate(doc, plan, 0);
  assert.deepEqual([doc.get(ids.cardB, 'y'), doc.get(ids.cardB, 'width'), doc.get(ids.fresh, 'opacity')], [10, 100, 0]);
  applySmartAnimate(doc, plan, 0.5);
  assert.deepEqual([doc.get(ids.cardB, 'y'), doc.get(ids.cardB, 'width'), doc.get(ids.cardB, 'cornerRadius'), doc.get(ids.cardB, 'rotation')], [110, 190, 10, 5]);
  const mid = doc.get(ids.cardB, 'fills')[0]!;
  assert.ok(mid.type === 'SOLID' && Math.abs(mid.color.r - 0.5) < 1e-9 && Math.abs(mid.color.b - 0.5) < 1e-9);
  applySmartAnimate(doc, plan, 1);
  assert.deepEqual([doc.get(ids.cardB, 'y'), doc.get(ids.cardB, 'width'), doc.get(ids.cardB, 'rotation'), doc.get(ids.fresh, 'opacity')], [210, 280, 10, 0.8]);
  assert.equal(doc.canUndo(), undoBefore, 'playing leaves no undo steps');

  // "Back" plays the transition reversed.
  editor.commit('link', (tx) => tx.set(ids.cardA, 'reactions', [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: ids.b, transition: { type: 'PUSH', direction: 'TOP', duration: 200, easing: { type: 'EASE_OUT' } } }] }]));
  const session = new PrototypeSession(doc, ids.a);
  session.fire(ids.cardA, 'ON_CLICK');
  const back = session.back()!;
  assert.ok(back.type === 'navigate' && back.transition?.type === 'PUSH' && back.transition.direction === 'BOTTOM');
});

test('prototype overlays, scrolling and "Change to" (FR-PRT-010, 011, 030–032)', async () => {
  const { DEFAULT_OVERLAY, PrototypeSession, variantChoices } = await import('../src/prototype/model.ts');
  const { ScrollState } = await import('../src/prototype/scroll.ts');
  const { planFromSnapshot, snapshotLayers } = await import('../src/prototype/smart.ts');
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const home = tx.create('FRAME', page, { name: 'Home', width: 300, height: 400, overflowDirection: 'VERTICAL' });
    const header = tx.create('RECTANGLE', home, { name: 'Header', width: 300, height: 50, scrollBehavior: 'FIXED' });
    const tabs = tx.create('RECTANGLE', home, { name: 'Tabs', y: 100, width: 300, height: 40, scrollBehavior: 'STICKY' });
    const list = tx.create('FRAME', home, { name: 'List', y: 150, width: 300, height: 200, overflowDirection: 'VERTICAL' });
    const items = [0, 1, 2, 3, 4, 5].map((i) => tx.create('RECTANGLE', list, { name: `Item ${i}`, y: i * 100, width: 300, height: 90 }));
    const footer = tx.create('RECTANGLE', home, { name: 'Footer', y: 900, width: 300, height: 100 });
    const menuBtn = tx.create('RECTANGLE', home, { name: 'Menu', width: 40, height: 40 });
    const menu = tx.create('FRAME', page, { name: 'Menu sheet', x: 400, width: 200, height: 300 });
    const sheetClose = tx.create('RECTANGLE', menu, { name: 'Close', width: 20, height: 20 });
    const other = tx.create('FRAME', page, { name: 'Other', x: 700, width: 300, height: 400 });
    return { home, header, tabs, list, items, footer, menuBtn, menu, sheetClose, other };
  });

  // Overlays: open, Back closes the overlay first, navigating from an overlay closes it.
  const s = new PrototypeSession(doc, ids.home);
  const open = s.run([{ type: 'OPEN_OVERLAY', destinationId: ids.menu, transition: null, overlay: DEFAULT_OVERLAY }], ids.menuBtn);
  assert.equal(open[0]!.type, 'overlay-open');
  assert.equal(s.top, ids.menu);
  assert.equal(s.findReaction(ids.sheetClose, 'ON_CLICK'), null);
  assert.equal(s.back()!.type, 'overlay-close');
  assert.equal(s.overlays.length, 0);
  s.run([{ type: 'OPEN_OVERLAY', destinationId: ids.menu, transition: null, overlay: DEFAULT_OVERLAY }]);
  s.run([{ type: 'CLOSE_OVERLAY' }], ids.sheetClose);
  assert.equal(s.overlays.length, 0, 'a layer closes the overlay it is in');
  s.run([{ type: 'OPEN_OVERLAY', destinationId: ids.menu, transition: null, overlay: DEFAULT_OVERLAY }]);
  s.run([{ type: 'NAVIGATE', destinationId: ids.other, transition: null }], ids.sheetClose);
  assert.deepEqual([s.current, s.overlays.length], [ids.other, 0]);

  // Scrolling: fixed stays, sticky stops at the top, nested hands over at the edge.
  const scroll = new ScrollState(doc);
  assert.deepEqual(scroll.limits(ids.home), { x: 0, y: 600 });
  assert.deepEqual(scroll.limits(ids.list), { x: 0, y: 390 });
  scroll.set(ids.home, 0, 300);
  assert.deepEqual([doc.get(ids.header, 'y'), doc.get(ids.tabs, 'y'), doc.get(ids.footer, 'y')], [0, 0, 600]);
  scroll.set(ids.home, 0, 50);
  assert.equal(doc.get(ids.tabs, 'y'), 50, 'sticky scrolls until it reaches the top');
  scroll.set(ids.home, 0, 0);
  const rest = scroll.scrollBy(scroll.chain(ids.items[2]!, ids.home), 0, 500);
  assert.deepEqual([scroll.offset(ids.list).y, scroll.offset(ids.home).y, rest.y], [390, 110, 0], 'the list scrolls to its end, the screen takes the rest');
  assert.equal(doc.get(ids.items[0]!, 'y'), -390);
  const target = scroll.targetOffset(ids.items[3]!, ids.home, { x: 0, y: 10 })!;
  assert.deepEqual(target, { container: ids.list, to: { x: 0, y: 290 } });
  scroll.reset(ids.home);
  assert.deepEqual([scroll.offset(ids.list).y, doc.get(ids.items[0]!, 'y')], [0, 0]);
  assert.equal(doc.canUndo(), true);

  // Change to: variants of the instance's set; a snapshot plan morphs size.
  const v = editor.commit('variants', (tx) => {
    const set = tx.create('COMPONENT_SET', page, { name: 'Button', x: 0, y: 600, width: 300, height: 100 });
    const normal = tx.create('COMPONENT', set, { name: 'State=Normal', width: 100, height: 40 });
    tx.create('RECTANGLE', normal, { name: 'Bg', width: 100, height: 40 });
    const hover = tx.create('COMPONENT', set, { name: 'State=Hover', x: 150, width: 120, height: 48 });
    tx.create('RECTANGLE', hover, { name: 'Bg', width: 120, height: 48 });
    return { set, normal, hover };
  });
  const inst = editor.commit('inst', (tx) => tx.create('INSTANCE', ids.other, { mainComponent: v.normal, width: 100, height: 40 }));
  assert.deepEqual(variantChoices(doc, inst), [v.normal, v.hover]);
  assert.deepEqual(variantChoices(doc, v.hover), [v.normal, v.hover]);
  const change = new PrototypeSession(doc, ids.other).run([{ type: 'CHANGE_TO', destinationId: v.hover, transition: null }], inst);
  assert.deepEqual(change, [{ type: 'change', instance: inst, variant: v.hover, transition: null }]);
  const snap = snapshotLayers(doc, inst);
  editor.commit('swap', (tx) => tx.set(inst, 'mainComponent', v.hover));
  const plan = planFromSnapshot(doc, snap, inst);
  const root = plan.matched.find((m) => m.id === inst)!;
  assert.deepEqual([root.a.width, root.b.width], [100, 120]);
});

test('prototype logic: expressions, set variable, conditions (FR-PRT-040–042)', async () => {
  const { evaluate, parseExpr, tryEvaluate, ExprError } = await import('../../components/src/expr.ts');
  const { PrototypeSession, MAX_CONDITION_DEPTH } = await import('../src/prototype/model.ts');
  const { toDisplay, toStored, coerce } = await import('../src/prototype/vars.ts');
  const vals: Record<string, unknown> = { count: 2, open: false, name: 'Аня', price: 9.5 };
  const read = (ref: string) => vals[ref] as never;
  const ev = (t: string) => evaluate(parseExpr(t), read);
  assert.equal(ev('{count} + 1'), 3);
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('!{open}'), true);
  assert.equal(ev('не {open} и {count} > 1'), true);
  assert.equal(ev('{open} или {count} = 2'), true);
  assert.equal(ev('"Привет, " + {name}'), 'Привет, Аня');
  assert.equal(ev("'Итого: ' + {price} * 2"), 'Итого: 19');
  assert.equal(ev('-{count} + 10 % 4'), 0);
  assert.equal(ev('1,5 + 1'), 2.5);
  assert.equal(ev('{open} и {missing}'), false, 'и stops early');
  assert.deepEqual(ev('#FF0000'), { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(ev('#ff0000 == #FF0000'), true);
  for (const [text, at] of [['{count} +', 9], ['{count} 2', 8], ['(1 + 2', 6], ['count + 1', 0], ['{count} + "a" > 1', 0], ['1 / 0', 4], ['{nope}', 0]] as const) {
    const r = tryEvaluate(text, read);
    assert.ok('error' in r, text);
    if ('error' in r) {
      assert.ok(r.error instanceof ExprError);
      assert.equal(r.error.start, at, `${text}: ${r.error.message}`);
    }
  }

  // In a session: variables are stored by id, values change and persist between screens.
  const { editor, doc, page } = setup();
  const coll = editor.variables.createCollection('Состояние');
  const count = editor.variables.createVariable(coll, 'FLOAT', 'Счётчик');
  const flag = editor.variables.createVariable(coll, 'BOOLEAN', 'Корзина/Открыта');
  const label = editor.variables.createVariable(coll, 'STRING', 'Надпись');
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('FRAME', page, { name: 'A', width: 100, height: 100 });
    const b = tx.create('FRAME', page, { name: 'B', x: 200, width: 100, height: 100 });
    const text = tx.create('TEXT', a, { characters: 'x', boundVariables: { characters: label } });
    return { a, b, text };
  });
  const stored = toStored(doc, '{счётчик} + 1');
  assert.equal(stored, `{#${count}} + 1`);
  assert.equal(toDisplay(doc, stored), '{Счётчик} + 1');
  assert.equal(toStored(doc, '{корзина.открыта}'), `{#${flag}}`);
  editor.variables.renameVariable(count, 'Количество');
  assert.equal(toDisplay(doc, stored), '{Количество} + 1', 'renaming does not break expressions');

  const s = new PrototypeSession(doc, ids.a);
  const inc = { type: 'SET_VARIABLE', variableId: count, expression: stored } as const;
  s.run([inc, inc, inc]);
  assert.deepEqual(s.evaluate(`{#${count}}`, ids.a), { value: 3 });
  s.run([{ type: 'NAVIGATE', destinationId: ids.b, transition: null }]);
  assert.deepEqual(s.evaluate(`{#${count}}`, ids.b), { value: 3 }, 'values live across screens');
  const bad = s.run([{ type: 'SET_VARIABLE', variableId: flag, expression: '{Количество} + 1' }]);
  assert.equal(bad[0]!.type, 'error', 'a number does not go into a boolean');
  assert.equal(coerce(doc, label, 42), '42');

  // Conditions: first true branch wins, else otherwise.
  const cond = (n: number): PrototypeAction => ({
    type: 'CONDITIONAL',
    branches: [
      { condition: `{#${count}} > ${n}`, actions: [{ type: 'SET_VARIABLE', variableId: label, expression: '"больше"' }] },
      { condition: `{#${count}} == ${n}`, actions: [{ type: 'SET_VARIABLE', variableId: label, expression: '"равно"' }] },
      { condition: null, actions: [{ type: 'SET_VARIABLE', variableId: label, expression: '"меньше"' }] },
    ],
  });
  for (const [n, want] of [[1, 'больше'], [3, 'равно'], [5, 'меньше']] as const) {
    s.run([cond(n)]);
    assert.deepEqual(s.evaluate(`{#${label}}`, ids.a), { value: want });
  }
  // Nesting deeper than the limit is refused, not run.
  let nested: never = { type: 'SET_VARIABLE', variableId: count, expression: '100' } as never;
  for (let i = 0; i < MAX_CONDITION_DEPTH + 1; i++) nested = { type: 'CONDITIONAL', branches: [{ condition: null, actions: [nested] }] } as never;
  const deep = s.run([nested]);
  assert.ok(deep.some((e) => e.type === 'error'));
  assert.deepEqual(s.evaluate(`{#${count}}`, ids.a), { value: 3 });
});

test('HTML import: the reported tree becomes frames, auto layout, mixed-style text, gradients, images and SVG in one undo step', async () => {
  const { buildHtmlImport } = await import('../src/html-import/build.ts');
  const doc = Document.createEmpty('Файл');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const tree = {
    t: 'FRAME' as const, name: 'body', w: 1440, h: 900, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    children: [
      {
        t: 'FRAME' as const, name: 'nav', x: 0, y: 0, w: 1440, h: 64, clip: true,
        // A 90° CSS gradient (left → right): Figma's matrix for it is the identity.
        fills: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
        stroke: { paint: { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, align: 'INSIDE' as const, w: [0, 0, 1, 0] as [number, number, number, number] },
        radii: [8, 8, 0, 0] as [number, number, number, number],
        effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 }, x: 0, y: 2, radius: 8, spread: 0 }],
        al: { mode: 'HORIZONTAL' as const, pad: [12, 24, 12, 24] as [number, number, number, number], gap: 16, primary: 'SPACE_BETWEEN', counter: 'CENTER' },
        children: [
          {
            t: 'TEXT' as const, name: 'Логотип', x: 24, y: 20, w: 120, h: 24, chars: 'Canvas Studio', auto: 'WIDTH_AND_HEIGHT' as const,
            styles: [{ fam: ['"Inter"', 'sans-serif'], w: 400, size: 18, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }, { fam: ['Inter'], w: 700, size: 18, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }],
            base: 0, ranges: [[0, 6, 1], [6, 13, 0]] as [number, number, number][],
          },
          { t: 'RECT' as const, name: 'img', x: 200, y: 8, w: 48, h: 48, fills: [{ type: 'IMAGE', imageId: 7, scaleMode: 'CROP' }], fillH: true },
          { t: 'SVG' as const, name: 'icon', x: 300, y: 20, w: 24, h: 24, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect width="12" height="12" fill="#f00"/></svg>' },
        ],
      },
    ],
  };
  // The tree comes from a page as plain JSON: typed loosely here, as it arrives.
  const { id, count } = buildHtmlImport(editor, tree as unknown as Parameters<typeof buildHtmlImport>[1], [{ id: 7, bytes: png }], 'Лендинг');
  assert.equal(count, 5);
  assert.equal(doc.get(id, 'name'), 'Лендинг');
  assert.deepEqual(editor.selection, [id]);
  const nav = doc.children(id)[0]!;
  assert.equal(doc.get(nav, 'layoutMode'), 'HORIZONTAL');
  assert.equal(doc.get(nav, 'spacingMode'), 'BETWEEN');
  assert.equal(doc.get(nav, 'counterAlign'), 'CENTER');
  assert.deepEqual(doc.get(nav, 'strokeWeights'), [0, 0, 1, 0]);
  assert.deepEqual(doc.get(nav, 'cornerRadii'), [8, 8, 0, 0]);
  assert.equal(doc.get(nav, 'effects')[0]!.type, 'DROP_SHADOW');
  const grad = doc.get(nav, 'fills')[0]!;
  assert.equal(grad.type, 'GRADIENT_LINEAR');
  if (grad.type === 'GRADIENT_LINEAR') assert.deepEqual([grad.from, grad.to], [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]);
  const [text, img, icon] = doc.children(nav);
  assert.equal(doc.get(text!, 'characters'), 'Canvas Studio');
  assert.equal(doc.get(text!, 'fontFamily'), 'Inter');
  assert.deepEqual(doc.get(text!, 'textRuns'), [{ start: 0, end: 6, style: { fontWeight: 700 } }]);
  const fill = doc.get(img!, 'fills')[0]!;
  assert.equal(fill.type, 'IMAGE');
  if (fill.type === 'IMAGE') assert.ok(doc.store.blobs.has(fill.imageHash), 'the picture is stored in the file');
  assert.deepEqual(doc.get(img!, 'sizingH'), { mode: 'FILL' });
  assert.equal(doc.type(icon!), 'GROUP');
  assert.ok(doc.children(icon!).length > 0, 'the SVG became vector layers');
  editor.undo();
  assert.equal(doc.store.isAlive(id), false, 'one undo removes the whole import');
});

test('HTML import (FEAT-169): a table of the page becomes a real table — grid cells row by row, merged cells, fills, a badge row kept in its cell', async () => {
  const { buildHtmlImport } = await import('../src/html-import/build.ts');
  const { tableShape, tableTexts, tableMerges } = await import('../src/tables.ts');
  const doc = Document.createEmpty('Файл');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const paint = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b }, opacity: 1 });
  const text = (chars: string, w = 100) => ({ t: 'TEXT' as const, x: 0, y: 0, w, h: 18, chars, styles: [{ fam: ['Arial'], w: 400, size: 13, fills: [paint(0, 0, 0)] }], base: 0, ranges: [] });
  const cell = (children: unknown[], extra: Record<string, unknown> = {}) => ({ t: 'FRAME' as const, name: 'td', x: 0, y: 0, w: 100, h: 40, fills: [paint(1, 1, 1)], cell: { rs: 1, cs: 1, hidden: false, pad: [12, 8, 12, 8], va: 'CENTER', minH: 40 }, children, ...extra });
  const badgeRow = { t: 'FRAME' as const, name: 'div.bank-head', x: 8, y: 10, w: 80, h: 24, al: { mode: 'HORIZONTAL' as const, pad: [0, 0, 0, 0], gap: 8, primary: 'CENTER', counter: 'CENTER' },
    children: [{ t: 'FRAME' as const, name: 'span.badge', x: 0, y: 0, w: 24, h: 24, radii: [12, 12, 12, 12], fills: [paint(1, 0.87, 0.18)], children: [text('Т', 10)] }, { ...text('Т-Банк', 48), auto: 'WIDTH_AND_HEIGHT' as const }] };
  const tree = {
    t: 'FRAME' as const, name: 'body', w: 800, h: 400,
    children: [{
      t: 'FRAME' as const, name: 'table', x: 20, y: 20, w: 300, h: 120, tbl: { cols: [100, 100, 100], header: true, line: paint(0.89, 0.9, 0.93) },
      children: [
        cell([text('Параметр')], { fills: [paint(0.12, 0.14, 0.2)] }), cell([badgeRow]), cell([text('Итог')], { cell: { rs: 1, cs: 1, hidden: false, pad: [12, 8, 12, 8], va: 'MIN', minH: 40 } }),
        cell([text('Цена')], { cell: { rs: 2, cs: 1, hidden: false, pad: [12, 8, 12, 8], va: 'CENTER', minH: 0 } }), cell([text('40 млн')], { cell: { rs: 1, cs: 2, hidden: false, pad: [12, 8, 12, 8], va: 'CENTER', minH: 40 } }), cell([], { cell: { rs: 1, cs: 1, hidden: true, pad: [0, 0, 0, 0], va: 'MIN', minH: 0 }, fills: [] }),
        cell([], { cell: { rs: 1, cs: 1, hidden: true, pad: [0, 0, 0, 0], va: 'MIN', minH: 0 }, fills: [] }), cell([text('1 год')]), cell([]),
      ],
    }],
  };
  const { id } = buildHtmlImport(editor, tree as unknown as Parameters<typeof buildHtmlImport>[1], [], 'Слайд');
  const table = doc.children(id)[0]!;
  assert.deepEqual(doc.get(table, 'table'), { header: true });
  assert.equal(doc.get(table, 'layoutMode'), 'GRID');
  assert.equal(doc.get(table, 'gridColumnGap'), 1, 'lines between the cells');
  const shape = tableShape(doc, table);
  assert.deepEqual([shape.rows, shape.cols], [3, 3]);
  assert.deepEqual(tableTexts(doc, table), [['Параметр', 'Т-Банк', 'Итог'], ['Цена', '40 млн', ''], ['', '1 год', '']], 'an empty cell still has a text to type in');
  assert.deepEqual(tableMerges(doc, table).map((m) => [m.row, m.col, m.rows, m.cols]), [[1, 0, 2, 1], [1, 1, 1, 2]]);
  assert.equal(doc.get(shape.cells[5]!, 'visible'), false, 'places under merged cells are hidden');
  const [head, bank] = shape.cells;
  assert.equal(doc.get(head!, 'primaryAlign'), 'CENTER', 'vertical-align: middle');
  assert.deepEqual(doc.get(head!, 'minHeight'), { unit: 'PX', value: 40 }, 'the row as high as on the page');
  assert.equal(doc.get(bank!, 'layoutMode'), 'HORIZONTAL', 'the badge row is the cell itself');
  assert.deepEqual(doc.children(bank!).map((c) => doc.type(c)), ['FRAME', 'TEXT']);
  editor.undo();
  assert.equal(doc.store.isAlive(id), false);
});

test('paste onto the copied layer itself puts the copy next to it, not inside (an auto layout card stays intact)', () => {
  const { doc, editor, page } = setup();
  const [card, row, other] = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { name: 'Карточка', x: 0, y: 0, width: 320, height: 200, layoutMode: 'VERTICAL', sizingV: { mode: 'HUG' } });
    const row = tx.create('RECTANGLE', card, { name: 'Строка', width: 100, height: 40 });
    tx.create('RECTANGLE', card, { name: 'Строка 2', width: 100, height: 40 });
    const other = tx.create('FRAME', page, { name: 'Другой', x: 1000, y: 0, width: 300, height: 300 });
    return [card, row, other];
  });
  const cardHeight = doc.get(card, 'height');
  editor.setSelection([card]);
  assert.ok(editor.pasteText(JSON.stringify(toClipboard(doc, [card]))));
  const copy = editor.selection[0]!;
  assert.equal(doc.parent(copy), page, 'a sibling on the page, not a row of the card');
  assert.deepEqual([doc.get(copy, 'x'), doc.get(copy, 'y')], [360, 0], 'to the right of the original, no overlap');
  assert.equal(doc.children(card).length, 2);
  assert.equal(doc.get(card, 'height'), cardHeight, 'the original keeps its size');

  // Copied something else and selected a frame: the copy goes inside it, as before.
  editor.setSelection([other]);
  assert.ok(editor.pasteText(JSON.stringify(toClipboard(doc, [card]))));
  assert.equal(doc.parent(editor.selection[0]!), other);

  // A row of an auto layout pasted onto itself: the next row, right after it.
  editor.setSelection([row]);
  assert.ok(editor.pasteText(JSON.stringify(toClipboard(doc, [row]))));
  assert.deepEqual(doc.children(card).map((id) => doc.get(id, 'name')), ['Строка', 'Строка', 'Строка 2']);
});

test('a pasted top-level frame goes to the first free place on the right, not under a neighbour', () => {
  const { doc, editor, page } = setup();
  const [card] = editor.commit('setup', (tx) => [
    tx.create('FRAME', page, { name: 'Карточка', x: 0, y: 0, width: 300, height: 200 }),
    tx.create('FRAME', page, { name: 'С чего начать', x: 330, y: 0, width: 300, height: 300 }),
  ]);
  editor.setSelection([card!]);
  assert.ok(editor.pasteText(JSON.stringify(toClipboard(doc, [card!]))));
  const copy = editor.selection[0]!;
  assert.deepEqual([doc.get(copy, 'x'), doc.get(copy, 'y')], [670, 0], 'past the neighbour, with the same gap');
});

test('copy to other apps: the layers travel in HTML, plain text is their text, never JSON', () => {
  const { editor, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Карточка', width: 200, height: 100 });
    tx.create('TEXT', f, { characters: 'Беспроводные наушники' });
    tx.create('TEXT', f, { characters: '12 990 ₽' });
    return f;
  });
  editor.setSelection([frame]);
  const flavours = editor.copyFlavours()!;
  assert.equal(flavours.text, 'Беспроводные наушники\n12 990 ₽');
  assert.doesNotMatch(flavours.html, /"nodes"/, 'no JSON visible in the HTML either');
  const other = setup();
  assert.ok(other.editor.pasteText(flavours.html), 'another file reads the layers from the HTML');
  assert.equal(other.doc.get(other.doc.children(other.page)[0]!, 'name'), 'Карточка');
  assert.equal(parseClipboard('<b>чужой HTML</b>'), null);
});

test('rename layers without AI: default names get meaningful ones from simple rules; given names stay', () => {
  const { editor, doc, page } = setup();
  const white = { type: 'SOLID' as const, color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true };
  const ids = editor.commit('setup', (tx) => {
    const screen = tx.create('FRAME', page, { name: 'Frame 1', width: 390, height: 844 });
    const header = tx.create('FRAME', screen, { name: 'Frame 2', x: 0, y: 0, width: 390, height: 56, fills: [white] });
    tx.create('TEXT', header, { name: 'Text', characters: 'Каталог', fontSize: 28 });
    const button = tx.create('FRAME', screen, { name: 'Frame 3', x: 16, y: 100, width: 120, height: 44, fills: [white] });
    tx.create('TEXT', button, { name: 'Text 2', characters: 'В корзину', fontSize: 14 });
    const card = tx.create('FRAME', screen, { name: 'div', x: 16, y: 200, width: 200, height: 260, cornerRadius: 12, fills: [white] });
    tx.create('RECTANGLE', card, { name: 'Rectangle 4', width: 200, height: 120, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] });
    tx.create('TEXT', card, { name: 'Text 3', characters: 'Наушники', fontSize: 18 });
    const list = tx.create('FRAME', screen, { name: 'Frame 5', x: 16, y: 500, width: 200, height: 200 });
    for (const t of ['Профиль', 'Заказы', 'Выход']) {
      const item = tx.create('FRAME', list, { name: 'Frame', width: 200, height: 40 });
      tx.create('TEXT', item, { name: 'Text', characters: t });
    }
    const icon = tx.create('VECTOR', screen, { name: 'Vector 7', width: 24, height: 24 });
    const line = tx.create('LINE', screen, { name: 'Line 1', width: 390 });
    const mine = tx.create('RECTANGLE', screen, { name: 'Мой фон', width: 10, height: 10 });
    return { screen, header, button, card, list, icon, line, mine };
  });
  editor.setSelection([]);
  assert.ok(editor.autoName() > 0);
  const n = (id: NodeId) => doc.get(id, 'name');
  assert.equal(n(ids.screen), 'Экран «Каталог»');
  assert.equal(n(ids.header), 'Шапка');
  assert.equal(n(ids.button), 'Кнопка «В корзину»');
  assert.equal(n(ids.card), 'Карточка «Наушники»');
  assert.equal(n(ids.list), 'Список');
  assert.equal(n(doc.children(ids.card)[0]!), 'Изображение');
  assert.equal(n(doc.children(ids.card)[1]!), 'Наушники', 'a text layer is named by its text');
  assert.equal(n(ids.icon), 'Иконка');
  assert.equal(n(ids.line), 'Разделитель');
  assert.equal(n(ids.mine), 'Мой фон', 'a name a person gave is kept');
  assert.equal(editor.autoName(), 0, 'nothing left to rename');
});

test('remove background without AI: a plain background is cleared from the edges, the object stays; a busy one is refused', async () => {
  const { removeUniformBackground } = await import('../src/remove-bg.ts');
  const w = 20;
  const h = 20;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = x >= 6 && x < 14 && y >= 6 && y < 14;
    // White background with a little noise, a red square in the middle.
    px.set(inside ? [220, 30, 30, 255] : [250 - ((x + y) % 3), 250, 252, 255], i);
  }
  const res = removeUniformBackground(px, w, h)!;
  assert.ok(res);
  assert.equal(px[3], 0, 'corner is transparent');
  assert.equal(px[(10 * w + 10) * 4 + 3], 255, 'the object is untouched');
  assert.ok(Math.abs(res.removed - (400 - 64) / 400) < 0.01);

  const busy = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) busy.set([(p * 37) % 256, (p * 91) % 256, (p * 13) % 256, 255], p * 4);
  assert.equal(removeUniformBackground(busy, w, h), null);
});

test('remove background: holes inside the object, gradient backdrops, no halo on the edge', async () => {
  const { removeUniformBackground } = await import('../src/remove-bg.ts');
  const w = 60;
  const h = 60;
  const at = (x: number, y: number) => (y * w + x) * 4;
  // A dark ring on white: the inside of the ring is background too.
  const ring = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 30, y - 30);
    ring.set(d >= 12 && d <= 20 ? [20, 20, 30, 255] : [255, 255, 255, 255], at(x, y));
  }
  assert.ok(removeUniformBackground(ring, w, h));
  assert.equal(ring[at(30, 30) + 3], 0, 'the hole of the ring is cleared');
  assert.equal(ring[at(30, 14) + 3], 255, 'the ring stays');

  // A blue square on a light-grey to white gradient, with an anti-aliased (half white) edge.
  const grad = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(200 + (55 * x) / (w - 1));
    grad.set([v, v, v, 255], at(x, y));
    if (x >= 20 && x < 40 && y >= 20 && y < 40) grad.set([0, 60, 200, 255], at(x, y));
    if (x === 19 && y >= 20 && y < 40) grad.set([Math.round((v + 0) / 2), Math.round((v + 60) / 2), Math.round((v + 200) / 2), 255], at(x, y));
  }
  assert.ok(removeUniformBackground(grad, w, h), 'a smooth gradient counts as a plain background');
  assert.equal(grad[at(2, 2) + 3], 0);
  assert.equal(grad[at(57, 57) + 3], 0, 'both ends of the gradient go');
  assert.equal(grad[at(30, 30) + 3], 255);
  const edgeAlpha = grad[at(19, 30) + 3]!;
  assert.ok(edgeAlpha > 60 && edgeAlpha < 200, `half-covered edge pixel is half transparent (${edgeAlpha})`);
  assert.ok(grad[at(19, 30)]! < 40, 'and the background colour is taken out of it (no light halo)');

  // Noise specks left in the background are cleared.
  const specks = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) specks.set([250, 250, 250, 255], p * 4);
  specks.set([90, 90, 90, 255], at(8, 8));
  for (let y = 25; y < 35; y++) for (let x = 25; x < 35; x++) specks.set([200, 0, 0, 255], at(x, y));
  assert.ok(removeUniformBackground(specks, w, h));
  assert.equal(specks[at(8, 8) + 3], 0, 'a lone speck goes');
  assert.equal(specks[at(30, 30) + 3], 255);
});

test('crop: frame drags stay inside the picture, keep proportions, the layer keeps the picture in place', async () => {
  const { dragCrop, fitRatio, layerAfterCrop, FULL, isFull } = await import('../src/crop.ts');
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  // Free: the right edge cannot leave the picture, the left one cannot cross the right.
  const r1 = dragCrop(FULL, 'e', 0.5, 0, null);
  near(r1.width, 1);
  const r2 = dragCrop(FULL, 'w', 2, 0, null);
  near(r2.width, 0.02);
  // Moving stays inside.
  const small = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  const moved = dragCrop(small, 'move', 1, -1, null);
  near(moved.x, 0.5);
  near(moved.y, 0);
  // A proportion is kept from the opposite corner and shrinks to fit.
  const sq = dragCrop(small, 'se', 0.3, 0.05, 1);
  near(sq.width, sq.height);
  near(sq.x, 0.1);
  assert.ok(sq.x + sq.width <= 1 + 1e-9 && sq.y + sq.height <= 1 + 1e-9);
  const f = fitRatio(FULL, 2);
  near(f.width, 1);
  near(f.height, 0.5);
  near(f.y, 0.25);
  assert.ok(isFull(FULL) && !isFull(small));
  // Layer 200×100 shows the whole picture; keeping its right half moves it right by 100 and halves it.
  const after = layerAfterCrop({ x: 10, y: 20, width: 200, height: 100, rotation: 0 }, FULL, { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.deepEqual(after, { x: 110, y: 20, width: 100, height: 100 });
  // And back to the whole picture from that crop.
  assert.deepEqual(layerAfterCrop({ ...after, rotation: 0 }, { x: 0.5, y: 0, width: 0.5, height: 1 }, FULL), { x: 10, y: 20, width: 200, height: 100 });
});

test('undo history: steps are listed with names, a jump goes several steps back and forward', () => {
  const { editor, doc, page } = setup();
  const id = editor.commit('Создать', (tx) => tx.create('RECTANGLE', page, { width: 10, height: 10 }));
  editor.commit('Ширина', (tx) => tx.set(id, 'width', 20));
  editor.commit('Переименовать', (tx) => tx.set(id, 'name', 'Кнопка'));
  assert.deepEqual(doc.history().undo.map((e) => e.label), ['Создать', 'Ширина', 'Переименовать']);
  editor.stepHistory(-2);
  assert.equal(doc.get(id, 'width'), 10);
  assert.deepEqual(doc.history().redo.map((e) => e.label), ['Ширина', 'Переименовать'], 'the next step to redo first');
  editor.stepHistory(1);
  assert.equal(doc.get(id, 'width'), 20);
  assert.equal(doc.get(id, 'name') === 'Кнопка', false);
  editor.stepHistory(-10);
  assert.equal(doc.store.isAlive(id), false, 'back to the start');
  editor.stepHistory(10);
  assert.equal(doc.get(id, 'name'), 'Кнопка');
});

test('find and replace: whole words, case, names; the replacement keeps the style of the text it replaces', async () => {
  const { findMatches, replaceMatches } = await import('../src/find-replace.ts');
  const { editor, doc, page } = setup();
  const [a, b] = editor.commit('setup', (tx) => [
    tx.create('TEXT', page, { name: 'Цена', characters: 'Купить сейчас. купить' }),
    tx.create('TEXT', page, { name: 'Подпись', characters: 'Покупка', textRuns: [{ start: 0, end: 7, style: { fontWeight: 700 } }] }),
  ]);
  const ctx = { pageId: page, selection: [] };
  const base = { query: 'купить', caseSensitive: false, wholeWord: false, scope: 'file' as const, names: false };
  assert.equal(findMatches(doc, base, ctx).length, 2);
  assert.equal(findMatches(doc, { ...base, caseSensitive: true }, ctx).length, 1);
  assert.equal(findMatches(doc, { ...base, query: 'куп', wholeWord: true }, ctx).length, 0, 'Cyrillic words have boundaries too');
  assert.equal(findMatches(doc, { ...base, query: 'цена', names: true }, ctx).length, 1, 'layer names when asked');
  editor.commit('replace', (tx) => replaceMatches(doc, tx, findMatches(doc, base, ctx), 'Заказать'));
  assert.equal(doc.get(a, 'characters'), 'Заказать сейчас. Заказать');
  const bold = findMatches(doc, { ...base, query: 'Покупка' }, ctx);
  editor.commit('replace', (tx) => replaceMatches(doc, tx, bold, 'Корзина товаров'));
  assert.equal(doc.get(b, 'characters'), 'Корзина товаров');
  assert.deepEqual(doc.get(b, 'textRuns'), [{ start: 0, end: 15, style: { fontWeight: 700 } }], 'bold stays bold over the new length');
});

test('fonts in the file: names from file names, the weights the file uses, carried into SVG', async () => {
  const { infoFromFileName, usedStyles } = await import('../src/fonts.ts');
  const { exportSvg } = await import('#render');
  assert.deepEqual(infoFromFileName('Golos-Text_SemiBold-Italic.woff2'), { family: 'Golos Text', weight: 600, italic: true });
  assert.deepEqual(infoFromFileName('InterVariable.woff2'), { family: 'Inter', weight: 0, italic: false });
  assert.deepEqual(infoFromFileName('Manrope-Regular.ttf'), { family: 'Manrope', weight: 400, italic: false });
  const { editor, doc, page } = setup();
  const t = editor.commit('setup', (tx) => {
    const hash = tx.addBlob(new Uint8Array([0, 1, 0, 0, 9, 9]), 'font/ttf');
    tx.set(doc.rootId, 'embeddedFonts', [{ family: 'Golos Text', weight: 600, italic: false, hash }]);
    return tx.create('TEXT', page, { characters: 'Привет', fontFamily: 'Golos Text', fontWeight: 600, textRuns: [{ start: 0, end: 2, style: { italic: true } }] });
  });
  assert.deepEqual(usedStyles(doc, 'Golos Text').sort((a, b) => Number(a.italic) - Number(b.italic)), [{ weight: 600, italic: false }, { weight: 600, italic: true }]);
  const { svg } = exportSvg(editor.scene, editor.measurer, [t]);
  assert.match(svg, /@font-face\{font-family:"Golos Text";src:url\(data:font\/ttf;base64,/);
});

test('export: name template with folders, no two files with one name, clean SVG with currentColor', async () => {
  const { exportPath } = await import('../src/exporter.ts');
  const { exportSvg } = await import('#render');
  const { editor, doc, page } = setup();
  const [frame, icon] = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Главный экран', width: 100, height: 100 });
    const i = tx.create('RECTANGLE', f, { name: 'icons/arrow: left', x: 10, y: 10, width: 16, height: 16, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] });
    return [f, i];
  });
  assert.equal(exportPath(editor, icon, '', 0), 'icons/arrow_ left', '"/" in a layer name is a folder, other symbols are made safe');
  assert.equal(exportPath(editor, icon, '{page}/{frame}/{name}-{n}', 2), `${doc.get(page, 'name')}/Главный экран/icons/arrow_ left-3`);
  const plain = exportSvg(editor.scene, editor.measurer, [icon]).svg;
  assert.doesNotMatch(plain, /id="/, 'no layer ids by default');
  assert.doesNotMatch(plain, /matrix\(1 0 0 1/, 'a plain shift is written as translate');
  const themed = exportSvg(editor.scene, editor.measurer, [icon], null, { currentColor: true, responsive: true }).svg;
  assert.match(themed, /fill="currentColor"/);
  assert.doesNotMatch(themed, / width="/);
  void frame;
});

test('hyperlinks: safe addresses only, on part of a text or a whole layer, found under the pointer, kept in SVG', async () => {
  const { safeLink } = await import('#core');
  const { linkAt } = await import('../src/text-links.ts');
  const { exportSvg } = await import('#render');
  assert.equal(safeLink('example.com/путь'), 'https://example.com/%D0%BF%D1%83%D1%82%D1%8C');
  assert.equal(safeLink('anna@example.com'), 'mailto:anna@example.com');
  assert.equal(safeLink('+7 (999) 123-45-67'), 'tel:+79991234567');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('data:text/html,x'), null);
  assert.equal(safeLink('   '), null);

  const { editor, doc, page } = setup();
  const t = editor.commit('setup', (tx) => tx.create('TEXT', page, { characters: 'Купить сейчас', textAutoResize: 'WIDTH_AND_HEIGHT' }));
  // While editing: the selected word only, underlined.
  editor.setSelection([t]);
  editor.startTextEditing(t);
  editor.setTextSelection(7, 13);
  assert.equal(editor.setLink('https://shop.example/'), true);
  editor.stopTextEditing();
  assert.deepEqual(doc.get(t, 'textRuns'), [{ start: 7, end: 13, style: { link: 'https://shop.example/', textDecoration: 'UNDERLINE' } }]);
  // Under the pointer: the link on "сейчас", nothing on "Купить".
  const b = editor.scene.bounds(t);
  assert.equal(linkAt(doc, editor.scene, editor.measurer, t, { x: b.x + b.width - 2, y: b.y + b.height / 2 }), 'https://shop.example/');
  assert.equal(linkAt(doc, editor.scene, editor.measurer, t, { x: b.x + 2, y: b.y + b.height / 2 }), null);
  assert.match(exportSvg(editor.scene, editor.measurer, [t]).svg, /<a href="https:\/\/shop\.example\/"><tspan[^>]*>сейчас<\/tspan><\/a>/);
  // The whole layer when not editing; mixed links show as mixed; removing takes the underline too.
  editor.setSelection([t]);
  assert.equal(typeof editor.linkValue(), 'symbol', 'part linked, part not');
  editor.setLink('https://other.example/');
  assert.equal(editor.linkValue(), 'https://other.example/');
  editor.setLink(null);
  assert.equal(editor.linkValue(), null);
  assert.deepEqual(doc.get(t, 'textRuns'), []);
});

test('one layer leaves an auto layout and comes back; the others keep their layout', () => {
  const { editor, doc, page } = setup();
  const [frame, a, badge, c] = editor.commit('setup', (tx) => {
    const f = tx.create('FRAME', page, { width: 300, height: 100, layoutMode: 'HORIZONTAL', itemSpacing: 10 });
    return [f, tx.create('RECTANGLE', f, { width: 50, height: 50 }), tx.create('RECTANGLE', f, { width: 20, height: 20 }), tx.create('RECTANGLE', f, { width: 50, height: 50 })];
  });
  assert.equal(doc.get(c, 'x'), 90, 'three in a row');
  editor.setSelection([badge]);
  assert.equal(editor.toggleAbsolute(), true);
  assert.equal(doc.get(badge, 'positioning'), 'ABSOLUTE');
  assert.equal(doc.get(c, 'x'), 60, 'the others close the gap');
  assert.notEqual(doc.get(frame, 'layoutMode'), 'NONE', 'the frame keeps its auto layout');
  editor.commit('move badge', (tx) => tx.set(badge, 'x', 270));
  assert.equal(doc.get(badge, 'x'), 270, 'it can be placed anywhere now');
  editor.toggleAbsolute();
  assert.equal(doc.get(badge, 'positioning'), 'AUTO');
  assert.equal(doc.get(c, 'x'), 90, 'back in the row');
  editor.setSelection([frame]);
  assert.equal(editor.toggleAbsolute(), false, 'a layer not inside an auto layout');
  void a;
});

test('screen templates: each builds a screen of its size with auto layout, to the right of what is on the page', async () => {
  const { screenTemplates } = await import('../src/templates.ts');
  const { editor, doc, page } = setup();
  editor.commit('setup', (tx) => tx.create('FRAME', page, { name: 'Старый', width: 300, height: 300 }));
  for (const t of screenTemplates()) {
    const id = editor.insertTemplate(t);
    assert.equal(doc.get(id, 'width'), t.width, t.id);
    assert.equal(doc.get(id, 'layoutMode'), 'VERTICAL', t.id);
    assert.ok(doc.children(id).length > 0, t.id);
    assert.ok(doc.get(id, 'x') >= 380, `${t.id} goes to the right of existing content`);
  }
});

test('help: both languages have the same articles; links point to existing ones; search finds by word start', async () => {
  const { ARTICLES_RU } = await import('../src/help/articles-ru.ts');
  const { ARTICLES_EN } = await import('../src/help/articles-en.ts');
  const { searchArticles } = await import('../src/help/dialog.ts');
  assert.deepEqual(ARTICLES_EN.map((a) => a.id), ARTICLES_RU.map((a) => a.id));
  const ids = new Set(ARTICLES_RU.map((a) => a.id));
  for (const a of [...ARTICLES_RU, ...ARTICLES_EN]) for (const r of a.related ?? []) assert.ok(ids.has(r), `${a.id} → ${r}`);
  assert.equal(searchArticles(ARTICLES_RU, 'тёмная тема')[0]!.article.id, 'variables-theme');
  assert.equal(searchArticles(ARTICLES_RU, 'переменной')[0]!.article.section, 'Переменные');
  assert.equal(searchArticles(ARTICLES_EN, 'dark theme')[0]!.article.id, 'variables-theme');
  assert.deepEqual(searchArticles(ARTICLES_RU, 'zzzz'), []);
});

test('similar components without AI: a detached copy of a button is found and replaced by an instance', async () => {
  const { similarComponents } = await import('../src/similar.ts');
  const { editor, doc, page } = setup();
  const blue = { type: 'SOLID' as const, color: { r: 0.05, g: 0.6, b: 1, a: 1 }, opacity: 1, visible: true };
  const make = (tx: Transaction, x: number, label: string) => {
    const f = tx.create('FRAME', page, { name: 'Frame', x, layoutMode: 'HORIZONTAL', width: 120, height: 40, fills: [blue] });
    tx.create('TEXT', f, { characters: label });
    return f;
  };
  const ids = editor.commit('setup', (tx) => ({ button: make(tx, 0, 'Купить'), copy: make(tx, 200, 'Купить'), card: tx.create('FRAME', page, { name: 'Card', x: 400, width: 300, height: 400 }) }));
  const component = editor.commit('c', (tx) => convertFrameToComponent(doc, tx, ids.button));
  const found = similarComponents(doc, ids.copy);
  assert.equal(found[0]?.component, component);
  assert.ok(found[0]!.score > 0.9);
  assert.equal(similarComponents(doc, ids.card).length, 0, 'an empty card is not like a button');
  const inst = editor.replaceWithInstance(ids.copy, component)!;
  assert.equal(doc.type(inst), 'INSTANCE');
  assert.equal(doc.get(inst, 'x'), 200);
  assert.equal(doc.store.isAlive(ids.copy), false);
});

test('translate without a server: the source language is guessed; without the browser translator a clear error', async () => {
  const { guessLanguage, translateTexts } = await import('../src/translate.ts');
  assert.equal(guessLanguage('Привет, мир'), 'ru');
  assert.equal(guessLanguage('Привіт, світ'), 'uk');
  assert.equal(guessLanguage('Hello'), 'en');
  await assert.rejects(translateTexts(['Привет'], 'en'), /Chrome 138/);
});

test('comment mentions: the @word at the caret, people called in a text, highlighted parts', () => {
  assert.deepEqual(mentionQuery('Привет, @Ол', 11), { start: 8, query: 'Ол' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('почта a@b', 9), null, 'an address is not a mention');
  assert.equal(mentionQuery('@Оля привет', 11), null, 'the word after a space ends the mention');
  assert.deepEqual(mentionQuery('@Оля, @Ко и дальше', 9), { start: 6, query: 'Ко' }, 'the caret decides, not the end of the text');
  const people = [
    { id: 'u1', name: 'Оля' },
    { id: 'u2', name: 'Оля Петрова' },
    { id: 'u3', name: 'Костя' },
  ];
  assert.deepEqual(mentionedIn('@Оля Петрова, глянь', people), ['u2'], 'the longest name wins');
  assert.deepEqual(mentionedIn('@Оля и @Костя', people), ['u1', 'u3']);
  assert.deepEqual(mentionedIn('Костя, без собачки', people), []);
  assert.deepEqual(splitMentions('@Оля Петрова и @Костя!', ['Оля', 'Оля Петрова', 'Костя']), [
    { text: '@Оля Петрова', mention: true },
    { text: ' и ', mention: false },
    { text: '@Костя', mention: true },
    { text: '!', mention: false },
  ]);
  assert.deepEqual(splitMentions('a@b @x', ['Оля']), [{ text: 'a@b @x', mention: false }]);
});

test('code for developers: CSS with auto layout, variables and styles; SwiftUI, Compose; variables as :root', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Тема');
  const light = doc.get(coll, 'modes')[0]!.id;
  const dark = vars.addMode(coll, 'Тёмная');
  const brand = vars.createVariable(coll, 'COLOR', 'Brand/Primary', { r: 13 / 255, g: 153 / 255, b: 1, a: 1 });
  vars.setValue(brand, dark, { r: 0, g: 0, b: 0, a: 1 });
  const gap = vars.createVariable(coll, 'FLOAT', 'Space/M', 12);
  vars.setDetails(gap, { codeSyntax: { WEB: 'var(--space-m)', IOS: 'Spacing.m' } });
  void light;
  const [card, button, label, abs] = editor.commit('s', (tx) => {
    const c = tx.create('FRAME', page, { width: 320, height: 200, layoutMode: 'VERTICAL', itemSpacing: 12, paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24, counterAlign: 'CENTER', cornerRadius: 8, clipsContent: true, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] });
    const b = tx.create('RECTANGLE', c, { width: 100, height: 40, sizingH: { mode: 'FILL' }, opacity: 0.5, effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true }] });
    const t = tx.create('TEXT', c, { characters: 'Купить "сейчас"', fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeight: { unit: 'PERCENT', value: 150 }, letterSpacing: { unit: 'PERCENT', value: 2 }, textAlignH: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' });
    const a = tx.create('RECTANGLE', c, { x: 10, y: 20, width: 8, height: 8, positioning: 'ABSOLUTE' });
    return [c, b, t, a];
  });
  editor.setSelection([card!]);
  vars.bind('fills/0', brand);
  vars.bind('itemSpacing', gap);
  const css = cssDecls(doc, card!);
  const get = (decls: { prop: string; value: string }[], prop: string) => decls.find((x) => x.prop === prop)?.value;
  assert.equal(get(css.decls, 'display'), 'flex');
  assert.equal(get(css.decls, 'flex-direction'), 'column');
  assert.equal(get(css.decls, 'align-items'), 'center');
  assert.equal(get(css.decls, 'gap'), 'var(--space-m, 12px)', 'code syntax names the variable');
  assert.equal(get(css.decls, 'padding'), '16px 24px');
  assert.equal(get(css.decls, 'background'), 'var(--brand-primary, #0D99FF)');
  assert.equal(get(css.decls, 'border-radius'), '8px');
  assert.equal(get(css.decls, 'overflow'), 'hidden');
  assert.equal(get(css.decls, 'position'), undefined, 'a frame on the page has no position');
  assert.equal(get(cssDecls(doc, card!, { unit: 'rem', remBase: 16 }).decls, 'padding'), '1rem 1.5rem');

  const b = cssDecls(doc, button!).decls;
  assert.equal(get(b, 'flex'), undefined, 'FILL across a column stretches, not grows');
  assert.equal(get(b, 'align-self'), 'stretch');
  assert.equal(get(b, 'height'), '40px');
  assert.equal(get(b, 'box-shadow'), '0 4px 8px rgba(0, 0, 0, 0.25)');
  assert.equal(get(b, 'opacity'), '0.5');
  const a = cssDecls(doc, abs!).decls;
  assert.deepEqual([get(a, 'position'), get(a, 'left'), get(a, 'top')], ['absolute', '10px', '20px'], 'out of auto layout');

  const t = formatCss(cssDecls(doc, label!).decls);
  assert.match(t, /font-family: "Inter", sans-serif;/);
  assert.match(t, /font-weight: 600;/);
  assert.match(t, /line-height: 1.5;/);
  assert.match(t, /letter-spacing: 0.02em;/);
  assert.match(t, /text-align: center;/);
  assert.match(t, /white-space: nowrap;/);
  assert.doesNotMatch(t, /width:/, 'text that grows has no width');

  const swift = swiftUI(doc, card!);
  assert.match(swift, /VStack\(alignment: \.center, spacing: 12\)/);
  assert.match(swift, /\.padding\(EdgeInsets\(top: 16, leading: 24, bottom: 16, trailing: 24\)\)/);
  assert.match(swift, /\.background\(Color\.brandPrimary, in: RoundedRectangle\(cornerRadius: 8\)\)/);
  assert.match(swiftUI(doc, label!), /Text\("Купить \\"сейчас\\""\)/);
  const kt = compose(doc, card!);
  assert.match(kt, /Column\(/);
  assert.match(kt, /verticalArrangement = Arrangement\.spacedBy\(12\.dp\)/);
  assert.match(kt, /\.background\(brandPrimary, RoundedCornerShape\(8\.dp\)\)/);
  assert.match(compose(doc, label!), /fontWeight = FontWeight\(600\)/);

  const root = variablesCss(doc);
  assert.match(root, /:root \{\n  \/\* Тема \*\/\n  --brand-primary: #0D99FF;\n  --space-m: 12;/);
  assert.match(root, /\[data-тема="тёмная"\] \{\n  --brand-primary: #000000;\n\}/, 'only values that differ');
});

test('code for developers: a layer with everything inside it (HTML + CSS, nested SwiftUI and Compose)', () => {
  const { editor, doc, page } = setup();
  const [screen] = editor.commit('s', (tx) => {
    const sc = tx.create('FRAME', page, { name: 'Экран', x: 500, y: 300, width: 360, height: 640 });
    const list = tx.create('FRAME', sc, { name: 'Список', x: 16, y: 80, width: 328, height: 200, layoutMode: 'VERTICAL', itemSpacing: 8 });
    tx.create('TEXT', list, { name: 'Пункт', characters: 'Первый <пункт>\nвторая строка', fontFamily: 'Inter', fontSize: 14 });
    tx.create('TEXT', list, { name: 'Пункт', characters: 'Второй', fontFamily: 'Inter', fontSize: 14 });
    tx.create('VECTOR', sc, { name: 'Иконка меню', x: 16, y: 16, width: 24, height: 24 });
    tx.create('RECTANGLE', sc, { name: 'Скрытый', visible: false, width: 10, height: 10 });
    return [sc];
  });
  const html = htmlTree(doc, screen!);
  assert.match(html, /^<div class="экран">\n  <div class="список">\n    <p class="пункт">Первый &lt;пункт&gt;<br>вторая строка<\/p>\n    <p class="пункт-2">Второй<\/p>\n  <\/div>\n  <img class="иконка-меню" src="иконка-меню.svg" alt="">\n<\/div>/);
  assert.doesNotMatch(html, /скрытый/, 'hidden layers are left out');
  assert.match(html, /\.экран \{\n  position: relative;/, 'the top element holds the placed children');
  assert.doesNotMatch(html, /\.экран \{[^}]*left:/, 'the top element is not placed against its page');
  assert.match(html, /\.список \{[^}]*display: flex;[^}]*position: absolute;\n  left: 16px;\n  top: 80px;/);
  assert.match(html, /<style>[\s\S]*\.пункт-2 \{/);

  const swift = swiftUI(doc, screen!, true);
  assert.match(swift, /ZStack\(alignment: \.topLeading\) \{\n    \/\/ Список\n    VStack\(alignment: \.leading, spacing: 8\) \{\n        \/\/ Пункт\n        Text\("Первый <пункт>\\nвторая строка"\)/);
  assert.match(swift, /\.offset\(x: 16, y: 80\)/);
  assert.match(swift, /Image\("иконка-меню"\)/);
  assert.doesNotMatch(swiftUI(doc, screen!), /Text\(/, 'without the tree only a note about the layers');
  const kt = compose(doc, screen!, true);
  assert.match(kt, /Box\(modifier = [\s\S]*Column\([\s\S]*Text\(/);
  assert.match(kt, /\.offset\(16\.dp, 80\.dp\)/);
  assert.match(kt, /R\.drawable\.иконка_меню/);
});

test('libraries: publish, take a component into another file, update it there, keep overrides, undo', () => {
  // The library: a button (with a text style and a colour variable) and a card with a copy of the button inside.
  const lib = setup();
  const coll = lib.editor.variables.createCollection('Бренд');
  const brand = lib.editor.variables.createVariable(coll, 'COLOR', 'primary', { r: 0, g: 0.6, b: 1, a: 1 });
  const btnFrame = lib.editor.commit('s', (tx) => {
    const f = tx.create('FRAME', lib.page, { name: 'Кнопка', width: 120, height: 40, fills: [{ type: 'SOLID', color: { r: 0, g: 0.6, b: 1, a: 1 }, opacity: 1, visible: true }] });
    tx.create('TEXT', f, { name: 'Подпись', characters: 'OK', x: 10, y: 10, width: 50, height: 20 });
    tx.create('RECTANGLE', f, { name: 'Блик', width: 4, height: 4 });
    return f;
  });
  lib.editor.setSelection([btnFrame]);
  lib.editor.variables.bind('fills/0', brand);
  lib.editor.createComponent();
  const button = lib.editor.selection[0]!;
  const cardFrame = lib.editor.commit('s', (tx) => tx.create('FRAME', lib.page, { name: 'Карточка', x: 400, width: 300, height: 200 }));
  const inner = lib.editor.placeInstance(button, { x: 410, y: 10 })!;
  lib.editor.commit('m', (tx) => tx.move(inner, cardFrame));
  lib.editor.setSelection([cardFrame]);
  lib.editor.createComponent();
  const card = lib.editor.selection[0]!;
  const publish = (): LibraryPayload => ({ ...buildLibrary(lib.doc), fileId: 'fLib0000001', name: 'Дизайн-система', publishedAt: Date.now() + Math.random() });
  const v1 = publish();
  assert.deepEqual(v1.components.map((c) => c.name).sort(), ['Карточка', 'Кнопка']);
  assert.ok(v1.variables.some((v) => v.id === brand), 'variables the components use come along');

  // Another file (its own session ids, as any other file) takes the card: the button it contains comes too, with the same ids.
  const appDoc = Document.createEmpty('Приложение', 'app');
  const app = { doc: appDoc, editor: new Editor(appDoc, new ApproximateTextMeasurer()), page: appDoc.pages()[0]! };
  const entry = v1.components.find((c) => c.name === 'Карточка')!;
  const placed = placeFromLibrary(app.editor, v1, entry, { x: 0, y: 0 })!;
  assert.equal(app.doc.type(placed), 'INSTANCE');
  assert.equal(app.doc.get(placed, 'mainComponent'), card);
  assert.ok(app.doc.store.isAlive(button), 'the component the card uses is taken too');
  assert.deepEqual(app.doc.pages(), [app.page], 'the hidden page is not in the page list');
  assert.equal(libraryOf(app.doc, button)?.name, 'Дизайн-система');
  assert.ok(app.doc.store.isAlive(brand) && app.doc.get(app.doc.libraryPage()!, 'libraryPage'));
  // A copy of the button with an own text.
  const ownButton = placeFromLibrary(app.editor, v1, v1.components.find((c) => c.name === 'Кнопка')!, { x: 0, y: 300 })!;
  const ownLabel = app.doc.children(ownButton).find((c) => app.doc.get(c, 'name') === 'Подпись')!;
  app.editor.commit('t', (tx) => tx.set(ownLabel, 'characters', 'Купить'));

  // The library changes: a new text, the highlight removed, a new height.
  const libLabel = lib.doc.children(button).find((c) => lib.doc.get(c, 'name') === 'Подпись')!;
  const libShine = lib.doc.children(button).find((c) => lib.doc.get(c, 'name') === 'Блик')!;
  lib.editor.commit('e', (tx) => {
    tx.set(libLabel, 'fontSize', 20);
    tx.set(libLabel, 'characters', 'Готово');
    tx.delete(libShine);
    tx.set(button, 'height', 48);
  });
  const v2 = publish();
  assert.equal(takenUnits(app.doc).get('fLib0000001')!.length, 2);
  assert.equal(updateFromLibrary(app.editor, v2), 2);
  assert.equal(app.doc.get(button, 'height'), 48);
  assert.ok(!app.doc.store.isAlive(libShine), 'what the library dropped is gone');
  assert.equal(app.doc.get(ownLabel, 'characters'), 'Купить', 'an own text of a copy is kept');
  assert.equal(app.doc.get(ownLabel, 'fontSize'), 20, 'other changes reach the copy');
  const cardButton = app.doc.children(placed)[0]!;
  const cardLabel = app.doc.children(cardButton).find((c) => app.doc.get(c, 'name') === 'Подпись')!;
  assert.equal(app.doc.get(cardLabel, 'characters'), 'Готово', 'copies inside copies follow too');
  assert.equal(app.doc.get(button, 'libraryRef')!.publishedAt, v2.publishedAt);
  // One undo step brings the old publication back.
  app.editor.undo();
  assert.equal(app.doc.get(button, 'height'), 40);
  assert.ok(app.doc.store.isAlive(libShine));

  // Taking it again changes nothing that is already there.
  app.editor.commit('again', (tx) => assert.ok(importFromLibrary(tx, app.doc, v1, [button])));
  assert.equal(app.doc.children(app.doc.libraryPage()!).length, 2);
});

test('tidy up (✦): names, whole pixels, spacing 1 px off the 4-grid, one undo step; the menu offers only what has work', async () => {
  const { snapSpacing, planTidy, applyTidy, tidySummary } = await import('../src/tidy.ts');
  const { smartActions } = await import('../src/smart.ts');
  assert.deepEqual([1, 3, 4, 6, 7, 10, 13, 15, 16, 0, 2.5].map(snapSpacing), [null, 4, null, null, 8, null, 12, 16, null, null, null]);
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { name: 'Frame 12', x: 10.4, y: 20, width: 200.6, height: 100, layoutMode: 'VERTICAL', itemSpacing: 7, paddingTop: 13, paddingLeft: 10 });
    const title = tx.create('TEXT', card, { name: 'Text', characters: 'Заголовок' });
    return { card, title };
  });
  const plan = planTidy(editor, [ids.card]);
  assert.deepEqual(plan.pixels.map((p) => [p.key, p.value]), [['x', 10], ['width', 201]]);
  assert.deepEqual(plan.spacing.map((p) => [p.key, p.value]), [['itemSpacing', 8], ['paddingTop', 12]], 'paddingLeft 10 stays');
  editor.setSelection([ids.card]);
  const menu = smartActions(editor);
  assert.equal(menu.actions[0]!.command, 'object.tidy');
  assert.equal(menu.actions[0]!.desc, tidySummary(plan));
  // Only these (28 Oct): the rest did poorly; screen templates are on the toolbar.
  assert.deepEqual(menu.actions.map((a) => a.command), ['object.tidy', 'smart.editLayout', 'smart.texts', 'object.autoName']);
  assert.ok(menu.actions.find((a) => a.command === 'smart.texts')!.ask, 'texts ask for a wish first');
  const done = applyTidy(editor, [ids.card]);
  assert.ok(done.names.size > 0);
  assert.equal(doc.get(ids.card, 'x'), 10);
  assert.equal(doc.get(ids.card, 'itemSpacing'), 8);
  assert.equal(doc.get(ids.card, 'paddingLeft'), 10);
  assert.notEqual(doc.get(ids.title, 'name'), 'Text');
  editor.undo();
  assert.equal(doc.get(ids.card, 'x'), 10.4, 'one step undoes all');
  assert.equal(doc.get(ids.card, 'itemSpacing'), 7);
  assert.equal(doc.get(ids.title, 'name'), 'Text');
  editor.redo();
  assert.equal(tidySummary(planTidy(editor, [ids.card])), '', 'nothing left: the menu does not offer it');
  assert.ok(!smartActions(editor).actions.some((a) => a.command === 'object.tidy'));
});

test('names of the HTML import are nobody\'s: «div.card», «section#hero», «::before», «img: …», «nav — …» get renamed; a person\'s names and file names stay', async () => {
  const { isDefaultName } = await import('../src/auto-name.ts');
  for (const n of ['div.dot', 'div.card', 'div.header', 'section#hero', 'div.card.big', 'li.item', '::before', 'border', 'border-left', 'img: Логотип', 'nav — Главное меню', 'div.accent-bar', 'span.chip-dot', 'spacer', 'marker', 'background', 'icon', 'chevron', 'td', 'table']) assert.equal(isDefaultName(n), true, n);
  for (const n of ['Кнопка', 'Карточка тарифа', 'v1.2', 'logo.png', 'Шапка.новая', 'Мой слой — версия 2']) assert.equal(isDefaultName(n), false, n);
});

test('names: the markup\'s name goes to the model; what neither it nor the rules name gets a name by its look — nothing keeps «::before» or «border»', async () => {
  const { nameLayers } = await import('../src/ai-text.ts');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { name: 'div.card', width: 400, height: 300 });
    const bar = tx.create('FRAME', card, { name: 'div.accent-bar', width: 400, height: 4, fills: [{ type: 'SOLID', color: { r: 1, g: 0.2, b: 0.5, a: 1 }, opacity: 1, visible: true }] });
    const before = tx.create('FRAME', card, { name: '::before', x: 20, y: 40, width: 8, height: 8 });
    const dot = tx.create('FRAME', card, { name: 'span.chip-dot', x: 40, y: 40, width: 6, height: 6 });
    const border = tx.create('RECTANGLE', card, { name: 'border', width: 400, height: 300, fills: [], strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] });
    const spacer = tx.create('FRAME', card, { name: 'spacer', y: 100, width: 400, height: 32, fills: [] });
    return { card, bar, before, dot, border, spacer };
  });
  const g = globalThis as Record<string, unknown>;
  const saved = g.fetch;
  let sent: Record<string, any> = {};
  g.fetch = async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    // The model names only the card and the bar.
    return new Response(JSON.stringify({ names: { '0': 'Карточка', '1': 'Акцентная полоса', '4': 'border' } }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.equal(await nameLayers(editor, [ids.card]), 6);
  } finally {
    g.fetch = saved;
  }
  assert.deepEqual(sent.items.map((i: { name: string }) => i.name), ['div.card', 'div.accent-bar', '::before', 'span.chip-dot', 'border', 'spacer']);
  assert.equal(doc.get(ids.bar, 'name'), 'Акцентная полоса');
  assert.equal(doc.get(ids.before, 'name'), 'Точка');
  assert.equal(doc.get(ids.dot, 'name'), 'Точка');
  assert.equal(doc.get(ids.border, 'name'), 'Рамка', 'the model\'s «border» is no name');
  assert.equal(doc.get(ids.spacer, 'name'), 'Отступ');
});

test('model texts and names (ai-text.ts): only layers go out, the answer lands as one undo step each, every default name by the model, the rules behind it', async () => {
  const { writeTexts, nameLayers, unnamedLayers } = await import('../src/ai-text.ts');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const screen = tx.create('FRAME', page, { name: 'Главная', width: 390, height: 800 });
    const box = tx.create('FRAME', screen, { name: 'Frame 3', width: 390, height: 100 });
    const title = tx.create('TEXT', box, { name: 'Text', characters: 'Title' });
    const label = tx.create('TEXT', box, { name: 'Text', characters: 'Button' });
    return { screen, box, title, label };
  });
  assert.deepEqual(unnamedLayers(editor, [ids.screen]), [ids.box, ids.title, ids.label], 'every default name, texts too');
  const sent: Record<string, any>[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = g.fetch;
  let answer: unknown = null;
  g.fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    answer = { texts: { '0': 'Свежая выпечка', '1': 'Заказать' } };
    assert.equal(await writeTexts(editor, [ids.screen], 'кофейня'), 2);
    assert.equal(sent[0]!.screen, 'Главная');
    assert.deepEqual(sent[0]!.items.map((i: { text: string }) => i.text), ['Title', 'Button']);
    assert.equal(doc.get(ids.title, 'characters'), 'Свежая выпечка');
    editor.undo();
    assert.equal(doc.get(ids.title, 'characters'), 'Title', 'one step');
    assert.equal(doc.get(ids.label, 'characters'), 'Button');
    // The model names what it can; what it leaves out takes the rules' name; one undo step.
    answer = { names: { '0': '«Промо»', '1': 'Заголовок акции' } };
    assert.equal(await nameLayers(editor, [ids.screen]), 3);
    assert.equal(sent[1]!.items[0].type, 'FRAME');
    assert.equal(sent[1]!.items[1].hint, 'Title', 'the rules\' guess goes along');
    assert.equal(doc.get(ids.box, 'name'), 'Промо');
    assert.equal(doc.get(ids.title, 'name'), 'Заголовок акции');
    assert.equal(doc.get(ids.label, 'name'), 'Button', 'left out by the model: the rules');
    editor.undo();
    assert.equal(doc.get(ids.box, 'name'), 'Frame 3', 'one step');
    // The model unreachable: an error for the caller, nothing changed (renameLayers falls back to the rules).
    g.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(nameLayers(editor, [ids.screen]), /Нет связи/);
    assert.equal(doc.get(ids.box, 'name'), 'Frame 3');
  } finally {
    g.fetch = saved;
  }
});

test('translate: the source language comes from the browser detector (German is not taken for English); unsure — the rough guess', async () => {
  const { translateTexts } = await import('../src/translate.ts');
  const g = globalThis as Record<string, unknown>;
  const pairs: string[] = [];
  g.Translator = {
    availability: async () => 'available',
    create: async (o: { sourceLanguage: string; targetLanguage: string }) => ({ translate: async (t: string) => (pairs.push(`${o.sourceLanguage}>${o.targetLanguage}`), `[${o.sourceLanguage}] ${t}`) }),
  };
  g.LanguageDetector = {
    create: async () => ({ detect: async (t: string) => (t.startsWith('Wohin') ? [{ detectedLanguage: 'de', confidence: 0.93 }] : [{ detectedLanguage: 'und', confidence: 0.2 }]) }),
  };
  try {
    const out = await translateTexts(['Wohin geht die Reise?', 'Куда отправимся?', 'Hello'], 'en');
    assert.deepEqual(out, ['[de] Wohin geht die Reise?', '[ru] Куда отправимся?', 'Hello']);
    assert.deepEqual(pairs, ['de>en', 'ru>en']);
  } finally {
    delete g.Translator;
    delete g.LanguageDetector;
  }
});

test('✦ colour maths: WCAG contrast, fixing it in the same hue, shades 50–900 around the colour itself, main colours, dark variants', async () => {
  const { contrast, fixContrast, shades, mainColors, darkVariant, hueName, toOklch, luminance } = await import('../src/color-math.ts');
  const white = { r: 1, g: 1, b: 1, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };
  assert.equal(Math.round(contrast(white, black)), 21);
  assert.equal(contrast(white, white), 1);
  const grey = { r: 0.6, g: 0.6, b: 0.6, a: 1 };
  assert.ok(contrast(grey, white) < 4.5);
  const fixed = fixContrast(grey, white, 4.5);
  assert.ok(contrast(fixed, white) >= 4.5 && contrast(fixed, white) < 5, 'just enough, not black');
  const orange = { r: 1, g: 0.55, b: 0.2, a: 1 };
  const o2 = fixContrast(orange, white, 4.5);
  assert.ok(contrast(o2, white) >= 4.5);
  assert.ok(Math.abs(toOklch(o2).h - toOklch(orange).h) < 8, 'the hue stays');
  const blue = { r: 0.05, g: 0.6, b: 1, a: 1 };
  const list = shades(blue);
  assert.deepEqual(list.map((s) => s.stop), [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.equal(list.filter((s) => s.source).length, 1);
  assert.deepEqual(list.find((s) => s.source)!.color, blue);
  for (let i = 1; i < list.length; i++) assert.ok(luminance(list[i]!.color) < luminance(list[i - 1]!.color), 'each darker than the one before');
  assert.equal(hueName(blue), 'Синий');
  assert.equal(hueName(white), 'Белый');
  // Picture: 70 % sand, 30 % deep blue, a few stray pixels.
  const px = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) px.set(i < 70 ? [236, 214, 170, 255] : i < 99 ? [20, 40, 120, 255] : [255, 0, 0, 255], i * 4);
  const main = mainColors(px, 6);
  assert.equal(main.length, 2, 'stray pixels are dropped');
  assert.ok(Math.abs(main[0]!.share - 0.7) < 0.01);
  assert.equal(hueName(main[0]!.color), 'Песочный');
  assert.ok(luminance(darkVariant(white)) < 0.03, 'white background → near black');
  assert.ok(luminance(darkVariant({ r: 0.12, g: 0.12, b: 0.12, a: 1 })) > 0.6, 'dark text → light');
  assert.ok(toOklch(darkVariant(blue)).c > 0.1, 'an accent keeps its colour');
});

test('✦ fill with data: kinds by the text, the format kept, ordinary labels left alone, repeats become different', async () => {
  const { dataKind, sampleValue, planFillData } = await import('../src/fill-data.ts');
  assert.equal(dataKind('от 38 000 ₽', false), 'price');
  assert.equal(dataKind('14 июля', false), 'date');
  assert.equal(dataKind('14.07.2026', false), 'date');
  assert.equal(dataKind('09:30', false), 'time');
  assert.equal(dataKind('9:41', false), null, 'the status bar of a phone mock-up');
  assert.equal(dataKind('+7 999 123-45-67', false), 'phone');
  assert.equal(dataKind('anna@mail.ru', false), 'email');
  assert.equal(dataKind('Анна Смирнова', false), 'name');
  assert.equal(dataKind('Text', false), 'title');
  assert.equal(dataKind('Lorem ipsum dolor sit amet', false), 'text');
  assert.equal(dataKind('Забронировать', false), null, 'a label stays');
  assert.equal(dataKind('Байкал', false), 'place');
  assert.equal(dataKind('Горы', true), 'place', 'a repeated word');
  assert.equal(dataKind('Популярное', false), null);
  assert.match(sampleValue('price', 1, 'от 38 000 ₽'), /^от \d{1,3} \d{3} ₽$/);
  assert.match(sampleValue('date', 2, '14.07.2026'), /^\d{2}\.\d{2}\.2026$/);
  assert.match(sampleValue('price', 3, '$49.99'), /^\$\d+\.\d{2}$/);
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const list = tx.create('FRAME', page, { name: 'Список' });
    const out: NodeId[] = [];
    for (let i = 0; i < 3; i++) {
      const card = tx.create('FRAME', list, { name: 'Карточка' });
      out.push(tx.create('TEXT', card, { characters: 'Байкал' }), tx.create('TEXT', card, { characters: 'от 38 000 ₽' }), tx.create('TEXT', card, { characters: 'Подробнее' }));
    }
    return { list, texts: out };
  });
  const plan = planFillData(doc, [ids.list], () => false);
  const titles = plan.filter((p) => p.kind === 'place').map((p) => p.text);
  assert.equal(new Set(titles).size, 3, 'three different places');
  assert.ok(!titles.includes('Байкал'), 'no «replacing» with the same text');
  assert.equal(plan.filter((p) => p.kind === 'price').length, 3);
  assert.ok(!plan.some((p) => doc.get(p.id, 'characters') === 'Подробнее'), 'a repeated button label is not data');
});

test('✦ contrast, text styles, palettes, a dark theme and the same picture — each one undo step', async () => {
  const ops = await import('../src/smart-ops.ts');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { width: 300, height: 200, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] });
    const pale = tx.create('TEXT', card, { characters: 'Подпись', fontSize: 12, fills: [{ type: 'SOLID', color: { r: 0.7, g: 0.7, b: 0.7, a: 1 }, opacity: 1, visible: true }] });
    const big = tx.create('TEXT', card, { y: 40, characters: 'Заголовок', fontSize: 32, fontWeight: 700, fills: [{ type: 'SOLID', color: { r: 0.45, g: 0.45, b: 0.45, a: 1 }, opacity: 1, visible: true }] });
    const style = tx.create('STYLE', doc.rootId, { name: 'Заголовок / H1', styleType: 'TEXT', fontSize: 32, fontWeight: 700 });
    const img = tx.create('RECTANGLE', page, { x: 400, fills: [{ type: 'IMAGE', imageHash: 'h1', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] as never });
    const img2 = tx.create('RECTANGLE', page, { x: 600, fills: [{ type: 'IMAGE', imageHash: 'h1', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] as never });
    return { card, pale, big, style, img, img2 };
  });
  editor.scene.ensure();
  const issues = ops.contrastIssues(editor, [ids.card]);
  assert.deepEqual(issues.map((i) => i.id), [ids.pale], 'the big text passes at 3:1');
  assert.equal(ops.fixContrastIssues(editor, issues), 1);
  assert.equal(ops.contrastIssues(editor, [ids.card]).length, 0);
  editor.undo();
  assert.equal(ops.contrastIssues(editor, [ids.card]).length, 1);

  const matches = ops.textStyleMatches(editor, [ids.card]);
  assert.deepEqual(matches, [{ id: ids.big, style: ids.style }]);
  ops.bindTextStyles(editor, matches);
  assert.equal(doc.get(ids.big, 'textStyleId'), ids.style);

  assert.deepEqual([...ops.sameImages(editor, [ids.img]).values()], [[ids.img2]]);

  const res = ops.createShades(editor, ids.card)!;
  assert.equal(res.count, 10);
  const palette = doc.collections().find((c) => doc.get(c, 'name') === 'Палитра')!;
  assert.equal(doc.children(palette).length, 10);
  assert.ok(doc.get(ids.card, 'boundVariables')?.['fills/0'], 'the layer is bound to its own shade');
  editor.undo();
  assert.equal(doc.collections().length, 0, 'one step: collection, variables and binding');
  editor.redo();

  assert.deepEqual(ops.darkThemeCandidates(editor), [palette]);
  const n = ops.createDarkTheme(editor, palette, [ids.card]);
  assert.equal(n, 10);
  assert.deepEqual(doc.get(palette, 'modes').map((m) => m.name), ['Режим 1', 'Тёмная']);
  assert.ok(doc.get(ids.card, 'variableModes')?.[palette]);
  assert.deepEqual(ops.darkThemeCandidates(editor), [], 'one dark mode is enough');
  editor.undo();
  assert.equal(doc.get(palette, 'modes').length, 1);
});

test('✦ repeats → component: blocks built the same way become a component and instances keeping their own texts; one undo step', async () => {
  const { findRepeats, applyRepeats } = await import('../src/repeats.ts');
  const { doc, editor, page } = setup();
  const white = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] as never;
  const ids = editor.commit('setup', (tx) => {
    const list = tx.create('FRAME', page, { name: 'Список', width: 800, height: 300 });
    const cards: NodeId[] = [];
    ['Алтай', 'Байкал', 'Карелия'].forEach((place, i) => {
      const card = tx.create('FRAME', list, { name: 'Карточка', x: i * 250, width: 200, height: 120, fills: white, cornerRadius: 12 });
      tx.create('RECTANGLE', card, { name: 'Фото', width: 200, height: 80 });
      tx.create('TEXT', card, { name: 'Место', y: 90, characters: place });
      cards.push(card);
    });
    // Built differently (no photo): not a repeat of the cards.
    const other = tx.create('FRAME', list, { name: 'Другое', x: 0, y: 200, width: 200, height: 40, fills: white, cornerRadius: 12 });
    tx.create('TEXT', other, { characters: 'Подробнее' });
    tx.create('TEXT', other, { characters: '→' });
    return { list, cards, other };
  });
  const groups = findRepeats(editor, [ids.list]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.ids, ids.cards);
  const [component] = applyRepeats(editor, groups);
  assert.equal(doc.type(component!), 'COMPONENT');
  const kids = doc.children(ids.list);
  const instances = kids.filter((k) => doc.type(k) === 'INSTANCE');
  assert.equal(instances.length, 2);
  const textOf = (id: NodeId) => doc.get(doc.children(id).find((c) => doc.type(c) === 'TEXT')!, 'characters');
  assert.deepEqual([component!, ...instances].map(textOf), ['Алтай', 'Байкал', 'Карелия'], 'each keeps its own text');
  assert.deepEqual(instances.map((i) => doc.get(i, 'x')), [250, 500], 'in place');
  assert.ok(doc.store.isAlive(ids.other), 'a different block stays');
  editor.undo();
  assert.deepEqual(doc.children(ids.list).map((k) => doc.type(k)), ['FRAME', 'FRAME', 'FRAME', 'FRAME']);
  assert.deepEqual(ids.cards.map(textOf), ['Алтай', 'Байкал', 'Карелия']);
});

test('✦ clean up layers: empty groups and frames, groups of one, wrapper frames — nothing moves on screen', async () => {
  const { planCleanup, applyCleanup, cleanupCount } = await import('../src/cleanup.ts');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const screen = tx.create('FRAME', page, { name: 'Экран', width: 400, height: 400, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] });
    const emptyFrame = tx.create('FRAME', screen, { name: 'Frame 1', x: 10, y: 10, width: 50, height: 50, fills: [] });
    const wrap = tx.create('FRAME', screen, { name: 'Frame 2', x: 100, y: 100, width: 80, height: 30, fills: [], clipsContent: false });
    const title = tx.create('TEXT', wrap, { characters: 'Заголовок', x: 0, y: 0, width: 80, height: 30, textAutoResize: 'NONE' });
    const styled = tx.create('FRAME', screen, { name: 'Кнопка', x: 200, y: 200, width: 80, height: 30, fills: [{ type: 'SOLID', color: { r: 0, g: 0.5, b: 1, a: 1 }, opacity: 1, visible: true }] });
    tx.create('TEXT', styled, { characters: 'OK', x: 0, y: 0, width: 80, height: 30, textAutoResize: 'NONE' });
    return { screen, emptyFrame, wrap, title, styled };
  });
  editor.scene.ensure();
  const before = editor.scene.bounds(ids.title);
  const plan = planCleanup(editor, [ids.screen]);
  assert.deepEqual(plan.empty, [ids.emptyFrame]);
  assert.deepEqual(plan.wrappers, [ids.wrap], 'a styled frame (the button) is not a wrapper');
  assert.equal(cleanupCount(plan), 2);
  applyCleanup(editor, [ids.screen]);
  editor.scene.ensure();
  assert.equal(doc.parent(ids.title), ids.screen);
  assert.deepEqual(editor.scene.bounds(ids.title), before, 'the text stays where it was');
  assert.ok(!doc.store.isAlive(ids.emptyFrame) && !doc.store.isAlive(ids.wrap));
  assert.ok(doc.store.isAlive(ids.styled));
  editor.undo();
  assert.equal(doc.parent(ids.title), ids.wrap);
});

test('✦ two copies of a whole screen (a form drawn twice): not a component, and its labels are not «data»', async () => {
  const { findRepeats } = await import('../src/repeats.ts');
  const { planFillData } = await import('../src/fill-data.ts');
  const { doc, editor, page } = setup();
  const screens = editor.commit('setup', (tx) =>
    [0, 1].map((i) => {
      const screen = tx.create('FRAME', page, { name: `Опросный лист ${i + 1}`, x: i * 500, width: 400, height: 600 });
      for (const label of ['Технический специалист', 'Персональный менеджер', 'SIP-порт']) {
        const row = tx.create('FRAME', screen, { name: 'Строка', width: 360, height: 40 });
        tx.create('TEXT', row, { characters: label });
        tx.create('RECTANGLE', row, { name: 'Поле', x: 200, width: 160, height: 32 });
      }
      return screen;
    }),
  );
  const groups = findRepeats(editor, [...doc.children(page)]);
  assert.ok(groups.every((g) => g.ids.every((id) => !screens.includes(id))), 'whole screens stay screens');
  assert.equal(planFillData(doc, screens, () => false).length, 0, 'form labels repeated on the copy are not data');
});

test('on a board, distribute spreads overlapping objects apart instead of leaving them piled (BUG-068)', () => {
  const { doc, editor, page } = setup();
  editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  const ids = editor.commit('setup', (tx) => [
    tx.create('FRAME', page, { x: 0, y: 0, width: 240, height: 240 }),
    tx.create('FRAME', page, { x: 100, y: 50, width: 240, height: 240 }),
    tx.create('FRAME', page, { x: 60, y: 120, width: 300, height: 200 }),
  ]);
  editor.setSelection(ids);
  editor.distribute('x');
  const xs = ids.map((id) => [doc.get(id, 'x'), doc.get(id, 'width')] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i]![0] >= xs[i - 1]![0] + xs[i - 1]![1] + 24 - 0.01, 'no overlap, at least 24 px apart');
});

test('batch rename: $& keeps the name, $n / $nn / $N number, find and replace inside names', async () => {
  const { renameAll } = await import('../src/batch-rename.ts');
  assert.deepEqual(renameAll(['Rectangle 1', 'Rectangle 2', 'Rectangle 3'], { pattern: 'Card $n', find: '', replace: '', start: 1 }), ['Card 1', 'Card 2', 'Card 3']);
  assert.deepEqual(renameAll(['a', 'b'], { pattern: '$nn-$&', find: '', replace: '', start: 9 }), ['09-a', '10-b']);
  assert.deepEqual(renameAll(['a', 'b', 'c'], { pattern: '$N', find: '', replace: '', start: 1 }), ['3', '2', '1']);
  assert.deepEqual(renameAll(['Icon / old', 'Icon / old 2'], { pattern: '$&', find: 'old', replace: 'new', start: 1 }), ['Icon / new', 'Icon / new 2']);
  // Regular expressions: every match, $1 for a group; a broken one changes nothing.
  assert.deepEqual(renameAll(['Frame 12', 'Frame 7'], { pattern: '$&', find: '^Frame (\\d+)$', replace: 'Экран $1', regex: true, start: 1 }), ['Экран 12', 'Экран 7']);
  assert.deepEqual(renameAll(['a.b.c'], { pattern: '', find: '.', replace: '-', regex: false, start: 1 }), ['a-b-c']);
  assert.deepEqual(renameAll(['a.b.c'], { pattern: '', find: '[', replace: '-', regex: true, start: 1 }), ['a.b.c']);
  assert.deepEqual(renameAll(['x$n'], { pattern: '[$&]', find: '', replace: '', start: 1 }), ['[x$n]'], 'a "$" inside the old name stays as it is');
});

test('batch rename numbers layers top down as in the layers panel; select matching finds the same-looking layers', async () => {
  const { renameSelection, matchingLayers } = await import('../src/batch-rename.ts');
  const { editor, page, doc } = setup();
  const fill = [{ type: 'SOLID' as const, color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }];
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('RECTANGLE', page, { name: 'a', width: 40, height: 40, fills: fill });
    const b = tx.create('RECTANGLE', page, { name: 'b', x: 50, width: 40, height: 40, fills: fill });
    const c = tx.create('RECTANGLE', page, { name: 'c', x: 100, width: 40, height: 20, fills: fill });
    const frame = tx.create('FRAME', page, { name: 'f', x: 200, width: 100, height: 100 });
    const d = tx.create('RECTANGLE', frame, { name: 'd', width: 40, height: 40, fills: fill });
    return { a, b, c, d };
  });
  editor.setSelection([ids.a, ids.b]);
  assert.equal(renameSelection(editor, { pattern: 'Item $n', find: '', replace: '', start: 1 }), 2);
  assert.equal(doc.get(ids.b, 'name'), 'Item 1', 'the front one (top of the panel) is first');
  assert.equal(doc.get(ids.a, 'name'), 'Item 2');
  editor.setSelection([ids.a]);
  assert.deepEqual(new Set(matchingLayers(editor)), new Set([ids.a, ids.b, ids.d]), 'same size and fill, also inside a frame; a different size is not matched');
});

test('flip mirrors layers on screen around the selection centre; rotate90 turns around each centre (FEAT-120)', () => {
  const { editor, doc, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('RECTANGLE', page, { x: 0, y: 0, width: 100, height: 50, cornerRadii: [20, 0, 0, 0] });
    const b = tx.create('RECTANGLE', page, { x: 200, y: 0, width: 100, height: 50 });
    const v = tx.create('VECTOR', page, { x: 0, y: 100, width: 10, height: 10, vectorPaths: [{ closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] });
    const p = tx.create('POLYGON', page, { x: 0, y: 200, width: 40, height: 30, pointCount: 3 });
    return { a, b, v, p };
  });
  editor.setSelection([ids.a, ids.b]);
  editor.flip('H');
  assert.deepEqual([doc.get(ids.a, 'x'), doc.get(ids.b, 'x')], [200, 0], 'the two swap sides around the selection centre');
  assert.deepEqual(doc.get(ids.a, 'cornerRadii'), [0, 20, 0, 0], 'the rounded corner goes to the other side');
  editor.setSelection([ids.v]);
  editor.flip('H');
  assert.deepEqual(doc.get(ids.v, 'vectorPaths')[0]!.points.map((q) => [q.x, q.y]), [[10, 0], [0, 10]]);
  editor.setSelection([ids.p]);
  editor.flip('V');
  assert.equal(doc.get(ids.p, 'rotation'), 180, 'a triangle upside down is the same triangle turned half round');
  const pb = editor.scene.bounds(ids.p);
  assert.deepEqual([pb.x, pb.y, pb.width, pb.height].map((n) => Math.round(n * 100) / 100 + 0), [0, 200, 40, 30], 'it stays in place');
  editor.setSelection([ids.b]);
  editor.rotate90();
  assert.equal(doc.get(ids.b, 'rotation'), 90);
  const box = editor.scene.bounds(ids.b);
  assert.deepEqual([box.x + box.width / 2, box.y + box.height / 2].map((n) => Math.round(n * 100) / 100 + 0), [50, 25], 'around its centre');
});

test('variables on gradient stops: bound stop follows the variable, moving the stop keeps the binding, editing its colour unbinds', () => {
  const { editor, doc, page } = setup();
  const vars = editor.variables;
  const coll = vars.createCollection('Цвета');
  const mode = doc.get(coll, 'modes')[0]!.id;
  const brand = vars.createVariable(coll, 'COLOR', 'Brand', { r: 0, g: 0.5, b: 1, a: 1 });
  const [rect] = editor.commit('s', (tx) => [
    tx.create('RECTANGLE', page, {
      width: 100,
      height: 50,
      fills: [{ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, stops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }], opacity: 1, visible: true }],
    }),
  ]);
  editor.setSelection([rect!]);
  assert.equal(vars.bind('fills/0/stops/1', brand), 1);
  const stop = () => {
    const f = doc.get(rect!, 'fills')[0]!;
    return f.type === 'GRADIENT_LINEAR' ? f.stops[1]! : null;
  };
  assert.deepEqual(stop()!.color, { r: 0, g: 0.5, b: 1, a: 1 });
  vars.setValue(brand, mode, { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(stop()!.color, { r: 1, g: 0, b: 0, a: 1 });
  // Moving the stop changes the paint but not its colour: still bound.
  editor.commit('move stop', (tx) => {
    const f = doc.get(rect!, 'fills')[0]!;
    if (f.type === 'GRADIENT_LINEAR') tx.set(rect!, 'fills', [{ ...f, stops: [f.stops[0]!, { ...f.stops[1]!, position: 0.8 }] }]);
  });
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0/stops/1'], brand);
  // A colour typed over it unbinds just that stop.
  editor.commit('recolour', (tx) => {
    const f = doc.get(rect!, 'fills')[0]!;
    if (f.type === 'GRADIENT_LINEAR') tx.set(rect!, 'fills', [{ ...f, stops: [f.stops[0]!, { ...f.stops[1]!, color: { r: 0, g: 1, b: 0, a: 1 } }] }]);
  });
  assert.equal(doc.get(rect!, 'boundVariables')?.['fills/0/stops/1'], undefined);
});

test('flip mirrors a picture in the fill; rotate 90 turns once', () => {
  const { editor, doc, page } = setup();
  const [rect] = editor.commit('s', (tx) => [tx.create('RECTANGLE', page, { width: 100, height: 50, fills: [{ type: 'IMAGE', imageHash: 'h', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] })]);
  editor.setSelection([rect!]);
  const img = () => doc.get(rect!, 'fills')[0] as { flipX?: boolean; flipY?: boolean };
  editor.flip('H');
  assert.equal(img().flipX, true);
  editor.flip('H');
  assert.equal(img().flipX, undefined, 'twice — as it was');
  editor.flip('V');
  assert.equal(img().flipY, true);
  editor.rotate90();
  assert.equal(doc.get(rect!, 'rotation'), 90);
});

test('shape builder: overlapping shapes cut into areas; a click takes one out, a drag merges, Alt removes; undo brings the layers back', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { name: 'Левый', x: 0, y: 0, width: 100, height: 100 }),
    tx.create('RECTANGLE', page, { name: 'Правый', x: 50, y: 0, width: 100, height: 100 }),
  ]);
  editor.setSelection(ids);
  editor.startShapeBuilder();
  const cells = editor.shapeBuilder!.cells;
  assert.equal(cells.length, 3);
  const box = (id: NodeId) => [doc.get(id, 'x'), doc.get(id, 'y'), doc.get(id, 'width'), doc.get(id, 'height')];
  // The overlap taken out: three layers side by side, still in the builder.
  editor.applyShapeBuilder([cells.findIndex((c) => c.owners.length === 2)], false);
  let layers = doc.children(page);
  assert.deepEqual(layers.map(box), [[0, 0, 50, 100], [100, 0, 50, 100], [50, 0, 50, 100]]);
  assert.deepEqual(layers.map((id) => doc.get(id, 'name')), ['Левый', 'Правый', 'Правый']);
  assert.equal(editor.shapeBuilder!.cells.length, 3);
  // A drag across all three: one layer.
  editor.applyShapeBuilder([0, 1, 2], false);
  layers = doc.children(page);
  assert.deepEqual(layers.map(box), [[0, 0, 150, 100]]);
  // Alt: the area goes, nothing is left.
  editor.applyShapeBuilder([0], true);
  assert.equal(doc.children(page).length, 0);
  assert.equal(editor.shapeBuilder, null);
  editor.undo();
  editor.undo();
  editor.undo();
  assert.deepEqual(doc.children(page).map((id) => doc.type(id)), ['RECTANGLE', 'RECTANGLE']);
});

test('repeat groups: copies in a row or round a circle follow the original; a click on a copy takes the group; they can become plain layers', () => {
  const { doc, editor, page } = setup();
  const rect = editor.commit('setup', (tx) => tx.create('RECTANGLE', page, { name: 'Плитка', x: 0, y: 0, width: 20, height: 10 }));
  editor.setSelection([rect]);
  editor.addRepeat('LINEAR');
  const group = editor.selection[0]!;
  assert.equal(doc.type(group), 'GROUP');
  const xs = () => doc.children(group).map((id) => doc.get(id, 'x'));
  assert.deepEqual(xs(), [0, 30, 60]);
  assert.deepEqual(doc.children(group).map((id) => doc.get(id, 'repeatCopy')), [false, true, true]);
  // The original changes: so do the copies.
  editor.commit('wider', (tx) => tx.set(rect, 'width', 40));
  assert.deepEqual(xs(), [0, 50, 100]);
  assert.deepEqual(doc.children(group).map((id) => doc.get(id, 'width')), [40, 40, 40]);
  editor.commit('count', (tx) => tx.set(group, 'repeat', { ...doc.get(group, 'repeat')!, count: 5 }));
  assert.equal(doc.children(group).length, 5);
  assert.equal(editor.selectableFor(doc.children(group)[3]!, false), group);
  // Round a circle: copies turned evenly.
  editor.setSelection([group]);
  editor.addRepeat('RADIAL');
  assert.deepEqual(doc.children(group).map((id) => Math.round(doc.get(id, 'rotation'))), [0, 72, 144, 216, 288]);
  editor.removeRepeat(true);
  assert.equal(doc.get(group, 'repeat'), null);
  assert.ok(doc.children(group).every((id) => !doc.get(id, 'repeatCopy')));
  assert.equal(doc.children(group).length, 5);
});

test('grid min-cut (Boykov–Kolmogorov) agrees with a plain max-flow on random grids', async () => {
  const { gridMinCut } = await import('../src/segment.ts');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  for (let trial = 0; trial < 40; trial++) {
    const w = 3 + Math.floor(rnd() * 5);
    const h = 3 + Math.floor(rnd() * 5);
    const n = w * h;
    const source = new Float64Array(n);
    const sink = new Float64Array(n);
    const cap = new Float64Array(n * 8);
    for (let p = 0; p < n; p++) {
      source[p] = rnd() < 0.5 ? rnd() * 10 : 0;
      sink[p] = rnd() < 0.5 ? rnd() * 10 : 0;
      for (let d = 0; d < 8; d++) {
        const x = (p % w) + DX[d]!;
        const y = Math.floor(p / w) + DY[d]!;
        if (x >= 0 && y >= 0 && x < w && y < h) cap[p * 8 + d] = rnd() * 6;
      }
    }
    const side = gridMinCut(w, h, source, sink, cap.slice());
    // The cut's value: terminal links cut plus edges from the source side to the sink side.
    let value = 0;
    for (let p = 0; p < n; p++) {
      value += side[p] ? sink[p]! : source[p]!;
      if (!side[p]) continue;
      for (let d = 0; d < 8; d++) {
        const x = (p % w) + DX[d]!;
        const y = Math.floor(p / w) + DY[d]!;
        if (x >= 0 && y >= 0 && x < w && y < h && !side[y * w + x]) value += cap[p * 8 + d]!;
      }
    }
    // Edmonds–Karp on the same graph (node n = source, n + 1 = sink).
    const N = n + 2;
    const c: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
    const add = (u: number, v: number, x: number) => {
      c[u]![v] = c[u]![v]! + x;
    };
    for (let p = 0; p < n; p++) {
      add(n, p, source[p]!);
      add(p, n + 1, sink[p]!);
      for (let d = 0; d < 8; d++) {
        const x = (p % w) + DX[d]!;
        const y = Math.floor(p / w) + DY[d]!;
        if (x >= 0 && y >= 0 && x < w && y < h) add(p, y * w + x, cap[p * 8 + d]!);
      }
    }
    let flow = 0;
    for (;;) {
      const prev = new Array<number>(N).fill(-1);
      prev[n] = n;
      const q = [n];
      while (q.length && prev[n + 1]! < 0) {
        const u = q.shift()!;
        for (let v = 0; v < N; v++) {
          if (prev[v]! < 0 && c[u]![v]! > 1e-12) {
            prev[v] = u;
            q.push(v);
          }
        }
      }
      if (prev[n + 1]! < 0) break;
      let b = Infinity;
      for (let v = n + 1; v !== n; v = prev[v]!) b = Math.min(b, c[prev[v]!]![v]!);
      for (let v = n + 1; v !== n; v = prev[v]!) {
        add(prev[v]!, v, -b);
        add(v, prev[v]!, b);
      }
      flow += b;
    }
    assert.ok(Math.abs(value - flow) < 1e-6, `trial ${trial}: cut ${value} vs flow ${flow}`);
  }
});

test('smart symbols while typing: dashes, arrows, ellipsis, quotes by language', async () => {
  const { smartReplace } = await import('../src/smart-symbols.ts');
  const run = (typed: string, text = typed) => {
    let out = '';
    for (const ch of typed) {
      out += ch;
      const r = smartReplace(out, text);
      if (r) out = out.slice(0, out.length - r.remove) + r.insert;
    }
    return out;
  };
  assert.equal(run('a--b'), 'a—b');
  assert.equal(run('слово - слово'), 'слово — слово');
  assert.equal(run('A -> B <- C <-> D'), 'A → B ← C ↔ D');
  assert.equal(run('Ждите...'), 'Ждите…');
  assert.equal(run('(c) 2026'), '© 2026');
  assert.equal(run('Он сказал "привет"'), 'Он сказал «привет»');
  assert.equal(run('"Цитата "внутри" цитаты"'), '«Цитата „внутри“ цитаты»');
  assert.equal(run('She said "hi"'), 'She said “hi”');
  assert.equal(run("don't"), 'don’t');
  assert.equal(run('x >= 1'), 'x ≥ 1');
});

test('code layer: a click on a layer made from the code takes the code layer; without code the layers are plain', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const code = tx.create('FRAME', page, { width: 200, height: 100, code: '<p>Hi</p>' });
    const result = tx.create('FRAME', code, { width: 200, height: 100 });
    const text = tx.create('TEXT', result, { characters: 'Hi' });
    return { code, text };
  });
  assert.equal(editor.selectableFor(ids.text, false), ids.code);
  assert.equal(editor.selectableFor(ids.text, true), ids.code);
  editor.commit('plain', (tx) => tx.set(ids.code, 'code', null));
  assert.equal(editor.codeLayerOf(ids.text), null);
  assert.notEqual(editor.selectableFor(ids.text, true), ids.code);
  assert.equal(doc.get(ids.code, 'code'), null);
});

test('suggest auto layout: a card becomes a column, buttons side by side a row, the background stays out of the flow; nothing moves', async () => {
  const { suggestAutoLayout } = await import('../src/suggest-layout.ts');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { x: 100, y: 100, width: 400, height: 300 });
    const bg = tx.create('RECTANGLE', card, { name: 'bg', x: 0, y: 0, width: 400, height: 300 });
    const title = tx.create('RECTANGLE', card, { name: 'title', x: 24, y: 24, width: 200, height: 40 });
    const b1 = tx.create('RECTANGLE', card, { name: 'b1', x: 24, y: 80, width: 100, height: 40 });
    const b2 = tx.create('RECTANGLE', card, { name: 'b2', x: 136, y: 80, width: 100, height: 40 });
    const b3 = tx.create('RECTANGLE', card, { name: 'b3', x: 248, y: 80, width: 100, height: 40 });
    const note = tx.create('RECTANGLE', card, { name: 'note', x: 24, y: 136, width: 300, height: 20 });
    return { card, bg, title, b1, b2, b3, note };
  });
  const world = (id: string) => editor.scene.bounds(id);
  const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, world(id)]));
  editor.setSelection([ids.card]);
  suggestAutoLayout(editor);
  assert.equal(doc.get(ids.card, 'layoutMode'), 'VERTICAL');
  assert.equal(doc.get(ids.card, 'itemSpacing'), 16);
  assert.equal(doc.get(ids.bg, 'positioning'), 'ABSOLUTE');
  const row = doc.parent(ids.b1)!;
  assert.equal(doc.get(row, 'layoutMode'), 'HORIZONTAL');
  assert.equal(doc.get(row, 'itemSpacing'), 12);
  assert.deepEqual(doc.children(row), [ids.b1, ids.b2, ids.b3]);
  assert.deepEqual([doc.get(ids.card, 'width'), doc.get(ids.card, 'height')], [400, 300]);
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(world(id), before[k], k);
  editor.undo();
  assert.equal(doc.parent(ids.b1), ids.card);
});

test('remove all auto layout: the selection and the frames inside lose it, every layer stays where it was and keeps its size', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { x: 0, y: 0, width: 300, height: 200, layoutMode: 'VERTICAL', itemSpacing: 10, paddingTop: 20, paddingLeft: 20, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
    const row = tx.create('FRAME', card, { width: 200, height: 40, layoutMode: 'HORIZONTAL', itemSpacing: 8, sizingH: { mode: 'HUG' } });
    const a = tx.create('RECTANGLE', row, { width: 30, height: 30 });
    const b = tx.create('RECTANGLE', row, { width: 50, height: 30, sizingV: { mode: 'FILL' } });
    const text = tx.create('RECTANGLE', card, { width: 120, height: 20, sizingH: { mode: 'FILL' } });
    return { card, row, a, b, text };
  });
  const world = (id: string) => editor.scene.bounds(id);
  const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, world(id)]));
  editor.setSelection([ids.card]);
  editor.removeAllAutoLayout();
  assert.equal(doc.get(ids.card, 'layoutMode'), 'NONE');
  assert.equal(doc.get(ids.row, 'layoutMode'), 'NONE');
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(world(id), before[k], k);
  assert.equal(doc.get(ids.text, 'sizingH').mode, 'FIXED');
  editor.undo();
  assert.equal(doc.get(ids.row, 'layoutMode'), 'HORIZONTAL');
});

test('repeat copies keep their ids: moving the group leaves them, editing the original updates them in place', () => {
  const { doc, editor, page } = setup();
  const rect = editor.commit('setup', (tx) => tx.create('RECTANGLE', page, { x: 0, y: 0, width: 20, height: 40 }));
  editor.setSelection([rect]);
  editor.addRepeat('RADIAL');
  const group = editor.selection[0]!;
  editor.commit('count', (tx) => tx.set(group, 'repeat', { ...doc.get(group, 'repeat')!, count: 10 }));
  const copies = () => doc.children(group).filter((id) => doc.get(id, 'repeatCopy'));
  const ids = copies();
  assert.equal(ids.length, 9);
  const before = ids.map((id) => [doc.get(id, 'x'), doc.get(id, 'y')]);
  editor.commit('move', (tx) => tx.update(group, { x: doc.get(group, 'x') + 50 }));
  assert.deepEqual(copies(), ids, 'moving the group keeps the copies');
  assert.deepEqual(ids.map((id) => [doc.get(id, 'x'), doc.get(id, 'y')]), before, 'inside the group they stay put');
  editor.commit('colour', (tx) => tx.set(rect, 'cornerRadius', 6));
  assert.deepEqual(copies(), ids, 'an edit of the original updates the same copies');
  assert.ok(ids.every((id) => doc.get(id, 'cornerRadius') === 6));
  editor.commit('fewer', (tx) => tx.set(group, 'repeat', { ...doc.get(group, 'repeat')!, count: 4 }));
  assert.deepEqual(copies(), ids.slice(0, 3));
  assert.deepEqual(doc.children(group).map((id) => Math.round(doc.get(id, 'rotation'))), [0, 90, 180, 270]);
});

test('a repeat round a circle resized: the circle and the copies scale together, keeping proportions', () => {
  const { doc, editor, page } = setup();
  const rect = editor.commit('setup', (tx) => tx.create('RECTANGLE', page, { x: 0, y: 0, width: 20, height: 40 }));
  editor.setSelection([rect]);
  editor.addRepeat('RADIAL');
  const group = editor.selection[0]!;
  const radius = doc.get(group, 'repeat')!.radius;
  const w = doc.get(group, 'width');
  const h = doc.get(group, 'height');
  // Pulled a little wider than tall, frame by frame, like a corner handle.
  const gesture = editor.beginGesture('resize');
  for (let i = 1; i <= 10; i++) gesture.update((tx) => editor.applySize(tx, group, w * (1 - 0.04 * i), h * (1 - 0.03 * i), true, true));
  gesture.commit();
  const r = doc.get(group, 'repeat')!.radius;
  assert.ok(r < radius * 0.8 && r > radius * 0.6, `radius ${radius} → ${r}`);
  assert.ok(Math.abs(doc.get(rect, 'width') / doc.get(rect, 'height') - 0.5) < 1e-6);
});

test('scale tool: a layer and everything in it scale together — strokes, text, radii, effects, auto layout gaps', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const card = tx.create('FRAME', page, { x: 10, y: 10, width: 200, height: 100, cornerRadius: 12, strokeWeight: 2, layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 16, paddingLeft: 16, effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, radius: 10, spread: 0, blendMode: 'NORMAL' } as never] });
    const text = tx.create('TEXT', card, { characters: 'Привет', fontSize: 16, lineHeight: { unit: 'PX', value: 20 } });
    return { card, text };
  });
  editor.setSelection([ids.card]);
  editor.scaleSelection(2);
  assert.equal(doc.get(ids.card, 'x'), 10);
  assert.deepEqual([doc.get(ids.card, 'cornerRadius'), doc.get(ids.card, 'strokeWeight'), doc.get(ids.card, 'itemSpacing'), doc.get(ids.card, 'paddingTop')], [24, 4, 16, 32]);
  const shadow = doc.get(ids.card, 'effects')[0] as { radius: number; offset: { y: number } };
  assert.deepEqual([shadow.radius, shadow.offset.y], [20, 8]);
  assert.deepEqual([doc.get(ids.text, 'fontSize'), doc.get(ids.text, 'lineHeight')], [32, { unit: 'PX', value: 40 }]);
  editor.setTool('scale');
  assert.equal(editor.tool, 'select');
  assert.equal(editor.scaleMode, true);
  editor.setTool('select');
  assert.equal(editor.scaleMode, false);
});

test('paste to replace takes the place of each selected layer; with several frames selected a paste goes into each', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const icon = tx.create('ELLIPSE', page, { name: 'Иконка', x: 500, y: 500, width: 20, height: 20 });
    const a = tx.create('FRAME', page, { name: 'A', x: 0, y: 0, width: 100, height: 100 });
    const b = tx.create('FRAME', page, { name: 'B', x: 200, y: 0, width: 100, height: 100 });
    const oldA = tx.create('RECTANGLE', a, { name: 'Старая A', x: 10, y: 10, width: 40, height: 40 });
    const oldB = tx.create('RECTANGLE', b, { name: 'Старая B', x: 50, y: 50, width: 40, height: 40 });
    return { icon, a, b, oldA, oldB };
  });
  editor.setSelection([ids.icon]);
  editor.copy();
  editor.setSelection([ids.oldA, ids.oldB]);
  assert.ok(editor.pasteReplaceText(null));
  assert.equal(doc.store.isAlive(ids.oldA), false);
  const inA = doc.children(ids.a);
  const inB = doc.children(ids.b);
  assert.deepEqual([doc.get(inA[0]!, 'name'), doc.get(inA[0]!, 'x'), doc.get(inA[0]!, 'y')], ['Иконка', 20, 20]);
  assert.deepEqual([doc.get(inB[0]!, 'x'), doc.get(inB[0]!, 'y')], [60, 60]);
  // Two frames selected: one paste each.
  editor.setSelection([ids.a, ids.b]);
  assert.ok(editor.pasteText(null));
  assert.equal(doc.children(ids.a).length, 2);
  assert.equal(doc.children(ids.b).length, 2);
});

test('multi-edit: layers from different frames are grouped, masked, combined and wrapped in each frame; Shift aligns each to its own frame', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const a = tx.create('FRAME', page, { width: 200, height: 200 });
    const b = tx.create('FRAME', page, { x: 300, width: 200, height: 200 });
    const make = (f: NodeId) => [tx.create('RECTANGLE', f, { x: 20, y: 30, width: 40, height: 40 }), tx.create('ELLIPSE', f, { x: 50, y: 40, width: 40, height: 40 })];
    return { a, b, inA: make(a), inB: make(b) };
  });
  const all = [...ids.inA, ...ids.inB];
  editor.setSelection(all);
  editor.group();
  assert.equal(editor.selection.length, 2, 'a group in each frame');
  assert.deepEqual(editor.selection.map((g) => doc.parent(g)), [ids.a, ids.b]);
  assert.deepEqual(editor.selection.map((g) => doc.type(g)), ['GROUP', 'GROUP']);
  assert.equal(doc.parent(ids.inB[0]!), editor.selection[1]);
  editor.undo();
  assert.equal(doc.parent(ids.inB[0]!), ids.b, 'one undo step');

  editor.setSelection(all);
  editor.booleanSelection('UNION');
  assert.deepEqual(editor.selection.map((g) => doc.type(g)), ['BOOLEAN_OPERATION', 'BOOLEAN_OPERATION']);
  editor.undo();

  editor.setSelection(all);
  editor.useAsMask();
  assert.equal(editor.selection.length, 2);
  assert.equal(doc.get(ids.inA[0]!, 'isMask'), true);
  assert.equal(doc.get(ids.inB[0]!, 'isMask'), true);
  editor.undo();

  editor.setSelection(all);
  editor.frameSelection(true);
  assert.deepEqual(editor.selection.map((f) => doc.parent(f)), [ids.a, ids.b]);
  assert.ok(editor.selection.every((f) => doc.get(f, 'layoutMode') !== 'NONE'));
  editor.undo();

  // One layer in each frame, Shift + align right: each to the right edge of its own frame.
  editor.setSelection([ids.inA[0]!, ids.inB[0]!]);
  editor.align('right', true);
  assert.equal(doc.get(ids.inA[0]!, 'x'), 160);
  assert.equal(doc.get(ids.inB[0]!, 'x'), 160);
  // Without Shift they align to each other.
  editor.setSelection([ids.inA[1]!, ids.inB[1]!]);
  editor.align('top');
  assert.equal(doc.get(ids.inB[1]!, 'y'), 40);
});

test('multi-edit text: Enter on several text layers types into all of them, each keeps its style; one undo step', () => {
  const { doc, editor, page } = setup();
  const [t1, t2, t3] = editor.commit('setup', (tx) => {
    const f1 = tx.create('FRAME', page, { width: 200, height: 200 });
    const f2 = tx.create('FRAME', page, { x: 300, width: 200, height: 200 });
    return [
      tx.create('TEXT', f1, { name: 'Купить', characters: 'Купить', fontSize: 16 }),
      tx.create('TEXT', f2, { name: 'Купить', characters: 'Купить', fontSize: 24 }),
      tx.create('TEXT', f2, { y: 50, name: 'Заголовок', characters: 'Другое', fontSize: 12 }),
    ] as const;
  });
  editor.setSelection([t1, t2, t3]);
  editor.startMultiTextEditing(editor.selection);
  assert.equal(editor.editingText, t1, 'the top one is edited');
  editor.replaceText('Оформить', 8, 8);
  assert.equal(doc.get(t2, 'characters'), 'Оформить');
  assert.equal(doc.get(t3, 'characters'), 'Оформить', 'a different text is replaced whole');
  editor.replaceText('Оформить заказ', 14, 14);
  assert.equal(doc.get(t2, 'characters'), 'Оформить заказ');
  assert.equal(doc.get(t2, 'fontSize'), 24, 'each keeps its own style');
  editor.stopTextEditing();
  assert.deepEqual([...editor.selection].sort(), [t1, t2, t3].sort(), 'all stay selected');
  assert.equal(doc.get(t2, 'name'), 'Оформить заказ', 'named by content');
  assert.equal(doc.get(t3, 'name'), 'Заголовок', 'a renamed layer keeps its name');
  editor.undo();
  assert.deepEqual([t1, t2, t3].map((t) => doc.get(t, 'characters')), ['Купить', 'Купить', 'Другое']);
});

test('multi-edit variants (Q): a layer of one variant takes the same layers of the others; what is added goes into all; leaving the set ends it', () => {
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const set = tx.create('COMPONENT_SET', page, { name: 'Button', width: 400, height: 100 });
    const make = (name: string, x: number) => {
      const v = tx.create('COMPONENT', set, { name, x, width: 120, height: 40 });
      const label = tx.create('TEXT', v, { name: 'Label', characters: 'OK', x: 10, y: 10 });
      return { v, label };
    };
    return { set, a: make('State=Default', 0), b: make('State=Hover', 140), c: make('State=Pressed', 280), other: tx.create('RECTANGLE', page, { y: 300, width: 10, height: 10 }) };
  });
  editor.setSelection([ids.a.label]);
  editor.toggleVariantEdit();
  assert.equal(editor.variantEdit, ids.set);
  assert.deepEqual(editor.selection, [ids.a.label, ids.b.label, ids.c.label]);
  editor.setSelection([ids.b.v]);
  assert.deepEqual(editor.selection, [ids.b.v, ids.a.v, ids.c.v], 'a variant brings the others');
  // A layer added to one variant appears in all of them, one undo step.
  editor.commit('add', (tx) => tx.create('ELLIPSE', ids.a.v, { name: 'Icon', x: 90, y: 10, width: 16, height: 16 }));
  for (const v of [ids.a.v, ids.b.v, ids.c.v]) assert.ok(doc.children(v).some((c) => doc.get(c, 'name') === 'Icon'));
  editor.undo();
  assert.ok(doc.children(ids.b.v).every((c) => doc.get(c, 'name') !== 'Icon'));
  // Duplicating layers selected in every variant does not copy twice.
  editor.setSelection([ids.a.label]);
  editor.duplicate();
  assert.equal(doc.children(ids.b.v).length, 2);
  editor.setSelection([ids.other]);
  assert.equal(editor.variantEdit, null, 'leaving the set ends multi-edit');
  editor.setSelection([ids.other]);
  editor.toggleVariantEdit();
  assert.equal(editor.variantEdit, null);
});

test('copy one property: a picked fill or effect is copied alone, pasted on top or in place of the picked row; copied looks go onto selected characters', () => {
  const { doc, editor, page } = setup();
  const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true } as const;
  const blue = { type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true } as const;
  const shadow = { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' } as const;
  const [a, b, t] = editor.commit('setup', (tx) => [
    tx.create('RECTANGLE', page, { width: 10, height: 10, fills: [red, blue], effects: [shadow as never], strokeWeight: 0 }),
    tx.create('RECTANGLE', page, { x: 50, width: 10, height: 10, fills: [red] }),
    tx.create('TEXT', page, { y: 50, characters: 'Привет мир', fontSize: 12 }),
  ] as const);
  editor.setSelection([a]);
  editor.pickProperty({ key: 'fills', index: 1 });
  const clip = editor.copyPickedProperty();
  assert.ok(clip);
  editor.setSelection([b]);
  assert.equal(editor.pickedProperty, null, 'a new selection drops the pick');
  assert.equal(editor.pastePropertyText(clip), true);
  assert.deepEqual(doc.get(b, 'fills').map((f) => (f.type === 'SOLID' ? f.color.b : -1)), [0, 1], 'added on top');
  editor.undo();
  editor.setSelection([b]);
  editor.pickProperty({ key: 'fills', index: 0 });
  editor.pastePropertyText(clip);
  assert.deepEqual(doc.get(b, 'fills').map((f) => (f.type === 'SOLID' ? f.color.b : -1)), [1], 'in place of the picked row');
  assert.equal(editor.pastePropertyText('просто текст'), false);
  // An effect; a stroke on a layer without stroke weight gets one.
  editor.setSelection([a]);
  editor.pickProperty({ key: 'effects', index: 0 });
  editor.setSelection([b]);
  editor.setSelection([a]);
  editor.pickProperty({ key: 'effects', index: 0 });
  const fx = editor.copyPickedProperty()!;
  editor.setSelection([b]);
  editor.pastePropertyText(fx);
  assert.equal(doc.get(b, 'effects').length, 1);
  // Cut takes the row off.
  editor.setSelection([a]);
  editor.pickProperty({ key: 'fills', index: 0 });
  editor.removePickedProperty();
  assert.equal(doc.get(a, 'fills').length, 1);
  // Paste properties into text: the selected characters only.
  const big = editor.commit('s', (tx) => tx.create('TEXT', page, { y: 100, characters: 'X', fontSize: 32, fontWeight: 700 }));
  editor.setSelection([big]);
  editor.copyProperties();
  editor.startTextEditing(t);
  editor.setTextSelection(0, 6);
  editor.pasteProperties();
  editor.stopTextEditing();
  const runs = doc.get(t, 'textRuns');
  assert.ok(runs.some((r) => r.start === 0 && r.end === 6 && r.style.fontSize === 32 && r.style.fontWeight === 700), JSON.stringify(runs));
  assert.equal(doc.get(t, 'fontSize'), 12, 'the rest keeps its look');
});

test('copy as code: CSS of each selected layer under its name', async () => {
  const { selectionCss } = await import('../src/ui/code-panel.ts');
  const { editor, page } = setup();
  const [a, b] = editor.commit('s', (tx) => [
    tx.create('RECTANGLE', page, { name: 'Карточка', width: 120, height: 80, cornerRadius: 8, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] }),
    tx.create('ELLIPSE', page, { name: 'Точка', x: 200, width: 10, height: 10 }),
  ]);
  editor.setSelection([a, b]);
  const css = selectionCss(editor);
  assert.match(css, /^\/\* Карточка \*\//);
  assert.match(css, /width: 120px;/);
  assert.match(css, /border-radius: 8px;/);
  assert.match(css, /\/\* Точка \*\//);
});

test('outline view: a click near an outline takes the layer under others or cut off by its frame; hidden ones with the option', () => {
  const { editor, page } = setup();
  const [frame, back, cover, hidden] = editor.commit('s', (tx) => {
    const f = tx.create('FRAME', page, { width: 100, height: 100, clipsContent: true });
    return [
      f,
      tx.create('RECTANGLE', f, { name: 'back', x: 10, y: 10, width: 40, height: 40, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] }),
      tx.create('RECTANGLE', f, { name: 'cover', x: 0, y: 0, width: 100, height: 100, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1, visible: true }] }),
      tx.create('RECTANGLE', f, { name: 'hidden', x: 60, y: 60, width: 20, height: 20, visible: false }),
    ];
  });
  const at = (x: number, y: number) => editor.scene.hitTest({ x, y }, { tolerance: 2 });
  assert.equal(at(10, 30)[0], cover, 'normally the top layer');
  editor.setView({ outlines: true });
  assert.equal(at(10, 30)[0], back, 'on its outline: the layer underneath');
  assert.equal(at(30, 30)[0], cover, 'away from outlines: as usual');
  assert.ok(!at(60, 70).includes(hidden));
  editor.setView({ outlineHidden: true });
  assert.equal(at(60, 70)[0], hidden);
  editor.setView({ outlines: false });
  assert.ok(!at(60, 70).includes(hidden));
  void frame;
});

test('erase with a brush: round brushes erase and restore up to the picture, opacity does not build up in a stroke, torn and dry edges are broken', async () => {
  const { Stroke } = await import('../src/image-erase.ts');
  const make = () => ({ width: 200, height: 200, shown: new Uint8ClampedArray(200 * 200).fill(255), full: new Uint8ClampedArray(200 * 200).fill(255) });
  const at = (s: { shown: Uint8ClampedArray }, x: number, y: number) => s.shown[y * 200 + x]!;
  const opts = { brush: 'soft' as const, mode: 'erase' as const, radius: 30, hardness: 0.5, opacity: 1, seed: 1 };
  const s = make();
  new Stroke(s, opts).to({ x: 100, y: 100 });
  assert.equal(at(s, 100, 100), 0, 'the middle is erased');
  assert.equal(at(s, 140, 100), 255, 'past the radius nothing changes');
  assert.ok(at(s, 124, 100) > 0 && at(s, 124, 100) < 255, 'the edge is soft');
  new Stroke(s, { ...opts, mode: 'restore' }).to({ x: 100, y: 100 });
  assert.equal(at(s, 100, 100), 255, 'restored');
  // Restoring never shows more than the picture had.
  s.full[50 * 200 + 50] = 100;
  s.shown[50 * 200 + 50] = 0;
  new Stroke(s, { ...opts, mode: 'restore' }).to({ x: 50, y: 50 });
  assert.equal(at(s, 50, 50), 100);
  // Half opacity: going over the same place within one stroke stays at half; a second stroke adds.
  const o = make();
  const half = new Stroke(o, { ...opts, brush: 'hard', opacity: 0.5 });
  half.to({ x: 100, y: 100 });
  half.to({ x: 101, y: 100 });
  half.to({ x: 100, y: 100 });
  assert.equal(at(o, 100, 100), 128);
  new Stroke(o, { ...opts, brush: 'hard', opacity: 0.5 }).to({ x: 100, y: 100 });
  assert.equal(at(o, 100, 100), 64);
  // Torn and dry: along a stroke the erased edge goes in and out.
  for (const brush of ['torn', 'dry'] as const) {
    const t = make();
    const st = new Stroke(t, { ...opts, brush, seed: 5 });
    st.to({ x: 10, y: 100 });
    st.to({ x: 190, y: 100 });
    const reach: number[] = [];
    for (let x = 40; x <= 160; x += 4) {
      let y = 100 - 40;
      while (y < 100 && at(t, x, y) > 128) y++;
      reach.push(100 - y);
    }
    assert.ok(Math.max(...reach) - Math.min(...reach) >= 4, `${brush}: ragged edge ${Math.min(...reach)}..${Math.max(...reach)}`);
  }
  // Dry: bristles leave unerased streaks inside the stroke.
  const dry = make();
  const ds = new Stroke(dry, { ...opts, brush: 'dry', seed: 9 });
  ds.to({ x: 10, y: 100 });
  ds.to({ x: 190, y: 100 });
  let kept = 0;
  for (let y = 80; y <= 120; y++) if (at(dry, 100, y) > 128) kept++;
  assert.ok(kept > 0 && kept < 41, `streaks: ${kept} of 41 kept`);
  // Splatter leaves separate drops.
  const sp = make();
  const ss = new Stroke(sp, { ...opts, brush: 'splatter', seed: 3 });
  ss.to({ x: 100, y: 100 });
  let erased = 0;
  for (let p = 0; p < sp.shown.length; p++) if (sp.shown[p]! < 128) erased++;
  assert.ok(erased > 10 && erased < Math.PI * 42 * 42, `drops: ${erased} px`);
});

test('typing an angle turns the layer round its centre, as the rotation handle does (not round its corner)', () => {
  const { editor, doc, page } = setup();
  const id = editor.commit('setup', (tx) => tx.create('RECTANGLE', page, { x: 100, y: 100, width: 200, height: 100 }));
  editor.setSelection([id]);
  editor.commit('turn', (tx) => editor.applyRotation(tx, id, 90));
  assert.equal(doc.get(id, 'rotation'), 90);
  const box = editor.scene.bounds(id);
  assert.deepEqual([box.x + box.width / 2, box.y + box.height / 2].map((n) => Math.round(n * 100) / 100 + 0), [200, 150], 'the centre stays');
  // Typing the same angle again changes nothing.
  const before = [doc.get(id, 'x'), doc.get(id, 'y')];
  editor.commit('again', (tx) => editor.applyRotation(tx, id, 90));
  assert.deepEqual([doc.get(id, 'x'), doc.get(id, 'y')], before);
});

test('blob generator: the same seed gives the same shape, its longer side is the size; insertBlob makes a vector (FEAT-148)', async () => {
  const { blobPath, insertBlob, DEFAULT_BLOB } = await import('../src/generators/blob.ts');
  const { pathsBounds } = await import('#geometry');
  const a = blobPath({ complexity: 7, spread: 80, seed: 42, size: 300 });
  assert.deepEqual(a, blobPath({ complexity: 7, spread: 80, seed: 42, size: 300 }));
  assert.notDeepEqual(a, blobPath({ complexity: 7, spread: 80, seed: 43, size: 300 }));
  assert.equal(a.points.length, 7);
  assert.ok(a.closed && a.points.every((p) => p.in && p.out));
  const box = pathsBounds([a])!;
  assert.ok(Math.abs(Math.max(box.width, box.height) - 300) < 0.05 && Math.abs(box.x) < 0.05 && Math.abs(box.y) < 0.05);
  const { editor, doc } = setup();
  const id = insertBlob(editor, { ...DEFAULT_BLOB, paint: 'outline' }, { x: 0, y: 0 })!;
  assert.equal(doc.type(id), 'VECTOR');
  assert.equal(doc.get(id, 'fills').length, 0);
  assert.equal(doc.get(id, 'strokes').length, 1);
  assert.deepEqual(editor.selection, [id]);
});

test('waves generator: layers back to front, the same seed — the same waves; in a frame they take its width at its bottom (FEAT-149)', async () => {
  const { wavePaths, waveColors, insertWaves, DEFAULT_WAVES } = await import('../src/generators/waves.ts');
  const s = { ...DEFAULT_WAVES, layers: 4, seed: 9, width: 800, areaHeight: 200 };
  const paths = wavePaths(s);
  assert.equal(paths.length, 4);
  assert.deepEqual(paths, wavePaths(s));
  assert.notDeepEqual(paths, wavePaths({ ...s, seed: 10 }));
  for (const p of paths) {
    assert.ok(p.closed && p.points.every((q) => q.x >= 0 && q.x <= 800 && q.y >= 0 && q.y <= 200));
    assert.deepEqual(p.points.slice(-2).map((q) => [q.x, q.y]), [[800, 200], [0, 200]]);
  }
  // Flipped: the waves hang from the top edge.
  assert.deepEqual(wavePaths({ ...s, flip: true })[0]!.points.slice(-2).map((q) => [q.x, q.y]), [[800, 0], [0, 0]]);
  assert.equal(wavePaths({ ...s, style: 'steps' })[0]!.points.length, 2 * s.frequency + 1 + 2);
  const colors = waveColors(s);
  assert.equal(colors.length, 4);
  assert.ok(colors[0]!.r > colors[3]!.r, 'from the light back layer to the darker front one');
  const { editor, doc } = setup();
  const frame = editor.commit('f', (tx) => tx.create('FRAME', editor.pageId, { name: 'Экран', x: 0, y: 0, width: 1000, height: 600 }), () => []);
  editor.setSelection([frame]);
  const group = insertWaves(editor, s)!;
  assert.equal(doc.type(group), 'GROUP');
  assert.equal(doc.parent(group), frame);
  assert.equal(doc.store.children(group).length, 4);
  assert.deepEqual(doc.get(group, 'constraints'), { horizontal: 'SCALE', vertical: 'MAX' });
  assert.ok(Math.abs(doc.get(group, 'width') - 1000) < 0.05);
  assert.ok(Math.abs(doc.get(group, 'y') + doc.get(group, 'height') - 600) < 0.05);
});

test('wave dividers (FEAT-163): every kind stays in the area and ends on its bottom corners; the same seed — the same divider', async () => {
  const { wavePaths, DEFAULT_WAVES } = await import('../src/generators/waves.ts');
  for (const style of ['zigzag', 'arc', 'slope', 'torn', 'clouds'] as const) {
    const s = { ...DEFAULT_WAVES, style, layers: 3, seed: 4, width: 900, areaHeight: 240 };
    const paths = wavePaths(s);
    assert.equal(paths.length, 3, style);
    assert.deepEqual(paths, wavePaths(s), style);
    for (const p of paths) {
      assert.ok(p.closed && p.points.every((q) => q.x >= 0 && q.x <= 900 && q.y >= 0 && q.y <= 240), style);
      assert.deepEqual(p.points.slice(-2).map((q) => [q.x, q.y]), [[900, 240], [0, 240]], style);
    }
  }
  assert.equal(wavePaths({ ...DEFAULT_WAVES, style: 'arc' })[0]!.points.length, 4, 'arc: two ends and the area corners');
});

test('gradient background (FEAT-162): spots on a seeded grid; in a frame it fills it behind everything and stretches with it', async () => {
  const { backdropSpots, insertBackdrop, DEFAULT_BACKDROP } = await import('../src/generators/backdrop.ts');
  const s = { ...DEFAULT_BACKDROP, spots: 6, seed: 3, width: 1600, height: 900 };
  const spots = backdropSpots(s);
  assert.equal(spots.length, 6);
  assert.deepEqual(spots, backdropSpots(s));
  assert.notDeepEqual(spots, backdropSpots({ ...s, seed: 4 }));
  for (const p of spots) {
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    assert.ok(cx >= 0 && cx <= 1600 && cy >= 0 && cy <= 900, 'every spot is centred inside the area');
  }
  assert.ok(backdropSpots({ ...s, style: 'aurora' }).every((p) => p.path));
  const { editor, doc } = setup();
  const frame = editor.commit('f', (tx) => tx.create('FRAME', editor.pageId, { name: 'Слайд', x: 0, y: 0, width: 1280, height: 720 }), () => []);
  editor.commit('t', (tx) => tx.create('RECTANGLE', frame, { name: 'Карточка', x: 10, y: 10, width: 50, height: 50 }), () => []);
  editor.setSelection([frame]);
  const bg = insertBackdrop(editor, s)!;
  assert.equal(doc.type(bg), 'FRAME');
  assert.equal(doc.parent(bg), frame);
  assert.equal(doc.store.children(frame)[0], bg, 'behind everything in the frame');
  assert.equal(doc.get(bg, 'width'), 1280);
  assert.equal(doc.get(bg, 'height'), 720);
  assert.equal(doc.get(bg, 'clipsContent'), true);
  assert.deepEqual(doc.get(bg, 'constraints'), { horizontal: 'SCALE', vertical: 'SCALE' });
  const kids = doc.store.children(bg);
  assert.equal(kids.length, 6);
  assert.ok(kids.every((k) => doc.type(k) === 'ELLIPSE' && doc.get(k, 'fills')[0]!.type === 'GRADIENT_RADIAL'));
  editor.setSelection([frame]);
  const aurora = insertBackdrop(editor, { ...s, style: 'aurora' })!;
  assert.ok(doc.store.children(aurora).every((k) => doc.type(k) === 'VECTOR' && doc.get(k, 'effects').some((e) => e.type === 'LAYER_BLUR')));
});

test('doodles (FEAT-164): every kind draws; the same seed — the same stroke; an underline fits the selection, the marker goes behind it', async () => {
  const { doodle, insertDoodle, DOODLE_KINDS, DEFAULT_DOODLE } = await import('../src/generators/doodles.ts');
  for (const kind of DOODLE_KINDS) {
    const d = doodle({ ...DEFAULT_DOODLE, kind }, 200, 80);
    assert.ok(d.paths.length > 0 && d.paths.every((p) => p.points.length >= 2), kind);
    assert.deepEqual(d, doodle({ ...DEFAULT_DOODLE, kind }, 200, 80), kind);
  }
  assert.notDeepEqual(doodle({ ...DEFAULT_DOODLE, seed: 2 }, 200, 30), doodle({ ...DEFAULT_DOODLE, seed: 3 }, 200, 30));
  assert.equal(doodle({ ...DEFAULT_DOODLE, kind: 'sparkle' }, 60, 60).filled, true);
  const { editor, doc } = setup();
  const title = editor.commit('t', (tx) => tx.create('RECTANGLE', editor.pageId, { name: 'Заголовок', x: 100, y: 100, width: 300, height: 40 }), () => []);
  editor.setSelection([title]);
  const line = insertDoodle(editor, { ...DEFAULT_DOODLE, kind: 'underline', wobble: 0 })!;
  assert.equal(doc.type(line), 'VECTOR');
  assert.ok(Math.abs(doc.get(line, 'width') - 300) < 1, 'as wide as the selection');
  assert.ok(doc.get(line, 'y') >= 140, 'under it');
  assert.equal(doc.get(line, 'strokeCap'), 'ROUND');
  editor.setSelection([title]);
  const marker = insertDoodle(editor, { ...DEFAULT_DOODLE, kind: 'marker' })!;
  const order = doc.store.children(editor.pageId);
  assert.ok(order.indexOf(marker) < order.indexOf(title), 'the marker is behind the text');
  assert.ok(doc.get(marker, 'strokeWeight') > 20);
});

test('motion and sounds (FEAT-150): motion on and sounds off by default; without animation frames the zoom is instant; inserted layers are greeted', async () => {
  const { editor } = setup();
  assert.equal(editor.view.motion, true);
  assert.equal(editor.view.sounds, false);
  assert.equal(editor.motionOn(), false, 'no requestAnimationFrame here: nothing moves');
  const greeted: (readonly string[])[] = [];
  editor.events.on('appear', (ids) => greeted.push(ids));
  const { insertBlob, DEFAULT_BLOB } = await import('../src/generators/blob.ts');
  const id = insertBlob(editor, DEFAULT_BLOB, { x: 0, y: 0 })!;
  assert.deepEqual(greeted, [[id]]);
  editor.viewport.restore({ zoom: 0.1, offsetX: 0, offsetY: 0 });
  editor.zoomToSelection();
  assert.ok(editor.viewport.zoom > 0.1, 'zoomed at once');
});

test('colour kit (FEAT-151): rows from one colour — scale, lighter, darker, muted, harmonies; contrast levels', async () => {
  const { colorKit, readability, turnHue } = await import('../src/generators/color-kit.ts');
  const { toOklch } = await import('../src/color-math.ts');
  const red = { r: 0.85, g: 0.3, b: 0.25, a: 1 };
  const rows = colorKit(red, 5);
  const by = (id: string) => rows.find((r) => r.id === id)!.colors;
  assert.deepEqual(rows.map((r) => r.id), ['scale', 'tints', 'shades', 'tones', 'complementary', 'analogous', 'triad', 'split', 'square']);
  assert.equal(by('scale').length, 10);
  assert.equal(by('tints').length, 5);
  const L = (c: typeof red) => toOklch(c).l;
  assert.ok(by('tints').every((c, i, a) => i === 0 || L(c) > L(a[i - 1]!)), 'lighter and lighter');
  assert.ok(by('shades').every((c, i, a) => i === 0 || L(c) < L(a[i - 1]!)), 'darker and darker');
  assert.ok(toOklch(by('tones').at(-1)!).c < 0.01, 'muted ends in grey');
  const hue = toOklch(red).h;
  const comp = toOklch(by('complementary')[1]!).h;
  assert.ok(Math.abs(((comp - hue + 360) % 360) - 180) < 3, 'complement is opposite');
  assert.equal(by('triad').length, 3);
  assert.equal(by('square').length, 4);
  assert.ok(Math.abs(toOklch(turnHue(red, 120)).l - toOklch(red).l) < 0.01, 'turning keeps lightness');
  assert.equal(readability({ r: 0, g: 0, b: 0, a: 1 }).level, 'AAA');
  assert.equal(readability({ r: 0, g: 0, b: 0, a: 1 }).text, 'white');
  assert.equal(readability({ r: 0.5, g: 0.5, b: 0.5, a: 1 }).level, 'AA');
  assert.equal(readability({ r: 0.5, g: 0.5, b: 0.5, a: 1 }).text, 'black');
});

test('typograph (FEAT-152): Russian typesetting rules; styles stay with their words; links and line breaks untouched', async () => {
  const { typograph, typographRuns, NBSP } = await import('../src/typograph.ts');
  const n = (s: string) => s.replaceAll(NBSP, '·');
  assert.equal(n(typograph('Он сказал: "Это "новый" дизайн" - и ушёл...')), 'Он·сказал: «Это·„новый“ дизайн»·— и·ушёл…');
  assert.equal(n(typograph('В 1941-1945 гг. и т.д.')), 'В·1941–1945·гг. и·т.·д.');
  assert.equal(n(typograph('А.С. Пушкин')), 'А.·С.·Пушкин');
  assert.equal(n(typograph('Цена 10 кг, скидка 5 %, №5')), 'Цена 10·кг, скидка 5·%, №·5');
  assert.equal(n(typograph('- Привет!\n- Пока.')), '— Привет!\n— Пока.');
  assert.equal(typograph('Телефон 8-800-555-35-35, дата 2026-10-26'), 'Телефон 8-800-555-35-35, дата 2026-10-26');
  assert.equal(n(typograph('Пишите на https://a.ru/x-y "тест"')), 'Пишите на·https://a.ru/x-y «тест»');
  assert.equal(typograph('He said "hi"'), 'He said “hi”');
  // «"новый"» bold stays bold after the quotes change and the text gets shorter before it.
  const text = 'Это... "новый" дизайн';
  const start = text.indexOf('новый');
  const res = typographRuns(text, [{ start, end: start + 5, style: { fontWeight: 700 } }]);
  const at = res.text.indexOf('новый');
  assert.deepEqual(res.runs.map((r) => [res.text.slice(r.start, r.end), r.style.fontWeight]), [['новый', 700]]);
  assert.ok(at > 0);
  // In the editor: the selected frame's texts, one undo step.
  const { editor, doc } = setup();
  let t1 = '';
  editor.commit('t', (tx) => {
    const f = tx.create('FRAME', editor.pageId, { name: 'Экран', width: 400, height: 300 });
    t1 = tx.create('TEXT', f, { name: 'Т', characters: 'Мы в "Симметрике" - дома' });
    editor.setSelection([f]);
  }, () => []);
  editor.setSelection([doc.parent(t1)!]);
  assert.equal(editor.typographSelection(), 1);
  assert.equal(n(doc.get(t1, 'characters')), 'Мы·в·«Симметрике»·— дома');
  editor.undo();
  assert.equal(doc.get(t1, 'characters'), 'Мы в "Симметрике" - дома');
  // The text itself selected.
  editor.setSelection([t1]);
  assert.equal(editor.typographSelection(), 1);
  assert.equal(n(doc.get(t1, 'characters')), 'Мы·в·«Симметрике»·— дома');
});

test('font picker live preview (FEAT-153): shows the family on the canvas and takes it back, nothing in the undo history', () => {
  const { editor, doc } = setup();
  let t = '';
  editor.commit('t', (tx) => {
    t = tx.create('TEXT', editor.pageId, { name: 'Т', characters: 'Привет', fontFamily: 'Inter', textRuns: [{ start: 0, end: 3, style: { fontFamily: 'Georgia' } }] });
  }, () => []);
  editor.setSelection([t]);
  const undoable = doc.canUndo();
  editor.previewFont('PT Serif');
  assert.equal(doc.get(t, 'fontFamily'), 'PT Serif');
  assert.deepEqual(doc.get(t, 'textRuns'), [], 'the whole text shows the family');
  editor.previewFont('Arial');
  assert.equal(doc.get(t, 'fontFamily'), 'Arial');
  editor.previewFont(null);
  assert.equal(doc.get(t, 'fontFamily'), 'Inter');
  assert.deepEqual(doc.get(t, 'textRuns'), [{ start: 0, end: 3, style: { fontFamily: 'Georgia' } }], 'runs come back too');
  assert.equal(doc.canUndo(), undoable);
});

test('«Контент» (FEAT-154): sets in both languages, shuffle without repeats, reading order, texts and pictures put in, own lists and tables', async () => {
  const { builtInSets, pickValues, contentTargets, putTexts, putPictures, parseOwnList, initials } = await import('../src/content-reel.ts');
  const sets = builtInSets();
  for (const set of sets) {
    if (set.kind !== 'text') continue;
    for (const l of ['ru', 'en'] as const) {
      const items = set.items(l);
      assert.ok(items.length >= 7, `${set.id}/${l}: enough values`);
      assert.ok(items.every((v) => typeof v === 'string' && v.trim().length > 0), `${set.id}/${l}: no empty values`);
    }
  }
  const byId = (id: string) => sets.find((s) => s.id === id)!;
  const text = (id: string, l: 'ru' | 'en' = 'ru') => (byId(id) as Extract<ReturnType<typeof byId>, { kind: 'text' }>).items(l);
  assert.equal(text('first')[0], 'Анна');
  assert.match(text('email')[0]!, /^anna\.smirnova@/);
  assert.match(text('reviews')[0]!, /\d (отзыв|отзыва|отзывов)$/);
  assert.match(text('price')[0]!, /^\d[\d ]* ₽$/);
  assert.match(text('price', 'en')[0]!, /^\$\d+\.\d{2}$/);
  assert.equal(initials(0, 'ru'), 'АС', 'avatars follow the names set');
  // Shuffle: every value once before any repeats; never the same twice in a row.
  const list = ['a', 'b', 'c', 'd'];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const picked = pickValues(list, 10, 0, true, random);
  assert.equal(new Set(picked.slice(0, 4)).size, 4);
  assert.ok(picked.every((v, i) => i === 0 || v !== picked[i - 1]));
  assert.deepEqual(pickValues(list, 3, 3, false), ['d', 'a', 'b'], 'in a row continues and wraps');
  // Texts in two rows of a grid: filled in reading order, each its own value; the auto name follows.
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const t = (x: number, y: number) => tx.create('TEXT', page, { name: 'Имя', characters: 'Имя', x, y });
    const rect = tx.create('RECTANGLE', page, { x: 0, y: 200, width: 40, height: 40, fills: [] });
    return { texts: [t(200, 100), t(0, 0), t(100, 100), t(100, 2)], rect };
  });
  editor.setSelection([...ids.texts, ids.rect]);
  const targets = contentTargets(editor, 'text');
  assert.deepEqual(targets, [ids.texts[1], ids.texts[3], ids.texts[2], ids.texts[0]]);
  assert.deepEqual(contentTargets(editor, 'image'), [ids.rect]);
  putTexts(editor, targets, ['Анна', 'Илья', 'Мария'], 'Контент');
  assert.deepEqual(targets.map((id) => doc.get(id, 'characters')), ['Анна', 'Илья', 'Мария', 'Анна']);
  assert.equal(doc.get(targets[1]!, 'name'), 'Илья');
  putPictures(editor, [ids.rect], [{ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png' }], 'Контент');
  const fill = doc.get(ids.rect, 'fills')[0]!;
  assert.equal(fill.type, 'IMAGE');
  editor.undo();
  assert.equal(doc.get(ids.rect, 'fills').length, 0, 'one step of undo');
  // Own lists: a line a value; a table — a set per column named by its heading.
  assert.deepEqual(parseOwnList('Москва\n\nКазань\n', 'Города'), [{ name: 'Города', items: ['Москва', 'Казань'] }]);
  assert.deepEqual(parseOwnList('Имя;Цена\n"Чай; зелёный";120\nКофе;180', 'x'), [
    { name: 'Имя', items: ['Чай; зелёный', 'Кофе'] },
    { name: 'Цена', items: ['120', '180'] },
  ]);
  assert.deepEqual(parseOwnList('Имя\tГород\nАнна\tКазань', 'x').map((s) => s.name), ['Имя', 'Город']);
});

test('Batch styles (FEAT-155): set, add or multiply sizes, line height and spacing, colours shifted in OKLCH, names and folders; bound layers follow in one step', async () => {
  const { parseNumberChange, parseLineHeight, parseLetterSpacing, planBatch, renamed } = await import('../src/batch-styles.ts');
  assert.deepEqual(parseNumberChange('24'), { op: 'set', value: 24 });
  assert.deepEqual(parseNumberChange('+2'), { op: 'add', value: 2 });
  assert.deepEqual(parseNumberChange('−2'), { op: 'add', value: -2 });
  assert.deepEqual(parseNumberChange('×1,25'), { op: 'mul', value: 1.25 });
  assert.equal(parseNumberChange('много'), null);
  assert.deepEqual(parseLineHeight('Авто')!({ unit: 'PX', value: 20 }, 16), { unit: 'AUTO' });
  assert.deepEqual(parseLineHeight('140%')!({ unit: 'AUTO' }, 16), { unit: 'PERCENT', value: 140 });
  assert.deepEqual(parseLineHeight('+4')!({ unit: 'AUTO' }, 20), { unit: 'PX', value: 28 }, 'auto is about 120 % of the size');
  assert.deepEqual(parseLetterSpacing('-2%')!({ unit: 'PX', value: 1 }), { unit: 'PERCENT', value: -2 });
  assert.deepEqual(parseLetterSpacing('1px')!({ unit: 'PERCENT', value: 0 }), { unit: 'PX', value: 1 });
  assert.equal(renamed('Кнопки/Основная', { find: 'Основная', replace: 'Главная' }), 'Кнопки/Главная');
  assert.equal(renamed('Кнопки/Основная', { folder: 'UI / Кнопки' }), 'UI/Кнопки/Основная');
  assert.equal(renamed('Кнопки/Основная', { folder: '' }), 'Основная', 'out of folders');
  const { doc, editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const h1 = tx.create('STYLE', doc.rootId, { styleType: 'TEXT', name: 'Заголовки/H1', fontFamily: 'Inter', fontSize: 32, fontWeight: 700 });
    const h2 = tx.create('STYLE', doc.rootId, { styleType: 'TEXT', name: 'Заголовки/H2', fontFamily: 'Inter', fontSize: 24, fontWeight: 700 });
    const blue = tx.create('STYLE', doc.rootId, { styleType: 'FILL', name: 'Синий', fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.9, a: 1 }, opacity: 1, visible: true }] });
    const text = tx.create('TEXT', page, { characters: 'Привет', textStyleId: h1, fontFamily: 'Inter', fontSize: 32, fontWeight: 700 });
    return { h1, h2, blue, text };
  });
  const plan = planBatch(doc, [ids.h1, ids.h2], { fontFamily: 'Roboto', fontSize: parseNumberChange('×1.25')! }, {}, {});
  assert.deepEqual(plan.get(ids.h1), { fontFamily: 'Roboto', fontSize: 40 });
  assert.deepEqual(plan.get(ids.h2), { fontFamily: 'Roboto', fontSize: 30 });
  assert.equal(planBatch(doc, [ids.h1], { fontWeight: 700 }, {}, {}).size, 0, 'nothing that already is so');
  editor.commit('batch', (tx) => {
    for (const [id, patch] of plan) tx.update(id, patch);
  });
  assert.equal(doc.get(ids.text, 'fontSize'), 40, 'the bound text follows');
  assert.equal(doc.get(ids.text, 'fontFamily'), 'Roboto');
  editor.undo();
  assert.equal(doc.get(ids.h1, 'fontSize'), 32);
  assert.equal(doc.get(ids.text, 'fontSize'), 32, 'one undo step');
  const lighter = planBatch(doc, [ids.blue], {}, { lightness: 10, opacity: 0.5 }, {}).get(ids.blue)!;
  const paint = lighter.fills![0]!;
  assert.equal(paint.opacity, 0.5);
  assert.ok(paint.type === 'SOLID' && paint.color.r + paint.color.g + paint.color.b > 0.2 + 0.4 + 0.9, 'lighter');
});

test('Batch styles: removing a folder name by find-and-replace leaves no empty folder', async () => {
  const { renamed } = await import('../src/batch-styles.ts');
  assert.equal(renamed('Бренд/Синий', { find: 'Бренд', replace: '' }), 'Синий');
  assert.equal(renamed('A//B', {}), 'A/B');
});

test('Presentation (FEAT-157): a slides file, slides kept in their grid in the same undo step, themes restyle bound layers, notes kept', async () => {
  const { createSlidesDocument, createSlide, slideIds, arrangeSlides, applySlideTheme, slideThemes, gridPlace, isSlides, currentTheme } = await import('../src/slides.ts');
  const { snapshotKind, serialize, deserialize } = await import('#core');
  const doc = createSlidesDocument('Доклад');
  assert.equal(isSlides(doc), true);
  assert.equal(snapshotKind(serialize(doc)), 'slides');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  editor.editPass = (tx, final) => final && arrangeSlides(doc, tx, editor.pageId, true);
  const page = editor.pageId;
  assert.equal(slideIds(doc, page).length, 1);
  const first = slideIds(doc, page)[0]!;
  for (const layout of ['titleText', 'twoColumns', 'imageText', 'quote'] as const) editor.commit('add', (tx) => createSlide(doc, tx, page, layout));
  const slides = slideIds(doc, page);
  assert.equal(slides.length, 5);
  slides.forEach((id, i) => assert.deepEqual({ x: doc.get(id, 'x'), y: doc.get(id, 'y') }, gridPlace(i)));
  assert.ok(gridPlace(4).y > 0, 'the fifth slide starts a new row');
  // Inserted after the first: the others move one place on.
  editor.commit('insert', (tx) => createSlide(doc, tx, page, 'section', first));
  const now = slideIds(doc, page);
  assert.equal(doc.get(now[1]!, 'name'), 'Раздел');
  now.forEach((id, i) => assert.equal(doc.get(id, 'x'), gridPlace(i).x));
  // Deleting closes the gap, undo puts it back in place.
  editor.commit('delete', (tx) => tx.delete(now[1]!));
  slideIds(doc, page).forEach((id, i) => assert.equal(doc.get(id, 'x'), gridPlace(i).x));
  editor.undo();
  assert.equal(slideIds(doc, page)[1], now[1]);
  // A slide moved on the canvas into the third place takes it.
  editor.commit('drag', (tx) => tx.set(first, 'x', gridPlace(2).x + 30));
  assert.equal(slideIds(doc, page).indexOf(first), 2);
  assert.equal(doc.get(first, 'x'), gridPlace(2).x);
  // The theme: the slide's background and its texts follow their styles.
  const dark = slideThemes().find((t) => t.id === 'graphite')!;
  applySlideTheme(editor, dark);
  assert.equal(currentTheme(doc).id, 'graphite');
  const bg = doc.get(first, 'fills')[0]!;
  assert.ok(bg.type === 'SOLID' && bg.color.r < 0.2, 'dark background');
  const title = doc.children(first).find((id) => doc.type(id) === 'TEXT')!;
  const ink = doc.get(title, 'fills')[0]!;
  assert.ok(ink.type === 'SOLID' && ink.color.r > 0.8, 'light text');
  // Notes survive saving.
  editor.commit('notes', (tx) => tx.set(first, 'slide', { notes: 'Сказать про рост', transition: { type: 'DISSOLVE', duration: 400 } }));
  const again = deserialize(serialize(doc));
  assert.equal(again.get(first, 'slide')?.notes, 'Сказать про рост');
});

test('Presentation: an imported slide is bound to the theme — its colours become «Тема/…», editing a style and another theme restyle it', async () => {
  const { createSlidesDocument, slideIds, bindSlideColors, applySlideTheme, slideThemes } = await import('../src/slides.ts');
  const { solid, hexToColor, colorToHex } = await import('#core');
  const doc = createSlidesDocument('Импорт', true);
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const page = editor.pageId;
  const fill = (hex: string) => [solid(hexToColor(hex)!)];
  const hex = (id: NodeId) => {
    const p = doc.get(id, 'fills')[0]!;
    return p.type === 'SOLID' ? colorToHex(p.color) : '';
  };
  let slide = '' as NodeId;
  const ids: Record<string, NodeId> = {};
  editor.commit('import', (tx) => {
    slide = tx.create('FRAME', page, { name: 'HTML', width: 1920, height: 1080, fills: fill('#FAFAFA'), slide: { notes: '' } });
    ids.title = tx.create('TEXT', slide, { characters: 'Минимум визуала', fills: fill('#1B1B2A') });
    ids.sub = tx.create('TEXT', slide, { characters: 'Чистая презентация без лишних украшений', fills: fill('#6B6B7B') });
    ids.near = tx.create('TEXT', slide, { characters: 'Почти тот же', fills: fill('#20202E') });
    ids.card = tx.create('FRAME', slide, { width: 500, height: 300, fills: fill('#F0F0F5') });
    ids.num = tx.create('TEXT', ids.card, { characters: '01', fills: fill('#5B5BF0') });
    ids.dot = tx.create('ELLIPSE', slide, { width: 8, height: 8, fills: fill('#5B5BF0') });
    ids.odd = tx.create('RECTANGLE', slide, { width: 10, height: 10, fills: fill('#E5484D') });
  });
  editor.commit('bind', (tx) => bindSlideColors(doc, tx, slideIds(doc, page)));
  const style = (name: string) => doc.children(doc.rootId).find((id) => doc.type(id) === 'STYLE' && doc.get(id, 'name') === name)!;
  // Nothing else used the theme: it takes the slide's colours, the look is kept.
  assert.equal(hex(style('Тема/Фон')), '#FAFAFA');
  assert.equal(hex(style('Тема/Текст')), '#1B1B2A');
  assert.equal(hex(style('Тема/Второстепенный')), '#6B6B7B');
  assert.equal(hex(style('Тема/Акцент')), '#5B5BF0');
  assert.equal(hex(style('Тема/Поверхность')), '#F0F0F5');
  assert.equal(doc.get(slide, 'fillStyleId'), style('Тема/Фон'));
  assert.equal(doc.get(ids.near!, 'fillStyleId'), style('Тема/Текст'), 'a near shade joins its role');
  assert.equal(doc.get(ids.num!, 'fillStyleId'), style('Тема/Акцент'));
  assert.equal(doc.get(ids.dot!, 'fillStyleId'), style('Тема/Акцент'));
  assert.equal(doc.get(ids.odd!, 'fillStyleId'), null, 'a colour far from every role stays its own');
  assert.equal(hex(ids.odd!), '#E5484D');
  // Editing the style recolours the slide.
  editor.commit('style', (tx) => tx.update(style('Тема/Акцент'), { fills: fill('#AC5118') }));
  assert.equal(hex(ids.num!), '#AC5118');
  assert.equal(hex(ids.dot!), '#AC5118');
  // Another theme reaches it too.
  applySlideTheme(editor, slideThemes().find((t) => t.id === 'graphite')!);
  assert.equal(hex(slide), '#17181C');
  assert.equal(hex(ids.title!), '#F4F4F6');
});

test('Presentation: a file imported before BUG-140 is bound to the theme on opening — the look kept, no undo step', async () => {
  const { createSlidesDocument, bindOldSlides } = await import('../src/slides.ts');
  const { solid, hexToColor } = await import('#core');
  const doc = createSlidesDocument('Старый', true);
  const page = doc.pages()[0]!;
  let slide = '' as NodeId;
  let title = '' as NodeId;
  doc.transact((tx) => {
    slide = tx.create('FRAME', page, { width: 1920, height: 1080, fills: [solid(hexToColor('#FAFAFA')!)], slide: { notes: '' } });
    title = tx.create('TEXT', slide, { characters: 'Заголовок', fills: [solid(hexToColor('#1B1B2A')!)] });
  });
  doc.clearHistory();
  bindOldSlides(doc);
  const style = (name: string) => doc.children(doc.rootId).find((id) => doc.type(id) === 'STYLE' && doc.get(id, 'name') === name)!;
  assert.equal(doc.get(slide, 'fillStyleId'), style('Тема/Фон'));
  assert.equal(doc.get(title, 'fillStyleId'), style('Тема/Текст'));
  assert.equal(doc.canUndo(), false);
  // Bound once: opening again changes nothing.
  const before = doc.get(style('Тема/Фон'), 'fills');
  bindOldSlides(doc);
  assert.deepEqual(doc.get(style('Тема/Фон'), 'fills'), before);
});

test('Presentation formats: 9:16 and back — every slide fits whole and centred, the theme type follows, new slides take the format, the grid makes room', async () => {
  const { createSlidesDocument, createSlide, slideIds, arrangeSlides, setSlideFormat, slideFormats, slideSize, gridPlace } = await import('../src/slides.ts');
  const doc = createSlidesDocument('Сторис');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  editor.editPass = (tx, final) => final && arrangeSlides(doc, tx, editor.pageId, true);
  const page = editor.pageId;
  editor.commit('add', (tx) => createSlide(doc, tx, page, 'titleText'));
  const titleStyle = doc.children(doc.rootId).find((id) => doc.type(id) === 'STYLE' && doc.get(id, 'name') === 'Тема/Титул')!;
  assert.equal(doc.get(titleStyle, 'fontSize'), 128);
  const stories = slideFormats().find((f) => f.id === '9:16')!.size;
  setSlideFormat(editor, stories);
  assert.deepEqual(slideSize(doc, page), { w: 1080, h: 1920 });
  const [first, second] = slideIds(doc, page);
  assert.equal(doc.get(first!, 'width'), 1080);
  assert.equal(doc.get(titleStyle, 'fontSize'), 72, '1920 → 1080 wide: the type × 0.5625');
  const title = doc.children(first!).find((id) => doc.type(id) === 'TEXT')!;
  assert.equal(doc.get(title, 'fontSize'), 72, 'the bound text agrees with its style');
  assert.ok(doc.get(title, 'y') > 600, 'the 16:9 content sits in the middle of the tall slide');
  assert.deepEqual({ x: doc.get(second!, 'x'), y: doc.get(second!, 'y') }, gridPlace(1, stories), 'the grid of tall slides');
  // A new slide is built for the format: its texts within the narrow width.
  editor.commit('add', (tx) => createSlide(doc, tx, page, 'twoColumns'));
  const third = slideIds(doc, page)[2]!;
  assert.equal(doc.get(third, 'height'), 1920);
  assert.ok(doc.children(third).every((id) => doc.get(id, 'x') + doc.get(id, 'width') <= 1080 + 1), 'nothing past the right edge');
  editor.undo();
  editor.undo();
  assert.deepEqual(slideSize(doc, page), { w: 1920, h: 1080 }, 'one undo step back to 16:9');
  assert.equal(doc.get(titleStyle, 'fontSize'), 128);
});

test('presentation «Слайд» view (FEAT-165): the slide on show is the paper — not picked, moved or resized; the view keeps to it', async () => {
  const { createSlidesDocument, createSlide, slideIds } = await import('../src/slides.ts');
  const doc = createSlidesDocument('Доклад');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const page = editor.pageId;
  editor.commit('add', (tx) => createSlide(doc, tx, page, 'titleText'));
  const [first, second] = slideIds(doc, page) as [string, string];
  const title = doc.children(first)[0]!;
  // Without the stage (designs, «Все слайды») a slide is still a slide: moved, but never resized.
  assert.equal(editor.isSlide(first), true);
  assert.equal(editor.isPinned(first), false);
  assert.equal(editor.canTransform(first), true);
  let current = first;
  const flips: number[] = [];
  editor.slideStage = { current: () => current, flip: (step) => flips.push(step) };
  assert.equal(editor.isPinned(first), true);
  assert.equal(editor.isPinned(title), false, 'its layers stay free');
  assert.equal(editor.canTransform(first), false);
  assert.deepEqual(editor.pickable([title, first]), [title]);
  editor.setSelection([title]);
  editor.selectParent();
  assert.deepEqual(editor.selection, [], 'going up from a layer of the slide clears the selection');
  editor.selectAll();
  assert.deepEqual(editor.selection, doc.children(first).filter((id) => !doc.get(id, 'locked')), '⌘A takes what is on the slide');
  editor.setSelection([first]);
  assert.deepEqual(editor.selection, [], 'a slide on show never gets into the selection (BUG-131)');
  editor.setSelection([title, first]);
  assert.deepEqual(editor.selection, [title]);
  const x = doc.get(first, 'x');
  editor.nudge(10, 0);
  assert.equal(doc.get(first, 'x'), x, 'arrows do not move it');
  // Duplicating a slide (the slides panel) does not go through the selection.
  const [copy] = editor.duplicate([first]);
  assert.ok(copy && editor.isSlide(copy));
  editor.undo();
  // The view: zoomed out or panned away, it comes back to the whole slide in the middle.
  editor.screenSize = { width: 1200, height: 800 };
  editor.viewport.zoom = 0.05;
  editor.viewport.offsetX = 5000;
  editor.requestViewport();
  const b = editor.scene.bounds(first);
  const left = b.x * editor.viewport.zoom + editor.viewport.offsetX;
  const right = (b.x + b.width) * editor.viewport.zoom + editor.viewport.offsetX;
  assert.ok(Math.abs(left - (1200 - right)) < 1, 'centred');
  assert.ok(editor.stageFitted());
  // Zoomed in, it can be looked over but not left.
  editor.viewport.zoom = 2;
  editor.viewport.offsetX = 99_999;
  editor.requestViewport();
  assert.ok(editor.viewport.offsetX <= Editor.STAGE_PADDING - b.x * 2 + 1e-6);
  assert.equal(editor.stageFitted(), false);
  current = second;
  editor.slideStage = null;
  assert.equal(editor.isPinned(first), false);
});

test('tables (FEAT-167): pasted from Excel (HTML or tab-separated text), laid out as a grid whose rows grow with their texts; rows and columns added and deleted', async () => {
  const { tableFromClipboard, insertTable, tableTexts, tableShape, cellPlace, addRow, addColumn, removeRow, removeColumn, setHeader, blankRows } = await import('../src/tables.ts');
  // Excel's HTML: styles, comments, line breaks in the source, a merged cell, &nbsp; and <br>.
  const excel = `<html><head><style>td{}</style></head><body><!--StartFragment--><table border=0>
    <tr height=20><td class=xl65>Город</td><td>Выручка,
      млн ₽</td></tr>
    <tr><td>Москва&nbsp;</td><td align=right>1&nbsp;250</td></tr>
    <tr><td colspan=2>Итого<br>за год</td></tr></table><!--EndFragment--></body></html>`;
  assert.deepEqual(tableFromClipboard(excel, 'x'), [['Город', 'Выручка, млн ₽'], ['Москва', '1 250'], ['Итого\nза год', '']]);
  // Plain text from a spreadsheet: tabs, a quoted cell with a line break and "", a trailing newline.
  assert.deepEqual(tableFromClipboard(null, 'a\tb\n"two\nlines ""q"""\tc\n'), [['a', 'b'], ['two\nlines "q"', 'c']]);
  assert.equal(tableFromClipboard(null, 'just one cell\n'), null, 'one cell stays plain text');
  assert.equal(tableFromClipboard('<p>no table</p>', 'no tabs'), null);
  // PowerPoint wraps a picture in a one-cell table and puts the real grid after it.
  const wrapped = '<table><tr><td><img src="x"></td></tr></table><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>';
  assert.deepEqual(tableFromClipboard(wrapped, ''), [['A', 'B'], ['1', '2']]);

  const { editor, doc } = setup();
  editor.screenSize = { width: 1200, height: 800 };
  const t = insertTable(editor, [['Имя', 'Роль', 'Город'], ['Аня', 'Дизайнер', 'Казань'], ['Борис', 'Очень длинная роль, которая займёт несколько строк в узкой колонке', 'Пермь']])!;
  assert.equal(doc.get(t, 'layoutMode'), 'GRID');
  assert.deepEqual(editor.selection, [t]);
  assert.deepEqual(tableTexts(doc, t)[1], ['Аня', 'Дизайнер', 'Казань']);
  const { cells } = tableShape(doc, t);
  const box = (id: string) => editor.scene.bounds(id);
  // Cells of a row share its top and height; columns line up; the long text makes its row taller.
  assert.equal(box(cells[3]!).y, box(cells[5]!).y);
  assert.equal(box(cells[3]!).height, box(cells[5]!).height);
  assert.equal(box(cells[1]!).x, box(cells[4]!).x);
  assert.ok(box(cells[7]!).height > box(cells[4]!).height * 1.5, 'the long text grows its row');
  assert.ok(Math.abs(box(t).height - (box(cells[8]!).y + box(cells[8]!).height + 1 - box(t).y)) < 1, 'the table hugs its rows');
  assert.equal(doc.get(doc.children(cells[0]!)[0]!, 'fontWeight'), 600, 'the header row is bolder');
  // Where a layer is: the text of the middle cell of the last row.
  assert.deepEqual(cellPlace(doc, doc.children(cells[7]!)[0]!), { table: t, row: 2, col: 1 });

  addRow(editor, t, 1);
  assert.equal(tableShape(doc, t).rows, 4);
  assert.deepEqual(tableTexts(doc, t)[1], ['', '', '']);
  assert.equal(doc.get(t, 'gridRows').length, 4);
  addColumn(editor, t, 3);
  assert.deepEqual(tableTexts(doc, t)[0], ['Имя', 'Роль', 'Город', '']);
  assert.equal(doc.get(doc.children(tableShape(doc, t).cells[3]!)[0]!, 'fontWeight'), 600, 'a new header cell is a header cell');
  removeColumn(editor, t, 0);
  assert.deepEqual(tableTexts(doc, t)[0], ['Роль', 'Город', '']);
  removeRow(editor, t, 0);
  assert.deepEqual(tableTexts(doc, t)[0], ['', '', ''], 'the next row became the header');
  assert.equal(doc.get(doc.children(tableShape(doc, t).cells[0]!)[0]!, 'fontWeight'), 600);
  setHeader(editor, t, false);
  assert.equal(doc.get(doc.children(tableShape(doc, t).cells[0]!)[0]!, 'fontWeight'), 400);
  editor.undo();
  assert.equal(doc.get(t, 'table')!.header, true);
  assert.deepEqual(blankRows(2, 2, true), [['Столбец 1', 'Столбец 2'], ['', '']]);
});

test('tables (FEAT-167): Tab steps through the cells row by row and adds a row past the last one', async () => {
  const { insertTable, stepCell, tableShape, cellPlace } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  const t = insertTable(editor, [['a', 'b'], ['c', 'd']])!;
  const textOf = (i: number) => doc.children(tableShape(doc, t).cells[i]!)[0]!;
  assert.equal(stepCell(editor, textOf(0), 1), textOf(1));
  assert.equal(stepCell(editor, textOf(2), -1), textOf(1));
  assert.equal(stepCell(editor, textOf(0), -1), textOf(0));
  const added = stepCell(editor, textOf(3), 1)!;
  assert.equal(tableShape(doc, t).rows, 3);
  assert.deepEqual(cellPlace(doc, added), { table: t, row: 2, col: 0 });
});

test('tables (FEAT-168): cells merged and split; pasted into a table from a cell on, growing it; a row added through a merged cell splits it', async () => {
  const { insertTable, tableShape, tableTexts, tableMerges, mergeCells, unmergeCell, cellRect, fillCells, addRow, stepCell } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  editor.screenSize = { width: 1200, height: 800 };
  const t = insertTable(editor, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']])!;
  const cells = () => tableShape(doc, t).cells;
  const box = (id: string) => editor.scene.bounds(id);
  // Shift-picked cells (their texts) → the rectangle they take.
  const textOf = (i: number) => doc.children(cells()[i]!)[0]!;
  assert.deepEqual(cellRect(doc, [textOf(4), cells()[8]!]), { table: t, r0: 1, c0: 1, r1: 2, c1: 2 });
  const anchor = mergeCells(editor, t, 1, 1, 2, 2)!;
  assert.equal(anchor, cells()[4]);
  assert.deepEqual(tableTexts(doc, t), [['a', 'b', 'c'], ['d', 'e\nf\nh\ni', ''], ['g', '', '']], 'texts joined in the top left cell');
  assert.deepEqual(tableMerges(doc, t).map((m) => [m.row, m.col, m.rows, m.cols]), [[1, 1, 2, 2]]);
  assert.ok([5, 7, 8].every((i) => !doc.get(cells()[i]!, 'visible')));
  // The merged cell covers both columns and both rows; the cell beside it stays in its place.
  assert.ok(Math.abs(box(anchor).width - (box(cells()[1]!).width + box(cells()[2]!).width + 1)) < 1);
  assert.ok(box(cells()[6]!).y >= box(cells()[3]!).y + box(cells()[3]!).height, 'g sits in the third row, under d');
  assert.ok(Math.abs(box(cells()[6]!).y + box(cells()[6]!).height - (box(anchor).y + box(anchor).height)) < 0.5, 'and ends where the merged cell ends');
  assert.ok(Math.abs(box(cells()[6]!).x - box(cells()[0]!).x) < 0.5);
  // A picked rectangle touching a merged cell takes all of it.
  assert.deepEqual(cellRect(doc, [cells()[3]!, anchor]), { table: t, r0: 1, c0: 0, r1: 2, c1: 2 });
  // Tab passes the hidden places.
  assert.equal(stepCell(editor, textOf(4), 1), textOf(6));
  editor.undo();
  assert.deepEqual(tableTexts(doc, t)[1], ['d', 'e', 'f'], 'one undo step back');
  mergeCells(editor, t, 0, 0, 0, 1);
  unmergeCell(editor, t, cells()[0]!);
  assert.equal(tableMerges(doc, t).length, 0);
  assert.equal(doc.get(cells()[1]!, 'visible'), true);
  // Pasting a 2 × 3 block at the last row's middle: one row and one column more.
  fillCells(editor, t, 2, 1, [['1', '2', '3'], ['4', '5', '6']]);
  assert.deepEqual([tableShape(doc, t).rows, tableShape(doc, t).cols], [4, 4]);
  assert.deepEqual(tableTexts(doc, t).slice(2), [['g', '1', '2', '3'], ['', '4', '5', '6']]);
  editor.undo();
  assert.deepEqual([tableShape(doc, t).rows, tableShape(doc, t).cols], [3, 3], 'the paste is one undo step');
  // A row put in through a merged cell splits it first.
  mergeCells(editor, t, 0, 2, 2, 2);
  addRow(editor, t, 1);
  assert.equal(tableMerges(doc, t).length, 0);
  assert.equal(tableShape(doc, t).rows, 4);
  assert.ok(cells().every((c) => doc.get(c, 'visible')));
});

test('tables (FEAT-170): ranges of cells grow to whole merged cells; the texts of cells get one colour, weight and alignment in one step; a selected table stands for all its cells', async () => {
  const { insertTable, tableShape, mergeCells, cellsBetween, cellsOfSelection, cellTexts, styleCellTexts, alignCellsV, cellAlignV, fillCellsWith } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  editor.screenSize = { width: 1200, height: 800 };
  const t = insertTable(editor, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']])!;
  const cells = () => tableShape(doc, t).cells;
  const at = (...i: number[]) => i.map((n) => cells()[n]!);
  assert.deepEqual(cellsBetween(doc, t, { row: 2, col: 2 }, { row: 1, col: 1 }), at(4, 5, 7, 8), 'either way round');
  assert.deepEqual(cellsBetween(doc, t, { row: 0, col: 0 }, { row: 0, col: 2 }), at(0, 1, 2), 'a row');
  mergeCells(editor, t, 1, 1, 2, 1);
  // A range touching the merged cell takes all of it; the hidden place under it is no cell to select.
  assert.deepEqual(cellsBetween(doc, t, { row: 2, col: 0 }, { row: 2, col: 1 }), at(3, 4, 6));
  assert.deepEqual(cellsOfSelection(doc, [t]).length, 8, 'the whole table: its visible cells');
  assert.deepEqual(cellsOfSelection(doc, [doc.children(cells()[0]!)[0]!, cells()[1]!]), at(0, 1), 'a text stands for its cell');
  assert.deepEqual(cellsOfSelection(doc, [cells()[0]!, t]).length, 8);
  // A run of its own in the text gives way: the cell looks as asked.
  const text = cellTexts(doc, at(0))[0]!;
  editor.commit('run', (tx) => tx.set(text, 'textRuns', [{ start: 0, end: 1, style: { fontWeight: 400, italic: true } }]));
  const white = { type: 'SOLID' as const, color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true };
  styleCellTexts(editor, at(0, 1, 2), { fontWeight: 700, fills: [white] }, 'Шапка');
  for (const tx of cellTexts(doc, at(0, 1, 2))) {
    assert.equal(doc.get(tx, 'fontWeight'), 700);
    assert.deepEqual(doc.get(tx, 'fills'), [white]);
  }
  assert.deepEqual(doc.get(text, 'textRuns'), [{ start: 0, end: 1, style: { italic: true } }], 'only the weight left the run');
  editor.undo();
  assert.equal(doc.get(cellTexts(doc, at(1))[0]!, 'fontWeight') === 700, false, 'one step of undo');
  alignCellsV(editor, at(0, 4), 'CENTER');
  assert.equal(cellAlignV(doc, cells()[0]!), 'CENTER');
  assert.equal(doc.get(cells()[4]!, 'primaryAlign'), 'CENTER');
  const dark = { type: 'SOLID' as const, color: { r: 0.1, g: 0.1, b: 0.2, a: 1 }, opacity: 1, visible: true };
  fillCellsWith(editor, at(0, 1, 2), dark);
  assert.ok(at(0, 1, 2).every((c) => doc.get(c, 'fills')[0]?.type === 'SOLID' && doc.get(c, 'fillStyleId') === null));
});

test('presentation (BUG-135): a slide always has the format’s size — a frame of another size on the page (an HTML page, a paste) gets it with its content fitted; HTML goes onto a new slide, the page’s own slide block becoming the slide', async () => {
  const { createSlidesDocument, slideIds, arrangeSlides } = await import('../src/slides.ts');
  const { buildHtmlImport } = await import('../src/html-import/build.ts');
  const doc = createSlidesDocument('Доклад');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  editor.editPass = (tx, final) => final && arrangeSlides(doc, tx, editor.pageId, true);
  const page = editor.pageId;
  const [frame, box] = editor.commit('paste', (tx) => {
    const f = tx.create('FRAME', page, { name: 'Вставка', x: 5000, y: 0, width: 960, height: 1080, rotation: 10 });
    return [f, tx.create('RECTANGLE', f, { name: 'Плашка', x: 0, y: 0, width: 960, height: 540 })];
  });
  assert.deepEqual([doc.get(frame, 'width'), doc.get(frame, 'height'), doc.get(frame, 'rotation')], [1920, 1080, 0], 'the sheet is the format');
  assert.deepEqual([doc.get(box, 'x'), doc.get(box, 'width')], [480, 960], 'its content fitted and centred');
  assert.deepEqual(doc.get(frame, 'slide'), { notes: '' });
  // An HTML «slide» 1280 × 720 inside a 1440 × 900 page with a dark body.
  const paint = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b }, opacity: 1 });
  const tree = {
    t: 'FRAME' as const, name: 'body', w: 1440, h: 900, fills: [paint(0.17, 0.18, 0.23)],
    children: [{ t: 'FRAME' as const, name: 'div#slide', x: 80, y: 24, w: 1280, h: 720, fills: [paint(1, 1, 1)],
      children: [{ t: 'TEXT' as const, name: 'h1', x: 26, y: 22, w: 600, h: 30, chars: 'Сводная таблица', styles: [{ fam: ['Arial'], w: 700, size: 22, fills: [paint(0, 0, 0)] }], base: 0, ranges: [] }] }],
  };
  const before = slideIds(doc, page).length;
  const { id } = buildHtmlImport(editor, tree as unknown as Parameters<typeof buildHtmlImport>[1], [], 'bank');
  const slides = slideIds(doc, page);
  assert.equal(slides.length, before + 1, 'a new slide');
  const slide = slides.find((s) => doc.get(s, 'name') === 'bank')!;
  assert.deepEqual([doc.get(slide, 'width'), doc.get(slide, 'height')], [1920, 1080]);
  assert.equal(doc.parent(id), slide);
  assert.equal(doc.get(id, 'characters'), 'Сводная таблица', 'the block’s content lies on the slide, no frame over the sheet');
  assert.deepEqual([doc.get(id, 'x'), doc.get(id, 'y'), doc.get(id, 'fontSize')], [39, 33, 33], 'scaled 1.5 times');
  const fill = doc.get(slide, 'fills')[0];
  assert.ok(fill?.type === 'SOLID' && fill.color.r === 1, 'the block’s background is the slide’s');
  editor.undo();
  assert.equal(slideIds(doc, page).length, before, 'one undo step');
});

test('presentation (BUG-136): of the page’s blocks the one nearest to the slide’s proportions is the slide, not a larger one a little off them', async () => {
  const { createSlidesDocument, slideIds, arrangeSlides } = await import('../src/slides.ts');
  const { buildHtmlImport } = await import('../src/html-import/build.ts');
  const doc = createSlidesDocument('Доклад');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  editor.editPass = (tx, final) => final && arrangeSlides(doc, tx, editor.pageId, true);
  const paint = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b }, opacity: 1 });
  // body 1436 × 784 is 3 % off 16:9; the slide 1280 × 720 is it.
  const tree = { t: 'FRAME' as const, name: 'page', w: 1436, h: 896, children: [{ t: 'FRAME' as const, name: 'body', x: 0, y: 0, w: 1436, h: 784, fills: [paint(0.17, 0.18, 0.23)],
    children: [{ t: 'FRAME' as const, name: 'div#slide', x: 78, y: 24, w: 1280, h: 720, fills: [paint(1, 1, 1)], children: [{ t: 'FRAME' as const, name: 'Блок', x: 26, y: 22, w: 600, h: 40, fills: [paint(1, 0, 0)] }] }] }] };
  const { id } = buildHtmlImport(editor, tree as unknown as Parameters<typeof buildHtmlImport>[1], [], 'bank');
  const slide = slideIds(doc, editor.pageId).find((s) => doc.get(s, 'name') === 'bank')!;
  assert.equal(doc.get(id, 'name'), 'Блок', 'the slide block’s content on the slide');
  assert.equal(doc.parent(id), slide);
  const fill = doc.get(slide, 'fills')[0];
  assert.ok(fill?.type === 'SOLID' && fill.color.r === 1, 'white, not the dark body');
});

test('tables (FEAT-170): a row dragged higher keeps that height (the least height of its cells counts for the row), never lower than its texts', async () => {
  const { insertTable, tableShape } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  editor.screenSize = { width: 1200, height: 800 };
  const t = insertTable(editor, [['a', 'b'], ['c', 'd'], ['e', 'f']])!;
  const cells = () => tableShape(doc, t).cells;
  const rowH = () => editor.gridGeometry(t)!.rows.map((r) => Math.round(r.size));
  const before = rowH();
  editor.commit('row', (tx) => {
    for (const c of cells().slice(2, 4)) tx.set(c, 'minHeight', { unit: 'PX', value: 120 });
  });
  assert.equal(rowH()[1], 120, 'the row itself, not only its cells');
  assert.ok(Math.abs(doc.get(cells()[4]!, 'y') - (doc.get(cells()[2]!, 'y') + 121)) < 0.6, 'the next row starts under it');
  editor.commit('row', (tx) => {
    for (const c of cells().slice(2, 4)) tx.set(c, 'minHeight', { unit: 'PX', value: 4 });
  });
  assert.equal(rowH()[1], before[1], 'down to its text');
});

test('tables (FEAT-168): a cell is not moved or resized by hand; Delete empties cells instead of taking them out', async () => {
  const { insertTable, tableShape, tableTexts } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  const t = insertTable(editor, [['a', 'b'], ['c', 'd']])!;
  const [, b, c] = tableShape(doc, t).cells as [string, string, string, string];
  assert.equal(editor.isTableCell(b), true);
  assert.equal(editor.canTransform(b), false);
  assert.equal(editor.canTransform(t), true, 'the table itself moves');
  editor.setSelection([b, doc.children(c)[0]!]);
  editor.deleteSelection();
  assert.deepEqual(tableTexts(doc, t), [['a', ''], ['', 'd']]);
  assert.equal(tableShape(doc, t).cells.length, 4);
});

test('a reading request that gets no answer is asked again on a fresh connection, then given up — the start never hangs (BUG-130)', async () => {
  const { cloud, ANSWER_WAIT } = await import('../src/cloud.ts');
  const saved = [...ANSWER_WAIT];
  ANSWER_WAIT.splice(0, 2, 20, 30);
  const realFetch = globalThis.fetch;
  const stuck = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  try {
    let calls = 0;
    const paths: string[] = [];
    globalThis.fetch = (async (_path: string, init?: RequestInit) => {
      calls++;
      paths.push(String(_path));
      if (calls === 1) return stuck(init);
      return new Response(JSON.stringify({ user: { id: 'u1', email: 'a@b.c', name: 'Аня' } }), { status: 200 });
    }) as typeof fetch;
    const probe = await cloud.probe();
    assert.equal(probe.state, 'signed-in', 'the second try answered');
    assert.deepEqual(paths.slice(0, 2), ['/api/me', '/api/me'], 'the same question asked twice (then the account settings sync on their own)');
    calls = 0;
    globalThis.fetch = (async (_path: string, init?: RequestInit) => {
      calls++;
      return stuck(init);
    }) as typeof fetch;
    const started = Date.now();
    const none = await cloud.probe();
    assert.notEqual(none.state, 'signed-out');
    assert.equal(calls, 2, 'two tries, then offline');
    assert.ok(Date.now() - started < 1000);
  } finally {
    globalThis.fetch = realFetch;
    ANSWER_WAIT.splice(0, 2, ...saved);
  }
});

test('layout from a description: the HTML is cut out of the model answer; the layer is named by the first words', async () => {
  const { extractHtml, promptName } = await import('../src/html-import/ai.ts');
  assert.equal(extractHtml('Вот макет:\n```html\n<!DOCTYPE html><html><body>x</body></html>\n```\nГотово!'), '<!DOCTYPE html><html><body>x</body></html>');
  assert.equal(extractHtml('<html lang="ru"><body>y</body></html> лишнее'), '<html lang="ru"><body>y</body></html>');
  // Cut short while being written: what came so far.
  assert.equal(extractHtml('```html\n<div>частично'), '<div>частично');
  assert.equal(promptName('  Лендинг кофейни\nс отзывами'), 'Лендинг кофейни');
  assert.equal(promptName('Дашборд продаж: боковое меню, четыре карточки с цифрами'), 'Дашборд продаж: боковое меню, четыре…');
});

test('layout from a description: the caption follows what the model writes now; the ticker shows its last line', async () => {
  const { layoutStage, lastCodeLine } = await import('../src/html-import/ai.ts');
  assert.equal(layoutStage(''), 'Продумываю, что будет на экране…');
  assert.equal(layoutStage('<!DOCTYPE html><html><head><style>* { margin: 0 }'), 'Подбираю цвета и шрифты…');
  assert.equal(layoutStage('<style>.a{border-radius:8px}</style></head><body><header class="header"><nav>'), 'Расставляю меню…');
  assert.equal(layoutStage('<body><div class="card">…</div><footer>'), 'Подвал — почти готово…');
  assert.equal(lastCodeLine('```html\n<body>\n  <div class="hero">\n\n'), '<div class="hero">');
});

test('layout from a description: pictures go to the model as placeholders and come back; files become text — xlsx sheets, docx paragraphs and tables, a CSV in Windows-1251', async () => {
  const { packPictures } = await import('../src/html-import/ai.ts');
  const pic = 'data:image/png;base64,iVBORw0KGgo=';
  const packed = packPictures(`<img src="${pic}"><div style="background:url(${pic})"></div><img src="data:image/jpeg;base64,/9j/4A==">`);
  assert.equal(packed.html, '<img src="cs-img:0"><div style="background:url(cs-img:0)"></div><img src="cs-img:1">');
  assert.equal(packed.restore('<main><img src="cs-img:1"><img src="cs-img:7"></main>'), '<main><img src="data:image/jpeg;base64,/9j/4A=="><img src="cs-img:7"></main>');

  const { readAttachment, xlsxText, docxText } = await import('../src/html-import/attachments.ts');
  const { zip } = await import('#render');
  const enc = (s: string) => new TextEncoder().encode(s);
  const xlsx = new Uint8Array(await (await zip([
    { name: 'xl/workbook.xml', data: enc('<workbook><sheets><sheet name="Меню" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/sharedStrings.xml', data: enc('<sst><si><t>Напиток</t></si><si><t>Цена</t></si><si><r><t>Раф </t></r><r><t>&amp; мёд</t></r></si></sst>') },
    { name: 'xl/worksheets/sheet1.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>290</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Капучино</t></is></c><c r="B3"><v>220</v></c></row></sheetData></worksheet>') },
  ])).arrayBuffer());
  assert.equal(await xlsxText(xlsx), 'Лист «Меню»\nНапиток\tЦена\nРаф & мёд\t\t290\nКапучино\t220');
  const docx = new Uint8Array(await (await zip([{ name: 'word/document.xml', data: enc('<w:document><w:body><w:p><w:r><w:t>Заголовок</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>А</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') }])).arrayBuffer());
  assert.equal(await docxText(docx), 'Заголовок\nА\t1');
  // «Цена;Кофе» in Windows-1251, as Excel saves a CSV in Russian.
  const cp1251 = new Uint8Array([0xd6, 0xe5, 0xed, 0xe0, 0x3b, 0xca, 0xee, 0xf4, 0xe5]);
  assert.equal((await readAttachment('menu.csv', cp1251)).text, 'Цена;Кофе');
  await assert.rejects(readAttachment('photo.png', new Uint8Array([1])), /картинки нейросеть не видит/);
  await assert.rejects(readAttachment('old.xls', new Uint8Array([1])), /не прочитать/);
});

test('layout from a description: a change comes as edit blocks applied to the page — exact or with other spacing; a piece of a page is refused, a whole page taken', async () => {
  const { applyEdits } = await import('../src/html-import/ai.ts');
  const page = '<html><head><title>Кофе</title><style>\n.h{color:red}\n</style></head><body>\n  <header class="h">\n    <b>Кофе &amp; Уют</b>\n  </header>\n  <main>Меню</main>\n</body></html>';
  const answer = 'Вот правки:\n<<<<<<< SEARCH\n<b>Кофе &amp; Уют</b>\n=======\n<b>Грань</b>\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n.h{color:red}\n=======\n.h{color:#222}\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<footer>нет такого</footer>\n=======\n<footer>x</footer>\n>>>>>>> REPLACE';
  const r = applyEdits(page, answer)!;
  assert.equal(r.applied, 2);
  assert.equal(r.missed, 1);
  assert.match(r.html, /<b>Грань<\/b>/);
  assert.match(r.html, /\.h\{color:#222\}/);
  assert.match(r.html, /<main>Меню<\/main>/, 'the rest stays');
  // Copied with other indentation: still found.
  const loose = applyEdits(page, '<<<<<<< SEARCH\n<header class="h"> <b>Кофе &amp; Уют</b>\n=======\n<header class="h"><b>Новое</b>\n>>>>>>> REPLACE')!;
  assert.equal(loose.applied, 1);
  assert.match(loose.html, /<header class="h"><b>Новое<\/b>\s*<\/header>/);
  // Not blocks: a whole page is taken, a piece of one is not (it would wipe the rest).
  const whole = `<!DOCTYPE html>${page.replace('Меню', 'Каталог')}`;
  assert.equal(applyEdits(page, whole)!.html, whole);
  assert.equal(applyEdits(page, '<header><b>Грань</b></header>'), null);
  // «=====» inside a CSS comment is not the divider; an empty REPLACE removes.
  const commented = '<style>\n/* ===== Меню ===== */\n.m{color:#fff}\n.x{}\n</style>';
  const c = applyEdits(commented, '<<<<<<< SEARCH\n/* ===== Меню ===== */\n.m{color:#fff}\n=======\n/* ===== Меню ===== */\n.m{color:#111}\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n.x{}\n=======\n>>>>>>> REPLACE')!;
  assert.deepEqual([c.applied, c.missed], [2, 0]);
  assert.equal(c.html, '<style>\n/* ===== Меню ===== */\n.m{color:#111}\n\n</style>');
});

test('layout from a description: a section changed by its first line takes the old one to its end; a repeated piece is the one after the previous block; a block that breaks nesting is not applied', async () => {
  const { applyEdits } = await import('../src/html-import/ai.ts');
  const page = [
    '<body>',
    '<section class="hero"><h1>Кофе</h1></section>',
    '<section class="menu">',
    '<div class="card"><b>Латте</b></div>',
    '<div class="card"><b>Раф</b></div>',
    '</section>',
    '<section class="reviews">',
    '<div class="card"><b>Отзыв</b></div>',
    '</section>',
    '</body>',
  ].join('\n');
  // SEARCH is the opening line only, REPLACE the whole new section: the old cards must go.
  const whole = applyEdits(page, '<<<<<<< SEARCH\n<section class="menu">\n=======\n<section class="menu">\n<div class="card"><b>Эспрессо</b></div>\n</section>\n>>>>>>> REPLACE')!;
  assert.deepEqual([whole.applied, whole.missed], [1, 0]);
  assert.doesNotMatch(whole.html, /Латте|Раф/);
  assert.match(whole.html, /<section class="menu">\n<div class="card"><b>Эспрессо<\/b><\/div>\n<\/section>\n<section class="reviews">/);
  // «<div class="card">» is in both sections: after the block in reviews it is the one there, not the menu's.
  const order = applyEdits(page, '<<<<<<< SEARCH\n<section class="reviews">\n=======\n<section class="reviews dark">\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<div class="card">\n=======\n<div class="card wide">\n>>>>>>> REPLACE')!;
  assert.match(order.html, /<section class="reviews dark">\n<div class="card wide"><b>Отзыв/);
  assert.match(order.html, /<div class="card"><b>Латте/);
  // A block never finds what another one put in: the same piece twice is two places, not one twice.
  const twice = applyEdits(page, '<<<<<<< SEARCH\n<div class="card">\n=======\n<div class="card">\n<i>new</i>\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<div class="card">\n=======\n<div class="card top">\n>>>>>>> REPLACE')!;
  assert.match(twice.html, /<div class="card">\n<i>new<\/i><b>Латте<\/b><\/div>\n<div class="card top"><b>Раф/);
  // A REPLACE that leaves an element open (the rest of the section dropped) would break the page: not applied.
  const cut = applyEdits(page, '<<<<<<< SEARCH\n<section class="hero"><h1>Кофе</h1></section>\n=======\n<section class="hero"><h1>Грань</h1>\n>>>>>>> REPLACE')!;
  assert.deepEqual([cut.applied, cut.missed], [0, 1]);
  assert.equal(cut.html, page);
  // An opening tag removed in one block and its closing tag in another: taken as asked.
  const unwrap = applyEdits(page, '<<<<<<< SEARCH\n<section class="reviews">\n=======\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<div class="card"><b>Отзыв</b></div>\n</section>\n=======\n<div class="card"><b>Отзыв</b></div>\n>>>>>>> REPLACE')!;
  assert.deepEqual([unwrap.applied, unwrap.missed], [2, 0]);
  assert.match(unwrap.html, /<\/section>\n\n<div class="card"><b>Отзыв<\/b><\/div>\n<\/body>/);
});

test('Presentation: any slide is changed by a description — ✦ offers the slide on show with nothing selected; its layers give way to the new page, the slide keeps its place and notes; one undo', async () => {
  const { createSlidesDocument, slideIds } = await import('../src/slides.ts');
  const { buildHtmlImport } = await import('../src/html-import/build.ts');
  const { smartActions } = await import('../src/smart.ts');
  const doc = createSlidesDocument('Доклад');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const slide = slideIds(doc, editor.pageId)[0]!;
  // A slide made by hand: its layers right on the slide, no frame of a layout.
  editor.commit('slide', (tx) => {
    tx.set(slide, 'slide', { notes: 'Сказать про цифры' });
    tx.create('RECTANGLE', slide, { name: 'Мой блок', x: 100, y: 100, width: 300, height: 200 });
  });
  editor.setSelection([]);
  editor.slideStage = { current: () => slide, flip: () => {} };
  const before = doc.children(slide).length;
  assert.ok(smartActions(editor).actions.some((a) => a.command === 'smart.editLayout'), 'offered for a slide made by hand');
  const paint = { type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.2 }, opacity: 1 };
  const { w, h } = { w: doc.get(slide, 'width'), h: doc.get(slide, 'height') };
  const tree = { t: 'FRAME', name: 'body', w, h, children: [{ t: 'FRAME', name: 'div.slide', x: 0, y: 0, w, h, fills: [paint], children: [
    { t: 'TEXT', name: 'h1', x: 80, y: 80, w: 600, h: 60, chars: 'Новый заголовок', styles: [{ fam: ['Inter'], w: 700, size: 48 }], base: 0 },
  ] }] };
  buildHtmlImport(editor, tree as unknown as Parameters<typeof buildHtmlImport>[1], [], 'x', slide, '<html><body><div class="slide">x</div></body></html>');
  assert.equal(doc.store.isAlive(slide), true, 'the slide itself stays');
  assert.deepEqual(slideIds(doc, editor.pageId), [slide], 'no new slide');
  assert.deepEqual(doc.children(slide).map((c) => doc.get(c, 'characters') || doc.get(c, 'name')), ['Новый заголовок'], 'the old layers are gone');
  assert.equal(doc.get(slide, 'slide')?.notes, 'Сказать про цифры');
  assert.ok(doc.get(slide, 'aiSource'), 'the page kept for the next change');
  editor.undo();
  assert.equal(doc.children(slide).length, before, 'one undo brings the slide back');
  editor.slideStage = null;
});

test('Export for a change by a description: layers carry their names; a layer filling a parent that hugs its content keeps its size (CSS has nothing to fill)', () => {
  const doc = Document.createEmpty('Файл');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  let row = '';
  editor.commit('t', (tx) => {
    const slide = tx.create('FRAME', editor.pageId, { name: 'Слайд', width: 1920, height: 1080 });
    row = tx.create('FRAME', slide, { name: 'Точки навигации', layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, itemSpacing: 12, width: 108, height: 12 });
    tx.create('FRAME', row, { name: 'Активная точка', width: 36, height: 12, sizingV: { mode: 'FILL' }, fills: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.9, a: 1 }, opacity: 1, visible: true }] });
    tx.create('TEXT', slide, { name: 'Счётчик "слайдов"', characters: 'Слайд 1 из 4', x: 10, y: 10 });
  });
  const slide = doc.parent(row)!;
  const plain = htmlTree(doc, slide);
  assert.doesNotMatch(plain, /data-name/, 'the code panel stays as it was');
  const named = htmlTree(doc, slide, undefined, undefined, true);
  assert.match(named, /<div class="точки-навигации" data-name="Точки навигации">/);
  assert.match(named, /data-name="Счётчик &quot;слайдов&quot;">Слайд 1 из 4<\/p>/);
  assert.doesNotMatch(named, /<div class="слайд"[^>]*data-name/, 'the top element is the page, its name is kept on the slide');
  const dotRule = named.match(/\.активная-точка \{[^}]*\}/)![0];
  assert.match(dotRule, /height: 12px/);
  assert.doesNotMatch(dotRule, /align-self: stretch/);
});

test('the auto layout panel says what would not move and how far the content sticks out (BUG-153)', async () => {
  const { alignInert, contentOverflow } = await import('../src/ui/properties-panel.ts');
  const doc = Document.createEmpty('Т', 't');
  const page = doc.pages()[0]!;
  // A landing: a column 2071 px high with its sections filling the width, 2240 px of them, centred.
  const col = doc.transact((tx) => tx.create('FRAME', page, { layoutMode: 'VERTICAL', width: 1540, height: 2071, primaryAlign: 'CENTER' }));
  for (const [y, h] of [[-84, 400], [316, 1000], [1316, 840]] as const) doc.transact((tx) => tx.create('FRAME', col, { x: 0, y, width: 1540, height: h, sizingH: { mode: 'FILL' } }));
  assert.deepEqual(contentOverflow(doc, col), { x: 0, y: 169 });
  const inert = alignInert(doc, col);
  assert.match(inert.counter!, /растянуты на всю ширину/);
  assert.equal(inert.main, null, 'a fixed height has room to align in');
  // Hugging its layers: nothing sticks out, and there is no room to align or spread them in.
  doc.transact((tx) => tx.set(col, 'sizingV', { mode: 'HUG' }));
  assert.deepEqual(contentOverflow(doc, col), { x: 0, y: 0 });
  assert.match(alignInert(doc, col).main!, /по содержимому/);
});

test('the main menu: every command once, families in submenus, no endless flat sections; language under «Интерфейс»', async () => {
  const { createCommands } = await import('../src/commands.ts');
  const { layOutMenu } = await import('../src/menu-layout.ts');
  const { editor } = setup();
  const host = new Proxy({ editor } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : () => undefined) });
  const all = createCommands(host as never).filter((c) => !c.hidden && (!c.mode || c.mode === 'design'));
  const menu = layOutMenu(all);
  type Item = ReturnType<typeof layOutMenu>[number]['items'][number];
  const ids: string[] = [];
  const walk = (items: Item[]) => items.forEach((i) => (i.kind === 'command' ? ids.push(i.command.id) : i.kind === 'submenu' ? walk(i.items) : null));
  for (const s of menu) walk(s.items);
  assert.equal(new Set(ids).size, ids.length, 'no command twice');
  const sections = new Set(['Файл', 'Презентация', 'Схема', 'Правка', 'Вид', 'Вставка', 'Объект', 'Фигуры', 'Текст', 'Выравнивание', 'Компоненты', 'Прототип', 'Переменные', 'Справка']);
  for (const c of all) if (sections.has(c.group)) assert.ok(ids.includes(c.id), `${c.id} is in the menu`);
  // Boolean operations and inserts were in no section at all.
  assert.ok(ids.includes('shape.union') && ids.includes('design.icons'));
  for (const s of menu) assert.ok(s.items.filter((i) => i.kind !== 'separator').length <= 22, `«${s.label}» is not one long list`);
  const view = menu.find((s) => s.label === 'Вид')!;
  const ui = view.items.find((i) => i.kind === 'submenu' && i.label === 'Интерфейс');
  assert.ok(ui && ui.kind === 'submenu' && ui.items.some((i) => i.kind === 'command' && i.command.id === 'view.langEn'));
});

test('board mentions: «@Name» replaces the typed «@query», coloured and semibold, typing goes on in the text style', () => {
  const { editor, doc, page } = setup();
  const t = editor.commit('setup', (tx) => tx.create('TEXT', page, { characters: 'Спросить @ан', textAutoResize: 'WIDTH_AND_HEIGHT' }));
  editor.setSelection([t]);
  editor.startTextEditing(t);
  editor.setTextSelection(12, 12);
  assert.equal(editor.insertMention('Анна', 3), null, 'not where «@» is');
  assert.deepEqual(editor.insertMention('Анна Петрова', 9), { start: 9, end: 22 });
  assert.equal(doc.get(t, 'characters'), 'Спросить @Анна Петрова ');
  assert.deepEqual(editor.textSel, { anchor: 23, focus: 23 });
  const runs = doc.get(t, 'textRuns');
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0]!.start, runs[0]!.end, runs[0]!.style.fontWeight], [9, 22, 600]);
  assert.equal(runs[0]!.style.fills?.[0]?.type, 'SOLID');
  editor.stopTextEditing();
  assert.equal(editor.insertMention('Анна', 0), null, 'only while editing');
});

test('board tables (FEAT-181): a new table goes beside what is on the board, never into another table', async () => {
  const { insertTable, tableOf } = await import('../src/tables.ts');
  const { editor, doc } = setup();
  editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  const first = insertTable(editor, [['a', 'b'], ['1', '2']])!;
  const second = insertTable(editor, [['c', 'd'], ['3', '4']])!;
  assert.equal(doc.parent(second), editor.pageId, 'not inside the first table');
  assert.equal(tableOf(doc, doc.parent(second)!), null);
  const a = editor.scene.bounds(first);
  const b = editor.scene.bounds(second);
  const apart = b.x >= a.x + a.width || a.x >= b.x + b.width || b.y >= a.y + a.height || a.y >= b.y + b.height;
  assert.ok(apart, `tables overlap: ${JSON.stringify([a, b])}`);
});

test('board code blocks: a dark frame with a monospace text, coloured by its language, growing with the code', async () => {
  const { createCodeBlock, setCodeLang, codeOf } = await import('../src/board.ts');
  const { boardTextOf } = await import('#components');
  const { editor, doc } = setup();
  editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  const id = createCodeBlock(editor, { x: 0, y: 0 }, 'js');
  const text = boardTextOf(doc, id)!;
  assert.equal(doc.get(text, 'fontFamily'), 'JetBrains Mono');
  const short = doc.get(id, 'height');
  editor.commit('type', (tx) => tx.set(text, 'characters', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;'));
  assert.ok(doc.get(id, 'height') > short, 'the block grows with the code');
  assert.deepEqual(doc.get(text, 'textRuns').map((r) => [r.start, r.end]).slice(0, 2), [[0, 5], [10, 11]], 'const and 1 coloured');
  setCodeLang(editor, [id], 'plain');
  assert.deepEqual(doc.get(text, 'textRuns'), [], 'plain text — no colours');
  assert.equal(codeOf(doc, id), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;');
  assert.equal(editor.boardPrefs.codeLang, 'plain', 'the next block takes the language chosen last');
});

test('board stickers: a bright shape with a white edge and a bold word, each on its own free place, the word editable as a shape text', async () => {
  const { createSticker, STICKERS } = await import('../src/board.ts');
  const { boardTextOf } = await import('#components');
  const { editor, doc } = setup();
  editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  const ids = ['cool', 'done', 'plus'].map((s) => createSticker(editor, s, { x: 0, y: 0 }));
  assert.equal(STICKERS.length, 20);
  for (const id of ids) assert.equal(doc.get(id, 'board')?.kind, 'SHAPE');
  const text = boardTextOf(doc, ids[0]!)!;
  assert.equal(doc.get(text, 'characters'), 'Круто!');
  assert.equal(doc.get(text, 'fontWeight'), 800);
  const outline = doc.children(ids[0]!).find((c) => doc.get(c, 'board')?.kind === 'SHAPE_OUTLINE')!;
  assert.equal(doc.get(outline, 'strokeWeight'), 6);
  const boxes = ids.map((id) => ({ x: doc.get(id, 'x'), y: doc.get(id, 'y'), w: doc.get(id, 'width'), h: doc.get(id, 'height') }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!;
    const b = boxes[j]!;
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `stickers ${i} and ${j} overlap`);
  }
});

test('washi tape: a see-through strip from where the drag began to where it ended, turned along it; a click lays the usual length', async () => {
  const { createTape, TAPE_WIDTH } = await import('../src/board.ts');
  const { editor, doc } = setup();
  editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  const id = createTape(editor, { x: 0, y: 0 }, { x: 100, y: 100 });
  assert.equal(doc.get(id, 'board')?.kind, 'TAPE');
  assert.equal(Math.round(doc.get(id, 'width')), 141);
  assert.equal(doc.get(id, 'height'), TAPE_WIDTH);
  assert.equal(doc.get(id, 'rotation'), 45);
  const b = editor.scene.bounds(id);
  assert.ok(Math.abs(b.x + b.width / 2 - 50) < 1 && Math.abs(b.y + b.height / 2 - 50) < 1, `the middle of the strip is the middle of the drag: ${JSON.stringify(b)}`);
  assert.ok((doc.get(id, 'fills')[0] as { opacity: number }).opacity < 1, 'see-through');
  assert.equal(doc.get(id, 'vectorPaths')[0]!.points.length, 12, 'torn ends');
  const click = createTape(editor, { x: 500, y: 500 }, { x: 501, y: 500 });
  assert.equal(doc.get(click, 'width'), 200);
  assert.equal(doc.get(click, 'rotation'), 0);
});

test('high fives: a ✋ answered by the other within five seconds is a high five; one way only, or too late, is not', async () => {
  const { HighFives, HIGH_FIVE_MS } = await import('../src/ui/emotes.ts');
  const f = new HighFives();
  assert.equal(f.record('a', 'b', 1000), false, 'asked');
  assert.equal(f.record('a', 'b', 1500), false, 'asked again by the same person');
  assert.equal(f.record('b', 'a', 2000), true, 'answered: a high five');
  assert.equal(f.record('b', 'a', 2100), false, 'used up: a new request');
  const late = new HighFives();
  late.record('a', 'b', 0);
  assert.equal(late.record('b', 'a', HIGH_FIVE_MS + 1), false, 'too late');
});

test('own board templates and colours: the selection kept under a name and put back on a free place; a board palette for everyone', async () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const { saveOwnTemplate, ownTemplates, insertOwnTemplate, removeOwnTemplate } = await import('../src/board-own-templates.ts');
    const { createSticky, addBoardColor, removeBoardColor, BOARD_COLORS_MAX } = await import('../src/board.ts');
    const { editor, doc } = setup();
    editor.commit('board', (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
    assert.equal(saveOwnTemplate(editor, 'Пусто').ok, false, 'nothing selected');
    const a = createSticky(editor, { x: 0, y: 0 });
    const b = createSticky(editor, { x: 300, y: 0 });
    editor.setSelection([a, b]);
    const saved = saveOwnTemplate(editor, '  Ретро команды  ');
    assert.equal(saved.ok, true, saved.message);
    const [t] = ownTemplates();
    assert.equal(t!.name, 'Ретро команды');
    assert.equal(t!.width, 540);
    const count = doc.children(editor.pageId).length;
    assert.equal(insertOwnTemplate(editor, t!), true);
    const added = doc.children(editor.pageId).slice(count);
    assert.equal(added.length, 2, 'both stickies came back');
    const boxes = [a, b].map((id) => editor.scene.bounds(id));
    for (const id of added) {
      const n = editor.scene.bounds(id);
      assert.ok(boxes.every((o) => n.x + n.width <= o.x || o.x + o.width <= n.x || n.y + n.height <= o.y || o.y + o.height <= n.y), 'beside the originals, not over them');
    }
    removeOwnTemplate(t!.id);
    assert.deepEqual(ownTemplates(), []);
    addBoardColor(editor, '#12a4b6');
    addBoardColor(editor, '#12A4B6');
    addBoardColor(editor, 'red');
    assert.deepEqual(doc.get(doc.rootId, 'boardColors'), ['#12A4B6'], 'upper case, once, real colours only');
    for (let i = 0; i < 20; i++) addBoardColor(editor, `#0000${String(i).padStart(2, '0')}`);
    assert.equal(doc.get(doc.rootId, 'boardColors').length, BOARD_COLORS_MAX, 'the oldest go');
    removeBoardColor(editor, '#000019');
    assert.equal(doc.get(doc.rootId, 'boardColors').includes('#000019'), false);
  } finally {
    g.localStorage = before;
  }
});
