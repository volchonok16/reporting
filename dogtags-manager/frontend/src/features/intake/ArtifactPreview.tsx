import type { Api } from '../../api/client';
import { Table } from '../../components/Table';
import { Pagination } from '../../components/Pagination';
import type { PageCursor } from '../../components/Pagination';
import { fieldLabels } from '../hub/model';
import { artifactLabel } from './model';

type Props = { preview: Api['ArtifactPreview']; archive: boolean; disabled: boolean;
  load: (after: PageCursor) => Promise<Api['ArtifactPreview']>; onLoad: (page: Api['ArtifactPreview']) => void };
const diagnosticLabels: Record<string, string> = { SOURCE_ROW: 'Строка исходника', ERROR_FIELDS: 'Поля с ошибками', ERROR_MESSAGES: 'Причины ошибок', STATUS: 'Статус' };
const previewLabels: Record<string, string> = { ...fieldLabels, ...diagnosticLabels };
export function ArtifactPreview({ preview, archive, disabled, load, onLoad }: Props) {
  const errorFieldsIndex = preview.columns.lastIndexOf('ERROR_FIELDS');
  const errorMessagesIndex = preview.columns.lastIndexOf('ERROR_MESSAGES');
  const sourceRowIndex = preview.columns.lastIndexOf('SOURCE_ROW');
  const diagnosticIndexes = new Set([errorFieldsIndex, errorMessagesIndex, sourceRowIndex]);
  const diagnostic = preview.role === 'ERRORS' || preview.role === 'ERROR_OTHER_OPERATOR';
  return <div className="artifact-preview"><Table showCaption={false}
    caption={`Предпросмотр ${artifactLabel(preview.role)}`} rows={preview.items.map((cells, index) => ({ cells, index }))} rowId={item => String(item.index)}
    columns={preview.columns.map((field, index) => ({ field, index })).filter(({ index }) => !diagnostic || !diagnosticIndexes.has(index)).map(({ field, index }) => ({ key: String(index), label: archive ? previewLabels[field] ?? field : field, technical: !archive,
      render: (item: { cells: string[] }) => {
        const errorFields = (item.cells[errorFieldsIndex] ?? '').split(/[;,]/).map(value => value.trim());
        const invalid = diagnostic && (errorFields.includes(field) || errorFields.includes('SOURCE_ROW'));
        const kind = ['ERROR_MESSAGES', 'Ошибка'].includes(field) ? 'artifact-explanation' : ['INN', 'MSISDN', 'SOURCE_ROW'].includes(field) ? 'artifact-identifier' : 'artifact-value';
        return <span title={invalid ? item.cells[errorMessagesIndex] : undefined} className={`${kind}${invalid ? ' repair-field-error' : ''}`}>{item.cells[index]}</span>;
      } }))}
    pagination={<Pagination label={`Предпросмотр ${artifactLabel(preview.role)}`} next={preview.next_cursor} disabled={disabled} load={load} onLoad={onLoad} />} />
  </div>;
}
