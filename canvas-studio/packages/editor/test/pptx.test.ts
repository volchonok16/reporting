import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, rgba, solid, type NodeId } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import { zip } from '#render';
import { Editor } from '../src/editor.ts';
import { collectSlides, slideTargets, type CollectEnv } from '../src/pptx/collect.ts';
import { buildPptx, type TableCell } from '../src/pptx/writer.ts';
import { lookAlike, useOfficeFonts, type FaceSource } from '../src/pptx/fonts.ts';

function setup() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  return { doc, editor, page: editor.pageId };
}

/** The browser parts replaced: a 1×1 "PNG" for every rendered layer. */
function env(editor: Editor, rendered: NodeId[] = []): CollectEnv {
  const scene = editor.scene;
  return {
    raster: async (id) => {
      rendered.push(id);
      return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), bounds: scene.renderBounds(id) };
    },
    svg: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
    image: async () => null,
    world: (id) => scene.world(id),
    bounds: (id) => scene.bounds(id),
  };
}

const xmlOf = (files: { name: string; data: Uint8Array }[], name: string) => new TextDecoder().decode(files.find((f) => f.name === name)!.data);

test('pptx: frames become slides in reading order; text, shapes and gradients stay editable, vectors become pictures', async () => {
  const { editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const second = tx.create('FRAME', page, { name: 'Второй', x: 1000, y: 0, width: 960, height: 540 });
    const first = tx.create('FRAME', page, { name: 'Первый', x: 0, y: 10, width: 960, height: 540, fills: [solid(rgba(0.1, 0.2, 0.3))] });
    const card = tx.create('RECTANGLE', first, {
      name: 'Карточка',
      x: 40,
      y: 40,
      width: 200,
      height: 100,
      cornerRadius: 12,
      fills: [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: rgba(1, 0, 0) }, { position: 1, color: rgba(0, 0, 1) }], from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, opacity: 1, visible: true }],
      strokes: [solid(rgba(0, 0, 0))],
      strokeWeight: 2,
      strokeAlign: 'CENTER',
      effects: [{ type: 'DROP_SHADOW', color: rgba(0, 0, 0, 0.25), offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true }],
    });
    const title = tx.create('TEXT', first, {
      name: 'Заголовок',
      x: 40,
      y: 200,
      characters: 'Привет, мир\nВторая строка',
      fontFamily: 'Inter',
      fontWeight: 700,
      fontSize: 32,
      textRuns: [{ start: 8, end: 11, style: { italic: true, fills: [solid(rgba(1, 0, 0))] } }],
    });
    const star = tx.create('STAR', first, { name: 'Звезда', x: 600, y: 40, width: 50, height: 50 });
    const hidden = tx.create('RECTANGLE', first, { name: 'Скрытый', visible: false });
    return { first, second, card, title, star, hidden };
  });

  const targets = slideTargets(editor.doc, page, [], (id) => editor.scene.bounds(id));
  assert.deepEqual(targets, { ids: [ids.first, ids.second], scope: 'page' }, 'rows top to bottom, left to right; nothing selected — the whole page');
  assert.deepEqual(slideTargets(editor.doc, page, [ids.second], (id) => editor.scene.bounds(id)).ids, [ids.second]);

  const rendered: NodeId[] = [];
  const res = await collectSlides(editor.doc, targets.ids, env(editor, rendered), { mode: 'editable', scale: 2, svg: true, groups: false });
  assert.equal(res.slides.length, 2);
  const [s1] = res.slides;
  assert.equal(s1!.bg, '1A334D', 'a solid frame fill becomes the slide background');
  assert.deepEqual(rendered, [ids.star], 'only the star is rendered as a picture');
  assert.equal(res.rasterized, 1);
  assert.deepEqual(res.fonts, ['Inter']);
  const text = s1!.els.find((e) => e.k === 'text');
  assert.ok(text && text.k === 'text');
  assert.equal(text.paras.length, 2);
  assert.deepEqual(text.paras[0]!.runs.map((r) => [r.text, r.i, r.color]), [['Привет, ', false, '000000'], ['мир', true, 'FF0000']]);
  assert.equal(text.paras[0]!.runs[0]!.w, 700);

  const files = buildPptx(res.slides, res.images, { title: 'Тест' });
  assert.equal(files[0]!.name, '[Content_Types].xml');
  const slide1 = xmlOf(files, 'ppt/slides/slide1.xml');
  assert.match(slide1, /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1A334D"\/>/);
  assert.match(slide1, /<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000">/, 'the gradient stays a gradient');
  assert.match(slide1, /prst="roundRect"/);
  assert.match(slide1, /<a:outerShdw /);
  assert.match(slide1, /<a:t>Привет, <\/a:t>.*<a:rPr lang="ru-RU" sz="\d+" b="1" i="1"/s, 'mixed styles keep their own runs');
  assert.match(slide1, /svgBlip/, 'the star has an SVG copy');
  assert.doesNotMatch(slide1, /Скрытый/, 'hidden layers are skipped');
  assert.match(xmlOf(files, 'ppt/presentation.xml'), /<p:sldSz cx="12192000" cy="6858000"\/>/, '16:9 frame → standard 16:9 slide');
  assert.ok(files.some((f) => f.name === 'ppt/media/image1.png') && files.some((f) => f.name === 'ppt/media/image2.svg'));
  // Every slide part is referenced by the presentation and listed in the content types.
  assert.match(xmlOf(files, '[Content_Types].xml'), /\/ppt\/slides\/slide2\.xml/);
  assert.match(xmlOf(files, 'ppt/_rels/presentation.xml.rels'), /Target="slides\/slide2\.xml"/);

  const blob = await zip(files);
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04], 'a ZIP package');
});

