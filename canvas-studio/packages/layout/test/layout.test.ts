import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, type NodeId, type NodeProps } from '#core';
import { ApproximateTextMeasurer, applyLayout, constrainSpan, distribute, fitGroups, settleSizing, wrapText } from '../src/index.ts';

const measurer = new ApproximateTextMeasurer();

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  return { doc, page: doc.pages()[0]! };
}

function frame(doc: Document, parent: NodeId, props: Partial<NodeProps>): NodeId {
  return doc.transact((tx) => tx.create('FRAME', parent, props));
}

function rect(doc: Document, parent: NodeId, props: Partial<NodeProps> = {}): NodeId {
  return doc.transact((tx) => tx.create('RECTANGLE', parent, props));
}

function relayout(doc: Document, ids: NodeId[]) {
  doc.transact((tx) => applyLayout(doc, tx, ids, measurer));
}

function box(doc: Document, id: NodeId) {
  return { x: doc.get(id, 'x'), y: doc.get(id, 'y'), w: doc.get(id, 'width'), h: doc.get(id, 'height') };
}

test('horizontal stack with fixed gap, padding and hug', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, {
    layoutMode: 'HORIZONTAL',
    itemSpacing: 10,
    paddingLeft: 20, paddingRight: 20, paddingTop: 8, paddingBottom: 8,
    sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' },
  });
  const a = rect(doc, row, { width: 50, height: 30 });
  const b = rect(doc, row, { width: 70, height: 40 });
  relayout(doc, [row]);
  assert.deepEqual(box(doc, a), { x: 20, y: 8, w: 50, h: 30 });
  assert.deepEqual(box(doc, b), { x: 80, y: 8, w: 70, h: 40 });
  assert.equal(doc.get(row, 'width'), 170);
  assert.equal(doc.get(row, 'height'), 56);
});

test('70/30 split with fr units, and percent widths (FR-AL-005)', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', width: 1000, height: 100 });
  const left = rect(doc, row, { sizingH: { mode: 'FR', value: 7 } });
  const right = rect(doc, row, { sizingH: { mode: 'FR', value: 3 } });
  relayout(doc, [row]);
  assert.equal(doc.get(left, 'width'), 700);
  assert.equal(doc.get(right, 'width'), 300);
  assert.equal(doc.get(right, 'x'), 700);

  doc.transact((tx) => {
    tx.set(left, 'sizingH', { mode: 'PERCENT', value: 25 });
    tx.set(right, 'sizingH', { mode: 'FILL' });
  });
  relayout(doc, [row]);
  assert.equal(doc.get(left, 'width'), 250);
  assert.equal(doc.get(right, 'width'), 750);
});

test('fill respects min and max and redistributes the rest', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', width: 600, height: 50, itemSpacing: 0 });
  const a = rect(doc, row, { sizingH: { mode: 'FILL' }, maxWidth: { unit: 'PX', value: 100 } });
  const b = rect(doc, row, { sizingH: { mode: 'FILL' } });
  const c = rect(doc, row, { sizingH: { mode: 'FILL' }, minWidth: { unit: 'PERCENT', value: 50 } });
  relayout(doc, [row]);
  assert.equal(doc.get(a, 'width'), 100);
  assert.equal(doc.get(c, 'width'), 300, 'min 50% of 600');
  assert.equal(doc.get(b, 'width'), 200);
});

test('vertical stack: fill width, hug height, alignment and auto spacing', () => {
  const { doc, page } = setup();
  const col = frame(doc, page, {
    layoutMode: 'VERTICAL', width: 300, height: 400, paddingTop: 10, paddingBottom: 10,
    spacingMode: 'BETWEEN', counterAlign: 'CENTER',
  });
  const a = rect(doc, col, { width: 100, height: 50 });
  const b = rect(doc, col, { sizingH: { mode: 'FILL' }, height: 50 });
  const c = rect(doc, col, { width: 100, height: 80 });
  relayout(doc, [col]);
  assert.deepEqual(box(doc, a), { x: 100, y: 10, w: 100, h: 50 });
  assert.deepEqual(box(doc, b), { x: 0, y: 10 + 50 + 100, w: 300, h: 50 });
  assert.equal(doc.get(c, 'y'), 400 - 10 - 80);
});

test('text inside fill-width column wraps and grows the hugging parent', () => {
  const { doc, page } = setup();
  const card = frame(doc, page, { layoutMode: 'VERTICAL', width: 80, sizingV: { mode: 'HUG' }, paddingTop: 0 });
  const text = doc.transact((tx) =>
    tx.create('TEXT', card, { characters: 'один два три четыре', fontSize: 10, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' } }),
  );
  relayout(doc, [text]);
  assert.equal(doc.get(text, 'width'), 80);
  // 0.5em glyphs at 10px → 5px per char: the whole line is 95px > 80px, so "четыре" wraps to line 2.
  assert.equal(doc.get(text, 'height'), 24);
  assert.equal(doc.get(card, 'height'), 24);
});

test('nested auto layout: inner hug frame inside outer fill', () => {
  const { doc, page } = setup();
  const outer = frame(doc, page, { layoutMode: 'HORIZONTAL', width: 400, height: 100, itemSpacing: 0 });
  const inner = doc.transact((tx) => tx.create('FRAME', outer, { layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'FILL' }, itemSpacing: 4 }));
  rect(doc, inner, { width: 10, height: 10 });
  rect(doc, inner, { width: 10, height: 10 });
  const rest = rect(doc, outer, { sizingH: { mode: 'FILL' } });
  relayout(doc, [inner]);
  assert.equal(doc.get(inner, 'width'), 24);
  assert.equal(doc.get(inner, 'height'), 100);
  assert.equal(doc.get(rest, 'width'), 376);
  assert.equal(doc.get(rest, 'x'), 24);
});

test('wrap moves items to the next line', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', layoutWrap: true, width: 100, sizingV: { mode: 'HUG' }, itemSpacing: 10, counterAxisSpacing: 5 });
  const items = [0, 1, 2].map(() => rect(doc, row, { width: 40, height: 20 }));
  relayout(doc, [row]);
  assert.equal(doc.get(items[1]!, 'x'), 50);
  assert.equal(doc.get(items[2]!, 'x'), 0);
  assert.equal(doc.get(items[2]!, 'y'), 25);
  assert.equal(doc.get(row, 'height'), 45);
});

