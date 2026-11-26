import { SourceDownload } from '../../components/SourceDownload';
import { useEffect, useRef, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { errorText } from '../hub/model';
import { Backfill } from '../results/Backfill';
import { EvidenceTable } from '../results/ExternalPanel';
import { date, stateLabels, values, type DirectMutation } from '../results/model';

export function RegistryPanel({ session, disabled, onDirty, directMutation }: { session: Api['SessionState']; disabled: boolean; onDirty: (value: boolean) => void; directMutation: DirectMutation }) {
  const [loaded, setLoaded] = useState<{ generation: string; page: Api['RegistryPage'] }>();
  const [kind, setKind] = useState<Api['RegistryEntryState']['kind'] | ''>('');
  const [state, setState] = useState<Api['RegistryEntryState']['external_state'] | ''>('');
  const [entry, setEntry] = useState<Api['RegistryEntryState']>();
  const [sources, setSources] = useState<Api['RegistrySourcePage']>(), [events, setEvents] = useState<Api['EvidencePage']>();
  const [reason, setReason] = useState(''), [chosen, setChosen] = useState(''), [included, setIncluded] = useState<string[]>([]);
  const [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const generation = `${kind}-${state}-${refresh}`;
  const currentGeneration = useRef(generation); currentGeneration.current = generation;
  const page = loaded?.generation === generation ? loaded.page : undefined;
  const dirty = !!reason || !!chosen || !!included.length;
  const canEdit = session.user?.permissions.includes('case.edit') ?? false;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { let live = true; setError(''); void api.registry(kind, state).then(value => { if (live && currentGeneration.current === generation) setLoaded({ generation, page: value }); }).catch(e => { if (live && currentGeneration.current === generation) setError(errorText(e)); }); return () => { live = false; }; }, [kind, state, refresh, generation]);
  async function open(value: Api['RegistryEntryState']) {
    if (dirty) { setError('Сохраните решение о конфликте или отмените ввод перед выбором записи.'); return; }
    try { const [s, e] = await Promise.all([api.registrySources(value.id), api.registryEvidence(value.id)]); setEntry(value); setSources(s); setEvents(e); setError(''); } catch (e) { setError(errorText(e)); }
  }
  async function resolve() {
    if (!entry || !page || !chosen || !reason.trim() || !included.includes(chosen)) { setError('Отметьте все действующие противоречащие свидетельства, выберите подтверждённое и укажите основание сверки.'); return; }
    if (await directMutation({ kind: 'resolution', body: { operation_id: crypto.randomUUID(), entry_id: entry.id, evidence_ids: included, chosen_event_id: chosen, expected_snapshot_version: page.snapshot_version, reason } })) { setReason(''); setChosen(''); setIncluded([]); setEntry(undefined); setRefresh(n => n + 1); }
  }
  return <section className="hub-section" data-testid="registry-panel"><h2 className="block-title">Реестр подготовленных и применённых данных</h2>
    <div className="action-strip"><Button disabled={disabled} onClick={() => setRefresh(n => n + 1)}>Перечитать внешнее состояние</Button></div>
    <p>Число подготовленных версий не означает загрузку во внешнюю систему. Значения в списке взяты из сохранённого источника; все версии доступны в происхождении записи.</p>
    {canEdit && <Backfill csrf={session.csrf_token} onProgress={() => setRefresh(n => n + 1)} />}
    {error && <Alert title="Реестр требует внимания" tone="warning"><p>{error}</p><Button onClick={() => setRefresh(n => n + 1)}>Обновить реестр, сохранив ввод</Button></Alert>}
    <FormSection title="Отбор записей" titleLevel={3}><FormGrid>
      <FormField id="registry-kind" label="Тип записи">{props => <Select {...props} disabled={dirty} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setEntry(undefined); }}><option value="">Все типы</option><option value="CLIENT">Клиенты</option><option value="LABEL">Этикетки</option><option value="ASSIGNMENT">Назначения номеров</option></Select>}</FormField>
      <FormField id="registry-state" label="Внешнее состояние">{props => <Select {...props} disabled={dirty} value={state} onChange={e => { setState(e.target.value as typeof state); setEntry(undefined); }}><option value="">Все состояния</option>{['UNKNOWN', 'APPLIED', 'DELETED', 'REJECTED', 'CONFLICT'].map(value => <option key={value} value={value}>{stateLabels[value]}</option>)}</Select>}</FormField>
    </FormGrid></FormSection>
    {page && !page.complete && <p>Реестр ещё неполон: не завершено файлов {page.incomplete_artifacts}. Уже показанные сведения сохранены.</p>}
    <Table key={generation} caption="Реестр" rows={page?.items ?? []} rowId={row => row.id} state={!page ? error ? 'error' : 'loading' : page.items.length ? 'ready' : error ? 'error' : 'empty'} error={error} columns={[
      { key: 'values', label: 'ИНН, этикетка или номер', render: row => <Button onClick={() => void open(row)}>{values(row.display_values)}</Button> },
      { key: 'prepared', label: 'Подготовлено версий', render: row => row.prepared_count }, { key: 'external', label: 'Внешний результат', render: row => stateLabels[row.external_state] },
    ]} pagination={<Pagination key={generation} label="Реестр" next={page?.next_cursor} disabled={disabled || dirty || !page} load={after => api.registry(kind, state, after == null ? undefined : String(after))} onLoad={value => { if (currentGeneration.current === generation) setLoaded({ generation, page: value }); }} />} />
    {entry && <section className="hub-section"><h3>Происхождение: {values(entry.display_values)}</h3>
      <Table caption="Подготовленные версии этой записи" rows={sources?.items ?? []} rowId={row => row.id} columns={[
        { key: 'value', label: 'Значения', render: row => values(row.values) }, { key: 'state', label: 'Состояние именно этой версии', render: row => stateLabels[row.evidence_state] },
        { key: 'source', label: 'Происхождение', render: row => <><SourceDownload caseId={row.case_id} sourceId={row.source_asset_id} label="Скачать исходный файл" /><details><summary>Точная версия и строка</summary><p>Строка CSV {row.ordinal}; ревизия {row.revision_id}; файл {row.artifact_id}</p></details></> },
      ]} pagination={<Pagination key={`sources-${entry.id}`} label="Источники записи" next={sources?.next_cursor} disabled={disabled} load={after => api.registrySources(entry.id, after == null ? undefined : String(after))} onLoad={setSources} />} />
      <EvidenceTable events={events} pagination={<Pagination key={`events-${entry.id}`} label="История записи" next={events?.next_cursor} disabled={disabled} load={after => api.registryEvidence(entry.id, after == null ? undefined : String(after))} onLoad={setEvents} />} />
      {entry.external_state === 'CONFLICT' && <><FormSection data-form="registry-resolution" title="Разрешить противоречие" titleLevel={3}><p>Выберите все действующие противоречащие свидетельства и одно подтверждённое внешней сверкой. Исторические записи сохранятся. Сервер проверит состав и актуальность решения.</p>
        <fieldset className="check-options"><legend>Свидетельства для сверки</legend>{events?.items.map(event => <label key={event.id}><input type="checkbox" disabled={disabled || !canEdit} checked={included.includes(event.id)} onChange={() => setIncluded(previous => previous.includes(event.id) ? previous.filter(id => id !== event.id) : [...previous, event.id])} />{stateLabels[event.outcome]} · {event.reason} · {date(event.created_at)}</label>)}</fieldset>
        <FormField id="resolution-chosen" label="Подтверждённое свидетельство">{props => <Select {...props} disabled={disabled || !canEdit} value={chosen} onChange={e => setChosen(e.target.value)}><option value="">Выберите</option>{events?.items.map(event => <option key={event.id} value={event.id}>{stateLabels[event.outcome]} · {event.reason} · {date(event.created_at)}</option>)}</Select>}</FormField>
        <FormField id="resolution-reason" label="Основание сверки" required>{props => <Textarea {...props} disabled={disabled || !canEdit} value={reason} onChange={e => setReason(e.target.value)} />}</FormField>
      </FormSection>
      <div className="action-strip"><Button disabled={disabled || !canEdit} onClick={() => void resolve()}>Сохранить решение о конфликте</Button></div></>}
      {dirty && <div className="action-strip"><Button disabled={disabled} onClick={() => { setReason(''); setChosen(''); setIncluded([]); }}>Отменить ввод сверки</Button></div>}
    </section>}
  </section>;
}
