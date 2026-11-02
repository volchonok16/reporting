import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { constants, deflateRawSync } from 'node:zlib';
import { zip } from '#render';
import { readCanvas, readFig, unzip } from '../src/fig/archive.ts';
import { commandsToPaths, convertFig, networkToPaths, parseFontStyle } from '../src/fig/convert.ts';
import { decodeMessage, decodeSchema } from '../src/fig/kiwi.ts';
import { zstdDecompress } from '../src/fig/zstd.ts';

/** Node 23.8+ has zstd: the reference for our decoder (older Node skips these checks). */
const zstdCompressSync = (zlib as Partial<typeof zlib>).zstdCompressSync;
const noZstd = typeof zstdCompressSync !== 'function' && 'this Node has no zstd to compare with';

test('zstd: the same bytes as the reference decoder, for every kind of data and level', { skip: noZstd }, () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const words = 'фрейм текст auto layout padding заливка gradient {"x":12,"y":40} 0.5 1.0 lorem'.split(' ');
  for (let k = 0; k < 24; k++) {
    const size = k < 3 ? [0, 1, 7][k]! : Math.floor(rnd() * 300_000);
    const data = Buffer.alloc(size);
    const kind = k % 4;
    if (kind === 0) for (let i = 0; i < size; i++) data[i] = Math.floor(rnd() * 256);
    else if (kind === 1) {
      const text = Buffer.from(Array.from({ length: 5000 }, () => words[Math.floor(rnd() * words.length)]).join(' '));
      for (let i = 0; i < size; i++) data[i] = text[i % text.length]!;
    } else if (kind === 2) for (let i = 0; i < size; i++) data[i] = rnd() < 0.9 ? 65 : Math.floor(rnd() * 4);
    else for (let i = 0; i < size; i++) data[i] = (i * 7 + Math.floor(i / 1000)) & 0xff;
    const level = [1, 3, 9, 19, -5][k % 5]!;
    const packed = zstdCompressSync!(data, { params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_checksumFlag]: k % 2 } });
    assert.deepEqual(Buffer.from(zstdDecompress(packed)), data, `case ${k} (kind ${kind}, level ${level}, ${size} bytes)`);
  }
  assert.throws(() => zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5)), /not zstd/);
});

