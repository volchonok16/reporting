import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ProgressiveContext, type ScrollEdge } from './ProgressiveContext';
import { windowIndices, type DisplayRows } from './progressiveWindow';
import './progressive.css';

export type TableColumn<Row> = {
  key: string;
  label: string;
  render: (row: Row) => ReactNode;
  sort?: 'ascending' | 'descending';
  onSort?: () => void;
  technical?: boolean;
};

type TableProps<Row> = {
  caption: string;
  showCaption?: boolean;
  showHeader?: boolean;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowId: (row: Row) => string;
  state?: 'ready' | 'loading' | 'empty' | 'no-results' | 'error';
  error?: string;
  filteredLabel?: string;
  selectedRowIds?: ReadonlySet<string>;
  rowTone?: (row: Row) => 'danger' | 'warning' | undefined;
  renderExpansion?: (row: Row) => ReactNode;
  pagination?: ReactNode;
  onRowClick?: (row: Row) => void;
  scrollOwner?: HTMLElement | null;
  scrollActive?: boolean;
};

export function Table<Row>({ caption, showCaption = true, showHeader = true, columns, rows, rowId, state = 'ready', error, filteredLabel, selectedRowIds, rowTone, renderExpansion, pagination, onRowClick, scrollOwner, scrollActive = true }: TableProps<Row>) {
  const region = useRef<HTMLDivElement>(null);
  const external = scrollOwner !== undefined;
  const owner = useRef<HTMLElement | null>(null); owner.current = external ? scrollOwner : region.current;
  const [index, setIndex] = useState(0), [mode, setMode] = useState<DisplayRows>('500');
  const cache = useRef(new Map<number, readonly Row[]>());
  const [, redraw] = useState(0);
  const lastOffset = useRef(0);
  const listener = useRef<((edge: ScrollEdge) => void) | undefined>(undefined);
  const pendingPage = useRef(false);
  const anchor = useRef<{ id: string; top: number; direction: ScrollEdge['direction'] } | undefined>(undefined);
  const indices = windowIndices([...cache.current.keys()], index, mode);
  const beforeHeight = pagination && indices[0] > 0 ? Math.max(160, owner.current?.clientHeight ?? 480) : 0;
  const pages = indices.map(page => ({ page, rows: page === index ? rows : cache.current.get(page) ?? [] }));
  const subscribe = useCallback((value: (edge: ScrollEdge) => void) => {
    listener.current = value;
    return () => { if (listener.current === value) listener.current = undefined; };
  }, []);
  const reset = useCallback(() => { cache.current.clear(); pendingPage.current = false; anchor.current = undefined; setIndex(0); setMode('500'); redraw(value => value + 1); if (owner.current) owner.current.scrollTop = 0; lastOffset.current = 0; }, []);
  function prepare(direction: ScrollEdge['direction']) {
    pendingPage.current = true;
    const view = owner.current;
    const visible = view && [...region.current!.querySelectorAll<HTMLElement>('[data-scroll-id]')]
      .find(row => row.getBoundingClientRect().bottom > view.getBoundingClientRect().top + 40);
    anchor.current = visible ? { id: visible.dataset.scrollId!, top: visible.getBoundingClientRect().top, direction } : undefined;
  }
  function cancel() { pendingPage.current = false; anchor.current = undefined; }
  function commit(target: number) { pendingPage.current = false; setIndex(target); }
  useLayoutEffect(() => {
    if (!pendingPage.current && state !== 'loading' && state !== 'error') cache.current.set(index, rows);
    for (const page of cache.current.keys()) if (!indices.includes(page)) cache.current.delete(page);
    const saved = anchor.current, view = owner.current;
    if (saved && view && scrollActive && !pendingPage.current) {
      const match = [...region.current!.querySelectorAll<HTMLElement>('[data-scroll-id]')].find(row => row.dataset.scrollId === saved.id);
      if (match) view.scrollTop += match.getBoundingClientRect().top - saved.top;
      else view.scrollTop = saved.direction === 'forward' ? tableOffset(view) + beforeHeight + 1 : Math.max(1, tableOffset(view) + region.current!.getBoundingClientRect().height - view.clientHeight - 1);
      anchor.current = undefined;
    }
    if (view && scrollActive) lastOffset.current = view.scrollTop;
  }, [rows, index, mode, state, scrollActive, scrollOwner]);
  function tableOffset(view: HTMLElement) { return external && region.current ? region.current.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop : 0; }
  function scroll() {
    const view = owner.current;
    if (!view || !scrollActive || !listener.current) return;
    const delta = view.scrollTop - lastOffset.current;
    lastOffset.current = view.scrollTop;
    const first = indices[0], last = indices[indices.length - 1];
    if (delta < 0 && view.scrollTop < tableOffset(view) + beforeHeight + 80 && first > 0) listener.current({ target: first - 1, direction: 'backward' });
    else if (delta > 0 && tableOffset(view) + (external ? region.current!.getBoundingClientRect().height : view.scrollHeight) - view.clientHeight - view.scrollTop < 160) listener.current({ target: last + 1, direction: 'forward' });
  }
  const scrollHandler = useRef(scroll); scrollHandler.current = scroll;
  useLayoutEffect(() => {
    const view = external ? scrollOwner : region.current;
    owner.current = view ?? null;
    if (!view || !scrollActive || !pagination) return;
    lastOffset.current = view.scrollTop;
    const handleScroll = () => scrollHandler.current();
    view.addEventListener('scroll', handleScroll);
    return () => view.removeEventListener('scroll', handleScroll);
  }, [external, scrollOwner, scrollActive, !!pagination]);
  const messages = {
    ready: undefined,
    loading: 'Загрузка данных…',
    empty: 'Записей пока нет.',
    'no-results': 'По этому фильтру записей нет.',
    error: error ?? 'Сервис недоступен. Повторите загрузку данных.',
  };
  const stateMessage = messages[state];
  const columnCount = columns.length;
  return <ProgressiveContext.Provider value={{ index, mode, first: indices[0], last: indices[indices.length - 1], prepare, cancel, commit, setMode, subscribe, reset }}><div className="table-block">
    {showCaption && <h3 className="block-title table-title">{caption}</h3>}
    {filteredLabel && <p className="secondary-text">{filteredLabel}</p>}
    {pagination}
    <div ref={region} data-progressive={pagination ? true : undefined} data-scroll-owner={external ? "external" : undefined} className="table-region" tabIndex={external ? undefined : 0} role={external ? undefined : "region"} aria-label={external ? undefined : caption}>
      <table className="data-table" aria-label={caption} aria-busy={state === 'loading' || undefined}>
        {showHeader && <thead><tr>{columns.map((column) => <th key={column.key} scope="col" aria-sort={column.sort} className={column.technical ? 'technical-header' : undefined}>
          {column.onSort ? <button className="table-sort" type="button" onClick={column.onSort}>{column.label}<span aria-hidden="true"> {column.sort === 'descending' ? '↓' : '↑'}</span></button> : column.label}
        </th>)}</tr></thead>}
        <tbody>
          {beforeHeight > 0 && <tr className="progressive-boundary"><td colSpan={columnCount} style={{ height: beforeHeight }}>Предыдущие строки загрузятся при прокрутке вверх</td></tr>}
          {stateMessage ? <tr><td colSpan={columnCount} className={state === 'error' ? 'field-error' : undefined}>{stateMessage}</td></tr>
            : pages.flatMap(({ page, rows: pageRows }) => pageRows.map((row) => {
              const id = rowId(row);
              const selected = selectedRowIds?.has(id);
              return <Fragment key={`${page}:${id}`}><tr data-scroll-id={`${page}:${id}`} aria-selected={selected || undefined} data-tone={rowTone?.(row)} className={onRowClick ? 'table-row-toggle' : undefined} onClick={onRowClick ? event => { if (!(event.target as Element).closest('button,a,input,select,textarea,summary,[role="button"]')) onRowClick(row); } : undefined}>
                {columns.map((column, index) => <td key={column.key}>{column.render(row)}{index === 0 && selected && <span className="selected-label"> (выбрано)</span>}</td>)}
              </tr>{renderExpansion && <tr className="table-expansion"><td colSpan={columnCount}>{renderExpansion(row)}</td></tr>}</Fragment>;
            }))}
        </tbody>
      </table>
    </div>
  </div></ProgressiveContext.Provider>;
}
