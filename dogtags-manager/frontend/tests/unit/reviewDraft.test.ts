import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReviewDraft, confirmMsisdnPrefix, msisdnPrefixCount, draftValues, editedIssues, mergeCorrections, remainingDraft, readReviewDraft, type ReviewDraft } from '../../src/features/intake/reviewDraft.ts';
import type { Correction, Revision } from '../../src/api/client.ts';
const cell = (id: string, before = 'Тест', after = 'Тест Brand'): Correction => ({ record_id: id, ordinal: Number(id) || 1, field: 'MAV_LABEL_NAME', before, after, reason: '' });
const profile = { SPREADING: '0', INTERNAL_OPERATOR_NAME: 'hubRTK', reason: '' };
const revision = { id: 'r0', case_id: 'case', source: { id: 'source' } } as Revision;

test('session corrections keep original before across repeated saves and remove reverted cells', () => {
  const first = mergeCorrections([], [cell('1')]);
  const second = mergeCorrections(first, [cell('1', 'Тест Brand', 'Новое')]);
  assert.equal(second[0].before, 'Тест');
  assert.equal(second[0].after, 'Новое');
  assert.deepEqual(mergeCorrections(second, [cell('1', 'Новое', 'Тест')]), []);
  assert.equal(first[0].after, 'Тест Brand');
});

test('saved corrections remove old cell diagnostics while retaining global checks until processing', () => {
  const original = { MAV_LABEL_NAME: 'Тест_' };
  const issues = [{ field: 'MAV_LABEL_NAME', code: 'label_characters', message: 'Недопустимый символ', scope: 'cell' },
    { field: 'MSISDN', code: 'conflict', message: 'Сверить назначения', scope: 'global' }];
  assert.deepEqual(editedIssues(issues, original, { MAV_LABEL_NAME: 'Тест' }, ['MAV_LABEL_NAME']).map(i => i.code), ['conflict']);
  assert.ok(editedIssues(issues, original, { MAV_LABEL_NAME: 'Тест_' }, ['MAV_LABEL_NAME']).some(i => i.scope === 'cell'));
  const warning = editedIssues([], original, { MAV_LABEL_NAME: 'Тест Brand' }, ['MAV_LABEL_NAME']);
  assert.equal(warning[0].scope, 'warning');
  assert.deepEqual(editedIssues(warning, { MAV_LABEL_NAME: 'Тест Brand' }, { MAV_LABEL_NAME: 'Тест' }, ['MAV_LABEL_NAME']), []);
});

test('more than 100 saved corrections use bounded draft requests and exactly one final processing request', async () => {
  const draft: ReviewDraft = { revisionId: 'r0', corrections: Array.from({ length: 250 }, (_, i) => cell(String(i + 1))), selections: [], profile };
  const commands: any[] = [], checkpoints: ReviewDraft[] = [];
  assert.equal(await applyReviewDraft(draft, revision, [], async command => { commands.push(command); return true; },
    async () => `r${commands.length}`, value => checkpoints.push(value)), true);
  assert.deepEqual(commands.map(c => c.action), ['revision.save', 'revision.save', 'processing.save_start']);
  assert.deepEqual(commands.map(c => c.body.expected_revision_id), ['r0', 'r1', 'r2']);
  assert.deepEqual(commands.map(c => c.body.corrections.length), [100, 100, 50]);
  assert.equal(checkpoints.at(-1)?.revisionId, 'r3');
  assert.equal(checkpoints.at(-1)?.corrections.length, 0);
});

test('unknown save result retains the exact command and all remaining draft cells for recovery', async () => {
  const draft: ReviewDraft = { revisionId: 'r0', corrections: [cell('1')], selections: [], profile };
  let saved = draft;
  assert.equal(await applyReviewDraft(draft, revision, [], async () => false, async () => { throw Error('not confirmed'); }, value => { saved = value; }), false);
  assert.equal(saved.corrections.length, 1);
  const pendingId = saved.pending!.body.operation_id;
  const commands: any[] = [];
  assert.equal(await applyReviewDraft(saved, revision, [], async c => { commands.push(c); return true; }, async () => 'r1', () => {}), true);
  assert.equal(commands[0].body.operation_id, pendingId);
  assert.equal(remainingDraft(saved, saved.pending!, 'r1').corrections.length, 0);
  assert.deepEqual(readReviewDraft({ getItem: () => JSON.stringify(saved) }, 'key'), saved);
});