/** A tiny Kiwi writer for the tests: varuints, strings and floats as Figma writes them. */
class Writer {
  bytes: number[] = [];
  uint(v: number): this {
    do {
      let b = v & 127;
      v >>>= 7;
      if (v) b |= 128;
      this.bytes.push(b);
    } while (v);
    return this;
  }
  int(v: number): this {
    return this.uint((v << 1) ^ (v >> 31));
  }
  str(s: string): this {
    this.bytes.push(...new TextEncoder().encode(s), 0);
    return this;
  }
  byte(b: number): this {
    this.bytes.push(b);
    return this;
  }
  float(v: number): this {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    let bits = dv.getUint32(0);
    if (bits === 0) return this.byte(0);
    bits = ((bits >>> 23) | (bits << 9)) >>> 0;
    return this.byte(bits & 255).byte((bits >>> 8) & 255).byte((bits >>> 16) & 255).byte(bits >>> 24);
  }
  get out(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Schema: enum Kind {A=0,B=1}; struct Vec {x float; y float}; message Message {name 1 string; kind 2 Kind; pos 3 Vec; tags 4 string[]; n 5 int; data 6 byte[]}. */
function schemaBytes(): Uint8Array {
  const w = new Writer().uint(3);
  w.str('Kind').byte(0).uint(2).str('A').int(0).byte(0).uint(0).str('B').int(0).byte(0).uint(1);
  w.str('Vec').byte(1).uint(2).str('x').int(-5).byte(0).uint(1).str('y').int(-5).byte(0).uint(2);
  w.str('Message').byte(2).uint(6);
  w.str('name').int(-6).byte(0).uint(1);
  w.str('kind').int(0).byte(0).uint(2);
  w.str('pos').int(1).byte(0).uint(3);
  w.str('tags').int(-6).byte(1).uint(4);
  w.str('n').int(-3).byte(0).uint(5);
  w.str('data').int(-2).byte(1).uint(6);
  return w.out;
}

function messageBytes(): Uint8Array {
  const w = new Writer();
  w.uint(1).str('Фрейм');
  w.uint(2).uint(1);
  w.uint(3).float(1.5).float(0);
  w.uint(4).uint(2).str('a').str('бв');
  w.uint(5).int(-42);
  w.uint(6).uint(3).byte(9).byte(8).byte(7);
  w.uint(0);
  return w.out;
}

test('kiwi: the schema comes with the data; messages, structs, enums, arrays, floats', () => {
  const schema = decodeSchema(schemaBytes());
  assert.deepEqual(schema.definitions.map((d) => [d.name, d.kind]), [['Kind', 'ENUM'], ['Vec', 'STRUCT'], ['Message', 'MESSAGE']]);
  const m = decodeMessage(schema, messageBytes());
  assert.equal(m.name, 'Фрейм');
  assert.equal(m.kind, 'B');
  assert.deepEqual(m.pos, { x: 1.5, y: 0 });
  assert.deepEqual(m.tags, ['a', 'бв']);
  assert.equal(m.n, -42);
  assert.deepEqual([...(m.data as Uint8Array)], [9, 8, 7]);
});

test('archive: canvas.fig with deflate and zstd chunks, inside a ZIP with pictures', { skip: noZstd }, async () => {
  const chunk = (bytes: Uint8Array) => {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length, true);
    return [len, bytes];
  };
  const parts = [new TextEncoder().encode('fig-kiwi'), Uint8Array.of(101, 0, 0, 0), ...chunk(deflateRawSync(schemaBytes())), ...chunk(zstdCompressSync!(messageBytes()))];
  const canvas = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    canvas.set(p, at);
    at += p.length;
  }
  const bare = await readCanvas(canvas);
  assert.equal(bare.version, 101);
  assert.equal(bare.message.name, 'Фрейм');
  const picture = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3);
  const archive = new Uint8Array(await (await zip([{ name: 'canvas.fig', data: canvas }, { name: 'images/ABCDEF', data: picture }, { name: 'meta.json', data: new TextEncoder().encode('{}') }])).arrayBuffer());
  assert.deepEqual([...(await unzip(archive)).keys()].sort(), ['canvas.fig', 'images/ABCDEF', 'meta.json']);
  const fig = await readFig(archive);
  assert.equal(fig.kind, 'design');
  assert.deepEqual([...fig.images.keys()], ['abcdef']);
  await assert.rejects(readFig(new TextEncoder().encode('PK not really a zip')), /ZIP/);
});

test('geometry: path commands and vector networks become contours with handles', () => {
  const dv = new DataView(new ArrayBuffer(200));
  let p = 0;
  const cmd = (c: number, ...xs: number[]) => {
    dv.setUint8(p++, c);
    for (const x of xs) {
      dv.setFloat32(p, x, true);
      p += 4;
    }
  };
  cmd(1, 0, 0);
  cmd(2, 10, 0);
  cmd(4, 10, 5, 5, 10, 0, 10);
  cmd(2, 0, 0);
  cmd(0);
  const paths = commandsToPaths(new Uint8Array(dv.buffer, 0, p));
  assert.equal(paths.length, 1);
  assert.equal(paths[0]!.closed, true);
  assert.deepEqual(paths[0]!.points.map((q) => [q.x, q.y]), [[0, 0], [10, 0], [0, 10]], 'the closing point is the first one');
  assert.deepEqual(paths[0]!.points[1]!.out, { x: 10, y: 5 });
  assert.deepEqual(paths[0]!.points[2]!.in, { x: 5, y: 10 });

  // Network: a triangle region and a loose line, in a 2× normalized space.
  const u = (v: number[]) => v;
  const words: [string, number][] = [];
  const push = (type: 'u' | 'f', ...v: number[]) => v.forEach((x) => words.push([type, x]));
  push('u', 4, 4, 1);
  for (const [x, y] of [u([0, 0]), u([20, 0]), u([0, 20]), u([40, 40])]) {
    push('u', 0);
    push('f', x!, y!);
  }
  const seg = (a: number, b: number, tbx = 0) => {
    push('u', 0, a);
    push('f', 0, 0);
    push('u', b);
    push('f', tbx, 0);
  };
  seg(0, 1);
  seg(1, 2);
  seg(2, 0);
  seg(2, 3, -4);
  push('u', 1, 1, 3, 0, 1, 2);
  const buf = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach(([t, v], i) => (t === 'u' ? buf.setUint32(i * 4, v, true) : buf.setFloat32(i * 4, v, true)));
  const net = networkToPaths(new Uint8Array(buf.buffer), 0.5, 0.5);
  assert.equal(net.evenOdd, false);
  assert.equal(net.paths.length, 2);
  assert.equal(net.paths[0]!.closed, true);
  assert.deepEqual(net.paths[0]!.points.map((q) => [q.x, q.y]), [[0, 0], [10, 0], [0, 10]]);
  assert.equal(net.paths[1]!.closed, false);
  assert.deepEqual(net.paths[1]!.points[1], { x: 20, y: 20, in: { x: 18, y: 20 } });
});

