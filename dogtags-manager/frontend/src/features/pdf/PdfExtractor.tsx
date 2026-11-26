import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { Input, Select, Textarea } from '../../components/Controls';
import { FormField } from '../../components/FormField';
import { FormSection } from '../../components/FormGrid';
import { SaveAsButton } from '../../components/SaveAsButton';
import { phoneListText, uniquePhoneNumbers } from './phoneNumbers';
import { readPdfPhones, type PdfPhoneResult } from './readPdf';
import { savePhoneList } from './saveList';

export function PdfExtractor({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<PdfPhoneResult>();
  const [deduplicate, setDeduplicate] = useState(true);
  const [format, setFormat] = useState<'txt' | 'csv'>('txt');
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  const unique = useMemo(() => uniquePhoneNumbers(result?.numbers ?? []), [result]);
  const numbers = deduplicate ? unique : result?.numbers ?? [];
  useEffect(() => { onBusy(busy || saving); }, [busy, saving, onBusy]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy]);
  async function extract() {
    if (!file || busy) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy(true); setError(''); setMessage(''); setResult(undefined); setProgress({ page: 0, total: 0 });
    try {
      const value = await readPdfPhones(file, operation.signal, (page, total) => { if (alive.current) setProgress({ page, total }); });
      if (alive.current && !operation.signal.aborted) setResult(value);
    } catch (cause) {
      if (!alive.current) return;
      if (operation.signal.aborted) setMessage('Извлечение отменено.');
      else if (cause instanceof Error && cause.name === 'PasswordException') setError('PDF защищён паролем. Загрузите копию без защиты.');
      else setError('Не удалось прочитать PDF. Проверьте, что файл не повреждён и содержит выделяемый текст.');
    } finally { if (alive.current) setBusy(false); }
  }
  async function download(chooseLocation = false) {
    if (!file || !numbers.length || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const name = `${file.name.replace(/\.pdf$/i, '')}-numbers.${format}`;
      const outcome = await savePhoneList(name, phoneListText(numbers, format), chooseLocation);
      if (alive.current) setMessage(outcome === 'saved' ? 'Список сохранён в выбранном месте.' : outcome === 'cancelled' ? 'Сохранение отменено.' : 'Список передан браузеру для скачивания.');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Не удалось скачать список.'); }
    finally { if (alive.current) setSaving(false); }
  }
  return <section className="hub-group" aria-label="Экстрактор данных из PDF">
    <FormSection title="Извлечь телефонные номера">
      <p>Загрузите PDF с выделяемым текстом. Соберём номера со всех страниц в один список. Файл обрабатывается в браузере и не отправляется на сервер.</p>
      <FormField id="pdf-source" label="PDF-файл" help="Номера из 10 цифр или 11 цифр с началом 7/8. Пробелы, скобки и дефисы удаляются; начальные цифры сохраняются. Сканы без текстового слоя не распознаются.">{props => <Input {...props} type="file" accept=".pdf,application/pdf" disabled={busy || saving} onChange={event => { setFile(event.target.files?.[0]); setResult(undefined); setError(''); setMessage(''); }} />}</FormField>
      {file && <p className="secondary-text">{file.name} · {(file.size / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} МБ</p>}
      <div className="actions"><Button variant="primary" disabled={!file || busy || saving} loading={busy} onClick={() => void extract()}>Извлечь номера</Button>{busy && <Button onClick={() => controller.current?.abort()}>Отменить извлечение</Button>}</div>
      {busy && <p role="status">{progress.total ? `Обработано страниц: ${progress.page} из ${progress.total}` : 'Открываем PDF…'}</p>}
    </FormSection>
    {error && <div role="alert"><Alert title="Не удалось выполнить действие" tone="danger"><p>{error}</p></Alert></div>}
    {result && <FormSection title="Единый список номеров">
      <p role="status">Обработано страниц: {result.pages}. Найдено номеров: {result.numbers.length}. Уникальных: {unique.length}.</p>
      {!!result.pagesWithoutText.length && <Alert title="Есть страницы без текста" tone="warning"><p>Страниц без доступного текста: {result.pagesWithoutText.length}. Если на них есть номера в виде изображения, они не попали в список: потребуется распознавание скана.</p></Alert>}
      {result.numbers.length ? <>
        <div className="check-options"><label><input type="checkbox" checked={deduplicate} disabled={saving} onChange={event => { setDeduplicate(event.target.checked); setMessage(''); }} />Удалить повторяющиеся номера</label></div>
        <FormField id="pdf-result" label={`Предпросмотр: ${Math.min(numbers.length, 200)} из ${numbers.length} номеров`} help="Один номер на строку. Скачивание содержит полный список. Проверьте номера перед использованием.">{props => <Textarea {...props} readOnly rows={10} value={numbers.slice(0, 200).join('\n')} />}</FormField>
        <FormField id="pdf-format" label="Формат списка" help="TXT — только номера. CSV — одна колонка MSISDN.">{props => <Select {...props} value={format} disabled={saving} onChange={event => { setFormat(event.target.value as 'txt' | 'csv'); setMessage(''); }}><option value="txt">TXT</option><option value="csv">CSV</option></Select>}</FormField>
        <div className="actions"><Button variant="primary" disabled={saving} loading={saving} onClick={() => void download()}>Скачать список</Button><SaveAsButton label="Сохранить список номеров как…" disabled={saving} onSave={chooseLocation => void download(chooseLocation)} /></div>
      </> : <Alert title="Номера не найдены" tone="info"><p>Не обнаружены телефонные номера подходящего формата. Если PDF является сканом, сначала потребуется распознавание текста.</p></Alert>}
    </FormSection>}
    {message && <Alert title="Экстрактор PDF"><p>{message}</p></Alert>}
  </section>;
}
