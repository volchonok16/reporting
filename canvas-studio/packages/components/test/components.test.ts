// Regression suite for the override model (FR-CMP-030…036, section 10.8):
// no override may be lost without an explicit reason.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, deserialize, hexToColor, serialize, solid, type NodeId, type NodeProps, type Op, type Transaction } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import {
  addPropertyFromLayer,
  addVariant,
  combineAsVariants,
  convertFrameToComponent,
  countOverrides,
  createInstance,
  detachInstance,
  findVariant,
  processTransaction,
  resetInstance,
  resetOverrides,
  sanitizePasted,
  setInstanceProperty,
  variantAxes,
} from '../src/index.ts';

const measurer = new ApproximateTextMeasurer();
const RED = hexToColor('#FF0000')!;
const BLUE = hexToColor('#0000FF')!;
const GREEN = hexToColor('#00FF00')!;

/** One user edit, processed exactly as the editor does. */
function edit<T>(doc: Document, fn: (tx: Transaction) => T): T {
  return doc.transact((tx) => {
    const result = fn(tx);
    processTransaction(tx, measurer);
    return result;
  });
}

function child(doc: Document, parent: NodeId, name: string): NodeId {
  let found: NodeId | null = null;
  doc.store.walk(parent, (id) => {
    if (found === null && doc.get(id, 'name') === name) found = id;
  });
  if (!found) throw new Error(`No layer «${name}» under ${doc.get(parent, 'name')}`);
  return found;
}

function fillOf(doc: Document, id: NodeId) {
  const paint = doc.get(id, 'fills')[0];
  return paint && paint.type === 'SOLID' ? paint.color : null;
}

/** A button component: frame with a label and an icon. */
function makeButton(doc: Document, page: NodeId, name = 'Кнопка'): NodeId {
  return edit(doc, (tx) => {
    const frame = tx.create('FRAME', page, { name, x: 0, y: 0, width: 120, height: 40, fills: [solid(BLUE)] });
    tx.create('TEXT', frame, { name: 'Подпись', characters: 'Купить', x: 10, y: 10 });
    tx.create('RECTANGLE', frame, { name: 'Иконка', x: 90, y: 10, width: 20, height: 20, constraints: { horizontal: 'MAX', vertical: 'MIN' } });
    return convertFrameToComponent(doc, tx, frame);
  });
}

function setup() {
  const doc = Document.createEmpty('Тест', 'alice');
  const page = doc.pages()[0]!;
  const button = makeButton(doc, page);
  return { doc, page, button };
}

function place(doc: Document, component: NodeId, parent: NodeId, props: Partial<NodeProps> = {}): NodeId {
  return edit(doc, (tx) => createInstance(doc, tx, component, parent, { x: 300, y: 0, ...props }));
}

test('an instance mirrors its component layer by layer', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  assert.equal(doc.type(inst), 'INSTANCE');
  assert.equal(doc.get(inst, 'name'), 'Кнопка');
  assert.deepEqual(doc.children(inst).map((c) => doc.get(c, 'name')), ['Подпись', 'Иконка']);
  const label = child(doc, inst, 'Подпись');
  assert.equal(doc.get(label, 'characters'), 'Купить');
  assert.equal(doc.get(label, 'componentKey'), child(doc, button, 'Подпись'));
  assert.deepEqual(fillOf(doc, inst), BLUE);
});

test('component edits propagate; overrides survive them (FR-CMP-034)', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  const label = child(doc, inst, 'Подпись');
  edit(doc, (tx) => tx.set(label, 'characters', 'В корзину'));
  assert.deepEqual(doc.get(label, 'overrides'), ['characters']);

  edit(doc, (tx) => {
    tx.set(child(doc, button, 'Подпись'), 'characters', 'Заказать');
    tx.set(child(doc, button, 'Подпись'), 'fontSize', 20);
    tx.set(button, 'fills', [solid(RED)]);
  });
  assert.equal(doc.get(label, 'characters'), 'В корзину', 'override kept');
  assert.equal(doc.get(label, 'fontSize'), 20, 'non-overridden property follows');
  assert.deepEqual(fillOf(doc, inst), RED);

  edit(doc, (tx) => resetOverrides(doc, tx, label));
  assert.equal(doc.get(label, 'characters'), 'Заказать', 'reset restores the component value');
});

