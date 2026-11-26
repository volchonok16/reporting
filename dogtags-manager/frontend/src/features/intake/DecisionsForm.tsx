import { useState } from 'react';
import { hubFields } from '../hub/model';
import { WhitemavInnPicker } from './WhitemavInnPicker';
import { object, string, type Api } from '../../api/client';
import { AttemptPicker } from '../results/AttemptPicker';
import { DeleteScopePicker } from '../results/DeleteScopePicker';
import { attemptLabel } from '../results/model';
import { Button } from '../../components/Button';
import { Input, Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { mappingOf, operations, repairFields, repairRole, repairRoles, strings, type Decisions, type Intake } from './model';

type Props = { partnerNames: readonly string[]; manual?: boolean; intake: Intake; csrf: string; disabled: boolean; onDirty: (dirty: boolean) => void; onSave: (decisions: Decisions) => Promise<void> };
export function DecisionsForm({ intake, csrf, partnerNames, manual = false, disabled, onDirty, onSave }: Props) {
  const result = intake.assessment?.result ?? {};
  const questions = intake.assessment?.questions ?? [];
  const reader = object(intake.version.decisions.reader ?? result.reader);
  const columns = strings(result.columns);
  const [partner, setPartner] = useState(string(intake.version.decisions.partner) ?? string(object(result.partner).partner) ?? '');
  const [whitemavInn, setWhitemavInn] = useState(string(intake.version.decisions.whitemav_inn) ?? string(intake.revision?.settings.whitemav_inn) ?? '7743895280');
  const [innSaving, setInnSaving] = useState(false);
  const [operation, setOperation] = useState(string(intake.version.decisions.operation) ?? string(result.operation) ?? '');
  const [role, setRole] = useState<NonNullable<Decisions['repair_role']> | ''>(repairRole(intake.version.decisions.repair_role ?? result.repair_role) ?? '');
  const [mapping, setMapping] = useState(mappingOf(intake.version.decisions.mapping ?? result.mapping));
  const [encoding, setEncoding] = useState< 'utf-8' | 'utf-8-sig' | 'cp1251'>(reader.encoding === 'cp1251' ? 'cp1251' : reader.encoding === 'utf-8-sig' ? 'utf-8-sig' : 'utf-8');
  const [delimiter, setDelimiter] = useState<';' | ',' | '\t' | '|'>(reader.delimiter === ',' ? ',' : reader.delimiter === '\t' ? '\t' : reader.delimiter === '|' ? '|' : ';');
  const [sheet, setSheet] = useState(string(reader.sheet) ?? '');
  const [header, setHeader] = useState(String(reader.header_row ?? 1));
  const [end, setEnd] = useState(reader.end_row == null ? '' : String(reader.end_row));
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [reason, setReason] = useState('');
  const [returnAttempt, setReturnAttempt] = useState<Api['ExternalAttemptState']>();
  const [deleteScope, setDeleteScope] = useState<Api['DeleteScopeSelection']>();
  const originalPartner = string(intake.version.decisions.partner);
  const changedPartner = !!originalPartner && originalPartner !== partner;
  const format = result.format === 'xlsx' || result.format === 'xls' || result.format === 'xlsb' || result.format === 'numbers' ? result.format : 'csv';
  const readerQuestion = manual || questions.some(question => question.field === 'reader');
  const isRepair = operation === 'REPAIR';
  const mappedFields: readonly string[] = isRepair ? (role ? repairFields[role] : []) : operation === 'STATUS' ? [...strings(object(result.return_context).columns), 'STATUS'] : ['DELETE', 'WHITEMAV'].includes(operation) ? ['MSISDN'] : hubFields;
  const manualLabels = ['ADD', 'CHANGE'].includes(operation);
  const defaultMav = isRepair && role === 'NUMBERS';
  const [flags, setFlags] = useState<NonNullable<Decisions['missing_flags']>>(intake.version.decisions.missing_flags ?? {});
  const missingFlags = (['IS_MAV', 'IS_KSS'] as const).filter(field => mapping[field] == null);
  const required: readonly string[] = manualLabels ? [] : isRepair && role === 'CLIENTS' ? ['INN', 'STATUS'] : mappedFields.filter(field => !(defaultMav && field === 'IS_MAV') && !(isRepair && role === 'NUMBERS' && field === 'MAV_OPERATOR_NAME'));
  const selectedFields = mappedFields.filter(field => mapping[field] != null);
  const mappingQuestion = ((manual && columns.length > 0) || questions.some(question => question.field === 'mapping' || isRepair && question.field === 'repair_role')) && (operation !== 'STATUS' || !!object(result.return_context).columns);
  const needsReason = changedPartner || operation === 'STATUS';
  async function save() {
    if (innSaving) return;
    setAttempted(true);
    if ((!['STATUS', 'WHITEMAV'].includes(operation) && !partner) || !(operation in operations)) { setError('Выберите партнёра и назначение файла.'); return; }
    if (isRepair && !role) { setError('Выберите тип возвращённого файла: CLIENTS, DOGTAGS или NUMBERS.'); return; }
    if (mappingQuestion && (required.some(field => mapping[field] == null) || new Set(selectedFields.map(field => mapping[field])).size !== selectedFields.length)) { setError('Каждому полю нужна своя исходная колонка.'); return; }
    if (needsReason && !reason.trim()) { setError('Укажите основание смены партнёра.'); return; }
    const decisions: Decisions = { operation: operation as Decisions['operation'] };
    if (operation === 'WHITEMAV') decisions.whitemav_inn = whitemavInn;
    if (isRepair && role) decisions.repair_role = role;
    if (!['STATUS', 'WHITEMAV'].includes(operation)) decisions.partner = partner as Decisions['partner'];
    if (reason.trim()) decisions.reason = reason.trim();
    if (operation === 'STATUS' && returnAttempt) decisions.return_attempt_id = returnAttempt.id;
    if (operation === 'STATUS' && !returnAttempt && !intake.version.decisions.return_attempt_id) { setError('Выберите сохранённую отправку исходного CSV.'); return; }
    if (operation === 'CHANGE' && deleteScope) decisions.delete_scope = deleteScope;
    if (operation === 'CHANGE' && !deleteScope && !intake.version.decisions.delete_scope) { setError('Проверьте и подтвердите состав старых номеров для удаления.'); return; }
    if (mappingQuestion) decisions.mapping = Object.fromEntries(selectedFields.map(field => [field, mapping[field]]));
    if (mappingQuestion && manualLabels) decisions.missing_flags = Object.fromEntries(missingFlags.flatMap(field => flags[field] ? [[field, flags[field]]] : []));
    if (readerQuestion) {
      if (format !== 'csv' && (!sheet.trim() || !Number.isInteger(Number(header)) || Number(header) < 1 || (end !== '' && (!Number.isInteger(Number(end)) || Number(end) < Number(header))))) { setError('Укажите лист и корректный диапазон строк.'); return; }
      decisions.reader = format === 'csv' ? { format, encoding, delimiter } : { format, sheet, header_row: Number(header), end_row: end ? Number(end) : null };
    }
    setError(''); await onSave(decisions);
  }
  return <FormSection title="Уточните данные файла" data-testid="intake-decisions" data-form="intake-decisions" aria-labelledby="decisions-title">
    {isRepair && <p>Обработка CLIENTS, DOGTAGS или NUMBERS по колонке STATUS. Все строки проходят проверку; строки с ошибками попадут в отдельный диагностический отчёт.</p>}
    <ul>{questions.map((question, index) => <li key={index}>{string(question.message) ?? 'Требуется уточнение у администратора.'}</li>)}</ul>
    <form onChange={() => onDirty(true)} onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormGrid>
        {operation === 'WHITEMAV' && <WhitemavInnPicker value={whitemavInn} csrf={csrf} disabled={disabled} preserveSelection={intake.version.decisions.operation === 'WHITEMAV'} onBusy={setInnSaving} onChange={value => { setWhitemavInn(value); onDirty(true); }} />}
        {!['STATUS', 'WHITEMAV'].includes(operation) && <FormField id="decision-partner" label="Партнёр" error={attempted && !partner ? 'Выберите партнёра для определения правил и параметров этого файла.' : undefined}>{props => <Select {...props} value={partner} disabled={disabled} onChange={event => setPartner(event.target.value)}><option value="">Выберите партнёра</option>{[...new Set([...partnerNames, ...(partner ? [partner] : [])])].map(value => <option key={value}>{value}</option>)}</Select>}</FormField>}
        <FormField id="decision-operation" label="Назначение файла" error={attempted && !operation ? 'Укажите назначение файла.' : undefined}>{props => <Select {...props} value={operation} disabled={disabled} onChange={event => setOperation(event.target.value)}><option value="">Выберите назначение</option>{Object.entries(operations).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</Select>}</FormField>
        {isRepair && (manual || !repairRole(result.repair_role)) && <FormField id="decision-repair-role" label="Тип возвращённого файла" required error={attempted && !role ? 'Выберите CLIENTS, DOGTAGS или NUMBERS.' : undefined}>{props => <Select {...props} value={role} disabled={disabled} onChange={event => { setRole(repairRole(event.target.value) ?? ''); }}><option value="">Выберите тип</option>{repairRoles.map(value => <option key={value}>{value}</option>)}</Select>}</FormField>}
        {mappingQuestion && mappedFields.map(field => <FormField key={field} id={`mapping-${field}`} label={`Колонка для ${field}`} error={attempted && ((required.includes(field) && mapping[field] == null) || (mapping[field] != null && selectedFields.some(other => other !== field && mapping[other] === mapping[field]))) ? 'Выберите отдельную исходную колонку: пропущенное или повторное соответствие не позволяет продолжить проверку.' : undefined} help={field === 'IS_MAV' && defaultMav ? 'Если столбец не найден, для всех записей используется 0. Найденные значения проверяются без замены.' : !required.includes(field) ? 'Необязательная колонка: если её нет, значение останется пустым. Существующую колонку можно сохранить.' : 'Номер и исходный заголовок; одна колонка соответствует одному полю.'}>{props => <Select {...props} value={mapping[field] ?? ''} disabled={disabled} onChange={event => setMapping(previous => { const next = { ...previous }; if (event.target.value === '') delete next[field]; else next[field] = Number(event.target.value); return next; })}><option value="">{field === 'IS_MAV' && defaultMav ? 'Столбец отсутствует — использовать 0' : manualLabels ? 'Нет колонки — заполнить при обработке' : 'Выберите колонку'}</option>{columns.map((column, index) => <option key={index} value={index}>{index + 1}. {column || '(без заголовка)'}</option>)}</Select>}</FormField>)}
        {mappingQuestion && manualLabels && missingFlags.map(field => <FormField key={field} id={`missing-${field}`} label={field}>{props => <Select {...props} value={flags[field] ?? ''} disabled={disabled} onChange={event => {
          const value = event.target.value;
          const other = field === 'IS_MAV' ? 'IS_KSS' : 'IS_MAV';
          setFlags(previous => ({ ...previous, [field]: value === '0' || value === '1' ? value : undefined,
            ...(value && missingFlags.includes(other) ? { [other]: value === '1' ? '0' : '1' } : {}) }));
        }}><option value="">Заполнить при обработке</option><option value="0">0</option><option value="1">1</option></Select>}</FormField>)}
        {readerQuestion && format === 'csv' && <>
          <FormField id="decision-encoding" label="Кодировка">{props => <Select {...props} disabled={disabled} value={encoding} onChange={event => setEncoding(event.target.value as typeof encoding)}><option value="utf-8">UTF-8</option><option value="utf-8-sig">UTF-8 с BOM</option><option value="cp1251">Windows-1251</option></Select>}</FormField>
          <FormField id="decision-delimiter" label="Разделитель">{props => <Select {...props} disabled={disabled} value={delimiter} onChange={event => setDelimiter(event.target.value as typeof delimiter)}><option value=";">Точка с запятой</option><option value=",">Запятая</option><option value={'\t'}>Табуляция</option><option value="|">Вертикальная черта</option></Select>}</FormField>
        </>}
        {readerQuestion && format !== 'csv' && <>
          <FormField id="decision-sheet" label="Лист книги">{props => <Select {...props} disabled={disabled} value={sheet} onChange={event => setSheet(event.target.value)}><option value="">Выберите лист</option>{(Array.isArray(result.inventory) ? result.inventory : []).map(object).map((item, index) => <option key={index} value={string(item.sheet) ?? string(item.name) ?? ''}>{string(item.sheet) ?? string(item.name) ?? 'Неизвестный лист'}</option>)}</Select>}</FormField>
          <FormField id="decision-header" label="Строка заголовков">{props => <Input {...props} disabled={disabled} type="number" min={1} value={header} onChange={event => setHeader(event.target.value)} />}</FormField>
          <FormField id="decision-end" label="Последняя строка" help="Пусто — до конца листа.">{props => <Input {...props} disabled={disabled} type="number" min={1} value={end} onChange={event => setEnd(event.target.value)} />}</FormField>
        </>}
      </FormGrid>
      {operation === 'STATUS' && <><AttemptPicker selected={[returnAttempt?.id ?? string(intake.version.decisions.return_attempt_id) ?? '']} disabled={disabled} onSelect={value => { setReturnAttempt(value); onDirty(true); }} />{returnAttempt && <p>Выбрано: {attemptLabel(returnAttempt)}</p>}</>}
      {operation === 'CHANGE' && <DeleteScopePicker disabled={disabled} selected={deleteScope} onSelect={value => { setDeleteScope(value); onDirty(true); }} />}
      {needsReason && <FormField id="decision-reason" label={operation === 'STATUS' ? 'Основание связи или пересмотра возврата' : 'Основание смены партнёра'} required help="Сохраняется только для этой обработки; будущие загрузки не меняются.">{props => <Textarea {...props} disabled={disabled} value={reason} onChange={event => setReason(event.target.value)} />}</FormField>}
      {error && <p role="alert" className="field-error">{error}</p>}
      <Button type="submit" variant="primary" disabled={disabled || innSaving}>Сохранить решения и продолжить</Button>
    </form>
  </FormSection>;
}
