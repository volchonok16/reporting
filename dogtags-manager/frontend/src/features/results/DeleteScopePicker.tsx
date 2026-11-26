import { useEffect, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import { errorText } from '../hub/model';

export function DeleteScopePicker({ disabled, selected, onSelect }: { disabled: boolean; selected?: Api['DeleteScopeSelection']; onSelect: (value: Api['DeleteScopeSelection']) => void }) {
  const [page, setPage] = useState<Api['ChangeSourcePage']>(), [preview, setPreview] = useState<Api['ArtifactPreview']>();
  const [candidate, setCandidate] = useState<Api['ChangeSourceState']>(), [error, setError] = useState('');
  useEffect(() => { let live = true; void api.changeSources().then(value => { if (live) setPage(value); }).catch(e => { if (live) setError(errorText(e)); }); return () => { live = false; }; }, []);
  async function inspect(value: Api['ChangeSourceState'], after = 0) { try { setPreview(await api.preview(value.case_id, value.revision_id, value.artifact_id, after)); setCandidate(value); setError(''); } catch (e) { setError(errorText(e)); } }
  return <div className="hub-group"><h3 className="block-title">Старые номера для удаления</h3><p>Сначала удалите именно этот список, затем применяйте исправленный комплект. Новые номера не определяют состав удаления. Если нужного списка нет, загрузите отдельный запрос DELETE.</p>
    {error && <Alert title="Список удаления недоступен" tone="danger"><p>{error}</p></Alert>}
    <Table caption="Источники старых номеров" rows={page?.items ?? []} rowId={row => row.artifact_id} state={!page ? 'loading' : page.items.length ? 'ready' : 'empty'} columns={[{ key: 'file', label: 'Проверенный CSV', render: row => row.filename }, { key: 'count', label: 'Номеров', render: row => row.row_count }, { key: 'view', label: 'Состав', render: row => <Button disabled={disabled} onClick={() => void inspect(row)}>Проверить список удаления</Button> }]} pagination={<Pagination label="Списки удаления" next={page?.next_cursor} disabled={disabled} load={after => api.changeSources(after == null ? undefined : String(after))} onLoad={setPage} />} />
    {preview && candidate && <><p>{candidate.filename} · {candidate.row_count} номеров</p><Table caption={`Предпросмотр «${candidate.filename}»`} rows={preview.items.map((cells, index) => ({ cells, index }))} rowId={row => String(row.index)} columns={preview.columns.map((field, index) => ({ key: field, label: field, render: (row: { cells: string[] }) => row.cells[index] }))} pagination={<Pagination key={candidate.artifact_id} label="Старые номера" next={preview.next_cursor} disabled={disabled} load={after => api.preview(candidate.case_id, candidate.revision_id, candidate.artifact_id, Number(after ?? 0))} onLoad={setPreview} />} /><div className="action-strip"><Button disabled={disabled} aria-pressed={selected?.artifact_id === candidate.artifact_id} onClick={() => onSelect({ artifact_id: candidate.artifact_id, manifest_hash: candidate.manifest_hash, confirmed: true })}>Подтвердить этот состав удаления</Button></div></>}
    {selected && <p>Состав удаления подтверждён для выбранной неизменной версии CSV.</p>}
  </div>;
}
