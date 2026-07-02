import { useCallback, useEffect, useState } from 'react'
import ProductStatusWorkbook from './ProductStatusWorkbook'
import {
  loadB2bNewsGid,
  loadB2bPanel,
  loadProductStatusB2bGid,
  saveB2bNewsGid,
  saveB2bPanel,
  saveProductStatusB2bGid,
  type B2bPanelId,
} from './uiState'

type ProductStatusB2BProps = {
  canManageOrg?: boolean
}

function B2bTitleSwitcher({
  panel,
  onPanelChange,
}: {
  panel: B2bPanelId
  onPanelChange: (panel: B2bPanelId) => void
}) {
  return (
    <div className="product-status-title-switcher" role="tablist" aria-label="Разделы B2B">
      <button
        type="button"
        role="tab"
        aria-selected={panel === 'status'}
        className={`product-status-title-tab${
          panel === 'status' ? ' product-status-title-tab-active' : ''
        }`}
        onClick={() => onPanelChange('status')}
      >
        Статус продукта B2B
      </button>
      <span className="product-status-title-sep" aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        role="tab"
        aria-selected={panel === 'news'}
        className={`product-status-title-tab product-status-title-tab-alt${
          panel === 'news' ? ' product-status-title-tab-active' : ''
        }`}
        onClick={() => onPanelChange('news')}
      >
        Новости и запуски
      </button>
    </div>
  )
}

export default function ProductStatusB2B({ canManageOrg = false }: ProductStatusB2BProps) {
  const [panel, setPanel] = useState<B2bPanelId>(() => loadB2bPanel())

  useEffect(() => {
    saveB2bPanel(panel)
  }, [panel])

  const renderTitleSwitcher = useCallback(
    () => <B2bTitleSwitcher panel={panel} onPanelChange={setPanel} />,
    [panel],
  )

  return (
    <>
      {panel === 'status' ? (
        <ProductStatusWorkbook
          apiBase="/api/product-status/b2b"
          defaultTitle="Статус продукта B2B"
          loadGid={loadProductStatusB2bGid}
          saveGid={saveProductStatusB2bGid}
          enableExcelExport
          enablePresentationExport
          excelFilename="status-produkta-b2b.xlsx"
          presentationFilename="status-produkta-b2b.pptx"
          headerTitle={renderTitleSwitcher()}
          lazySheets
          fixedColumns
          enableRowDelete
          enableHistory
          canEditAdminColumns={canManageOrg}
          commitOnRefresh
        />
      ) : null}
      {panel === 'news' ? (
        <ProductStatusWorkbook
          apiBase="/api/b2b-news"
          defaultTitle="Новости и запуски"
          loadGid={loadB2bNewsGid}
          saveGid={saveB2bNewsGid}
          headerTitle={renderTitleSwitcher()}
          lazySheets
          fixedColumns
          enableRowDelete
          enableHistory
          commitOnRefresh
        />
      ) : null}
    </>
  )
}
