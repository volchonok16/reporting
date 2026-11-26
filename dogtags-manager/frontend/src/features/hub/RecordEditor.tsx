import { useEffect, useMemo, useState } from 'react';
import { object, string, type Api, type Correction } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Input, Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { Table } from '../../components/Table';
import { dispositionLabels, fieldLabels, hubFields, time } from './model';
import { suggestLabelCorrection, type FieldIssue } from './validateFields';
import { draftValues, editedIssues } from '../intake/reviewDraft';

type Props = {
  compact?: boolean; prefixMsisdn?: boolean; detail: Api['RecordDetail']; columns: readonly string[];
  mapping?: Record<string, number>; sourceSheet?: string; pending: readonly Correction[]; fields?: readonly Correction['field'][]; enabled: boolean; focusField?: string;
  onStage: (changes: Correction[]) => void;
  onSave?: (changes: Correction[]) => Promise<boolean>;
  onPreview?: (recordId: string, values: Record<string, string>, issues: FieldIssue[]) => void;
  returnedRole?: string;
  onDirty: (dirty: boolean) => void;
  onRepresentative: (id: string, ordinal: number) => void;
};

export function RecordEditor({ compact = false, prefixMsisdn = false, detail, columns, mapping, sourceSheet, pending, fields = hubFields, enabled, focusField, onStage, onSave, onPreview, returnedRole, onDirty, onRepresentative }: Props) {
  const record = detail.record;
  const editable = enabled && record.raw_cells.length === columns.length && !detail.issues.some(issue => issue.code === 'row_shape' || issue.code === 'unsupported_schema');
  const effective = draftValues(record, pending, prefixMsisdn);
  const base = Object.fromEntries(fields.map(field => [field, effective[field] ?? '']));
  const [values, setValues] = useState(base);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const edited = fields.some(field => values[field] !== base[field]);
  const visibleIssues = useMemo(() => editedIssues(detail.issues, record.effective, values, fields, returnedRole), [detail, values, fields, returnedRole]);
  useEffect(() => { onPreview?.(record.record_id, values, visibleIssues); }, [record.record_id, values, visibleIssues, onPreview]);
  useEffect(() => { onDirty(edited); }, [edited, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (focusField) document.getElementById(`edit-${focusField}`)?.focus();
  }, [focusField]);
  const update = (field: string, value: string) => setValues(previous => {
    const other = field === 'IS_MAV' ? 'IS_KSS' : field === 'IS_KSS' ? 'IS_MAV' : undefined;
    return { ...previous, [field]: value,
      ...(other && fields.includes(other) && (value === '0' || value === '1') ? { [other]: value === '1' ? '0' : '1' } : {}) };
  });
  async function stage() {
    if (!edited) { setError('Измените значение поля.'); return; }
    const changes: Correction[] = fields.filter(field => values[field] !== base[field]).map(field => ({
      record_id: record.record_id, ordinal: record.ordinal, field, before: base[field], after: values[field], reason: '',
    }));
    if (onSave) {
      setSaving(true); setError('');
      try { if (await onSave(changes)) { onDirty(false); } }
      catch { setError('Не удалось сохранить изменения. Введённые значения сохранены в редакторе.'); }
      finally { setSaving(false); }
    } else { onStage(changes); setError(''); onDirty(false); }
  }
  const repair = fields.includes('STATUS');
  const flag = (field: string) => field.startsWith('IS_') || field === 'SPREADING';
  const helpByField: Partial<Record<Correction['field'], string>> = {
    IS_ACTIVE: 'В импортном файле IS_ACTIVE всегда 1. Исправьте другое исходное значение на 1.',
    STATUS: 'Сообщение из возвращённого файла. Пустое значение отправляет исправленную строку в основной файл после проверки.',
    INN: 'Строка без преобразования в число. Научная запись не восстанавливается догадкой.',
    INTERNAL_OPERATOR_NAME: 'Имя оператора из этой строки. Если оператора нет, оставьте пустым; параметры партнёра не подставляются.',
  };
  function fieldHelp(field: Correction['field']) {
    if (field.startsWith('MAV_LABEL')) return `${Array.from(values[field]).length} символов; максимум 32. Значение не усекается.`;
    return helpByField[field] ?? (flag(field) ? 'Независимое значение 0 или 1; пустое значение требует исправления.' : 'Значение исходной строки.');
  }
  const fieldError = (field: string) => visibleIssues.filter(issue => issue.field === field && issue.scope !== 'warning').map(issue => compact ? issue.message : `${issue.code}: ${issue.message}`).join(' ');
  return <section className="hub-group" aria-labelledby="record-title">
    <div className="hub-group">
      <h2 id="record-title" className="block-title">Запись {record.ordinal}</h2>
      {!compact && <><p className="secondary-text">{sourceSheet ? `Лист ${sourceSheet}. ` : ''}Исходные строки {record.line_start}–{record.line_end}.</p><details><summary>Идентификатор записи</summary><span className="technical-data">{record.record_id}</span></details>
      <p>{record.disposition ? repair && record.disposition === 'excluded_error' ? 'Строка требует исправления и вынесена в отчёт об ошибках' : repair && record.disposition === 'agreed_skip' ? 'Обработана по STATUS: пропущена в основном файле или передана во вспомогательный файл' : dispositionLabels[record.disposition] : 'Сохранённый черновик — исход обработки ещё не определён.'}</p></>}
      {record.representative_id && record.representative_id !== record.record_id && record.representative_ordinal && <Button onClick={() => onRepresentative(record.representative_id!, record.representative_ordinal!)}>Открыть представителя дубля {record.representative_ordinal}</Button>}
    </div>
    {!compact && <Table caption="Исходное и действующее значения" rowId={row => String(row.index)} rows={Array.from({ length: Math.max(columns.length, record.raw_cells.length) }, (_, index) => ({ index, field: columns[index] ?? `Колонка без заголовка ${index + 1}`, original: record.raw_cells[index] ?? '', effective: record.effective[Object.keys(mapping ?? {}).find(field => mapping?.[field] === index) ?? columns[index]] ?? 'Действующие значения — в полях записи ниже' }))}
      columns={[
        { key: 'field', label: 'Колонка', render: row => row.field, technical: true },
        { key: 'original', label: 'Исходное значение', render: row => <span className="hub-value">{row.original === '' ? '(пусто)' : row.original}</span> },
        { key: 'effective', label: 'Действующее значение', render: row => <span className="hub-value">{row.effective === '' ? '(пусто)' : row.effective}</span> },
      ]} />}
    {!!detail.normalizations?.length && <Table caption="Автоматические изменения записи" rows={detail.normalizations} rowId={row => `${row.field}-${row.rule_id}`} columns={[
      { key: 'field', label: 'Поле', render: row => row.field }, { key: 'before', label: 'Исходное значение', render: row => row.before },
      { key: 'after', label: 'После нормализации', render: row => row.after }, ...(!compact ? [{ key: 'rule', label: 'Правило', render: (row: NonNullable<Api['RecordDetail']['normalizations']>[number]) => row.rule_id }] : []),
    ]} />}
    {(['error', 'warning'] as const).map(kind => {
      const items = visibleIssues.filter(issue => (issue.scope === 'warning') === (kind === 'warning'));
      return items.length > 0 && <Alert key={kind} title={kind === 'warning' ? 'Некритичные предупреждения' : 'Ошибки этой записи'} tone={kind === 'warning' ? 'warning' : 'danger'}><ul>{items.map((issue, index) => <li key={`${issue.field}-${issue.code}-${index}`}><a href={`#edit-${issue.field}`}>{fieldLabels[issue.field as Correction['field']] ?? issue.field}: {issue.message}{!compact && ` (${issue.code})`}</a></li>)}</ul>{kind === 'warning' && edited && <p>{compact ? 'Связанные предупреждения перепроверяются при переходе к подтверждению.' : 'Предупреждения о регистре перепроверяются после сохранения.'}</p>}</Alert>;
    })}
    {fields.map(field => {
      const suggestion = suggestLabelCorrection(field, values[field] ?? '');
      return suggestion && <Alert key={field} title="Предлагаемое исправление" tone="info"><p>{fieldLabels[field]}: «{values[field]}» → «{suggestion}».</p><p>Кавычки и запрещённые знаки удаляются, варианты тире заменяются дефисом, переносы строк — пробелом, кириллические двойники в латинской этикетке — латинскими буквами. Правка применяется только по вашему решению.</p><Button disabled={!editable || saving} onClick={() => update(field, suggestion)}>Применить исправление этикетки</Button></Alert>;
    })}
    <FormSection data-form="record" aria-labelledby="record-title"><form onSubmit={event => { event.preventDefault(); if (!saving) void stage(); }}>
      <FormGrid>
        {fields.filter(field => field !== 'MSISDN').map(field => <FormField key={field} id={`edit-${field}`} label={<>{fieldLabels[field]} {!compact && <span className="field-note">{field}</span>}</>} error={fieldError(field) || undefined}
          help={fieldHelp(field)}>
          {props => flag(field) ? <Select {...props} value={values[field]} disabled={!editable} onChange={event => update(field, event.target.value)}>
            <option value="">Пусто</option>{field !== 'IS_ACTIVE' && <option value="0">0</option>}<option value="1">1</option>
            {values[field] !== '' && (field === 'IS_ACTIVE' || values[field] !== '0') && values[field] !== '1' && <option value={values[field]}>{values[field]}</option>}
          </Select> : <Input {...props} value={values[field]} readOnly={!editable} onChange={event => update(field, event.target.value)} />}
        </FormField>)}
      </FormGrid>
      {fields.includes('MSISDN') && <FormField id="edit-MSISDN" label={<>Номер <span className="field-note">MSISDN</span></>} error={fieldError('MSISDN') || undefined} help="Полная исходная строка, включая переносы. Никаких автоматических изменений формата номера.">
        {props => <Textarea {...props} value={values.MSISDN} readOnly={!editable} rows={3} onChange={event => update('MSISDN', event.target.value)} />}
      </FormField>}
      {error && <p role="alert" className="field-error">{error}</p>}
      <div className="actions"><Button type="submit" loading={saving} disabled={!editable || saving}>{onSave ? 'Сохранить' : 'Добавить исправления в черновик'}</Button>
        {!onSave && <Button onClick={() => { setValues(base); setError(''); onDirty(false); }}>Отменить ввод этой записи</Button>}</div>
    </form></FormSection>
    {!compact && <Table caption="Сохранённая история исправлений записи" rows={detail.corrections.map((value, index) => ({ value: object(value), index }))} rowId={row => String(row.index)} state={detail.corrections.length ? 'ready' : 'empty'}
      columns={[
        { key: 'field', label: 'Поле', render: row => string(row.value.field) ?? 'Неизвестно' },
        { key: 'before', label: 'Было', render: row => <span className="hub-value">{string(row.value.before) ?? 'Неизвестно'}</span> },
        { key: 'after', label: 'Стало', render: row => <span className="hub-value">{string(row.value.after) ?? 'Неизвестно'}</span> },
        { key: 'rule', label: 'Правило', render: row => string(row.value.rule_version) ?? 'Неизвестно' },
        { key: 'author', label: 'Автор / время UTC', render: row => `${string(row.value.author_id) ?? 'Неизвестно'} / ${time(string(row.value.created_at))}` },
      ]} />}
  </section>;
}
