import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, apiFetch, readApiError } from './api'
import { loadProductStatusB2bGid, saveProductStatusB2bGid } from './uiState'
import ProductStatusCell, { type ProductStatusCellHandle } from './ProductStatusCell'
import ProductStatusFormatToolbar from './ProductStatusFormatToolbar'
import type { CellStyle, TextStyleSegment } from './productStatusRichText'

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

type ActiveCell = {
  rowIndex: number
  column: string
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

function buildPayload(data: ProductStatusData | null, sheets: ProductStatusSheet[]): ProductStatusData {
  return {
    title: data?.title ?? 'Статус продукта B2B',
    sourceUrl: data?.sourceUrl,
    presentationReferenceUrl: data?.presentationReferenceUrl,
    sheets,
  }
}

export default function ProductStatusB2B() {
  const [data, setData] = useState<ProductStatusData | null>(null)
  const [sheets, setSheets] = useState<ProductStatusSheet[]>([])
  const [activeGid, setActiveGid] = useState<string | null>(null)
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exportingPresentation, setExportingPresentation] = useState(false)
  const [exportingExcel, setExportingExcel] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeCellRef = useRef<ProductStatusCellHandle | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await getJson<ProductStatusData>('/api/product-status/b2b')
      setData(payload)
      setSheets(cloneSheets(payload.sheets))
      setDirty(false)
      setActiveGid((current) => {
        const savedGid = loadProductStatusB2bGid()
        if (savedGid && payload.sheets.some((sheet) => sheet.gid === savedGid)) {
          return savedGid
        }
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

  const handleSave = useCallback(async () => {
    if (sheets.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch('/api/product-status/b2b/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(data, sheets)),
      })
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }, [data, sheets])

  const handleExportPresentation = useCallback(async () => {
    if (sheets.length === 0) return
    setExportingPresentation(true)
    setError(null)
    try {
      const response = await apiFetch('/api/product-status/b2b/presentation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(data, sheets)),
      })
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
  }, [data, sheets])

  const handleExportExcel = useCallback(async () => {
    if (sheets.length === 0) return
    setExportingExcel(true)
    setError(null)
    try {
      const response = await apiFetch('/api/product-status/b2b/excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(data, sheets)),
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
    setDirty(true)
    setSheets((current) =>
      current.map((sheet) => {
        if (sheet.gid !== gid) return sheet
        const rows = sheet.rows.map((row, index) =>
          index === rowIndex ? { ...row, [column]: value } : row,
        )
        return { ...sheet, rows }
      }),
    )
  }, [])

  const addRow = useCallback(() => {
    if (!activeGid) return
    setDirty(true)
    setSheets((current) =>
      current.map((sheet) => {
        if (sheet.gid !== activeGid) return sheet
        const emptyRow = Object.fromEntries(sheet.columns.map((column) => [column, '']))
        return { ...sheet, rows: [...sheet.rows, emptyRow], totalShown: sheet.rows.length + 1 }
      }),
    )
  }, [activeGid])

  const addColumn = useCallback(() => {
    if (!activeGid) return
    const sheet = sheets.find((item) => item.gid === activeGid)
    if (!sheet) return
    const proposed = window.prompt('Название нового столбца', 'Новый столбец')
    const name = proposed?.trim()
    if (!name) return
    if (sheet.columns.includes(name)) {
      setError(`Столбец «${name}» уже есть на этом листе`)
      return
    }

    setDirty(true)
    setSheets((current) =>
      current.map((item) => {
        if (item.gid !== activeGid) return item
        const rows = item.rows.map((row) => ({ ...row, [name]: '' }))
        return {
          ...item,
          columns: [...item.columns, name],
          rows,
        }
      }),
    )
  }, [activeGid, sheets])

  const handleRefresh = useCallback(() => {
    if (dirty && !window.confirm('Есть несохранённые изменения. Обновить из Google Sheets?')) {
      return
    }
    void loadData()
  }, [dirty, loadData])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (activeGid) {
      saveProductStatusB2bGid(activeGid)
    }
  }, [activeGid])

  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.gid === activeGid) ?? sheets[0] ?? null,
    [activeGid, sheets],
  )

  const exporting = exportingPresentation || exportingExcel
  const busy = loading || saving || exporting

  const applyTextStyle = useCallback((patch: Partial<TextStyleSegment>) => {
    activeCellRef.current?.applyTextStyle(patch)
  }, [])

  const applyCellStyle = useCallback((patch: Partial<CellStyle>) => {
    activeCellRef.current?.applyCellStyle(patch)
  }, [])

  const clearFormatting = useCallback(() => {
    activeCellRef.current?.clearFormatting()
  }, [])

  return (
    <div className="product-status">
      <header className="product-status-toolbar">
        <div className="product-status-toolbar-left">
          <h1 className="product-status-title">{data?.title ?? 'Статус продукта B2B'}</h1>
          {(data?.sourceUrl || data?.presentationReferenceUrl) && (
            <p className="product-status-subtitle">
              {data?.sourceUrl ? (
                <a className="zni-link" href={data.sourceUrl} target="_blank" rel="noreferrer">
                  Открыть таблицу
                </a>
              ) : null}
              {data?.sourceUrl && data?.presentationReferenceUrl ? ' · ' : null}
              {data?.presentationReferenceUrl ? (
                <a
                  className="zni-link"
                  href={data.presentationReferenceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Эталон в Google Slides
                </a>
              ) : null}
            </p>
          )}
          {dirty ? <p className="product-status-dirty">Есть несохранённые изменения</p> : null}
        </div>
        <div className="product-status-toolbar-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSave()}
            disabled={busy || sheets.length === 0 || !dirty}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleExportExcel()}
            disabled={busy || sheets.length === 0}
          >
            {exportingExcel ? 'Формирование…' : 'Скачать Excel'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleExportPresentation()}
            disabled={busy || sheets.length === 0}
          >
            {exportingPresentation ? 'Формирование…' : 'Скачать презентацию'}
          </button>
          <button type="button" className="btn-secondary" onClick={handleRefresh} disabled={loading}>
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

      <ProductStatusFormatToolbar
        disabled={busy}
        hasActiveCell={activeCell !== null}
        onTextStyle={applyTextStyle}
        onCellStyle={applyCellStyle}
        onClearFormatting={clearFormatting}
      />

      {error && <p className="banner-error">{error}</p>}

      <section className="table-section product-status-table-section">
        <div className="product-status-table-toolbar">
          <p className="table-meta">
            {activeSheet ? (
              <>
                Лист «{activeSheet.name}» · строк {activeSheet.rows.length} · столбцов{' '}
                {activeSheet.columns.length}
              </>
            ) : (
              <>Показано строк 0</>
            )}
            {loading ? ' · загрузка…' : ''}
          </p>
          <div className="product-status-table-toolbar-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={addRow}
              disabled={busy || !activeSheet}
            >
              + Строка
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={addColumn}
              disabled={busy || !activeSheet}
            >
              + Столбец
            </button>
          </div>
        </div>
        <div className="table">
          <div className="table-scroll">
            {activeSheet && activeSheet.columns.length > 0 ? (
              <table className="product-status-table">
                <colgroup>
                  {activeSheet.columns.map((_, index) => (
                    <col key={index} className={index === 1 ? 'col-project' : undefined} />
                  ))}
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
                      {activeSheet.columns.map((column, columnIndex) => {
                        const isActive =
                          activeCell?.rowIndex === rowIndex && activeCell.column === column
                        return (
                          <td
                            key={`${rowIndex}-${column}`}
                            className={
                              columnIndex === 1
                                ? 'cell-project product-status-multiline'
                                : 'product-status-multiline'
                            }
                          >
                            <ProductStatusCell
                              ref={(handle) => {
                                if (isActive) {
                                  activeCellRef.current = handle
                                }
                              }}
                              className={`product-status-cell-input${
                                columnIndex === 1 ? ' product-status-cell-project' : ''
                              }`}
                              value={row[column] ?? ''}
                              ariaLabel={column}
                              onFocus={() =>
                                setActiveCell({
                                  rowIndex,
                                  column,
                                })
                              }
                              onBlur={() => {
                                setActiveCell((current) =>
                                  current?.rowIndex === rowIndex && current.column === column
                                    ? null
                                    : current,
                                )
                              }}
                              onChange={(nextValue) =>
                                updateCell(activeSheet.gid, rowIndex, column, nextValue)
                              }
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : loading ? (
              <div className="table-empty">Загрузка…</div>
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
