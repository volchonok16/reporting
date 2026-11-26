import { useEffect, useRef, useState } from 'react';
import { api, ApiFailure, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Input, Select } from '../../components/Controls';
import { Disclosure } from '../../components/Disclosure';
import { FormField } from '../../components/FormField';
import { FormGrid, FormSection } from '../../components/FormGrid';
import { IconButton } from '../../components/IconButton';
import { Pagination } from '../../components/Pagination';
import { Table } from '../../components/Table';
import { InnDirectory } from './InnDirectory';
import './dictionary.css';

type State = Api['ProcessingSettingsState'];
type Profiles = State['profiles'];
type Mnemonic = Api['ProcessingMnemonicState'];
type Draft = { id?: string; code: string; description: string; originalCode: string; originalDescription: string };
type Command = { kind: 'partners'; body: Api['PartnerSettingsBody'] } | { kind: 'mnemonic'; body: Api['MnemonicWriteBody'] };
type Props = { session: Api['SessionState']; onDirty: (value: boolean) => void };

export function ReferenceDirectory({ session, onDirty }: Props) {
  const [section, setSection] = useState<'partners' | 'mnemonics' | 'inns'>('partners');
  const [innDirty, setInnDirty] = useState(false);
  const [data, setData] = useState<State>();
  const [profiles, setProfiles] = useState<Profiles>({});
  const [newPartner, setNewPartner] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [deletion, setDeletion] = useState<Mnemonic>();
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Command>();
  const [page, setPage] = useState({ after: 0, items: [] as Mnemonic[], next_cursor: null as number | null });
  const alive = useRef(true), working = useRef(false);
  const partnerDirty = !!data && (JSON.stringify(profiles) !== JSON.stringify(data.profiles) || !!newPartner.trim());
  const partnerName = newPartner.trim();
  const canAddPartner = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(partnerName)
    && partnerName.toLowerCase() !== 'whitemav'
    && !Object.keys(profiles).some(name => name.toLowerCase() === partnerName.toLowerCase());
  const hasZeroFlags = Object.values(profiles).some(profile => profile.IS_MAV === '0' && profile.IS_KSS === '0');
  const mnemonicDirty = !!draft && (draft.code !== draft.originalCode || draft.description !== draft.originalDescription);
  const editable = !!data?.can_manage && !busy && !pending;
  function accept(value: State) {
    setData(value); setProfiles(value.profiles); setNewPartner(''); setDraft(undefined); setDeletion(undefined);
    setPage({ after: 0, items: value.mnemonics.slice(0, 500), next_cursor: value.mnemonics.length > 500 ? 500 : null });
  }
  async function reload() {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { const value = await api.processingSettings(); if (alive.current) accept(value); }
    catch (e) { if (alive.current) setError(e instanceof ApiFailure ? e.message : 'Не удалось связаться с сервисом.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirty(partnerDirty || mnemonicDirty || innDirty || busy || !!pending); }, [partnerDirty, mnemonicDirty, innDirty, busy, pending, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  async function execute(command: Command) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage(''); setPending(command);
    try {
      if (command.kind === 'partners') await api.writePartnerSettings(session.csrf_token, command.body);
      else await api.writeMnemonic(session.csrf_token, command.body);
      // A replay can contain an older receipt; always show the current shared settings.
      const current = await api.processingSettings();
      if (alive.current) { accept(current); setPending(undefined); setMessage(command.kind === 'partners' ? 'Настройки партнёров сохранены. Они применятся к новым исходным файлам.' : 'Справочник мнемоники сохранён.'); }
    } catch (e) {
      if (alive.current) { setDeletion(undefined); setError(e instanceof ApiFailure ? e.message : 'Не удалось связаться с сервисом.'); if (e instanceof ApiFailure && e.status >= 400 && e.status < 500) setPending(undefined); }
    } finally { working.current = false; if (alive.current) setBusy(false); }
  }
  function savePartners() {
    if (!data || !editable || partnerName || hasZeroFlags || (!partnerDirty && data.rules_ready)) return;
    void execute({ kind: 'partners', body: { operation_id: crypto.randomUUID(), expected_token: data.token, profiles } });
  }
  function saveMnemonic() {
    if (!data || !draft || !editable || !draft.code.trim() || !mnemonicDirty) return;
    void execute({ kind: 'mnemonic', body: { operation_id: crypto.randomUUID(), expected_token: data.token,
      action: draft.id ? 'edit' : 'add', mnemonic_id: draft.id, code: draft.code, description: draft.description } });
  }
  function open(item?: Mnemonic) {
    if (!editable || partnerDirty || mnemonicDirty) return;
    setError(''); setMessage('');
    if (item && draft?.id === item.id) { setDraft(undefined); return; }
    setDraft({ id: item?.id, code: item?.code ?? '', description: item?.description ?? '', originalCode: item?.code ?? '', originalDescription: item?.description ?? '' });
  }
  const editor = draft && <form className="mnemonic-editor" onSubmit={event => { event.preventDefault(); saveMnemonic(); }}>
    <FormGrid>
      <FormField id="mnemonic-code" label="Мнемоника" required help={draft.id && data?.mnemonics.find(item => item.id === draft.id)?.used_by.length ? 'Используется партнёром. Чтобы переименовать, сначала выберите для партнёра другую мнемонику.' : 'Точное значение INTERNAL_OPERATOR_NAME в выходном файле NUMBERS.'}>{props => <Input {...props} maxLength={120} value={draft.code} readOnly={!editable || !!(draft.id && data?.mnemonics.find(item => item.id === draft.id)?.used_by.length)} onChange={event => setDraft({ ...draft, code: event.target.value })} />}</FormField>
      <FormField id="mnemonic-description" label="Описание">{props => <Input {...props} maxLength={500} value={draft.description} readOnly={!editable} onChange={event => setDraft({ ...draft, description: event.target.value })} />}</FormField>
    </FormGrid>
    <div className="actions"><Button type="submit" variant="primary" disabled={!editable || !draft.code.trim() || !mnemonicDirty} loading={busy}>Сохранить мнемонику</Button><Button disabled={busy || !!pending} onClick={() => setDraft(undefined)}>Закрыть</Button></div>
  </form>;
  return <div className="reference-directory">
    <nav className="actions dictionary-sections" aria-label="Разделы справочника">
      {([['partners', 'Настройки партнёров'], ['mnemonics', 'Мнемоника'], ['inns', 'ИНН']] as const).map(([key, title]) => <Button key={key} variant={section === key ? 'primary' : 'secondary'} aria-pressed={section === key} disabled={section !== key && (partnerDirty || mnemonicDirty || innDirty || busy || !!pending)} onClick={() => { if (section === key) return; setDraft(undefined); setSection(key); setError(''); setMessage(''); }}>{title}</Button>)}
    </nav>
    {section !== 'inns' && <p>Настройки общие для платформы и применяются к новым исходным файлам.</p>}
    {section === 'inns' && <InnDirectory csrf={session.csrf_token} canEdit={!!session.user?.permissions.includes('case.edit')} onDirty={setInnDirty} />}
    {message && <Alert title="Сохранено" tone="info"><p>{message}</p></Alert>}
    {error && <Alert title="Не удалось сохранить или загрузить справочник" tone="danger"><p>{error}</p>{pending ? <Button disabled={busy} onClick={() => void execute(pending)}>Повторить сохранение</Button> : <Button disabled={busy} onClick={() => void reload()}>Обновить справочник</Button>}</Alert>}
    {!data && !error && <p role="status">Загружаем справочник…</p>}
    {data && <>
      {section !== 'inns' && !data.can_manage && <Alert title="Просмотр справочника" tone="info"><p>Для изменения настроек требуется право управления правилами обработки.</p></Alert>}
      {section === 'partners' && <section className="hub-section" aria-labelledby="partner-settings-title">
        <h2 id="partner-settings-title" className="block-title">Настройки партнёров</h2>
        <p>Выберите параметры новых файлов. Значения IS_MAV и IS_KSS можно взять из файла или задать для всего партнёра.</p>
        {!data.rules_ready && <Alert title="Правила ещё не опубликованы" tone="warning"><p>Сохраните настройки партнёров, чтобы включить автоматическую обработку новых исходных файлов.</p></Alert>}
        {data.can_manage && <form className="mnemonic-editor" onSubmit={event => {
          event.preventDefault();
          if (!editable || !canAddPartner) return;
          setProfiles(previous => ({ ...previous, [partnerName]: { SPREADING: '0', INTERNAL_OPERATOR_NAME: '' } }));
          setNewPartner('');
        }}>
          <FormField id="new-partner" label="Название нового партнёра"
            help="До 48 символов. Допустимы буквы, цифры, пробел, точка, дефис и подчёркивание.">
            {props => <Input {...props} maxLength={48} disabled={!editable} value={newPartner} onChange={event => setNewPartner(event.target.value)} />}
          </FormField>
          <Button type="submit" disabled={!editable || !canAddPartner}>Добавить партнёра</Button>
        </form>}
        <form onSubmit={event => { event.preventDefault(); savePartners(); }}>
          <div className="partner-settings-grid">{Object.keys(profiles).map((partner, index) => <FormSection key={partner} title={partner} titleLevel={3} data-form="partner-settings">
            <FormField id={`partner-${index}-mnemonic`} label="Внутреннее имя оператора">{props => <Select {...props} disabled={!editable || !!draft} value={profiles[partner]?.INTERNAL_OPERATOR_NAME ?? ''} onChange={event => setProfiles({ ...profiles, [partner]: { ...profiles[partner], INTERNAL_OPERATOR_NAME: event.target.value } })}><option value="">Без оператора — пустая ячейка</option>{data.mnemonics.map(item => <option key={item.id} value={item.code}>{item.code}{item.description ? ` — ${item.description}` : ''}</option>)}</Select>}</FormField>
            {(['IS_MAV', 'SPREADING', 'IS_KSS'] as const).map(field => <FormField key={field} id={`partner-${index}-${field}`} label={field} required={field === 'SPREADING'}>
              {props => <Select {...props} disabled={!editable || !!draft} value={profiles[partner]?.[field] ?? ''}
                onChange={event => {
                  const value = event.target.value as '0' | '1' | '';
                  setProfiles(previous => ({ ...previous, [partner]: { ...previous[partner], [field]: value || null } }));
                }}>
                {field !== 'SPREADING' && <option value="">Из файла</option>}
                <option value="0">0</option><option value="1">1</option>
              </Select>}
            </FormField>)}
          </FormSection>)}</div>
          {hasZeroFlags && <Alert title="Проверьте флаги" tone="warning"><p>IS_MAV и IS_KSS не могут одновременно быть 0.</p></Alert>}
          {data.can_manage && <div className="actions action-strip dictionary-publication"><Button type="submit" variant="primary" disabled={!editable || !!partnerName || hasZeroFlags || (!partnerDirty && data.rules_ready) || !!draft} loading={busy}>Сохранить настройки партнёров</Button>{partnerDirty && <Button disabled={!editable} onClick={() => { setProfiles(data.profiles); setNewPartner(''); }}>Отменить изменения</Button>}</div>}
        </form>
      </section>}
      {section === 'mnemonics' && <section className="hub-section" aria-labelledby="mnemonics-title"><h2 id="mnemonics-title" className="block-title">Мнемоника</h2>
        <p>Значения внутреннего имени оператора (INTERNAL_OPERATOR_NAME), доступные в настройках партнёров.</p>
        {data.can_manage && <div className="actions action-strip dictionary-addition"><Button disabled={!editable || partnerDirty || mnemonicDirty} onClick={() => open()}>Добавить мнемонику</Button></div>}
        <Disclosure open={!!draft && !draft.id}><div className="dictionary-new-entry">{draft && !draft.id && editor}</div></Disclosure>
        <Table key={data.token} showCaption={false} caption="Мнемоника" rows={page.items} rowId={row => row.id} columns={[
          { key: 'code', label: 'Мнемоника', render: row => <span className="technical-data">{row.code}</span> },
          { key: 'description', label: 'Описание', render: row => row.description || '—' },
          { key: 'partners', label: 'Используется партнёрами', render: row => row.used_by.join(', ') || 'Не назначена' },
          ...(data.can_manage ? [{ key: 'actions', label: 'Действия', render: (row: Mnemonic) => <div className="actions"><IconButton icon="edit" label={`Редактировать мнемонику ${row.code}`} aria-expanded={draft?.id === row.id} disabled={!editable || partnerDirty || mnemonicDirty} onClick={() => open(row)} /><IconButton icon="trash" danger label={`Удалить мнемонику ${row.code}`} disabled={!editable || partnerDirty || !!draft || !!row.used_by.length} onClick={() => setDeletion(row)} /></div> }] : []),
        ]} renderExpansion={row => <Disclosure open={draft?.id === row.id}>{draft?.id === row.id && editor}</Disclosure>}
          pagination={<Pagination label="Мнемоника" next={page.next_cursor} disabled={busy || !!draft} load={async after => { const offset = Number(after ?? 0), items = data.mnemonics.slice(offset, offset + 500); return { after: offset, items, next_cursor: offset + items.length < data.mnemonics.length ? offset + items.length : null }; }} onLoad={setPage} />} />
      </section>}
    </>}
    {deletion && <ConfirmDialog title={`Удалить мнемонику «${deletion.code}»?`} busy={busy} onCancel={() => { if (!pending) setDeletion(undefined); }} onConfirm={() => { if (data && editable) void execute({ kind: 'mnemonic', body: { operation_id: crypto.randomUUID(), expected_token: data.token, action: 'delete', mnemonic_id: deletion.id, description: '' } }); }} />}
  </div>;
}
