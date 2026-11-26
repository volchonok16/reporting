import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { errorText } from '../hub/model';
import { AttemptPicker } from './AttemptPicker';
import { Backfill } from './Backfill';
import { attemptLabel, date, stateLabels, values, type DirectMutation } from './model';

type Props = { artifact: Api['ArtifactState']; bundle: Api['ArtifactSetState']; session: Api['SessionState']; disabled: boolean; onDirty: (value: boolean) => void; directMutation: DirectMutation; initialAttempt?: string; onEvidence?: () => void };
export function ExternalPanel({ artifact, bundle, session, disabled, onDirty, directMutation, initialAttempt, onEvidence }: Props) {
  const [attempts, setAttempts] = useState<Api['ExternalAttemptPage']>();
  const [attempt, setAttempt] = useState<Api['ExternalAttemptState']>();
  const [events, setEvents] = useState<Api['EvidencePage']>();
  const [rows, setRows] = useState<Api['ExportRowPage']>();
  const [reason, setReason] = useState(''), [sentReason, setSentReason] = useState('');
  const [predecessors, setPredecessors] = useState<Api['ExternalAttemptState'][]>([]);
  const [outcome, setOutcome] = useState<Api['EvidenceBody']['outcome']>('UNKNOWN');
  const [coverage, setCoverage] = useState<Api['EvidenceBody']['coverage']>('FILE');
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [indexRefresh, setIndexRefresh] = useState(0);
  const evidenceRead = useRef(0), activeAttempt = useRef<string | undefined>(undefined);
  activeAttempt.current = attempt?.id;
  const dirty = touched || !!reason || !!sentReason || !!predecessors.length || !!selected.length;
  const canEdit = session.user?.permissions.includes('case.edit') ?? false;
  const locked = disabled || !canEdit;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    let live = true;
    void Promise.all([api.attempts(artifact.id), initialAttempt ? api.attempt(initialAttempt) : Promise.resolve(undefined)]).then(([a, chosen]) => { if (live) { setError(''); setAttempts(a); if (chosen) setAttempt(chosen); } }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [artifact.id, refresh, initialAttempt]);
  useEffect(() => {
    let live = true;
    void api.exportRows(artifact.id).then(value => { if (live) setRows(value); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [artifact.id, refresh, indexRefresh]);
  useEffect(() => {
    setEvents(undefined);
    if (attempt) void readEvidence(attempt.id);
    return () => { evidenceRead.current += 1; };
  }, [attempt?.id, refresh, indexRefresh]);
  async function readEvidence(attemptId: string, after?: string | null) {
    const generation = ++evidenceRead.current;
    const current = () => generation === evidenceRead.current && activeAttempt.current === attemptId;
    try { const value = await api.externalEvidence(attemptId, after); if (current()) { setEvents(value); setError(''); } }
    catch (e) { if (current()) setError(errorText(e)); }
  }
  function choose(value: Api['ExternalAttemptState']) { if (dirty) { setError('Сохраните результат или отмените ввод перед выбором другой отправки.'); return; } if (activeAttempt.current === value.id) return; evidenceRead.current += 1; activeAttempt.current = value.id; setAttempt(value); setEvents(undefined); }
  async function sent() {
    if (!sentReason.trim()) { setError('Укажите основание и обстоятельства отправки конкретного CSV.'); return; }
    if (await directMutation({ kind: 'attempt', body: { operation_id: crypto.randomUUID(), artifact_id: artifact.id, artifact_set_id: bundle.artifact_set_id!, manifest_hash: bundle.manifest_hash!, reason: sentReason, predecessor_ids: predecessors.map(value => value.id) } })) { setSentReason(''); setPredecessors([]); setRefresh(n => n + 1); }
  }
  async function save() {
    if (!attempt || !reason.trim()) { setError('Выберите сохранённую отправку и укажите основание результата.'); return; }
    if (coverage === 'ROWS' && !selected.length) { setError('Выберите точные строки файла, к которым относится результат.'); return; }
    if (await directMutation({ kind: 'evidence', attemptId: attempt.id, body: { operation_id: crypto.randomUUID(), outcome, coverage: outcome === 'PARTIAL' ? 'UNKNOWN' : coverage, export_row_ids: coverage === 'ROWS' && outcome !== 'PARTIAL' ? selected : [], reason, origin: 'MANUAL', expected_snapshot_version: rows?.snapshot_version } })) { setReason(''); setSelected([]); setTouched(false); setRefresh(n => n + 1); onEvidence?.(); }
  }
  return <section className="hub-section" data-testid="external-panel">
    <h3 className="block-title">Внешняя загрузка: {artifact.role}</h3><p>{artifact.download_filename}</p>
    <div className="action-strip"><Button disabled={disabled} onClick={() => setRefresh(n => n + 1)}>Обновить внешние сведения, сохранив ввод</Button></div>
    <p>Подготовка и скачивание не подтверждают применение. Запишите отправку, затем её известный результат. Противоречия сохраняются для сверки в реестре.</p>
    {canEdit && <Backfill csrf={session.csrf_token} artifactId={artifact.id} onProgress={() => setIndexRefresh(n => n + 1)} />}
    {error && <Alert title="Проверьте внешние сведения" tone="warning"><p>{error}</p><Button onClick={() => setRefresh(n => n + 1)}>Обновить сведения, сохранив ввод</Button></Alert>}
    <details><summary>Файл отправлен — записать новую отправку</summary><div className="hub-group"><FormSection data-form="external-attempt" title="Новая отправка" titleLevel={3}>
      <FormField id="sent-reason" label="Основание отправки" required>{props => <Textarea {...props} disabled={locked} value={sentReason} onChange={e => setSentReason(e.target.value)} />}</FormField>
      <p>Если файл применялся после других файлов, укажите их реальные отправки. Для загрузки соблюдайте CLIENTS → DOGTAGS → NUMBERS; при изменении сначала DELETE.</p>
      {predecessors.length > 0 && <ul>{predecessors.map(value => <li key={value.id}>{attemptLabel(value)} <Button disabled={locked} onClick={() => setPredecessors(previous => previous.filter(p => p.id !== value.id))}>Убрать связь</Button></li>)}</ul>}
      </FormSection>
      <details><summary>Предшествующие отправки</summary><AttemptPicker multiple selected={predecessors.map(value => value.id)} disabled={locked} onSelect={value => setPredecessors(previous => previous.some(p => p.id === value.id) ? previous.filter(p => p.id !== value.id) : [...previous, value])} /></details>
      <div className="action-strip"><Button disabled={locked || !!reason || !!selected.length} onClick={() => void sent()}>Файл отправлен</Button></div>
    </div></details>
    <Table caption={`Отправки ${artifact.role}`} rows={attempts?.items ?? []} rowId={row => row.id} state={!attempts ? 'loading' : attempts.items.length ? 'ready' : 'empty'} columns={[{ key: 'date', label: 'Когда и почему', render: row => `${date(row.created_at)} · ${row.reason}` }, { key: 'open', label: 'Результат', render: row => <Button aria-pressed={attempt?.id === row.id} onClick={() => choose(row)}>Открыть результат отправки</Button> }]} pagination={<Pagination key={`attempts-${artifact.id}-${refresh}`} label={`Отправки ${artifact.role}`} next={attempts?.next_cursor} disabled={disabled || dirty} load={after => api.attempts(artifact.id, after == null ? undefined : String(after))} onLoad={setAttempts} />} />
    {attempt && <><p>Выбрана отправка: {date(attempt.created_at)} · {attempt.reason}</p>
      <EvidenceTable events={events} pagination={<Pagination key={`evidence-${attempt.id}-${refresh}-${indexRefresh}`} label="Сведения о загрузке" next={events?.next_cursor} disabled={disabled} load={after => api.externalEvidence(attempt.id, after == null ? undefined : String(after))} onLoad={setEvents} />} />
      <FormSection data-form="external-evidence" title="Записать результат загрузки" titleLevel={3}><FormGrid>
        <FormField id="external-outcome" label="Известный результат">{props => <Select {...props} disabled={locked} value={outcome} onChange={e => { setTouched(true); setOutcome(e.target.value as typeof outcome); if (['APPLIED', 'REJECTED'].includes(e.target.value) && coverage === 'UNKNOWN') setCoverage('FILE'); if (e.target.value === 'PARTIAL') setCoverage('UNKNOWN'); }}><option value="UNKNOWN">Результат пока неизвестен</option><option value="APPLIED">Загружено полностью в указанном покрытии</option><option value="REJECTED">Вернулся с ошибкой</option><option value="PARTIAL">Частично, точные строки неизвестны</option></Select>}</FormField>
        <FormField id="external-coverage" label="К каким строкам относится" help="Частичный результат без списка строк не подтверждает успех ни одной записи.">{props => <Select {...props} disabled={locked || outcome === 'PARTIAL'} value={coverage} onChange={e => { setTouched(true); setCoverage(e.target.value as typeof coverage); }}><option value="FILE">Весь этот CSV</option><option value="ROWS">Только выбранные строки</option>{(outcome === 'UNKNOWN' || outcome === 'PARTIAL') && <option value="UNKNOWN">Покрытие неизвестно</option>}</Select>}</FormField>
      </FormGrid>
      <FormField id="external-reason" label="Основание внешнего результата" required help={`Автор: ${session.user?.username}. Сохраняется вместе с временем и точным покрытием.`}>{props => <Textarea {...props} disabled={locked} value={reason} onChange={e => setReason(e.target.value)} />}</FormField>
      <p>Выбрано строк: {selected.length}. Остальные строки сохранят собственное состояние.</p>
      </FormSection>
      <div className="action-strip"><Button disabled={locked || !!sentReason || !!predecessors.length} onClick={() => void save()}>Записать результат загрузки</Button></div>
    </>}
    <Table caption={`Точные строки ${artifact.role}`} rows={rows?.items ?? []} rowId={row => row.id} state={!rows ? 'loading' : rows.items.length ? 'ready' : 'empty'} columns={[
      { key: 'row', label: 'Строка', render: row => row.ordinal }, { key: 'values', label: 'Выданные значения', render: row => values(row.values) },
      { key: 'state', label: 'Сведения об этой версии', render: row => `${stateLabels[row.evidence_state]} · ${stateLabels[row.coverage_state]}` },
      { key: 'select', label: 'Покрытие', render: row => <Button disabled={locked || coverage !== 'ROWS'} aria-pressed={selected.includes(row.id)} onClick={() => setSelected(previous => previous.includes(row.id) ? previous.filter(id => id !== row.id) : [...previous, row.id])}>{selected.includes(row.id) ? 'Убрать строку' : 'Выбрать строку'}</Button> },
    ]} pagination={<Pagination key={`rows-${artifact.id}-${refresh}-${indexRefresh}`} label={`Строки ${artifact.role}`} next={rows?.next_cursor} disabled={disabled} load={after => api.exportRows(artifact.id, Number(after ?? 0))} onLoad={setRows} />} />
    {rows && !rows.complete && <p>Индекс ещё неполон: {rows.indexed_rows} из {rows.expected_rows}. Неизвестные строки не считаются успешными.</p>}

    {dirty && <div className="action-strip"><Button disabled={disabled} onClick={() => { setReason(''); setSentReason(''); setPredecessors([]); setSelected([]); setTouched(false); }}>Отменить ввод внешнего результата</Button></div>}
    {attempt && <details><summary>Технические сведения отправки</summary><pre className="hub-json">{JSON.stringify(attempt, null, 2)}</pre></details>}
  </section>;
}
export function EvidenceTable({ events, pagination }: { events?: Api['EvidencePage']; pagination?: ReactNode }) {
  return <Table caption="Сохранённые внешние сведения" rows={events?.items ?? []} rowId={row => row.id} state={!events ? 'loading' : events.items.length ? 'ready' : 'empty'} columns={[
    { key: 'outcome', label: 'Результат и покрытие', render: row => `${stateLabels[row.outcome]} · ${row.coverage === 'FILE' ? 'Весь CSV' : row.coverage === 'ROWS' ? 'Точные строки' : 'Покрытие неизвестно'} · ${row.covered_rows} строк` },
    { key: 'reason', label: 'Основание', render: row => row.reason }, { key: 'origin', label: 'Происхождение', render: row => <>{row.origin === 'MANUAL' ? 'Ручное подтверждение' : 'Связанный возврат'} · {date(row.created_at)}<details><summary>Автор и связь</summary><p>Автор: {row.author_id}</p><p>Возврат: {row.return_assessment_id ?? 'Не относится к системному возврату'}</p><p>Свидетельство: {row.id}</p></details></> },
  ]} pagination={pagination} />;
}
