import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, deserialize, serialize, type Op } from '../src/index.ts';

function setup() {
  const doc = Document.createEmpty('Тест', 'alice');
  const page = doc.pages()[0]!;
  return { doc, page };
}

test('create, read and default properties', () => {
  const { doc, page } = setup();
  const id = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 10, width: 50 }));
  assert.equal(doc.get(id, 'x'), 10);
  assert.equal(doc.get(id, 'width'), 50);
  assert.equal(doc.get(id, 'height'), 100, 'type default');
  assert.equal(doc.get(id, 'name'), 'Rectangle');
  assert.deepEqual(doc.children(page), [id]);
});

test('sparse storage keeps only non-default values', () => {
  const { doc, page } = setup();
  const id = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 0, width: 100 }));
  assert.deepEqual(Object.keys(doc.store.record(id)!.props), []);
  doc.transact((tx) => tx.set(id, 'x', 5));
  assert.deepEqual(Object.keys(doc.store.record(id)!.props), ['x']);
  doc.transact((tx) => tx.set(id, 'x', 0));
  assert.deepEqual(Object.keys(doc.store.record(id)!.props), []);
});

test('sibling order follows positions', () => {
  const { doc, page } = setup();
  const [a, b, c] = doc.transact((tx) => {
    const a = tx.create('RECTANGLE', page);
    const c = tx.create('RECTANGLE', page);
    const b = tx.create('RECTANGLE', page, {}, { before: c });
    return [a, b, c];
  });
  assert.deepEqual(doc.children(page), [a, b, c]);
  doc.transact((tx) => tx.move(a!, page, { at: 'end' }));
  assert.deepEqual(doc.children(page), [b, c, a]);
  doc.transact((tx) => tx.move(a!, page, { index: 0 }));
  assert.deepEqual(doc.children(page), [a, b, c]);
});

test('moves that would create a cycle or break containment are rejected', () => {
  const { doc, page } = setup();
  const { outer, inner, rect } = doc.transact((tx) => {
    const outer = tx.create('FRAME', page);
    const inner = tx.create('FRAME', outer);
    const rect = tx.create('RECTANGLE', inner);
    return { outer, inner, rect };
  });
  doc.transact((tx) => {
    assert.equal(tx.move(outer, inner), false);
    assert.equal(tx.move(outer, outer), false);
    assert.equal(tx.move(inner, rect), false, 'rectangle cannot have children');
  });
  assert.equal(doc.parent(outer), page);
});

test('undo and redo restore values, creation and moves', () => {
  const { doc, page } = setup();
  const frame = doc.transact((tx) => tx.create('FRAME', page), { label: 'frame' });
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page), { label: 'rect' });
  doc.transact((tx) => tx.set(rect, 'x', 42), { label: 'x' });
  doc.transact((tx) => tx.move(rect, frame), { label: 'move' });

  doc.undo();
  assert.equal(doc.parent(rect), page);
  doc.undo();
  assert.equal(doc.get(rect, 'x'), 0);
  doc.undo();
  assert.equal(doc.store.isAlive(rect), false);
  assert.deepEqual(doc.children(page), [frame]);

  doc.redo();
  doc.redo();
  doc.redo();
  assert.equal(doc.store.isAlive(rect), true);
  assert.equal(doc.get(rect, 'x'), 42);
  assert.equal(doc.parent(rect), frame);
  assert.equal(doc.canRedo(), false);
});

test('a new edit clears the redo stack', () => {
  const { doc, page } = setup();
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page));
  doc.transact((tx) => tx.set(rect, 'x', 1));
  doc.undo();
  assert.equal(doc.canRedo(), true);
  doc.transact((tx) => tx.set(rect, 'y', 1));
  assert.equal(doc.canRedo(), false);
});

test('undo skips steps that another participant changed afterwards (FR-DOC-011)', () => {
  const base = Document.createEmpty('Тест', 'base');
  const rect = base.transact((tx) => tx.create('RECTANGLE', base.pages()[0]!));
  const alice = deserialize(serialize(base), 'alice');
  const bob = deserialize(serialize(base), 'bob');
  alice.onLocalOps((ops) => bob.applyRemote(ops));
  bob.onLocalOps((ops) => alice.applyRemote(ops));

  alice.transact((tx) => tx.update(rect, { x: 10, y: 10 }));
  bob.transact((tx) => tx.set(rect, 'x', 99));
  assert.equal(alice.get(rect, 'x'), 99);

  const result = alice.undo();
  assert.equal(result?.skipped, 1, 'x was changed by Bob, so it is skipped');
  assert.equal(alice.get(rect, 'x'), 99);
  assert.equal(alice.get(rect, 'y'), 0, 'y is still Alice\'s value and is undone');
  assert.equal(bob.get(rect, 'y'), 0);
});

