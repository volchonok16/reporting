import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

type Props = { filename: string; date: string; dateTime: string; partner: string; selected: boolean; intakeId: string; onSelect: () => void };
export function ArchiveEntryButton({ filename, date, dateTime, partner, selected, intakeId, onSelect }: Props) {
  const box = useRef<HTMLSpanElement>(null), fullName = useRef<HTMLElement>(null);
  const [heights, setHeights] = useState({ line: 24, full: 24 });
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const expanded = (hovered || focused) && heights.full > heights.line;
  useLayoutEffect(() => {
    const node = box.current, full = fullName.current;
    if (!node || !full) return;
    const measure = () => {
      if (!node.clientWidth) return;
      const line = parseFloat(getComputedStyle(full).lineHeight) || 24;
      const height = Math.max(line, full.scrollHeight);
      setHeights(previous => previous.line === line && previous.full === height ? previous : { line, full: height });
    };
    const observer = new ResizeObserver(measure); observer.observe(full); measure();
    return () => observer.disconnect();
  }, [filename]);
  return <button type="button" className="archive-record-select" aria-label={`Открыть обработку ${filename} от ${date}`} aria-pressed={selected} data-intake-id={intakeId} data-name-expanded={expanded}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={event => setFocused(event.currentTarget.matches(':focus-visible'))} onBlur={() => setFocused(false)} onClick={onSelect}>
    <span ref={box} className="archive-name-box" style={{ height: expanded ? heights.full : heights.line } as CSSProperties}>
      <strong className="archive-name-short" aria-hidden="true">{filename}</strong>
      <strong ref={fullName} className="archive-name-full">{filename}</strong>
    </span>
    <time dateTime={dateTime}>{date}</time><span>{partner}</span>
  </button>;
}
