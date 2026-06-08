import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, apiFetch, readApiError } from './api'

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

function cellText(value: string | undefined): string {
  return (value ?? '').trim() || '—'
}

export default function ProductStatusB2B() {
  const [data, setData] = useState<ProductStatusData | null>(null)
  const [activeGid, setActiveGid] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await getJson<ProductStatusData>('/api/product-status/b2b')
      setData(payload)
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
    setExporting(true)
    setError(null)
    try {
      const response = await apiFetch('/api/product-status/b2b/presentation')
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match?.[1] ?? 'status-produkta-b2b.pptx'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки презентации')
    } finally {
      setExporting(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const activeSheet = useMemo(
    () => data?.sheets.find((sheet) => sheet.gid === activeGid) ?? data?.sheets[0] ?? null,
    [activeGid, data],
  )

  return (
    <div className="product-status">
      <header className="product-status-toolbar">
        <div className="product-status-toolbar-left">
          <h1 className="product-status-title">{data?.title ?? 'Статус продукта B2B'}</h1>
          <p className="product-status-subtitle">
            Данные из Google Sheets
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
            onClick={() => void handleExportPresentation()}
            disabled={loading || exporting || (data?.sheets.length ?? 0) === 0}
          >
            {exporting ? 'Формирование…' : 'Скачать презентацию'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void loadData()} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
        </div>
      </header>

      {(data?.sheets.length ?? 0) > 0 && (
        <nav className="product-status-sheet-tabs" aria-label="Листы Google Sheets">
          {data?.sheets.map((sheet) => (
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
              Лист «{activeSheet.name}» · показано строк {activeSheet.totalShown}
            </>
          ) : (
            <>Показано строк 0</>
          )}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className="table-scroll">
            {activeSheet && activeSheet.columns.length > 0 ? (
              <>
                <div
                  className="table-head product-status-head"
                  style={{
                    gridTemplateColumns: `repeat(${activeSheet.columns.length}, minmax(120px, 1fr))`,
                  }}
                >
                  {activeSheet.columns.map((column) => (
                    <div key={column}>{column}</div>
                  ))}
                </div>
                <div className="table-body">
                  {activeSheet.rows.map((row, index) => (
                    <div
                      className="table-row product-status-row"
                      key={`${activeSheet.gid}-${index}`}
                      style={{
                        gridTemplateColumns: `repeat(${activeSheet.columns.length}, minmax(120px, 1fr))`,
                      }}
                    >
                      {activeSheet.columns.map((column) => (
                        <div
                          key={`${index}-${column}`}
                          className="product-status-cell product-status-multiline"
                        >
                          {cellText(row[column])}
                        </div>
                      ))}
                    </div>
                  ))}
                  {!loading && activeSheet.rows.length === 0 && (
                    <div className="table-empty">На этом листе нет данных.</div>
                  )}
                </div>
              </>
            ) : (
              <div className="table-empty">Нет данных в таблице.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
