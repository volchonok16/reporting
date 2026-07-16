import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
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
import {
  cloneEmbeddedTableDoc,
  createEmbeddedTable,
  extractEmbeddedTablePayload,
  parseEmbeddedTableDoc,
  readEmbeddedTableClipboard,
  readTableDocFromHost,
  resolvePreambleForTableInsert,
  serializeDocWithTable,
  setLastCopiedEmbeddedTable,
  tableToTsv,
  writeEmbeddedTableClipboard,
  type EmbeddedTable,
  type EmbeddedTableDoc,
} from './productStatusEmbeddedTable'
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

type InlineTableCellProps = {
  value: string
  placeholder?: string
  className?: string
  onCommit: (value: string) => void
  onFocus?: () => void
}

function inlineTableCellIsEditing(
  element: HTMLDivElement | null,
  isFocusedRef: RefObject<boolean>,
): boolean {
  if (!element) return false
  if (isFocusedRef.current) return true
  const active = document.activeElement
  return active === element || (active instanceof Node && element.contains(active))
}

function InlineTableCell({
  value,
  placeholder,
  className = 'product-status-inline-table-cell',
  onCommit,
  onFocus,
}: InlineTableCellProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  /** null until first DOM sync — otherwise mount skips writing value into an empty div */
  const lastSynced = useRef<string | null>(null)
  const isFocusedRef = useRef(false)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || inlineTableCellIsEditing(element, isFocusedRef)) return
    if (lastSynced.current === value && element.textContent === value) return
    element.textContent = value
    lastSynced.current = value
  }, [value])

  return (
    <div
      ref={elementRef}
      role="textbox"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      className={className}
      data-placeholder={placeholder}
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
      onFocus={() => {
        isFocusedRef.current = true
        onFocus?.()
      }}
      onBlur={(event) => {
        isFocusedRef.current = false
        const next = event.currentTarget.textContent ?? ''
        lastSynced.current = next
        if (next !== value) onCommit(next)
      }}
      onInput={(event) => {
        isFocusedRef.current = true
        lastSynced.current = event.currentTarget.textContent ?? ''
      }}
    />
  )
}

type PreambleEditorProps = {
  value: string
  className?: string
  onChange: (value: string) => void
  onFocus?: () => void
  autoFocus?: boolean
}

