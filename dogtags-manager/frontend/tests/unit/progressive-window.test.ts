import assert from 'node:assert/strict';
import test from 'node:test';
import { pageCursor, retainedPages, windowIndices, type Cursor } from '../../src/components/progressiveWindow.ts';

test('million-row logical list retains a bounded contiguous window in both directions', () => {
  for (const mode of ['500', '1000', 'all'] as const) {
    let window: number[] = [];
    for (let active = 0; active < 2000; ++active) {
      window = windowIndices(window, active, mode);
      assert.ok(window.length <= retainedPages(mode));
      assert.equal(window.at(-1), active);
      assert.ok(window.every((value, i) => !i || value === window[i - 1] + 1));
    }
    for (let active = window[0] - 1; active >= 0; --active) {
      window = windowIndices(window, active, mode);
      assert.equal(window[0], active);
      assert.ok(window.length <= retainedPages(mode));
      assert.ok(window.every((value, i) => !i || value === window[i - 1] + 1));
    }
  }
});

test('opaque cursor ledger restores evicted pages without deriving offsets from record numbers', () => {
  const ledger: Cursor[] = [undefined, 'opaque-A', 'opaque-B'];
  assert.deepEqual(pageCursor(ledger, 0, 'opaque-C'), { cursor: undefined });
  assert.deepEqual(pageCursor(ledger, 1, 'opaque-C'), { cursor: 'opaque-A' });
  assert.deepEqual(pageCursor(ledger, 3, 'opaque-C'), { cursor: 'opaque-C' });
  assert.equal(pageCursor(ledger, 3, null), undefined);
  assert.equal(pageCursor(ledger, -1, 'opaque-C'), undefined);
  assert.equal(pageCursor(ledger, 4, 'opaque-C'), undefined);
});

test('display mode changes retain the active page and do not require giant transport requests', () => {
  assert.deepEqual(windowIndices([7, 8, 9], 8, '500'), [8]);
  assert.deepEqual(windowIndices([7, 8, 9], 8, '1000'), [7, 8]);
  assert.deepEqual(windowIndices([7, 8, 9], 8, 'all'), [7, 8, 9]);
  assert.equal(retainedPages('all') * 500, 1500);
});
