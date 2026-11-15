import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { Document } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import { exportVectorPdf, toCmyk } from '#render';
import { Editor } from '../src/editor.ts';
import { checkPrint, effectivePpi, MM } from '../src/print-check.ts';

const solid = (r: number, g: number, b: number) => [{ type: 'SOLID' as const, color: { r, g, b, a: 1 }, opacity: 1, visible: true }];

function flyer() {
  const doc = Document.createEmpty('Тест', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const ids = editor.commit('setup', (tx) => {
    const page = tx.create('FRAME', editor.pageId, { name: 'A5', width: 420, height: 595, fills: solid(1, 0.9, 0.2), clipsContent: true });
    const band = tx.create('RECTANGLE', page, { name: 'Полоса', x: 0, y: 500, width: 420, height: 95, fills: solid(0.1, 0.3, 0.8) });
    const bled = tx.create('RECTANGLE', page, { name: 'С вылетом', x: -10, y: -10, width: 200, height: 60, fills: solid(0.9, 0.1, 0.1) });
    const title = tx.create('TEXT', page, { name: 'Заголовок', x: 4, y: 100, width: 300, height: 40, characters: 'Афиша', fontSize: 32 });
    const body = tx.create('TEXT', page, { name: 'Текст', x: 40, y: 200, width: 300, height: 40, characters: 'Внутри', fontSize: 14 });
    const photo = tx.create('RECTANGLE', page, { name: 'Фото', x: 40, y: 260, width: 340, height: 220, fills: [{ type: 'IMAGE', imageHash: 'p', scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] as never });
    const line = tx.create('LINE', page, { name: 'Волосок', x: 40, y: 250, width: 300, strokes: solid(0, 0, 0), strokeWeight: 0.1 });
    return { page, band, bled, title, body, photo, line };
  });
  return { doc, editor, ...ids };
}

const streams = (pdf: Uint8Array) => {
  const text = new TextDecoder('latin1').decode(pdf);
  const out: string[] = [text];
  const re = /\/FlateDecode[^>]*>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      /* binary image data */
    }
  }
  return out.join('\n');
};

test('print: CMYK of plain colours — black is K only, white is nothing', () => {
  assert.deepEqual(toCmyk(0, 0, 0), [0, 0, 0, 1]);
  assert.deepEqual(toCmyk(1, 1, 1), [0, 0, 0, 0]);
  const [c, m, y, k] = toCmyk(1, 0, 0);
  assert.deepEqual([c, m, y, k], [0, 1, 1, 0]);
  assert.equal(Math.round(effectivePpi('FILL', 340, 220, 1000, 700)), Math.round(72 / Math.max(340 / 1000, 220 / 700)));
});

test('print: PDF with bleed and marks — trim and bleed boxes, CMYK operators, the frame fill past the trim, marks outside', async () => {
  const { editor, page, photo, title, body } = flyer();
  // A picture, and text without the font's file, are drawn on a canvas (not in Node): the page without them.
  editor.commit('shapes only', (tx) => [photo, title, body].forEach((id) => tx.delete(id)));
  editor.scene.ensure();
  const bleed = 3 * MM;
  const pdf = new Uint8Array(await (await exportVectorPdf({ images: { get: () => null } } as never, editor.scene, editor.measurer, [page], 300 / 72, { bleed, marks: true, cmyk: true })).arrayBuffer());
  const all = streams(pdf);
  const off = bleed + 20;
  const r = (v: number) => String(Math.round(v * 1000) / 1000);
  assert.match(all, new RegExp(`/MediaBox \\[0 0 ${r(420 + off * 2)} ${r(595 + off * 2)}\\]`));
  assert.match(all, new RegExp(`/TrimBox \\[${r(off)} ${r(off)} ${r(off + 420)} ${r(off + 595)}\\]`));
  assert.match(all, /\/BleedBox/);
  assert.match(all, / k\n/, 'fills in CMYK');
  assert.doesNotMatch(all, / rg\n/, 'no RGB fills');
  assert.match(all, /1 1 1 1 K/, 'marks in registration black');
  // The frame's fill starts a bleed before its trim (−3 mm in its own space).
  assert.match(all, new RegExp(`-${r(bleed)} -${r(bleed)} m`));
  // Without print options — the page as before, RGB.
  const plain = streams(new Uint8Array(await (await exportVectorPdf({ images: { get: () => null } } as never, editor.scene, editor.measurer, [page])).arrayBuffer()));
  assert.doesNotMatch(plain, /TrimBox/);
  assert.match(plain, / rg\n/);
});

test('print: the check before printing — text at the edge, a weak picture, a band stopping at the trim, a hairline', () => {
  const { editor, page } = flyer();
  const issues = checkPrint(editor, page, 3, (h) => (h === 'p' ? { width: 500, height: 320 } : null));
  const by = (k: string) => issues.filter((i) => i.kind === k).map((i) => editor.doc.get(i.id, 'name'));
  assert.deepEqual(by('edge'), ['Заголовок'], '4 pt from the trim, inside the 3 mm safe margin');
  assert.deepEqual(by('lowres'), ['Фото']);
  assert.ok(issues.find((i) => i.kind === 'lowres')!.bad, 'under 150 ppi');
  assert.deepEqual(by('nobleed'), ['Полоса'], 'the band touches three edges and stops; the red one goes past');
  assert.deepEqual(by('hairline'), ['Волосок']);
  assert.equal(checkPrint(editor, page, 0, () => null).some((i) => i.kind === 'nobleed'), false, 'no bleed — nothing to reach');
});
