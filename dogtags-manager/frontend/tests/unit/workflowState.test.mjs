import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreWorkflowStep, workflowSteps } from '../../src/features/intake/workflowState.ts';

test('four-stage workflow preserves old checking, editing, confirmation and download locations', () => {
  assert.deepEqual(workflowSteps, ['Загрузка', 'Проверка', 'Подтверждение', 'Скачивание']);
  assert.equal(restoreWorkflowStep(null, '1', false), 1);
  assert.equal(restoreWorkflowStep(null, '2', false), 1);
  assert.equal(restoreWorkflowStep(null, '3', false), 2);
  assert.equal(restoreWorkflowStep(null, '4', true), 3);
  assert.equal(restoreWorkflowStep('2', '1', false), 2);
  assert.equal(restoreWorkflowStep('invalid', null, true), 3);
  assert.equal(restoreWorkflowStep(null, null, false), 1);
});
