import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ProgressiveContext, type ScrollEdge } from './ProgressiveContext';
import { pageCursor, type Cursor, type DisplayRows } from './progressiveWindow';

export type PageCursor = Cursor;
type Props<Page> = { label: string; next?: string | number | null; initialAfter?: PageCursor; disabled?: boolean; loadManagesState?: boolean; showEndStatus?: boolean; showFilter?: boolean; toolbarActions?: ReactNode; toolbarAfter?: ReactNode;
  load: (after: PageCursor) => Promise<Page>; onLoad: (page: Page) => void; };

/** Cursor transport adapter. Table owns the bounded render window and measured scroll anchor. */
export function Pagination<Page>({ label, next, initialAfter, disabled = false, loadManagesState = false, showEndStatus = false, showFilter = true, toolbarActions, toolbarAfter, load, onLoad }: Props<Page>) {
  const filterId = useId();
  const filterButton = useRef<HTMLButtonElement>(null);
  const table = useContext(ProgressiveContext);
  const ledger = useRef<PageCursor[]>([initialAfter]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const sequence = useRef(0), alive = useRef(true), loading = useRef(false);
  const latest = useRef({ table, next, disabled, loadManagesState, load, onLoad });
  latest.current = { table, next, disabled, loadManagesState, load, onLoad };
  const failed = useRef<ScrollEdge | undefined>(undefined);
  const end = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!table) return;
    if (next != null) { ledger.current[table.index + 1] = next; if (end.current != null && end.current <= table.index) end.current = undefined; }
    else if (next === null) end.current = table.index + 1;
  }, [table?.index, next]);
  useEffect(() => {
    alive.current = true; latest.current.table?.reset();
    return () => { alive.current = false; ++sequence.current; };
  }, []);
  async function go(edge: ScrollEdge) {
    const current = latest.current;
    if (loading.current || current.disabled || !current.table || end.current != null && edge.target >= end.current) return;
    const target = pageCursor(ledger.current, edge.target, current.next);
    if (!target) return;
    const request = ++sequence.current;
    loading.current = true; current.table.prepare(edge.direction); setBusy(true); setError(''); failed.current = undefined;
    try {
      const page = await current.load(target.cursor);
      if (!alive.current || request !== sequence.current) return;
      if (page === false || latest.current.disabled && !current.loadManagesState) { current.table.cancel(); return; }
      current.table.commit(edge.target);
      current.onLoad(page);
      ledger.current[edge.target] = target.cursor;
    } catch (value) {
      if (alive.current && request === sequence.current) { current.table.cancel(); failed.current = edge; setError(value instanceof Error ? value.message : 'Не удалось загрузить строки.'); }
    } finally {
      if (alive.current && request === sequence.current) { loading.current = false; setBusy(false); }
    }
  }
  useEffect(() => table?.subscribe(edge => { if (!failed.current) void go(edge); }), [table?.subscribe]);
  useEffect(() => {
    if (table?.mode === '1000' && table.first === table.last && next != null && !disabled && !busy && !error) void go({ target: table.last + 1, direction: 'forward' });
  }, [table?.mode, table?.first, table?.last, next, disabled, busy, error]);
  const filterOptions = <div id={filterId} className="progressive-options">
    <h3>Количество строк</h3>
    <div role="radiogroup" aria-label="Количество строк">{(['500', '1000', 'all'] as DisplayRows[]).map(value => <label key={value}><input type="radio" name={filterId} value={value} checked={(table?.mode ?? '500') === value} disabled={disabled || busy} onChange={() => { table?.setMode(value); }} /><span>{value === 'all' ? 'Все строки' : `${value} строк`}</span></label>)}</div>
  </div>;
  return <div hidden={!showFilter && !busy && !error} className="progressive-toolbar progressive-toolbar--compact progressive-toolbar--inline" aria-label={`${showFilter ? 'Фильтр списка' : 'Загрузка списка'}: ${label}`} aria-busy={busy || undefined}>
    {(busy || showEndStatus) && <p className="secondary-text progressive-status" role="status">{busy ? 'Загружаем строки…' : next == null ? 'Конец списка' : 'Следующие строки загрузятся при прокрутке'}</p>}
    {toolbarActions}
    {showFilter && <div className="progressive-filter progressive-filter--inline" data-open={open} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); filterButton.current?.focus(); } }}>
      <button ref={filterButton} type="button" className="icon-button" aria-label={`Фильтр: ${label}`} title="Фильтр" aria-expanded={open} aria-controls={filterId} onClick={() => setOpen(value => !value)} disabled={disabled || busy}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></svg></button>
      <div className="progressive-inline-reveal" inert={!open} aria-hidden={!open}>{filterOptions}</div>
    </div>}
    {toolbarAfter}
    {error && <div role="alert" className="field-error">{error}<button type="button" className="button" disabled={disabled || busy} onClick={() => { if (failed.current) void go(failed.current); }}>Повторить загрузку</button></div>}
  </div>;
}
