import { useEffect, useRef, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input } from '../../components/Controls';
import { Disclosure } from '../../components/Disclosure';
import { FormField } from '../../components/FormField';
import { FormGrid } from '../../components/FormGrid';
import { IconButton } from '../../components/IconButton';
import { Pagination } from '../../components/Pagination';
import { Table } from '../../components/Table';
import { errorText } from '../hub/model';
import { validateFields } from '../hub/validateFields';

type Entry = Api['WhitemavInnEntry'];
type Draft = Entry & { existing: boolean; originalName: string };

export function InnDirectory({ csrf, canEdit, onDirty }: { csrf: string; canEdit: boolean; onDirty: (value: boolean) => void }) {
  const [items, setItems] = useState<Entry[]>([]), [draft, setDraft] = useState<Draft>();
  const [deletion, setDeletion] = useState<Entry>();
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [page, setPage] = useState({ items: [] as Entry[], next_cursor: null as number | null });
  const alive = useRef(true), working = useRef(false);
  const dirty = !!draft && (draft.existing ? draft.company_name !== draft.originalName : !!draft.inn || !!draft.company_name);
  function accept(entries: Entry[]) {
    setItems(entries); setPage({ items: entries.slice(0, 500), next_cursor: entries.length > 500 ? 500 : null }); setLoaded(true);
  }
  async function load() {
    setBusy(true); setError('');
    try { const result = await api.whitemavInns(); if (alive.current) accept(result.entries); }
    catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  function open(entry?: Entry) {
    if (dirty || busy) return;
    setError(''); setMessage('');
    setDraft(entry ? { ...entry, existing: true, originalName: entry.company_name } : { inn: '', company_name: '', existing: false, originalName: '' });
  }
  async function save() {
    if (!draft || !canEdit || working.current) return;
    const issue = validateFields({ INN: draft.inn }, ['INN'])[0];
    if (issue) { setError(issue.message); return; }
    if (!draft.existing && items.some(item => item.inn === draft.inn)) { setError('Этот ИНН уже есть в справочнике. Откройте его редактирование, чтобы указать название компании.'); return; }
    working.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await (draft.existing ? api.nameWhitemavInn(csrf, draft.inn, draft.company_name) : api.addWhitemavInn(csrf, draft.inn, draft.company_name));
      if (alive.current) { accept(result.entries); setDraft(undefined); setMessage('Запись сохранена и доступна в процессе «Исключения из МАВ».'); }
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function remove() {
    if (!deletion || !canEdit || working.current) return;
    working.current = true; setBusy(true); setDeleteError('');
    try {
      const result = await api.deleteWhitemavInn(csrf, deletion.inn);
      if (alive.current) { accept(result.entries); setDraft(undefined); setDeletion(undefined); setError(''); setMessage('ИНН удалён из справочника.'); }
    } catch (e) { if (alive.current) setDeleteError(errorText(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  const editor = draft && <form className="mnemonic-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
    <FormGrid>
      <FormField id="directory-inn" label="ИНН" required help="10 или 12 цифр с корректными контрольными разрядами.">{props => <Input {...props} inputMode="numeric" maxLength={12} value={draft.inn} readOnly={draft.existing || !canEdit} disabled={busy} onChange={event => setDraft({ ...draft, inn: event.target.value })} />}</FormField>
      <FormField id="directory-company" label="Название компании">{props => <Input {...props} maxLength={500} value={draft.company_name} disabled={busy || !canEdit} onChange={event => setDraft({ ...draft, company_name: event.target.value })} />}</FormField>
    </FormGrid>
    <div className="actions"><Button type="submit" variant="primary" loading={busy} disabled={!canEdit || busy || !dirty || !draft.inn}>Сохранить</Button><Button disabled={busy} onClick={() => { setDraft(undefined); setError(''); }}>Закрыть</Button></div>
  </form>;
  return <section className="hub-section" aria-labelledby="inn-directory-title">
    <h2 id="inn-directory-title" className="block-title">ИНН</h2>
    <p>Ваш список компаний для процесса «Исключения из МАВ». Названия помогают выбрать ИНН и не добавляются в выходной CSV.</p>
    {message && <Alert title="Сохранено" tone="info"><p>{message}</p></Alert>}
    {error && <Alert title="Не удалось сохранить или загрузить ИНН" tone="danger"><p>{error}</p>{!loaded && <Button disabled={busy} onClick={() => void load()}>Повторить загрузку</Button>}</Alert>}
    {canEdit && <div className="actions"><Button disabled={!loaded || busy || dirty} onClick={() => open()}>Добавить ИНН</Button></div>}
    <Disclosure open={!!draft && !draft.existing}><div className="dictionary-new-entry">{draft && !draft.existing && editor}</div></Disclosure>
    <Table key={items.map(item => `${item.inn}:${item.company_name}`).join('|')} showCaption={false} caption="ИНН компаний" rows={page.items} rowId={row => row.inn} state={!loaded && busy ? 'loading' : !loaded && error ? 'error' : 'ready'} error={error} columns={[
      { key: 'inn', label: 'ИНН', render: row => <span className="technical-data">{row.inn}</span> },
      { key: 'company_name', label: 'Название компании', render: row => row.company_name || 'Название не указано' },
      ...(canEdit ? [{ key: 'actions', label: 'Действия', render: (row: Entry) => <div className="actions"><IconButton icon="edit" label={`Редактировать ИНН ${row.inn}`} aria-expanded={draft?.existing && draft.inn === row.inn} disabled={busy || dirty} onClick={() => draft?.existing && draft.inn === row.inn ? setDraft(undefined) : open(row)} /><IconButton icon="trash" danger label={`Удалить ИНН ${row.inn}`} disabled={busy || dirty} onClick={() => { setDeleteError(''); setDeletion(row); }} /></div> }] : []),
    ]} renderExpansion={row => <Disclosure open={!!draft?.existing && draft.inn === row.inn}>{draft?.existing && draft.inn === row.inn && editor}</Disclosure>}
      pagination={<Pagination label="ИНН компаний" next={page.next_cursor} disabled={busy || !!draft} load={async after => { const offset = Number(after ?? 0), entries = items.slice(offset, offset + 500); return { items: entries, next_cursor: offset + entries.length < items.length ? offset + entries.length : null }; }} onLoad={setPage} />} />
    {deletion && <ConfirmDialog title={`Удалить ИНН ${deletion.inn}?`} busy={busy} onCancel={() => setDeletion(undefined)} onConfirm={() => void remove()}>
      {deletion.company_name && <p>{deletion.company_name}</p>}
      <p>ИНН исчезнет из справочника и списка выбора для новых обработок. Уже сформированные файлы сохранятся. При необходимости ИНН можно добавить снова.</p>
      {deleteError && <p className="field-error" role="alert">{deleteError}</p>}
    </ConfirmDialog>}
  </section>;
}