test('pptx: "images" mode gives one picture per slide; content outside a clipping frame is cut', async () => {
  const { editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Слайд', width: 400, height: 300 });
    const pic = tx.create('RECTANGLE', frame, { name: 'Выходит за край', x: 300, y: 0, width: 200, height: 100 });
    const away = tx.create('RECTANGLE', frame, { name: 'Совсем снаружи', x: 500, y: 0, width: 50, height: 50 });
    return { frame, pic, away };
  });
  const image = await collectSlides(editor.doc, [ids.frame], env(editor), { mode: 'image', scale: 2, svg: true, groups: true });
  assert.equal(image.slides[0]!.els.length, 1);
  assert.equal(image.slides[0]!.els[0]!.k, 'pic');

  const editable = await collectSlides(editor.doc, [ids.frame], env(editor), { mode: 'editable', scale: 2, svg: true, groups: true });
  const xml = xmlOf(buildPptx(editable.slides, editable.images), 'ppt/slides/slide1.xml');
  assert.doesNotMatch(xml, /Совсем снаружи/);
  // 400×300 → 12192000 wide: 1 px = 30480 EMU; the clipped rectangle is 100 px wide.
  assert.match(xml, /name="Выходит за край"\/>.*?<a:off x="9144000" y="0"\/><a:ext cx="3048000" cy="3048000"\/>/s);
});

