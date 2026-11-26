import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProcessing, processingProgress } from '../../src/features/intake/processing.ts';

function item(state, kind = 'DISCOVER', percent = 0, stage = 'queued') {
  return { intake: { state: 'PROCESSING' }, job: { state, kind, progress: { percent, stage } } };
}

test('interface stays locked through discovery and queued or active build', () => {
  assert.equal(isProcessing(item('QUEUED')), true);
  assert.equal(isProcessing(item('PROCESSING', 'DISCOVER', 95)), true);
  assert.equal(isProcessing(item('QUEUED', 'BUILD')), true);
  assert.equal(isProcessing(item('PROCESSING', 'BUILD', 98)), true);
  assert.ok(processingProgress(item('QUEUED', 'BUILD')).percent >
    processingProgress(item('PROCESSING', 'DISCOVER', 95)).percent);
});

test('results, decisions and failures release the interface even with an older intake state', () => {
  for (const state of ['COMPLETE', 'PREPARED', 'BLOCKED', 'FAILED', 'SUPERSEDED']) {
    assert.equal(isProcessing(item(state)), false, state);
  }
  assert.equal(isProcessing({ intake: { state: 'DISCOVERING' } }), true);
  assert.equal(isProcessing({ intake: { state: 'NEEDS_DECISION' } }), false);
});

test('progress waits for server milestones, and active work never reports complete', () => {
  const active = item('PROCESSING', 'BUILD', 70, 'serialization');
  assert.deepEqual(processingProgress(active), processingProgress(active));
  assert.equal(processingProgress(active).stage, 'Формируем выходные файлы');
  for (const value of [undefined, null, NaN, Infinity, -50, 500]) {
    const result = processingProgress(item('PROCESSING', 'BUILD', value));
    assert.ok(Number.isFinite(result.percent) && result.percent >= 0 && result.percent < 100);
  }
});
