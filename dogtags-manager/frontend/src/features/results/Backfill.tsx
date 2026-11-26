import { useEffect, useRef, useState } from 'react';
import { api, type Api } from '../../api/client';
import { Alert } from '../../components/Alert';
import { Button } from '../../components/Button';
import { errorText } from '../hub/model';

/** Every batch commits a durable server cursor. Stop scheduling on error/unmount. */
export function Backfill({ csrf, artifactId, onProgress }: { csrf: string; artifactId?: string; onProgress: () => void }) {
  const [progress, setProgress] = useState<Api['RegistryBatchState']>();
  const [error, setError] = useState(''), [restart, setRestart] = useState(0);
  const notify = useRef(onProgress); notify.current = onProgress;
  useEffect(() => {
    let live = true; setError('');
    async function resume() {
      try {
        while (live) {
          const batch = await api.backfill(csrf, artifactId);
          if (!live) return;
          setProgress(batch); notify.current();
          if (artifactId ? batch.artifact_complete : batch.complete) return;
        }
      } catch (e) { if (live) setError(errorText(e)); }
    }
    void resume(); return () => { live = false; };
  }, [csrf, artifactId, restart]);
  if (error) return <Alert title="Обновление реестра остановлено" tone="warning"><p>{error} Уже прочитанные данные сохранены.</p><Button onClick={() => setRestart(value => value + 1)}>Продолжить обновление реестра</Button></Alert>;
  if (!progress || !(artifactId ? progress.artifact_complete : progress.complete)) return <p role="status">Читаем подготовленные версии для сверки. {progress?.cursor != null && `Текущий файл: ${progress.cursor} из ${progress.expected_rows ?? 'неизвестного числа'} строк.`}</p>;
  return <p className="secondary-text">Подготовленные версии учтены. Это не подтверждает внешнюю загрузку.</p>;
}