test('font styles: weight and italic from the style name', () => {
  assert.deepEqual(parseFontStyle('Regular'), { weight: 400, italic: false });
  assert.deepEqual(parseFontStyle('Semi Bold Italic'), { weight: 600, italic: true });
  assert.deepEqual(parseFontStyle('ExtraLight'), { weight: 200, italic: false });
  assert.deepEqual(parseFontStyle('Black'), { weight: 900, italic: false });
  assert.deepEqual(parseFontStyle('Bold'), { weight: 700, italic: false });
});

test('convert: pages, frames with auto layout, groups, shapes, texts with mixed styles, pictures, instances', () => {
  const g = (l: number) => ({ sessionID: 1, localID: l });
  const at = (parent: number, position: string) => ({ guid: g(parent), position });
  const tf = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const solid = (r: number, a = 1) => ({ type: 'SOLID', color: { r, g: 0, b: 0, a }, opacity: 1, visible: true, blendMode: 'NORMAL' });
  const hash = Uint8Array.of(0xab, 0xcd);
  const nodeChanges = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), parentIndex: at(0, '!'), type: 'CANVAS', name: 'Экраны', backgroundColor: { r: 1, g: 1, b: 1, a: 1 } },
    { guid: g(99), parentIndex: at(0, '"'), type: 'CANVAS', name: 'Internal', internalOnly: true },
    {
      guid: g(2), parentIndex: at(1, '!'), type: 'FRAME', name: 'Карточка', size: { x: 200, y: 100 }, transform: tf(10, 20),
      fillPaints: [solid(1, 0.5)], stackMode: 'VERTICAL', stackSpacing: 8, stackHorizontalPadding: 16, stackPaddingRight: 16, stackVerticalPadding: 12, stackPaddingBottom: 12,
      stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackCounterAlignItems: 'CENTER', cornerRadius: 8, frameMaskDisabled: true,
      effects: [{ type: 'DROP_SHADOW', offset: { x: 0, y: 4 }, radius: 10, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.2 }, visible: true }],
    },
    // Higher position: on top, so after the text below.
    {
      guid: g(3), parentIndex: at(2, '#'), type: 'ROUNDED_RECTANGLE', name: 'Фото', size: { x: 168, y: 40 }, transform: tf(16, 50), stackChildAlignSelf: 'STRETCH',
      fillPaints: [{ type: 'IMAGE', image: { hash }, imageScaleMode: 'FILL', opacity: 1, visible: true }],
      rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 4, rectangleTopRightCornerRadius: 4, rectangleBottomRightCornerRadius: 0, rectangleBottomLeftCornerRadius: 0,
    },
    {
      guid: g(4), parentIndex: at(2, '!'), type: 'TEXT', name: 'Заголовок', size: { x: 168, y: 20 }, transform: tf(16, 12), fillPaints: [solid(0)],
      fontName: { family: 'Inter', style: 'Medium' }, fontSize: 16, lineHeight: { value: 100, units: 'PERCENT' }, letterSpacing: { value: 2, units: 'PERCENT' }, textAutoResize: 'HEIGHT',
      textData: { characters: 'Привет, мир', characterStyleIDs: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold Italic' }, fillPaints: [solid(1)] }] },
    },
    { guid: g(5), parentIndex: at(1, '"'), type: 'FRAME', name: 'Группа', resizeToFit: true, size: { x: 30, y: 30 }, transform: tf(300, 0) },
    { guid: g(6), parentIndex: at(5, '!'), type: 'ELLIPSE', name: 'Круг', size: { x: 30, y: 30 }, transform: tf(0, 0), fillPaints: [solid(0.5)], strokePaints: [solid(0)], strokeWeight: 2, strokeAlign: 'INSIDE' },
    { guid: g(7), parentIndex: at(1, '#'), type: 'SYMBOL', name: 'Кнопка', size: { x: 80, y: 32 }, transform: tf(0, 200) },
    { guid: g(8), parentIndex: at(7, '!'), type: 'RECTANGLE', name: 'Фон', size: { x: 80, y: 32 }, transform: tf(0, 0), fillPaints: [solid(0.2)] },
    { guid: g(9), parentIndex: at(1, '$'), type: 'INSTANCE', name: 'Кнопка', size: { x: 80, y: 32 }, transform: tf(100, 200), symbolData: { symbolID: g(7) } },
    { guid: g(10), parentIndex: at(1, '%'), type: 'STICKY', name: 'Стикер' },
    { guid: g(11), parentIndex: at(1, '&'), type: 'RECTANGLE', name: 'Удалён', phase: 'REMOVED' },
  ];
  const r = convertFig({ message: { nodeChanges, blobs: [] }, images: new Map([['abcd', Uint8Array.of(0x89, 0x50, 1)]]), kind: 'design', version: 100 }, 'Импорт');
  const doc = r.doc;
  const pages = doc.pages();
  assert.deepEqual(pages.map((p) => doc.get(p, 'name')), ['Экраны'], 'internal pages are left out');
  const top = doc.children(pages[0]!);
  assert.deepEqual(top.map((id) => [doc.type(id), doc.get(id, 'name')]), [['FRAME', 'Карточка'], ['GROUP', 'Группа'], ['COMPONENT', 'Кнопка'], ['INSTANCE', 'Кнопка']]);
  const card = top[0]!;
  assert.equal(doc.get(card, 'x'), 10);
  assert.equal(doc.get(card, 'layoutMode'), 'VERTICAL');
  assert.equal(doc.get(card, 'itemSpacing'), 8);
  assert.deepEqual([doc.get(card, 'paddingTop'), doc.get(card, 'paddingRight'), doc.get(card, 'paddingBottom'), doc.get(card, 'paddingLeft')], [12, 16, 12, 16]);
  assert.deepEqual(doc.get(card, 'sizingV'), { mode: 'HUG' });
  assert.equal(doc.get(card, 'counterAlign'), 'CENTER');
  assert.equal(doc.get(card, 'clipsContent'), false);
  assert.deepEqual(doc.get(card, 'fills')[0], { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5, visible: true });
  assert.equal(doc.get(card, 'effects')[0]!.type, 'DROP_SHADOW');
  assert.deepEqual(doc.get(card, 'strokes'), [], 'no stroke of our defaults sneaks in');
  const [text, photo] = doc.children(card);
  assert.equal(doc.type(text!), 'TEXT', 'siblings in position order');
  assert.equal(doc.get(text!, 'fontWeight'), 500);
  assert.deepEqual(doc.get(text!, 'lineHeight'), { unit: 'AUTO' });
  assert.deepEqual(doc.get(text!, 'letterSpacing'), { unit: 'PERCENT', value: 2 });
  assert.deepEqual(doc.get(text!, 'textRuns'), [{ start: 8, end: 11, style: { fontWeight: 700, italic: true, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] } }]);
  assert.deepEqual(doc.get(photo!, 'sizingH'), { mode: 'FILL' }, 'stretch across a vertical stack');
  assert.deepEqual(doc.get(photo!, 'cornerRadii'), [4, 4, 0, 0]);
  const fill = doc.get(photo!, 'fills')[0]!;
  assert.equal(fill.type, 'IMAGE');
  assert.equal(r.missingImages, 0);
  const circle = doc.children(top[1]!)[0]!;
  assert.equal(doc.get(circle, 'strokeAlign'), 'INSIDE');
  assert.equal(doc.children(top[3]!).length, 1, 'an instance shows its component\'s layers');
  assert.equal(doc.get(top[3]!, 'mainComponent'), top[2]);
  assert.deepEqual([...r.skipped], [['STICKY', 1]]);
  assert.deepEqual([...r.fonts], ['Inter']);
});

