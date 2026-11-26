import { useRef, useState } from 'react';
import { Alert, ErrorSummary } from '../components/Alert';
import { Button } from '../components/Button';
import { Combobox, DateInput, Input, Select } from '../components/Controls';
import { FormField } from '../components/FormField';
import { FormGrid, FormSection } from '../components/FormGrid';
import { StatusBadge } from '../components/StatusBadge';
import { StepHeader } from '../components/StepHeader';
import { Table, type TableColumn } from '../components/Table';
import { Pagination } from '../components/Pagination';
import { statusSemantics, type Status } from '../design/status-semantics';

const label32 = 'А'.repeat(32);
const label33 = 'Б'.repeat(33);
const contractRows = [
  { id: 'operator', column: 'INTERNAL_OPERATOR_NAME', source: 'Профиль или разрешённое изменение', rule: 'Непустая строка' },
  { id: 'spreading', column: 'SPREADING', source: 'Профиль или разрешённое изменение', rule: '0 или 1 — независимое значение' },
  { id: 'label32', column: 'DOGTAG', source: <span id="label-32-value">{label32}</span>, rule: '32 символа: полное значение' },
  { id: 'label33', column: 'DOGTAG', source: <span id="label-33-value">{label33}</span>, rule: '33 символа: ошибка, значение сохранено без усечения' },
];
type ContractRow = typeof contractRows[number];

function catalogPage(offset: number, descending: boolean) {
  return { items: Array.from({ length: Math.min(500, 1200 - offset) }, (_, index) => {
    const number = descending ? 1200 - offset - index : offset + index + 1;
    return { id: String(number), number };
  }), next_cursor: offset + 500 < 1200 ? offset + 500 : null };
}

