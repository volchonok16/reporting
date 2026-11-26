import { SourceDownload } from '../../components/SourceDownload';
import { appPath } from '../../reporting';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiFailure, object, readSession, string, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Disclosure } from '../../components/Disclosure';
import { ArchiveWorkspace } from './ArchiveWorkspace';
import { ArchiveEntryButton } from './ArchiveEntryButton';
import { ActionIcon, IconButton } from '../../components/IconButton';
import { Input, Select } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ReferenceDirectory } from '../dictionary/ReferenceDirectory';
import { Sidebar } from '../../components/Sidebar';
import { PdfExtractor } from '../pdf/PdfExtractor';
import { errorText } from '../hub/model';
import { WhitemavInnPicker } from './WhitemavInnPicker';
import { DecisionsForm } from './DecisionsForm';
import { ResultPanel } from './ResultPanel';
import { WorkflowSteps, type WorkflowStep } from './WorkflowSteps';
import { ProcessingDialog } from './ProcessingDialog';
import { isProcessing, processingProgress } from './processing';
import { ReturnPanel } from '../results/ReturnPanel';
import { sendDirect, sendOperation, type OperationCommand, type DirectCommand } from '../results/model';
import { label, partnerOf, partners, operations, workDate, type Decisions, type Intake } from './model';
import '../hub/hub.css';
import './intake.css';