/** A font file with just the names and the weight: name IDs 1 and 2 (Windows, English), OS/2 usWeightClass. */
function fakeFont(family: string, style: string, weight: number): Uint8Array {
  const strings = [family, style];
  const utf16 = strings.map((t) => {
    const b = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) new DataView(b.buffer).setUint16(i * 2, t.charCodeAt(i));
    return b;
  });
  const nameLen = 6 + 12 * strings.length + utf16.reduce((n, b) => n + b.length, 0);
  const name = new Uint8Array(nameLen);
  const nv = new DataView(name.buffer);
  nv.setUint16(2, strings.length);
  nv.setUint16(4, 6 + 12 * strings.length);
  let at = 0;
  utf16.forEach((b, i) => {
    const r = 6 + i * 12;
    nv.setUint16(r, 3);
    nv.setUint16(r + 2, 1);
    nv.setUint16(r + 4, 0x409);
    nv.setUint16(r + 6, i + 1);
    nv.setUint16(r + 8, b.length);
    nv.setUint16(r + 10, at);
    name.set(b, 6 + 12 * strings.length + at);
    at += b.length;
  });
  const os2 = new Uint8Array(64);
  new DataView(os2.buffer).setUint16(4, weight);
  const tables: [string, Uint8Array][] = [['OS/2', os2], ['name', name]];
  const out = new Uint8Array(12 + 16 * tables.length + os2.length + ((name.length + 3) & ~3));
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x54, 0x54, 0x4f]);
  v.setUint16(4, tables.length);
  let offset = 12 + 16 * tables.length;
  tables.forEach(([tag, data], i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) v.setUint8(r + k, tag.charCodeAt(k));
    v.setUint32(r + 8, offset);
    v.setUint32(r + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

test('pptx: fonts go by the names PowerPoint knows — a weight past Bold is a family of its own; a missing family is named with a look-alike', async () => {
  const { editor, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const frame = tx.create('FRAME', page, { name: 'Слайд', width: 960, height: 540 });
    const text = (characters: string, fontFamily: string, fontWeight: number, y: number) => tx.create('TEXT', frame, { name: characters, x: 0, y, characters, fontFamily, fontWeight, fontSize: 20 });
    text('Заголовок', 'Halvar Breit t2', 800, 0);
    text('Обычный', 'T2 Rooftop', 400, 40);
    text('Средний', 'T2 Rooftop', 500, 80);
    text('Полужирный', 'T2 Rooftop', 600, 120);
    text('Опечатка', 'T2 Halvar', 800, 160);
    return frame;
  });
  const face = (family: string, weight: number, ...names: [string, string]): FaceSource => ({ family, weight, italic: false, bytes: async () => fakeFont(...names, weight) });
  const sources = [
    face('Halvar Breit t2', 800, 'Halvar Breitschrift t2 XBd', 'Regular'),
    face('T2 Rooftop', 400, 'T2 Rooftop', 'Regular'),
    face('T2 Rooftop', 500, 'T2 Rooftop Medium', 'Regular'),
  ];
  const collected = await collectSlides(editor.doc, [frame], env(editor), { mode: 'editable', scale: 2, svg: true, groups: true });
  const fonts = await useOfficeFonts(collected.slides, sources);
  assert.deepEqual(fonts.missing, [{ family: 'T2 Halvar', like: 'Halvar Breit t2' }]);
  assert.deepEqual(fonts.fonts, ['Halvar Breitschrift t2 XBd', 'T2 Halvar', 'T2 Rooftop', 'T2 Rooftop Medium']);
  const xml = xmlOf(buildPptx(collected.slides, collected.images), 'ppt/slides/slide1.xml');
  const runOf = (text: string) => xml.match(new RegExp(`<a:r><a:rPr([^>]*)>(?:(?!</a:rPr>).)*?typeface="([^"]+)"(?:(?!<a:r>).)*?<a:t>${text}</a:t>`, 's'));
  const bold = (text: string) => / b="1"/.test(runOf(text)![1]!);
  // ExtraBold is the Regular of its own family: not made bolder still.
  assert.equal(runOf('Заголовок')![2], 'Halvar Breitschrift t2 XBd');
  assert.equal(bold('Заголовок'), false);
  assert.equal(runOf('Обычный')![2], 'T2 Rooftop');
  assert.equal(runOf('Средний')![2], 'T2 Rooftop Medium');
  assert.equal(bold('Средний'), false);
  // 600 with no heavier face: Medium made bold, as the browser draws it.
  assert.equal(runOf('Полужирный')![2], 'T2 Rooftop Medium');
  assert.equal(bold('Полужирный'), true);
  // Found nowhere: stays as it was.
  assert.equal(runOf('Опечатка')![2], 'T2 Halvar');
  assert.equal(bold('Опечатка'), true);

  assert.equal(lookAlike('Inter', ['Inter Display', 'Inter']), 'Inter');
  assert.equal(lookAlike('Golos', ['T2 Rooftop']), null);
});

test('pptx import (FEAT-158): our own export read back — slides, background, texts with their runs, shapes, notes; built into a presentation in one step', async () => {
  const { readPptx } = await import('../src/pptx/import.ts');
  const { buildDeck } = await import('../src/pptx/import-build.ts');
  const { createSlidesDocument, slideIds, arrangeSlides } = await import('../src/slides.ts');
  const { editor, page } = setup();
  const ids = editor.commit('setup', (tx) => {
    const first = tx.create('FRAME', page, { name: 'Первый', x: 0, y: 0, width: 960, height: 540, fills: [solid(rgba(0.1, 0.2, 0.3))] });
    tx.create('RECTANGLE', first, { name: 'Плашка', x: 40, y: 40, width: 200, height: 100, cornerRadius: 12, fills: [solid(rgba(1, 0, 0))] });
    tx.create('TEXT', first, { name: 'Заголовок', x: 40, y: 200, width: 500, characters: 'Привет, мир', fontFamily: 'Inter', fontWeight: 700, fontSize: 32, textAutoResize: 'HEIGHT', textRuns: [{ start: 8, end: 11, style: { italic: true, fills: [solid(rgba(1, 0, 0))] } }] });
    const second = tx.create('FRAME', page, { name: 'Второй', x: 1000, y: 0, width: 960, height: 540 });
    return { first, second };
  });
  const res = await collectSlides(editor.doc, [ids.first, ids.second], env(editor), { mode: 'editable', scale: 2, svg: true, groups: false });
  const files = buildPptx(res.slides, res.images, { title: 'Доклад' });
  const deck = readPptx(new Map(files.map((f) => [f.name, f.data])));
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.width, 1920);
  assert.equal(deck.height, 1080, '16:9 kept');
  const bg = deck.slides[0]!.background;
  assert.ok(bg && bg.type === 'solid' && Math.abs(bg.color.b - 0.3) < 0.01, 'the background colour');
  const shapes = deck.slides[0]!.elements.filter((e) => e.k === 'shape');
  const plate = shapes.find((e) => e.k === 'shape' && e.geom === 'roundRect');
  assert.ok(plate && plate.k === 'shape' && Math.abs(plate.w - 400) < 2 && Math.abs(plate.x - 80) < 2, 'a 960 slide becomes 1920: twice as large');
  const text = shapes.find((e) => e.k === 'shape' && e.text);
  assert.ok(text && text.k === 'shape');
  const runs = text.text!.paragraphs[0]!.runs;
  assert.deepEqual(runs.map((r) => r.text), ['Привет, ', 'мир']);
  assert.equal(runs[1]!.italic, true);
  assert.ok(Math.abs(runs[0]!.size - 64) < 1, '32 px on a 960 slide → 64 px on 1920');
  assert.equal(runs[0]!.bold, true);
  // Built into a presentation: slides in the grid, the run's style kept.
  const doc = createSlidesDocument('Импорт', true);
  const target = new Editor(doc, new ApproximateTextMeasurer());
  target.editPass = (tx, final) => final && arrangeSlides(doc, tx, target.pageId, true);
  target.commit('import', (tx) => buildDeck(target, tx, deck, deck.media, null));
  const slides = slideIds(doc, target.pageId);
  assert.equal(slides.length, 2);
  assert.equal(doc.get(slides[1]!, 'x'), 2160, 'in the grid');
  const t = doc.children(slides[0]!).find((id) => doc.type(id) === 'TEXT')!;
  assert.equal(doc.get(t, 'characters'), 'Привет, мир');
  assert.deepEqual(doc.get(t, 'textRuns').map((r) => [r.start, r.end, r.style.italic]), [[8, 11, true]]);
  // Bound to the theme as the import does (BUG-140): the red plate is the accent, its colour kept.
  const { bindSlideColors } = await import('../src/slides.ts');
  target.commit('bind', (tx) => bindSlideColors(doc, tx, slides));
  const plate2 = doc.children(slides[0]!).find((id) => doc.type(id) === 'RECTANGLE')!;
  const accent = doc.children(doc.rootId).find((id) => doc.type(id) === 'STYLE' && doc.get(id, 'name') === 'Тема/Акцент')!;
  assert.equal(doc.get(plate2, 'fillStyleId'), accent);
  const red = doc.get(plate2, 'fills')[0]!;
  assert.ok(red.type === 'SOLID' && red.color.r > 0.99 && red.color.g < 0.01, 'the look is kept');
  target.undo();
  target.undo();
  assert.equal(slideIds(doc, target.pageId).length, 0, 'one undo step');
});