test('convert: a FigJam shape with text becomes a group of the shape and an editable text', () => {
  const g = (l: number) => ({ sessionID: 1, localID: l });
  const part = (localID: number) => ({ guidPath: { guids: [{ sessionID: 40000000, localID }] } });
  const nodeChanges = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Доска' },
    {
      guid: g(2), parentIndex: { guid: g(1), position: '!' }, type: 'SHAPE_WITH_TEXT', name: '2Q 2026', shapeWithTextType: 'SQUARE',
      size: { x: 200, y: 100 }, transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 60 },
      nodeGenerationData: {
        overrides: [
          { ...part(0), cornerRadius: 6, fillPaints: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1, visible: true }], strokePaints: [] },
          { ...part(1), fontName: { family: 'Inter', style: 'Bold' }, fontSize: 48, textAlignHorizontal: 'CENTER', textData: { characters: '2Q 2026' }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] },
        ],
      },
      derivedImmutableFrameData: {
        overrides: [
          { ...part(0), size: { x: 200, y: 100 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } },
          { ...part(1), size: { x: 168, y: 72 }, transform: { m00: 1, m01: 0, m02: 16, m10: 0, m11: 1, m12: 14 } },
        ],
      },
    },
  ];
  const { doc, skipped } = convertFig({ message: { nodeChanges }, images: new Map(), kind: 'design', version: 100 }, 'Доска');
  const [group] = doc.children(doc.pages()[0]!);
  assert.equal(doc.type(group!), 'GROUP');
  assert.equal(doc.get(group!, 'x'), 50);
  const [shape, text] = doc.children(group!);
  assert.equal(doc.type(shape!), 'RECTANGLE');
  assert.equal(doc.get(shape!, 'cornerRadius'), 6);
  assert.equal(doc.type(text!), 'TEXT');
  assert.equal(doc.get(text!, 'characters'), '2Q 2026');
  assert.equal(doc.get(text!, 'textAlignH'), 'CENTER');
  assert.equal(doc.get(text!, 'x'), 16);
  assert.equal(skipped.size, 0);
});