test('absolute and hidden children do not take part in the flow', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, itemSpacing: 10 });
  rect(doc, row, { width: 20, height: 20 });
  const badge = rect(doc, row, { width: 8, height: 8, positioning: 'ABSOLUTE', x: 500 });
  rect(doc, row, { width: 20, height: 20, visible: false });
  relayout(doc, [row]);
  assert.equal(doc.get(row, 'width'), 20);
  assert.equal(doc.get(badge, 'x'), 500);
});

test('layout result is one undo step together with the edit', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' } });
  const a = rect(doc, row, { width: 20, height: 20 });
  relayout(doc, [row]);
  doc.transact((tx) => {
    tx.set(a, 'width', 50);
    applyLayout(doc, tx, [a], measurer);
  });
  assert.equal(doc.get(row, 'width'), 50);
  doc.undo();
  assert.equal(doc.get(row, 'width'), 20);
});

test('a layer dragged out of a hugging frame leaves no gap behind (BUG-089)', () => {
  const { doc, page } = setup();
  const cell = frame(doc, page, { layoutMode: 'VERTICAL', paddingTop: 6, paddingBottom: 6, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const text = rect(doc, cell, { width: 100, height: 12 });
  relayout(doc, [cell]);
  const passing = rect(doc, page, { width: 160, height: 110 });
  // In and out within one drag, as the pointer crosses the cell.
  doc.transact((tx) => {
    tx.move(passing, cell, { index: 0 });
    applyLayout(doc, tx, tx.changes.touched(), measurer);
  });
  assert.equal(doc.get(cell, 'height'), 6 + 110 + 12 + 6);
  doc.transact((tx) => {
    tx.move(passing, page, { at: 'end' });
    applyLayout(doc, tx, tx.changes.touched(), measurer);
  });
  assert.equal(doc.get(cell, 'height'), 24);
  assert.equal(doc.get(text, 'y'), 6);
});

test('auto layout inside a plain frame inside auto layout is laid out too (BUG-090)', () => {
  const { doc, page } = setup();
  const body = frame(doc, page, { layoutMode: 'VERTICAL', width: 400, sizingV: { mode: 'HUG' } });
  const plain = frame(doc, body, { width: 400, height: 200 });
  const caption = frame(doc, plain, { layoutMode: 'VERTICAL', width: 300, sizingV: { mode: 'HUG' } });
  const text = doc.transact((tx) => tx.create('TEXT', caption, { characters: 'Подпись', width: 100, sizingH: { mode: 'FILL' }, textAutoResize: 'HEIGHT' }));
  relayout(doc, [text, plain, body]);
  assert.equal(doc.get(text, 'width'), 300);
});

test('groups fit their children', () => {
  const { doc, page } = setup();
  const group = doc.transact((tx) => tx.create('GROUP', page, { x: 100, y: 100 }));
  const a = rect(doc, group, { x: 10, y: 20, width: 30, height: 30 });
  rect(doc, group, { x: 50, y: 40, width: 10, height: 10 });
  doc.transact((tx) => fitGroups(doc, tx, [a]));
  assert.deepEqual(box(doc, group), { x: 110, y: 120, w: 50, h: 30 });
  assert.deepEqual(box(doc, a), { x: 0, y: 0, w: 30, h: 30 });
});

test('groups fit their turned children by the corners, not by the unturned box', () => {
  const { doc, page } = setup();
  const group = doc.transact((tx) => tx.create('GROUP', page, { x: 0, y: 0 }));
  // A 100 × 20 bar turned 90° about its origin lies from x −20 to 0, y 0 to 100.
  const a = rect(doc, group, { x: 0, y: 0, width: 100, height: 20, rotation: 90 });
  doc.transact((tx) => fitGroups(doc, tx, [a]));
  assert.deepEqual(box(doc, group), { x: -20, y: 0, w: 20, h: 100 });
});

test('constraints', () => {
  assert.deepEqual(constrainSpan('MAX', { start: 80, size: 10 }, 100, 200), { start: 180, size: 10 });
  assert.deepEqual(constrainSpan('STRETCH', { start: 10, size: 80 }, 100, 200), { start: 10, size: 180 });
  assert.deepEqual(constrainSpan('CENTER', { start: 45, size: 10 }, 100, 200), { start: 95, size: 10 });
  assert.deepEqual(constrainSpan('SCALE', { start: 10, size: 20 }, 100, 200), { start: 20, size: 40 });
});

test('distribute and wrapText helpers', () => {
  assert.deepEqual(distribute([{ base: 0, grow: 1, min: 0, max: Infinity }, { base: 0, grow: 3, min: 0, max: Infinity }], 400), [100, 300]);
  const lines = wrapText('aaaa bbbb cc', 9, (s) => s.length);
  assert.deepEqual(lines.map((l) => l.text), ['aaaa bbbb', 'cc']);
  // A word longer than the line sticks out, as in CSS; Chinese breaks between letters.
  assert.deepEqual(wrapText('abcdefghij', 4, (s) => s.length).map((l) => l.text), ['abcdefghij']);
  assert.deepEqual(wrapText('中文字体排版', 4, (s) => s.length).map((l) => l.text), ['中文字体', '排版']);
});

test('text layout: lists, paragraph spacing and indent, truncation (FEAT-018)', async () => {
  const { layoutText } = await import('../src/text-measure.ts');
  const widthOf = (s: string) => [...s].length * 10;
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 20, lineHeight: { unit: 'PX' as const, value: 30 }, letterSpacing: { unit: 'PX' as const, value: 0 }, textCase: 'ORIGINAL' as const };
  const list = layoutText({ ...base, characters: 'один\n\nдва', paragraphSpacing: 8, listType: 'NUMBER' }, null, widthOf);
  assert.deepEqual(list.lines.map((l) => l.marker), ['1.', undefined, '2.'], 'empty paragraphs are not numbered');
  assert.deepEqual(list.lines.map((l) => l.y), [0, 38, 76], 'paragraph spacing between paragraphs');
  assert.equal(list.height, 106);
  assert.ok(list.lines[0]!.x! > 0 && list.lines[0]!.markerX! < list.lines[0]!.x!);

  const indented = layoutText({ ...base, characters: 'aaa bbb ccc ddd', paragraphSpacing: 0, paragraphIndent: 30 }, 100, widthOf);
  assert.equal(indented.lines[0]!.x, 30);
  assert.equal(indented.lines[1]!.x, 0);
  assert.ok(indented.lines.every((l) => (l.x ?? 0) + l.width <= 100));

  const cut = layoutText({ ...base, characters: 'aaa bbb ccc ddd eee fff', paragraphSpacing: 0, maxLines: 2 }, 70, widthOf);
  assert.equal(cut.lines.length, 2);
  assert.ok(cut.lines[1]!.text.endsWith('…'));
  assert.ok(cut.lines[1]!.width <= 70);
  assert.equal(cut.height, 60);
});

test('rich text runs: apply, edit, read a range (stage "Text for real")', async () => {
  const { applyRunStyle, editRuns, rangeValue, MIXED_RUN, normalizeRuns } = await import('../src/rich-text.ts');
  const base = { fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 16, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  // "Hello world": make "world" bold.
  let runs = applyRunStyle([], 11, 6, 11, { fontWeight: 700 });
  assert.deepEqual(runs, [{ start: 6, end: 11, style: { fontWeight: 700 } }]);
  assert.equal(rangeValue(runs, base, 6, 11, 'fontWeight'), 700);
  assert.equal(rangeValue(runs, base, 0, 11, 'fontWeight'), MIXED_RUN);
  assert.equal(rangeValue(runs, base, 0, 5, 'fontWeight'), 400);
  // Italic over "lo wo": splits the bold run.
  runs = applyRunStyle(runs, 11, 3, 8, { italic: true });
  assert.equal(runs.length, 3);
  assert.equal(rangeValue(runs, base, 3, 8, 'italic'), true);
  // Removing the italic merges runs back.
  runs = applyRunStyle(runs, 11, 0, 11, { italic: undefined });
  assert.deepEqual(runs, [{ start: 6, end: 11, style: { fontWeight: 700 } }]);
  // Typing inside "world" keeps it bold; typing before it does not.
  let edited = editRuns(runs, 8, 0, 3, 14);
  assert.deepEqual(edited, [{ start: 6, end: 14, style: { fontWeight: 700 } }]);
  edited = editRuns(runs, 2, 0, 2, 13);
  assert.deepEqual(edited, [{ start: 8, end: 13, style: { fontWeight: 700 } }]);
  // Deleting across the run edge.
  edited = editRuns(runs, 4, 4, 0, 7);
  assert.deepEqual(edited, [{ start: 4, end: 7, style: { fontWeight: 700 } }]);
  // Pending style for typed text.
  edited = editRuns([], 5, 0, 1, 12, { italic: true });
  assert.deepEqual(edited, [{ start: 5, end: 6, style: { italic: true } }]);
  assert.deepEqual(normalizeRuns([{ start: 0, end: 3, style: { fontWeight: 400 } }], 5, base), [], 'overrides equal to the base are dropped');
});

test('rich text layout: mixed sizes share a baseline; caret and hit testing agree', async () => {
  const { layoutRichText, caretAt, indexAt } = await import('../src/rich-text.ts');
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = { characters: 'aa BB cc', base, runs: [{ start: 3, end: 5, style: { fontSize: 30 } }], lineHeight: { unit: 'AUTO' as const }, paragraphSpacing: 0, paragraphIndent: 0, listType: 'NONE' as const, maxLines: 0, textCase: 'ORIGINAL' as const };
  const one = layoutRichText(style, null, api);
  assert.equal(one.lines.length, 1);
  assert.equal(one.lines[0]!.height, 36, 'line height follows the largest font');
  assert.equal(one.lines[0]!.fragments.length, 3);
  const wrapped = layoutRichText(style, 40, api);
  assert.ok(wrapped.lines.length >= 2);
  for (let i = 0; i <= 8; i++) {
    const c = caretAt(one, i, api, one.width, 'LEFT');
    assert.equal(indexAt(one, c.x, c.y + c.height / 2, api, one.width, 'LEFT'), i, `caret ${i}`);
  }
  const sup = layoutRichText({ ...style, runs: [{ start: 3, end: 5, style: { baseline: 'SUPER' } }] }, null, api);
  const frag = sup.lines[0]!.fragments[1]!;
  assert.ok(frag.shift < 0 && frag.font.fontSize < 10, 'superscript is smaller and raised');
});

test('hanging punctuation and hanging lists: the marks stand outside the edge, the letters line up', async () => {
  const { layoutRichText, lineOffset } = await import('../src/rich-text.ts');
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = { characters: '«Цитата» и ещё.', base, runs: [], lineHeight: { unit: 'AUTO' as const }, paragraphSpacing: 0, paragraphIndent: 0, listType: 'NONE' as const, maxLines: 0, textCase: 'ORIGINAL' as const };
  const plain = layoutRichText(style, 200, api).lines[0]!;
  assert.equal(lineOffset(plain, 200, 'LEFT'), 0);
  const hung = layoutRichText({ ...style, hangingPunctuation: true }, 200, api).lines[0]!;
  assert.equal(lineOffset(hung, 200, 'LEFT'), -5, 'the opening quote (5 px) goes past the left edge');
  assert.equal(lineOffset(hung, 200, 'RIGHT') - lineOffset(plain, 200, 'RIGHT'), 5, 'the full stop past the right edge');
  const list = { ...style, characters: 'один\nдва', listType: 'BULLET' as const };
  const normal = layoutRichText(list, 200, api).lines[0]!;
  assert.ok(normal.x > 0 && (normal.markerX ?? -1) >= 0);
  const hanging = layoutRichText({ ...list, hangingList: true }, 200, api).lines[0]!;
  assert.equal(hanging.x, 0, 'the items’ text at the edge');
  assert.ok((hanging.markerX ?? 0) < 0, 'the marker outside');
});

test('line wrapping: balanced lines are about equal, «no orphans» keeps two words on the last line; never more lines', async () => {
  const { layoutRichText } = await import('../src/rich-text.ts');
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = { characters: 'aaaa bbbb cccc dddd eeee ffff gggg hh', base, runs: [], lineHeight: { unit: 'AUTO' as const }, paragraphSpacing: 0, paragraphIndent: 0, listType: 'NONE' as const, maxLines: 0, textCase: 'ORIGINAL' as const };
  const lone = layoutRichText({ ...style, characters: 'aaaa bbbb cccc dddd eeee' }, 100, api).lines;
  assert.equal(lone[lone.length - 1]!.text.trim(), 'eeee', 'one word alone without the option');
  const pretty = layoutRichText({ ...style, characters: 'aaaa bbbb cccc dddd eeee', textWrap: 'PRETTY' }, 100, api).lines;
  assert.equal(pretty.length, lone.length);
  assert.equal(pretty[pretty.length - 1]!.text.trim(), 'dddd eeee');
  const prep = layoutRichText({ ...style, characters: 'aaaa bbbb cccc ddd в eeee ffff', textWrap: 'PRETTY' }, 100, api).lines;
  assert.ok(prep.every((l) => !/ в\s*$/.test(l.text)), 'a preposition goes down with its word');
  const head = { ...style, characters: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh i' };
  const plain = layoutRichText(head, 150, api).lines.map((l) => l.width);
  const balanced = layoutRichText({ ...head, textWrap: 'BALANCE' }, 150, api).lines.map((l) => l.width);
  assert.equal(balanced.length, plain.length);
  assert.ok(Math.max(...balanced) - Math.min(...balanced) < Math.max(...plain) - Math.min(...plain), `${balanced} vs ${plain}`);
});

test('nested lists: levels indent, markers by level (• ◦ ▪, 1. a. i.), numbering restarts; levels follow edits; list spacing', async () => {
  const { layoutRichText, editListLevels, listMarker } = await import('../src/rich-text.ts');
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = { characters: 'one\ntwo\nthree\nfour', base, runs: [], lineHeight: { unit: 'PX' as const, value: 20 }, paragraphSpacing: 4, paragraphIndent: 0, listType: 'NUMBER' as const, maxLines: 0, textCase: 'ORIGINAL' as const, listLevels: [0, 1, 1, 0] };
  const lines = layoutRichText(style, 300, api).lines;
  assert.deepEqual(lines.map((l) => l.marker), ['1.', 'a.', 'b.', '2.']);
  assert.ok(lines[1]!.x > lines[0]!.x && lines[1]!.x === lines[2]!.x && lines[3]!.x === lines[0]!.x);
  assert.deepEqual([listMarker('BULLET', 0, 1), listMarker('BULLET', 1, 1), listMarker('BULLET', 2, 1), listMarker('NUMBER', 2, 4)], ['•', '◦', '▪', 'iv.']);
  const spaced = layoutRichText({ ...style, listSpacing: 10 }, 300, api).lines;
  assert.equal(spaced[1]!.y - spaced[0]!.y, 30, 'items 10 px apart instead of the paragraph spacing');
  // Enter in the middle of «two» (level 1): the new paragraph is level 1 too; joining it back removes it.
  const text = 'one\ntwo\nthree';
  const split = 'one\ntw\no\nthree';
  assert.deepEqual(editListLevels([0, 1, 2], text, split, 6, 0, 1), [0, 1, 1, 2]);
  assert.deepEqual(editListLevels([0, 1, 1, 2], split, text, 6, 1, 0), [0, 1, 2]);
});

test('decorations: a bar by default, dashes, dots and a wave as filled outlines; thickness and offset', async () => {
  const { decorationPath } = await import('../src/rich-text.ts');
  assert.equal(decorationPath('UNDERLINE', 0, 20, 100, 16), 'M0 21.92H100V22.92H0Z');
  assert.equal(decorationPath('UNDERLINE', 0, 20, 100, 16, { style: 'SOLID', thickness: 2, offset: 4 }), 'M0 24H100V26H0Z');
  assert.equal((decorationPath('UNDERLINE', 0, 20, 100, 16, { style: 'DASHED', thickness: 1, offset: null }).match(/Z/g) ?? []).length, 17);
  assert.ok((decorationPath('UNDERLINE', 0, 20, 100, 16, { style: 'DOTTED', thickness: 2, offset: null }).match(/Z/g) ?? []).length >= 24);
  const wave = decorationPath('UNDERLINE', 0, 20, 100, 16, { style: 'WAVY', thickness: 1, offset: null });
  assert.equal((wave.match(/Z/g) ?? []).length, 1);
  assert.equal(decorationPath('UNDERLINE', 0, 20, 0, 16), '');
});

test('right to left: Hebrew and Arabic paragraphs mirror their fragments; the caret starts at the right', async () => {
  const { layoutRichText, firstStrongIsRtl, caretAt } = await import('../src/rich-text.ts');
  assert.equal(firstStrongIsRtl('  «שלום»'), true);
  assert.equal(firstStrongIsRtl('123 مرحبا'), true);
  assert.equal(firstStrongIsRtl('Simmetrika גרסה'), false);
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = { characters: 'אב גד', base, runs: [{ start: 3, end: 5, style: { fontWeight: 700 } }], lineHeight: { unit: 'AUTO' as const }, paragraphSpacing: 0, paragraphIndent: 0, listType: 'NONE' as const, maxLines: 0, textCase: 'ORIGINAL' as const };
  const layout = layoutRichText(style, null, api);
  const line = layout.lines[0]!;
  assert.equal(line.rtl, true);
  assert.ok(line.fragments[0]!.x > line.fragments[1]!.x, 'the first word on the right');
  assert.equal(caretAt(layout, 0, api, layout.width, 'LEFT').x, line.width);
  const ltr = layoutRichText({ ...style, textDirection: 'LTR' as const }, null, api).lines[0]!;
  assert.ok(!ltr.rtl && ltr.fragments[0]!.x === 0);
});

test('as in Figma: a rotated child takes its rotated bounding box in the flow', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', itemSpacing: 10, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const a = rect(doc, row, { width: 100, height: 20, rotation: 90 });
  const b = rect(doc, row, { width: 30, height: 30 });
  relayout(doc, [row]);
  // 100×20 turned by 90° is 20 wide and 100 tall; its origin (top-left before turning) ends up on the right.
  assert.deepEqual(box(doc, a), { x: 20, y: 0, w: 100, h: 20 });
  assert.deepEqual(box(doc, b), { x: 30, y: 0, w: 30, h: 30 });
  assert.deepEqual({ w: doc.get(row, 'width'), h: doc.get(row, 'height') }, { w: 60, h: 100 });
});

test('as in Figma: "auto" spacing in a hugging column keeps its gap; one child sits at the start', () => {
  const { doc, page } = setup();
  const col = frame(doc, page, { layoutMode: 'VERTICAL', spacingMode: 'BETWEEN', itemSpacing: 12, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const a = rect(doc, col, { width: 40, height: 20 });
  const b = rect(doc, col, { width: 40, height: 20 });
  relayout(doc, [col]);
  assert.equal(doc.get(b, 'y') - (doc.get(a, 'y') + 20), 12);
  assert.equal(doc.get(col, 'height'), 52);

  const single = frame(doc, page, { layoutMode: 'HORIZONTAL', spacingMode: 'BETWEEN', primaryAlign: 'CENTER', width: 200, height: 40 });
  const only = rect(doc, single, { width: 40, height: 20 });
  relayout(doc, [single]);
  assert.equal(doc.get(only, 'x'), 0);
});

test('as in Figma: wrapped rows move together by the counter alignment in a taller frame', () => {
  const { doc, page } = setup();
  const wrap = frame(doc, page, { layoutMode: 'HORIZONTAL', layoutWrap: true, itemSpacing: 10, counterAxisSpacing: 10, counterAlign: 'CENTER', width: 100, height: 200 });
  const items = [0, 1, 2].map(() => rect(doc, wrap, { width: 40, height: 40 }));
  relayout(doc, [wrap]);
  // Two rows (40 + 10 + 40 = 90) centred in 200: they start at 55.
  assert.deepEqual(items.map((i) => [doc.get(i, 'x'), doc.get(i, 'y')]), [[0, 55], [50, 55], [0, 105]]);
});

test('as in Figma: "include strokes" — the frame stroke pads the content, children strokes take room', () => {
  const { doc, page } = setup();
  const black = { type: 'SOLID' as const, color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', itemSpacing: 0, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, strokes: [black], strokeWeight: 4, strokeAlign: 'INSIDE' });
  const a = rect(doc, row, { width: 40, height: 20, strokes: [black], strokeWeight: 2, strokeAlign: 'OUTSIDE' });
  const b = rect(doc, row, { width: 40, height: 20 });
  relayout(doc, [row]);
  // Off: strokes overlap neighbours and the frame's border.
  assert.deepEqual([box(doc, a).x, box(doc, b).x, doc.get(row, 'width')], [0, 40, 80]);
  doc.transact((tx) => tx.set(row, 'strokesIncludedInLayout', true));
  relayout(doc, [row]);
  // On: 4 px border inside the frame, 2 px stroke around the first rectangle.
  assert.deepEqual(box(doc, a), { x: 6, y: 6, w: 40, h: 20 });
  assert.equal(box(doc, b).x, 48);
  assert.deepEqual({ w: doc.get(row, 'width'), h: doc.get(row, 'height') }, { w: 92, h: 32 });
});

test('grid: fixed, fr and content-sized tracks, gaps, padding, reading-order placement (FR-AL-020)', () => {
  const { doc, page } = setup();
  const grid = frame(doc, page, {
    layoutMode: 'GRID',
    width: 420,
    sizingH: { mode: 'FIXED' }, sizingV: { mode: 'HUG' },
    paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10,
    gridColumns: [{ kind: 'FIXED', value: 100 }, { kind: 'FR', value: 1 }, { kind: 'FR', value: 2 }],
    gridRows: [],
    gridColumnGap: 20, gridRowGap: 8,
  });
  const cells = Array.from({ length: 5 }, (_, i) => rect(doc, grid, { width: 40, height: 30 + i * 10, sizingH: { mode: 'FILL' } }));
  relayout(doc, [grid]);
  // Room for shares: 400 − 100 − 2×20 = 260 → 1fr ≈ 86.67, 2fr ≈ 173.33.
  assert.deepEqual(box(doc, cells[0]!), { x: 10, y: 10, w: 100, h: 30 });
  assert.deepEqual(box(doc, cells[1]!), { x: 130, y: 10, w: 86.667, h: 40 });
  assert.deepEqual(box(doc, cells[2]!), { x: 236.667, y: 10, w: 173.333, h: 50 });
  // Second row starts below the tallest of the first (50) and the row gap.
  assert.deepEqual(box(doc, cells[3]!), { x: 10, y: 68, w: 100, h: 60 });
  assert.equal(doc.get(grid, 'height'), 10 + 50 + 8 + 70 + 10, 'rows grow with content, the frame hugs them');
});

test('grid: explicit cells, spans, fill and alignment in the cell; extra columns for far placements', () => {
  const { doc, page } = setup();
  const grid = frame(doc, page, {
    layoutMode: 'GRID', width: 300, height: 200, sizingH: { mode: 'FIXED' }, sizingV: { mode: 'FIXED' },
    gridColumns: [{ kind: 'FR', value: 1 }, { kind: 'FR', value: 1 }], gridRows: [{ kind: 'FR', value: 1 }, { kind: 'FR', value: 1 }],
    gridColumnGap: 0, gridRowGap: 0,
  });
  const wide = rect(doc, grid, { width: 10, height: 10, gridColumn: 0, gridRow: 1, gridColumnSpan: 2, sizingH: { mode: 'FILL' }, sizingV: { mode: 'FILL' } });
  const centered = rect(doc, grid, { width: 20, height: 20, gridColumn: 1, gridRow: 0, gridAlignH: 'CENTER', gridAlignV: 'MAX' });
  const auto = rect(doc, grid, { width: 30, height: 30 });
  relayout(doc, [grid]);
  assert.deepEqual(box(doc, wide), { x: 0, y: 100, w: 300, h: 100 }, 'spans both columns of the second row');
  assert.deepEqual(box(doc, centered), { x: 215, y: 80, w: 20, h: 20 });
  assert.deepEqual(box(doc, auto), { x: 0, y: 0, w: 30, h: 30 }, 'the first free cell');
  // A layer placed beyond the columns adds one sized by its content.
  const far = rect(doc, grid, { width: 50, height: 10, gridColumn: 2, gridRow: 0 });
  relayout(doc, [grid]);
  assert.equal(doc.get(far, 'width'), 50);
  assert.equal(doc.get(far, 'x'), 250, 'two shares split what the content-sized third column leaves');
});

test('grid: a hugging grid sizes shares by content', () => {
  const { doc, page } = setup();
  const grid = frame(doc, page, {
    layoutMode: 'GRID', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' },
    gridColumns: [{ kind: 'FR', value: 1 }, { kind: 'HUG' }], gridRows: [], gridColumnGap: 10, gridRowGap: 0,
  });
  rect(doc, grid, { width: 60, height: 20 });
  rect(doc, grid, { width: 30, height: 40 });
  relayout(doc, [grid]);
  assert.equal(doc.get(grid, 'width'), 100);
  assert.equal(doc.get(grid, 'height'), 40);
});

test('vertical trim: the box runs from the first line capitals to the last line baseline', async () => {
  const { ApproximateTextMeasurer } = await import('../src/index.ts');
  const m = new ApproximateTextMeasurer();
  const style = { characters: 'Кнопка\nвторая', fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 20, lineHeight: { unit: 'PX' as const, value: 30 }, letterSpacing: { unit: 'PX' as const, value: 0 }, paragraphSpacing: 0, textCase: 'ORIGINAL' as const };
  const plain = m.measure(style, null);
  const trimmed = m.measure({ ...style, leadingTrim: 'CAP_HEIGHT' }, null);
  const first = plain.layout.lines[0]!;
  const last = plain.layout.lines[plain.layout.lines.length - 1]!;
  const top = first.y + first.baseline - 20 * 0.7;
  const bottom = last.height - last.baseline;
  assert.ok(Math.abs(trimmed.height - (plain.height - top - bottom)) < 1e-6);
  assert.ok(Math.abs(trimmed.layout.lines[0]!.y + trimmed.layout.lines[0]!.baseline - 14) < 1e-6, 'the first baseline sits a cap height below the top');
});

test('text on a path: letters follow the line, turned along it, centred on the offset', async () => {
  const { pathTextGlyphs } = await import('../src/path-text.ts');
  const m = new ApproximateTextMeasurer();
  const style = { characters: 'abcd', fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 20, lineHeight: { unit: 'AUTO' as const, value: 0 }, letterSpacing: { unit: 'PX' as const, value: 0 }, paragraphSpacing: 0, textCase: 'ORIGINAL' as const };
  const layout = m.measure(style, null).layout;
  const down = [{ closed: false, points: [{ x: 0, y: 0 }, { x: 0, y: 400 }] }];
  const g = pathTextGlyphs(layout, down, 0.5, 'CENTER', m);
  assert.equal(g.length, 4);
  assert.ok(g.every((x) => Math.abs(x.angle - Math.PI / 2) < 1e-9 && Math.abs(x.x) < 1e-9), 'turned along a vertical line');
  const total = g.reduce((s, x) => s + x.advance, 0);
  assert.ok(Math.abs(g[0]!.y - (200 - total / 2)) < 1e-6, 'centred on the middle of the line');
  assert.equal(pathTextGlyphs(layout, down, 1, 'LEFT', m).length, 0, 'past the end — nothing');
});

test('wrap: filling layers break by their min width, then share the rest of their row (as in Figma)', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', layoutWrap: true, itemSpacing: 10, counterAxisSpacing: 10, width: 330, sizingV: { mode: 'HUG' } });
  const cards = [0, 1, 2].map(() => rect(doc, row, { height: 50, sizingH: { mode: 'FILL' }, minWidth: { unit: 'PX', value: 150 } }));
  relayout(doc, [row]);
  // Two fit in 330 (150 + 10 + 150), the third goes to the next row and takes all of it.
  assert.deepEqual(cards.map((c) => box(doc, c)), [
    { x: 0, y: 0, w: 160, h: 50 },
    { x: 170, y: 0, w: 160, h: 50 },
    { x: 0, y: 60, w: 330, h: 50 },
  ]);
  assert.equal(doc.get(row, 'height'), 110);
});

test('wrap: rows spread over a taller frame when the gap between them is auto', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', layoutWrap: true, counterAxisAlignContent: 'SPACE_BETWEEN', width: 100, height: 200 });
  const a = rect(doc, row, { width: 80, height: 40 });
  const b = rect(doc, row, { width: 80, height: 40 });
  const c = rect(doc, row, { width: 80, height: 40 });
  relayout(doc, [row]);
  assert.deepEqual([a, b, c].map((n) => doc.get(n, 'y')), [0, 80, 160]);
});

test('row aligned by text baseline', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', counterAlign: 'BASELINE', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const big = doc.transact((tx) => tx.create('TEXT', row, { characters: 'Ab', fontSize: 20, textAutoResize: 'WIDTH_AND_HEIGHT' }));
  const small = doc.transact((tx) => tx.create('TEXT', row, { characters: 'Ab', fontSize: 10, textAutoResize: 'WIDTH_AND_HEIGHT' }));
  // A button: a hugging frame whose own text sits 5px below its top.
  const button = frame(doc, row, { layoutMode: 'HORIZONTAL', paddingTop: 5, paddingBottom: 5, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  doc.transact((tx) => tx.create('TEXT', button, { characters: 'OK', fontSize: 10, textAutoResize: 'WIDTH_AND_HEIGHT' }));
  relayout(doc, [row]);
  // Baselines: 18 in the 24px text, 9 in the 12px one, 5 + 9 in the button.
  assert.equal(doc.get(big, 'y'), 0);
  assert.equal(doc.get(small, 'y'), 9);
  assert.equal(doc.get(button, 'y'), 4);
  // The most above a baseline (18) plus the most below it (the button: 22 - 14).
  assert.equal(doc.get(row, 'height'), 26);
});

test('a negative gap makes the layers overlap', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', itemSpacing: -8, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const a = rect(doc, row, { width: 32, height: 32 });
  const b = rect(doc, row, { width: 32, height: 32 });
  relayout(doc, [row]);
  assert.equal(doc.get(b, 'x'), 24);
  assert.equal(doc.get(a, 'x'), 0);
  assert.equal(doc.get(row, 'width'), 56);
});

test('a frame does not hug a layer that fills it (as in Figma)', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
  const a = rect(doc, row, { width: 40, height: 40 });
  relayout(doc, [row]);
  doc.transact((tx) => {
    tx.set(a, 'sizingH', { mode: 'FILL' });
    settleSizing(doc, tx);
  });
  assert.equal(doc.get(row, 'sizingH').mode, 'FIXED');
  assert.equal(doc.get(row, 'sizingV').mode, 'HUG');
  // Across the row filling is fine: the layer stretches to its neighbours (a divider).
  doc.transact((tx) => {
    tx.set(a, 'sizingV', { mode: 'FILL' });
    settleSizing(doc, tx);
  });
  assert.equal(doc.get(row, 'sizingV').mode, 'HUG');
  // And back: hugging again makes the filling layer fixed.
  doc.transact((tx) => {
    tx.set(row, 'sizingH', { mode: 'HUG' });
    settleSizing(doc, tx);
  });
  assert.equal(doc.get(a, 'sizingH').mode, 'FIXED');
});

test('"first on top" reverses the paint order of a row, not of a plain frame', () => {
  const { doc, page } = setup();
  const row = frame(doc, page, { layoutMode: 'HORIZONTAL', itemReverseZIndex: true });
  const a = rect(doc, row);
  const b = rect(doc, row);
  assert.deepEqual(doc.paintChildren(row), [b, a]);
  assert.deepEqual(doc.children(row), [a, b]);
  doc.transact((tx) => tx.set(row, 'layoutMode', 'NONE'));
  assert.deepEqual(doc.paintChildren(row), [a, b]);
});

test('rich text layout: a non-breaking space never breaks a line (FEAT-152, the typograph relies on it)', async () => {
  const { layoutRichText } = await import('../src/rich-text.ts');
  const api = { width: (t: string, f: { fontSize: number }) => [...t].length * f.fontSize * 0.5 };
  const base = { fontFamily: 'X', fontWeight: 400, italic: false, fontSize: 10, letterSpacing: { unit: 'PX' as const, value: 0 }, fills: null, textDecoration: 'NONE' as const, baseline: 'NORMAL' as const };
  const style = (characters: string) => ({ characters, base, runs: [], lineHeight: { unit: 'AUTO' as const }, paragraphSpacing: 0, paragraphIndent: 0, listType: 'NONE' as const, maxLines: 0, textCase: 'ORIGINAL' as const });
  // 5 px a character, 40 px wide: «aaaa в» would fit on the first line, but «в» is bound to «1941».
  const lines = (s: string) => layoutRichText(style(s), 40, api).lines.map((l) => l.fragments.map((f) => f.text).join('').trim());
  assert.deepEqual(lines('aaaa в 1941'), ['aaaa в', '1941']);
  assert.deepEqual(lines('aaaa в 1941'), ['aaaa', 'в 1941']);
});

test('as in CSS: a filling layer is never narrower than its longest word, a text never breaks a word by letters', () => {
  const { doc, page } = setup();
  // A column of four sections turned into a row 300 px wide: 75 px each would break «Корпоративная» (65 px) letter by letter.
  const root = frame(doc, page, { layoutMode: 'VERTICAL', width: 300, sizingV: { mode: 'HUG' }, clipsContent: false });
  const sections: NodeId[] = [];
  const texts: NodeId[] = [];
  for (let i = 0; i < 4; i++) {
    const s = frame(doc, root, { layoutMode: 'VERTICAL', sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, paddingLeft: 10, paddingRight: 10, clipsContent: false });
    sections.push(s);
    texts.push(doc.transact((tx) => tx.create('TEXT', s, { characters: 'Корпоративная АТС', fontSize: 10, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' } })));
  }
  doc.transact((tx) => tx.set(root, 'layoutMode', 'HORIZONTAL'));
  relayout(doc, [root]);
  // Each section: the word (13 × 5 = 65) plus its padding — the row sticks out of its frame, as a CSS flex row does.
  for (const s of sections) assert.equal(doc.get(s, 'width'), 85);
  for (const t of texts) assert.equal(doc.get(t, 'width'), 65);
  assert.equal(doc.get(texts[0]!, 'height'), 24, 'two lines: the word, then «АТС»');

  // A section that clips its content shrinks as CSS overflow: hidden lets it; the word sticks out, unbroken.
  doc.transact((tx) => sections.forEach((s) => tx.set(s, 'clipsContent', true)));
  relayout(doc, [root]);
  assert.equal(doc.get(sections[0]!, 'width'), 75);
  assert.equal(doc.get(texts[0]!, 'height'), 24);

  // A min width of its own wins over the content's, as min-width does.
  doc.transact((tx) => tx.set(sections[0]!, 'minWidth', { unit: 'PX', value: 20 }));
  relayout(doc, [root]);
  assert.ok(doc.get(sections[0]!, 'width') >= 20);
});

test('as in CSS: a grid share (1fr) is never less than its layers take — minmax(auto, 1fr)', () => {
  const { doc, page } = setup();
  const grid = frame(doc, page, { layoutMode: 'GRID', width: 200, sizingV: { mode: 'HUG' }, gridColumns: [{ kind: 'FR', value: 1 }, { kind: 'FR', value: 1 }], gridColumnGap: 0, clipsContent: false });
  const wide = doc.transact((tx) => tx.create('TEXT', grid, { characters: 'Достопримечательности', fontSize: 10, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' } }));
  const narrow = doc.transact((tx) => tx.create('TEXT', grid, { characters: 'да', fontSize: 10, textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' } }));
  relayout(doc, [grid]);
  // 21 letters × 5 = 105 px: the first column holds it, the second takes the rest.
  assert.equal(doc.get(wide, 'width'), 105);
  assert.equal(doc.get(narrow, 'width'), 95);
});