test('layers added to or removed from the component appear in instances', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  const badge = edit(doc, (tx) => tx.create('ELLIPSE', button, { name: 'Значок', x: 2, y: 2, width: 6, height: 6 }));
  assert.ok(doc.children(inst).some((c) => doc.get(c, 'name') === 'Значок'));
  edit(doc, (tx) => tx.delete(badge));
  assert.ok(!doc.children(inst).some((c) => doc.get(c, 'name') === 'Значок'));
  edit(doc, (tx) => tx.move(child(doc, button, 'Иконка'), button, { at: 'start' }));
  assert.deepEqual(doc.children(inst).map((c) => doc.get(c, 'name')), ['Иконка', 'Подпись'], 'order follows the component');
});

test('resizing an instance applies constraints and is kept as an override', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  edit(doc, (tx) => tx.set(inst, 'width', 200));
  assert.equal(doc.get(child(doc, inst, 'Иконка'), 'x'), 170, 'right-pinned icon follows the right edge');
  assert.ok(doc.get(inst, 'overrides').includes('width'));
  edit(doc, (tx) => tx.set(button, 'height', 48));
  assert.equal(doc.get(inst, 'width'), 200);
  assert.equal(doc.get(inst, 'height'), 48);
});

test('switching variants keeps overrides of matching layers and parks the rest (FR-CMP-031)', () => {
  const { doc, page, button } = setup();
  const set = edit(doc, (tx) => combineAsVariants(doc, tx, [button], 'Кнопка'));
  const primary = doc.children(set)[0]!;
  const secondary = edit(doc, (tx) =>
    addVariant(doc, tx, primary, (t, id) => {
      // Same as the editor's duplicate: a structural copy keeps layer keys.
      const copy = t.create('COMPONENT', set, structuredClone(doc.store.record(id)!.props));
      for (const c of doc.children(id)) t.create(doc.type(c), copy, structuredClone(doc.store.record(c)!.props));
      return copy;
    }),
  );
  edit(doc, (tx) => {
    tx.set(secondary, 'fills', [solid(GREEN)]);
    tx.delete(child(doc, secondary, 'Иконка'));
  });
  assert.deepEqual(variantAxes(doc, set), [{ name: 'Свойство 1', values: ['По умолчанию', 'Вариант 2'] }]);

  const inst = place(doc, primary, page, { x: 0, y: 400 });
  edit(doc, (tx) => {
    tx.set(child(doc, inst, 'Подпись'), 'characters', 'Мой текст');
    tx.set(child(doc, inst, 'Иконка'), 'fills', [solid(RED)]);
  });

  edit(doc, (tx) => tx.set(inst, 'mainComponent', findVariant(doc, set, primary, 'Свойство 1', 'Вариант 2')!));
  assert.deepEqual(fillOf(doc, inst), GREEN);
  assert.equal(doc.get(child(doc, inst, 'Подпись'), 'characters'), 'Мой текст', 'text override kept across variants');
  assert.ok(!doc.children(inst).some((c) => doc.get(c, 'name') === 'Иконка'));

  edit(doc, (tx) => tx.set(inst, 'mainComponent', primary));
  assert.deepEqual(fillOf(doc, child(doc, inst, 'Иконка')), RED, 'parked override restored');
  assert.equal(doc.get(inst, 'name'), 'Кнопка', 'variant instances are named after the set');
});

/** Card component that contains a button instance. */
function makeCard(doc: Document, page: NodeId, button: NodeId) {
  return edit(doc, (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Карточка', x: 0, y: 200, width: 300, height: 200 });
    tx.create('TEXT', frame, { name: 'Заголовок', characters: 'Товар', x: 10, y: 10 });
    createInstance(doc, tx, button, frame, { name: 'Кнопка', x: 10, y: 150 });
    return convertFrameToComponent(doc, tx, frame);
  });
}

test('nested instances: overrides at each level stay at their level (FR-CMP-032)', () => {
  const { doc, page, button } = setup();
  const card = makeCard(doc, page, button);
  const innerInCard = child(doc, card, 'Кнопка');
  // Override inside the card component: becomes the default for every card.
  edit(doc, (tx) => tx.set(child(doc, innerInCard, 'Подпись'), 'characters', 'Подробнее'));

  const cardInst = place(doc, card, page, { x: 400, y: 200 });
  const nested = child(doc, cardInst, 'Кнопка');
  assert.equal(doc.type(nested), 'INSTANCE');
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Подробнее');

  // A local override on the card instance.
  edit(doc, (tx) => tx.set(child(doc, nested, 'Подпись'), 'characters', 'Купить сейчас'));
  // Base component changes still flow through two levels.
  edit(doc, (tx) => tx.set(button, 'fills', [solid(RED)]));
  assert.deepEqual(fillOf(doc, nested), RED);
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Купить сейчас');
  // Changing the card's own override does not touch the local one…
  edit(doc, (tx) => tx.set(child(doc, innerInCard, 'Подпись'), 'characters', 'Ещё'));
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Купить сейчас');
  // …until it is reset.
  edit(doc, (tx) => resetOverrides(doc, tx, child(doc, nested, 'Подпись')));
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Ещё');
});

