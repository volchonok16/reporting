import { useCallback, useEffect, useState } from 'react'
import ProductStatusWorkbook from './ProductStatusWorkbook'
import { REVENUE_NUMERIC_COLUMNS } from './revenueActivitiesColumns'
import { loadRevenueActivitiesGid, saveRevenueActivitiesGid } from './uiState'

type RevenueActivitiesProps = {
  canManageOrg?: boolean
}

type RevenuePanelId = 'base' | 'revenue'

function loadRevenuePanel(): RevenuePanelId {
  const gid = loadRevenueActivitiesGid()
  return gid === 'revenue' ? 'revenue' : 'base'
}

function RevenueTitleSwitcher({
  panel,
  onPanelChange,
}: {
  panel: RevenuePanelId
  onPanelChange: (panel: RevenuePanelId) => void
}) {
  return (
    <div className="product-status-title-switcher" role="tablist" aria-label="Активности по выручкам">
      <button
        type="button"
        role="tab"
        aria-selected={panel === 'base'}
        className={`product-status-title-tab${
          panel === 'base' ? ' product-status-title-tab-active' : ''
        }`}
        onClick={() => onPanelChange('base')}
      >
        Влияние по базе
      </button>
      <span className="product-status-title-sep" aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        role="tab"
        aria-selected={panel === 'revenue'}
        className={`product-status-title-tab product-status-title-tab-alt${
          panel === 'revenue' ? ' product-status-title-tab-active' : ''
        }`}
        onClick={() => onPanelChange('revenue')}
      >
        Влияние по выручке
      </button>
    </div>
  )
}

export default function RevenueActivities({ canManageOrg = false }: RevenueActivitiesProps) {
  const [panel, setPanel] = useState<RevenuePanelId>(() => loadRevenuePanel())

  useEffect(() => {
    saveRevenueActivitiesGid(panel)
  }, [panel])

  const renderTitleSwitcher = useCallback(
    () => <RevenueTitleSwitcher panel={panel} onPanelChange={setPanel} />,
    [panel],
  )

  return (
    <div className="revenue-activities">
      <ProductStatusWorkbook
        key={panel}
        apiBase="/api/revenue-activities"
        defaultTitle="Активности по выручкам"
        loadGid={() => panel}
        saveGid={(gid) => {
          if (gid === 'base' || gid === 'revenue') {
            setPanel(gid)
          }
        }}
        headerTitle={renderTitleSwitcher()}
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
      />
    </div>
  )
}
