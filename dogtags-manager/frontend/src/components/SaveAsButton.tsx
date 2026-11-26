import { useState } from 'react';
import { canChooseDownloadLocation } from '../api/client';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

export function SaveAsButton({ label, disabled, onSave }: {
  label: string; disabled: boolean; onSave: (chooseLocation: boolean) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return <>
    <Button aria-label={label} disabled={disabled} onClick={() => canChooseDownloadLocation() ? onSave(true) : setHelpOpen(true)}>Сохранить как…</Button>
    {helpOpen && <ConfirmDialog title="Выбор папки для скачивания" busy={false} destructive={false} confirmLabel="Скачать файл" onCancel={() => setHelpOpen(false)} onConfirm={() => { setHelpOpen(false); onSave(false); }}>
      <p>Этот браузер выбирает папку через настройки загрузок. Приложение не может открыть системный выбор папки самостоятельно.</p>
      <p>В Safari откройте «Настройки» → «Основные» → «Папка загрузки файлов» и выберите «Спрашивать при каждой загрузке».</p>
      <p>После этого нажмите «Скачать файл»: Safari предложит выбрать папку. Без этой настройки файл сохранится в обычную папку загрузок.</p>
    </ConfirmDialog>}
  </>;
}