test('concurrent edits converge regardless of arrival order', () => {
  const base = Document.createEmpty('Тест', 'base');
  const page = base.pages()[0]!;
  const rect = base.transact((tx) => tx.create('RECTANGLE', page));
  const snapshot = serialize(base);
  const a = deserialize(snapshot, 'aaaa');
  const b = deserialize(snapshot, 'bbbb');
  const opsA: Op[] = [];
  const opsB: Op[] = [];
  a.onLocalOps((ops) => opsA.push(...ops));
  b.onLocalOps((ops) => opsB.push(...ops));

  a.transact((tx) => tx.set(rect, 'x', 1));
  b.transact((tx) => tx.set(rect, 'x', 2));
  a.applyRemote(opsB);
  b.applyRemote(opsA);
  assert.equal(a.get(rect, 'x'), b.get(rect, 'x'));
});

test('deleting a parent hides the subtree; undo restores it with concurrent edits intact', () => {
  const { doc, page } = setup();
  const { frame, text } = doc.transact((tx) => {
    const frame = tx.create('FRAME', page);
    const text = tx.create('TEXT', frame, { characters: 'до' });
    return { frame, text };
  });
  doc.transact((tx) => tx.delete(frame));
  assert.equal(doc.store.isAlive(text), false);
  assert.deepEqual(doc.children(page), []);
  doc.transact((tx) => tx.set(text, 'characters', 'после'), { undoable: false });
  doc.undo();
  assert.equal(doc.store.isAlive(text), true);
  assert.equal(doc.get(text, 'characters'), 'после');
});

test('gesture: many live updates become one undo step; cancel reverts', () => {
  const { doc, page } = setup();
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page));
  const gesture = doc.beginGesture('drag');
  for (let i = 1; i <= 20; i++) gesture.update((tx) => tx.set(rect, 'x', i));
  gesture.commit();
  assert.equal(doc.get(rect, 'x'), 20);
  doc.undo();
  assert.equal(doc.get(rect, 'x'), 0);

  const second = doc.beginGesture('drag');
  second.update((tx) => tx.set(rect, 'x', 5));
  second.cancel();
  assert.equal(doc.get(rect, 'x'), 0);
});

test('history: listeners hear every change of undo/redo, after the step is in (BUG: Undo stayed grey after a single edit)', () => {
  const { doc, page } = setup();
  const seen: string[] = [];
  doc.onHistory(() => seen.push(`${doc.canUndo() ? 'U' : '-'}${doc.canRedo() ? 'R' : '-'}`));
  // A change listener runs before the step enters the history: that is why the button needs onHistory.
  let duringChange = true;
  doc.subscribe(() => (duringChange = doc.canUndo()));
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page), { label: 'create' });
  assert.equal(duringChange, false);
  assert.deepEqual(seen, ['U-']);
  const g = doc.beginGesture('drag');
  g.update((tx) => tx.set(rect, 'x', 5));
  g.commit();
  assert.deepEqual(seen, ['U-', 'U-'], 'a finished gesture is heard');
  doc.undo();
  doc.undo();
  assert.deepEqual(seen.slice(2), ['UR', '-R']);
  doc.redo();
  assert.deepEqual(seen.slice(4), ['UR']);
  doc.transact((tx) => tx.set(rect, 'y', 1), { undoable: false });
  assert.equal(seen.length, 5, 'work outside the history tells nothing');
  doc.clearHistory();
  assert.deepEqual(seen.slice(5), ['--']);
});

