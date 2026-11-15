import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApproximateTextMeasurer } from '#layout';
import { Editor } from '../src/editor.ts';
import { createSlidesDocument, slideIds } from '../src/slides.ts';

test('a slide on show is the whole world: dropping past its edge keeps a layer on it, wrapping a loose layer stays on it (BUG-180)', () => {
  const doc = createSlidesDocument('Доклад');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const slide = slideIds(doc, editor.pageId)[0]!;
  editor.slideStage = { current: () => slide, flip: () => {} };
  editor.scene.ensure();
  const b = editor.scene.bounds(slide);
  // Below the slide, on the grey: still the slide.
  assert.equal(editor.containerAt({ x: b.x + 100, y: b.y + b.height + 300 }), slide);
  // A square left on the page by an older version (as in the user's file): framing it stays on the slide.
  const loose = editor.commit('loose', (tx) => tx.create('RECTANGLE', editor.pageId, { x: b.x + 200, y: b.y + 200, width: 100, height: 100 }));
  editor.scene.ensure();
  const slidesBefore = slideIds(doc, editor.pageId).length;
  editor.setSelection([loose]);
  editor.addAutoLayout();
  assert.equal(slideIds(doc, editor.pageId).length, slidesBefore, 'no new slide');
  const frame = doc.parent(loose)!;
  assert.equal(doc.type(frame), 'FRAME');
  assert.equal(doc.parent(frame), slide, 'the auto layout frame is on the slide');
  assert.notEqual(doc.get(frame, 'layoutMode'), 'NONE');
  // Without a slide on show (all slides view), the page is the page.
  editor.slideStage = null;
  assert.equal(editor.containerAt({ x: b.x + 100, y: b.y + b.height + 300 }), editor.pageId);
});
