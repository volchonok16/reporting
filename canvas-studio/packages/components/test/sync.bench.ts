// Benchmark: `node packages/components/test/sync.bench.ts` (N instances, default 500).
import { Document, hexToColor, solid, type Transaction } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import { convertFrameToComponent, createInstance, processTransaction } from '../src/index.ts';

const N = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.N ?? 500);
const measurer = new ApproximateTextMeasurer();
const edit = <T>(doc: Document, fn: (tx: Transaction) => T): T =>
  doc.transact((tx) => {
    const result = fn(tx);
    processTransaction(tx, measurer);
    return result;
  });
const time = (label: string, fn: () => void) => {
  const t = performance.now();
  fn();
  console.log(`${label}: ${(performance.now() - t).toFixed(1)} мс`);
};

const doc = Document.createEmpty('bench', 'a');
const page = doc.pages()[0]!;
const component = edit(doc, (tx) => {
  const frame = tx.create('FRAME', page, { name: 'Row', layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, itemSpacing: 4 });
  for (let i = 0; i < 20; i++) tx.create(i % 2 ? 'TEXT' : 'RECTANGLE', frame, { name: `L${i}`, characters: 'текст', width: 10, height: 10 });
  return convertFrameToComponent(doc, tx, frame);
});

time(`создать ${N} экземпляров по 21 слою`, () =>
  edit(doc, (tx) => {
    for (let i = 0; i < N; i++) createInstance(doc, tx, component, page, { x: (i % 25) * 400, y: Math.floor(i / 25) * 40 });
  }),
);
console.log(`узлов в документе: ${doc.store.size}`);
const leaf = doc.children(component)[3]!;
time(`изменить текст в компоненте → ${N} экземпляров`, () => edit(doc, (tx) => tx.set(leaf, 'characters', 'другой текст')));
time(`изменить заливку компонента → ${N} экземпляров`, () => edit(doc, (tx) => tx.set(component, 'fills', [solid(hexToColor('#ff0000')!)])));
const someText = doc.children(doc.children(page)[Math.min(N, 100)]!)[1]!;
time('переопределить слой одного экземпляра', () => edit(doc, (tx) => tx.set(someText, 'characters', 'override')));
const plain = edit(doc, (tx) => tx.create('RECTANGLE', page, {}));
time('изменить посторонний слой', () => edit(doc, (tx) => tx.set(plain, 'x', 5)));
