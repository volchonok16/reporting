import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import {
  applyCellStylePatch,
  applyStyleToCellOrSelection,
  clearFormattingInCell,
  createStyledMark,
  displayCellText,
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
  commitPending: () => boolean
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

type EmbeddedTableDoc = {
  text: string
  table: EmbeddedTable
}

const TABLE_TOKEN_PREFIX = '<<tablejson:'
const TABLE_TOKEN_SUFFIX = '>>'

function serializeEmbeddedTableDoc(doc: EmbeddedTableDoc): string {
  const payload = JSON.stringify(doc)
  return `${TABLE_TOKEN_PREFIX}${btoa(unescape(encodeURIComponent(payload)))}${TABLE_TOKEN_SUFFIX}`
}

function parseEmbeddedTableDoc(value: string): EmbeddedTableDoc | null {
  const { inner } = splitCellWrapper(normalizeCellValue(value))
  if (!inner.startsWith(TABLE_TOKEN_PREFIX) || !inner.endsWith(TABLE_TOKEN_SUFFIX)) {
    return null
  }
  const encoded = inner.slice(TABLE_TOKEN_PREFIX.length, -TABLE_TOKEN_SUFFIX.length)
  try {
    const raw = decodeURIComponent(escape(atob(encoded)))
    const parsed = JSON.parse(raw) as EmbeddedTable | EmbeddedTableDoc
    const table = (parsed as EmbeddedTableDoc).table ?? (parsed as EmbeddedTable)
    const text = typeof (parsed as EmbeddedTableDoc).text === 'string' ? (parsed as EmbeddedTableDoc).text : ''
    if (!table || table.rows < 1 || table.cols < 1 || !Array.isArray(table.cells)) return null
    const cells = Array.from({ length: table.rows }, (_, row) =>
      Array.from({ length: table.cols }, (_, col) => table.cells[row]?.[col] ?? ''),
    )
    return { text, table: { rows: table.rows, cols: table.cols, cells } }
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

function serializeDocWithTable(doc: EmbeddedTableDoc): string {
  return serializeEmbeddedTableDoc({
    text: doc.text,
    table: doc.table,
  })
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

function tableDocToPlainText(doc: EmbeddedTableDoc): string {
  return formatEmbeddedTableDoc({ text: doc.text, table: doc.table })
}

function readTableDocFromHost(
  host: HTMLElement,
  table: EmbeddedTable,
): EmbeddedTableDoc {
  const preamble = host.querySelector('.product-status-inline-table-preamble')
  const text = preamble?.textContent ?? ''
  const nextCells: string[][] = []
  host.querySelectorAll('.product-status-inline-table tbody tr').forEach((rowElement) => {
    const row: string[] = []
    rowElement.querySelectorAll('.product-status-inline-table-cell').forEach((cellElement) => {
      row.push(cellElement.textContent ?? '')
    })
    if (row.length > 0) {
      nextCells.push(row)
    }
  })
  if (nextCells.length === 0) {
    return { text, table }
  }
  return {
    text,
    table: {
      rows: nextCells.length,
      cols: Math.max(...nextCells.map((row) => row.length), table.cols),
      cells: nextCells,
    },
  }
}

function formatEmbeddedTableDoc(parsed: { text?: string; table: EmbeddedTable }): string {
  const lines: string[] = []
  const text = (parsed.text ?? '').trim()
  if (text) lines.push(text)
  for (const row of parsed.table.cells) {
    const rowText = row.map((cell) => cell.trim()).join(' | ')
    if (rowText.replace(/\|/g, '').trim()) {
      lines.push(rowText)
    }
  }
  return lines.join('\n')
}

type InlineTableCellProps = {
  value: string
  placeholder?: string
  className?: string
  onCommit: (value: string) => void
  onFocus?: () => void
}

function InlineTableCell({
  value,
  placeholder,
  className = 'product-status-inline-table-cell',
  onCommit,
  onFocus,
}: InlineTableCellProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const lastCommitted = useRef(value)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || value === lastCommitted.current) return
    element.textContent = value
    lastCommitted.current = value
  }, [value])

  const syncRef = (element: HTMLDivElement | null) => {
    elementRef.current = element
    if (!element) return
    if (element.textContent !== value) {
      element.textContent = value
      lastCommitted.current = value
    }
  }

  return (
    <div
      ref={syncRef}
      role="textbox"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      className={className}
      data-placeholder={placeholder}
      onFocus={onFocus}
      onBlur={(event) => {
        const next = event.currentTarget.textContent ?? ''
        if (next === lastCommitted.current) return
        lastCommitted.current = next
        onCommit(next)
      }}
    />
  )
}

const ProductStatusCellInner = forwardRef<ProductStatusCellHandle, ProductStatusCellProps>(
  function ProductStatusCell(
    { value, className, ariaLabel, placeholder, onChange, onFocus, onBlur },
    ref,
  ) {
    const elementRef = useRef<HTMLDivElement>(null)
    const tableHostRef = useRef<HTMLDivElement>(null)
    const lastSerialized = useRef<string | null>(null)
    const cellStyleRef = useRef<CellStyle>({ bg: null, border: null })

    const tableDoc = parseEmbeddedTableDoc(value)

    useLayoutEffect(() => {
      if (tableDoc) {
        lastSerialized.current = value
      }
    }, [tableDoc, value])

    const commitValue = (nextSerialized: string) => {
      lastSerialized.current = nextSerialized
      onChange(nextSerialized)
    }

    const commitTableFromHost = (): boolean => {
      const host = tableHostRef.current
      if (!host || !tableDoc) return false
      const nextDoc = readTableDocFromHost(host, tableDoc.table)
      const nextSerialized = serializeDocWithTable(nextDoc)
      if (nextSerialized === (lastSerialized.current ?? value)) {
        return false
      }
      commitValue(nextSerialized)
      return true
    }
    const commitTableFromHostRef = useRef(commitTableFromHost)
    commitTableFromHostRef.current = commitTableFromHost

    useEffect(() => {
      const host = tableHostRef.current
      if (!host || !tableDoc || !onBlur) return
      const handleFocusOut = (event: globalThis.FocusEvent) => {
        const next = event.relatedTarget
        if (next instanceof Node && host.contains(next)) return
        commitTableFromHostRef.current()
        onBlur()
      }
      host.addEventListener('focusout', handleFocusOut)
      return () => host.removeEventListener('focusout', handleFocusOut)
    }, [onBlur, tableDoc])

    useLayoutEffect(() => {
      const element = elementRef.current
      if (!element || value === lastSerialized.current || tableDoc) {
        return
      }
      const normalized = normalizeCellValue(value)
      const { cellStyle, inner } = splitCellWrapper(normalized)
      cellStyleRef.current = cellStyle
      applyCellStyle(element, cellStyle)
      renderSegments(inner, element)
      lastSerialized.current = value
    }, [tableDoc, value])

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
        if (!element || tableDoc) return false
        const applied = applyStyleToCellOrSelection(element, patch)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      applyCellStyle(patch) {
        const element = elementRef.current
        if (!element || tableDoc) return false
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
        if (!element || tableDoc) return false
        const applied = clearFormattingInCell(element)
        if (!applied) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      insertText(text) {
        const element = elementRef.current
        if (!element || tableDoc) return false
        const inserted = insertTextAtSelection(element, text)
        if (!inserted) return false
        commitValue(serializeEditableCell(element, cellStyleRef.current))
        return true
      },
      insertTable(rows, cols) {
        if (rows < 1 || cols < 1) return false
        const baseText = tableDoc ? tableDocToPlainText(tableDoc) : displayCellText(value)
        const table = createEmbeddedTable(rows, cols)
        commitValue(serializeDocWithTable({ text: baseText, table }))
        return true
      },
      commitPending() {
        if (tableDoc) {
          return commitTableFromHost()
        }
        const element = elementRef.current
        if (!element) return false
        const serialized = serializeEditableCell(element, cellStyleRef.current)
        if (serialized === (lastSerialized.current ?? value)) {
          return false
        }
        commitValue(serialized)
        return true
      },
    }), [tableDoc, value])

    if (tableDoc) {
      const updateFreeText = (nextText: string) => {
        commitValue(serializeDocWithTable({ text: nextText, table: tableDoc.table }))
      }

      const updateTableCell = (rowIndex: number, colIndex: number, cellValue: string) => {
        const nextTable: EmbeddedTable = {
          rows: tableDoc.table.rows,
          cols: tableDoc.table.cols,
          cells: tableDoc.table.cells.map((items) => [...items]),
        }
        nextTable.cells[rowIndex][colIndex] = cellValue
        commitValue(serializeDocWithTable({ text: tableDoc.text, table: nextTable }))
      }

      const updateTable = (nextTable: EmbeddedTable) => {
        commitValue(serializeDocWithTable({ text: tableDoc.text, table: nextTable }))
      }

      return (
        <div
          ref={tableHostRef}
          className={[className, 'product-status-inline-table-host'].filter(Boolean).join(' ')}
          onFocusCapture={() => onFocus?.()}
        >
          <InlineTableCell
            value={tableDoc.text}
            className="product-status-inline-table-preamble"
            onFocus={onFocus}
            onCommit={updateFreeText}
          />
          <div className="product-status-inline-table-toolbar">
            <button
              type="button"
              className="btn-secondary product-status-inline-table-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                updateTable({
                  rows: tableDoc.table.rows + 1,
                  cols: tableDoc.table.cols,
                  cells: [...tableDoc.table.cells.map((items) => [...items]), Array.from({ length: tableDoc.table.cols }, () => '')],
                })
              }}
            >
              + Строка
            </button>
            <button
              type="button"
              className="btn-secondary product-status-inline-table-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                updateTable({
                  rows: tableDoc.table.rows,
                  cols: tableDoc.table.cols + 1,
                  cells: tableDoc.table.cells.map((items) => [...items, '']),
                })
              }}
            >
              + Столбец
            </button>
            <button
              type="button"
              className="btn-secondary product-status-inline-table-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                commitValue(tableDocToPlainText(tableDoc))
              }}
            >
              Удалить таблицу
            </button>
          </div>
          <table className="product-status-inline-table">
            <tbody>
              {tableDoc.table.cells.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, colIndex) => (
                    <td key={colIndex}>
                      <InlineTableCell
                        value={cell}
                        onFocus={onFocus}
                        onCommit={(nextValue) => updateTableCell(rowIndex, colIndex, nextValue)}
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
