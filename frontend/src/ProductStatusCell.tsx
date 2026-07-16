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
import { notifySuccess, notifyWarning } from './toast'

export type ProductStatusCellHandle = {
  applyTextStyle: (patch: Partial<TextStyleSegment>) => boolean
  applyCellStyle: (patch: Partial<CellStyle>) => boolean
  clearFormatting: () => boolean
  insertText: (text: string) => boolean
  insertTable: (rows: number, cols: number) => boolean
  copyTable: () => Promise<boolean>
  pasteTable: () => Promise<boolean>
  hasEmbeddedTable: () => boolean
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

/** Убирает точный дубль абзаца/всего текста (ABC\\nABC → ABC). */
function collapseDuplicatedPlainText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ')
  const trimmed = normalized.replace(/^\n+|\n+$/g, '')
  if (!trimmed) return ''

  const blankSplit = trimmed.split(/\n{2,}/)
  if (blankSplit.length === 2 && blankSplit[0].trim() === blankSplit[1].trim()) {
    return blankSplit[0].trim()
  }

  const lines = trimmed.split('\n')
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const mid = lines.length / 2
    const first = lines.slice(0, mid).join('\n').trim()
    const second = lines.slice(mid).join('\n').trim()
    if (first && first === second) {
      return first
    }
  }

  if (trimmed.length >= 40 && trimmed.length % 2 === 0) {
    const half = trimmed.length / 2
    const first = trimmed.slice(0, half)
    const second = trimmed.slice(half)
    if (first === second) {
      return first
    }
  }

  return trimmed
}

function serializeDocWithTable(doc: EmbeddedTableDoc): string {
  return serializeEmbeddedTableDoc({
    text: collapseDuplicatedPlainText(doc.text),
    table: doc.table,
  })
}

function cloneEmbeddedTable(table: EmbeddedTable): EmbeddedTable {
  return {
    rows: table.rows,
    cols: table.cols,
    cells: table.cells.map((row) => [...row]),
  }
}

function cloneEmbeddedTableDoc(doc: EmbeddedTableDoc): EmbeddedTableDoc {
  return {
    text: collapseDuplicatedPlainText(doc.text),
    table: cloneEmbeddedTable(doc.table),
  }
}

function isBlockEditableNode(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as HTMLElement).tagName
    return tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'BR'
  }
  return false
}

/** Plain text из contentEditable: блочные узлы → переносы, без двойного учёта. */
function editableToPlainText(root: HTMLElement): string {
  const parts: string[] = []

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (text) parts.push(text)
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') {
      parts.push('\n')
      return
    }
    const block = isBlockEditableNode(node)
    if (block && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
      parts.push('\n')
    }
    node.childNodes.forEach(walk)
    if (block && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
      parts.push('\n')
    }
  }

  root.childNodes.forEach(walk)
  return collapseDuplicatedPlainText(parts.join('').replace(/\n{3,}/g, '\n\n'))
}

function resolvePreambleForNewTable(
  tableDoc: EmbeddedTableDoc | null,
  tableHost: HTMLElement | null,
  element: HTMLElement | null,
  value: string,
  lastSerialized: string | null,
): string {
  if (tableDoc) {
    if (tableHost) {
      return collapseDuplicatedPlainText(readTableDocFromHost(tableHost, tableDoc.table).text)
    }
    return collapseDuplicatedPlainText(tableDoc.text)
  }

  // Уже tablejson в value (редкий race) — только preamble, без flatten строк таблицы.
  const existing = parseEmbeddedTableDoc(lastSerialized ?? value)
  if (existing) {
    return collapseDuplicatedPlainText(existing.text)
  }

  if (element) {
    // Сначала живой DOM (несохранённый ввод), затем закодированное value.
    const fromDom = editableToPlainText(element)
    if (fromDom) return fromDom
    const fromSerialized = collapseDuplicatedPlainText(
      displayCellText(serializeEditableCell(element, { bg: null, border: null })),
    )
    if (fromSerialized) return fromSerialized
  }

  const committed = lastSerialized ?? value
  return collapseDuplicatedPlainText(displayCellText(committed))
}

