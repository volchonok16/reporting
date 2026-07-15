import ProductStatusWorkbook from './ProductStatusWorkbook'
import { REVENUE_NUMERIC_COLUMNS } from './revenueActivitiesColumns'
import { loadRevenueActivitiesGid, saveRevenueActivitiesGid } from './uiState'

type RevenueActivitiesProps = {
  canManageOrg?: boolean
}

export default function RevenueActivities({ canManageOrg = false }: RevenueActivitiesProps) {
  return (
    <ProductStatusWorkbook
      apiBase="/api/revenue-activities"
      defaultTitle="Активности по выручкам"
      loadGid={loadRevenueActivitiesGid}
      saveGid={saveRevenueActivitiesGid}
      lazySheets
      fixedColumns
      enableRowDelete
      enableRowReorder
      enableHistory={canManageOrg}
      commitOnRefresh
      enableExcelExport
      excelFromClientPayload
      excelFilename="aktivnosti-po-vyruchkam.xlsx"
      numericColumns={REVENUE_NUMERIC_COLUMNS}
      showTotalsRow
      enableColumnFilters
      compactRows
    />
  )
}