test('bulk prefix is one session decision and manual changes retain correct before values', async () => {
  const draft: ReviewDraft = { revisionId: 'r0', corrections: [
    { ...cell('1'), field: 'MSISDN', before: '9937967877', after: '9937967878' },
  ], selections: [], profile };
  const accepted = confirmMsisdnPrefix(draft);
  assert.equal(accepted.prefixMsisdn, true);
  assert.equal(draft.corrections[0].before, '9937967877');
  assert.equal(accepted.corrections[0].before, '79937967877');
  assert.equal(accepted.corrections[0].after, '79937967878');
  const row = { record_id: 'other', effective: { MSISDN: '9937967879' } } as any;
  assert.equal(draftValues(row, accepted.corrections, true).MSISDN, '79937967879');
  const commands: any[] = [];
  await applyReviewDraft(accepted, revision, [], async command => { commands.push(command); return true; }, async () => 'r1', () => {});
  assert.equal(commands.length, 1);
  assert.equal(commands[0].body.prefix_msisdn, true);
  assert.equal(commands[0].body.corrections.length, 1);
});

test('bulk prefix is sent on first chunk only while final chunk starts processing', async () => {
  const draft: ReviewDraft = { revisionId: 'r0', corrections: Array.from({ length: 101 }, (_, i) => cell(String(i + 1))), selections: [], profile, prefixMsisdn: true };
  const commands: any[] = [];
  await applyReviewDraft(draft, revision, [], async command => { commands.push(command); return true; }, async () => `r${commands.length}`, () => {});
  assert.deepEqual(commands.map(c => c.body.prefix_msisdn), [true, undefined]);
  assert.deepEqual(commands.map(c => c.action), ['revision.save', 'processing.save_start']);
});


test('prefix popup count includes unloaded rows and adjusts session edits', () => {
  const changes = [
    { ...cell('1'), field: 'MSISDN' as const, before: '9937967877', after: '79937967877' },
    { ...cell('2'), field: 'MSISDN' as const, before: '79937967878', after: '9937967878' },
    { ...cell('3'), field: 'MSISDN' as const, before: '9937967879', after: '79937967879' },
    cell('4'),
  ];
  assert.equal(msisdnPrefixCount(4917, []), 4917);
  assert.equal(msisdnPrefixCount(4917, changes), 4916);
  assert.equal(msisdnPrefixCount(0, changes.slice(0, 1)), 0);
});

test('prefix-only validation retains other diagnostics without rechecking untouched fields', () => {
  const original = { MSISDN: '9937967877', MAV_LABEL_NAME: 'Тест_' };
  const issues = [{ field: 'MSISDN', code: 'msisdn_country_prefix', message: '10 цифр', scope: 'cell' },
    { field: 'MAV_LABEL_NAME', code: 'label_characters', message: 'Символ _', scope: 'cell' }];
  assert.deepEqual(editedIssues(issues, original, { ...original, MSISDN: '79937967877' }, ['MSISDN']), [issues[1]]);
});

test('changing either flag clears the joint zero error, while prefix-only checks retain it', () => {
  const original = { IS_MAV: '0', IS_KSS: '0', MSISDN: '9937967877' };
  const issues = [{ field: 'IS_MAV', code: 'flags_both_zero', message: 'Оба флага 0', scope: 'cell' }];
  assert.deepEqual(editedIssues(issues, original, { ...original, IS_KSS: '1' }, ['IS_MAV', 'IS_KSS']), []);
  assert.deepEqual(editedIssues(issues, original, { ...original, MSISDN: '79937967877' }, ['MSISDN']), issues);
});