test('convert: components, variants, instances with overrides and properties, library layers by override key, styles', () => {
  const g = (s: number, l: number) => ({ sessionID: s, localID: l });
  const at = (parent: { sessionID: number; localID: number }, position: string) => ({ guid: parent, position });
  const tf = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const solid = (r: number) => ({ type: 'SOLID', color: { r, g: r, b: r, a: 1 }, opacity: 1, visible: true });
  const page = g(0, 1);
  const hidden = g(0, 2);
  const nodeChanges = [
    { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
    { guid: page, parentIndex: at(g(0, 0), '!'), type: 'CANVAS', name: 'Экраны' },
    { guid: hidden, parentIndex: at(g(0, 0), '"'), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true },
    // A colour style, kept by Figma as a hidden layer.
    { guid: g(1, 1), parentIndex: at(hidden, '!'), type: 'RECTANGLE', name: 'Brand/Blue', styleType: 'FILL', fillPaints: [solid(0.2)], size: { x: 10, y: 10 }, transform: tf(0, 0) },
    // A set of variants with a text property, copied from a library (its layers keep their library guids as override keys).
    {
      guid: g(2, 1), parentIndex: at(hidden, '"'), type: 'FRAME', name: 'Button', isStateGroup: true, size: { x: 200, y: 50 }, transform: tf(0, 100),
      componentPropDefs: [{ id: g(9, 1), name: 'Label', type: 'TEXT', initialValue: { textValue: { characters: 'OK' } } }, { id: g(9, 2), name: 'Icon', type: 'BOOL' }],
    },
    { guid: g(2, 2), parentIndex: at(g(2, 1), '!'), type: 'SYMBOL', name: 'Size=M', size: { x: 80, y: 32 }, transform: tf(0, 0), fillPaints: [solid(0.2)], inheritFillStyleID: g(1, 1) },
    {
      guid: g(2, 3), parentIndex: at(g(2, 2), '!'), type: 'TEXT', name: 'Label', overrideKey: g(77, 5), size: { x: 60, y: 20 }, transform: tf(10, 6), fillPaints: [solid(1)],
      fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14, textData: { characters: 'OK' }, componentPropRefs: [{ defID: g(9, 1), componentPropNodeField: 'TEXT_DATA' }],
    },
    { guid: g(2, 4), parentIndex: at(g(2, 2), '"'), type: 'ELLIPSE', name: 'Icon', size: { x: 8, y: 8 }, transform: tf(2, 2), fillPaints: [solid(0)], componentPropRefs: [{ defID: g(9, 2), componentPropNodeField: 'VISIBLE' }] },
    { guid: g(2, 5), parentIndex: at(g(2, 1), '"'), type: 'SYMBOL', name: 'Size=L', size: { x: 120, y: 40 }, transform: tf(100, 0), fillPaints: [solid(0.2)] },
    // On the page: a card component holding a button instance whose text is overridden through the library key…
    { guid: g(3, 1), parentIndex: at(page, '!'), type: 'SYMBOL', name: 'Card', size: { x: 300, y: 100 }, transform: tf(0, 0), fillPaints: [solid(1)] },
    {
      guid: g(3, 2), parentIndex: at(g(3, 1), '!'), type: 'INSTANCE', name: 'Button', size: { x: 80, y: 32 }, transform: tf(20, 20),
      symbolData: { symbolID: g(2, 2), symbolOverrides: [{ guidPath: { guids: [g(77, 5)] }, textData: { characters: 'Купить' } }] },
    },
    // …and an instance of the card that hides the button's icon through a property and recolours the card.
    {
      guid: g(3, 3), parentIndex: at(page, '"'), type: 'INSTANCE', name: 'Card', size: { x: 300, y: 100 }, transform: tf(0, 200), fillPaints: [solid(0.5)],
      symbolData: { symbolID: g(3, 1), symbolOverrides: [{ guidPath: { guids: [g(3, 2)] }, componentPropAssignments: [{ defID: g(9, 2), value: { boolValue: false } }] }] },
    },
    // An instance whose component is in no file we have: an empty frame.
    { guid: g(3, 4), parentIndex: at(page, '#'), type: 'INSTANCE', name: 'Ghost', size: { x: 40, y: 40 }, transform: tf(0, 400), symbolData: { symbolID: g(55, 55) } },
  ];
  const r = convertFig({ message: { nodeChanges }, images: new Map(), kind: 'design', version: 100 }, 'Компоненты');
  const doc = r.doc;
  assert.equal(r.components, 3);
  assert.equal(r.instances, 2);
  assert.equal(r.unlinked, 1);
  assert.equal(r.styles, 1);
  const style = doc.styles()[0]!;
  assert.equal(doc.get(style, 'name'), 'Brand/Blue');
  const lib = doc.libraryPage()!;
  const set = doc.children(lib)[0]!;
  assert.equal(doc.type(set), 'COMPONENT_SET');
  assert.deepEqual(doc.get(set, 'componentProps').map((p) => [p.name, p.type]), [['Label', 'TEXT'], ['Icon', 'BOOLEAN']]);
  const [m, l] = doc.children(set);
  assert.deepEqual([doc.type(m!), doc.get(m!, 'name'), doc.type(l!)], ['COMPONENT', 'Size=M', 'COMPONENT']);
  assert.equal(doc.get(m!, 'fillStyleId'), style, 'layers keep their styles');
  const [label] = doc.children(m!);
  assert.deepEqual(doc.get(label!, 'propRefs'), { characters: '9:1' });

  const [card, cardInstance, ghost] = doc.children(doc.pages()[0]!);
  assert.equal(doc.type(card!), 'COMPONENT');
  const button = doc.children(card!)[0]!;
  assert.equal(doc.type(button), 'INSTANCE');
  assert.equal(doc.get(button, 'mainComponent'), m);
  const buttonLabel = doc.children(button).find((x) => doc.type(x) === 'TEXT')!;
  assert.equal(doc.get(buttonLabel, 'characters'), 'Купить', 'the override found its layer by the library key');
  assert.ok(doc.get(buttonLabel, 'overrides').includes('characters'), 'and it stays an override');

  assert.equal(doc.type(cardInstance!), 'INSTANCE');
  assert.equal(doc.get(cardInstance!, 'mainComponent'), card);
  assert.equal(doc.get(cardInstance!, 'fills')[0]!.opacity, 1);
  assert.equal((doc.get(cardInstance!, 'fills')[0] as { color: { r: number } }).color.r, 0.5, 'own look of the instance');
  assert.ok(doc.get(cardInstance!, 'overrides').includes('fills'));
  const innerButton = doc.children(cardInstance!)[0]!;
  assert.equal(doc.get(doc.children(innerButton).find((x) => doc.type(x) === 'TEXT')!, 'characters'), 'Купить', 'the card\'s own override reaches its instance');
  assert.deepEqual(doc.get(innerButton, 'propValues'), { '9:2': false });
  assert.equal(doc.get(doc.children(innerButton).find((x) => doc.type(x) === 'ELLIPSE')!, 'visible'), false, 'a property hides the icon');

  assert.equal(doc.type(ghost!), 'FRAME');
  assert.equal(doc.get(ghost!, 'width'), 40);
});

test('convert: a Figma grid becomes our grid — tracks by their order, layers in their cells', () => {
  const g = (l: number) => ({ sessionID: 5, localID: l });
  const tf = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const size = (type: string, value = 1) => ({ minSizing: { type, value }, maxSizing: { type, value } });
  const nodeChanges = [
    { guid: g(0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1), parentIndex: { guid: g(0), position: '!' }, type: 'CANVAS', name: 'Стр' },
    {
      guid: g(2), parentIndex: { guid: g(1), position: '!' }, type: 'FRAME', name: 'Сетка', size: { x: 300, y: 100 }, transform: tf(0, 0), stackMode: 'GRID',
      stackPrimarySizing: 'FIXED', stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', gridColumnGap: 12, gridRowGap: 8,
      // Listed out of order: the position strings decide.
      gridColumns: { entries: [{ id: g(11), position: '"' }, { id: g(10), position: '!' }] },
      gridColumnsSizing: { entries: [{ id: g(10), trackSize: size('FIXED', 22) }, { id: g(11), trackSize: size('FLEX', 2) }] },
      gridRows: { entries: [{ id: g(20), position: '!' }] },
      gridRowsSizing: { entries: [{ id: g(20), trackSize: size('HUG') }] },
    },
    { guid: g(3), parentIndex: { guid: g(2), position: '!' }, type: 'RECTANGLE', name: 'Иконка', size: { x: 18, y: 18 }, transform: tf(0, 2), gridColumnAnchor: g(10), gridRowAnchor: g(20), gridChildVerticalAlign: 'CENTER' },
    { guid: g(4), parentIndex: { guid: g(2), position: '"' }, type: 'RECTANGLE', name: 'Текст', size: { x: 200, y: 22 }, transform: tf(34, 0), gridColumnAnchor: g(11), gridRowAnchor: g(20), stackChildPrimaryGrow: 1 },
  ];
  const { doc } = convertFig({ message: { nodeChanges }, images: new Map(), kind: 'design', version: 100 }, 'Сетка');
  const [grid] = doc.children(doc.pages()[0]!);
  assert.equal(doc.get(grid!, 'layoutMode'), 'GRID');
  assert.deepEqual(doc.get(grid!, 'gridColumns'), [{ kind: 'FIXED', value: 22 }, { kind: 'FR', value: 2 }]);
  assert.deepEqual(doc.get(grid!, 'gridRows'), [{ kind: 'HUG' }]);
  assert.deepEqual([doc.get(grid!, 'gridColumnGap'), doc.get(grid!, 'gridRowGap')], [12, 8]);
  assert.deepEqual(doc.get(grid!, 'sizingV'), { mode: 'HUG' });
  const [icon, text] = doc.children(grid!);
  assert.deepEqual([doc.get(icon!, 'gridColumn'), doc.get(icon!, 'gridRow'), doc.get(icon!, 'gridAlignV')], [0, 0, 'CENTER']);
  assert.deepEqual([doc.get(text!, 'gridColumn'), doc.get(text!, 'gridRow')], [1, 0]);
  assert.deepEqual(doc.get(text!, 'sizingH'), { mode: 'FILL' });
});

test('a FigJam board comes over as a board: stickies, shapes with text and connectors between them (smoke test, not a real file)', async () => {
  const { refreshBoard } = await import('#components');
  const { ApproximateTextMeasurer } = await import('#layout');
  const g = (localID: number) => ({ sessionID: 1, localID });
  const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const nodes = [
    { guid: g(0), type: 'DOCUMENT', name: 'Доска' },
    { guid: g(1), type: 'CANVAS', name: 'Page 1', parentIndex: { guid: g(0), position: 'a' } },
    { guid: g(2), type: 'STICKY', parentIndex: { guid: g(1), position: 'a' }, transform: at(0, 0), size: { x: 240, y: 240 }, fillPaints: [{ type: 'SOLID', color: { r: 0.71, g: 0.92, b: 0.69, a: 1 } }], textData: { characters: 'Идея' }, authorName: 'Аня' },
    {
      guid: g(3), type: 'SHAPE_WITH_TEXT', shapeWithTextType: 'DIAMOND', parentIndex: { guid: g(1), position: 'b' }, transform: at(400, 0), size: { x: 160, y: 160 },
      nodeGenerationData: { overrides: [{ guidPath: { guids: [{ localID: 0 }] }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0.95, b: 0.72, a: 1 } }] }, { guidPath: { guids: [{ localID: 1 }] }, textData: { characters: 'Да?' }, fontSize: 18 }] },
    },
    { guid: g(4), type: 'CONNECTOR', parentIndex: { guid: g(1), position: 'c' }, transform: at(240, 120), size: { x: 160, y: 0 }, connectorLineStyle: 'STRAIGHT', connectorStart: { endpointNodeID: g(2), magnet: 'RIGHT' }, connectorEnd: { endpointNodeID: g(3), magnet: 'LEFT' }, textData: { characters: 'потом' } },
  ];
  const result = convertFig({ message: { nodeChanges: nodes }, kind: 'figjam', version: 1 } as never, 'Доска', true);
  const doc = result.doc;
  doc.transact((tx) => refreshBoard(doc, tx, new ApproximateTextMeasurer()), { undoable: false });
  assert.equal(doc.get(doc.rootId, 'fileKind'), 'BOARD');
  assert.deepEqual(result.board, { stickies: 1, shapes: 1, connectors: 1 });
  const page = doc.pages()[0]!;
  const [sticky, shape, connector] = doc.children(page);
  assert.deepEqual(doc.get(sticky!, 'board'), { kind: 'STICKY', author: 'Аня' });
  assert.equal(doc.get(shape!, 'board')?.kind === 'SHAPE' && (doc.get(shape!, 'board') as { shape: string }).shape, 'DIAMOND');
  const role = doc.get(connector!, 'board') as { start: { node: string; x: number }; end: { node: string; x: number } };
  assert.equal(role.start.node, sticky);
  assert.equal(role.end.node, shape);
  assert.equal(role.start.x, 240, 'from the sticky’s right side');
  assert.equal(role.end.x, 400, 'to the diamond’s left side');
  const label = [...doc.children(page)].find((id) => doc.get(id, 'board')?.kind === 'CONNECTOR_LABEL');
  assert.ok(label, 'the connector’s text is its label');
});
