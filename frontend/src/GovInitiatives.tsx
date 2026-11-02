import { useEffect, useState } from 'react'
import ProductStatusWorkbook from './ProductStatusWorkbook'
import {
  loadGovInitiativesRowNumberDirection,
  saveGovInitiativesRowNumberDirection,
  type RevenueRowNumberDirection,
} from './uiState'

type GovInitiativesProps = {
  canManageOrg?: boolean
}

export default function GovInitiatives({ canManageOrg = false }: GovInitiativesProps) {
  const [rowNumberDirection, setRowNumberDirection] = useState<RevenueRowNumberDirection>(
    () => loadGovInitiativesRowNumberDirection(),
  )

  useEffect(() => {
    saveGovInitiativesRowNumberDirection(rowNumberDirection)
  }, [rowNumberDirection])

  return (
    <div className="gov-initiatives">
      <ProductStatusWorkbook
        apiBase="/api/gov-initiatives"
        defaultTitle="Госинициативы"
        loadGid={() => 'main'}
        saveGid={() => undefined}
        lazySheets
        fixedColumns
        enableRowDelete
        enableRowReorder
        enableHistory={canManageOrg}
        commitOnRefresh
        enableExcelExport
        excelFromClientPayload
        excelFilename="gosinitsiativy.xlsx"
        enableColumnFilters
        showRowNumbers
        rowNumberDirection={rowNumberDirection}
        onRowNumberDirectionChange={setRowNumberDirection}
      />
    </div>
  )
}