/** Fallback, если браузер не дал доступ к системному буферу. */
let lastCopiedEmbeddedTable: string | null = null

function extractEmbeddedTablePayload(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (parseEmbeddedTableDoc(trimmed)) return trimmed
  const start = trimmed.indexOf(TABLE_TOKEN_PREFIX)
  const end = trimmed.lastIndexOf(TABLE_TOKEN_SUFFIX)
  if (start < 0 || end <= start) return null
  const candidate = trimmed.slice(start, end + TABLE_TOKEN_SUFFIX.length)
  return parseEmbeddedTableDoc(candidate) ? candidate : null
}

async function writeEmbeddedTableClipboard(serialized: string): Promise<boolean> {
  lastCopiedEmbeddedTable = serialized
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(serialized)
      return true
    }
  } catch {
    /* permission / insecure context — остаётся in-memory fallback */
  }
  return true
}

async function readEmbeddedTableClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      const fromSystem = extractEmbeddedTablePayload(await navigator.clipboard.readText())
      if (fromSystem) {
        lastCopiedEmbeddedTable = fromSystem
        return fromSystem
      }
    }
  } catch {
    /* ignore */
  }
  return lastCopiedEmbeddedTable && parseEmbeddedTableDoc(lastCopiedEmbeddedTable)
    ? lastCopiedEmbeddedTable
    : null
}

function tableToTsv(table: EmbeddedTable): string {
  return table.cells.map((row) => row.join('\t')).join('\n')
}

