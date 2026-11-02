import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, snapshotKind } from '#core';
import { createDiagramDocument, diagramFamily, diagramSpec, diagramText, isDiagram, moveBranch, paletteFrom, sameDiagramText, withDiagramText } from '../src/diagram/model.ts';

test('a diagram file (FEAT-090): its kind in the root, known by the file list; one file — one text', () => {
  const doc = createDiagramDocument('Схема');
  assert.equal(isDiagram(doc), true);
  assert.equal(snapshotKind(serialize(doc)), 'diagram');
  const spec = diagramSpec(doc);
  assert.equal(spec.layout, 'radial');
  // Nothing written yet: the kind is chosen first, its example is only shown.
  assert.equal(spec.fresh, true);
  assert.equal(diagramText(spec), null);
  // A new file of a given kind (another kind opened in a new file): no choosing.
  const gantt = diagramSpec(createDiagramDocument('Схема', 'gantt'));
  assert.equal(gantt.layout, 'gantt');
  assert.equal(gantt.fresh, undefined);
  assert.equal(sameDiagramText('classic', 'horizontal'), true);
  assert.equal(sameDiagramText('lanes', 'ribbon'), true);
  assert.equal(sameDiagramText('flowchart', 'radial'), false);
  doc.transact((tx) => tx.set(doc.rootId, 'diagram', withDiagramText(spec, 'Корень\n    Ветка')));
  assert.equal(diagramText({ ...diagramSpec(doc), layout: 'classic' }), 'Корень\n    Ветка');
  // A file of before: texts per family are read, and dropped once the text is written.
  const old = { ...spec, layout: 'flowchart', texts: { tree: 'Карта', flowchart: '[А] -> [Б]' } };
  assert.equal(diagramText(old), '[А] -> [Б]');
  assert.deepEqual(withDiagramText(old, '[А] -> [В]').texts, undefined);
  assert.equal(diagramFamily('flowchart'), 'flowchart');
});

test('a map node dropped on another becomes its branch: its nested lines move along, indents follow (FEAT-092)', () => {
  const text = ['Корень', '    Цели', '        Цель 1', '            Подцель', '    Команда', '        Аня'].join('\n');
  // «Цель 1» (with «Подцель») under «Команда».
  assert.equal(moveBranch(text, 3, 5), ['Корень', '    Цели', '    Команда', '        Аня', '        Цель 1', '            Подцель'].join('\n'));
  // «Команда» under «Цели»: one level deeper, after «Цель 1».
  assert.equal(moveBranch(text, 5, 2), ['Корень', '    Цели', '        Цель 1', '            Подцель', '        Команда', '            Аня'].join('\n'));
  // Not into itself.
  assert.equal(moveBranch(text, 2, 4), null);
});

test('own colours from one colour: eight, distinct, the colour itself first (FEAT-095)', () => {
  const colors = paletteFrom('#E4572E');
  assert.equal(colors.length, 8);
  assert.equal(colors[0], '#E4572E');
  assert.equal(new Set(colors).size, 8);
  for (const c of colors) assert.match(c, /^#[0-9A-F]{6}$/);
  assert.deepEqual(paletteFrom('не цвет'), []);
});
