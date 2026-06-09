import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, apiFetch, readApiError } from './api'
import ProductStatusCell from './ProductStatusCell'

type ProductStatusSheet = {
  gid: string
  name: string
  columns: string[]
  rows: Record<string, string>[]
  totalShown: number
}

type ProductStatusData = {
  title: string
  sourceUrl?: string | null
  presentationReferenceUrl?: string | null
  sheets: ProductStatusSheet[]
}

function cloneSheets(sheets: ProductStatusSheet[]): ProductStatusSheet[] {
  return sheets.map((sheet) => ({
    ...sheet,
    columns: [...sheet.columns],
    rows: sheet.rows.map((row) => ({ ...row })),
  }))
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function filenameFromDisposition(disposition: string, fallback: string): string {
  const match = disposition.match(/filename="([^"]+)"/)
  return match?.[1] ?? fallback
}

export default function ProductStatusB2B() {
  const [data, setData] = useState<ProductStatusData | null>(null)
  const [sheets, setSheets] = useState<ProductStatusSheet[]>([])
  const [activeGid, setActiveGid] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exportingPresentation, setExportingPresentation] = useState(false)
  const [exportingExcel, setExportingExcel] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await getJson<ProductStatusData>('/api/product-status/b2b')
      setData(payload)
      setSheets(cloneSheets(payload.sheets))
      setActiveGid((current) => {
        if (current && payload.sheets.some((sheet) => sheet.gid === current)) {
          return current
        }
        return payload.sheets[0]?.gid ?? null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleExportPresentation = useCallback(async () => {
    setExportingPresentation(true)
    setError(null)
    try {
      const response = await apiFetch('/api/product-status/b2b/presentation')
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const blob = await response.blob()
      downloadBlob(
        blob,
        filenameFromDisposition(response.headers.get('Content-Disposition') ?? '', 'status-produkta-b2b.pptx'),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки презентации')
    } finally {
      setExportingPresentation(false)
    }
  }, [])

  const handleExportExcel = useCallback(async () => {
    if (sheets.length === 0) {
      return
    }
    setExportingExcel(true)
    setError(null)
    try {
      const payload: ProductStatusData = {
        title: data?.title ?? 'Статус продукта B2B',
        sourceUrl: data?.sourceUrl,
        presentationReferenceUrl: data?.presentationReferenceUrl,
        sheets,
      }
      const response = await apiFetch('/api/product-status/b2b/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const blob = await response.blob()
      downloadBlob(
        blob,
        filenameFromDisposition(response.headers.get('Content-Disposition') ?? '', 'status-produkta-b2b.xlsx'),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки Excel')
    } finally {
      setExportingExcel(false)
    }
  }, [data, sheets])

  const updateCell = useCallback((gid: string, rowIndex: number, column: string, value: string) => {
    setSheets((current) =>
      current.map((sheet) => {
        if (sheet.gid !== gid) {
          return sheet
        }
        const rows = sheet.rows.map((row, index) =>
          index === rowIndex ? { ...row, [column]: value } : row,
        )
        return { ...sheet, rows }
      }),
    )
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.gid === activeGid) ?? sheets[0] ?? null,
    [activeGid, sheets],
  )

  const exporting = exportingPresentation || exportingExcel

  return (
    <div className="product-status">
      <header className="product-status-toolbar">
        <div className="product-status-toolbar-left">
          <h1 className="product-status-title">{data?.title ?? 'Статус продукта B2B'}</h1>
          <p className="product-status-subtitle">
            Данные из Google Sheets · ячейки можно править · жёлтая заливка из таблицы при
            GOOGLE_SHEETS_API_KEY
            {data?.sourceUrl ? (
              <>
                {' · '}
                <a className="zni-link" href={data.sourceUrl} target="_blank" rel="noreferrer">
                  Открыть таблицу
                </a>
              </>
            ) : null}
            {data?.presentationReferenceUrl ? (
              <>
                {' · '}
                <a
                  className="zni-link"
                  href={data.presentationReferenceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Эталон в Google Slides
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="product-status-toolbar-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleExportExcel()}
            disabled={loading || exporting || sheets.length === 0}
          >
            {exportingExcel ? 'Формирование…' : 'Скачать Excel'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleExportPresentation()}
            disabled={loading || exporting || sheets.length === 0}
          >
            {exportingPresentation ? 'Формирование…' : 'Скачать презентацию'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void loadData()} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
        </div>
      </header>

      {sheets.length > 0 && (
        <nav className="product-status-sheet-tabs" aria-label="Листы Google Sheets">
          {sheets.map((sheet) => (
            <button
              key={sheet.gid}
              type="button"
              className={`product-status-sheet-tab${
                activeSheet?.gid === sheet.gid ? ' product-status-sheet-tab-active' : ''
              }`}
              onClick={() => setActiveGid(sheet.gid)}
              aria-selected={activeSheet?.gid === sheet.gid}
            >
              {sheet.name}
            </button>
          ))}
        </nav>
      )}

      {error && <p className="banner-error">{error}</p>}

      <section className="table-section product-status-table-section">
        <p className="table-meta">
          {activeSheet ? (
            <>
              Лист «{activeSheet.name}» · строк {activeSheet.rows.length}
            </>
          ) : (
            <>Показано строк 0</>
          )}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className="table-scroll">
            {activeSheet && activeSheet.columns.length > 0 ? (
              <table className="product-status-table">
                <colgroup>
                  <col className="col-launch" />
                  <col className="col-project" />
                  <col className="col-description" />
                  <col className="col-why" />
                </colgroup>
                <thead>
                  <tr>
                    {activeSheet.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeSheet.rows.map((row, rowIndex) => (
                    <tr key={`${activeSheet.gid}-${rowIndex}`}>
                      {activeSheet.columns.map((column, columnIndex) => (
                        <td
                          key={`${rowIndex}-${column}`}
                          className={
                            columnIndex === 1 ? 'cell-project product-status-multiline' : 'product-status-multiline'
                          }
                        >
                          <ProductStatusCell
                            className={`product-status-cell-input${
                              columnIndex === 1 ? ' product-status-cell-project' : ''
                            }`}
                            value={row[column] ?? ''}
                            ariaLabel={column}
                            onChange={(nextValue) =>
                              updateCell(activeSheet.gid, rowIndex, column, nextValue)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="table-empty">Нет данных в таблице.</div>
            )}
            {activeSheet && !loading && activeSheet.rows.length === 0 && (
              <div className="table-empty">На этом листе нет данных.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