test('snapshot round trip preserves the tree', () => {
  const { doc, page } = setup();
  doc.transact((tx) => {
    const frame = tx.create('FRAME', page, { name: 'Карточка', layoutMode: 'VERTICAL', itemSpacing: 8 });
    tx.create('TEXT', frame, { characters: 'Привет' });
    const gone = tx.create('RECTANGLE', frame);
    tx.delete(gone);
  });
  const restored = deserialize(serialize(doc), 'zzzz');
  const frame = restored.children(restored.pages()[0]!)[0]!;
  assert.equal(restored.get(frame, 'name'), 'Карточка');
  assert.equal(restored.get(frame, 'itemSpacing'), 8);
  assert.equal(restored.children(frame).length, 1, 'deleted nodes are not saved');
  assert.equal(serialize(restored).length > 0, true);
  // New ids from the restored session never collide with loaded ones.
  const fresh = restored.transact((tx) => tx.create('RECTANGLE', frame));
  assert.match(fresh, /^zzzz:/);
});

test('a failed transaction leaves nothing behind and no undo step (BUG-003)', () => {
  const doc = Document.createEmpty('t', 'a');
  const page = doc.pages()[0]!;
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 1 }));
  doc.undo();
  doc.redo();
  assert.throws(() =>
    doc.transact((tx) => {
      tx.set(rect, 'x', 50);
      tx.create('FRAME', page, {});
      throw new Error('boom');
    }),
  );
  assert.equal(doc.get(rect, 'x'), 1);
  assert.equal(doc.children(page).length, 1);
  doc.undo();
  assert.equal(doc.children(page).length, 0, "the previous step is still the top of the history");
});

test('images are stored once by content hash, survive save/load and reach collaborators (FR-DOC-003)', () => {
  const a = Document.createEmpty('t', 'a');
  const page = a.pages()[0]!;
  const sent: Op[] = [];
  a.onLocalOps((ops) => sent.push(...ops));
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const [h1, h2] = a.transact((tx) => [tx.addBlob(bytes, 'image/png'), tx.addBlob(bytes.slice(), 'image/png')]);
  assert.equal(h1, h2);
  assert.equal(a.store.blobs.size, 1);
  assert.equal(sent.filter((op) => op.kind === 'blob').length, 1);
  a.transact((tx) => tx.create('RECTANGLE', page, { fills: [{ type: 'IMAGE', imageHash: h1!, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] }));
  const loaded = deserialize(serialize(a), 'b');
  assert.deepEqual(loaded.store.blobs.get(h1!), a.store.blobs.get(h1!));
  const remote = deserialize(serialize(Document.createEmpty('t', 'x')), 'c');
  const changes = remote.applyRemote(sent.filter((op) => op.kind === 'blob'));
  assert.ok(changes.blobs.has(h1!));
});

test('view-only document: edits and gestures are reverted at once and reported, nothing enters history', () => {
  const doc = Document.createEmpty('Файл');
  const page = doc.pages()[0]!;
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { name: 'Прямоугольник', x: 10 }));
  doc.clearHistory();
  const sent: Op[] = [];
  doc.onLocalOps((ops) => sent.push(...ops));
  let blocked = 0;
  doc.readOnly = true;
  doc.onBlockedEdit = () => blocked++;

  const made = doc.transact((tx) => tx.create('ELLIPSE', page));
  assert.equal(doc.store.isAlive(made), false, 'a created node is gone again');
  doc.transact((tx) => tx.set(rect, 'x', 99));
  assert.equal(doc.get(rect, 'x'), 10);
  assert.equal(blocked, 2);
  assert.equal(doc.canUndo(), false);

  const g = doc.beginGesture('Перетаскивание');
  g.update((tx) => tx.set(rect, 'x', 50));
  g.update((tx) => tx.set(rect, 'x', 60));
  assert.equal(doc.get(rect, 'x'), 10, 'a drag does not move anything');
  g.commit();
  assert.equal(blocked, 3, 'one report per gesture');
  assert.equal(doc.canUndo(), false);

  // Work that is not an edit (loading, layout) still runs.
  doc.transact((tx) => tx.set(rect, 'x', 12), { undoable: false });
  assert.equal(doc.get(rect, 'x'), 12);
  doc.readOnly = false;
  doc.transact((tx) => tx.set(rect, 'x', 20));
  assert.equal(doc.get(rect, 'x'), 20);
  assert.ok(sent.length > 0);
});

