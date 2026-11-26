import { useEffect, useRef, useState } from 'react';
import { api, object, string, type Api, type Correction, type Revision } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Input, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { RecordEditor } from '../hub/RecordEditor';
import { errorText } from '../hub/model';
import { ResultPanel } from '../intake/ResultPanel';
import { mappingOf, type Intake } from '../intake/model';
import { ExternalPanel } from './ExternalPanel';
import { date, preparationLabels, stateLabels, values, type DirectMutation, type Mutate } from './model';

type Props = { compact?: boolean; restoredRetry?: string; intake: Intake; session: Api['SessionState']; disabled: boolean; onDirty: (value: boolean) => void; mutate: Mutate; directMutation: DirectMutation };
export function ReturnPanel({ compact = false, restoredRetry, intake, session, disabled, onDirty, mutate, directMutation }: Props) {
  const id = intake.intake.id;
  const [detail, setDetail] = useState<Api['ReturnDetailWithRetryTarget']>();
  const [rows, setRows] = useState<Api['ReturnRowPage']>();
  const [history, setHistory] = useState<Api['ReturnHistoryPage']>(), [retries, setRetries] = useState<Api['RetryHistoryPage']>();
  const [assessmentId, setAssessmentId] = useState<string>();
  const [retry, setRetry] = useState<Api['RetryDetail']>(), [retryRevision, setRetryRevision] = useState<Revision>();
  const [sourceRevision, setSourceRevision] = useState<Revision>(), [sourceRecords, setSourceRecords] = useState<Api['RecordPage']>();
  const [stageRows, setStageRows] = useState<Api['ExportRowPage']>();
  const [edit, setEdit] = useState<Api['RecordDetail']>(), [editKey, setEditKey] = useState(0);
  const [corrections, setCorrections] = useState<Correction[]>([]), [editorDirty, setEditorDirty] = useState(false);
  const [reason, setReason] = useState(''), [successReasons, setSuccessReasons] = useState<Record<string, string>>({});
  const [external, setExternal] = useState<{ artifact: Api['ArtifactState']; bundle: Api['ArtifactSetState'] }>();
  const [externalDirty, setExternalDirty] = useState(false), [resultDirty, setResultDirty] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const dirty = !!reason || !!corrections.length || editorDirty || Object.keys(successReasons).length > 0 || externalDirty || resultDirty;
  const generation = useRef(0), rowsGeneration = useRef(0);
  const live = useRef(true), currentRetry = useRef<string | undefined>(undefined); currentRetry.current = retry?.revision_id;
  const canEdit = session.user?.permissions.includes('case.edit') ?? false;
  const target = detail?.retry_target;
  const recordRevision = retry?.revision_id ?? target?.source_revision_id;
  const stageScope = (retry?.correction_scope ?? target?.correction_scope) === 'stage_export_rows';
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { live.current = true; return () => { live.current = false; ++generation.current; ++rowsGeneration.current; }; }, []);
  function invalidateDetail(clear = false) {
    ++generation.current; ++rowsGeneration.current; setRows(undefined);
    if (clear) { setDetail(undefined); setSourceRevision(undefined); setSourceRecords(undefined); setStageRows(undefined); setEdit(undefined); }
  }
  function refreshDetail() { invalidateDetail(); setRefresh(n => n + 1); }
  function selectAssessment(value?: string) { invalidateDetail(true); setAssessmentId(value); setRefresh(n => n + 1); }
  async function readRows(assessment: string, after = 0) {
    const current = generation.current, request = ++rowsGeneration.current;
    try {
      const value = await api.returnRows(id, assessment, after);
      if (live.current && current === generation.current && request === rowsGeneration.current) setRows(value);
    } catch (e) { if (live.current && current === generation.current && request === rowsGeneration.current) setError(errorText(e)); }
  }
  useEffect(() => {
    const current = ++generation.current; ++rowsGeneration.current; setRows(undefined);
    async function loadDetail() {
      const [d, h, r] = await Promise.all([api.returnDetail(id, assessmentId), api.returnHistory(id), api.retryHistory(id)]);
      if (!live.current || current !== generation.current) return;
      setDetail(d); setHistory(h); setRetries(r);
      if (d.assessment) await readRows(d.assessment.id);
    }
    void loadDetail().catch(e => { if (live.current && current === generation.current) setError(errorText(e)); });
    return () => { ++generation.current; ++rowsGeneration.current; };
  }, [id, intake.assessment?.id, assessmentId, refresh]);
  useEffect(() => {
    setExternal(undefined); setEdit(undefined);
    if (retry && detail?.assessment && retry.retry.assessment_id !== detail.assessment.id) {
      setRetry(undefined); setRetryRevision(undefined);
    }
  }, [detail?.assessment?.id]);
  useEffect(() => {
    if (!target || !recordRevision) return;
    let active = true; const current = generation.current;
    void Promise.all([api.revision(target.case_id, recordRevision),
      stageScope && !retry ? Promise.resolve(undefined) : api.records(target.case_id, recordRevision),
    ]).then(([revision, records]) => {
      if (active && current === generation.current) { setSourceRevision(revision); setSourceRecords(records); }
    }).catch(e => { if (active && current === generation.current) setError(errorText(e)); });
    if (stageScope && !retry && detail?.assessment) void api.exportRows(detail.assessment.artifact_id).then(value => { if (active && current === generation.current) setStageRows(value); }).catch(e => { if (active && current === generation.current) setError(errorText(e)); });
    return () => { active = false; };
  }, [target?.source_revision_id, recordRevision, stageScope, retry?.revision_id, retry?.state, detail]);
  useEffect(() => {
    if (!retry) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api.retryDetail(id, currentRetry.current!, retryAfter);
        const revision = await api.revision(value.case_id, value.revision_id);
        if (active) { setRetry(value); setRetryRevision(revision); }
      } catch (e) { if (active) setError(errorText(e)); }
      if (active) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [id, retry?.revision_id, retryAfter]);
  async function read<T>(work: Promise<T>, update: (value: T) => void) { const current = generation.current; try { const value = await work; if (live.current && current === generation.current) { update(value); setError(''); } } catch (e) { if (live.current && current === generation.current) setError(errorText(e)); } }
  function canSwitch() { if (dirty) { setError('Сохраните или отмените введённые исправления и основания перед переходом.'); return false; } return true; }
  async function openRetry(revisionId: string) {
    if (!canSwitch()) return;
    try { const value = await api.retryDetail(id, revisionId); const revision = await api.revision(value.case_id, revisionId); setRetry(value); setRetryAfter(0); setRetryRevision(revision); setEdit(undefined); setExternal(undefined); if (value.retry.assessment_id !== detail?.assessment?.id) selectAssessment(value.retry.assessment_id); const url = new URL(location.href); url.searchParams.set('retry', revisionId); window.history.replaceState(null, '', url); } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { const saved = restoredRetry ?? new URLSearchParams(location.search).get('retry'); if (saved) void openRetry(saved); }, [id, restoredRetry]);
  async function openRecord(record: Api['RecordState']) {
    if (editorDirty || externalDirty || resultDirty) { setError('Сначала сохраните или отмените текущий ввод.'); return; }
    if (target && recordRevision) await read(api.record(target.case_id, recordRevision, record.record_id, record.ordinal), setEdit);
  }
  function openStage(row: Api['ExportRowState']) {
    if (editorDirty) { setError('Добавьте исправление текущей записи или отмените его.'); return; }
    setEdit({ revision_id: target!.source_revision_id, source_asset_id: target!.source_asset_id, issues_available: true, issues: [], corrections: [], record: { record_id: row.id, ordinal: row.ordinal, page_index: row.ordinal, line_start: row.ordinal + 1, line_end: row.ordinal + 1, raw_cells: [row.values.MSISDN], effective: { MSISDN: row.values.MSISDN }, disposition: 'included', duplicate_kind: '' } });
  }
  function discard() { setReason(''); setSuccessReasons({}); setCorrections([]); setEditorDirty(false); setEdit(undefined); }
  async function prepare() {
    if (!detail?.assessment || !target?.expected_revision_id || editorDirty || externalDirty || resultDirty) return;
    if (!reason.trim()) { setError('Укажите основание повторной подготовки.'); return; }
    if (Object.values(successReasons).some(value => !value.trim())) { setError('Для каждой успешной строки нужно отдельное основание повторной отправки либо уберите её из выбора.'); return; }
    const ok = await mutate({ action: 'return.retry', intakeId: id, caseId: target.case_id, body: {
      operation_id: crypto.randomUUID(), assessment_id: detail.assessment!.id, expected_revision_id: target.expected_revision_id!, expected_snapshot_version: detail.snapshot_version,
      retry_revision_id: retry?.revision_id, reason, corrections, success_reasons: successReasons,
    } });
    if (ok) {
      discard(); onDirty(false);
      try {
        const head = await api.case(target.case_id);
        if (head.head_revision_id) { const value = await api.retryDetail(id, head.head_revision_id); setRetry(value); setRetryAfter(0); setRetryRevision(await api.revision(value.case_id, value.revision_id)); const url = new URL(location.href); url.searchParams.set('retry', value.revision_id); window.history.replaceState(null, '', url); }
        refreshDetail();
      } catch (e) { setError(errorText(e)); }
    }
  }
  async function showEvidence() {
    if (!canSwitch() || !detail?.assessment || !target) return;
    try { const bundle = await api.artifacts(target.case_id, target.source_revision_id); const artifact = bundle.artifacts.find(value => value.id === detail.assessment!.artifact_id); if (artifact) setExternal({ bundle, artifact }); } catch (e) { setError(errorText(e)); }
  }
  const mapping = stageScope ? { MSISDN: 0 } : mappingOf(object(sourceRevision?.settings).mapping);
  return <section className="hub-section" data-testid="return-panel"><h2 className="block-title">Разбор возврата STATUS</h2><div className="action-strip"><Button disabled={disabled} onClick={() => refreshDetail()}>Перечитать связь и внешние результаты</Button></div>
    {error && <Alert title="Требуется сверка" tone="warning"><p>{error}</p><Button onClick={() => refreshDetail()}>Обновить возврат, сохранив ввод</Button></Alert>}
    {!detail?.assessment && <p>Выберите исходную отправку в уточнениях файла. После сохранения сервер сопоставит строки и покажет неизвестные результаты отдельно.</p>}
    {detail?.assessment && <><p>Сверка от {date(detail.assessment.created_at)}. {Object.entries(detail.assessment.counts).map(([key, value]) => `${stateLabels[key] ?? key}: ${value}`).join('; ')}</p>
      {detail.superseded_by && <Alert title="Сверка заменена" tone="warning"><p>Эта историческая связь пересмотрена: {detail.superseded_by.reason}. Повторная подготовка по ней недоступна.</p></Alert>}
      <p>Успешные строки не повторяются. Неизвестные, отсутствующие и противоречивые результаты требуют точной внешней сверки; они не дают разрешения повторить весь файл.</p>
      <Table caption="Строки возврата и точность сопоставления" rows={rows?.items ?? []} rowId={row => row.id} columns={[
        { key: 'row', label: 'Место и STATUS', render: row => <><p>Строка {row.ordinal}: {row.raw_status ?? '(нет в возврате)'}</p><details><summary>Исходные значения возврата</summary><p>{row.raw_cells.join(' · ')}</p><p>{row.reason}</p>{!compact && <p>Правило: {row.rule_version}</p>}</details></> },
        { key: 'raw', label: 'Результат распознавания', render: row => stateLabels[row.classification] }, { key: 'current', label: 'Подтверждения выбранной отправки', render: row => stateLabels[row.attempt_state] },
        { key: 'repeat', label: 'Отдельное основание успеха', render: row => row.export_row_id && row.attempt_state === 'APPLIED' && <>{row.export_row_id in successReasons ? <><FormField id={`repeat-${row.id}`} label={`Основание повтора успешной строки ${row.ordinal}`}>{props => <Input {...props} disabled={disabled} value={successReasons[row.export_row_id!]} onChange={e => setSuccessReasons(previous => ({ ...previous, [row.export_row_id!]: e.target.value }))} />}</FormField><Button disabled={disabled} onClick={() => setSuccessReasons(previous => { const next = { ...previous }; delete next[row.export_row_id!]; return next; })}>Не повторять успех</Button></> : <Button disabled={disabled || !canEdit} onClick={() => setSuccessReasons(previous => ({ ...previous, [row.export_row_id!]: '' }))}>Обосновать повтор успешной строки</Button>}</> },
      ]} pagination={<Pagination key={`return-${detail.assessment.id}-${refresh}`} label="Строки возврата" next={rows?.next_cursor} disabled={disabled || dirty} load={after => api.returnRows(id, detail.assessment!.id, Number(after ?? 0))} onLoad={setRows} />} /><div className="action-strip"><Button disabled={dirty} onClick={() => void showEvidence()}>Сверить неизвестные результаты</Button></div>
      {external && <ExternalPanel artifact={external.artifact} bundle={external.bundle} session={session} disabled={disabled || editorDirty || !!reason || !!corrections.length || resultDirty} onDirty={setExternalDirty} directMutation={directMutation} initialAttempt={detail.assessment.attempt_id} onEvidence={() => refreshDetail()} />}
      {target && <section className="hub-group" aria-labelledby="return-retry-title"><h3 id="return-retry-title" className="block-title">Исправить и подготовить повторно</h3><p>Редактируется {stageScope ? 'точный список MSISDN выданной стадии DELETE' : 'исходная версия данных выданного файла'}. Новая версия потребует проверки и подтверждения. Если номер уже применён, откройте исходную обработку, выберите назначение «Изменение» и подтвердите отдельный список старых номеров.</p>{!compact && sourceRevision && <p>Источник: {sourceRevision.source.filename}, версия {sourceRevision.sequence} от {date(sourceRevision.created_at)}.</p>}
        {!target.expected_revision_id && <Alert title="Исходный файл распознаётся" tone="warning"><p>Дождитесь завершения распознавания. Повтор пока недоступен.</p></Alert>}
        <details><summary>Исправления исходных записей</summary><div className="hub-group">
          {stageScope && !retry ? <Table caption="Номера выданной стадии DELETE" rows={stageRows?.items ?? []} rowId={row => row.id} columns={[{ key: 'value', label: 'MSISDN', render: row => row.values.MSISDN }, { key: 'edit', label: 'Исправление', render: row => <Button onClick={() => openStage(row)}>Исправить номер {row.ordinal}</Button> }]} pagination={<Pagination key={`stage-${detail.assessment?.artifact_id}-${refresh}`} label="Номера DELETE" next={stageRows?.next_cursor} disabled={disabled || editorDirty} load={after => api.exportRows(detail.assessment!.artifact_id, Number(after ?? 0))} onLoad={setStageRows} />} /> : <Table caption="Записи исходной версии для повтора" rows={sourceRecords?.items ?? []} rowId={row => row.record_id} columns={[{ key: 'value', label: 'Значения', render: row => values(row.effective) }, { key: 'edit', label: 'Исправление', render: row => <Button onClick={() => void openRecord(row)}>Исправить исходную запись {row.ordinal}</Button> }]} pagination={<Pagination key={`source-${recordRevision}-${refresh}`} label="Записи для исправления" next={sourceRecords?.next_cursor} disabled={disabled || editorDirty} load={after => api.records(target.case_id, recordRevision!, Number(after ?? 0))} onLoad={setSourceRecords} />} />}

          {edit && <RecordEditor compact={compact} key={`${edit.record.record_id}-${editKey}`} detail={edit} columns={stageScope ? ['MSISDN'] : sourceRecords?.columns ?? []} mapping={mapping} fields={target.role === 'DELETE' ? ['MSISDN'] : undefined} pending={corrections} enabled={canEdit && !disabled && !externalDirty && !resultDirty && !detail.superseded_by} onDirty={setEditorDirty} onStage={items => { setCorrections(previous => [...previous, ...items]); setEditorDirty(false); setEditKey(n => n + 1); }} onRepresentative={(record, ordinal) => { if (editorDirty) setError('Сначала добавьте исправления в черновик или отмените ввод.'); else void read(api.record(target.case_id, recordRevision!, record, ordinal), setEdit); }} />}
          {!!corrections.length && <Table caption="Исправления нового повтора" rows={corrections.map((item, index) => ({ ...item, index }))} rowId={row => String(row.index)} columns={[{ key: 'field', label: 'Строка / поле', render: row => `${row.ordinal} / ${row.field}` }, { key: 'before', label: 'Было', render: row => row.before }, { key: 'after', label: 'Стало', render: row => row.after }]} />}
        </div></details>
        <FormSection data-form="return-retry" aria-labelledby="return-retry-title"><FormField id="retry-reason" label="Основание повторной подготовки" required>{props => <Textarea {...props} disabled={disabled || !canEdit || externalDirty || resultDirty} value={reason} onChange={e => setReason(e.target.value)} />}</FormField></FormSection>
        <div className="action-strip"><Button disabled={disabled || !canEdit || !target.expected_revision_id || !!detail.superseded_by || editorDirty || externalDirty || resultDirty} onClick={() => void prepare()}>{retry ? 'Пересчитать повтор с сохранёнными исправлениями' : 'Исправить и подготовить повторно'}</Button>
        {(!!reason || !!corrections.length || editorDirty || Object.keys(successReasons).length > 0) && <Button disabled={disabled} onClick={discard}>Отменить ввод повторной подготовки</Button>}</div>
      </section>}
    </>}
    {retry && <section className="hub-section"><h3>{compact ? 'Исправленный комплект' : 'Повторная версия'}</h3><p>{retry.retry.reason}</p>{Object.keys(retry.retry.success_reasons).length > 0 && <p>В этой версии отдельно обосновано успешных строк: {Object.keys(retry.retry.success_reasons).length}. Для нового пересчёта подтвердите требуемые успешные строки заново.</p>}{retry.stale && <Alert title="Появились новые внешние сведения" tone="warning"><p>Этот повтор устарел. Подтверждение и скачивание требуют пересчёта и нового подтверждения. Ранее полученные файлы доступны в архиве.</p></Alert>}
      {!!retry.diagnostics.length && <Alert title="Что нужно решить до выпуска" tone="warning"><ul>{retry.diagnostics.map((item, index) => <li key={index}>{string(item.message) ?? string(item.reason) ?? string(item.code) ?? 'Сверьте внешний результат.'}</li>)}</ul></Alert>}
      <Table caption="Состав повтора — решение по каждой строке" rows={retry.items} rowId={row => row.export_row_id} columns={[{ key: 'values', label: 'Исходный экспорт', render: row => values(row.values) }, { key: 'state', label: 'Результат', render: row => stateLabels[row.state] }, { key: 'selected', label: 'В повторе', render: row => row.selected ? 'Включена' : 'Исключена' }, { key: 'reason', label: 'Причина', render: row => row.reason }]} pagination={<Pagination key={`retry-${retry.revision_id}-${refresh}`} label="Состав повтора" next={retry.next_cursor} disabled={disabled || editorDirty} load={async after => ({ value: await api.retryDetail(id, retry.revision_id, Number(after ?? 0)), after: Number(after ?? 0) })} onLoad={page => { setRetry(page.value); setRetryAfter(page.after); }} />} />
      {retryRevision && <ResultPanel intake={intake} selectedRevision={retryRevision} readOnly session={session} disabled={disabled || externalDirty || editorDirty || !!reason || !!corrections.length || Object.keys(successReasons).length > 0 || retry.stale} onDirty={setResultDirty} mutate={mutate} directMutation={directMutation} />}
      {!compact && <details><summary>Техническое происхождение повтора</summary><pre className="hub-json">{JSON.stringify({ source: retry.source_asset_id, snapshot: retry.retry, current: retry.current_evidence_watermark }, null, 2)}</pre></details>}
    </section>}
    {!compact && <details><summary>История сверок и повторных версий</summary><div className="hub-group">
      <Table caption="Сверки возврата" rows={history?.items ?? []} rowId={row => row.id} columns={[{ key: 'date', label: 'Время', render: row => date(row.created_at) }, { key: 'open', label: 'Версия связи', render: row => <Button onClick={() => { if (canSwitch()) { selectAssessment(row.id); setRetry(undefined); setRetryRevision(undefined); setExternal(undefined); } }}>Открыть сверку</Button> }]} pagination={<Pagination key={`history-${id}-${refresh}`} label="Сверки возврата" next={history?.next_cursor} disabled={disabled || dirty} load={after => api.returnHistory(id, after == null ? undefined : String(after))} onLoad={setHistory} />} /><div className="action-strip"><Button disabled={dirty} onClick={() => { selectAssessment(); }}>Текущая сверка</Button></div>
      <Table caption="Повторные версии возврата" rows={retries?.items ?? []} rowId={row => row.revision_id} columns={[{ key: 'date', label: 'Подготовка', render: row => `${date(row.created_at)} · ${preparationLabels[row.state] ?? 'Проверьте результат'} · ${row.stale ? 'Требует пересчёта' : 'Сведения актуальны'}` }, { key: 'open', label: 'Результат', render: row => <Button onClick={() => void openRetry(row.revision_id)}>Открыть повторную версию</Button> }]} pagination={<Pagination key={`versions-${id}-${refresh}`} label="Повторные обработки" next={retries?.next_cursor} disabled={disabled || dirty} load={after => api.retryHistory(id, after == null ? undefined : String(after))} onLoad={setRetries} />} />
    </div></details>}
  </section>;
}