function selectionIsInside(root: HTMLElement | null): boolean {
  if (!root) return false
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
  const node = selection.anchorNode
  return Boolean(node && root.contains(node))
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

    const parsedTableDoc = parseEmbeddedTableDoc(value)
    const tableDoc = parsedTableDoc
      ? {
          text: collapseDuplicatedPlainText(parsedTableDoc.text),
          table: parsedTableDoc.table,
        }
      : null

    useLayoutEffect(() => {
      if (tableDoc) {
        lastSerialized.current = value
      }
    }, [tableDoc, value])

    const commitValue = (nextSerialized: string) => {
      lastSerialized.current = nextSerialized
      onChange(nextSerialized)
    }

    // Автолечение уже сохранённого дубля preamble (ABC\\nABC → ABC).
    useLayoutEffect(() => {
      if (!parsedTableDoc) return
      const collapsed = collapseDuplicatedPlainText(parsedTableDoc.text)
      if (collapsed === parsedTableDoc.text) return
      commitValue(
        serializeDocWithTable({
          text: collapsed,
          table: parsedTableDoc.table,
        }),
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps -- heal once per corrupted value
    }, [value])

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
      if (!element || tableDoc) {
        return
      }
      if (value === lastSerialized.current && serializeEditableCell(element, cellStyleRef.current) === value) {
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
        // Один раз берём preamble и сразу пишем tablejson — без flatten старой таблицы
        // и без повторного commitPending (он давал гонку с blur при размонтировании).
        const preamble = resolvePreambleForNewTable(
          tableDoc,
          tableHostRef.current,
          elementRef.current,
          value,
          lastSerialized.current,
        )
        const table = createEmbeddedTable(rows, cols)
        commitValue(serializeDocWithTable({ text: preamble, table }))
        return true
      },
      async copyTable() {
        if (!tableDoc) return false
        const host = tableHostRef.current
        const doc = host
          ? readTableDocFromHost(host, tableDoc.table)
          : cloneEmbeddedTableDoc(tableDoc)
        await writeEmbeddedTableClipboard(serializeDocWithTable(doc))
        return true
      },
      async pasteTable() {
        const payload = await readEmbeddedTableClipboard()
        if (!payload) return false
        const doc = parseEmbeddedTableDoc(payload)
        if (!doc) return false
        commitValue(serializeDocWithTable(cloneEmbeddedTableDoc(doc)))
        return true
      },
      hasEmbeddedTable() {
        return Boolean(tableDoc)
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

    const applyPastedTablePayload = (raw: string): boolean => {
      const payload = extractEmbeddedTablePayload(raw)
      if (!payload) return false
      const doc = parseEmbeddedTableDoc(payload)
      if (!doc) return false
      commitValue(serializeDocWithTable(cloneEmbeddedTableDoc(doc)))
      return true
    }

    if (tableDoc) {
      const readCurrentPreamble = (): string => {
        const host = tableHostRef.current
        if (!host) return tableDoc.text
        return readTableDocFromHost(host, tableDoc.table).text
      }

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
        commitValue(serializeDocWithTable({ text: readCurrentPreamble(), table: nextTable }))
      }

      const updateTable = (nextTable: EmbeddedTable) => {
        commitValue(serializeDocWithTable({ text: readCurrentPreamble(), table: nextTable }))
      }

      const copyCurrentTable = () => {
        const host = tableHostRef.current
        const doc = host
          ? readTableDocFromHost(host, tableDoc.table)
          : cloneEmbeddedTableDoc(tableDoc)
        void writeEmbeddedTableClipboard(serializeDocWithTable(doc)).then(() => {
          notifySuccess('Таблица скопирована')
        })
      }

      return (
        <div
          ref={tableHostRef}
          className={[className, 'product-status-inline-table-host'].filter(Boolean).join(' ')}
          onFocusCapture={() => onFocus?.()}
          onCopy={(event) => {
            if (selectionIsInside(tableHostRef.current)) return
            event.preventDefault()
            const host = tableHostRef.current
            const doc = host
              ? readTableDocFromHost(host, tableDoc.table)
              : cloneEmbeddedTableDoc(tableDoc)
            const serialized = serializeDocWithTable(doc)
            lastCopiedEmbeddedTable = serialized
            event.clipboardData.setData('text/plain', serialized)
            event.clipboardData.setData('text/tab-separated-values', tableToTsv(doc.table))
          }}
          onPaste={(event) => {
            const raw = event.clipboardData.getData('text/plain')
            if (applyPastedTablePayload(raw)) {
              event.preventDefault()
            }
          }}
          onKeyDown={(event) => {
            const primary = event.ctrlKey || event.metaKey
            if (!primary || event.altKey) return
            const key = event.key.toLowerCase()
            if (key === 'c' && !selectionIsInside(tableHostRef.current)) {
              event.preventDefault()
              copyCurrentTable()
              return
            }
            if (key === 'v') {
              // Нативный paste обработает onPaste; Shift+V — явная вставка таблицы из fallback.
              if (event.shiftKey) {
                event.preventDefault()
                void readEmbeddedTableClipboard().then((payload) => {
                  if (payload) applyPastedTablePayload(payload)
                })
              }
            }
          }}
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
              title="Скопировать таблицу (Ctrl/Cmd+C без выделения текста)"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                copyCurrentTable()
              }}
            >
              Копировать
            </button>
            <button
              type="button"
              className="btn-secondary product-status-inline-table-btn"
              title="Вставить таблицу из буфера"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void readEmbeddedTableClipboard().then((payload) => {
                  if (!payload || !applyPastedTablePayload(payload)) {
                    notifyWarning('В буфере нет скопированной таблицы')
                    return
                  }
                  notifySuccess('Таблица вставлена')
                })
              }}
            >
              Вставить
            </button>
            <button
              type="button"
              className="btn-secondary product-status-inline-table-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const text = readCurrentPreamble()
                commitValue(text)
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
        onPaste={(event) => {
          const raw = event.clipboardData.getData('text/plain')
          if (applyPastedTablePayload(raw)) {
            event.preventDefault()
          }
        }}
        onFocus={onFocus}
        onBlur={(event) => {
          // Не затираем только что вставленный tablejson plain-текстом при unmount.
          if (lastSerialized.current && parseEmbeddedTableDoc(lastSerialized.current)) {
            onBlur?.()
            return
          }
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
