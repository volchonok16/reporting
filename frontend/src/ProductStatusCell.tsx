import { useEffect, useRef } from 'react'
import { serializeEditableCell, splitHighlightSegments } from './productStatusRichText'

type ProductStatusCellProps = {
  value: string
  className?: string
  ariaLabel: string
  onChange: (value: string) => void
}

function renderSegments(value: string, container: HTMLElement) {
  container.replaceChildren()
  for (const segment of splitHighlightSegments(value)) {
    if (!segment.text) {
      continue
    }
    if (segment.highlighted) {
      const mark = document.createElement('mark')
      mark.className = 'product-status-highlight'
      mark.textContent = segment.text
      container.append(mark)
      continue
    }
    container.append(document.createTextNode(segment.text))
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
  const lastSerialized = useRef(value)

  useEffect(() => {
    const element = ref.current
    if (!element || value === lastSerialized.current) {
      return
    }
    renderSegments(value, element)
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
        const serialized = serializeEditableCell(event.currentTarget)
        lastSerialized.current = serialized
        onChange(serialized)
      }}
    />
  )
}
