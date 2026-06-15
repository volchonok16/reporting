import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import {
  applyCellStylePatch,
  applyStyleToSelection,
  clearFormattingInCell,
  createStyledMark,
  normalizeCellValue,
  normalizeTextSegment,
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
    const normalized = normalizeTextSegment(segment)
    const hasStyle =
      normalized.bg || normalized.fg || normalized.strike || normalized.bold || normalized.italic
    if (!hasStyle) {
      container.append(document.createTextNode(normalized.text))
      continue
    }
    container.append(createStyledMark(normalized))
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
      const normalized = normalizeCellValue(value)
      const { cellStyle, inner } = splitCellWrapper(normalized)
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
        const applied = clearFormattingInCell(element)
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