test('swapping a nested instance survives changes of the outer component', () => {
  const { doc, page, button } = setup();
  const other = makeButton(doc, page, 'Ссылка');
  edit(doc, (tx) => tx.set(other, 'y', 600));
  const card = makeCard(doc, page, button);
  const cardInst = place(doc, card, page, { x: 400, y: 200 });
  const nested = child(doc, cardInst, 'Кнопка');
  edit(doc, (tx) => tx.set(nested, 'mainComponent', other));
  assert.ok(doc.get(nested, 'overrides').includes('mainComponent'));
  edit(doc, (tx) => tx.set(child(doc, card, 'Заголовок'), 'characters', 'Новый товар'));
  assert.equal(doc.get(nested, 'mainComponent'), other, 'swap kept');
  assert.equal(doc.get(child(doc, cardInst, 'Заголовок'), 'characters'), 'Новый товар');
  assert.equal(doc.get(nested, 'x'), 10, 'swapped instance keeps the slot position');
});

test('a copy of an instance keeps its overrides and stays linked (FR-CMP-033)', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  edit(doc, (tx) => tx.set(child(doc, inst, 'Подпись'), 'characters', 'Своё'));

  const copyTree = (id: NodeId, parent: NodeId, tx: Transaction, inside: boolean): NodeId => {
    const props = sanitizePasted(structuredClone(doc.store.record(id)!.props), doc.type(id), inside);
    const created = tx.create(doc.type(id), parent, props);
    for (const c of doc.children(id)) copyTree(c, created, tx, inside || doc.type(id) === 'INSTANCE');
    return created;
  };
  const copy = edit(doc, (tx) => copyTree(inst, page, tx, false));
  assert.equal(doc.get(child(doc, copy, 'Подпись'), 'characters'), 'Своё');
  edit(doc, (tx) => tx.set(child(doc, button, 'Подпись'), 'fontSize', 30));
  assert.equal(doc.get(child(doc, copy, 'Подпись'), 'fontSize'), 30, 'copy is still linked');
  assert.equal(doc.get(child(doc, copy, 'Подпись'), 'characters'), 'Своё');

  // A copy of an inner layer alone becomes a plain layer.
  const loose = edit(doc, (tx) => copyTree(child(doc, inst, 'Подпись'), page, tx, false));
  assert.equal(doc.get(loose, 'componentKey'), null);
  assert.deepEqual(doc.get(loose, 'overrides'), []);
});

test('component properties: text, boolean and instance swap (FR-CMP-010)', () => {
  const { doc, page, button } = setup();
  const other = makeButton(doc, page, 'Иконка-звезда');
  const textProp = edit(doc, (tx) => addPropertyFromLayer(doc, tx, child(doc, button, 'Подпись'), 'TEXT'));
  const showIcon = edit(doc, (tx) => addPropertyFromLayer(doc, tx, child(doc, button, 'Иконка'), 'BOOLEAN'));
  assert.equal(doc.get(button, 'componentProps').length, 2);

  const inst = place(doc, button, page);
  edit(doc, (tx) => {
    setInstanceProperty(doc, tx, inst, textProp, 'Оплатить');
    setInstanceProperty(doc, tx, inst, showIcon, false);
  });
  assert.equal(doc.get(child(doc, inst, 'Подпись'), 'characters'), 'Оплатить');
  assert.equal(doc.get(child(doc, inst, 'Иконка'), 'visible'), false);
  assert.deepEqual(doc.get(inst, 'overrides'), [], 'property values are not overrides');

  // Instance swap through a property on a nested instance.
  const card = makeCard(doc, page, button);
  const swap = edit(doc, (tx) => addPropertyFromLayer(doc, tx, child(doc, card, 'Кнопка'), 'INSTANCE_SWAP', 'Действие'));
  const cardInst = place(doc, card, page, { y: 500 });
  const nested = child(doc, cardInst, 'Кнопка');
  edit(doc, (tx) => setInstanceProperty(doc, tx, cardInst, swap, other));
  assert.equal(doc.get(nested, 'mainComponent'), other);
  assert.equal(doc.get(nested, 'name'), 'Иконка-звезда', 'a swapped instance is named after its new component');
  assert.deepEqual(doc.get(nested, 'overrides'), [], 'a property value is not an override');
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Купить');
});

