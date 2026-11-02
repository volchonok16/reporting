import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countChanges, Document, fromSnapshot, mergeSnapshots, restoreVersion, serialize, deserialize, toSnapshot, type MergeChoice, type Snapshot } from '../src/index.ts';

/** A file, and two copies of it (the main file and a branch) that go their own ways from here. */
function setup() {
  const base = Document.createEmpty('Файл', 'base');
  const page = base.pages()[0]!;
  const [frame, a, b, text] = base.transact((tx) => {
    const frame = tx.create('FRAME', page, { name: 'Экран', width: 400, height: 300 });
    const a = tx.create('RECTANGLE', frame, { name: 'A', x: 10 });
    const b = tx.create('RECTANGLE', frame, { name: 'B', x: 100 });
    const text = tx.create('TEXT', frame, { name: 'Заголовок', characters: 'Привет' });
    return [frame, a, b, text];
  });
  const copy = (session: string) => deserialize(serialize(base), session);
  return { base, main: copy('main'), branch: copy('branch'), page: page!, frame: frame!, a: a!, b: b!, text: text! };
}

const snap = (d: Document): Snapshot => toSnapshot(d);
const merge = (base: Document, ours: Document, theirs: Document, choices?: Map<string, MergeChoice>) => mergeSnapshots(snap(base), snap(ours), snap(theirs), choices);

test('merge: changes of different properties and layers come together without conflicts', () => {
  const { base, main, branch, a, b, frame, page } = setup();
  main.transact((tx) => tx.set(a, 'x', 50));
  branch.transact((tx) => {
    tx.set(a, 'y', 70);
    tx.set(b, 'opacity', 0.5);
    tx.create('ELLIPSE', frame, { name: 'Новый' });
  });
  const r = merge(base, main, branch);
  assert.equal(r.conflicts.length, 0);
  const out = fromSnapshot(r.snapshot!);
  assert.equal(out.get(a, 'x'), 50, 'the main file\'s change stays');
  assert.equal(out.get(a, 'y'), 70, 'the branch\'s change comes in');
  assert.equal(out.get(b, 'opacity'), 0.5);
  assert.ok(out.children(frame).some((id) => out.get(id, 'name') === 'Новый'), 'a layer made in the branch comes in');
  assert.equal(out.pages()[0], page);
});

test('merge: the same property changed on both sides is a conflict decided by property', () => {
  const { base, main, branch, a } = setup();
  main.transact((tx) => tx.set(a, 'x', 50));
  branch.transact((tx) => {
    tx.set(a, 'x', 80);
    tx.set(a, 'y', 5);
  });
  const r = merge(base, main, branch);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0]!;
  assert.deepEqual([c.kind, c.prop, c.ours, c.theirs, c.name, c.path], ['prop', 'x', 50, 80, 'A', [base.get(base.pages()[0]!, 'name'), 'Экран']]);
  assert.equal(fromSnapshot(r.snapshot!).get(a, 'x'), 50, 'undecided — as in the file it goes into');
  assert.equal(fromSnapshot(r.snapshot!).get(a, 'y'), 5, 'the other property still comes in');
  const chosen = merge(base, main, branch, new Map([[c.key, 'theirs']]));
  assert.equal(fromSnapshot(chosen.snapshot!).get(a, 'x'), 80);
});

test('merge: the same change on both sides, and a value set back to what it was, are no conflicts', () => {
  const { base, main, branch, a } = setup();
  main.transact((tx) => tx.set(a, 'x', 50));
  branch.transact((tx) => tx.set(a, 'x', 50));
  assert.equal(merge(base, main, branch).conflicts.length, 0);
  // A property written explicitly with its default value is the same as one never written.
  const explicit = deserialize(serialize(base), 'x');
  (explicit.store.record(a)!.props as Record<string, unknown>).opacity = 1;
  assert.equal(countChanges(snap(base), snap(explicit)), 0);
});

test('merge: a layer deleted on one side and changed on the other is a conflict about keeping it', () => {
  const { base, main, branch, a, b } = setup();
  main.transact((tx) => tx.delete(a));
  branch.transact((tx) => tx.set(a, 'x', 99));
  // Deleted in the branch, untouched in the main file: simply deleted.
  branch.transact((tx) => tx.delete(b));
  const r = merge(base, main, branch);
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.name, c.ours, c.theirs]), [['exists', 'A', false, true]]);
  const deleted = fromSnapshot(r.snapshot!);
  assert.equal(deleted.store.isAlive(a), false, 'undecided — deleted, as in the main file');
  assert.equal(deleted.store.isAlive(b), false, 'the branch\'s deletion comes in');
  const kept = fromSnapshot(merge(base, main, branch, new Map([[r.conflicts[0]!.key, 'theirs']])).snapshot!);
  assert.equal(kept.get(a, 'x'), 99, 'kept with the branch\'s change');
});

