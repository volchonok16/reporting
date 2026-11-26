import { useRef, useState } from 'react';
import './sidebar.css';

type Props = { section: 'marking' | 'archive' | 'dictionary' | 'pdf'; onMarking: () => void; onArchive: () => void; onDictionary: () => void; onPdf: () => void };

export function Sidebar({ section, onMarking, onArchive, onDictionary, onPdf }: Props) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  function close() { setExpanded(false); toggle.current?.focus(); }
  function navigate(action: () => void) {
    action();
    if (window.matchMedia('(max-width: 47.999rem)').matches) close();
  }
  return <>
    {expanded && <button className="sidebar-backdrop" aria-label="Закрыть меню" onClick={close} />}
    <aside className={`sidebar${expanded ? ' sidebar--expanded' : ''}`} onKeyDown={event => {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); close(); }
    }}>
      <div className="sidebar-heading">
        <span className="sidebar-brand" aria-hidden="true">DT</span>
        <span className="sidebar-label sidebar-product">DOGTAGS<br />MANAGER</span>
      </div>
      <button ref={toggle} className="sidebar-action sidebar-toggle" aria-expanded={expanded}
        aria-controls="main-navigation" aria-label={expanded ? 'Свернуть меню' : 'Раскрыть меню'}
        title={expanded ? 'Свернуть меню' : 'Раскрыть меню'} onClick={() => setExpanded(value => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'M14 6l-6 6 6 6' : 'M4 6h16M4 12h16M4 18h16'} /></svg>
        <span className="sidebar-label">Свернуть меню</span>
      </button>
      <nav id="main-navigation" aria-label="Главное меню">
        <button className={`sidebar-action${section === 'marking' ? ' sidebar-action--active' : ''}`} aria-label="Маркировка" title="Маркировка"
          aria-current={section === 'marking' ? 'page' : undefined} onClick={() => navigate(onMarking)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8l10 10-8 8L3 11V3Z" /><circle cx="7.5" cy="7.5" r="1" /></svg>
          <span className="sidebar-label">Маркировка</span>
        </button>
        <button className={`sidebar-action${section === 'archive' ? ' sidebar-action--active' : ''}`} aria-label="Архив" title="Архив"
          aria-current={section === 'archive' ? 'page' : undefined} onClick={() => navigate(onArchive)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v14h14V7M9 12h6" /></svg>
          <span className="sidebar-label">Архив</span>
        </button>
        <button className={`sidebar-action${section === 'dictionary' ? ' sidebar-action--active' : ''}`} aria-label="Справочник" title="Справочник"
          aria-current={section === 'dictionary' ? 'page' : undefined} onClick={() => navigate(onDictionary)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3V3ZM4 17h16M8 7h8M8 11h6" /></svg>
          <span className="sidebar-label">Справочник</span>
        </button>
        <button className={`sidebar-action${section === 'pdf' ? ' sidebar-action--active' : ''}`} aria-label="Экстрактор PDF" title="Экстрактор PDF"
          aria-current={section === 'pdf' ? 'page' : undefined} onClick={() => navigate(onPdf)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h8" /></svg>
          <span className="sidebar-label">Экстрактор PDF</span>
        </button>
      </nav>

    </aside>
  </>;
}
