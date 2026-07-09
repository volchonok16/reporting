import { memo, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import ProductStatusCell, { type ProductStatusCellHandle } from './ProductStatusCell'
import { resolveBooleanColors, styledBooleanValue } from './productStatusBoolean'
import {
  isZniColumn,
  normalizeZniCellValue,
  parseZniNumbers,
  PRODUCT_STATUS_ROW_ID_KEY,
  ZNI_NUMBERS_PLACEHOLDER,
} from './productStatusZni'
import { displayCellText } from './productStatusRichText'
import type { ChangeRequest } from './zniTypes'

export type ActiveCell = {
  rowIndex: number
  column: string
}

type ProductStatusTableRowProps = {
  sheetGid: string
  rowIndex: number
  row: Record<string, string>
  columns: string[]
  rowClassName?: string
  cellBusy: boolean
  activeCell: ActiveCell | null
  booleanColorsByColumn: Record<string, ReturnType<typeof resolveBooleanColors>>
  zniLookup: Record<string, ChangeRequest>
  onUpdateCell: (gid: string, rowIndex: number, column: string, value: string) => void
  onActiveCellFocus: (cell: ActiveCell) => void
  onActiveCellBlur: (cell: ActiveCell) => void
  onOpenZniModal: (item: ChangeRequest) => void
  activeCellRef: React.MutableRefObject<ProductStatusCellHandle | null>
  resolveColumnClass: (column: string) => string | undefined
  isBooleanColumn: (column: string) => boolean
  isReadOnlyColumn?: (column: string) => boolean
  enableRowDelete?: boolean
  onDeleteRow?: (rowIndex: number) => void
  enableRowReorder?: boolean
  rowCount?: number
  onMoveRow?: (fromIndex: number, toIndex: number) => void
  isDraggingRow?: boolean
  isDragOverRow?: boolean
  onRowPointerDragStart?: (
    rowIndex: number,
    event: ReactPointerEvent<HTMLButtonElement>,
    rowElement: HTMLTableRowElement,
  ) => void
}

function booleanCellValue(value: string): string {
  return displayCellText(value).trim()
}

function isYesValue(value: string): boolean {
  const normalized = booleanCellValue(value).toLowerCase()
  if (normalized === 'нет' || normalized === 'no' || normalized === '0' || normalized === 'false') {
    return false
  }
  return normalized === 'да' || normalized === 'yes' || normalized === '1' || normalized === 'true'
}

function rowNeedsActiveCellUpdate(prev: ActiveCell | null, next: ActiveCell | null, rowIndex: number) {
  const prevActive = prev?.rowIndex === rowIndex
  const nextActive = next?.rowIndex === rowIndex
  return prevActive || nextActive
}

function ProductStatusTableRow({
  sheetGid,
  rowIndex,
  row,
  columns,
  rowClassName,
  cellBusy,
  activeCell,
  booleanColorsByColumn,
  zniLookup,
  onUpdateCell,
  onActiveCellFocus,
  onActiveCellBlur,
  onOpenZniModal,
  activeCellRef,
  resolveColumnClass,
  isBooleanColumn,
  isReadOnlyColumn,
  enableRowDelete = false,
  onDeleteRow,
  enableRowReorder = false,
  rowCount = 0,
  onMoveRow,
  isDraggingRow = false,
  isDragOverRow = false,
  onRowPointerDragStart,
}: ProductStatusTableRowProps) {
  const rowRef = useRef<HTMLTableRowElement>(null)
  const cellHandleRef = useRef<ProductStatusCellHandle | null>(null)
  const zniDraftRef = useRef<string | null>(null)
  const rowActive = activeCell?.rowIndex === rowIndex

  useEffect(() => {
    if (rowActive) {
      activeCellRef.current = cellHandleRef.current
    }
  }, [rowActive, activeCell?.column, activeCellRef])

  const rowClassNames = [
    rowClassName,
    isDraggingRow ? 'product-status-row--dragging' : '',
    isDragOverRow ? 'product-status-row--drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <tr
      ref={rowRef}
      data-row-index={rowIndex}
      className={rowClassNames || undefined}
    >
      {enableRowDelete ? (
        <td className="product-status-row-actions">
          <div className="product-status-row-actions-stack">
            <button
              type="button"
              className="btn-secondary product-status-row-delete"
              disabled={cellBusy}
              aria-label="Удалить строку"
              title="Удалить строку"
              onClick={() => onDeleteRow?.(rowIndex)}
            >
              ×
            </button>
            {enableRowReorder ? (
              <>
                <button
                  type="button"
                  className="btn-secondary product-status-row-move"
                  disabled={cellBusy || rowIndex === 0}
                  aria-label="Переместить строку вверх"
                  title="Переместить строку вверх"
                  onClick={() => onMoveRow?.(rowIndex, rowIndex - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-secondary product-status-row-move"
                  disabled={cellBusy || rowIndex >= rowCount - 1}
                  aria-label="Переместить строку вниз"
                  title="Переместить строку вниз"
                  onClick={() => onMoveRow?.(rowIndex, rowIndex + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-secondary product-status-row-drag"
                  disabled={cellBusy}
                  aria-label="Перетащить строку"
                  title="Перетащить строку"
                  onPointerDown={(event) => {
                    if (!rowRef.current) return
                    onRowPointerDragStart?.(rowIndex, event, rowRef.current)
                  }}
                >
                  <span className="product-status-row-drag-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </button>
              </>
            ) : null}
          </div>
        </td>
      ) : null}
      {columns.map((column) => {
        const isActive = rowActive && activeCell?.column === column
        const colClass = resolveColumnClass(column)
        const readOnly = isReadOnlyColumn?.(column) ?? false
        const cellClassName = [
          colClass,
          isBooleanColumn(column) ? 'product-status-bool-cell' : 'product-status-multiline',
          readOnly ? 'product-status-cell-readonly' : '',
        ]
          .filter(Boolean)
          .join(' ')

        if (isBooleanColumn(column)) {
          const cellValue = row[column] ?? ''
          return (
            <td key={column} className={cellClassName}>
              <input
                type="checkbox"
                className="product-status-bool-checkbox"
                checked={isYesValue(cellValue)}
                aria-label={column}
                disabled={cellBusy}
                onChange={(event) => {
                  const colors = booleanColorsByColumn[column]
                  if (!colors) return
                  onUpdateCell(
                    sheetGid,
                    rowIndex,
                    column,
                    styledBooleanValue(event.target.checked, colors),
                  )
                }}
              />
            </td>
          )
        }

        const zniNumbers = isZniColumn(column) ? parseZniNumbers(row[column] ?? '') : []
        const showZniView = isZniColumn(column) && zniNumbers.length > 0 && !isActive
        const cellValue = isZniColumn(column)
          ? normalizeZniCellValue(row[column] ?? '')
          : row[column] ?? ''

        if (readOnly) {
          return (
            <td key={column} className={cellClassName}>
              <div className="product-status-cell-readonly-value">{displayCellText(cellValue) || '—'}</div>
            </td>
          )
        }

        return (
          <td
            key={column}
            className={[
              cellClassName,
              isActive ? 'product-status-cell-active' : '',
              showZniView ? 'product-status-zni-cell--matched' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onDoubleClick={() => {
              if (showZniView) {
                onActiveCellFocus({ rowIndex, column })
              }
            }}
          >
            {showZniView ? (
              <div className="product-status-zni-links">
                {zniNumbers.map((number, index) => {
                  const item = zniLookup[number]
                  return (
                    <span key={number} className="product-status-zni-token">
                      {index > 0 ? <span className="product-status-zni-sep">, </span> : null}
                      {item ? (
                        <button
                          type="button"
                          className="zni-link product-status-zni-trigger"
                          onClick={() => onOpenZniModal(item)}
                        >
                          {number}
                        </button>
                      ) : (
                        <span className="product-status-zni-plain">{number}</span>
                      )}
                    </span>
                  )
                })}
              </div>
            ) : (
              <ProductStatusCell
                ref={(handle) => {
                  cellHandleRef.current = handle
                  if (isActive) {
                    activeCellRef.current = handle
                  }
                }}
                className={[
                  'product-status-cell-input',
                  isZniColumn(column) ? 'product-status-cell-input-zni' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                value={cellValue}
                ariaLabel={column}
                isEditing={isActive}
                placeholder={isZniColumn(column) ? ZNI_NUMBERS_PLACEHOLDER : undefined}
                onFocus={() => onActiveCellFocus({ rowIndex, column })}
                onBlur={() => {
                  if (isZniColumn(column)) {
                    const raw = zniDraftRef.current ?? row[column] ?? ''
                    const normalized = normalizeZniCellValue(raw)
                    if (normalized !== raw) {
                      onUpdateCell(sheetGid, rowIndex, column, normalized)
                    }
                    zniDraftRef.current = null
                  }
                  onActiveCellBlur({ rowIndex, column })
                }}
                onChange={(nextValue) => {
                  if (isZniColumn(column)) {
                    zniDraftRef.current = nextValue
                  }
                  onUpdateCell(sheetGid, rowIndex, column, nextValue)
                }}
              />
            )}
          </td>
        )
      })}
    </tr>
  )
}

export default memo(ProductStatusTableRow, (prev, next) => {
  if (prev.rowIndex !== next.rowIndex) return false
  if (prev.row !== next.row) return false
  if (prev.columns !== next.columns) return false
  if (prev.sheetGid !== next.sheetGid) return false
  if (prev.rowClassName !== next.rowClassName) return false
  if (prev.cellBusy !== next.cellBusy) return false
  if (prev.booleanColorsByColumn !== next.booleanColorsByColumn) return false
  if (prev.zniLookup !== next.zniLookup) return false
  if (prev.enableRowDelete !== next.enableRowDelete) return false
  if (prev.enableRowReorder !== next.enableRowReorder) return false
  if (prev.rowCount !== next.rowCount) return false
  if (prev.isDraggingRow !== next.isDraggingRow) return false
  if (prev.isDragOverRow !== next.isDragOverRow) return false
  if (rowNeedsActiveCellUpdate(prev.activeCell, next.activeCell, prev.rowIndex)) {
    return false
  }
  return true
})

export { PRODUCT_STATUS_ROW_ID_KEY }
