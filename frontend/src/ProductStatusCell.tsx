import { useLayoutEffect, useRef } from 'react'
import {
  serializeEditableCell,
  splitCellWrapper,
  splitStyleSegments,
  type CellStyle,
} from './productStatusRichText'

type ProductStatusCellProps = {
  value: string
  className?: string
  ariaLabel: string
  onChange: (value: string) => void
}

function applyCellStyle(element: HTMLElement, cellStyle: CellStyle) {
  element.style.backgroundColor = cellStyle.bg ? `#${cellStyle.bg}` : ''
  element.style.border = cellStyle.border ? `2px solid #${cellStyle.border}` : ''
}

function renderSegments(inner: string, container: HTMLElement) {
  container.replaceChildren()
  for (const segment of splitStyleSegments(inner)) {
    if (!segment.text) continue
    const hasStyle =
      segment.bg || segment.fg || segment.strike || segment.bold || segment.italic
    if (!hasStyle) {
      container.append(document.createTextNode(segment.text))
      continue
    }
    const mark = document.createElement('mark')
    mark.className = 'product-status-highlight'
    if (segment.bg) {
      mark.dataset.bg = segment.bg
      mark.style.backgroundColor = `#${segment.bg}`
    }
    if (segment.fg) {
      mark.dataset.fg = segment.fg
      mark.style.color = `#${segment.fg}`
    }
    if (segment.strike) {
      mark.dataset.strike = '1'
      mark.style.textDecoration = 'line-through'
    }
    if (segment.bold) {
      mark.dataset.bold = '1'
      mark.style.fontWeight = '600'
    }
    if (segment.italic) {
      mark.dataset.italic = '1'
      mark.style.fontStyle = 'italic'
    }
    mark.textContent = segment.text
    container.append(mark)
  }
  if (!container.childNodes.length) {
    container.append(document.createTextNode(''))
  }
}

export default function ProductStatusCell({
  value,
  className,
  ariaLabel,
  onChange,
}: ProductStatusCellProps) {
  const ref = useRef<HTMLDivElement>(null)
  const lastSerialized = useRef<string | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || value === lastSerialized.current) {
      return
    }
    const { cellStyle, inner } = splitCellWrapper(value)
    applyCellStyle(element, cellStyle)
    renderSegments(inner, element)
    lastSerialized.current = value
  }, [value])

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      className={className}
      onBlur={(event) => {
        const { cellStyle } = splitCellWrapper(value)
        const serialized = serializeEditableCell(event.currentTarget, cellStyle)
        lastSerialized.current = serialized
        onChange(serialized)
      }}
    />
  )
}
