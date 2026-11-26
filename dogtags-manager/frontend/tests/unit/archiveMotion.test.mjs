import assert from 'node:assert/strict';
import test from 'node:test';
import { scrollToArchivePreview } from '../../src/features/intake/scrollToArchivePreview.ts';

function environment(t, reduced = false) {
  const keys = ['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const events = new EventTarget(), frames = new Map();
  let sequence = 0, focused = 0;
  events.matchMedia = () => ({ matches: reduced });
  globalThis.window = events;
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.getComputedStyle = () => ({ scrollMarginBlockStart: '20px' });
  const table = { scrollTop: 123, focus: () => ++focused };
  const owner = { scrollTop: 0, scrollHeight: 2000, clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }) };
  const target = { getBoundingClientRect: () => ({ top: 1000 }), querySelector: () => table };
  function advance(now) { const entry = frames.entries().next().value; if (entry) { frames.delete(entry[0]); entry[1](now); } }
  return { owner, target, table, events, advance, frames, focused: () => focused };
}

test('preview motion takes a second, focuses the table and preserves its own scroll', t => {
  const e = environment(t);
  scrollToArchivePreview(e.owner, e.target);
  e.advance(0); e.advance(500);
  assert.equal(e.owner.scrollTop, 440);
  assert.equal(e.focused(), 0);
  e.advance(999);
  assert.ok(e.owner.scrollTop < 880);
  e.advance(1000);
  assert.equal(e.owner.scrollTop, 880);
  assert.equal(e.focused(), 1);
  assert.equal(e.table.scrollTop, 123);
  assert.equal(e.frames.size, 0);
});

test('manual scrolling or teardown cancels movement without stealing focus', t => {
  const e = environment(t);
  const cancel = scrollToArchivePreview(e.owner, e.target);
  e.advance(0); e.advance(200);
  const stoppedAt = e.owner.scrollTop;
  e.events.dispatchEvent(new Event('wheel'));
  e.advance(1000); cancel();
  assert.equal(e.owner.scrollTop, stoppedAt);
  assert.equal(e.frames.size, 0);
  assert.equal(e.focused(), 0);
});

test('reduced motion skips animation while reaching the preview', t => {
  const e = environment(t, true);
  scrollToArchivePreview(e.owner, e.target);
  assert.equal(e.owner.scrollTop, 880);
  assert.equal(e.focused(), 1);
  assert.equal(e.frames.size, 0);
});

test('document preview movement uses viewport coordinates after existing page scroll', t => {
  const e = environment(t);
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'document', prior); else delete globalThis.document; });
  globalThis.document = { scrollingElement: e.owner };
  e.owner.scrollTop = 300;
  e.owner.getBoundingClientRect = () => ({ top: -300 });
  scrollToArchivePreview(e.owner, e.target);
  e.advance(0); e.advance(1000);
  assert.equal(e.owner.scrollTop, 1280);
});