test('pptx import: EMF pictures — GDI drawing becomes an SVG, a bitmap inside EMF+ is taken out (pixels un-premultiplied)', async () => {
  const { emfToSvg, emfPicture, RAW_MIME } = await import('../src/pptx/emf.ts');
  const records: number[][] = [];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const i16 = (n: number) => [n & 255, (n >> 8) & 255];
  const rec = (type: number, body: number[]) => records.push([...u32(type), ...u32(8 + body.length), ...body]);
  // Header: bounds 0,0–99,99; the signature at byte 40; padded to 88 bytes.
  // The header's body: bounds 0,0–99,99, the frame, the signature (at byte 40 of the record), padding to 88 bytes.
  const header = [...u32(0), ...u32(0), ...u32(99), ...u32(99), ...new Array(16).fill(0), ...u32(0x464d4520), ...new Array(80 - 36).fill(0)];
  rec(1, header);
  rec(39, [...u32(1), ...u32(0), ...u32(0x0000ff), ...u32(0)]); // a red solid brush
  rec(37, u32(1));
  rec(37, u32(0x80000008)); // no pen
  rec(86, [...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(3), ...i16(0), ...i16(0), ...i16(99), ...i16(0), ...i16(50), ...i16(99)]);
  rec(14, [...u32(0), ...u32(16), ...u32(20)]);
  const bytes = new Uint8Array(records.flat());
  const svg = emfToSvg(bytes);
  assert.ok(svg, 'a drawing');
  assert.match(svg!, /viewBox="0 0 100 100"/);
  assert.match(svg!, /<path d="M0\.00 0\.00 L99\.00 0\.00 L50\.00 99\.00 Z" fill="#ff0000"/);
  assert.doesNotMatch(svg!, /stroke=/, 'the null pen draws no outline');
  // EMF+ with a 1×1 premultiplied ARGB bitmap: half-transparent red (premultiplied 128,0,0,128).
  const image = [...u32(0xdbc01002), ...u32(1), ...u32(1), ...u32(1), ...u32(4), ...u32(0xe200b), ...u32(0), 0, 0, 128, 128];
  const objRec = [...i16(0x4008), ...i16(0x0500), ...u32(12 + image.length), ...u32(image.length), ...image];
  const plus = [...u32(0x2b464d45), ...objRec];
  records.length = 0;
  rec(1, header);
  rec(70, [...u32(plus.length), ...plus]);
  rec(14, [...u32(0), ...u32(16), ...u32(20)]);
  const pic = emfPicture(new Uint8Array(records.flat()));
  assert.ok(pic && pic.mime.startsWith(RAW_MIME) && /w=1;h=1/.test(pic.mime));
  assert.deepEqual([...pic.bytes], [255, 0, 0, 128], 'straight RGBA');
  assert.equal(emfToSvg(new Uint8Array(records.flat())), null, 'nothing drawn with GDI');
});

