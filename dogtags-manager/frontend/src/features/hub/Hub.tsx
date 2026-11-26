import { appPath } from '../../reporting';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, boolean, canChooseDownloadLocation, number, object, readSession, string, type Api, type Correction, type Override, type Revision } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { SaveAsButton } from '../../components/SaveAsButton';
import { Input, Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { StatusBadge } from '../../components/StatusBadge';
import { StepHeader } from '../../components/StepHeader';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { RecordEditor } from './RecordEditor';
import { ScientificExclusions } from './ScientificExclusions';
import { dispositionLabels, errorText, failure, fieldLabels, loading, profileValue, ready, statusFor, time, type Remote } from './model';
import './hub.css';

type Pending = {
  id: string; action: string; caseId: string | null; epoch: number;
  status: 'unknown' | 'RUNNING' | 'FAILED';
  execute: (csrf: string, id: string) => Promise<Api['OperationState']>;
};
type ProfileDraft = { SPREADING: string; INTERNAL_OPERATOR_NAME: string; reason: string };
const noProfile: ProfileDraft = { SPREADING: '0', INTERNAL_OPERATOR_NAME: 'hubRTK', reason: '' };
const profileFields = ['SPREADING', 'INTERNAL_OPERATOR_NAME'] as const;
const steps = [
  { id: 'source', label: 'Источник' }, { id: 'config', label: 'Настройка' },
  { id: 'checks', label: 'Проверки' }, { id: 'files', label: 'Файлы и сверка' }, { id: 'approval', label: 'Подтверждение' },
];

function pageState<T>(remote: Remote<T>, count: number) {
  return remote.state === 'error' ? 'error' : remote.state === 'loading' ? 'loading' : count ? 'ready' : 'empty';
}

function Pager({ next, after, onPage, busy }: { next: number | string | null | undefined; after: number | string; onPage: (cursor: number | string) => Promise<unknown>; busy: boolean }) {
  return <Pagination loadManagesState label="Данные" next={next} disabled={busy} load={cursor => onPage(cursor ?? (typeof after === 'number' ? 0 : ''))} onLoad={() => {}} />;
}

export function Hub() {
  const [session, setSession] = useState<Api['SessionState']>();
  const [sessionLoading, setSessionLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const owner = useRef<string | undefined>(undefined);
  const epoch = useRef(0);
  const reads = useRef({ cases: 0, records: 0, issues: 0, detail: 0, preview: 0, evidence: 0 });
  const busyRef = useRef(false);
  const pendingRef = useRef<Pending | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [errorStatus, setErrorStatus] = useState(0);
  const errorBox = useRef<HTMLDivElement>(null);
  const [cases, setCases] = useState<Remote<Api['CasePage']>>(loading());
  const [caseCursor, setCaseCursor] = useState('');
  const [currentCase, setCase] = useState<Api['CaseState']>();
  const [revision, setRevision] = useState<Revision>();
  const [caseLoading, setCaseLoading] = useState(false);
  const caseLoadingRef = useRef(false);
  const [file, setFile] = useState<File>();
  const [fileKey, setFileKey] = useState(0);
  const [encoding, setEncoding] = useState<'utf-8' | 'cp1251'>('utf-8');
  const [profile, setProfile] = useState<ProfileDraft>(noProfile);
  const [draftBase, setDraftBase] = useState<Revision>();
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [editorDirty, setEditorDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editorDirtyRef = useRef(false);
  const updateEditorDirty = useCallback((value: boolean) => {
    editorDirtyRef.current = value;
    if (value) dirtyRef.current = true;
    setEditorDirty(value);
  }, []);
  const [detail, setDetail] = useState<Remote<Api['RecordDetail']>>();
  const [focusField, setFocusField] = useState<string>();
  const [review, setReview] = useState<Remote<Api['ReviewState']>>(loading());
  const [records, setRecords] = useState<Remote<Api['RecordPage']>>(loading());
  const [issues, setIssues] = useState<Remote<Api['IssuePage']>>(loading());
  const [artifacts, setArtifacts] = useState<Remote<Api['ArtifactSetState']>>(loading());
  const [approval, setApproval] = useState<Remote<Api['RevisionApprovalState']>>(loading());
  const [job, setJob] = useState<Api['ProcessingState']>();
  const [pollError, setPollError] = useState('');
  const [recordCursor, setRecordCursor] = useState(0);
  const [issueCursor, setIssueCursor] = useState(0);
  const [preview, setPreview] = useState<Remote<Api['ArtifactPreview']>>();
  const [previewId, setPreviewId] = useState('');
  const [previewCursor, setPreviewCursor] = useState(0);
  const [evidence, setEvidence] = useState<Record<string, Remote<Api['DownloadEvidenceState']>>>({});
  const [received, setReceived] = useState<string>();
  const authenticated = session?.authenticated === true;
  const canEdit = authenticated && (session.user?.permissions.includes('case.edit') ?? false);
  const canOverride = authenticated && (session.user?.permissions.includes('profile.override') ?? false);
  const canApprove = authenticated && (session.user?.permissions.includes('package.approve') ?? false);
  const profileChanges = draftBase ? profileFields.filter(field => profile[field] !== profileValue(draftBase, field)).map(field => ({ field, before: profileValue(draftBase, field), after: profile[field] })) : [];
  const profileChanged = profileChanges.length > 0;
  const dirty = !!file || profileChanged || profile.reason !== '' || corrections.length > 0 || editorDirty;
  dirtyRef.current = dirty;
  editorDirtyRef.current = editorDirty;
  const active = job?.state === 'QUEUED' || job?.state === 'PROCESSING';
  const state = job && revision && job.revision_id === revision.id ? job.state : review.data?.state ?? revision?.state ?? 'DRAFT';
  const structuralIssues = object(review.data?.summary?.issue_counts);
  const shapeRequiresReplacement = (number(structuralIssues.row_shape) ?? 0) > 0 || (number(structuralIssues.unsupported_schema) ?? 0) > 0;
  const sourceValid = revision?.source.inspection.schema_supported && revision.source.inspection.records_count != null && revision.source.inspection.records_count > 0 && revision.source.inspection.errors.length === 0 && !shapeRequiresReplacement;

  function showError(value: unknown, focus = true) {
    const e = failure(value); setError(errorText(e)); setErrorStatus(e.status);
    if (focus) requestAnimationFrame(() => errorBox.current?.focus());
    if (e.status === 401) {
      setSession(undefined); setSessionLoading(true);
      void readSession().then(setSession).catch(challenge => { setError(errorText(challenge)); }).finally(() => setSessionLoading(false));
    }
  }
  function resetDraft(value?: Revision) {
    dirtyRef.current = false; editorDirtyRef.current = false;
    setDraftBase(value); setCorrections([]); setEditorDirty(false); setDetail(undefined);
    setProfile(value ? { SPREADING: profileValue(value, 'SPREADING'), INTERNAL_OPERATOR_NAME: profileValue(value, 'INTERNAL_OPERATOR_NAME'), reason: '' } : noProfile);
    setFile(undefined); setFileKey(key => key + 1);
  }
  function clearPrivateState() {
    caseLoadingRef.current = false; setCaseLoading(false);
    epoch.current++; ++reads.current.cases; setCases(loading()); setCaseCursor(''); setCase(undefined); setRevision(undefined); resetDraft(); setJob(undefined);
    setReview(loading()); setRecords(loading()); setIssues(loading()); setArtifacts(loading()); setApproval(loading());
    setPreview(undefined); setEvidence({}); setReceived(undefined); setError('');
    pendingRef.current = undefined; setPending(undefined); history.replaceState(null, '', appPath());
  }
  async function loadCases(after = '') {
    const request = ++reads.current.cases, user = owner.current; setCases(loading()); setCaseCursor(after);
    try { const data = await api.cases(after || undefined); if (user === owner.current && request === reads.current.cases) setCases(ready(data)); }
    catch (e) { if (user === owner.current && request === reads.current.cases) { setCases({ state: 'error', error: errorText(e) }); showError(e, false); } return false; }
  }
  async function loadEvidence(c: string, r: string, list: readonly Api['ArtifactState'][], scope: number) {
    const request = ++reads.current.evidence;
    const results = await Promise.allSettled(list.map(item => api.evidence(c, r, item.id)));
    if (scope !== epoch.current || request !== reads.current.evidence) return;
    const values: Record<string, Remote<Api['DownloadEvidenceState']>> = {};
    results.forEach((result, index) => { values[list[index].id] = result.status === 'fulfilled' ? ready(result.value) : { state: 'error', error: errorText(result.reason) }; });
    setEvidence(values);
  }
  async function loadBundle(c: string, value: Revision, scope: number) {
    const recordRequest = ++reads.current.records, issueRequest = ++reads.current.issues;
    ++reads.current.preview;
    setReview(loading()); setRecords(loading()); setIssues(loading()); setArtifacts(loading()); setApproval(loading());
    setRecordCursor(0); setIssueCursor(0); setPreview(undefined); setPreviewId(''); setEvidence({});
    const result = await Promise.allSettled([api.review(c, value.id), api.records(c, value.id), api.issues(c, value.id), api.artifacts(c, value.id), api.approval(c, value.id)]);
    if (scope !== epoch.current) return;
    const [v, rs, is, as, ap] = result;
    setReview(v.status === 'fulfilled' ? ready(v.value) : { state: 'error', error: errorText(v.reason) });
    if (recordRequest === reads.current.records) setRecords(rs.status === 'fulfilled' ? ready(rs.value) : { state: 'error', error: errorText(rs.reason) });
    if (issueRequest === reads.current.issues) setIssues(is.status === 'fulfilled' ? ready(is.value) : { state: 'error', error: errorText(is.reason) });
    setArtifacts(as.status === 'fulfilled' ? ready(as.value) : { state: 'error', error: errorText(as.reason) });
    setApproval(ap.status === 'fulfilled' ? ready(ap.value) : { state: 'error', error: errorText(ap.reason) });
    if (as.status === 'fulfilled' && as.value.available) void loadEvidence(c, value.id, as.value.artifacts, scope);
    const rejected = result.find(item => item.status === 'rejected');
    if (rejected?.status === 'rejected') showError(rejected.reason, false);
    if (value.run_id) {
      try { const j = await api.job(c, value.run_id); if (scope === epoch.current) { setJob(j); setPollError(''); } }
      catch (e) { if (scope === epoch.current) { setPollError(errorText(e)); showError(e, false); } }
    } else setJob(undefined);
  }
  async function openCase(id: string, preserveDraft = false) {
    if (caseLoadingRef.current || busyRef.current || pendingRef.current) return;
    function draftBlocksRead() {
      if (editorDirtyRef.current) { setError('Ввод текущей записи не сохранён. Добавьте его в черновик или явно отмените перед перечитыванием заявки.'); setErrorStatus(409); return true; }
      if ((!preserveDraft || id !== currentCase?.id) && dirtyRef.current) { setError('Несохранённый ввод сохранён в браузере. Сохраните или явно отмените его перед открытием другой заявки.'); setErrorStatus(409); return true; }
      return false;
    }
    if (draftBlocksRead()) return;
    const scope = ++epoch.current; caseLoadingRef.current = true; setCaseLoading(true); setError(''); setJob(undefined); setPollError('');
    try {
      const data = await api.case(id);
      if (scope !== epoch.current) return;
      // A queued input can arrive after the controls became read-only. Read the
      // latest draft here before changing the case or discarding record detail.
      if (draftBlocksRead()) { setJob(job); return; }
      setCase(data); setRevision(data.revision ?? undefined);
      history.replaceState(null, '', appPath(`?case=${encodeURIComponent(data.id)}`));
      if (!preserveDraft || !dirtyRef.current) resetDraft(data.revision ?? undefined);
      else { setDetail(undefined); setEditorDirty(false); }
      if (data.revision) await loadBundle(id, data.revision, scope);
      else { setRecords(loading()); setIssues(loading()); setReview(loading()); setArtifacts(loading()); setApproval(loading()); }
    } catch (e) { if (scope === epoch.current) showError(e); }
    finally { if (scope === epoch.current) { caseLoadingRef.current = false; setCaseLoading(false); } }
  }

  useEffect(() => {
    let live = true;
    void readSession().then(value => {
      if (!live) return; setSession(value);
      if (value.user) owner.current = value.user.id;
    }).catch(e => { if (live) showError(e, false); }).finally(() => { if (live) setSessionLoading(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    void loadCases();
    const saved = new URLSearchParams(location.search).get('case');
    if (!currentCase && saved && /^[0-9a-f-]{36}$/.test(saved)) void openCase(saved);
  }, [authenticated]);
  useEffect(() => {
    if (!active || !currentCase || !revision || !job || !authenticated || pollError) return;
    const c = currentCase.id, r = revision.id, id = job.id, scope = epoch.current;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.job(c, id);
        if (!live || scope !== epoch.current) return;
        setMessage(result.state === 'QUEUED' ? 'Обработка ожидает запуска.' : result.state === 'PROCESSING' ? 'Выполняется обработка сохранённой ревизии.' : 'Обработка завершена. Результат получен от сервера.');
        if (result.state === 'QUEUED' || result.state === 'PROCESSING') { setJob(result); timer = setTimeout(poll, 1000); }
        else {
          // A mutation owns the next revision transition. Do not invalidate its
          // receipt with a concurrent terminal-job refresh.
          if (busyRef.current || pendingRef.current) { timer = setTimeout(poll, 1000); return; }
          const value = await api.revision(c, r);
          if (!live || scope !== epoch.current) return;
          const completedScope = ++epoch.current;
          setJob(result); setRevision(value); await loadBundle(c, value, completedScope);
        }
      } catch (e) { if (live && scope === epoch.current) { setPollError(errorText(e)); showError(e, false); } }
    };
    timer = setTimeout(poll, 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [active, job?.id, authenticated, pollError]);

  async function signIn() {
    if (busyRef.current || !session?.csrf_token) return;
    busyRef.current = true; setBusy('login'); setError('');
    try {
      const value = await api.login(session.csrf_token, username, password);
      if (owner.current && value.user?.id !== owner.current) clearPrivateState();
      owner.current = value.user?.id; setSession(value); setPassword(''); setMessage('Вход выполнен. Несохранённый ввод той же учётной записи сохранён.');
    } catch (e) { showError(e); }
    finally { busyRef.current = false; setBusy(''); }
  }
  async function signOut() {
    if (busyRef.current || !session) return;
    busyRef.current = true; setBusy('logout');
    try { await api.logout(session.csrf_token); setSession(undefined); setSessionLoading(true); setSession(await readSession()); }
    catch (e) { showError(e); }
    finally { busyRef.current = false; setBusy(''); setSessionLoading(false); }
  }
  async function acceptOperation(receipt: Api['OperationState'], action: Pending) {
    if (action.epoch !== epoch.current) return;
    if (receipt.status !== 'SUCCEEDED') {
      const next = { ...action, status: receipt.status }; pendingRef.current = next; setPending(next);
      if (receipt.error) { setError(`${receipt.error.message} (${receipt.error.code})`); setErrorStatus(receipt.error.status); }
      else setMessage('Операция ещё не завершена. Результат не подтверждён.');
      return;
    }
    pendingRef.current = undefined; setPending(undefined);
    const result = receipt.result;
    if (result?.case) {
      ++epoch.current;
      setCase(result.case); setRevision(undefined); resetDraft(); history.replaceState(null, '', appPath(`?case=${result.case.id}`)); void loadCases();
    }
    if (result?.revision && action.caseId) {
      const revisionScope = ++epoch.current;
      setRevision(result.revision); setCase(previous => previous && ({ ...previous, head_revision_id: result.revision!.id }));
      resetDraft(result.revision); setReceived(undefined); await loadBundle(action.caseId, result.revision, revisionScope);
    }
    const buildJob = result?.job;
    if (buildJob?.revision_id) {
      setJob(buildJob); setPollError('');
      setRevision(previous => previous && previous.id === buildJob.revision_id ? { ...previous, state: buildJob.state, run_id: buildJob.id } : previous);
    }
    if (result?.approval && action.caseId && revision) {
      const [value, decision] = await Promise.all([api.revision(action.caseId, revision.id), api.approval(action.caseId, revision.id)]);
      if (action.epoch === epoch.current) { ++epoch.current; setRevision(value); setApproval(ready(decision)); setJob(previous => previous && ({ ...previous, state: value.state })); setReview(previous => previous.data ? ready({ ...previous.data, state: value.state }) : previous); }
    }
    setError(''); setMessage('Операция сохранена сервером.');
  }
  async function mutate(actionName: string, caseId: string | null, execute: Pending['execute']) {
    if (caseLoadingRef.current || busyRef.current || pendingRef.current || !session?.authenticated) return;
    const action: Pending = { id: crypto.randomUUID(), action: actionName, caseId, execute, epoch: epoch.current, status: 'unknown' };
    busyRef.current = true; pendingRef.current = action; setPending(action); setBusy(actionName); setError('');
    try { await acceptOperation(await execute(session.csrf_token, action.id), action); }
    catch (e) {
      if (action.epoch === epoch.current) {
        const knownFailure = failure(e).status > 0 && failure(e).status < 500;
        if (knownFailure) { pendingRef.current = undefined; setPending(undefined); }
        showError(e);
      }
    } finally { busyRef.current = false; setBusy(''); }
  }
  async function recover(repeat = false) {
    const action = pendingRef.current;
    if (!action || caseLoadingRef.current || busyRef.current || !session?.authenticated) return;
    busyRef.current = true; setBusy('recover'); setError('');
    try {
      const receipt = repeat ? await action.execute(session.csrf_token, action.id) : await api.operation(action.id, action.action, action.caseId);
      await acceptOperation(receipt, action);
    } catch (e) { showError(e); }
    finally { busyRef.current = false; setBusy(''); }
  }
  function save(start: boolean) {
    if (caseLoadingRef.current || !currentCase || !revision || !draftBase) return;
    if (editorDirty) { setError('Добавьте исправления записи в черновик или отмените её ввод.'); return; }
    if (profileChanged && !profile.reason.trim()) { setError('Укажите основание переопределения профиля.'); document.getElementById('override-reason')?.focus(); return; }
    const overrides: Override[] = profileChanges.map(change => ({ ...change, reason: profile.reason }));
    const c = currentCase.id;
    const body = { expected_revision_id: draftBase.id, source_asset_id: draftBase.source.id, corrections, overrides };
    void mutate(start ? 'processing.save_start' : 'revision.save', c, (csrf, id) => api.save(csrf, c, { ...body, operation_id: id }, start));
  }
  async function openRecord(id: string, ordinal: number, field?: string) {
    if (caseLoadingRef.current || !currentCase || !revision) return;
    if (editorDirtyRef.current) { setError('Ввод текущей записи не сохранён. Добавьте его в черновик или явно отмените.'); return; }
    const scope = epoch.current, request = ++reads.current.detail, c = currentCase.id, r = revision.id; setDetail(loading()); setFocusField(field);
    try { const result = await api.record(c, r, id, ordinal); if (scope === epoch.current && request === reads.current.detail) setDetail(ready(result)); }
    catch (e) { if (scope === epoch.current && request === reads.current.detail) { setDetail({ state: 'error', error: errorText(e) }); showError(e); } }
  }
  async function recordPage(after: number) {
    if (caseLoadingRef.current || !currentCase || !revision) return;
    const scope = epoch.current, request = ++reads.current.records; setRecords(loading()); setRecordCursor(after);
    try { const value = await api.records(currentCase.id, revision.id, after); if (scope === epoch.current && request === reads.current.records) setRecords(ready(value)); }
    catch (e) { if (scope === epoch.current && request === reads.current.records) { setRecords({ state: 'error', error: errorText(e) }); showError(e, false); } return false; }
  }
  async function issuePage(after: number) {
    if (caseLoadingRef.current || !currentCase || !revision) return;
    const scope = epoch.current, request = ++reads.current.issues; setIssues(loading()); setIssueCursor(after);
    try { const value = await api.issues(currentCase.id, revision.id, after); if (scope === epoch.current && request === reads.current.issues) setIssues(ready(value)); }
    catch (e) { if (scope === epoch.current && request === reads.current.issues) { setIssues({ state: 'error', error: errorText(e) }); showError(e, false); } return false; }
  }
  async function previewPage(id: string, after = 0) {
    if (caseLoadingRef.current || !currentCase || !revision) return;
    const scope = epoch.current, request = ++reads.current.preview; setPreview(loading()); setPreviewId(id); setPreviewCursor(after);
    try { const value = await api.preview(currentCase.id, revision.id, id, after); if (scope === epoch.current && request === reads.current.preview) setPreview(ready(value)); }
    catch (e) { if (scope === epoch.current && request === reads.current.preview) { setPreview({ state: 'error', error: errorText(e) }); showError(e, false); } return false; }
  }
  async function download(item: Api['ArtifactState'], chooseLocation = false) {
    if (caseLoadingRef.current || busyRef.current || dirtyRef.current || pendingRef.current || !currentCase || !revision || !artifacts.data?.manifest_hash || !approval.data?.approved) return;
    const c = currentCase.id, r = revision.id, scope = epoch.current, hash = artifacts.data.manifest_hash;
    busyRef.current = true; setBusy('download'); setError(''); setReceived(undefined);
    try {
      const result = await api.download(c, r, item, hash, chooseLocation);
      if (scope === epoch.current) {
        setReceived(result.status === 'saved' ? `Файл «${result.filename}» сохранён в выбранном месте.`
          : result.status === 'cancelled' ? 'Сохранение отменено.' : `Браузер получил файл ${item.download_filename} показанной ревизии ${r}; хеш проверен. Сохранение на локальном диске неизвестно.`);
        if (result.status !== 'cancelled') await loadEvidence(c, r, artifacts.data.artifacts, scope);
      }
    } catch (e) { if (scope === epoch.current) { showError(e); await loadEvidence(c, r, artifacts.data.artifacts, scope); } }
    finally { busyRef.current = false; setBusy(''); }
  }

  const counts = object(review.data?.summary?.counts);
  const reconciliation = object(review.data?.summary?.reconciliation);
  const fileErrors = review.data?.summary?.file_errors;
  const ordered = [...(artifacts.data?.artifacts ?? [])].sort((a, b) => ['CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP'].indexOf(a.role) - ['CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP'].indexOf(b.role));
  const zip = ordered.find(item => item.role === 'ZIP');
  const mutationDisabled = !canEdit || !!busy || !!pending || caseLoading;
  let nextLabel = 'Выберите источник', nextDisabled = true, nextAction = () => {};
  if (file && currentCase) {
    nextLabel = 'Сохранить источник'; nextDisabled = mutationDisabled || profileChanged || corrections.length > 0 || editorDirty;
    nextAction = () => { const c = currentCase.id, chosen = file, selectedEncoding = encoding, expected = revision?.id ?? null; void mutate('source.upload', c, (csrf, id) => api.upload(csrf, c, id, chosen, selectedEncoding, expected)); };
  } else if (revision && dirty) {
    nextLabel = 'Сохранить и пересчитать'; nextDisabled = mutationDisabled || !sourceValid || editorDirty || draftBase?.id !== revision.id; nextAction = () => save(true);
  } else if (revision && (state === 'DRAFT')) {
    nextLabel = 'Проверить файл'; nextDisabled = mutationDisabled || !sourceValid;
    nextAction = () => { const c = currentCase!.id, r = revision.id; void mutate('processing.start', c, (csrf, id) => api.start(csrf, c, { operation_id: id, expected_revision_id: r })); };
  } else if (active) { nextLabel = state === 'QUEUED' ? 'Ожидание обработки' : 'Выполняется обработка'; }
  else if (state === 'PREPARED' && revision && artifacts.data?.available) {
    nextLabel = 'Подтвердить комплект'; nextDisabled = caseLoading || !canApprove || !!busy || !!pending || !approval.data?.current || !artifacts.data.manifest_hash || review.state !== 'ready' || boolean(reconciliation.complete) !== true;
    nextAction = () => { const c = currentCase!.id, r = revision.id, hash = artifacts.data!.manifest_hash!; void mutate('package.approve', c, (csrf, id) => api.approve(csrf, c, { operation_id: id, expected_revision_id: r, manifest_hash: hash })); };
  } else if (state === 'APPROVED' && zip) {
    nextLabel = 'Скачать комплект'; nextDisabled = caseLoading || !canApprove || !!busy || !!pending || !approval.data?.approved; nextAction = () => void download(zip);
  } else if (state === 'BLOCKED' || state === 'NEEDS_REVIEW') { nextLabel = 'Исправьте блокирующие ошибки'; }

  return <main className="page hub-page">
    <header className="page-header"><p className="product-name">DOGTAGS MANAGER</p><h1>Подготовка комплекта HUB</h1>
      <p className="secondary-text">Ручная подготовка: источник, проверки, исправления и подтверждение одной сохранённой версии.</p>
      <a href={appPath("?view=catalog")}>Каталог общих компонентов</a></header>
    <div className="hub-live secondary-text" role="status" aria-live="polite" aria-atomic="true">{message}</div>
    {error && <div ref={errorBox} tabIndex={-1} className="hub-error-summary" aria-label="Сводка ошибок"><Alert title="Действие не завершено" tone="danger"><p>{error}</p>
      {errorStatus === 409 && currentCase && <Button disabled={caseLoading || !!busy || !!pending} onClick={() => void openCase(currentCase.id, true)}>Открыть текущую ревизию для сверки</Button>}
    </Alert></div>}
    <FormSection data-form="session" title="Доступ к работе" aria-labelledby="session-title">
      {sessionLoading && <p>Получение состояния сессии…</p>}
      {authenticated ? <div className="actions"><p>Пользователь: <span data-testid="session-user">{session.user!.username}</span></p><Button loading={busy === 'logout'} onClick={() => void signOut()}>Выйти</Button></div>
        : <form onSubmit={event => { event.preventDefault(); void signIn(); }}><FormGrid>
          <FormField id="login-username" label="Имя пользователя" required help="Локальная учётная запись оператора.">{props => <Input {...props} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} />}</FormField>
          <FormField id="login-password" label="Пароль" required help="Пароль не хранится в браузерном хранилище.">{props => <Input {...props} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />}</FormField>
        </FormGrid><div className="actions"><Button type="submit" loading={busy === 'login'} disabled={!session?.csrf_token || sessionLoading}>Войти</Button><Button onClick={() => { setSessionLoading(true); void readSession().then(setSession).catch(showError).finally(() => setSessionLoading(false)); }}>Повторить чтение сессии</Button></div></form>}
      {!authenticated && dirty && <p>Несохранённый ввод этой учётной записи остаётся в памяти страницы до повторного входа.</p>}
    </FormSection>
    <section className="hub-group" aria-labelledby="case-title"><h2 id="case-title" className="block-title">Контекст заявки</h2>
      <div className="actions action-strip"><Button disabled={caseLoading || !canEdit || !!busy || !!pending || dirty} onClick={() => void mutate('case.create', null, api.create)}>Новая заявка</Button>
        <Button disabled={!authenticated || caseLoading || !!busy} onClick={() => void loadCases(caseCursor)}>Обновить список заявок</Button></div>
      {!canEdit && authenticated && <p>Нет разрешения case.edit: создание заявки, загрузка и исправления недоступны.</p>}
      {authenticated && <><Table caption="Сохранённые заявки" rows={cases.data?.items ?? []} rowId={row => row.id} state={pageState(cases, cases.data?.items.length ?? 0)} error={cases.error}
        columns={[{ key: 'case', label: 'Заявка', render: row => <Button disabled={caseLoading || !!busy || !!pending} onClick={() => void openCase(row.id)}>{row.title} · {row.id}</Button> }, { key: 'created', label: 'Создана / UTC', render: row => time(row.created_at) } ]} pagination={<Pager key={`cases-${session?.user?.id}`} after={caseCursor} next={cases.data?.next_cursor} busy={caseLoading || cases.state === 'loading'} onPage={cursor => loadCases(String(cursor))} />} />
        </>}
      {caseLoading && <p>Загрузка сохранённой заявки…</p>}
      {currentCase && <div className="hub-group"><p>Заявка: <span className="technical-data" data-testid="case-id">{currentCase.id}</span></p>
        {revision && <p>Показана ревизия {revision.sequence}: <span className="technical-data" data-testid="revision-id">{revision.id}</span></p>}
        <div className="status-list"><span data-testid="preparation-status"><StatusBadge status={statusFor(state)} /></span><span data-testid="external-state"><StatusBadge status="notSubmitted" /></span></div>
        <p className="secondary-text">Состояние внешнего применения: {currentCase.external_state}. Скачивание не означает внешний импорт.</p>
        <StepHeader steps={steps} currentStep={!revision ? 'source' : state === 'DRAFT' ? 'config' : active || state === 'BLOCKED' || state === 'NEEDS_REVIEW' ? 'checks' : state === 'PREPARED' ? 'files' : 'approval'} />
      </div>}
    </section>
    <FormSection data-form="source" title="Источник HUB" aria-labelledby="source-title">
      <FormGrid><FormField id="hub-file" label="Файл HUB CSV" help="CSV с разделителем ;. Исходные байты сохраняются неизменяемыми; новый источник заменяет источник заявки и создаёт ревизию.">
        {props => <Input {...props} key={fileKey} type="file" accept=".csv,text/csv" disabled={caseLoading || !canEdit || !!busy || !!pending || !currentCase} onChange={event => { dirtyRef.current = true; setFile(event.target.files?.[0]); }} />}</FormField>
        <FormField id="hub-encoding" label="Кодировка источника" help="Выберите явно UTF-8 или Windows-1251. Автоматического угадывания кодировки нет.">{props => <Select {...props} value={encoding} disabled={caseLoading || !canEdit || !!busy || !!pending} onChange={event => setEncoding(event.target.value as 'utf-8' | 'cp1251')}><option value="utf-8">UTF-8</option><option value="cp1251">Windows-1251</option></Select>}</FormField>
      </FormGrid>
      {!currentCase && <p>Войдите и создайте или откройте заявку, затем выберите источник.</p>}
      {file && <p>Выбран: {file.name} · {file.size.toLocaleString('ru-RU')} байт. Пока не сохранён.</p>}
      {revision && <div className="hub-group"><p>Сохранённый источник: <strong>{revision.source.filename}</strong></p><p>Кодировка: {revision.source.encoding}. Записей: {revision.source.inspection.records_count == null ? 'Неизвестно — синтаксический разбор не завершён' : revision.source.inspection.records_count.toLocaleString('ru-RU')}.</p>
        <p className="secondary-text technical-data">SHA-256: {revision.source.sha256} · {revision.source.size_bytes.toLocaleString('ru-RU')} байт</p>
        <p className="secondary-text">Технические колонки: {revision.source.inspection.columns?.join('; ') ?? 'Не определены'}</p>
        {(!revision.source.inspection.schema_supported || revision.source.inspection.errors.length > 0 || revision.source.inspection.records_count === 0 || shapeRequiresReplacement) && <Alert title="Требуется заменить исходный файл" tone="danger"><ul>{revision.source.inspection.errors.map(item => <li key={item.code}>{item.message} ({item.code})</li>)}</ul><p>Схему, число ячеек, повреждённый синтаксис или пустой набор нельзя исправить исключением строк. Выберите исправленный источник и сохраните его.</p></Alert>}
      </div>}
    </FormSection>
    {revision && <div className="hub-group"><FormSection data-form="profile" title="Настройки этой ревизии" aria-labelledby="profile-title">
      <p>Зафиксированный профиль: {string(revision.profile_snapshot.name) ?? 'Неизвестно'} · {string(revision.profile_snapshot.id) ?? 'Неизвестно'} · версия <span className="technical-data">{revision.profile_version_id}</span></p>
      <p className="secondary-text">Приоритет: переопределение этой ревизии → снимок профиля. Изменение не меняет профиль будущих заявок.</p>
      <FormGrid><FormField id="profile-SPREADING" label="Распространение SPREADING" help={`Профиль: ${string(revision.profile_snapshot.SPREADING) ?? 'Неизвестно'}; сохранённое значение: ${profileValue(revision, 'SPREADING')}. Независимый флаг 0/1.`}>{props => <Select {...props} value={profile.SPREADING} disabled={caseLoading || !canOverride || !!busy || !!pending} onChange={event => { dirtyRef.current = true; setProfile(value => ({ ...value, SPREADING: event.target.value })); }}><option value="0">0</option><option value="1">1</option></Select>}</FormField>
        <FormField id="profile-INTERNAL_OPERATOR_NAME" label="Внутреннее имя оператора INTERNAL_OPERATOR_NAME" help={`Профиль: ${string(revision.profile_snapshot.INTERNAL_OPERATOR_NAME) ?? 'Неизвестно'}; сохранённое значение: ${profileValue(revision, 'INTERNAL_OPERATOR_NAME')}. Литерал остаётся строкой.`}>{props => <Input {...props} value={profile.INTERNAL_OPERATOR_NAME} readOnly={caseLoading || !canOverride || !!busy || !!pending} onChange={event => { dirtyRef.current = true; setProfile(value => ({ ...value, INTERNAL_OPERATOR_NAME: event.target.value })); }} />}</FormField>
      </FormGrid>
      <FormField id="override-reason" label="Основание переопределения профиля" help="Только эта заявка / новая ревизия. До сохранения показан несохранённый diff; сервер добавляет автора и время UTC.">{props => <Textarea {...props} rows={3} value={profile.reason} readOnly={caseLoading || !canOverride || !!busy || !!pending} onChange={event => { dirtyRef.current = true; setProfile(value => ({ ...value, reason: event.target.value })); }} />}</FormField>
      {!canOverride && <p>Нет разрешения profile.override; сохранённые значения доступны для чтения и копирования.</p>}
      </FormSection>
      {profileChanged && <Table caption="Несохранённые настройки: было / стало" rows={profileChanges} rowId={row => row.field}
        columns={[{ key: 'field', label: 'Поле', render: row => row.field }, { key: 'before', label: 'Было', render: row => <span className="hub-value">{row.before}</span> }, { key: 'after', label: 'Стало', render: row => <span className="hub-value">{row.after}</span> }]} />}
      <details><summary>Сохранённая история настроек, происхождение и параметры версии</summary><pre className="hub-json">{JSON.stringify({ profile_snapshot: revision.profile_snapshot, settings: revision.settings, config_hash: revision.config_hash, rules_version: revision.rules_version, serializer_version: revision.serializer_version, created_at_UTC: revision.created_at, export_timestamp_UTC: revision.export_timestamp, export_timezone: revision.export_timezone, filename_components: revision.filename_components }, null, 2)}</pre></details>
    </div>}
    {revision && <section className="hub-section" aria-labelledby="checks-title"><h2 id="checks-title">Проверки и исход каждой записи</h2>
      {active && <Alert title={state === 'QUEUED' ? 'Ожидает обработки' : 'Идёт обработка'}><p>Этап: {string(job?.progress.stage) ?? 'Неизвестен'}; {number(job?.progress.percent) == null ? 'процент неизвестен' : `${number(job?.progress.percent)}%`}.</p><progress max={100} value={number(job?.progress.percent)} aria-label="Прогресс обработки" /></Alert>}
      {pollError && <Alert title="Состояние обработки не получено" tone="warning"><p>{pollError}</p><Button onClick={() => setPollError('')}>Повторить чтение состояния обработки</Button></Alert>}
      {state === 'FAILED' && <Alert title="Обработка завершилась ошибкой" tone="danger"><p>{string(job?.error?.message) ?? 'Детали ошибки пока не получены.'}</p>{boolean(job?.error?.retryable) && <Button disabled={mutationDisabled || dirty} onClick={() => { const c = currentCase!.id, r = revision.id; void mutate('processing.retry', c, (csrf, id) => api.start(csrf, c, { operation_id: id, expected_revision_id: r }, true)); }}>Повторить обработку сохранённой ревизии</Button>}</Alert>}
      {review.state === 'error' && <Alert title="Сводка проверки недоступна" tone="danger"><p>{review.error}</p></Alert>}
      {review.state === 'loading' && <p>Загрузка сводки проверки…</p>}
      {review.data && !review.data.dataset_available && <p>Глобальная проверка ещё не завершена; исходы и список ошибок пока не доступны.</p>}
      <ScientificExclusions summary={review.data?.summary ?? undefined} />
      {Array.isArray(fileErrors) && fileErrors.length > 0 && <Alert title="Структура источника блокирует полный комплект" tone="danger"><pre className="hub-json">{JSON.stringify(fileErrors, null, 2)}</pre><p>Замените исправленным источником; исходные записи не исключаются молча.</p></Alert>}
      <Table caption="Ошибки" rows={issues.data?.items ?? []} rowId={row => `${row.record_id}-${row.page_index}`} state={pageState(issues, issues.data?.items.length ?? 0)} error={issues.error}
        columns={[{ key: 'record', label: 'Запись / поле', render: row => <Button disabled={caseLoading} onClick={() => void openRecord(row.record_id, row.ordinal, row.field)}>Открыть запись {row.ordinal} · {row.field}</Button> }, { key: 'message', label: 'Причина и действие', render: row => row.message }, { key: 'code', label: 'Код / область', render: row => `${row.code} / ${row.scope}` } ]} pagination={<Pager key={`issues-${revision?.id}`} after={issueCursor} next={issues.data?.next_cursor} busy={caseLoading || issues.state === 'loading'} onPage={cursor => issuePage(Number(cursor))} />} />
      {issues.data && !issues.data.available && <p>Список ошибок ещё не рассчитан; пустая таблица не означает успешную проверку.</p>}

      <Table caption="Исходные записи и исход обработки" rows={records.data?.items ?? []} rowId={row => row.record_id} rowTone={row => row.disposition === 'excluded_scientific_inn' ? 'danger' : undefined} state={pageState(records, records.data?.items.length ?? 0)} error={records.error}
        columns={[{ key: 'ordinal', label: 'Запись', render: row => <Button disabled={caseLoading} onClick={() => void openRecord(row.record_id, row.ordinal)}>Открыть запись {row.ordinal}</Button> },
          ...(records.data?.columns ?? []).map((field, index) => ({ key: `${index}-${field}`, label: field, technical: true, render: (row: Api['RecordState']) => <span className="hub-value">{row.effective[field] ?? row.raw_cells[index] ?? ''}</span> })),
          { key: 'disposition', label: 'Исход / происхождение', render: row => <div className="hub-group"><span>{row.disposition ? dispositionLabels[row.disposition] : 'Ещё не определён'}</span><span className="secondary-text">{row.record_id}; строки {row.line_start}–{row.line_end}</span>{row.representative_id && row.representative_id !== row.record_id && row.representative_ordinal && <Button disabled={caseLoading} onClick={() => void openRecord(row.representative_id!, row.representative_ordinal!)}>Представитель: запись {row.representative_ordinal}</Button>}</div> } ]} pagination={<Pager key={`records-${revision?.id}`} after={recordCursor} next={records.data?.next_cursor} busy={caseLoading || records.state === 'loading'} onPage={cursor => recordPage(Number(cursor))} />} />

      <div className="actions action-strip"><Button disabled={caseLoading || !authenticated || !!busy} onClick={() => { void recordPage(recordCursor); void issuePage(issueCursor); }}>Повторить загрузку записей и ошибок</Button></div>
      {detail?.state === 'loading' && <p>Загрузка выбранной записи…</p>}
      {detail?.state === 'error' && <Alert title="Запись недоступна" tone="danger"><p>{detail.error}</p></Alert>}
      {detail?.data && <fieldset disabled={caseLoading} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} onChangeCapture={() => updateEditorDirty(true)}>
        <RecordEditor key={`${detail.data.revision_id}-${detail.data.record.record_id}`} detail={detail.data} columns={records.data?.columns ?? revision.source.inspection.columns ?? []} pending={corrections} enabled={canEdit && !!sourceValid && !caseLoading && !busy && !pending} focusField={focusField} onDirty={updateEditorDirty} onStage={changes => { dirtyRef.current = true; setCorrections(previous => [...previous, ...changes]); }} onRepresentative={(id, ordinal) => void openRecord(id, ordinal)} />
      </fieldset>}
    </section>}
    {revision && <section className="hub-section" aria-labelledby="files-title"><h2 id="files-title">Файлы и сверка полного комплекта</h2>
      {artifacts.state === 'loading' && <p>Загрузка состава файлов…</p>}
      {artifacts.state === 'error' && <Alert title="Комплект недоступен" tone="danger"><p>{artifacts.error}</p></Alert>}
      {artifacts.data && !artifacts.data.available && <Alert title="Полный комплект ещё не подготовлен" tone={state === 'BLOCKED' || state === 'NEEDS_REVIEW' ? 'danger' : 'info'}><p>Критические ошибки и конфликты блокируют выпуск всех трёх файлов. Выпуск корректной части не предусмотрен.</p></Alert>}
      {review.data?.summary && <div className="hub-group"><p>CLIENTS: <span data-testid="count-CLIENTS">{number(counts.CLIENTS)?.toLocaleString('ru-RU') ?? 'Неизвестно'}</span>; DOGTAGS: <span data-testid="count-DOGTAGS">{number(counts.DOGTAGS)?.toLocaleString('ru-RU') ?? 'Неизвестно'}</span>; NUMBERS: <span data-testid="count-NUMBERS">{number(counts.NUMBERS)?.toLocaleString('ru-RU') ?? 'Неизвестно'}</span>.</p>
        <p data-testid="coverage">{boolean(reconciliation.complete) === true ? 'Покрытие полное: зависимости и назначения проверены.' : boolean(reconciliation.complete) === false ? 'Покрытие неполное: выпуск заблокирован.' : 'Полнота покрытия неизвестна.'} Равенство количества строк не требуется.</p>
        <details><summary>Сводка исходов, ошибок и проверок покрытия</summary><pre className="hub-json">{JSON.stringify(review.data.summary, null, 2)}</pre></details></div>}
      {artifacts.data?.available && <><p className="secondary-text">{canChooseDownloadLocation() ? 'Нажмите «Сохранить как…», чтобы выбрать папку и имя файла.' : 'Для выбора папки включите в настройках браузера запрос места сохранения каждого файла.'}</p><Table caption="Комплект: клиенты → этикетки → номера → ZIP" rows={ordered} rowId={row => row.id}
        columns={[{ key: 'role', label: 'Файл', render: row => row.role }, { key: 'name', label: 'Точное имя / SHA-256', render: row => <div className="hub-group"><span>{row.download_filename}</span><span className="secondary-text technical-data">{row.sha256}</span></div> }, { key: 'count', label: 'Строк / байт', render: row => `${row.row_count == null ? 'Не применимо' : row.row_count.toLocaleString('ru-RU')} / ${row.size_bytes.toLocaleString('ru-RU')}` },
          { key: 'preview', label: 'Просмотр', render: row => row.role !== 'ZIP' && <Button disabled={caseLoading} onClick={() => void previewPage(row.id)}>Предпросмотр {row.role}</Button> },
          { key: 'download', label: 'Скачивание', render: row => <div className="actions">{row.role !== 'ZIP' && <Button disabled={caseLoading || dirty || !canApprove || !!busy || !!pending || !approval.data?.approved} onClick={() => void download(row)}>Скачать {row.role}</Button>}<SaveAsButton label={`Сохранить ${row.role} как…`} disabled={caseLoading || dirty || !canApprove || !!busy || !!pending || !approval.data?.approved} onSave={chooseLocation => void download(row, chooseLocation)} /></div> }]} />
        <p>Manifest SHA-256: <span className="technical-data" data-testid="manifest-hash">{artifacts.data.manifest_hash}</span>. Набор: <span className="technical-data">{artifacts.data.artifact_set_id}</span>.</p>
        <details><summary>Проверенный manifest: состав, хеши и версии</summary><pre className="hub-json" data-testid="manifest">{JSON.stringify(artifacts.data.manifest, null, 2)}</pre></details>
        <Table caption="Сохранённые свидетельства передачи файлов" rows={ordered} rowId={row => row.id} columns={[
          { key: 'role', label: 'Файл', render: row => row.role }, { key: 'evidence', label: 'Последняя попытка и её завершение / UTC', render: row => {
            const value = evidence[row.id]; const attempt = value?.data?.latest_attempt;
            return value?.state === 'error' ? <span className="field-error">{value.error}</span> : !value ? 'Загрузка свидетельств…' : attempt ? <div className="hub-group"><span>Попытка: {time(attempt.attempted_at)}; ID {attempt.attempt_id}</span><span>{attempt.response_completed_at ? `Сервер завершил передачу: ${time(attempt.response_completed_at)}; ${attempt.bytes_sent} байт.` : 'Завершение этой попытки не зафиксировано.'}</span><span className="secondary-text">Ревизия {value.data!.revision_id}; manifest {attempt.manifest_hash}. Сохранение на диске неизвестно.</span></div> : 'Попыток передачи нет.';
          } }]} />
        <div className="action-strip"><Button disabled={caseLoading || !!busy} onClick={() => void loadEvidence(currentCase!.id, revision.id, ordered, epoch.current)}>Обновить свидетельства передачи</Button></div>
      </>}
      {preview && <div className="hub-group"><Table caption={`Предпросмотр «${ordered.find(artifact => artifact.id === previewId)?.download_filename ?? preview.data?.role ?? 'CSV'}»`} rows={(preview.data?.items ?? []).map((cells, index) => ({ cells, index }))} rowId={row => String(row.index)} state={pageState(preview, preview.data?.items.length ?? 0)} error={preview.error} columns={(preview.data?.columns ?? []).map((field, index) => ({ key: field, label: field, technical: true, render: (row: { cells: string[] }) => <span className="hub-value">{row.cells[index]}</span> }))}  pagination={<Pager key={`preview-${revision?.id}-${previewId}`} after={previewCursor} next={preview.data?.next_cursor} busy={caseLoading || preview.state === 'loading'} onPage={cursor => previewPage(previewId, Number(cursor))} />} />
        <div className="action-strip"><Button disabled={caseLoading} onClick={() => void previewPage(previewId, previewCursor)}>Повторить загрузку предпросмотра</Button></div></div>}
    </section>}
    <section className="hub-group" aria-labelledby="next-title"><h2 id="next-title" className="block-title">Текущее действие</h2>
      <p data-testid="dirty-state">{dirty ? 'Есть несохранённый ввод. Подтверждение и скачивание заблокированы до сохранения или явной отмены.' : revision ? 'Сохранённая ревизия показана без несохранённого ввода.' : 'Источник ещё не сохранён.'}</p>
      {draftBase && revision && dirty && draftBase.id !== revision.id && <Alert title="Черновик относится к предыдущей ревизии" tone="warning"><p>Ввод сохранён для сравнения. Его основание: {draftBase.id}; текущая показанная ревизия: {revision.id}. Сверьте значения, затем явно отмените старый ввод и внесите исправления относительно показанной версии.</p></Alert>}
      {corrections.length > 0 && <Table caption="Несохранённые исправления" rows={corrections.map((change, index) => ({ ...change, index }))} rowId={row => String(row.index)} columns={[{ key: 'field', label: 'Запись / поле', render: row => `${row.ordinal} / ${fieldLabels[row.field]} (${row.field})` }, { key: 'before', label: 'Было', render: row => <span className="hub-value">{row.before}</span> }, { key: 'after', label: 'Стало', render: row => <span className="hub-value">{row.after}</span> }]} />}
      {approval.state === 'error' && revision && <Alert title="Действительность подтверждения неизвестна" tone="danger"><p>{approval.error}</p></Alert>}
      {approval.data?.approval && <p>Подтверждение: {approval.data.approval.id}; автор {approval.data.approval.author_id}; {time(approval.data.approval.created_at)}. Ревизия {approval.data.approval.revision_id}; набор {approval.data.approval.artifact_set_id}; manifest {approval.data.approval.manifest_hash}. {approval.data.approved ? 'Действует для показанной текущей версии.' : 'Не действует для текущей версии.'}</p>}
      {approval.data && !approval.data.current && <Alert title="Показанная версия устарела" tone="warning"><p>Текущая ревизия: {approval.data.head_revision_id}. Черновик сохранён в памяти; новая версия требует отдельной сверки.</p><Button disabled={caseLoading || !!busy || !!pending} onClick={() => void openCase(currentCase!.id, true)}>Открыть текущую ревизию для сверки</Button></Alert>}
      {!canApprove && authenticated && <p>Нет разрешения package.approve: подтверждение и скачивание недоступны.</p>}
      {pending && busy !== pending.action && <Alert title={pending.status === 'RUNNING' ? 'Операция ещё не завершена' : pending.status === 'FAILED' ? 'Операция завершилась ошибкой' : 'Исход операции неизвестен'} tone="warning"><p>Ключ {pending.id}; действие {pending.action}; область {pending.caseId ?? 'создание заявки'}. Новое действие не подменяет неизвестный исход.</p>
        <div className="actions"><Button loading={busy === 'recover'} disabled={caseLoading || !!busy || !authenticated} onClick={() => void recover()}>Проверить сохранённую операцию</Button>
          {pending.status === 'unknown' && <Button disabled={caseLoading || !!busy || !authenticated} onClick={() => void recover(true)}>Повторить с тем же ключом</Button>}
          {(pending.status === 'FAILED' || (pending.action === 'source.upload' && pending.status === 'RUNNING')) && <Button disabled={caseLoading || !!busy} onClick={() => { pendingRef.current = undefined; setPending(undefined); setMessage('Предыдущая квитанция остаётся в истории; следующая загрузка получит новый ключ.'); }}>Начать новую попытку с новым ключом</Button>}</div>
        {pending.action === 'source.upload' && pending.status === 'RUNNING' && <p>Это незавершённая квитанция загрузки, не задача обработки. Автоматический бесконечный опрос не выполняется; проверьте квитанцию или выберите новую попытку.</p>}
      </Alert>}
      <div className="actions action-strip"><Button variant="primary" disabled={nextDisabled} loading={!!busy && busy !== 'login' && busy !== 'logout' && busy !== 'recover'} onClick={nextAction}>{nextLabel}</Button>
        {revision && <Button disabled={mutationDisabled || !dirty || !!file || editorDirty || draftBase?.id !== revision.id} onClick={() => save(false)}>Сохранить черновик</Button>}
        {dirty && <Button disabled={caseLoading || !!busy || !!pending} onClick={() => resetDraft(revision)}>Отменить несохранённый ввод</Button>}
        {currentCase && <Button disabled={caseLoading || !!busy || !!pending || !authenticated} onClick={() => void openCase(currentCase.id, true)}>Перечитать сохранённую заявку</Button>}</div>
      {received && <Alert title="Получение файла" ><p>{received}</p><p>Внешняя загрузка не подтверждена.</p></Alert>}
    </section>
  </main>;
}