test('history: quick repeats of the same edit become one undo step; other edits stay separate', () => {
  const doc = Document.createEmpty('Файл');
  const page = doc.pages()[0]!;
  const rect = doc.transact((tx) => tx.create('RECTANGLE', page, { x: 0 }));
  doc.clearHistory();
  for (const x of [1, 2, 3, 4]) doc.transact((tx) => tx.set(rect, 'x', x), { label: 'Цвет заливки' });
  doc.transact((tx) => tx.set(rect, 'y', 5), { label: 'Цвет заливки' });
  doc.undo();
  assert.equal(doc.get(rect, 'y'), 0, 'another property is its own step');
  assert.equal(doc.get(rect, 'x'), 4);
  doc.undo();
  assert.equal(doc.get(rect, 'x'), 0, 'the four quick changes undo together');
  assert.equal(doc.canUndo(), false);
  doc.redo();
  assert.equal(doc.get(rect, 'x'), 4);
});

test('restoring a version: the whole file or one frame, as operations that others can apply', async () => {
  const { restoreVersion, compareTopLevel } = await import('../src/restore.ts');
  const shape = (d: Document) =>
    d.pages().flatMap((p) => {
      const out: string[] = [];
      d.store.walk(p, (id) => void out.push(`${id}:${d.parent(id)}:${d.get(id, 'name')}:${d.get(id, 'width')}`));
      return out;
    });
  // A: the file with two frames; the version is saved.
  const a = Document.createEmpty('Файл', 'a');
  const page = a.pages()[0]!;
  const [f1, f2, inner] = a.transact((tx) => {
    const x = tx.create('FRAME', page, { name: 'Главный', width: 100 });
    const y = tx.create('FRAME', page, { name: 'Профиль', width: 200 });
    const z = tx.create('RECTANGLE', x, { name: 'Кнопка', width: 40 });
    return [x, y, z];
  });
  const version = deserialize(serialize(a));
  const saved = shape(a);
  // Later: a frame changed, a layer deleted, a frame added.
  a.transact((tx) => {
    tx.set(f1, 'width', 300);
    tx.delete(inner);
    tx.create('FRAME', page, { name: 'Новый' });
  });
  // B opened the file after that: it has never seen the deleted layer.
  const b = deserialize(serialize(a), 'b');
  // The live session gives a newcomer the room's clock (a snapshot has no times).
  b.clock.observe({ counter: a.clock.now, session: '' });
  assert.equal(b.store.has(inner), false);
  const ops: Op[] = [];
  b.onLocalOps((o) => ops.push(...o));
  const diff = compareTopLevel(version, b, page);
  assert.deepEqual([diff.changed, diff.removed, diff.added.length], [[f1], [], 1]);

  // Only "Главный" from the version: back to 100 wide with its button; the new frame stays.
  b.transact((tx) => restoreVersion(tx, b, version, [f1], page), { label: 'Вернуть фрейм' });
  assert.equal(b.get(f1, 'width'), 100);
  assert.equal(b.store.isAlive(inner), true);
  assert.equal(b.children(page).length, 3);
  // A (which holds the deleted layer) receives the same operations and gets the same result.
  a.applyRemote(ops);
  assert.deepEqual(shape(a), shape(b));
  // Undo takes it back.
  b.undo();
  assert.equal(b.get(f1, 'width'), 300);
  assert.equal(b.store.isAlive(inner), false);

  // The whole version: exactly as saved (the new frame goes).
  b.transact((tx) => restoreVersion(tx, b, version, null, page), { label: 'Восстановить версию' });
  assert.deepEqual(shape(b), saved);
  void f2;
});

test('export scale typed as in Figma: 2x, 0,5x, 512w, 300h', async () => {
  const { parseExportScale, exportScale, exportScaleLabel } = await import('../src/schema.ts');
  assert.deepEqual(parseExportScale('2x'), { scale: 2, size: undefined });
  assert.deepEqual(parseExportScale(' 0,5 '), { scale: 0.5, size: undefined });
  assert.deepEqual(parseExportScale('512w'), { scale: 1, size: { side: 'WIDTH', px: 512 } });
  assert.deepEqual(parseExportScale('300H'), { scale: 1, size: { side: 'HEIGHT', px: 300 } });
  assert.equal(parseExportScale('abc'), null);
  assert.equal(parseExportScale('0'), null);
  const s = { format: 'PNG' as const, scale: 1, size: { side: 'WIDTH' as const, px: 512 }, suffix: '' };
  assert.equal(exportScale(s, 256, 100), 2);
  assert.equal(exportScaleLabel(s), '512w');
});