test('pptx import (FEAT-168): a PowerPoint table becomes a real table — grid cells with texts, merged cells kept', async () => {
  const { readPptx } = await import('../src/pptx/import.ts');
  const { buildDeck } = await import('../src/pptx/import-build.ts');
  const { createSlidesDocument, slideIds, arrangeSlides } = await import('../src/slides.ts');
  const { tableShape, tableTexts, tableMerges } = await import('../src/tables.ts');
  const { editor, page } = setup();
  const frame = editor.commit('setup', (tx) => tx.create('FRAME', page, { name: 'Слайд', x: 0, y: 0, width: 960, height: 540 }));
  const res = await collectSlides(editor.doc, [frame], env(editor), { mode: 'editable', scale: 2, svg: true, groups: false });
  const files = buildPptx(res.slides, res.images, { title: 'Таблица' });
  const cell = (text: string, attrs = '', pr = '') => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ru-RU" sz="1800"/><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>${pr}</a:tcPr></a:tc>`;
  const merged = '<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>';
  const frameXml = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Таблица 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="1463040"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid>`
    + `<a:tr h="365760">${cell('Город')}${cell('Итог', ' gridSpan="2"')}${merged}</a:tr>`
    + `<a:tr h="365760">${cell('Казань')}${cell('10')}${cell('20')}</a:tr>`
    + `<a:tr h="365760">${cell('Прозрачная', '', '<a:noFill/>')}${cell('')}${cell('')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const slide = files.find((f) => f.name === 'ppt/slides/slide1.xml')!;
  const xml = new TextDecoder().decode(slide.data).replace('</p:spTree>', `${frameXml}</p:spTree>`);
  slide.data = new TextEncoder().encode(xml);
  const deck = readPptx(new Map(files.map((f) => [f.name, f.data])));
  const el = deck.slides[0]!.elements.find((e) => e.k === 'table');
  assert.ok(el && el.k === 'table');
  const doc = createSlidesDocument('Импорт', true);
  const target = new Editor(doc, new ApproximateTextMeasurer());
  target.editPass = (tx, final) => final && arrangeSlides(doc, tx, target.pageId, true);
  target.commit('import', (tx) => buildDeck(target, tx, deck, deck.media, null));
  const s = slideIds(doc, target.pageId)[0]!;
  const table = doc.children(s).find((id) => doc.get(id, 'table'))!;
  assert.ok(table, 'a table, not a group of rectangles');
  assert.equal(doc.get(table, 'layoutMode'), 'GRID');
  const shape = tableShape(doc, table);
  assert.deepEqual([shape.rows, shape.cols], [3, 3]);
  assert.deepEqual(tableTexts(doc, table), [['Город', 'Итог', ''], ['Казань', '10', '20'], ['Прозрачная', '', '']]);
  const fillOf = (id: typeof shape.cells[number]) => doc.get(id!, 'fills')[0]!;
  assert.equal(fillOf(shape.cells[0]).type === 'SOLID' && fillOf(shape.cells[0]).opacity, 1, 'a cell without a fill stays white');
  assert.equal(fillOf(shape.cells[6]).type === 'SOLID' && fillOf(shape.cells[6]).opacity, 0, 'an explicit noFill stays transparent');
  assert.deepEqual(tableMerges(doc, table).map((m) => [m.row, m.col, m.rows, m.cols]), [[0, 1, 1, 2]]);
  assert.equal(doc.get(shape.cells[2]!, 'visible'), false, 'the place under the merged cell is hidden');
});

test('pptx export (FEAT-169): a table goes as a PowerPoint table — columns, merged cells, fills, lines; a badge in a cell goes over it; read back it is a table again', async () => {
  const { readPptx } = await import('../src/pptx/import.ts');
  const { buildDeck } = await import('../src/pptx/import-build.ts');
  const { createSlidesDocument, slideIds, arrangeSlides } = await import('../src/slides.ts');
  const { bareCell, tableFrame, tableMerges, tableTexts } = await import('../src/tables.ts');
  const { editor, page } = setup();
  const frame = editor.commit('setup', (tx) => {
    const slide = tx.create('FRAME', page, { name: 'Слайд', x: 0, y: 0, width: 960, height: 540, fills: [solid(rgba(1, 1, 1))] });
    const table = tableFrame(tx, slide, { name: 'Таблица', x: 40, y: 40, widths: [200, 300, 300], rows: 2, line: solid(rgba(0.8, 0.8, 0.8)) });
    const texts = [['Банк', 'Итог', ''], ['Т-Банк', '40 млн', '50 млн']];
    texts.forEach((row, r) =>
      row.forEach((text, c) => {
        const merged = r === 0 && c === 1;
        const cell = bareCell(tx, table, { fill: solid(r === 0 ? rgba(0.1, 0.1, 0.2) : rgba(1, 1, 1)), colSpan: merged ? 2 : 1, rowSpan: 1, minHeight: 40, hidden: r === 0 && c === 2, padX: 8, padY: 4 });
        if (r === 1 && c === 0) {
          tx.update(cell, { layoutMode: 'HORIZONTAL', itemSpacing: 6, counterAlign: 'CENTER' });
          tx.create('ELLIPSE', cell, { name: 'Значок', width: 20, height: 20, fills: [solid(rgba(1, 0.85, 0.2))] });
        }
        tx.create('TEXT', cell, { name: 'Текст', characters: text, fontFamily: 'Inter', fontSize: 16, ...(r === 1 && c === 0 ? { textAutoResize: 'WIDTH_AND_HEIGHT' as const } : { sizingH: { mode: 'FILL' as const }, textAutoResize: 'HEIGHT' as const, width: 100 }) });
      }),
    );
    return slide;
  });
  const res = await collectSlides(editor.doc, [frame], env(editor), { mode: 'editable', scale: 2, svg: true, groups: true });
  const els = res.slides[0]!.els;
  const table = els.find((e) => e.k === 'table');
  assert.ok(table && table.k === 'table', 'one table, not a group of cells');
  assert.equal(els.filter((e) => e.k === 'text').length, 0, 'the texts are in the cells');
  assert.ok(els.some((e) => e.k === 'shape' && e.geom === 'ellipse'), 'the badge goes over the table');
  assert.equal(table.cols.length, 3);
  assert.ok(Math.abs(table.cols.reduce((a, v) => a + v, 0) - table.w) < 0.5, 'the columns make up the width');
  assert.ok(table.cols[1]! > table.cols[0]!, 'shares kept');
  assert.deepEqual(table.cells[0]!.map((c) => [c.span, c.hMerge]), [[1, false], [2, false], [1, true]]);
  assert.equal(table.cells[1]![0]!.align, 'l');
  assert.ok(table.cells[1]![0]!.mar[3] > 20, 'the text stays to the right of the badge');
  assert.equal(table.line?.color, 'CCCCCC');
  const files = buildPptx(res.slides, res.images, { title: 'Таблица' });
  const xml = xmlOf(files, 'ppt/slides/slide1.xml');
  assert.match(xml, /<a:tbl><a:tblPr\/><a:tblGrid>(<a:gridCol w="\d+"\/>){3}<\/a:tblGrid>/);
  assert.match(xml, /<a:tc gridSpan="2">/);
  assert.match(xml, /<a:tc hMerge="1">/);
  assert.doesNotMatch(xml, /<p:grpSp>/, 'PowerPoint does not group a table');
  const deck = readPptx(new Map(files.map((f) => [f.name, f.data])));
  const doc = createSlidesDocument('Импорт', true);
  const target = new Editor(doc, new ApproximateTextMeasurer());
  target.editPass = (tx, final) => final && arrangeSlides(doc, tx, target.pageId, true);
  target.commit('import', (tx) => buildDeck(target, tx, deck, deck.media, null));
  const s = slideIds(doc, target.pageId)[0]!;
  const back = doc.children(s).find((id) => doc.get(id, 'table'))!;
  assert.ok(back, 'read back as a table');
  assert.deepEqual(tableTexts(doc, back), [['Банк', 'Итог', ''], ['Т-Банк', '40 млн', '50 млн']]);
  assert.deepEqual(tableMerges(doc, back).map((m) => [m.row, m.col, m.rows, m.cols]), [[0, 1, 1, 2]]);
});

test('pptx export (BUG-139): the text of a cell wrapped in frames that paint nothing, or several texts, go into the cell; a pill with its own text goes over', async () => {
  const { bareCell, tableFrame } = await import('../src/tables.ts');
  const { editor } = setup();
  const text = (tx: Parameters<Parameters<Editor['commit']>[1]>[0], parent: NodeId, characters: string, weight = 400) =>
    tx.create('TEXT', parent, { name: 'Текст', characters, fontFamily: 'Inter', fontSize: 16, fontWeight: weight, textAutoResize: 'WIDTH_AND_HEIGHT' });
  const frame = editor.commit('setup', (tx) => {
    const slide = tx.create('FRAME', editor.pageId, { name: 'Слайд', x: 0, y: 0, width: 960, height: 540, fills: [solid(rgba(1, 1, 1))] });
    const table = tableFrame(tx, slide, { name: 'Таблица', x: 40, y: 40, widths: [300, 300], rows: 2, line: solid(rgba(0.8, 0.8, 0.8)) });
    const cells = [0, 1, 2, 3].map(() => bareCell(tx, table, { fill: solid(rgba(1, 1, 1)), colSpan: 1, rowSpan: 1, minHeight: 40, hidden: false, padX: 8, padY: 4 }));
    // <td><div><span>Москва</span></div></td>: frames without paint around the text.
    const div = tx.create('FRAME', cells[0]!, { name: 'div', layoutMode: 'VERTICAL', paddingLeft: 10, fills: [] });
    text(tx, tx.create('FRAME', div, { name: 'span', layoutMode: 'HORIZONTAL', fills: [] }), 'Москва');
    // <td><b>Итог:</b> 40 млн</td> side by side, and a line under them.
    const row = tx.create('FRAME', cells[1]!, { name: 'p', layoutMode: 'HORIZONTAL', itemSpacing: 4, fills: [] });
    text(tx, row, 'Итог:', 700);
    text(tx, row, '40 млн');
    text(tx, cells[1]!, 'за год');
    // A pill paints: it goes over with its text.
    const pill = tx.create('FRAME', cells[2]!, { name: 'pill', layoutMode: 'HORIZONTAL', paddingLeft: 6, paddingRight: 6, fills: [solid(rgba(0.9, 0.95, 1))] });
    text(tx, pill, 'Новое');
    text(tx, cells[3]!, 'Пермь');
    return slide;
  });
  const res = await collectSlides(editor.doc, [frame], env(editor), { mode: 'editable', scale: 2, svg: true, groups: false });
  const els = res.slides[0]!.els;
  const table = els.find((e) => e.k === 'table');
  assert.ok(table && table.k === 'table');
  const said = (c: TableCell) => c.paras.map((p) => p.runs.map((r) => r.text).join(''));
  assert.deepEqual(table.cells.map((row) => row.map(said)), [[['Москва'], ['Итог: 40 млн', 'за год']], [[], ['Пермь']]]);
  assert.equal(table.cells[0]![1]!.paras[0]!.runs[0]!.w, 700, 'each text keeps its style');
  assert.ok(table.cells[0]![0]!.mar[3] >= 17, 'the wrapper\'s padding stays as the margin');
  assert.deepEqual(els.filter((e) => e.k === 'text').map((e) => e.k === 'text' && e.paras[0]!.runs[0]!.text), ['Новое'], 'only the pill\'s text goes over');
});
