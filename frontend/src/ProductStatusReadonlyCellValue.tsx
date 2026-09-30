import type { CSSProperties } from 'react'
import ProductStatusRichText from './ProductStatusRichText'
import { parseEmbeddedTableDoc } from './productStatusEmbeddedTable'
import {
  displayCellText,
  normalizeCellValue,
  splitCellWrapper,
  type CellStyle,
} from './productStatusRichText'

type ProductStatusReadonlyCellValueProps = {
  value: string
}

function cellHostStyle(cellStyle: CellStyle): CSSProperties | undefined {
  const style: React.CSSProperties = {}
  if (cellStyle.bg) {
    style.backgroundColor = `#${cellStyle.bg}`
  }
  if (cellStyle.border) {
    style.boxShadow = `inset 0 0 0 2px #${cellStyle.border}`
  }
  return cellStyle.bg || cellStyle.border ? style : undefined
}

export default function ProductStatusReadonlyCellValue({
  value,
}: ProductStatusReadonlyCellValueProps) {
  const tableDoc = parseEmbeddedTableDoc(value)
  if (!tableDoc) {
    return <ProductStatusRichText value={value} />
  }

  const { cellStyle } = splitCellWrapper(normalizeCellValue(value))
  const preambleVisible = Boolean(displayCellText(tableDoc.text).trim())
  const afterVisible = Boolean(displayCellText(tableDoc.afterText).trim())

  return (
    <div
      className="product-status-inline-table-host product-status-inline-table-host--readonly"
      style={cellHostStyle(cellStyle)}
    >
      {preambleVisible ? (
        <div className="product-status-inline-table-preamble-readonly">
          <ProductStatusRichText value={tableDoc.text} empty="" />
        </div>
      ) : null}
      <table className="product-status-inline-table">
        <tbody>
          {tableDoc.table.cells.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, colIndex) => (
                <td key={colIndex} className="product-status-inline-table-cell-readonly">
                  {displayCellText(cell).trim() ? (
                    <ProductStatusRichText value={cell} empty="" />
                  ) : (
                    '\u00a0'
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {afterVisible ? (
        <div className="product-status-inline-table-postamble-readonly">
          <ProductStatusRichText value={tableDoc.afterText} empty="" />
        </div>
      ) : null}
    </div>
  )
}