function PreambleEditor({ value, className, onChange, onFocus, autoFocus }: PreambleEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (!autoFocus) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [autoFocus])

  return (
    <textarea
      ref={textareaRef}
      className={className}
      value={value}
      rows={Math.min(8, Math.max(2, value.split('\n').length + 1))}
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={onFocus}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => event.stopPropagation()}
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
    const shouldFocusPreambleRef = useRef(false)

    const tableDoc = parseEmbeddedTableDoc(value)
    const focusPreamble = shouldFocusPreambleRef.current && Boolean(tableDoc)

    useLayoutEffect(() => {
      if (tableDoc) {
        lastSerialized.current = value
      }
    }, [tableDoc, value])

    useLayoutEffect(() => {
      if (focusPreamble) {
        shouldFocusPreambleRef.current = false
      }
    }, [focusPreamble])

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

    const readSerializedPlain = (): string => {
      if (tableDoc && tableHostRef.current) {
        commitTableFromHost()
        return lastSerialized.current ?? value
      }
      const element = elementRef.current
      if (element) {
        return serializeEditableCell(element, cellStyleRef.current)
      }
      return lastSerialized.current ?? value
    }

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
        const serialized = readSerializedPlain()
        const preamble = resolvePreambleForTableInsert({
          tableDoc,
          tableHost: tableHostRef.current,
          serializedPlain: serialized,
        })
        shouldFocusPreambleRef.current = true
        commitValue(
          serializeDocWithTable({
            text: preamble,
            table: createEmbeddedTable(rows, cols),
          }),
        )
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
        shouldFocusPreambleRef.current = true
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
      const readCurrentDoc = (): EmbeddedTableDoc => {
        const host = tableHostRef.current
        if (host) {
          return readTableDocFromHost(host, tableDoc.table)
        }
        return tableDoc
      }

      const updateFreeText = (nextText: string) => {
        const current = readCurrentDoc()
        commitValue(serializeDocWithTable({ text: nextText, table: current.table }))
      }

      const updateTableCell = (rowIndex: number, colIndex: number, cellValue: string) => {
        const current = readCurrentDoc()
        const nextTable: EmbeddedTable = {
          rows: current.table.rows,
          cols: current.table.cols,
          cells: current.table.cells.map((items) => [...items]),
        }
        nextTable.cells[rowIndex][colIndex] = cellValue
        commitValue(serializeDocWithTable({ text: current.text || tableDoc.text, table: nextTable }))
      }

      const updateTable = (nextTable: EmbeddedTable) => {
        const current = readCurrentDoc()
        commitValue(serializeDocWithTable({ text: current.text || tableDoc.text, table: nextTable }))
      }

      const removeTableKeepText = () => {
        const current = readCurrentDoc()
        const text = current.text || tableDoc.text
        commitValue(text)
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
          contentEditable={false}
          className={[className, 'product-status-inline-table-host'].filter(Boolean).join(' ')}
          onFocusCapture={() => onFocus?.()}
          onCopy={(event) => {
            const host = tableHostRef.current
            const active = document.activeElement
            if (
              active instanceof HTMLTextAreaElement ||
              (active instanceof HTMLElement && active.isContentEditable)
            ) {
              if (host?.contains(active)) return
            }
            if (selectionIsInside(host)) return
            event.preventDefault()
            const doc = host
              ? readTableDocFromHost(host, tableDoc.table)
              : cloneEmbeddedTableDoc(tableDoc)
            const serialized = serializeDocWithTable(doc)
            setLastCopiedEmbeddedTable(serialized)
            event.clipboardData.setData('text/plain', serialized)
            event.clipboardData.setData('text/tab-separated-values', tableToTsv(doc.table))
          }}
          onPaste={(event) => {
            const active = document.activeElement
            if (
              active instanceof HTMLTextAreaElement ||
              (active instanceof HTMLElement && active.isContentEditable)
            ) {
              if (tableHostRef.current?.contains(active)) {
                const raw = event.clipboardData.getData('text/plain')
                // В textarea/ячейке обычный текст вставляем как есть; tablejson — как таблицу.
                if (!extractEmbeddedTablePayload(raw)) return
              }
            }
            const raw = event.clipboardData.getData('text/plain')
            if (applyPastedTablePayload(raw)) {
              event.preventDefault()
            }
          }}
          onKeyDown={(event) => {
            const primary = event.ctrlKey || event.metaKey
            if (!primary || event.altKey) return
            const active = document.activeElement
            const editingInside =
              (active instanceof HTMLTextAreaElement ||
                (active instanceof HTMLElement && active.isContentEditable)) &&
              Boolean(tableHostRef.current?.contains(active))
            const key = event.key.toLowerCase()
            if (key === 'c' && !editingInside && !selectionIsInside(tableHostRef.current)) {
              event.preventDefault()
              copyCurrentTable()
              return
            }
            if (key === 'v' && event.shiftKey) {
              event.preventDefault()
              void readEmbeddedTableClipboard().then((payload) => {
                if (payload) applyPastedTablePayload(payload)
              })
            }
          }}
        >
          <PreambleEditor
            value={tableDoc.text}
            className="product-status-inline-table-preamble"
            onFocus={onFocus}
            onChange={updateFreeText}
            autoFocus={focusPreamble}
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
                  cells: [
                    ...tableDoc.table.cells.map((items) => [...items]),
                    Array.from({ length: tableDoc.table.cols }, () => ''),
                  ],
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
              onClick={copyCurrentTable}
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
              title="Удалить таблицу, оставить текст над ней"
              onMouseDown={(event) => event.preventDefault()}
              onClick={removeTableKeepText}
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
          if (parseEmbeddedTableDoc(lastSerialized.current ?? '')) {
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
