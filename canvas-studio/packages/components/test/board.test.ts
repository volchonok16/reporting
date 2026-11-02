// Board objects (FEAT-083): the board pass keeps stickies, shapes and connectors whole.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, solid, type BoardRole, type NodeId, type Transaction } from '#core';
import { ApproximateTextMeasurer, textStyleOf } from '#layout';
import { boardTextOf, processTransaction, STICKY_FONT_SIZES, STICKY_MIN_AUTO_FONT } from '../src/index.ts';

const measurer = new ApproximateTextMeasurer();

function edit<T>(doc: Document, fn: (tx: Transaction) => T): T {
  return doc.transact((tx) => {
    const v = fn(tx);
    processTransaction(tx, measurer);
    return v;
  });
}

function board() {
  const doc = Document.createEmpty('Доска', 'b');
  edit(doc, (tx) => tx.set(doc.rootId, 'fileKind', 'BOARD'));
  return { doc, page: doc.pages()[0]! };
}

function sticky(doc: Document, page: NodeId, text: string, x = 0, y = 0, author = 'Аня') {
  return edit(doc, (tx) => {
    const id = tx.create('FRAME', page, { x, y, width: 240, height: 240, fills: [solid({ r: 1, g: 0.85, b: 0.4, a: 1 })], board: { kind: 'STICKY', author } });
    tx.create('TEXT', id, { characters: text, board: { kind: 'STICKY_TEXT' }, textAutoResize: 'HEIGHT' });
    return id;
  });
}

function shape(doc: Document, page: NodeId, x: number, y: number, kind: 'RECTANGLE' | 'DIAMOND' = 'RECTANGLE', text = '') {
  return edit(doc, (tx) => {
    const id = tx.create('FRAME', page, { x, y, width: 160, height: 100, fills: [], clipsContent: false, board: { kind: 'SHAPE', shape: kind } });
    tx.create('VECTOR', id, { board: { kind: 'SHAPE_OUTLINE' }, fills: [solid({ r: 1, g: 1, b: 1, a: 1 })] });
    tx.create('TEXT', id, { characters: text, board: { kind: 'SHAPE_TEXT' }, textAutoResize: 'HEIGHT' });
    return id;
  });
}

function connector(doc: Document, page: NodeId, a: NodeId | null, b: NodeId | null, route: 'STRAIGHT' | 'ELBOW' | 'CURVE' = 'STRAIGHT') {
  return edit(doc, (tx) =>
    tx.create('VECTOR', page, { board: { kind: 'CONNECTOR', route, start: { node: a, side: 'AUTO', x: 0, y: 0 }, end: { node: b, side: 'AUTO', x: 600, y: 50 } }, endCap: 'ARROW' }),
  );
}

const role = (doc: Document, id: NodeId) => doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;

