import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import {
  applyCellStylePatch,
  applyStyleToCellOrSelection,
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
  insertText: (text: string) => boolean
  insertTable: (rows: number, cols: number) => boolean
}

type ProductStatusCellProps = {
  value: string
  className?: string
  ariaLabel: string
  placeholder?: string
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
}

type EmbeddedTable = {
  rows: number
  cols: number
  cells: string[][]
}

const TABLE_TOKEN_PREFIX = '<<tablejson:'
const TABLE_TOKEN_SUFFIX = '>>'

function serializeEmbeddedTable(table: EmbeddedTable): string {
  const payload = JSON.stringify(table)
  return `${TABLE_TOKEN_PREFIX}${btoa(unescape(encodeURIComponent(payload)))}${TABLE_TOKEN_SUFFIX}`
}

function parseEmbeddedTable(value: string): EmbeddedTable | null {
  const { inner } = splitCellWrapper(normalizeCellValue(value))
  if (!inner.startsWith(TABLE_TOKEN_PREFIX) || !inner.endsWith(TABLE_TOKEN_SUFFIX)) {
    return null
  }
  const encoded = inner.slice(TABLE_TOKEN_PREFIX.length, -TABLE_TOKEN_SUFFIX.length)
  try {
    const raw = decodeURIComponent(escape(atob(encoded)))
    const parsed = JSON.parse(raw) as EmbeddedTable
    if (!parsed || parsed.rows < 1 || parsed.cols < 1 || !Array.isArray(parsed.cells)) return null
    const cells = Array.from({ length: parsed.rows }, (_, row) =>
      Array.from({ length: parsed.cols }, (_, col) => parsed.cells[row]?.[col] ?? ''),
    )
    return { rows: parsed.rows, cols: parsed.cols, cells }
  } catch {
    return null
  }
}

function createEmbeddedTable(rows: number, cols: number): EmbeddedTable {
  return {
    rows,
    cols,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
  }
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

function insertTextAtSelection(root: HTMLElement, text: string): boolean {
  if (!text) return false
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    root.append(document.createTextNode(text))
    return true
  }
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    root.append(document.createTextNode(text))
    return true
  }
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

const ProductStatusCellInner = forwardRef<ProductStatusCellHandle, ProductStatusCellProps>(
  function ProductStatusCell(
    { value, className, ariaLabel, placeholder, onChange, onFocus, onBlur },
    ref,
  ) {
    const elementRef = useRef<HTMLDivElement>(null)
    const lastSerialized = useRef<string | null>(null)
    const cellStyleRef = useRef<CellStyle>({ bg: null, border: null })

    const tableData = parseEmbeddedTable(value)

    useLayoutEffect(() => {
      const element = elementRef.current
      if (!element || value === lastSerialized.current || tableData) {
        return
      }
      const normalized = normalizeCellValue(value)
      const { cellStyle, inner } = splitCellWrapper(normalized)
      cellStyleRef.current = cellStyle
      applyCellStyle(element, cellStyle)
      renderSegments(inner, element)
      lastSerialized.current = value
    }, [tableData, value])

    const commitValue = (nextSerialized: string) => {
      lastSerialized.current = nextSerialized
      onChange(nextSerialized)
    }

    const handleFormattingShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
      const isPrimary = event.ctrlKey || event.metaKey
      if (!isPrimary || event.altKey) return
      const key = event.key.toLowerCase()
      let patch: Partial<TextStyleSegment> | null = null
      if (key === 'b') patch = { bold: true }
      else if (key === 'i') patch = { italic: true }
      else if (key === 'u') patch = { underline: true }
      else if (key === 'x' && event.shiftKey) patch = { strike: true }
      if (!patch) return
      event.preventDefault()
      const element = elementRef.current
      if (!element) return
      const applied = applyStyleToCellOrSelection(element, patch)
      if (!applied) return
      commitValue(serializeEditableCell(element, cellStyleRef.current))
    }

    useImperativeHandle(ref, () => ({
      applyTextStyle(patch) {
        const element = elementRef.current
        if (!element || tableData) return false
        const applied = applyStyleToCellOrSelection(element, patch)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      applyCellStyle(patch) {
        const element = elementRef.current
        if (!element || tableData) return false
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
        if (!element || tableData) return false
        const applied = clearFormattingInCell(element)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      insertText(text) {
        const element = elementRef.current
        if (!element || tableData) return false
        const inserted = insertTextAtSelection(element, text)
        if (!inserted) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      insertTable(rows, cols) {
        if (rows < 1 || cols < 1) return false
        const table = createEmbeddedTable(rows, cols)
        commitValue(serializeEmbeddedTable(table))
        return true
      },
    }), [tableData, value])

    if (tableData) {
      return (
        <div
          className={className}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <table className="product-status-inline-table">
            <tbody>
              {tableData.cells.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, colIndex) => (
                    <td key={colIndex}>
                      <input
                        className="product-status-inline-table-input"
                        value={cell}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        onChange={(event) => {
                          const nextTable: EmbeddedTable = {
                            rows: tableData.rows,
                            cols: tableData.cols,
                            cells: tableData.cells.map((items) => [...items]),
                          }
                          nextTable.cells[rowIndex][colIndex] = event.target.value
                          commitValue(serializeEmbeddedTable(nextTable))
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    return (
      <div
        ref={elementRef}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        className={className}
        data-placeholder={placeholder}
        onKeyDown={handleFormattingShortcut}
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

const ProductStatusCell = memo(ProductStatusCellInner, (prev, next) => {
  return (
    prev.value === next.value &&
    prev.className === next.className &&
    prev.ariaLabel === next.ariaLabel
  )
})

export default ProductStatusCell
