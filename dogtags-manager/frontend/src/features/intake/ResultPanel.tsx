import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, boolean, canChooseDownloadLocation, object, string, type Api, type Correction, type Override, type Revision } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Disclosure } from '../../components/Disclosure';
import { IconButton } from '../../components/IconButton';
import { SaveAsButton } from '../../components/SaveAsButton';
import { Input, Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { RecordEditor } from '../hub/RecordEditor';
import { ScientificExclusions } from '../hub/ScientificExclusions';
import { dispositionLabels, errorText, fieldLabels, hubFields, profileValue } from '../hub/model';
import { type DirectMutation, type Mutate } from '../results/model';
import { MsisdnCleanupNotice } from './MsisdnCleanupNotice';
import { ArtifactPreview } from './ArtifactPreview';
import { scrollToArchivePreview } from './scrollToArchivePreview';
import { artifactLabel, mappingOf, repairFields, repairRole, reviewCountLabels, type Intake } from './model';
import { restoreWorkflowStep, type WorkflowStep } from './workflowState';
import { applyReviewDraft, confirmMsisdnPrefix, msisdnPrefixCount, draftValues, editedIssues, mergeCorrections, readReviewDraft, remainingDraft, reviewDraftKey, type ReviewDraft } from './reviewDraft';
import { suggestLabelCorrection, validateFields, type FieldIssue } from '../hub/validateFields';

type Props = { intake: Intake; session: Api['SessionState']; disabled: boolean; onDirty: (dirty: boolean) => void;
  mutate: Mutate; directMutation: DirectMutation; selectedRevision?: Revision; readOnly?: boolean; onProcessed?: () => Promise<void>; onBackToUpload?: () => void; onStepChange?: (step: WorkflowStep) => void; configuration?: (actions?: ReactNode, content?: ReactNode) => ReactNode; backHost?: HTMLElement | null; mode?: 'workflow' | 'archive'; scrollOwner?: HTMLElement | null; operationPending?: (id: string) => boolean };
function profileDraft(revision: Revision) {
  return { SPREADING: profileValue(revision, 'SPREADING'), INTERNAL_OPERATOR_NAME: profileValue(revision, 'INTERNAL_OPERATOR_NAME'), reason: '' };
}
export function ResultPanel({ intake, session, disabled, onDirty, mutate, directMutation, selectedRevision, readOnly = false, onProcessed, onBackToUpload, onStepChange, configuration, backHost, mode = 'workflow', scrollOwner, operationPending }: Props) {
  const revision = selectedRevision ?? intake.revision!;
  const c = revision.case_id, r = revision.id;
  const archive = mode === 'archive';
  const draftKey = reviewDraftKey(session.user?.id ?? '', intake.intake.id);
  const confirmKey = `${draftKey}.confirm`;
  const [restoredDraft] = useState(() => archive || readOnly ? undefined : readReviewDraft(sessionStorage, draftKey));
  const [draftRevision, setDraftRevision] = useState(restoredDraft?.revisionId ?? r);
  const [pendingSave, setPendingSave] = useState<ReviewDraft['pending']>(restoredDraft?.pending);
  const [prefixMsisdn, setPrefixMsisdn] = useState(restoredDraft?.prefixMsisdn ?? false);
  const [prefixPrompt, setPrefixPrompt] = useState(false);
  const [applying, setApplying] = useState(false);
  const [labelRows, setLabelRows] = useState<Api['RecordState'][]>([]);
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelScanFailed, setLabelScanFailed] = useState(false);
  const [labelPrompt, setLabelPrompt] = useState(false);
  const [bulkLabels, setBulkLabels] = useState<Record<string, string>>();
  const [bulkLabelError, setBulkLabelError] = useState('');
  const labelScanKey = useRef(''), labelRequest = useRef(0);
  const stepKey = `dogtags.workflow.v2.${session.user?.id}.${r}`;
  const [step, setStep] = useState<WorkflowStep>(() => restoreWorkflowStep(sessionStorage.getItem(stepKey), sessionStorage.getItem(`dogtags.workflow.${session.user?.id}.${r}`), revision.state === 'APPROVED'));
  const [review, setReview] = useState<Api['ReviewState']>();
  const [artifacts, setArtifacts] = useState<Api['ArtifactSetState']>();
  const [approval, setApproval] = useState<Api['RevisionApprovalState']>();
  const [records, setRecords] = useState<Api['RecordPage']>();
  const [detail, setDetail] = useState<Api['RecordDetail']>();
  const [preview, setPreview] = useState<Api['ArtifactPreview']>();
  const [expandedPreview, setExpandedPreview] = useState(''), [previewError, setPreviewError] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [base, setBase] = useState<Revision>(revision);
  const [corrections, setCorrections] = useState<Correction[]>(restoredDraft?.corrections ?? []);
  const [rowSelections, setRowSelections] = useState<Api['RowSelectionInput'][]>(restoredDraft?.selections ?? []);
  const [expandedRecord, setExpandedRecord] = useState<string>();
  const [recordAnchor, setRecordAnchor] = useState(0);
  const [recordSort, setRecordSort] = useState<'source' | 'errors_first'>('source');
  const [profile, setProfile] = useState(() => restoredDraft?.profile ?? profileDraft(revision));
  const [editorDirty, setEditorDirty] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [focus, setFocus] = useState<string>();
  const [revisionReads, setRevisionReads] = useState(0);
  const [liveEdit, setLiveEdit] = useState<{ id: string; values: Record<string, string>; issues: FieldIssue[] }>();
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const draftProgress = useRef<ReviewDraft | undefined>(undefined);
  const previewRequest = useRef(0);
  const archivePreview = useRef<HTMLElement>(null);
  const stopArchiveScroll = useRef<(() => void) | undefined>(undefined);
  function focusArchivePreview() {
    stopArchiveScroll.current?.();
    const node = archivePreview.current;
    const owner = scrollOwner ?? document.scrollingElement as HTMLElement | null;
    if (!node || !owner) return;
    stopArchiveScroll.current = scrollToArchivePreview(owner, node);
  }
  useEffect(() => {
    if ((archive || step > 1) && expandedPreview && (preview || previewError)) focusArchivePreview();
    return () => stopArchiveScroll.current?.();
  }, [archive, step, expandedPreview, !!preview, !!previewError, scrollOwner]);
  const alive = useRef(true), request = useRef(0), previousRevision = useRef(r);
  const recordRequest = useRef(0);
  const isWhiteMav = revision.settings.operation === 'WHITEMAV';
  const [innNames, setInnNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    if (isWhiteMav && !archive) void api.whitemavInns().then(result => { if (active) setInnNames(Object.fromEntries(result.entries.map(item => [item.inn, item.company_name]))); }).catch(() => {});
    return () => { active = false; };
  }, [isWhiteMav, archive]);
  const isRepair = revision.settings.operation === 'REPAIR';
  const operatorGuard = isRepair && revision.settings.repair_role === 'NUMBERS' && object(revision.settings.output_spec).version === 'repair-output-v3';
  const role = repairRole(revision.settings.repair_role ?? intake.assessment?.result.repair_role);
  const profileFields = ['SPREADING', 'INTERNAL_OPERATOR_NAME'] as const;
  const changes = (isRepair || isWhiteMav ? [] : profileFields).filter(field => profile[field] !== profileValue(base, field));
  const editDirty = prefixMsisdn || !!corrections.length || !!rowSelections.length || editorDirty || !!profile.reason || !!changes.length;
  const dirty = editDirty;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const canEdit = !readOnly && !revision.settings.retry && (session.user?.permissions.includes('case.edit') ?? false);
  const canOverride = session.user?.permissions.includes('profile.override') ?? false;
  const canApprove = session.user?.permissions.includes('package.approve') ?? false;
  const stale = draftRevision !== r && dirty;
  const locked = disabled || loading || applying || downloading;
  const editLocked = locked || !!pendingSave || labelScanning;
  const mapping = mappingOf(intake.assessment?.result.mapping), reader = object(intake.assessment?.result.reader);
  const fields: readonly Correction['field'][] = useMemo(() => isRepair && role ? repairFields[role].filter(field => field !== 'MAV_OPERATOR_NAME' || role !== 'NUMBERS' || object(revision.settings.output_spec).version === 'repair-output-v3') : ['DELETE', 'WHITEMAV'].includes(String(revision.settings.operation)) ? ['MSISDN'] : hubFields, [isRepair, role, revision.settings.operation, revision.settings.output_spec]);
  const importOrder = ['DELETE', 'CLIENTS', 'DOGTAGS', 'NUMBERS'].filter(value => artifacts?.artifacts.some(item => item.role === value));
  const hasErrors = artifacts?.artifacts.some(item => item.role === 'ERRORS');
  const rowLabels: Record<string, string> = { ...dispositionLabels,
    ...(hasErrors ? { excluded_error: 'В файле ошибок', conflict: 'Конфликт: в файле ошибок' } : {}),
    agreed_skip: 'Обработана по STATUS' };
  const previewRecord = useCallback((id: string, values: Record<string, string>, issues: FieldIssue[]) => setLiveEdit({ id, values, issues }), []);
  const changesByRecord = useMemo(() => {
    const indexed = new Map<string, Correction[]>();
    for (const change of corrections) indexed.set(change.record_id, [...(indexed.get(change.record_id) ?? []), change]);
    return indexed;
  }, [corrections]);
  const rowCache = new Map<string, { values: Record<string, string>; issues: FieldIssue[]; changed: boolean }>();
  function stagedRow(row: Api['RecordState']) {
    const cached = rowCache.get(row.record_id);
    if (cached) return cached;
    const changes = changesByRecord.get(row.record_id) ?? [];
    const values = draftValues(row, changes, prefixMsisdn);
    const owned = row.issues ?? (detail?.record.record_id === row.record_id ? detail.issues : []);
    const prefixChanged = prefixMsisdn && values.MSISDN !== row.effective.MSISDN;
    const result = { values, issues: changes.length ? editedIssues(owned, row.effective, values, fields, role)
      : prefixChanged ? editedIssues(owned, row.effective, values, ['MSISDN'], role) : owned,
      changed: changes.length > 0 || prefixChanged };
    rowCache.set(row.record_id, result);
    return result;
  }
  function recordIssues(row: Api['RecordState']): FieldIssue[] {
    if (expandedRecord === row.record_id && liveEdit?.id === row.record_id) return liveEdit.issues;
    return stagedRow(row).issues;
  }
  function badField(row: Api['RecordState'], field: string) {
    return recordIssues(row).some(issue => issue.field === field && issue.scope !== 'warning');
  }
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { if (!archive) onStepChange?.(step); }, [archive, step, onStepChange]);
  useEffect(() => { if (!archive && previousRevision.current === r) sessionStorage.setItem(stepKey, String(step)); }, [archive, stepKey, step, r]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current; }; }, []);
  useEffect(() => {
    if (previousRevision.current !== r) { previousRevision.current = r; setPrefixPrompt(false); setLabelPrompt(false); setLabelRows([]); labelScanKey.current = ''; ++labelRequest.current; ++recordRequest.current; ++previewRequest.current; setExpandedRecord(undefined); setLiveEdit(undefined); setExpandedPreview(''); setStep(1); setPreview(undefined); setMessage(''); }
    const generation = ++request.current; ++previewRequest.current; setExpandedPreview(''); setLoading(true); setError(''); setRecordAnchor(0);
    void Promise.all([archive ? Promise.resolve(undefined) : api.review(c, r), api.artifacts(c, r), api.approval(c, r), archive ? Promise.resolve(undefined) : api.records(c, r, 0, recordSort)]).then(([v, a, p, rows]) => {
      if (!alive.current || generation !== request.current) return;
      setReview(v); setArtifacts(a); setApproval(p); setRecords(rows); setPreview(undefined);
      if (!dirtyRef.current) { setBase(revision); setDraftRevision(r); setProfile(profileDraft(revision)); setDetail(undefined); }
    }).catch(e => { if (alive.current && generation === request.current) setError(errorText(e)); }).finally(() => { if (alive.current && generation === request.current) setLoading(false); });
  }, [archive, c, r, revision.state, revisionReads]);
  useEffect(() => {
    if (archive && disabled) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function pollApproval() {
      try { const value = await api.approval(c, r); if (active) setApproval(value); }
      catch (e) { if (active) setError(errorText(e)); }
      if (active) timer = setTimeout(pollApproval, 2000);
    }
    timer = setTimeout(pollApproval, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [c, r, archive, archive && disabled]);
  function persistDraft(value: ReviewDraft) {
    draftProgress.current = value;
    try { sessionStorage.setItem(draftKey, JSON.stringify(value)); }
    catch { setError('Не удалось сохранить правки в сессии браузера. Изменения остаются в редакторе.'); return false; }
    setPrefixMsisdn(value.prefixMsisdn ?? false); setCorrections(value.corrections); setRowSelections(value.selections); setDraftRevision(value.revisionId); setPendingSave(value.pending);
    return true;
  }
  useEffect(() => {
    if (archive || readOnly || !pendingSave || draftRevision === r) return;
    let active = true;
    void api.operation(pendingSave.body.operation_id, pendingSave.action, c).then(receipt => {
      if (!active || receipt.status !== 'SUCCEEDED' || string(object(receipt.result?.revision).id) !== r) return;
      if (pendingSave.action === 'processing.save_start') { sessionStorage.removeItem(draftKey); setPrefixMsisdn(false); setCorrections([]); setRowSelections([]); setPendingSave(undefined); setDraftRevision(r); setProfile(profileDraft(revision)); }
      else persistDraft(remainingDraft({ revisionId: draftRevision, corrections, prefixMsisdn, selections: rowSelections, profile, pending: pendingSave }, pendingSave, r));
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [r, pendingSave?.body.operation_id]);
  useEffect(() => {
    if (archive || readOnly || loading || dirty || !['PREPARED', 'APPROVED'].includes(revision.state) || !artifacts?.available || !approval?.current || review?.summary?.blocking !== false) return;
    const operation = sessionStorage.getItem(confirmKey);
    if (!operation) return;
    let active = true;
    void api.operation(operation, 'processing.save_start', c).then(receipt => {
      if (active && receipt.status === 'SUCCEEDED' && string(object(receipt.result?.revision).id) === r) {
        sessionStorage.removeItem(confirmKey); setStep(2); setError('');
      }
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [archive, readOnly, r, revision.state, loading, dirty, artifacts?.available, approval?.current, review?.summary?.blocking]);
  const cleanupCount = Number(object(review?.summary?.issue_counts).msisdn_cleaned ?? 0);
  const prefixCount = msisdnPrefixCount(Number(object(review?.summary?.issue_counts).msisdn_country_prefix ?? 0), corrections);
  const prefixPromptKey = `${draftKey}.prefix-prompt.${r}`;
  useEffect(() => {
    if (!archive && step === 1 && !editLocked && !editorDirty && canEdit && !prefixMsisdn && fields.includes('MSISDN')
        && review?.revision_id === r && ['PREPARED', 'APPROVED'].includes(revision.state)
        && prefixCount > 0 && cleanupCount === 0
        && !sessionStorage.getItem(prefixPromptKey)) {
      sessionStorage.setItem(prefixPromptKey, 'shown'); setPrefixPrompt(true);
    }
  }, [archive, step, editLocked, editorDirty, canEdit, prefixMsisdn, fields, review, prefixPromptKey, prefixCount, cleanupCount, r, revision.state]);
  function confirmPrefix() {
    setPrefixPrompt(false);
    const draft = confirmMsisdnPrefix({ revisionId: draftRevision, corrections, selections: rowSelections, profile, prefixMsisdn });
    if (!persistDraft(draft)) return;
    setExpandedRecord(undefined); setDetail(undefined); setLiveEdit(undefined); setError('');
    setMessage('Добавление 7 ко всем номерам из 10 цифр сохранено в сессии. Файлы обновятся при переходе к подтверждению.');
  }
  async function read<T>(execute: () => Promise<T>, accept: (value: T) => void) {
    const generation = request.current; setError('');
    try { const value = await execute(); if (alive.current && generation === request.current) accept(value); }
    catch (e) { if (alive.current && generation === request.current) setError(errorText(e)); }
  }
  async function readPreview(artifactId: string, after?: number) {
    const generation = request.current, sequence = ++previewRequest.current;
    setExpandedPreview(artifactId); setPreview(undefined); setPreviewError('');
    try {
      const value = await api.preview(c, r, artifactId, after);
      if (alive.current && generation === request.current && sequence === previewRequest.current) setPreview(value);
    } catch (e) { if (alive.current && generation === request.current && sequence === previewRequest.current) setPreviewError(errorText(e)); }
  }
  function togglePreview(artifactId: string) {
    if (expandedPreview === artifactId && archive) { focusArchivePreview(); return; }
    if (expandedPreview === artifactId) { ++previewRequest.current; setExpandedPreview(''); }
    else void readPreview(artifactId);
  }
  function go(next: WorkflowStep) {
    if (editDirty) { setError('Сохраните изменения перед переходом.'); return; }
    if (next > 1 && (!artifacts?.available || !approval?.current || locked || review?.summary?.blocking !== false)) { setError('Дождитесь полной проверки и отделения ошибочных записей.'); return; }
    ++previewRequest.current; setStep(next); setExpandedPreview(''); setPreview(undefined); setMessage(''); setError('');
  }
  async function sortRecords(next: typeof recordSort) {
    if (locked || editorDirty || next === recordSort) return;
    const generation = ++request.current;
    ++recordRequest.current; setLoading(true); setError('');
    try {
      const page = await api.records(c, r, 0, next);
      if (!alive.current || generation !== request.current) return;
      setExpandedRecord(undefined); setLiveEdit(undefined); setDetail(undefined); setEditorDirty(false);
      setRecordAnchor(0); setRecordSort(next); setRecords(page);
    } catch (e) { if (alive.current && generation === request.current) setError(errorText(e)); }
    finally { if (alive.current && generation === request.current) setLoading(false); }
  }
  function openRecord(id: string, ordinal: number, field?: string, visible = false) {
    const changed = liveEdit && detail?.record.record_id === liveEdit.id
      ? fields.some(key => liveEdit.values[key] !== (draftValues(detail.record, corrections, prefixMsisdn)[key] ?? ''))
      : editorDirty;
    if (changed) { setError('Сохраните изменения текущей записи.'); return; }
    if (expandedRecord === id && !field) { ++recordRequest.current; setExpandedRecord(undefined); setLiveEdit(undefined); setDetail(undefined); setEditorDirty(false); setError(''); return; }
    if (step !== 1) setStep(1);
    const sequence = ++recordRequest.current;
    setExpandedRecord(id); setLiveEdit(undefined); setFocus(field); setDetail(undefined);
    if (!visible && !records?.items.some(row => row.record_id === id)) {
      if (recordSort !== 'source') setRecordSort('source');
      setRecordAnchor(ordinal - 1);
      void read(() => api.records(c, r, ordinal - 1), value => { if (sequence === recordRequest.current) setRecords(value); });
    }
    void read(() => api.record(c, r, id, ordinal), value => { if (sequence === recordRequest.current) setDetail(value); });
  }
  function isExcluded(row: Api['RecordState']) {
    return rowSelections.find(value => value.record_id === row.record_id)?.excluded ??
      boolean(object(object(base.settings.row_selections)[row.record_id]).excluded) ?? false;
  }
  function selectRow(row: Api['RecordState'], excluded: boolean) {
    const before = boolean(object(object(base.settings.row_selections)[row.record_id]).excluded) ?? false;
    const selections = [...rowSelections.filter(value => value.record_id !== row.record_id),
      ...(before === excluded ? [] : [{ record_id: row.record_id, ordinal: row.ordinal, before, excluded }])];
    persistDraft({ revisionId: draftRevision, corrections, prefixMsisdn, selections, profile, pending: pendingSave });
  }
  function discard() { sessionStorage.removeItem(draftKey); setPrefixMsisdn(false); setCorrections([]); setRowSelections([]); setEditorDirty(false); setExpandedRecord(undefined); setLiveEdit(undefined); setDetail(undefined); setBase(revision); setDraftRevision(r); setPendingSave(undefined); setProfile(profileDraft(revision)); onDirty(false); }
  async function save(recordChanges: Correction[] = []): Promise<boolean> {
    if (pendingSave || stale || (editorDirty && !recordChanges.length)) { setError('Сохраните изменения в открытом редакторе. Если версия изменилась, сверьте актуальные данные.'); return false; }
    if (!persistDraft({ revisionId: draftRevision, prefixMsisdn, corrections: mergeCorrections(corrections, recordChanges), selections: rowSelections, profile, pending: pendingSave })) return false;
    if (recordChanges.length) {
      const ids = new Set(recordChanges.map(change => change.record_id));
      setLabelRows(previous => [...new Map([...previous, ...(records?.items ?? []).filter(row => ids.has(row.record_id)), ...(detail && ids.has(detail.record.record_id) ? [detail.record] : [])].map(row => [row.record_id, row])).values()]);
    }
    setExpandedRecord(undefined); setDetail(undefined); setLiveEdit(undefined); setEditorDirty(false); setError('');
    setMessage('Изменения сохранены в сессии. Итоговые файлы обновятся при переходе к подтверждению.');
    return true;
  }
  async function prepareConfirmation() {
    if (locked || editorDirty || stale || !approval?.current) return;
    if (!dirty) { go(2); return; }
    if (changes.length && !profile.reason.trim()) { setError('Укажите основание изменения параметров.'); return; }
    const overrides: Override[] = changes.map(field => ({ field, before: profileValue(base, field), after: profile[field], reason: profile.reason }));
    setApplying(true); setError('');
    try {
      const applied = await applyReviewDraft({ revisionId: draftRevision, corrections, prefixMsisdn, selections: rowSelections, profile, pending: pendingSave }, base, overrides,
        async command => {
          if (command.action === 'processing.save_start') sessionStorage.setItem(confirmKey, command.body.operation_id);
          const accepted = await mutate(command);
          if (!accepted && operationPending && !operationPending(command.body.operation_id)) {
            if (draftProgress.current) persistDraft({ ...draftProgress.current, pending: undefined });
            sessionStorage.removeItem(confirmKey);
          }
          return accepted;
        }, async command => {
          const receipt = await api.operation(command.body.operation_id, command.action, c);
          const id = string(object(receipt.result?.revision).id);
          if (receipt.status !== 'SUCCEEDED' || !id) throw new Error('Сохранение ещё не подтверждено сервером. Правки сохранены в сессии.');
          return id;
        }, value => { if (!persistDraft(value)) throw new Error('Не удалось сохранить состояние правок в сессии.'); });
      if (applied) { discard(); setStep(1); await onProcessed?.(); setRevisionReads(value => value + 1); }
      else await onProcessed?.();
    } catch (e) { setError(errorText(e)); }
    finally { setApplying(false); }
  }
  async function approve() {
    if (!artifacts?.artifact_set_id || !artifacts.manifest_hash || dirty || locked || !approval?.current) return;
    if (await mutate({ action: 'package.approve', caseId: c, body: { operation_id: crypto.randomUUID(), expected_revision_id: r, manifest_hash: artifacts.manifest_hash } })) {
      setRevisionReads(value => value + 1); setStep(3);
    }
  }
  async function download(item: Api['ArtifactState'], chooseLocation = false) {
    if (!artifacts?.manifest_hash || !approval?.approved || !approval.current || dirty || locked) return;
    setDownloading(true); setMessage('');
    try {
      await read(() => api.download(c, r, item, artifacts.manifest_hash!, chooseLocation), result => setMessage(
        result.status === 'saved' ? `Файл «${result.filename}» сохранён в выбранном месте.`
          : result.status === 'cancelled' ? 'Сохранение отменено.' : `Файл ${artifactLabel(item.role)} передан браузеру для скачивания.`));
    } finally { setDownloading(false); }
  }
  const labelFields = useMemo(() => fields.filter(field => ['MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'MAV_LABEL'].includes(field)), [fields]);
  useEffect(() => {
    if (archive || step !== 1 || !canEdit || !labelFields.length) return;
    if (!['PREPARED', 'APPROVED', 'BLOCKED', 'NEEDS_REVIEW'].includes(revision.state)) {
      labelScanKey.current = ''; ++labelRequest.current; setLabelRows([]); setLabelScanning(false); return;
    }
    if (loading || disabled) return;
    const key = `${r}:${revision.state}:${revisionReads}`;
    if (labelScanKey.current === key) return;
    labelScanKey.current = key;
    const sequence = ++labelRequest.current;
    setLabelScanning(true); setLabelScanFailed(false);
    void (async () => {
      const found: Api['RecordState'][] = [];
      let after = 0;
      do {
        const page = await api.records(c, r, after, 'source');
        if (!alive.current || sequence !== labelRequest.current) return;
        for (const row of page.items) {
          if (validateFields(row.effective, labelFields).some(issue => issue.code === 'label_characters')) found.push(row);
        }
        if (page.next_cursor == null) break;
        after = page.next_cursor;
      } while (true);
      setLabelRows(found);
    })().catch(() => { if (alive.current && sequence === labelRequest.current) setLabelScanFailed(true); })
      .finally(() => { if (alive.current && sequence === labelRequest.current) setLabelScanning(false); });
  }, [archive, step, canEdit, labelFields, revision.state, r, c, revisionReads, loading, disabled]);
  const labelReview = useMemo(() => {
    const proposals: Correction[] = [];
    let errors = 0;
    const rows = new Map([...labelRows, ...(records?.items ?? [])].map(row => [row.record_id, row]));
    const affected = new Set<string>();
    for (const row of rows.values()) {
      if (isExcluded(row)) continue;
      const values = draftValues(row, changesByRecord.get(row.record_id) ?? []);
      const issues = validateFields(values, labelFields).filter(issue => issue.code === 'label_characters');
      errors += issues.length;
      if (issues.length) affected.add(row.record_id);
      for (const field of labelFields) {
        const after = suggestLabelCorrection(field, values[field] ?? '');
        if (after !== undefined) proposals.push({ record_id: row.record_id, ordinal: row.ordinal, field,
          before: row.effective[field] ?? '', after, reason: 'Подтверждено массовое исправление символов этикеток.' });
      }
    }
    return { errors, rows: affected.size, proposals };
  }, [labelRows, records, changesByRecord, labelFields, rowSelections, base.settings.row_selections]);
  const labelProposals = labelReview.proposals;
  const correctedLabelRows = useMemo(() => new Set([...revision.correction_overlay ?? [], ...corrections].flatMap(change => {
    const field = string(change.field), before = string(object(change).submitted_before) ?? string(change.before), after = string(change.after), id = string(change.record_id);
    return id && field && before !== undefined && after !== undefined && before !== after
      && validateFields({ [field]: before }, [field]).some(issue => issue.code === 'label_characters')
      && !validateFields({ [field]: after }, [field]).some(issue => issue.scope !== 'warning') ? [id] : [];
  })), [revision.correction_overlay, corrections]);
  async function applyBulkLabels() {
    if (!bulkLabels || editLocked || dirty || stale || !canEdit) return;
    const labels = Object.fromEntries(Object.entries(bulkLabels).map(([field, value]) => [field, value.trim()])
      .filter(([, value]) => value));
    if (!Object.keys(labels).length) return;
    const issues = validateFields(labels, Object.keys(labels)).filter(issue => issue.scope !== 'warning');
    if (issues.length) { setBulkLabelError(issues[0].message); return; }
    setApplying(true);
    try {
      const accepted = await mutate({ action: 'processing.save_start', caseId: c,
        body: { operation_id: crypto.randomUUID(), expected_revision_id: r,
          source_asset_id: revision.source.id, bulk_labels: labels } });
      if (accepted) {
        setBulkLabels(undefined);
        setStep(1);
        await onProcessed?.();
      }
    } catch (error) { setBulkLabelError(errorText(error)); }
    finally { setApplying(false); }
  }
  const counts = object(review?.summary?.counts), reconciliation = object(review?.summary?.reconciliation);
  const rowsTable = <div className="source-rows">
    {canEdit && labelFields.length > 0 && <div data-testid="label-correction-offer">
      {labelScanning ? <p role="status">Проверяем запрещённые символы во всех этикетках…</p>
        : labelScanFailed ? <Alert title="Не удалось проверить все этикетки" tone="warning"><Button disabled={editLocked || editorDirty} onClick={() => { labelScanKey.current = ''; setRevisionReads(value => value + 1); }}>Повторить проверку символов</Button></Alert>
        : labelReview.errors > 0 && <Alert title="Найдены запрещённые символы в этикетках" tone="warning"><p>Ошибок: {labelReview.errors}; строк: {labelReview.rows}. Можно исправить автоматически: {labelProposals.length}.</p>
          {labelProposals.length > 0 && <Button disabled={editLocked || editorDirty || stale} onClick={() => setLabelPrompt(true)}>Исправить все ошибки символов ({labelProposals.length})</Button>}
          {labelReview.errors > labelProposals.length && <p>Для остальных ошибок требуется ручное исправление: однозначная замена не найдена.</p>}
        </Alert>}
    </div>}
    {canEdit && labelFields.length > 0 && records?.items.length ? <div className="actions">
      <Button disabled={editLocked || dirty || stale || !approval?.current}
        onClick={() => { setBulkLabelError(''); setBulkLabels({}); }}>Задать этикетки для всех строк</Button>
      {dirty && <p>Сначала примените или отмените текущие правки.</p>}
    </div> : null}
    <Table caption="Результаты обработки данных" rows={records?.items ?? []} rowId={row => row.record_id} state={loading ? 'loading' : records?.items.length ? 'ready' : 'empty'} rowTone={row => recordIssues(row).some(issue => issue.scope !== 'warning') ? 'danger' : recordIssues(row).length ? 'warning' : undefined} columns={[
      { key: 'row', label: 'Строка', render: row => <div className="row-tools"><span className="row-ordinal">{row.ordinal}</span>{canEdit && <IconButton icon="edit" label={`Редактировать строку ${row.ordinal}`} aria-expanded={expandedRecord === row.record_id} aria-controls={`row-editor-${row.record_id}`} disabled={editLocked} onClick={() => openRecord(row.record_id, row.ordinal, undefined, true)} />}</div> },
      ...(canEdit ? [{ key: 'exclude', label: 'Исключить', render: (row: Api['RecordState']) => <label className="row-exclusion"><input type="checkbox" aria-label={`Исключить строку ${row.ordinal} из итоговых файлов`} checked={isExcluded(row)} disabled={editLocked || stale} onChange={event => selectRow(row, event.target.checked)} /></label> }] : []),
      ...fields.map(field => ({ key: field, label: fieldLabels[field], render: (row: Api['RecordPage']['items'][number]) => <span className={`${isExcluded(row) ? 'row-excluded' : ''} ${badField(row, field) ? 'repair-field-error' : recordIssues(row).some(issue => issue.field === field && issue.scope === 'warning') ? 'repair-field-warning' : ''} ${field === 'INN' || field === 'MSISDN' ? 'technical-data' : ''}`}>{expandedRecord === row.record_id && liveEdit?.id === row.record_id ? liveEdit.values[field] : String(stagedRow(row).values[field] ?? '')}</span> })),
      { key: 'errors', label: 'Ошибки и предупреждения', render: row => <div className="record-errors">{recordIssues(row).slice().sort((a, b) => fields.indexOf(a.field as Correction['field']) - fields.indexOf(b.field as Correction['field'])).map((issue, index) => <p className={issue.scope === 'warning' ? 'record-warning' : undefined} key={`${issue.field}-${issue.code}-${index}`}><strong>{fieldLabels[issue.field as Correction['field']] ?? (issue.field || 'Структура строки')}:</strong> {issue.scope === 'warning' && 'Предупреждение: '}{issue.message}{['global', 'warning'].includes(issue.scope ?? '') && editorDirty && liveEdit?.id === row.record_id && <span> Перепроверяется при переходе к подтверждению.</span>}</p>)}</div> },
      { key: 'outcome', label: 'Результат', render: row => <span className="row-outcome">{isExcluded(row) ? 'Исключена пользователем' : editorDirty && liveEdit?.id === row.record_id ? 'Изменения не сохранены' : correctedLabelRows.has(row.record_id) ? `Ошибка символов исправлена${recordIssues(row).some(issue => issue.scope !== 'warning') ? '; есть другие ошибки' : stagedRow(row).changed ? '; сохранено в сессии' : ''}` : stagedRow(row).changed ? 'Сохранена в сессии' : recordIssues(row).some(issue => issue.code === 'other_operator') ? 'ERROR OTHER OPERATOR' : rowLabels[row.disposition ?? ''] ?? 'Проверяется'}</span> },
    ]} renderExpansion={canEdit ? row => <Disclosure open={expandedRecord === row.record_id} id={`row-editor-${row.record_id}`}><div className="row-editor">{expandedRecord === row.record_id && detail?.record.record_id === row.record_id ? <RecordEditor compact prefixMsisdn={prefixMsisdn} key={`${detail.revision_id}-${detail.record.record_id}-${prefixMsisdn}`} detail={detail} columns={records?.columns ?? []} mapping={mapping} sourceSheet={string(reader.sheet)} pending={corrections} fields={fields} enabled={canEdit && !editLocked && !stale} focusField={focus} onDirty={setEditorDirty} onPreview={previewRecord} returnedRole={role} onSave={save} onStage={() => {}} onRepresentative={openRecord} /> : expandedRecord === row.record_id && <p role="status">Открываем строку…</p>}</div></Disclosure> : undefined}
      pagination={<Pagination key={`${r}-${revisionReads}-${revision.state}-${recordAnchor}-${recordSort}`} label="Результаты обработки данных" initialAfter={recordAnchor} next={records?.next_cursor} disabled={locked || editorDirty} toolbarActions={<label className="review-sort">Сортировка<Select aria-label="Сортировка записей" value={recordSort} disabled={locked || editorDirty} onChange={event => void sortRecords(event.target.value as typeof recordSort)}><option value="source">Как в исходнике</option><option value="errors_first">Сначала ошибки</option></Select></label>} toolbarAfter={canEdit && fields.includes('MSISDN') && prefixCount > 0 && !prefixMsisdn ? <Button disabled={editLocked || editorDirty || stale || prefixMsisdn} onClick={() => setPrefixPrompt(true)}>Добавить 7 к номерам</Button> : undefined} load={after => api.records(c, r, Number(after ?? 0), recordSort)} onLoad={value => { ++recordRequest.current; if (!editorDirty) { setExpandedRecord(undefined); setLiveEdit(undefined); } setRecords(value); }} />} />
  </div>;
  function previewContent(artifactId: string) {
    if (expandedPreview !== artifactId) return null;
    return preview ? <ArtifactPreview key={`${c}-${r}-${artifactId}`} preview={preview} archive={archive} disabled={locked || expandedPreview !== artifactId}
      load={after => api.preview(c, r, artifactId, Number(after ?? 0))} onLoad={value => { if (alive.current && expandedPreview === artifactId) setPreview(value); }} />
      : previewError ? <Alert title="Предпросмотр недоступен" tone="danger"><p>{previewError}</p><Button disabled={locked} onClick={() => void readPreview(artifactId)}>Повторить предпросмотр</Button></Alert>
      : <p role="status">Открываем предпросмотр…</p>;
  }
  const parametersAction = !isRepair && !isWhiteMav && <Button aria-expanded={parametersOpen} aria-controls="processing-parameters" disabled={editLocked} onClick={() => setParametersOpen(value => !value)}>Изменить параметры обработки</Button>;
  const parametersContent = !isRepair && !isWhiteMav && <Disclosure id="processing-parameters" open={parametersOpen}>{parametersOpen && <FormSection><FormGrid>{profileFields.map(field => <FormField key={field} id={`override-${field}`} label={field === 'SPREADING' ? 'SPREADING' : 'Внутреннее имя оператора'}>{props => <Input {...props} readOnly={!canOverride || editLocked} value={profile[field]} onChange={event => setProfile(previous => ({ ...previous, [field]: event.target.value }))} />}</FormField>)}</FormGrid><FormField id="override-reason" label="Основание изменения параметров">{props => <Textarea {...props} readOnly={!canOverride || editLocked} value={profile.reason} onChange={event => setProfile(previous => ({ ...previous, reason: event.target.value }))} />}</FormField></FormSection>}</Disclosure>;
  return <section className="hub-section workflow-result" data-testid="intake-result" aria-labelledby={archive ? undefined : 'result-title'} aria-label={archive ? 'Файлы обработки' : undefined}>
    {bulkLabels && <ConfirmDialog title="Задать этикетки для всех строк" busy={applying} destructive={false}
      confirmLabel="Применить ко всем строкам" onConfirm={() => void applyBulkLabels()} onCancel={() => setBulkLabels(undefined)}>
      <p>Заполните одну или обе этикетки. Заполненные значения заменят соответствующие этикетки во всём файле, после чего комплект будет пересобран.</p>
      <FormGrid>{labelFields.map(field => <FormField key={field} id={`bulk-${field}`} label={fieldLabels[field]}>
        {props => <Input {...props} maxLength={32} value={bulkLabels[field] ?? ''} readOnly={applying}
          onChange={event => { setBulkLabelError(''); setBulkLabels({ ...bulkLabels, [field]: event.target.value }); }} />}
      </FormField>)}</FormGrid>
      {bulkLabelError && <p role="alert">{bulkLabelError}</p>}
    </ConfirmDialog>}
    {labelPrompt && labelProposals.length > 0 && <ConfirmDialog title="Применить замены во всех этикетках?" busy={false} destructive={false} confirmLabel="Применить все замены" onConfirm={() => { void save(labelProposals).then(saved => { if (saved) setLabelPrompt(false); }); }} onCancel={() => setLabelPrompt(false)}><p>Будет исправлено полей: {labelProposals.length}; строк: {new Set(labelProposals.map(change => change.record_id)).size}. Кавычки и запрещённые знаки удаляются, варианты тире заменяются дефисом, кириллические двойники в латинской этикетке — латинскими буквами. Неоднозначные буквы и пустые этикетки требуют ручного решения.</p>{labelProposals.slice(0, 8).map(change => <p key={`${change.record_id}-${change.field}`}>Строка {change.ordinal}, {fieldLabels[change.field]}: «{changesByRecord.get(change.record_id)?.find(existing => existing.field === change.field)?.after ?? change.before}» → «{change.after}»</p>)}{labelProposals.length > 8 && <p>Показаны первые 8 замен. Будут применены все {labelProposals.length}.</p>}<p>Правки сохранятся в сессии; итоговые файлы обновятся при переходе к подтверждению.</p></ConfirmDialog>}
    <MsisdnCleanupNotice key={r} caseId={c} revisionId={r} count={cleanupCount} autoOpen={!archive && step === 1 && !loading && !prefixPrompt} />
    {prefixPrompt && <ConfirmDialog title="Добавить цифру 7 в начало всех номеров из 10 цифр?" busy={false} destructive={false} confirmLabel="Подтвердить" onConfirm={confirmPrefix} onCancel={() => setPrefixPrompt(false)}><p>Найдено номеров с 10 цифрами: {prefixCount.toLocaleString('ru-RU')}.</p></ConfirmDialog>}
    {!archive && backHost && createPortal(<IconButton icon="back" label="Вернуться назад" disabled={locked || dirty} onClick={() => step === 1 ? onBackToUpload?.() : go((step - 1) as WorkflowStep)} />, backHost)}
    {!archive && step === 1 && (configuration ? configuration(parametersAction, parametersContent) : <><div className="actions">{parametersAction}</div>{parametersContent}</>)}
    {!archive && <h2 id="result-title">{['','Проверьте результаты обработки','Подтверждение комплекта','Скачайте готовые файлы'][step]}</h2>}
    {!archive && step === 3 && <Alert title="Исходный файл сохранён в архиве" tone="info"><p>Файл «{intake.source.filename}» доступен в разделе «Архив». Там можно вернуться к нему и повторить обработку.</p></Alert>}
    {loading && <p role="status">Получаем результаты обработки…</p>}
    {error && <Alert title="Не удалось выполнить действие" tone="danger"><p>{error}</p><Button disabled={locked || dirty} onClick={() => { if (!dirtyRef.current) setRevisionReads(value => value + 1); }}>Обновить результат</Button></Alert>}
    {!archive && (step === 1 || step === 2) && <>
      <p data-testid="preparation-status">{approval?.approved ? 'Комплект подтверждён' : artifacts?.available ? 'Файлы подготовлены' : ['BLOCKED', 'NEEDS_REVIEW'].includes(revision.state) ? 'Есть ошибки, которые необходимо исправить' : 'Идёт подготовка файлов'}</p>
      {review?.summary && <><p data-testid="coverage">{boolean(reconciliation.complete) ? 'Все строки исходного файла учтены.' : 'Не все строки учтены. Проверьте ошибки перед подтверждением.'}</p><div className="workflow-counts">{Object.entries(counts).filter(([, value]) => typeof value === 'number').map(([key, value]) => <span key={key}>{reviewCountLabels[key] ?? key}: <strong>{String(value)}</strong></span>)}</div></>}
      {isRepair && <><p>Проверены все строки, в том числе с пустым STATUS. В основной файл попадают только корректные строки; точные дубли включаются один раз.</p><p>Известные сообщения STATUS могут пропускать строку, формировать CLIENTS для отсутствующего клиента или DELETE для уже существующего номера. Корректный ключ может попасть в CLIENTS или DELETE, даже если другие поля той же строки вынесены в отчёт об ошибках.</p>{operatorGuard && <p>DELETE формируется только для оператора mTELE2. Строки остальных операторов сохранены в ERROR OTHER OPERATOR.</p>}<div className="workflow-counts">{Object.entries(object(review?.summary?.dispositions)).filter(([, value]) => typeof value === 'number').map(([key, value]) => <span key={key}>{reviewCountLabels[key] ?? key}: <strong>{String(value)}</strong></span>)}</div></>}
      <ScientificExclusions summary={review?.summary ?? undefined} />
      {Array.isArray(review?.summary?.file_errors) && review.summary.file_errors.length > 0 && <Alert title="Ошибки исходного файла" tone="danger"><ul>{review.summary.file_errors.map((value, index) => <li key={index}>{string(object(value).message) ?? 'Проверьте структуру исходного файла.'}</li>)}</ul></Alert>}
    </>}
    {!archive && step === 1 && <>
      <p>Отметьте ненужные строки в колонке «Исключить». Для редактирования нажмите на карандаш рядом с номером строки.</p>
      {rowsTable}
    </>}
    {!archive && step === 1 && <>
      <div className="actions">{(rowSelections.length > 0 || changes.length > 0) && <Button disabled={editLocked || editorDirty || stale || !canEdit} onClick={() => void save()}>Сохранить</Button>}<Button variant="primary" disabled={locked || editorDirty || stale || !approval?.current || (!dirty && (!artifacts?.available || review?.summary?.blocking !== false))} onClick={() => void prepareConfirmation()}>Перейти к подтверждению</Button></div>
    </>}
    {archive && !loading && !error && !artifacts?.available && <p role="status">Выходные файлы пока недоступны. {revision.state === 'APPROVED' || revision.state === 'PREPARED' ? 'Для этой обработки нет сформированных файлов.' : 'Обработка ещё не завершена.'}</p>}
    {(archive || step === 2 || step === 3) && artifacts?.available && <>
      {!archive && isWhiteMav && <p>WhiteMAV: ИНН {string(revision.settings.whitemav_inn) ?? '7743895280'} — {innNames[string(revision.settings.whitemav_inn) ?? '7743895280'] || 'Название не указано'}; оператор whiteMAV; IS_MAV 1; IS_KSS 0; SPREADING 0; этикетка пустая.</p>}
      {!archive && !isRepair && !isWhiteMav && <p>Параметры комплекта: SPREADING {profileValue(revision, 'SPREADING')}; оператор {profileValue(revision, 'INTERNAL_OPERATOR_NAME')}.</p>}
      {!archive && <p data-testid="application-order">{importOrder.length ? `Порядок загрузки: ${importOrder.join(' → ')}.` : 'В комплекте только отчёт об ошибках. Файлов для загрузки в базу нет.'}</p>}
      {hasErrors && <Alert title={archive ? 'В файле есть ошибки' : 'Строки с ошибками'} tone={archive ? 'danger' : 'warning'}>{!archive && <p>Строки с ошибками — диагностический CSV в UTF-8. Не загружайте его в базу.</p>}<p>Платформа отделила ошибочные записи от основного результата. Их данные и причины ошибок сохранены в отдельном файле.</p></Alert>}
      <section className="archive-output-block" aria-labelledby="archive-outputs-title">
        <h2 id="archive-outputs-title">Выходные файлы</h2>
        {(archive || step === 3) && <p className="secondary-text">{canChooseDownloadLocation() ? 'Нажмите «Сохранить как…», чтобы выбрать папку и имя файла.' : 'Для выбора папки включите в настройках браузера запрос места сохранения каждого файла.'}</p>}
        <ul className="archive-artifact-list">{artifacts.artifacts.map(row => <li key={row.id}>
          <div className="archive-artifact-name"><strong>{artifactLabel(row.role)}</strong><span title={row.download_filename}>{row.download_filename}</span><span className="secondary-text">{row.row_count == null ? 'Комплект' : `${row.row_count} строк`}</span></div>
          <div className="actions">{row.role !== 'ZIP' && <IconButton icon="eye" label={`Предпросмотр ${artifactLabel(row.role)}`} aria-expanded={expandedPreview === row.id} aria-controls={`preview-${row.id}`} disabled={locked} onClick={() => togglePreview(row.id)} />}
            {(archive || step === 3) && <><IconButton icon="download" label={row.role === 'ZIP' ? 'Скачать комплект' : `Скачать ${artifactLabel(row.role)}`} disabled={locked || dirty || !canApprove || !approval?.approved || !approval.current} onClick={() => void download(row)} /><SaveAsButton label={`Сохранить ${artifactLabel(row.role)} как…`} disabled={locked || dirty || !canApprove || !approval?.approved || !approval.current} onSave={chooseLocation => void download(row, chooseLocation)} /></>}</div>
        </li>)}</ul>
      </section>
      {expandedPreview && <section ref={archivePreview} tabIndex={-1} className="archive-preview-block" id={`preview-${expandedPreview}`} aria-label="Содержимое файла">
        <h2>Предпросмотр «{artifacts.artifacts.find(row => row.id === expandedPreview)?.download_filename ?? (preview ? artifactLabel(preview.role) : 'файл')}»</h2>{previewContent(expandedPreview)}
      </section>}

      {!archive && step === 2 && <><p>Проверьте файлы. После подтверждения будет доступно скачивание.</p><div className="actions">{approval?.approved ? <Button variant="primary" disabled={locked || !approval.current} onClick={() => go(3)}>Перейти к скачиванию</Button> : <Button variant="primary" disabled={locked || dirty || !canApprove || !approval?.current} onClick={() => void approve()}>Подтвердить комплект</Button>}</div></>}
    </>}
    {!archive && approval && !approval.current && step > 1 && <Alert title="Данные изменились" tone="warning"><p>Проверьте актуальный результат перед подтверждением и скачиванием.</p><Button disabled={dirty || locked} onClick={() => go(1)}>Вернуться к проверке</Button></Alert>}
    {message && <Alert title={step === 1 ? 'Изменения' : 'Скачивание'}><p>{message}</p></Alert>}
    {!archive && step === 3 && <p data-testid="preparation-status">Комплект подтверждён</p>}
    {!archive && step === 3 && approval?.approved && approval.current && createPortal(<aside className="completion-toast" aria-label="Обработка завершена"><Alert title="Обработка завершена"><p role="status">Файлы готовы. Можно перейти к загрузке следующего файла.</p><Button variant="primary" disabled={locked || dirty} onClick={onBackToUpload}>Завершить</Button></Alert></aside>, document.body)}
  </section>;
}
