import type { Api, Correction, Revision } from '../../api/client';
import { suggestMsisdnPrefix, validateFields, type FieldIssue } from '../hub/validateFields.ts';
import type { OperationCommand } from '../results/model';

export type ReviewDraft = {
  revisionId: string; corrections: Correction[]; selections: Api['RowSelectionInput'][];
  prefixMsisdn?: boolean;
  profile: { SPREADING: string; INTERNAL_OPERATOR_NAME: string; reason: string };
  pending?: Extract<OperationCommand, { action: 'revision.save' | 'processing.save_start' }>;
};
export function mergeCorrections(existing: readonly Correction[], incoming: readonly Correction[]): Correction[] {
  const result = new Map(existing.map(value => [`${value.record_id}:${value.field}`, value]));
  for (const change of incoming) {
    const key = `${change.record_id}:${change.field}`;
    const before = result.get(key)?.before ?? change.before;
    if (change.after === before) result.delete(key);
    else result.set(key, { ...change, before });
  }
  return [...result.values()];
}
export function draftValues(row: Api['RecordState'], corrections: readonly Correction[], prefixMsisdn = false): Record<string, string> {
  const values = { ...row.effective };
  if (prefixMsisdn && values.MSISDN) values.MSISDN = suggestMsisdnPrefix(values.MSISDN) ?? values.MSISDN;
  for (const change of corrections) if (change.record_id === row.record_id) values[change.field] = change.after;
  return values;
}
export function msisdnPrefixCount(total: number, corrections: readonly Correction[]): number {
  return Math.max(0, corrections.reduce((count, change) => change.field === 'MSISDN'
    ? count - Number(!!suggestMsisdnPrefix(change.before)) + Number(!!suggestMsisdnPrefix(change.after)) : count, total));
}
export function confirmMsisdnPrefix(draft: ReviewDraft): ReviewDraft {
  return { ...draft, prefixMsisdn: true, corrections: draft.corrections.map(change => change.field === 'MSISDN'
    ? { ...change, before: suggestMsisdnPrefix(change.before) ?? change.before, after: suggestMsisdnPrefix(change.after) ?? change.after }
    : change).filter(change => change.before !== change.after) };
}
export function editedIssues(issues: readonly FieldIssue[], original: Record<string, string>, values: Record<string, string>, fields: readonly string[], role?: string): FieldIssue[] {
  const checksFlags = fields.some(field => field === 'IS_MAV' || field === 'IS_KSS');
  const preserved = issues.filter(issue => !(checksFlags && issue.code === 'flags_both_zero') && (!fields.includes(issue.field) || issue.code !== 'label_contains_latin')
    && (issue.scope === 'global' || issue.scope === 'warning' || !fields.includes(issue.field) || values[issue.field] === original[issue.field]));
  return [...new Map([...preserved, ...validateFields(values, fields, role)].map(issue => [`${issue.field}:${issue.code}`, issue])).values()];
}
export function reviewDraftKey(user: string, intake: string) { return `dogtags.review-draft.v1.${user}.${intake}`; }
export function readReviewDraft(storage: Pick<Storage, 'getItem'>, key: string): ReviewDraft | undefined {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    return value && typeof value.revisionId === 'string' && Array.isArray(value.corrections)
      && Array.isArray(value.selections) && value.profile ? value : undefined;
  } catch { return undefined; }
}
export function remainingDraft(draft: ReviewDraft, command: NonNullable<ReviewDraft['pending']>, revisionId: string): ReviewDraft {
  const cells = new Set(command.body.corrections?.map(value => `${value.record_id}:${value.field}`));
  const rows = new Set(command.body.row_selections?.map(value => value.record_id));
  return { ...draft, revisionId, pending: undefined, prefixMsisdn: command.body.prefix_msisdn ? false : draft.prefixMsisdn,
    corrections: draft.corrections.filter(value => !cells.has(`${value.record_id}:${value.field}`)),
    selections: draft.selections.filter(value => !rows.has(value.record_id)) };
}
/** Save bounded chunks through existing revision APIs; only the final chunk starts processing. */
export async function applyReviewDraft(draft: ReviewDraft, revision: Revision, overrides: Api['ProfileOverrideInput'][], send: (command: NonNullable<ReviewDraft['pending']>) => Promise<boolean>, receiptRevision: (command: NonNullable<ReviewDraft['pending']>) => Promise<string>, checkpoint: (draft: ReviewDraft) => void): Promise<boolean> {
  let current = draft;
  do {
    const final = current.corrections.length <= 100 && current.selections.length <= 100;
    const command: NonNullable<ReviewDraft['pending']> = current.pending ?? {
      action: final ? 'processing.save_start' : 'revision.save', caseId: revision.case_id,
      body: { operation_id: crypto.randomUUID(), expected_revision_id: current.revisionId, source_asset_id: revision.source.id,
        corrections: current.corrections.slice(0, 100), row_selections: current.selections.slice(0, 100), overrides: final ? overrides : [], ...(current.prefixMsisdn ? { prefix_msisdn: true } : {}) },
    };
    current = { ...current, pending: command }; checkpoint(current);
    if (!await send(command)) return false;
    current = remainingDraft(current, command, await receiptRevision(command)); checkpoint(current);
    if (command.action === 'processing.save_start') return true;
  } while (true);
}