type Pending = { id: string; action: string; caseId: string | null; intakeId?: string; filename?: string; direct?: DirectCommand; command?: OperationCommand; partner?: Decisions['partner']; operation?: Decisions['operation']; whitemavInn?: string; state: 'unknown' | 'RUNNING' | 'FAILED' };
function intakeUrl(id: string) { const url = new URL(location.href); if (url.searchParams.get('intake') !== id) url.searchParams.delete('retry'); url.searchParams.set('intake', id); url.searchParams.delete('view'); history.replaceState(null, '', url); }
function pendingKey(user: string) { return `dogtags.intake.operations.${user}`; }
function savedPending(user: string): Pending[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(pendingKey(user)) ?? '[]');
    return Array.isArray(value) ? value.map(object).filter(value => typeof value.id === 'string' && typeof value.action === 'string').map(value => ({ id: String(value.id), action: String(value.action), caseId: string(value.caseId) ?? null, intakeId: string(value.intakeId), filename: string(value.filename), operation: typeof value.operation === 'string' && value.operation in operations ? value.operation as Decisions['operation'] : undefined, partner: string(value.partner), direct: value.direct as DirectCommand | undefined, command: value.command as OperationCommand | undefined, state: value.state === 'FAILED' ? 'FAILED' : 'unknown' })) : [];
  } catch { return []; }
}
export function Workspace() {
  const [session, setSession] = useState<Api['SessionState']>();
  const [items, setItems] = useState<Intake[]>([]), [archivePage, setArchivePage] = useState<Api['IntakePage']>();
  const [selected, setSelected] = useState<Intake>();
  const [partner, setPartner] = useState('');
  const [partnerNames, setPartnerNames] = useState<readonly string[]>(partners);
  const [whitemavInnSaving, setWhitemavInnSaving] = useState(false);
  const [whitemavInn, setWhitemavInn] = useState('7743895280');
  const [uploadMode, setUploadMode] = useState<'new' | 'repair' | 'whitemav'>('new');
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>(1);
  const [backHost, setBackHost] = useState<HTMLSpanElement | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false), [pollError, setPollError] = useState('');
  const [decisionDirty, setDecisionDirty] = useState(false), [resultDirty, setResultDirty] = useState(false);
  const [recoveryReset, setRecoveryReset] = useState(0);
  const [decisionReset, setDecisionReset] = useState(0), [manualDecisions, setManualDecisions] = useState(false);
  const [section, setSection] = useState<'marking' | 'archive' | 'dictionary' | 'pdf'>(() => { const value = new URLSearchParams(location.search).get('section'); return value === 'archive' || value === 'dictionary' || value === 'pdf' ? value : 'marking'; });
  const [pdfBusy, setPdfBusy] = useState(false);
  const [archiveSelected, setArchiveSelected] = useState<Intake>();
  const [deleteTarget, setDeleteTarget] = useState<Intake>();
  const [archiveMessage, setArchiveMessage] = useState('');
  const listEpoch = useRef(0);
  const archiveAfter = useRef<string | undefined>(undefined);
  const [chosenFiles, setChosenFiles] = useState<File[]>([]);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [restoredRetry, setRestoredRetry] = useState<string | undefined>(() => new URLSearchParams(location.search).get('retry') ?? undefined);
  const [retryFiles] = useState(() => new Map<string, File>());
  const archiveSelectedRef = useRef<Intake | undefined>(undefined); archiveSelectedRef.current = archiveSelected;
  const selectedRef = useRef<Intake | undefined>(undefined), dirty = useRef(false), alive = useRef(true), busyRef = useRef(false), pendingRef = useRef<Pending[]>([]), owner = useRef<string | undefined>(undefined);
  const decisionDirtyRef = useRef(false);
  selectedRef.current = selected; dirty.current = decisionDirty || resultDirty; decisionDirtyRef.current = decisionDirty;
  const updateDecisionDirty = useCallback((value: boolean) => { decisionDirtyRef.current = value; dirty.current = value || dirty.current; setDecisionDirty(value); }, []);
  const updateResultDirty = useCallback((value: boolean) => { dirty.current = value || decisionDirtyRef.current; setResultDirty(value); }, []);
  function storePending(values: Pending[]) {
    if (owner.current) localStorage.setItem(pendingKey(owner.current), JSON.stringify(values));
    const retained = new Set(values.map(value => value.id));
    for (const id of retryFiles.keys()) if (!retained.has(id)) retryFiles.delete(id);
    pendingRef.current = values; setPending(values);
  }
  function showError(value: unknown) { setError(errorText(value)); if (value instanceof ApiFailure && value.status === 401) void readSession().then(setSession); }
  function upsert(value: Intake) {
    const visible = !value.intake.deleted_at;
    setArchiveSelected(previous => previous?.intake.id === value.intake.id ? visible ? value : undefined : previous);
    setArchivePage(previous => previous ? { ...previous, items: previous.items.flatMap(item => item.intake.id === value.intake.id ? visible ? [value] : [] : [item]) } : previous);
    setItems(previous => [...(visible ? [value] : []), ...previous.filter(item => item.intake.id !== value.intake.id)]
      .sort((a, b) => b.intake.created_at.localeCompare(a.intake.created_at)));
  }
  function clearSelected() {
    setSelected(undefined); selectedRef.current = undefined; setSessionIds([]); setRestoredRetry(undefined);
    const url = new URL(location.href); url.searchParams.delete('intake'); url.searchParams.delete('retry');
    history.replaceState(null, '', url);
  }
  function select(value: Intake, fromArchive = false) {
    if (value.intake.deleted_at) { setError('Запись удалена окончательно.'); return; }
    if (dirty.current || busyRef.current || pendingRef.current.some(item => item.intakeId === selectedRef.current?.intake.id)) { setError('Несохранённый ввод или неподтверждённая операция. Сохраните решения либо явно отмените ввод перед переключением файла.'); return; }
    if (fromArchive && value.revision) {
      sessionStorage.setItem(`dogtags.workflow.${session?.user?.id}.${value.revision.id}`, '1');
      sessionStorage.setItem(`dogtags.workflow.v2.${session?.user?.id}.${value.revision.id}`, '1');
    }
    setRestoredRetry(undefined); setArchiveSelected(undefined); setSection('marking'); const url = new URL(location.href); url.searchParams.delete('section'); history.replaceState(null, '', url); setSelected(value); selectedRef.current = value; setManualDecisions(false); setError('');
    intakeUrl(value.intake.id);
  }
  async function refreshSelected(id = selectedRef.current?.intake.id, force = false) {
    if (!id) return;
    const user = owner.current; const value = await api.intake(id);
    if (!alive.current || user !== owner.current) return;
    upsert(value);
    if (value.intake.deleted_at) { if (selectedRef.current?.intake.id === id && !dirty.current) clearSelected(); return; }
    if ((force || selectedRef.current?.intake.id === id) && !dirty.current) { setSelected(value); selectedRef.current = value; intakeUrl(id); }
  }
  async function list(after?: string) {
    const user = owner.current, epoch = listEpoch.current, pageAfter = after ?? archiveAfter.current;
    const page = await api.intakes(pageAfter);
    if (!alive.current || user !== owner.current || epoch !== listEpoch.current || pageAfter !== archiveAfter.current) return;
    setItems(previous => {
      const seen = new Set<string>();
      return [...page.items, ...previous].filter(item => {
        if (seen.has(item.intake.id)) return false;
        seen.add(item.intake.id); return true;
      }).sort((a, b) => b.intake.created_at.localeCompare(a.intake.created_at));
    }); setArchivePage(page);
  }
  useEffect(() => {
    alive.current = true; void readSession().then(value => { if (alive.current) { owner.current = value.user?.id; setSession(value); } }).catch(showError);
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!session?.authenticated || !session.user) return;
    owner.current = session.user.id; const restored = savedPending(session.user.id); pendingRef.current = restored; setPending(restored);
    for (const pendingOperation of restored) void recover(pendingOperation);
    void list().catch(showError);
    const id = new URLSearchParams(location.search).get('intake'); if (id) void refreshSelected(id, true).catch(showError);
    let live = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!live) return;
      try {
        for (const operation of pendingRef.current.filter(value => value.state === 'RUNNING')) {
          if (live && !busyRef.current) await recover(operation);
        }
        await refreshSelected();
        const archiveId = archiveSelectedRef.current?.intake.id;
        if (live && archiveId && archiveId !== selectedRef.current?.intake.id) await refreshSelected(archiveId);
        if (live) await list();
        if (live) setPollError('');
      } catch (e) { if (live) { setPollError(errorText(e)); showError(e); } }
      if (live) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => { live = false; clearTimeout(timer); };
  }, [session?.user?.id]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty.current || pendingRef.current.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  async function accept(p: Pending, receipt: Api['IntakeOperationState'] | Api['OperationState'], recovered = false) {
    if (receipt.status !== 'SUCCEEDED') { storePending(pendingRef.current.map(value => value.id === p.id ? { ...value, state: receipt.status === 'FAILED' ? 'FAILED' : 'RUNNING' } : value)); if (receipt.error) setError(receipt.error.message); return false; }
    if (recovered && p.command && selectedRef.current?.intake.id === p.intakeId) {
      dirty.current = false; decisionDirtyRef.current = false; setDecisionDirty(false); setResultDirty(false);
      setDecisionReset(n => n + 1); setRecoveryReset(n => n + 1); setManualDecisions(false);
    }
    const intake = object(receipt.result?.intake), id = string(intake.id) ?? p.intakeId;
    if (id) {
      const value = p.action === 'intake.archive' ? receipt.result as Intake : await api.intake(id); upsert(value);
      storePending(pendingRef.current.filter(value => value.id !== p.id));
      if (p.action === 'intake.archive') {
        ++listEpoch.current;
        if (value.intake.deleted_at && selectedRef.current?.intake.id === id) clearSelected();
        setArchiveSelected(undefined); setDeleteTarget(undefined);
        setArchiveMessage(`Файл «${value.source.filename}» удалён окончательно.`);
        await list(); return true;
      }
      if (p.action === 'intake.database_status') return true;
      if (!dirty.current && (!selectedRef.current || selectedRef.current.intake.id === id || p.action === 'intake.upload')) { setSelected(value); selectedRef.current = value; intakeUrl(id); }
    } else storePending(pendingRef.current.filter(value => value.id !== p.id));
    if (p.action === 'intake.upload' && id) setSessionIds(previous => [...new Set([...previous, id])]);
    if (p.action === 'return.retry') {
      const revisionId = string(object(receipt.result?.revision).id);
      if (revisionId) { setRestoredRetry(revisionId); const url = new URL(location.href); if (p.intakeId) url.searchParams.set('intake', p.intakeId); url.searchParams.set('retry', revisionId); history.replaceState(null, '', url); }
    }
    return true;
  }
  async function execute(p: Pending, work: () => Promise<Api['IntakeOperationState'] | Api['OperationState']>) {
    // Persist the exact command and key before sending any state-changing request.
    try { storePending([...pendingRef.current, p]); return await accept(p, await work()); }
    catch (e) {
      if (e instanceof ApiFailure && e.status >= 400 && e.status < 500) storePending(pendingRef.current.filter(value => value.id !== p.id));
      showError(e); return false;
    }
  }
  async function upload(files: FileList | File[]) {
    if (uploadMode === 'whitemav' && (whitemavInnSaving || !whitemavInn)) return;
    if (!session?.authenticated || !session.user?.permissions.includes('case.edit')) return;
    if (dirty.current || busyRef.current) { setError('Сохраните или отмените несохранённый ввод перед загрузкой новых файлов.'); return; }
    if ((uploadMode !== 'whitemav' && !partner) || !files.length || pendingRef.current.length) { setError('Выберите исходный файл и партнёра перед обработкой.'); return; }
    const operation = uploadMode === 'whitemav' ? 'WHITEMAV' : uploadMode === 'repair' ? 'REPAIR' : undefined;
    const scopePartner = (uploadMode === 'whitemav' ? undefined : partner) as Decisions['partner']; setError(''); setPollError(''); busyRef.current = true; setBusy(true); setUploading(true);
    try { await Promise.all(Array.from(files).map(async file => {
      const id = crypto.randomUUID(); retryFiles.set(id, file);
      await execute({ id, action: 'intake.upload', caseId: null, filename: file.name, partner: scopePartner || undefined, operation, whitemavInn: operation === 'WHITEMAV' ? whitemavInn : undefined, state: 'unknown' }, () => api.intakeUpload(session.csrf_token, id, file, scopePartner || undefined, operation, operation === 'WHITEMAV' ? whitemavInn : undefined));
    })); setChosenFiles([]); } finally { busyRef.current = false; setBusy(false); setUploading(false); }
  }
  async function recover(p: Pending, file?: File) {
    setError('');
    try {
      if (p.direct) { await sendDirect(session!.csrf_token, p.direct); storePending(pendingRef.current.filter(value => value.id !== p.id)); await refreshSelected(); return; }
      // Query the receipt before replaying the original command or upload.
      const receipt = await api.operation(p.id, p.action, p.caseId);
      await accept(p, receipt, true);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404 && p.action === 'intake.upload') {
        const original = file ?? retryFiles.get(p.id);
        if (original) { try { await accept(p, await api.intakeUpload(session!.csrf_token, p.id, original, p.partner, p.operation, p.whitemavInn)); } catch (retryError) { showError(retryError); } }
        else setError('Квитанция пока не найдена. Выберите тот же исходный файл для повтора с сохранённым ключом.');
      } else if (e instanceof ApiFailure && e.status === 404 && p.command) {
        try { await accept(p, await sendOperation(session!.csrf_token, p.command), true); }
        catch (retryError) {
          if (retryError instanceof ApiFailure && retryError.status >= 400 && retryError.status < 500) storePending(pendingRef.current.map(value => value.id === p.id ? { ...value, state: 'FAILED' } : value));
          showError(retryError);
        }
      } else if (e instanceof ApiFailure && e.status === 404 && !p.command && !p.direct) {
        setError('Квитанция не найдена. В старой записи не сохранены параметры команды; для восстановления требуется сверить состояние и исходное решение.');
      } else { if (p.direct && e instanceof ApiFailure && e.status >= 400 && e.status < 500) storePending(pendingRef.current.map(value => value.id === p.id ? { ...value, state: 'FAILED' } : value)); showError(e); }
    }
  }
  async function saveDecisions(decisions: Decisions) {
    if (!selected || !session || busyRef.current || pendingRef.current.some(value => value.intakeId === selected.intake.id)) return;
    const value = selected; busyRef.current = true; setBusy(true); setError('');
    const command: OperationCommand = { action: 'intake.decisions', intakeId: value.intake.id, caseId: value.intake.case_id,
      body: { operation_id: crypto.randomUUID(), expected_version_id: value.version.id, decisions } };
    const p: Pending = { id: command.body.operation_id, action: command.action, caseId: command.caseId, intakeId: value.intake.id, command, state: 'unknown' };
    try { if (await execute(p, () => sendOperation(session.csrf_token, command))) { dirty.current = false; setDecisionDirty(false); setManualDecisions(false); setDecisionReset(n => n + 1); await refreshSelected(value.intake.id); } }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function mutate(command: OperationCommand) {
    if (!selected || !session || busyRef.current || pendingRef.current.some(value => value.intakeId === selected.intake.id)) return false;
    busyRef.current = true; setBusy(true); setError(''); const p: Pending = { id: command.body.operation_id, action: command.action, caseId: command.caseId, intakeId: selected.intake.id, command, state: 'unknown' };
    try { return await execute(p, () => sendOperation(session.csrf_token, command)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function directMutation(command: DirectCommand) {
    if (!session || busyRef.current || pendingRef.current.length) return false;
    const p: Pending = { id: command.body.operation_id, action: command.kind, caseId: null,
      intakeId: (section === 'archive' ? archiveSelected : selectedRef.current)?.intake.id, direct: command, state: 'unknown' };
    busyRef.current = true; setBusy(true); setError('');
    try {
      storePending([...pendingRef.current, p]);
      await sendDirect(session.csrf_token, command);
      storePending(pendingRef.current.filter(value => value.id !== p.id));
      return true;
    } catch (e) {
      if (e instanceof ApiFailure && e.status >= 400 && e.status < 500) storePending(pendingRef.current.filter(value => value.id !== p.id));
      showError(e); return false;
    } finally { busyRef.current = false; setBusy(false); }
  }
  function navigate(next: 'marking' | 'archive' | 'dictionary' | 'pdf') {
    if (section === next) return;
    if (pdfBusy) { setError('Дождитесь окончания извлечения PDF или отмените его.'); return; }
    if (dirty.current || busyRef.current || pendingRef.current.length) { setError('Сохраните или отмените ввод перед переходом в другой раздел.'); return; }
    setSection(next); setResultDirty(false); setArchiveSelected(undefined); setDeleteTarget(undefined); setError('');
    const url = new URL(location.href);
    if (next !== 'marking') url.searchParams.set('section', next); else url.searchParams.delete('section');
    history.replaceState(null, '', url);
  }
  function newProcessing() {
    if (dirty.current || busyRef.current || pendingRef.current.length) { setError('Сохраните или отмените ввод перед началом новой обработки.'); return; }
    setSelected(undefined); selectedRef.current = undefined; setSessionIds([]); setChosenFiles([]); setPartner(''); setWhitemavInn('7743895280'); setUploadMode('new'); setRestoredRetry(undefined); setManualDecisions(false); setError('');
    history.replaceState(null, '', appPath());
  }
  function inspectArchive(value: Intake) {
    if (dirty.current || busyRef.current || pendingRef.current.length) { setError('Сохраните или отмените ввод перед выбором другого файла.'); return; }
    setArchiveSelected(value); setError('');
  }
  function askDelete(value: Intake) {
    if (dirty.current || busyRef.current || pendingRef.current.length) { setError('Сохраните или отмените ввод перед удалением файла.'); return; }
    setDeleteTarget(value); setError(''); setArchiveMessage('');
  }
  async function changeArchive(value: Intake) {
    if (!session || !canEdit || dirty.current || busyRef.current || pendingRef.current.length) return;
    busyRef.current = true; setBusy(true); setError('');
    const command: OperationCommand = { action: 'intake.archive', intakeId: value.intake.id, caseId: value.intake.case_id,
      body: { operation_id: crypto.randomUUID(), expected_version_id: value.version.id, expected_deleted_at: value.intake.deleted_at ?? null, deleted: true } };
    try { await execute({ id: command.body.operation_id, action: command.action, caseId: command.caseId, intakeId: value.intake.id, filename: value.source.filename, command, state: 'unknown' }, () => sendOperation(session.csrf_token, command)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const selectedPending = pending.some(value => value.intakeId === selected?.intake.id);
  const canEdit = session?.user?.permissions.includes('case.edit') ?? false;
  const processingItems = items.filter(item => sessionIds.includes(item.intake.id) || item.intake.id === selected?.intake.id);
  if (selected && !processingItems.some(item => item.intake.id === selected.intake.id)) processingItems.push(selected);
  const activeProcessing = processingItems.filter(isProcessing);
  const activeUpload = uploading || pending.some(value => value.action === 'intake.upload' && value.state === 'RUNNING');
  useEffect(() => {
    if (!session?.user?.id || section !== 'marking') return;
    let active = true;
    void api.processingSettings().then(settings => {
      if (active) setPartnerNames(Object.keys(settings.profiles));
    }).catch(() => {});
    return () => { active = false; };
  }, [session?.user?.id, section]);
  const processing = session?.authenticated && (activeUpload || activeProcessing.length > 0);
  const currentProgress = activeProcessing[0] ? processingProgress(activeProcessing[0]) : { percent: 0, stage: 'Загружаем исходный файл' };
  const fileConfiguration = (actions?: ReactNode, content?: ReactNode) => selected && <section className="hub-section" aria-label="Обработка файла"><h2>Обработка файла</h2>
    <div className="actions"><Button aria-expanded={!!selected.assessment?.questions.length || manualDecisions} aria-controls="file-settings" disabled={busy || resultDirty || selectedPending || !canEdit} onClick={() => { if (decisionDirty) { setError('Сохраните решения или отмените ввод перед сворачиванием.'); return; } setManualDecisions(value => !value); }}>Изменить партнёра или назначение</Button>{actions}</div>
    {content}
    <Disclosure id="file-settings" open={!!selected.assessment?.questions.length || manualDecisions}>
      {(!!selected.assessment?.questions.length || manualDecisions) && <DecisionsForm partnerNames={partnerNames} manual={manualDecisions} key={`${selected.intake.id}-${selected.version.id}-${decisionReset}`} intake={selected} csrf={session!.csrf_token} disabled={busy || selectedPending || resultDirty || !canEdit} onDirty={updateDecisionDirty} onSave={saveDecisions} />}
      {decisionDirty && <Button disabled={busy || selectedPending} onClick={() => { dirty.current = resultDirty; setDecisionDirty(false); setDecisionReset(n => n + 1); }}>Отменить несохранённые решения</Button>}
    </Disclosure>
  </section>;
  return <div className={session?.authenticated ? 'workspace-shell' : undefined}>
    {session?.authenticated && <Sidebar section={section} onMarking={() => navigate('marking')} onArchive={() => navigate('archive')} onDictionary={() => navigate('dictionary')} onPdf={() => navigate('pdf')} />}
    <main className={`page hub-page intake-page${!session?.authenticated ? ' login-page' : ''}`}>
    <header className="page-header workflow-header"><div className="workflow-heading">{!session?.authenticated ? <h1 className="login-title">DOGTAGS MANAGER</h1> : <h1>{section === 'archive' ? 'Архив' : section === 'dictionary' ? 'Справочник' : section === 'pdf' ? 'Экстрактор данных из PDF' : 'Маркировка'}</h1>}{session?.authenticated && section === 'marking' && selected && <><span className="workflow-filename">{selected.source.filename} · {partnerOf(selected)}</span><IconButton icon="repeat" label="Новая обработка" disabled={busy || !!pending.length || resultDirty || decisionDirty} onClick={newProcessing} /></>}</div>
      {session?.authenticated && section === 'marking' && <div className="workflow-navigation">{selected && <span className="workflow-back" ref={setBackHost}>{!selected.revision && <IconButton icon="back" label="Вернуться назад" disabled={busy || selectedPending || decisionDirty} onClick={newProcessing} />}</span>}<WorkflowSteps current={!selected ? 0 : !selected.revision ? 1 : workflowStep} /></div>}
    </header>
    {error && <div role="alert"><Alert title="Требуется внимание" tone="danger"><p>{error}</p><Button onClick={() => { setError(''); void list().then(() => refreshSelected()).catch(showError); }}>Обновить состояние</Button></Alert></div>}
    {!session && <p>Подключаемся к серверу…</p>}
    {session?.authenticated && <>
      <div hidden={section !== 'pdf'}><PdfExtractor key={session.user?.id} onBusy={setPdfBusy} /></div>
      {section === 'dictionary' && <ReferenceDirectory key={session.user?.id} session={session} onDirty={updateResultDirty} />}
      {section === 'marking' && !selected && <>
        <FormSection title={uploadMode === 'whitemav' ? 'Исключения из МАВ — WhiteMAV' : uploadMode === 'repair' ? 'Загрузите файл с ошибками из базы' : 'Загрузите исходный файл'} className="intake-upload" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (canEdit && !busy && !pending.length) setChosenFiles(Array.from(event.dataTransfer.files)); }}>
          <fieldset className="upload-process"><legend>Что вы хотите обработать?</legend><label><input type="radio" name="upload-process" checked={uploadMode === 'new'} disabled={!canEdit || busy || !!pending.length} onChange={() => setUploadMode('new')} />Новый исходный файл</label><label><input type="radio" name="upload-process" checked={uploadMode === 'repair'} disabled={!canEdit || busy || !!pending.length} onChange={() => setUploadMode('repair')} />Файл с ошибками из базы</label><label><input type="radio" name="upload-process" checked={uploadMode === 'whitemav'} disabled={!canEdit || busy || !!pending.length} onChange={() => setUploadMode('whitemav')} />Исключения из МАВ</label></fieldset>
          <p>{uploadMode === 'whitemav' ? 'Загрузите файл с номерами. Подготовим NUMBERS с выбранным ИНН и оператором whiteMAV. Комментарии не переносятся.' : uploadMode === 'repair' ? 'Выберите возвращённый CLIENTS, DOGTAGS или NUMBERS с колонкой STATUS и партнёра. Проверим все строки и подготовим исправленные файлы и отдельный отчёт об ошибках.' : 'Выберите таблицу и партнёра, от которого она поступила.'}</p>
          <FormField id="intake-files" label="Исходный файл" help="CSV, XLSX, XLS, XLSB или Numbers (.numbers). Можно перетащить файл в эту область.">{props => <Input {...props} type="file" multiple accept=".csv,.xlsx,.xls,.xlsb,.numbers" disabled={!canEdit || busy || !!pending.length} onChange={event => { setChosenFiles(Array.from(event.target.files ?? [])); }} />}</FormField>
          {!!chosenFiles.length && <ul className="selected-files">{chosenFiles.map((file, index) => <li key={index}>{file.name}</li>)}</ul>}
          {uploadMode === 'whitemav' && <WhitemavInnPicker value={whitemavInn} csrf={session.csrf_token} disabled={!canEdit || busy || !!pending.length} onChange={setWhitemavInn} onBusy={setWhitemavInnSaving} />}
          {uploadMode !== 'whitemav' && <FormField id="upload-partner" label="Партнёр" required>{props => <Select {...props} disabled={!canEdit || busy || !!pending.length} value={partner} onChange={event => setPartner(event.target.value)}><option value="">Выберите партнёра</option>{partnerNames.map(value => <option key={value}>{value}</option>)}</Select>}</FormField>}
          <Button variant="primary" loading={busy} disabled={!canEdit || (uploadMode === 'whitemav' && (whitemavInnSaving || !whitemavInn)) || (uploadMode !== 'whitemav' && !partner) || !chosenFiles.length || !!pending.length} onClick={() => void upload(chosenFiles)}>Обработать файл{chosenFiles.length > 1 ? 'ы' : ''}</Button>
        </FormSection>
      </>}
      {pending.map(p => <Alert key={p.id} title={p.state === 'FAILED' ? 'Операция завершилась ошибкой' : 'Проверяем сохранение операции'} tone="warning"><p>{p.filename ?? p.direct?.body.reason ?? 'Изменение выбранного файла'}. Результат подтверждается квитанцией сервера.</p><Button onClick={() => void recover(p)}>Проверить сохранённую операцию</Button>{p.action === 'intake.upload' && <FormField id={`retry-${p.id}`} label="Повторно выбрать тот же файл" help="Сначала проверяется квитанция; повтор использует прежний ключ.">{props => <Input {...props} type="file" onChange={event => { const file = event.target.files?.[0]; if (file) void recover(p, file); }} />}</FormField>}{p.state === 'FAILED' && <Button onClick={() => storePending(pendingRef.current.filter(value => value.id !== p.id))}>Закрыть завершённую попытку</Button>}</Alert>)}
      {section === 'archive' && <>
        {archiveMessage && <p role="status">{archiveMessage}</p>}
        <section className="hub-section archive-files" aria-label="Архивные файлы">
          <ArchiveWorkspace selected={archiveSelected} onSelect={inspectArchive}
            actions={archiveSelected && <><SourceDownload caseId={archiveSelected.intake.case_id} sourceId={archiveSelected.source.id} filename={archiveSelected.source.filename} /><IconButton icon="repeat" label={`Повторить обработку ${archiveSelected.source.filename}`} disabled={busy || pending.length > 0} onClick={() => select(archiveSelected, true)} />{canEdit && <IconButton icon="trash" danger label={`Удалить ${archiveSelected.source.filename}`} disabled={busy || pending.length > 0} onClick={() => askDelete(archiveSelected)} />}</>}
            renderList={(active, choose) => <Table scrollActive={active} showHeader={false} showCaption={false} caption="Архив обработок" rows={archivePage?.items ?? []} rowId={row => row.intake.id}
              selectedRowIds={archiveSelected ? new Set([archiveSelected.intake.id]) : undefined} state={!archivePage ? 'loading' : archivePage.items.length ? 'ready' : 'empty'} onRowClick={choose}
              columns={[{ key: 'processing', label: 'Обработка', render: row => <ArchiveEntryButton filename={row.source.filename} date={workDate(row)} dateTime={row.intake.worked_at ?? row.intake.created_at} partner={partnerOf(row)} selected={archiveSelected?.intake.id === row.intake.id} intakeId={row.intake.id} onSelect={() => choose(row)} /> }]}
              pagination={<Pagination showFilter={false} key={listEpoch.current} initialAfter={archiveAfter.current} showEndStatus={false} label="Архив обработок" next={archivePage?.next_cursor} disabled={!active || busy || pending.length > 0 || resultDirty}
                load={async after => ({ ...await api.intakes(after == null ? undefined : String(after)), after })} onLoad={page => { archiveAfter.current = page.after == null ? undefined : String(page.after); setArchivePage(page); setItems(previous => [...page.items, ...previous.filter(item => !page.items.some(row => row.intake.id === item.intake.id) && (sessionIds.includes(item.intake.id) || item.intake.id === selectedRef.current?.intake.id))]); }} />} />}
            renderDetail={(owner, active) => archiveSelected?.revision ? <ResultPanel key={archiveSelected.intake.id} mode="archive" readOnly intake={archiveSelected} session={session} scrollOwner={owner} disabled={!active || busy || pending.length > 0} onDirty={updateResultDirty} mutate={mutate} directMutation={directMutation} /> : archiveSelected && <p role="status">{label(archiveSelected)}</p>} />
        </section>
      </>}
      {section === 'marking' && sessionIds.length > 1 && <div className="actions" aria-label="Файлы текущей обработки">{items.filter(item => sessionIds.includes(item.intake.id)).map(item => <Button key={item.intake.id} aria-pressed={selected?.intake.id === item.intake.id} onClick={() => select(item)}>{item.source.filename}</Button>)}</div>}
      {section === 'marking' && selected && <section className="hub-section marking-processing" aria-label="Текущая обработка">{!selected.revision && <>{fileConfiguration()}<p>{label(selected)}</p></>}
        {selected.job?.error && <Alert title={selected.job.state === 'QUEUED' ? 'Ожидает доступных ресурсов' : 'Ошибка обработки'} tone="warning"><p>{string(selected.job.error.message) ?? 'Сервер сообщил об ошибке обработки.'}</p><p>{selected.job.state === 'QUEUED' ? 'Сервер повторит запуск после освобождения места. Если ожидание затянулось, попробуйте повторить обработку позже.' : 'Исходный файл сохранён. Проверьте причину перед повторной обработкой.'}</p>{selected.job.state === 'FAILED' && <Button disabled={!canEdit || busy || selectedPending} onClick={() => void saveDecisions({})}>Повторить оценку файла</Button>}</Alert>}
        {selected.version.decisions.operation !== 'REPAIR' && selected.assessment?.result.operation !== 'REPAIR' && (selected.version.decisions.operation === 'STATUS' || selected.assessment?.result.operation === 'STATUS') && <ReturnPanel compact restoredRetry={restoredRetry} key={`${selected.intake.id}-${recoveryReset}`} intake={selected} session={session} disabled={busy || selectedPending || decisionDirty} onDirty={updateResultDirty} mutate={mutate} directMutation={directMutation} />}
        {selected.revision && <ResultPanel key={`${selected.intake.id}-${recoveryReset}`} intake={selected} session={session} disabled={busy || selectedPending || decisionDirty} onDirty={updateResultDirty} mutate={mutate} directMutation={directMutation} operationPending={id => pendingRef.current.some(value => value.id === id)} onProcessed={() => refreshSelected(undefined, true)} onBackToUpload={newProcessing} onStepChange={setWorkflowStep} configuration={fileConfiguration} backHost={backHost} />}
        {!selected.revision && !selected.assessment?.questions.length && !selected.job?.error && <p role="status">Проверяем файл и готовим результаты…</p>}
      </section>}
    </>}
  </main>{deleteTarget && <ConfirmDialog title={`Удалить обработку файла «${deleteTarget.source.filename}»?`} busy={busy || pending.length > 0} onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void changeArchive(deleteTarget)} />}{processing && <ProcessingDialog filename={activeProcessing[0]?.source.filename ?? pending.find(value => value.action === 'intake.upload')?.filename ?? chosenFiles[0]?.name ?? 'Исходный файл'} percent={currentProgress.percent} stage={currentProgress.stage} count={Math.max(activeProcessing.length, uploading ? chosenFiles.length : 0, 1)} error={pollError || (activeUpload && !uploading ? error : '')} onRefresh={() => { void refreshSelected().then(() => list()).then(() => setPollError('')).catch(value => { setPollError(errorText(value)); showError(value); }); }} />}</div>;
}
