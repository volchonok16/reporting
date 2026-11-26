import { useEffect, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';

export function MsisdnCleanupNotice({ caseId, revisionId, count, autoOpen }: {
  caseId: string; revisionId: string; count: number; autoOpen: boolean;
}) {
  const key = `dogtags.msisdn-cleanup.${revisionId}`;
  const [open, setOpen] = useState(false);
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<Api['IssuePage']>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (autoOpen && count > 0 && !sessionStorage.getItem(key)) setOpen(true);
  }, [autoOpen, count, key]);
  useEffect(() => {
    if (!open) return;
    let active = true; setLoading(true); setError(''); setPage(undefined);
    void api.issues(caseId, revisionId, after).then(value => { if (active) setPage(value); })
      .catch(() => { if (active) setError('Не удалось загрузить подробности очистки.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, caseId, revisionId, after, attempt]);
  function close() { sessionStorage.setItem(key, 'seen'); setOpen(false); setAfter(0); }
  if (!count) return null;
  return <>
    <p>MSISDN автоматически очищены в строках: {count.toLocaleString('ru-RU')}. <Button onClick={() => setOpen(true)}>Показать удалённые символы</Button></p>
    {open && <ConfirmDialog title="MSISDN: удалены лишние символы" busy={false} destructive={false} confirmLabel="Понятно" onConfirm={close} onCancel={close}>
      <p>Очищено строк: {count.toLocaleString('ru-RU')}. Исходные значения сохранены в истории. Номера с неверной длиной или началом требуют исправления.</p>
      {loading && <p role="status">Загружаем строки…</p>}
      {error && <p role="alert">{error} <Button onClick={() => setAttempt(value => value + 1)}>Повторить</Button></p>}
      {page?.items.filter(issue => issue.code === 'msisdn_cleaned').map(issue => <p key={issue.page_index}>Строка {issue.ordinal}: {issue.message}</p>)}
      {page && !page.items.some(issue => issue.code === 'msisdn_cleaned') && <p>На этой странице только другие замечания проверки.</p>}
      <div className="actions">
        {after > 0 && <Button disabled={loading} onClick={() => setAfter(0)}>В начало</Button>}
        {page?.next_cursor != null && <Button disabled={loading} onClick={() => setAfter(page.next_cursor!)}>Следующая страница</Button>}
      </div>
    </ConfirmDialog>}
  </>;
}
