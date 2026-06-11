import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import {
  applyCellStylePatch,
  applyStyleToSelection,
  clearFormattingInSelection,
  serializeEditableCell,
  splitCellWrapper,
  splitStyleSegments,
  type CellStyle,
  type TextStyleSegment,
} from './productStatusRichText'

export type ProductStatusCellHandle = {
  applyTextStyle: (patch: Partial<TextStyleSegment>) => boolean
  applyCellStyle: (patch: Partial<CellStyle>) => boolean
  clearFormatting: () => boolean
}

type ProductStatusCellProps = {
  value: string
  className?: string
  ariaLabel: string
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
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

const ProductStatusCell = forwardRef<ProductStatusCellHandle, ProductStatusCellProps>(
  function ProductStatusCell(
    { value, className, ariaLabel, onChange, onFocus, onBlur },
    ref,
  ) {
    const elementRef = useRef<HTMLDivElement>(null)
    const lastSerialized = useRef<string | null>(null)
    const cellStyleRef = useRef<CellStyle>({ bg: null, border: null })

    useLayoutEffect(() => {
      const element = elementRef.current
      if (!element || value === lastSerialized.current) {
        return
      }
      const { cellStyle, inner } = splitCellWrapper(value)
      cellStyleRef.current = cellStyle
      applyCellStyle(element, cellStyle)
      renderSegments(inner, element)
      lastSerialized.current = value
    }, [value])

    const commitValue = (nextSerialized: string) => {
      lastSerialized.current = nextSerialized
      onChange(nextSerialized)
    }

    useImperativeHandle(ref, () => ({
      applyTextStyle(patch) {
        const element = elementRef.current
        if (!element) return false
        const applied = applyStyleToSelection(element, patch)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      applyCellStyle(patch) {
        const element = elementRef.current
        if (!element) return false
        const next = applyCellStylePatch(lastSerialized.current ?? value, patch)
        const { cellStyle, inner } = splitCellWrapper(next)
        cellStyleRef.current = cellStyle
        applyCellStyle(element, cellStyle)
        renderSegments(inner, element)
        commitValue(next)
        return true
      },
      clearFormatting() {
        const element = elementRef.current
        if (!element) return false
        const applied = clearFormattingInSelection(element)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
    }))

    return (
      <div
        ref={elementRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        className={className}
        onFocus={onFocus}
        onBlur={(event) => {
          const serialized = serializeEditableCell(event.currentTarget, cellStyleRef.current)
          lastSerialized.current = serialized
          onChange(serialized)
          onBlur?.()
        }}
      />
    )
  },
)

export default ProductStatusCell