test('a sticky fits its text: short text is large, long text gets smaller, the author is at the bottom', () => {
  const { doc, page } = board();
  const short = sticky(doc, page, 'Идея');
  const text = boardTextOf(doc, short)!;
  assert.equal(doc.get(text, 'fontSize'), STICKY_FONT_SIZES[0]);
  const long = sticky(doc, page, 'Очень длинная мысль, которая не помещается крупным шрифтом. '.repeat(6), 300);
  const t2 = boardTextOf(doc, long)!;
  assert.ok(doc.get(t2, 'fontSize') < STICKY_FONT_SIZES[0]!, 'long text is smaller');
  assert.ok(doc.get(t2, 'fontSize') >= STICKY_MIN_AUTO_FONT, 'never unreadably small');
  assert.ok(doc.get(t2, 'y') + doc.get(t2, 'height') <= doc.get(long, 'height'), 'the text stays inside the note');
  const author = doc.children(short).find((c) => doc.get(c, 'board')?.kind === 'STICKY_AUTHOR')!;
  assert.equal(doc.get(author, 'characters'), 'Аня');
  assert.ok(doc.get(author, 'visible'));
  assert.ok(doc.get(author, 'y') > 180, 'the author is at the bottom');
  // The board hides authors: every sticky follows.
  edit(doc, (tx) => tx.set(doc.rootId, 'boardAuthors', false));
  assert.equal(doc.get(author, 'visible'), false);
  // A long word is never broken in the middle: the size goes down until it fits whole.
  const word = sticky(doc, page, 'Долгие согласования макетов', 600);
  const tw = boardTextOf(doc, word)!;
  const widest = measurer.measure({ ...textStyleOf(doc, tw), characters: 'согласования', runs: [] }, null).width;
  assert.ok(widest <= doc.get(tw, 'width'), 'the longest word fits on a line');
  // Typing more makes the text smaller as it goes.
  edit(doc, (tx) => tx.set(text, 'characters', 'Идея '.repeat(40)));
  assert.ok(doc.get(text, 'fontSize') < STICKY_FONT_SIZES[0]!);
  // Never unreadably small: past the smallest readable size the sticky grows down, as in FigJam (BUG-105).
  edit(doc, (tx) => tx.set(text, 'characters', 'Очень длинная мысль, которая не помещается. '.repeat(20)));
  assert.equal(doc.get(text, 'fontSize'), STICKY_MIN_AUTO_FONT);
  assert.ok(doc.get(short, 'height') > 240, 'the sticky grew');
  assert.ok(doc.get(text, 'y') + doc.get(text, 'height') <= doc.get(short, 'height'), 'the text stays inside the note');
});

test('a shape centres its text, grows when the text needs room, and redraws its outline at its size', () => {
  const { doc, page } = board();
  const id = shape(doc, page, 0, 0, 'DIAMOND', 'Да?');
  const text = boardTextOf(doc, id)!;
  const outline = doc.children(id).find((c) => doc.get(c, 'board')?.kind === 'SHAPE_OUTLINE')!;
  assert.equal(doc.get(outline, 'width'), 160);
  assert.deepEqual(doc.get(outline, 'vectorPaths')[0]!.points.map((p) => [p.x, p.y]), [[80, 0], [160, 50], [80, 100], [0, 50]]);
  const mid = doc.get(text, 'y') + doc.get(text, 'height') / 2;
  assert.ok(Math.abs(mid - 50) < 1, 'text is centred');
  edit(doc, (tx) => tx.set(text, 'characters', 'Длинный текст в ромбе, которому нужно гораздо больше места. '.repeat(3)));
  assert.ok(doc.get(id, 'height') > 100, 'the shape grew');
  assert.equal(doc.get(outline, 'height'), doc.get(id, 'height'), 'the outline follows');
  edit(doc, (tx) => tx.set(id, 'width', 300));
  assert.equal(doc.get(outline, 'vectorPaths')[0]!.points[1]!.x, 300);
});

test('a connector follows the layers it is attached to, from the facing sides', () => {
  const { doc, page } = board();
  const a = shape(doc, page, 0, 0);
  const b = shape(doc, page, 400, 0);
  const c = connector(doc, page, a, b);
  const pts = () => doc.get(c, 'vectorPaths')[0]!.points.map((p) => ({ x: p.x + doc.get(c, 'x'), y: p.y + doc.get(c, 'y') }));
  assert.deepEqual(pts(), [{ x: 160, y: 50 }, { x: 400, y: 50 }], 'right side of A to left side of B');
  edit(doc, (tx) => tx.update(b, { x: 0, y: 300 }));
  assert.deepEqual(pts(), [{ x: 80, y: 100 }, { x: 80, y: 300 }], 'bottom of A to top of B after B moved below');
  // Elbow: out of the sides and across.
  edit(doc, (tx) => tx.set(c, 'board', { ...role(doc, c), route: 'ELBOW' }));
  edit(doc, (tx) => tx.update(b, { x: 400, y: 300 }));
  const elbow = pts();
  assert.ok(elbow.length >= 3);
  for (let i = 1; i < elbow.length; i++) assert.ok(elbow[i]!.x === elbow[i - 1]!.x || elbow[i]!.y === elbow[i - 1]!.y, 'only right angles');
});

