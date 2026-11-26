import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Intake } from './model';

type Props = { selected?: Intake; onSelect: (row: Intake) => void; actions: ReactNode;
  renderList: (active: boolean, select: (row: Intake) => void) => ReactNode;
  renderDetail: (owner: HTMLElement | null, active: boolean) => ReactNode };
export function ArchiveWorkspace({ selected, onSelect, actions, renderList, renderDetail }: Props) {
  const container = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), back = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(true), [detail, setDetail] = useState(false), [owner, setOwner] = useState<HTMLDivElement | null>(null);
  const saved = useRef<{ top: number; id?: string; offset?: number } | undefined>(undefined);
  const previousId = useRef<string | undefined>(undefined);
  const hidden = !wide && detail && !!selected;
  useLayoutEffect(() => {
    const button = back.current;
    if (wide || !button || !owner) return;
    const measure = () => owner.style.setProperty('--archive-back-height', `${button.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure); observer.observe(button); measure();
    return () => { observer.disconnect(); owner.style.removeProperty('--archive-back-height'); };
  }, [wide, owner, !!selected]);
  function savePosition() {
    const region = list.current?.querySelector<HTMLElement>('.table-region');
    if (!region) return;
    const row = [...region.querySelectorAll<HTMLElement>('[data-scroll-id]')].find(row => row.getBoundingClientRect().bottom > region.getBoundingClientRect().top + 40);
    saved.current = { top: region.scrollTop, id: row?.dataset.scrollId, offset: row ? row.getBoundingClientRect().top - region.getBoundingClientRect().top : undefined };
  }
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const resize = () => {
      const next = node.clientWidth >= 64 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (!next && wide && selected) {
        savePosition(); setDetail(true);
        if (list.current?.contains(document.activeElement)) requestAnimationFrame(() => back.current?.focus({ preventScroll: true }));
      }
      setWide(next);
    };
    const observer = new ResizeObserver(resize); observer.observe(node); observer.observe(document.documentElement); resize();
    return () => observer.disconnect();
  }, [wide, !!selected]);
  useLayoutEffect(() => {
    const id = selected?.intake.id;
    if (id !== previousId.current) {
      previousId.current = id;
      if (owner) { owner.scrollTop = 0; owner.scrollLeft = 0; }
      if (!id) setDetail(false);
    }
  }, [selected?.intake.id, owner]);
  useLayoutEffect(() => {
    if (hidden || !saved.current) return;
    const region = list.current?.querySelector<HTMLElement>('.table-region');
    if (!region) return;
    const snapshot = saved.current;
    region.scrollTop = snapshot.top;
    const row = [...region.querySelectorAll<HTMLElement>('[data-scroll-id]')].find(row => row.dataset.scrollId === snapshot.id);
    if (row && snapshot.offset != null) region.scrollTop += row.getBoundingClientRect().top - region.getBoundingClientRect().top - snapshot.offset;
    saved.current = undefined;
    const button = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? row?.querySelector<HTMLButtonElement>('button');
    button?.focus({ preventScroll: true });
  }, [hidden]);
  function choose(row: Intake) {
    savePosition(); onSelect(row); setDetail(true);
    if (!wide) requestAnimationFrame(() => back.current?.focus({ preventScroll: true }));
  }
  return <div ref={container} className="archive-workspace" data-wide={wide} data-detail={hidden}>
    <div ref={list} className="archive-list" hidden={hidden} inert={hidden}>{renderList(!hidden, choose)}</div>
    <div ref={setOwner} className="archive-viewer" hidden={!wide && !hidden} role="region" aria-label="Просмотр обработки" tabIndex={0}>
      {selected ? <>
        {!wide && <button className="button" type="button" ref={back} onClick={() => setDetail(false)}>Назад к списку</button>}
        <section className="archive-actions-section" aria-labelledby="archive-actions-title"><h2 id="archive-actions-title">Действия с исходным файлом</h2><div className="archive-detail-actions">{actions}</div></section>
        {renderDetail(owner, wide || hidden)}
      </> : <p>Выберите обработку из списка.</p>}
    </div>
  </div>;
}
