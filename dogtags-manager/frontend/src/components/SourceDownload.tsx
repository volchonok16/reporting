import { useState } from 'react';
import { api } from '../api/client';

export function SourceDownload({ caseId, sourceId, filename, label = 'Скачать исходник' }: {
  caseId: string; sourceId: string; filename?: string; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    try { await api.downloadSource(caseId, sourceId, filename); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось скачать исходник.'); }
    finally { setBusy(false); }
  }
  return <span><button className="button" disabled={busy} onClick={() => void download()}>{busy ? 'Скачиваем…' : label}</button>
    {error && <span role="alert">{error}</span>}</span>;
}
