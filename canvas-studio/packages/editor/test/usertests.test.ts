import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, taskStats, tapsOn } from '../src/prototype/test-stats.ts';
import type { TestSession } from '../src/cloud.ts';

const tap = (s: string, x: number, hit: boolean) => ({ s, x, y: 0, t: 0, hit });

test('prototype tests on people: reached, usual time, misses, where people stopped, ways through', () => {
  const sessions: TestSession[] = [
    { id: 'a', at: 1, tasks: [{ task: 'k1', outcome: 'done', ms: 4000, path: ['A', 'B', 'B', 'C'], taps: [tap('A', 1, true), tap('B', 2, true)] }] },
    { id: 'b', at: 2, tasks: [{ task: 'k1', outcome: 'done', ms: 8000, path: ['A', 'B', 'C'], taps: [tap('A', 3, false), tap('A', 4, true), tap('B', 5, true)] }] },
    { id: 'c', at: 3, tasks: [{ task: 'k1', outcome: 'gaveup', ms: 20000, path: ['A', 'D'], taps: [tap('A', 6, true), tap('D', 7, false), tap('D', 8, false)] }] },
    { id: 'd', at: 4, tasks: [{ task: 'k1', outcome: 'left', ms: 3000, path: ['A', 'D'], taps: [] }, { task: 'k2', outcome: 'done', ms: 1, path: [], taps: [] }] },
    { id: 'e', at: 5, tasks: [] },
  ];
  const s = taskStats(sessions, 'k1');
  assert.deepEqual([s.total, s.done, s.gaveup, s.left], [4, 2, 1, 1]);
  assert.equal(s.medianMs, 6000, 'median of those who reached the goal only');
  assert.equal(s.misses, 3 / 8);
  assert.deepEqual(s.stops, [{ screen: 'D', n: 2 }]);
  assert.deepEqual(s.paths[0], { path: ['A', 'B', 'C'], n: 2, done: 2 }, 'a repeated screen is one step');
  assert.deepEqual(s.paths[1], { path: ['A', 'D'], n: 2, done: 0 });
  assert.equal(s.screens[0]!.screen, 'A');
  assert.deepEqual(tapsOn(sessions, 'k1', 'D').map((t) => t.x), [7, 8]);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(taskStats(sessions, 'none').misses, null);
});
