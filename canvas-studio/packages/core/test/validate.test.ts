import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymize, deserialize, Document, serialize, toSnapshot, validOp, type Op } from '../src/index.ts';

const hostile = (props: Record<string, unknown>) =>
  JSON.stringify({
    format: 'canvas-studio/document',
    schemaVersion: 1,
    savedAt: '',
    nodes: [
      { id: 'r', type: 'DOCUMENT', parent: null, index: 'a0', props: {} },
      { id: 'p', type: 'PAGE', parent: 'r', index: 'a0', props: {} },
      { id: 't', type: 'TEXT', parent: 'p', index: 'a0', props },
    ],
  });

test('a hand-written file: values that do not fit the schema are dropped, the rest opens (validate.ts)', () => {
  const doc = deserialize(
    hostile({
      name: 'Заголовок',
      characters: 'Привет',
      x: 'NaN',
      y: 12,
      width: 1e400, // Infinity after JSON.parse
      fontFamily: { toString: 'x' },
      textAlignH: 'LEFT; } body { background: red',
      visible: 'yes',
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      strokes: JSON.parse('[{"__proto__": {"polluted": true}}]'),
      madeUp: '<script>',
    }),
  );
  assert.equal(doc.get('t', 'name'), 'Заголовок');
  assert.equal(doc.get('t', 'characters'), 'Привет');
  assert.equal(doc.get('t', 'y'), 12);
  assert.equal(doc.get('t', 'x'), 0, 'a string where a number goes: the default');
  assert.equal(doc.get('t', 'width'), 0, 'Infinity: the default');
  assert.equal(doc.get('t', 'fontFamily'), 'Inter');
  assert.equal(doc.get('t', 'textAlignH'), 'LEFT', 'an enum takes a plain word only');
  assert.equal(doc.get('t', 'visible'), true);
  assert.equal(doc.get('t', 'fills').length, 1);
  assert.deepEqual(doc.get('t', 'strokes'), [], 'a «__proto__» key is not taken');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(!('madeUp' in toSnapshot(doc).nodes[2]!.props));
});

test('a file of a wrong shape is refused, too many layers too', () => {
  assert.throws(() => deserialize('{"format":"canvas-studio/document","schemaVersion":1,"nodes":"x"}'));
  assert.throws(() => deserialize(hostile({}).replace('"TEXT"', '"SCRIPT"')));
  assert.throws(() => deserialize('null'));
});

test('edits of a co-editor: an operation of a wrong shape or value is not applied, the right ones are', () => {
  const doc = Document.createEmpty('Т', 'test');
  const page = doc.pages()[0]!;
  const time = { counter: 5, session: 'peer' };
  const id = 'peer:1';
  doc.applyRemote([
    { kind: 'create', id, type: 'RECTANGLE', parent: page, index: 'a5', props: { name: 'Ок', width: 'wide', opacity: 0.5 }, time },
    { kind: 'set', id, key: 'x', value: { valueOf: 1 }, time: { counter: 6, session: 'peer' } },
    { kind: 'set', id, key: 'y', value: 40, time: { counter: 7, session: 'peer' } },
    { kind: 'set', id, key: '__proto__', value: 1, time: { counter: 8, session: 'peer' } },
    { kind: 'create', id: 'peer:2', type: 'NOPE', parent: page, index: 'a6', props: {}, time: { counter: 9, session: 'peer' } },
  ] as unknown as Op[]);
  assert.equal(doc.get(id, 'name'), 'Ок');
  assert.equal(doc.get(id, 'opacity'), 0.5);
  assert.equal(doc.get(id, 'width'), 100, 'the default width of a rectangle');
  assert.equal(doc.get(id, 'x'), 0);
  assert.equal(doc.get(id, 'y'), 40);
  assert.equal(doc.store.has('peer:2'), false);
  assert.equal(validOp({ kind: 'set', id, key: 'y', value: 1, time: { counter: -1, session: 'x' } }), null, 'a time of a wrong shape');
});

test('a copy without authors: stickies\' authors and voters are gone, the counts stay (Сохранить копию без авторов)', () => {
  const doc = Document.createEmpty('Доска', 'test');
  const page = doc.pages()[0]!;
  doc.transact((tx) => {
    const s = tx.create('FRAME', page, { name: 'Стикер', board: { kind: 'STICKY', author: 'Оля Петрова' } } as never);
    tx.create('TEXT', s, { name: 'Author', board: { kind: 'STICKY_AUTHOR' }, characters: 'Оля Петрова' } as never);
    tx.create('ELLIPSE', s, { board: { kind: 'VOTE', voter: 'user-olya', session: 'sess-1' } } as never);
    tx.create('ELLIPSE', s, { board: { kind: 'VOTE', voter: 'user-olya', session: 'sess-1' } } as never);
    tx.create('ELLIPSE', s, { board: { kind: 'VOTE', voter: 'user-ivan', session: 'sess-2' } } as never);
    tx.set(doc.rootId, 'boardVoting', { id: 'v', perPerson: 3, by: 'user-olya', open: true } as never);
  });
  const text = serialize(doc, { anonymous: true });
  assert.ok(!/Оля|user-olya|user-ivan|sess-/.test(text), text.slice(0, 300));
  const votes = anonymize(toSnapshot(doc)).nodes.map((n) => n.props.board as { kind: string; voter?: string } | undefined).filter((b) => b?.kind === 'VOTE').map((b) => b!.voter);
  assert.deepEqual(votes, ['v1', 'v1', 'v2'], 'the same person stays the same');
  assert.ok(serialize(doc).includes('Оля Петрова'), 'an ordinary copy keeps them');
});
