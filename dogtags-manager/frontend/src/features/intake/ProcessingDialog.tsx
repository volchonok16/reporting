import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';

type Props = { filename: string; percent: number; stage: string; count: number; error?: string; onRefresh: () => void };
export function ProcessingDialog({ filename, percent, stage, count, error, onRefresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const overflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="processing-dialog" aria-modal="true" aria-labelledby="processing-title" aria-describedby="processing-help" onCancel={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }}>
    <div className="processing-animation" aria-hidden="true"><svg viewBox="0 0 64 64"><circle className="processing-ring-track" cx="32" cy="32" r="27" /><circle className="processing-ring-active" cx="32" cy="32" r="27" /><path d="M24 20h12l6 6v18H24Z M36 20v7h6 M28 33h10 M28 38h7" /></svg></div>
    <h2 id="processing-title" tabIndex={-1} autoFocus>Обрабатываем файл</h2>
    <p className="processing-filename">{filename}</p>
    {count > 1 && <p className="processing-count">Файлов в обработке: {count}</p>}
    <div className="processing-status" role="status"><span>{stage}</span><strong>{percent}%</strong></div>
    <div className="processing-bar" role="progressbar" aria-label="Выполнение этапов проверки" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}% — ${stage}`}><div style={{ width: `${percent}%` }} /></div>
    <p id="processing-help" className="processing-help">Дождитесь завершения всех проверок. Затем появятся результаты и найденные ошибки.</p>
    <p className="processing-note">Процент обновляется по мере завершения этапов.</p>
    {error && <div className="processing-connection" role="alert"><p>{error}</p><Button onClick={onRefresh}>Обновить соединение</Button></div>}
  </dialog>;
}