test('merge: a frame deleted on one side with something changed inside on the other — one decision for the frame', () => {
  const { base, main, branch, frame, a, text } = setup();
  main.transact((tx) => tx.delete(frame));
  branch.transact((tx) => tx.set(text, 'characters', 'Здравствуйте'));
  const r = merge(base, main, branch);
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.name]), [['exists', 'Экран']]);
  const kept = fromSnapshot(merge(base, main, branch, new Map([[r.conflicts[0]!.key, 'theirs']])).snapshot!);
  assert.equal(kept.get(text, 'characters'), 'Здравствуйте');
  assert.equal(kept.store.isAlive(a), true, 'with everything inside');
  const gone = fromSnapshot(r.snapshot!);
  assert.equal(gone.store.isAlive(frame), false);
  assert.equal(gone.store.isAlive(text), false);
});

test('merge: a layer added into a frame deleted on the other side goes with the frame unless kept', () => {
  const { base, main, branch, frame } = setup();
  main.transact((tx) => tx.delete(frame));
  const added = branch.transact((tx) => tx.create('ELLIPSE', frame, { name: 'Круг' }));
  const r = merge(base, main, branch);
  assert.equal(r.conflicts.length, 1, 'something inside changed: the frame\'s deletion is a question');
  assert.equal(fromSnapshot(r.snapshot!).store.isAlive(added), false);
  assert.equal(fromSnapshot(merge(base, main, branch, new Map([[r.conflicts[0]!.key, 'theirs']])).snapshot!).store.isAlive(added), true);
});

test('merge: moves — one side moves, or both move differently (a conflict about the place)', () => {
  const { base, main, branch, a, page, frame } = setup();
  branch.transact((tx) => tx.move(a, page));
  const one = fromSnapshot(merge(base, main, branch).snapshot!);
  assert.equal(one.parent(a), page);
  main.transact((tx) => {
    const other = tx.create('FRAME', page, { name: 'Другой' });
    tx.move(a, other);
  });
  const r = merge(base, main, branch);
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.ours, c.theirs]), [['place', 'Другой', base.get(page, 'name')]]);
  assert.notEqual(frame, page);
});

test('merge: a text conflict can be decided by writing the text; runs that no longer fit are cut', () => {
  const { base, main, branch, text } = setup();
  main.transact((tx) => tx.set(text, 'characters', 'Привет, мир'));
  branch.transact((tx) => {
    tx.set(text, 'characters', 'Привет всем');
    tx.set(text, 'textRuns', [{ start: 7, end: 11, style: { fontWeight: 700 } }]);
  });
  const r = merge(base, main, branch);
  const key = r.conflicts.find((c) => c.prop === 'characters')!.key;
  const out = fromSnapshot(merge(base, main, branch, new Map([[key, { text: 'Привет!' }]])).snapshot!);
  assert.equal(out.get(text, 'characters'), 'Привет!');
  assert.deepEqual(out.get(text, 'textRuns'), [], 'the bold run was past the end');
});

test('merge: moves that would put two layers inside each other are reported, not merged', () => {
  const { main, page } = setup();
  // Two frames side by side in the common ancestor.
  const [f1, f2] = main.transact((tx) => [tx.create('FRAME', page, { name: 'Один' }), tx.create('FRAME', page, { name: 'Два' })]);
  const base = deserialize(serialize(main), 'base2');
  const theirs = deserialize(serialize(main), 'branch2');
  main.transact((tx) => tx.move(f1!, f2!));
  theirs.transact((tx) => tx.move(f2!, f1!));
  const r = merge(base, main, theirs);
  assert.equal(r.snapshot, null);
  assert.match(r.error!, /^cycle:/);
});

test('merge: the result goes into a live document as ordinary operations; undoing a merge is the reverse merge', () => {
  const { base, main, branch, a, b } = setup();
  main.transact((tx) => tx.set(b, 'x', 1));
  branch.transact((tx) => tx.set(a, 'x', 2));
  const before = snap(main);
  const r = merge(base, main, branch);
  main.transact((tx) => restoreVersion(tx, main, fromSnapshot(r.snapshot!), null, main.pages()[0]!));
  assert.equal(main.get(a, 'x'), 2);
  const after = snap(main);
  // Work goes on in the main file after the merge…
  main.transact((tx) => tx.set(b, 'x', 3));
  // …and undoing the merge takes back only what the branch brought.
  const undo = mergeSnapshots(after, snap(main), before);
  assert.equal(undo.conflicts.length, 0);
  main.transact((tx) => restoreVersion(tx, main, fromSnapshot(undo.snapshot!), null, main.pages()[0]!));
  assert.equal(main.get(a, 'x'), 10, 'the branch\'s change is gone');
  assert.equal(main.get(b, 'x'), 3, 'the later work stays');
});

test('countChanges: added, changed, moved and deleted layers', () => {
  const { base, main, a, b, frame, page } = setup();
  assert.equal(countChanges(snap(base), snap(main)), 0);
  main.transact((tx) => {
    tx.set(a, 'x', 1);
    tx.move(b, page);
    tx.create('ELLIPSE', frame);
    tx.delete(frame);
  });
  // a (changed, then deleted with the frame), b (moved), the ellipse (added, deleted with the frame — not in the file), the frame and its text (deleted).
  assert.equal(countChanges(snap(base), snap(main)), 4);
});