test('a connector inside a moved section still follows; a deleted layer leaves its end free in place', () => {
  const { doc, page } = board();
  const section = edit(doc, (tx) => tx.create('SECTION', page, { x: 0, y: 0, width: 800, height: 400 }));
  const a = edit(doc, (tx) => {
    const id = tx.create('FRAME', section, { x: 0, y: 0, width: 100, height: 100, board: { kind: 'SHAPE', shape: 'RECTANGLE' } });
    return id;
  });
  const b = shape(doc, page, 400, 0);
  const c = connector(doc, page, a, b);
  edit(doc, (tx) => tx.update(section, { x: 100 }));
  assert.equal(role(doc, c).start.x, 200, 'the end moved with the section');
  edit(doc, (tx) => tx.delete(b));
  assert.equal(role(doc, c).end.node, null);
  assert.equal(role(doc, c).end.x, 400, 'free where the layer was');
});

test('a connector dragged as a whole takes its free ends along; its label stays at the middle and goes with it', () => {
  const { doc, page } = board();
  const c = edit(doc, (tx) => tx.create('VECTOR', page, { board: { kind: 'CONNECTOR', route: 'STRAIGHT', start: { node: null, side: 'AUTO', x: 0, y: 0 }, end: { node: null, side: 'AUTO', x: 200, y: 0 } } }));
  const label = edit(doc, (tx) => {
    const id = tx.create('FRAME', page, { width: 40, height: 20, board: { kind: 'CONNECTOR_LABEL', connector: c } });
    tx.create('TEXT', id, { characters: 'да' });
    return id;
  });
  edit(doc, (tx) => tx.update(c, { x: 10, y: 20 }));
  assert.deepEqual([role(doc, c).start.x, role(doc, c).start.y, role(doc, c).end.x], [10, 20, 210]);
  assert.deepEqual([doc.get(label, 'x'), doc.get(label, 'y')], [90, 10]);
  edit(doc, (tx) => tx.delete(c));
  assert.equal(doc.store.isAlive(label), false, 'a label goes with its connector');
});

test('an elbow connector goes around an object in its way and keeps clear of it', () => {
  const { doc, page } = board();
  const a = shape(doc, page, 0, 0);
  const b = shape(doc, page, 600, 0);
  const wall = shape(doc, page, 280, -60, 'RECTANGLE');
  edit(doc, (tx) => tx.update(wall, { height: 220 }));
  const c = connector(doc, page, a, b, 'ELBOW');
  const pts = doc.get(c, 'vectorPaths')[0]!.points.map((p) => ({ x: p.x + doc.get(c, 'x'), y: p.y + doc.get(c, 'y') }));
  const w = { x: 280, y: -60, width: 160, height: 220 };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    assert.ok(p.x === q.x || p.y === q.y, 'right angles only');
    // A horizontal run at a height inside the wall must not span across it, and the other way round.
    if (p.y === q.y && p.y > w.y && p.y < w.y + w.height) assert.ok(Math.max(p.x, q.x) <= w.x || Math.min(p.x, q.x) >= w.x + w.width, 'not through the wall');
    if (p.x === q.x && p.x > w.x && p.x < w.x + w.width) assert.ok(Math.max(p.y, q.y) <= w.y || Math.min(p.y, q.y) >= w.y + w.height, 'not through the wall');
  }
  assert.deepEqual(pts[0], { x: 160, y: 50 });
  assert.deepEqual(pts[pts.length - 1], { x: 600, y: 50 });
  // Nothing in the way: the plain line.
  edit(doc, (tx) => tx.delete(wall));
  assert.equal(doc.get(c, 'vectorPaths')[0]!.points.length, 2);
});

test('a sticky with a size chosen by hand grows down when its text does not fit', () => {
  const { doc, page } = board();
  const id = sticky(doc, page, 'Крупный текст, который не помещается в обычный стикер целиком. '.repeat(3));
  edit(doc, (tx) => tx.set(id, 'board', { kind: 'STICKY', author: 'Аня', fontSize: 40 }));
  const text = boardTextOf(doc, id)!;
  assert.equal(doc.get(text, 'fontSize'), 40);
  assert.ok(doc.get(id, 'height') > 240, 'taller than a square');
  assert.ok(doc.get(text, 'y') + doc.get(text, 'height') <= doc.get(id, 'height'), 'the text is inside');
});