test('detaching keeps the look; nested instances stay linked (FR-CMP-041)', () => {
  const { doc, page, button } = setup();
  const card = makeCard(doc, page, button);
  const cardInst = place(doc, card, page, { x: 400, y: 200 });
  edit(doc, (tx) => tx.set(child(doc, cardInst, 'Заголовок'), 'characters', 'Мой заголовок'));
  const frame = edit(doc, (tx) => detachInstance(doc, tx, cardInst));
  assert.equal(doc.type(frame), 'FRAME');
  assert.equal(doc.get(child(doc, frame, 'Заголовок'), 'characters'), 'Мой заголовок');
  assert.equal(doc.get(child(doc, frame, 'Заголовок'), 'componentKey'), null);
  const nested = child(doc, frame, 'Кнопка');
  assert.equal(doc.type(nested), 'INSTANCE');
  edit(doc, (tx) => tx.set(child(doc, button, 'Подпись'), 'characters', 'Оформить'));
  assert.equal(doc.get(child(doc, nested, 'Подпись'), 'characters'), 'Оформить', 'nested instance still follows its component');
  edit(doc, (tx) => tx.set(child(doc, card, 'Заголовок'), 'characters', 'Другое'));
  assert.equal(doc.get(child(doc, frame, 'Заголовок'), 'characters'), 'Мой заголовок', 'detached layers no longer follow');
});

test('deleted component: instances keep their last look (FR-CMP-042)', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  edit(doc, (tx) => tx.delete(button));
  assert.equal(doc.children(inst).length, 2);
  edit(doc, (tx) => tx.set(child(doc, inst, 'Подпись'), 'characters', 'Ещё работает'));
  assert.equal(doc.get(child(doc, inst, 'Подпись'), 'characters'), 'Ещё работает');
});

test('undo reverts a component edit together with its propagation', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  edit(doc, (tx) => tx.set(button, 'fills', [solid(RED)]));
  assert.deepEqual(fillOf(doc, inst), RED);
  doc.undo();
  assert.deepEqual(fillOf(doc, inst), BLUE);
  doc.redo();
  assert.deepEqual(fillOf(doc, inst), RED);
});

test('a component cannot contain an instance of itself', () => {
  const { doc, button } = setup();
  assert.throws(() => edit(doc, (tx) => createInstance(doc, tx, button, button)));
  const page = doc.pages()[0]!;
  const card = makeCard(doc, page, button);
  assert.throws(() => edit(doc, (tx) => createInstance(doc, tx, card, button)), 'indirect cycle');
});

test('auto layout: an override can grow the instance without touching the component', () => {
  const doc = Document.createEmpty('Тест', 'alice');
  const page = doc.pages()[0]!;
  const tag = edit(doc, (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Тег', layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, paddingLeft: 8, paddingRight: 8 });
    tx.create('TEXT', frame, { name: 'Текст', characters: 'Новинка', fontSize: 10 });
    return convertFrameToComponent(doc, tx, frame);
  });
  const inst = place(doc, tag, page);
  const before = doc.get(tag, 'width');
  edit(doc, (tx) => tx.set(child(doc, inst, 'Текст'), 'characters', 'Очень длинная метка'));
  assert.ok(doc.get(inst, 'width') > before);
  assert.equal(doc.get(tag, 'width'), before);
});

test('collaborators converge on the same instance tree', () => {
  const alice = Document.createEmpty('Тест', 'alice');
  const page = alice.pages()[0]!;
  const button = makeButton(alice, page);
  const bob = deserialize(serialize(alice), 'bob');
  const toBob: Op[] = [];
  alice.onLocalOps((ops) => toBob.push(...ops));
  const inst = place(alice, button, page);
  edit(alice, (tx) => tx.set(child(alice, inst, 'Подпись'), 'characters', 'Привет'));
  edit(alice, (tx) => tx.set(button, 'fills', [solid(RED)]));
  bob.applyRemote(toBob);
  const strip = (s: string) => JSON.parse(s).nodes;
  assert.deepEqual(strip(serialize(bob)), strip(serialize(alice)));
});

test('reset all clears every override in the instance', () => {
  const { doc, page, button } = setup();
  const inst = place(doc, button, page);
  edit(doc, (tx) => {
    tx.set(child(doc, inst, 'Подпись'), 'characters', 'А');
    tx.set(child(doc, inst, 'Иконка'), 'visible', false);
    tx.set(inst, 'fills', [solid(RED)]);
  });
  assert.equal(countOverrides(doc, inst), 3);
  edit(doc, (tx) => resetInstance(doc, tx, inst));
  assert.equal(countOverrides(doc, inst), 0);
  assert.equal(doc.get(child(doc, inst, 'Подпись'), 'characters'), 'Купить');
  assert.deepEqual(fillOf(doc, inst), BLUE);
});
