import ProductStatusWorkbook from './ProductStatusWorkbook'

type GovInitiativesProps = {
  canManageOrg?: boolean
}

export default function GovInitiatives({ canManageOrg = false }: GovInitiativesProps) {
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
      />
    </div>
  )
}
