import { memo, useEffect, useRef } from 'react'
import ProductStatusCell, { type ProductStatusCellHandle } from './ProductStatusCell'
import { resolveBooleanColors, styledBooleanValue } from './productStatusBoolean'
import {
  isZniColumn,
  normalizeZniCellValue,
  parseZniNumber,
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
}: ProductStatusTableRowProps) {
  const cellHandleRef = useRef<ProductStatusCellHandle | null>(null)
  const rowActive = activeCell?.rowIndex === rowIndex

  useEffect(() => {
    if (rowActive) {
      activeCellRef.current = cellHandleRef.current
    }
  }, [rowActive, activeCell?.column, activeCellRef])

  return (
    <tr className={rowClassName || undefined}>
      {columns.map((column) => {
        const isActive = rowActive && activeCell?.column === column
        const colClass = resolveColumnClass(column)
        const cellClassName = [
          colClass,
          isBooleanColumn(column) ? 'product-status-bool-cell' : 'product-status-multiline',
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

        const zniNumber = isZniColumn(column) ? parseZniNumber(row[column] ?? '') : null
        const matchedZni = zniNumber ? zniLookup[zniNumber] : undefined
        const showZniTrigger = Boolean(matchedZni && zniNumber && !isActive)
        const cellValue = isZniColumn(column)
          ? normalizeZniCellValue(row[column] ?? '')
          : row[column] ?? ''

        return (
          <td
            key={column}
            className={[cellClassName, matchedZni ? 'product-status-zni-cell--matched' : '']
              .filter(Boolean)
              .join(' ')}
            onDoubleClick={() => {
              if (showZniTrigger) {
                onActiveCellFocus({ rowIndex, column })
              }
            }}
          >
            {showZniTrigger ? (
              <button
                type="button"
                className="zni-link product-status-zni-trigger"
                onClick={() => {
                  if (matchedZni) onOpenZniModal(matchedZni)
                }}
              >
                {zniNumber}
              </button>
            ) : (
              <ProductStatusCell
                ref={(handle) => {
                  cellHandleRef.current = handle
                  if (isActive) {
                    activeCellRef.current = handle
                  }
                }}
                className="product-status-cell-input"
                value={cellValue}
                ariaLabel={column}
                onFocus={() => onActiveCellFocus({ rowIndex, column })}
                onBlur={() => onActiveCellBlur({ rowIndex, column })}
                onChange={(nextValue) => onUpdateCell(sheetGid, rowIndex, column, nextValue)}
              />
            )}
          </td>
        )
      })}
    </tr>
  )
}

export default memo(ProductStatusTableRow, (prev, next) => {
  if (prev.row !== next.row) return false
  if (prev.columns !== next.columns) return false
  if (prev.sheetGid !== next.sheetGid) return false
  if (prev.rowClassName !== next.rowClassName) return false
  if (prev.cellBusy !== next.cellBusy) return false
  if (prev.booleanColorsByColumn !== next.booleanColorsByColumn) return false
  if (prev.zniLookup !== next.zniLookup) return false
  if (rowNeedsActiveCellUpdate(prev.activeCell, next.activeCell, prev.rowIndex)) {
    return false
  }
  return true
})
