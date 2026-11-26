import { useEffect, useId, useRef, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Button } from '../../components/Button';
import { Input, Select } from '../../components/Controls';
import { Disclosure } from '../../components/Disclosure';
import { FormField } from '../../components/FormField';
import { errorText } from '../hub/model';
import { validateFields } from '../hub/validateFields';

export function WhitemavInnPicker({ value, csrf, disabled, onChange, onBusy, preserveSelection = false }: {
  value: string; csrf: string; disabled: boolean; onChange: (value: string) => void; onBusy?: (value: boolean) => void; preserveSelection?: boolean;
}) {
  const id = useId();
  const alive = useRef(true);
  const [items, setItems] = useState<Api['WhitemavInnEntry'][]>([]);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false), [pending, setPending] = useState(''), [error, setError] = useState('');
  const [companyName, setCompanyName] = useState('');
  useEffect(() => {
    alive.current = true;
    let active = true;
    onBusy?.(true);
    void api.whitemavInns().then(result => { if (active) {
      setItems(result.entries);
      if (!preserveSelection && !result.items.includes(value)) onChange(result.items[0] ?? '');
    } })
      .catch(error => { if (active) setError(errorText(error)); })
      .finally(() => { if (active) { setLoading(false); onBusy?.(false); } });
    return () => { active = false; alive.current = false; onBusy?.(false); };
  }, []);
  async function add() {
    const issue = validateFields({ INN: pending }, ['INN'])[0];
    if (issue) { setError(issue.message); return; }
    if (items.some(item => item.inn === pending)) { setError('Этот ИНН уже есть в списке. Название компании можно изменить в справочнике, в разделе «ИНН».'); return; }
    setSaving(true); onBusy?.(true); setError('');
    try {
      const result = await api.addWhitemavInn(csrf, pending, companyName);
      if (!alive.current) return;
      setItems(result.entries); onChange(pending); setPending(''); setCompanyName(''); setOpen(false);
    } catch (error) { setError(errorText(error)); }
    finally { setSaving(false); onBusy?.(false); }
  }
  return <div className="whitemav-inn-picker">
    <FormField id={`${id}-choice`} label="ИНН для исключений" required help="Этот ИНН будет указан во всех строках выходного NUMBERS.">{props =>
      <Select {...props} value={value} disabled={disabled || loading || saving} onChange={event => onChange(event.target.value)}>
        <option value="">{loading ? 'Загружаем ИНН…' : items.length ? 'Выберите ИНН' : 'Добавьте ИНН для обработки'}</option>
        {preserveSelection && value && !items.some(item => item.inn === value) && <option value={value}>{value} — сохранён в этой обработке</option>}
        {items.map(item => <option key={item.inn} value={item.inn}>{item.inn} — {item.company_name || 'Название не указано'}</option>)}
      </Select>}</FormField>
    <div className="actions"><Button disabled={disabled || loading || saving} aria-expanded={open} aria-controls={`${id}-add`} onClick={() => { setOpen(!open); setError(''); }}>Добавить ИНН</Button></div>
    <Disclosure id={`${id}-add`} open={open}>
      <FormField id={`${id}-new`} label="Новый ИНН" help="10 или 12 цифр с корректными контрольными разрядами.">{props => <Input {...props} value={pending} inputMode="numeric" maxLength={12} disabled={disabled || saving} onChange={event => { setPending(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!disabled && !saving && pending) void add(); } }} />}</FormField>
      <FormField id={`${id}-company`} label="Название компании">{props => <Input {...props} value={companyName} maxLength={500} disabled={disabled || saving} onChange={event => setCompanyName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!disabled && !saving && pending) void add(); } }} />}</FormField>
      <div className="actions"><Button disabled={disabled || saving || !pending} loading={saving} onClick={() => void add()}>Сохранить ИНН</Button></div>
    </Disclosure>
    {error && <p role="alert" className="field-error">{error}</p>}
  </div>;
}