export function ComponentCatalog() {
  const [showErrors, setShowErrors] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [descending, setDescending] = useState(false);
  const [profile, setProfile] = useState('hub');
  const [operator, setOperator] = useState('hubRTK');
  const [spreading, setSpreading] = useState('0');
  const [date, setDate] = useState('2026-10-10');
  const [encoding, setEncoding] = useState('Windows-1251');
  const [announcement, setAnnouncement] = useState('Пример готов к проверке. Рабочие файлы не формируются.');
  const [previewDescending, setPreviewDescending] = useState(false);
  const [previewPage, setPreviewPage] = useState(() => catalogPage(0, false));
  const summary = useRef<HTMLDivElement>(null);
  const columns: TableColumn<ContractRow>[] = [
    { key: 'column', label: 'Столбец CSV', technical: true, sort: descending ? 'descending' : 'ascending', onSort: () => setDescending(!descending), render: (row) => <span className="technical-data">{row.column}</span> },
    { key: 'source', label: 'Источник / исходное значение', render: (row) => row.source },
    { key: 'rule', label: 'Проверка', render: (row) => row.rule },
  ];
  const rows = [...contractRows].sort((a, b) => descending ? b.column.localeCompare(a.column) : a.column.localeCompare(b.column));
  const unsortableColumns = columns.map(({ onSort: _onSort, sort: _sort, ...column }) => column);

  function checkExample() {
    if (showErrors) { summary.current?.focus(); setAnnouncement('В примере есть ошибки. Перейдите к полю по ссылке в сводке.'); }
    else setAnnouncement('Ошибки скрыты для проверки вёрстки. Исходные значения не исправлены.');
  }

  return <main className="page">
    <header className="page-header">
      <p className="product-name">DOGTAGS MANAGER</p>
      <h1>Каталог общих компонентов</h1>
      <p className="secondary-text">Синтетические примеры полей, сообщений и таблиц. Здесь можно проверить состояние интерфейса перед работой с заявкой.</p>
    </header>
    <StepHeader steps={[
      { id: 'source', label: 'Источник и параметры' }, { id: 'check', label: 'Проверка' },
      { id: 'reconcile', label: 'Сверка файлов' }, { id: 'download', label: 'Подтверждение и скачивание' },
    ]} currentStep="check" />

    <section className="catalog-settings" aria-labelledby="catalog-settings-title">
      <h2 id="catalog-settings-title">Состояния примера</h2>
      <div className="check-options">
        <label><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />Текстовые поля только для чтения</label>
        <label><input type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} />Поля недоступны</label>
        <label><input type="checkbox" checked={busy} onChange={(event) => setBusy(event.target.checked)} />Показать ожидание кнопки</label>
      </div>
      {disabled && <p className="secondary-text">Поля недоступны в этом примере, чтобы проверить читаемость и геометрию. Снимите отметку для ввода.</p>}
    </section>

    <FormSection title="Параметры обработки" data-form="catalog" aria-labelledby="parameters-title">
      {showErrors && <ErrorSummary id="catalog-errors" ref={summary} title="Проверьте исходные значения" errors={[
        { fieldId: 'inn', message: 'ИНН: научная запись вместо полных цифр' },
        { fieldId: 'dogtag', message: 'Этикетка: 33 символа вместо допустимых 32' },
      ]} />}
      <form noValidate onSubmit={(event) => { event.preventDefault(); checkExample(); }}>
        <FormGrid>
          <FormField id="profile" label="Профиль отправителя" help={<>Выбранный профиль: {profile === 'hub' ? 'RTK HUB' : 'RTK ABC'}. Выбран вручную. Этот пример не изменяет рабочие профили.</>}>
            {(props) => <Select {...props} disabled={disabled} value={profile} onChange={(event) => setProfile(event.target.value)}><option value="hub">RTK HUB</option><option value="abc">RTK ABC</option></Select>}
          </FormField>
          <FormField id="operator" label="Внутреннее имя оператора для сформированных файлов и последующей сверки комплекта" help={<>INTERNAL_OPERATOR_NAME · полное текущее значение: <span className="technical-data">{operator || 'не задано'}</span>. Длинная подпись переносится целиком.</>} required>
            {(props) => <Input {...props} readOnly={readOnly} disabled={disabled} value={operator} onChange={(event) => setOperator(event.target.value)} spellCheck={false} />}
          </FormField>
          <FormField id="inn" label="ИНН клиента" required help={<>Идентификатор хранится строкой. Исходное значение: <span className="technical-data">7,84201E+11</span>. Должен содержать 10 или 12 цифр.</>} error={showErrors ? 'Научная запись не содержит достоверного исходного ИНН. Укажите полные цифры из подтверждённого первоисточника; не подбирайте недостающие цифры.' : undefined}>
            {(props) => <Input {...props} className="technical-data" readOnly={readOnly} disabled={disabled} defaultValue="7,84201E+11" spellCheck={false} />}
          </FormField>
          <FormField id="spreading" label="Значение SPREADING" help={<>Выбрано: {spreading === '0' ? '0 — согласно профилю HUB' : '1 — ручное переопределение'}. Значение не определяет IS_MAV или IS_KSS.</>}>
            {(props) => <Select {...props} disabled={disabled} value={spreading} onChange={(event) => setSpreading(event.target.value)}><option value="0">0 — согласно профилю HUB</option><option value="1">1 — ручное переопределение</option></Select>}
          </FormField>
          <FormField id="date" label="Дата подготовки результата в часовом поясе оператора" optional help={<>Полная выбранная дата: <time dateTime={date || undefined}>{date || 'не задана'}</time>. Стандартный календарь браузера. Время и часовой пояс в этом примере не сохраняются.</>}>
            {(props) => <DateInput {...props} readOnly={readOnly} disabled={disabled} value={date} onChange={(event) => setDate(event.target.value)} />}
          </FormField>
          <FormField id="encoding" label="Кодировка результата" help={<>Полное текущее значение: <span className="technical-data">{encoding || 'не задано'}</span>. Можно выбрать подсказку или ввести текст. Это демонстрация списка, не проверка кодировки файла.</>}>
            {(props) => <Combobox {...props} readOnly={readOnly} disabled={disabled} value={encoding} onChange={(event) => setEncoding(event.target.value)} options={['Windows-1251', 'UTF-8']} />}
          </FormField>
          <FormField id="dogtag" label="Этикетка с полным исходным значением, превышающим допустимую длину" help={<>Исходные 33 символа: <span className="technical-data">{label33}</span>. Значение не усечено.</>} error={showErrors ? 'Этикетка содержит 33 символа. Допустимы не более 32. Проверьте подтверждённое название; автоматическое усечение изменило бы исходные данные.' : undefined}>
            {(props) => <Input {...props} readOnly={readOnly} disabled={disabled} defaultValue={label33} />}
          </FormField>
          <FormField id="empty" label="Комментарий к проверке" optional help="Пустое поле сохраняет постоянную подпись. Необязательность не обозначается отключением поля.">
            {(props) => <Input {...props} readOnly={readOnly} disabled={disabled} placeholder="Например, источник уточнения" />}
          </FormField>
        </FormGrid>
        <div className="actions">
          <Button variant="primary" type="submit" loading={busy}>Проверить пример</Button>
          <Button onClick={() => {
            setShowErrors(!showErrors);
            setAnnouncement(showErrors ? 'Ошибки скрыты для проверки вёрстки. Исходные значения не исправлены.' : 'Сообщения об ошибках снова показаны.');
          }}>{showErrors ? 'Скрыть ошибки в примере' : 'Показать ошибки в примере'}</Button>
        </div>
        <p className="secondary-text" role="status" aria-live="polite">{busy ? 'Идёт проверка примера. Дождитесь завершения демонстрации.' : announcement}</p>
      </form>
    </FormSection>

    <FormSection title="Форма в узкой панели" data-form="narrow" className="form-section--narrow" aria-labelledby="narrow-title">
      <FormGrid>
        <FormField id="narrow-source" label="Источник подтверждённого уточнения ИНН клиента" help="Полное значение: Подтверждённый источник. Даже на широком экране узкая панель сохраняет одну колонку и полный текст пояснения.">
          {(props) => <Input {...props} readOnly defaultValue="Подтверждённый источник" />}
        </FormField>
        <FormField id="narrow-date" label="Дата проверки источника" help="Полная дата: 2026-10-10. Отдельная строка той же формы.">
          {(props) => <DateInput {...props} readOnly defaultValue="2026-10-10" />}
        </FormField>
      </FormGrid>
    </FormSection>

    <section className="catalog-section" aria-labelledby="buttons-title">
      <h2 id="buttons-title">Действия</h2>
      <p className="secondary-text">Основное действие, вторичное действие и отдельное опасное действие имеют постоянные подписи. Состояние ожидания сохраняет видимую область кнопки.</p>
      <div className="actions action-strip">
        <Button variant="secondary">Вторичное действие</Button><Button variant="ghost">Показать детали</Button>
        <Button variant="danger">Удалить пример</Button><Button disabled>Недоступное действие</Button>
        <Button loading>Действие в ожидании</Button>
      </div>
      <p className="secondary-text">Недоступное действие: пример не подключён к рабочим данным. Кнопки этой секции демонстрируют оформление.</p>
    </section>

    <section className="catalog-section" aria-labelledby="statuses-title">
      <h2 id="statuses-title">Статусы и сообщения</h2>
      <div className="status-list">{(Object.keys(statusSemantics) as Status[]).map((status) => <StatusBadge key={status} status={status} />)}</div>
      <Alert title="Файлы подготовлены" tone="info"><p>Подготовка комплекта не подтверждает применение во внешней системе.</p></Alert>
      <Alert title="Нужна сверка" tone="warning"><p>Проверьте состав и исходные значения перед подтверждением.</p></Alert>
      <Alert title="Полный комплект заблокирован" tone="danger"><p>Блокирующая ошибка остаётся видимой до устранения причины.</p></Alert>
    </section>

    <section className="catalog-section" aria-labelledby="tables-title">
      <h2 id="tables-title">Таблицы</h2>
      <p className="secondary-text">Технические заголовки и полные значения сохранены. При необходимости прокручивается только область таблицы.</p>
      <Table key={String(previewDescending)} caption="Пример фильтра и сортировки" columns={[{ key: 'number', label: 'Номер строки', render: row => row.number }, { key: 'value', label: 'Данные', render: row => `Синтетическая запись ${row.number}` }]} rows={previewPage.items} rowId={row => row.id}
        pagination={<Pagination label="Пример фильтра и сортировки" next={previewPage.next_cursor} toolbarActions={<label className="review-sort">Сортировка<Select aria-label="Сортировка примера" value={String(previewDescending)} onChange={event => { const descending = event.target.value === 'true'; setPreviewDescending(descending); setPreviewPage(catalogPage(0, descending)); }}><option value="false">По возрастанию номера</option><option value="true">По убыванию номера</option></Select></label>}
          load={async after => catalogPage(Number(after ?? 0), previewDescending)} onLoad={setPreviewPage} />} />
      <Table caption="Часть контракта результата · синтетические значения" columns={columns} rows={rows} rowId={(row) => row.id} />
      <Table caption="Отфильтрованные и выбранные записи" columns={unsortableColumns} rows={[contractRows[1]]} rowId={(row) => row.id} filteredLabel="Фильтр: строки с ошибками" selectedRowIds={new Set(['spreading'])} />
      {(['loading', 'empty', 'no-results', 'error'] as const).map((state) => <Table key={state} caption={{ loading: 'Данные загружаются', empty: 'Пустой набор', 'no-results': 'Нет результатов фильтра', error: 'Ошибка получения данных' }[state]} columns={unsortableColumns} rows={[]} rowId={(row) => row.id} state={state} />)}
    </section>
  </main>;
}