test('code highlighting: comments, strings, numbers, keywords, functions and types per language; markup, CSS and JSON', async () => {
  const { highlightCode, codeRuns } = await import('../src/code-highlight.ts');
  const kinds = (lang: Parameters<typeof highlightCode>[0], text: string) => highlightCode(lang, text).map((t) => `${t.kind}:${text.slice(t.start, t.end)}`);
  assert.deepEqual(kinds('js', 'const n = sum(1, 2.5); // итог\nnew Date("x")'), ['keyword:const', 'function:sum', 'number:1', 'number:2.5', 'comment:// итог', 'keyword:new', 'function:Date', 'string:"x"']);
  assert.deepEqual(kinds('py', 'def f(x):\n    return None  # нет\n"""док"""'), ['keyword:def', 'function:f', 'keyword:return', 'literal:None', 'comment:# нет', 'string:"""док"""']);
  assert.deepEqual(kinds('py', '// не комментарий'), [], 'Python has no // comments');
  assert.deepEqual(kinds('sql', 'SELECT name FROM users WHERE id = 7 -- один'), ['keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', 'number:7', 'comment:-- один']);
  assert.deepEqual(kinds('sh', 'echo "$HOME" $USER'), ['keyword:echo', 'string:"$HOME"', 'property:$USER']);
  assert.deepEqual(kinds('html', '<a href="/x">Привет</a><!-- c -->'), ['tag:a', 'attr:href', 'string:"/x"', 'tag:a', 'comment:<!-- c -->']);
  assert.deepEqual(kinds('css', '.btn { color: #fff; padding: 8px; }'), ['tag:.btn', 'property:color', 'number:#fff', 'property:padding', 'number:8px']);
  assert.deepEqual(kinds('json', '{"a": [1, true, "b"]}'), ['property:"a"', 'number:1', 'literal:true', 'string:"b"']);
  assert.deepEqual(kinds('plain', 'const x = 1'), []);
  assert.deepEqual(kinds('js', '"не закрыта\nx'), ['string:"не закрыта'], 'an open string ends with its line');
  const runs = codeRuns('js', 'let a');
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.style.fills?.[0]?.type]), [[0, 3, 'SOLID']]);
});

test('connectors: an edit routes only the lines it may move — typing far away leaves the others untouched, moving an end moves its line', () => {
  const { doc, page } = board();
  const a = shape(doc, page, 0, 0);
  const b = shape(doc, page, 600, 0);
  const c = shape(doc, page, 0, 3000);
  const d = shape(doc, page, 600, 3000);
  const line = (from: NodeId, to: NodeId) => edit(doc, (tx) => tx.create('VECTOR', page, { board: { kind: 'CONNECTOR', route: 'ELBOW', start: { node: from, side: 'AUTO', x: 0, y: 0 }, end: { node: to, side: 'AUTO', x: 0, y: 0 } } }));
  const near = line(a, b);
  const far = line(c, d);
  const text = boardTextOf(doc, c)!;
  // Typing in a shape: its own line is routed, the line 3000 px away is not even looked at.
  const changes = doc.transact((tx) => {
    tx.set(text, 'characters', 'Новый текст');
    processTransaction(tx, measurer);
    return tx.changes;
  });
  assert.equal(changes.updated.has(near), false, 'a line far from the edit is not touched');
  // Moving an end: the line follows.
  const before = role(doc, far).start;
  edit(doc, (tx) => tx.set(c, 'x', 200));
  assert.notDeepEqual(role(doc, far).start, before, 'the attached end follows its shape');
  const nearBefore = doc.get(near, 'vectorPaths');
  edit(doc, (tx) => tx.set(b, 'y', 150));
  assert.notDeepEqual(doc.get(near, 'vectorPaths'), nearBefore, 'the line of a moved shape is routed again');
});
