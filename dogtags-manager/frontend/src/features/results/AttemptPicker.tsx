import { useEffect, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Button } from '../../components/Button';
import { Alert } from '../../components/Alert';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { errorText } from '../hub/model';
import { attemptLabel } from './model';

export function AttemptPicker({ selected, disabled, onSelect, multiple = false }: { selected: string[]; disabled: boolean; onSelect: (attempt: Api['ExternalAttemptState']) => void; multiple?: boolean }) {
  const [page, setPage] = useState<Api['ExternalAttemptPage']>(), [error, setError] = useState('');
  useEffect(() => { let live = true; void api.attemptCandidates().then(value => { if (live) setPage(value); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, []);
  return <div className="hub-group">
    {error && <Alert title="Не удалось прочитать отправки" tone="danger"><p>{error}</p></Alert>}
    <Table caption="Сохранённые внешние отправки" rows={page?.items ?? []} rowId={row => row.id} state={!page ? 'loading' : page.items.length ? 'ready' : 'empty'} columns={[
      { key: 'file', label: 'Файл, версия и отправка', render: attemptLabel },
      { key: 'select', label: multiple ? 'Порядок применения' : 'Связь возврата', render: row => <Button disabled={disabled} aria-pressed={selected.includes(row.id)} onClick={() => onSelect(row)}>{selected.includes(row.id) ? 'Выбрано' : 'Выбрать отправку'}</Button> },
    ]} pagination={<Pagination label="Внешние отправки" next={page?.next_cursor} disabled={disabled} load={after => api.attemptCandidates(after == null ? undefined : String(after))} onLoad={setPage} />} />
    {!page?.items.length && page && <p>Сначала откройте подготовленный CSV и запишите «Файл отправлен». Скачивание само по себе не создаёт отправку.</p>}
  </div>;
}
