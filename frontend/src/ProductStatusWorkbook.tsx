import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getJson, apiFetch, postJson, readApiError } from './api'
import ProductStatusCell, { type ProductStatusCellHandle } from './ProductStatusCell'
import ProductStatusFormatToolbar from './ProductStatusFormatToolbar'
import { collectZniNumbers, isZniColumn, parseZniNumber } from './productStatusZni'
import {
  booleanCellBackground,
  resolveBooleanColors,
  styledBooleanValue,
} from './productStatusBoolean'
import { displayCellText, type CellStyle, type TextStyleSegment } from './productStatusRichText'
import ZniDetailModal from './ZniDetailModal'
import type { ChangeRequest, TaskLookupResponse } from './zniTypes'

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

export type ProductStatusWorkbookConfig = {
  apiBase: string
  defaultTitle: string
  loadGid: () => string | null
  saveGid: (gid: string | null) => void
  variant?: 'page' | 'section'
  afterHeader?: ReactNode
  headerTitle?: ReactNode
  enablePresentationExport?: boolean
  enableExcelExport?: boolean
  presentationFilename?: string
  excelFilename?: string
  lazySheets?: boolean
}

function cloneSheet(sheet: ProductStatusSheet): ProductStatusSheet {
  return {
    ...sheet,
    columns: [...sheet.columns],
    rows: sheet.rows.map((row) => ({ ...row })),
  }
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

function buildPayload(data: ProductStatusData | null, sheets: ProductStatusSheet[], defaultTitle: string): ProductStatusData {
  return {
    title: data?.title ?? defaultTitle,
    sourceUrl: data?.sourceUrl,
    presentationReferenceUrl: data?.presentationReferenceUrl,
    sheets,
  }
}

function isPresentationFlagColumn(column: string): boolean {
  return column.trim().toLowerCase().includes('идет в презентацию')
}

function isAttentionColumn(column: string): boolean {
  const key = column.trim().toLowerCase()
  return key.includes('обратить') && key.includes('вним')
}

function resolveColumnClass(column: string): string | undefined {
  const key = column.trim().toLowerCase()
  if (key === 'зни') return 'col-zni'
  if (isPresentationFlagColumn(column) || isAttentionColumn(column)) return 'col-presentation-flag'
  if (key === 'дата' || key.startsWith('дата')) return 'col-date'
  if (key === 'новость') return 'col-news'
  if (key === 'проект') return 'col-project'
  if (key.includes('полное описание') || key.includes('для презентации')) return 'col-description'
  if (key.includes('описание')) return 'col-description'
  if (key.includes('зачем')) return 'col-why'
  return undefined
}

function isBooleanColumn(column: string): boolean {
  return isPresentationFlagColumn(column) || isAttentionColumn(column)
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

export default function ProductStatusWorkbook({
  apiBase,
  defaultTitle,
  loadGid,
  saveGid,
  variant = 'page',
  afterHeader,
  headerTitle,
  enablePresentationExport = false,
  enableExcelExport = false,
  presentationFilename = 'workbook.pptx',
  excelFilename = 'workbook.xlsx',
  lazySheets = false,
}: ProductStatusWorkbookConfig) {
  const isSection = variant === 'section'
  const RootTag = isSection ? 'section' : 'div'
  const rootClassName = isSection ? 'product-status-section' : 'product-status'
  const titleClassName = isSection ? 'product-status-section-title' : 'product-status-title'
  const TitleTag = isSection ? 'h2' : 'h1'
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
  const [zniLookup, setZniLookup] = useState<Record<string, ChangeRequest>>({})
  const [zniModalItem, setZniModalItem] = useState<ChangeRequest | null>(null)
  const [loadedGids, setLoadedGids] = useState<Set<string>>(() => new Set())
  const [sheetLoadingGid, setSheetLoadingGid] = useState<string | null>(null)
  const activeCellRef = useRef<ProductStatusCellHandle | null>(null)

  const loadSheetData = useCallback(
    async (gid: string, options?: { refresh?: boolean }) => {
      const params = new URLSearchParams({ gid })
      if (options?.refresh) {
        params.set('refresh', 'true')
      }
      const payload = await getJson<ProductStatusData>(`${apiBase}?${params}`)
      const sheet = payload.sheets.find((item) => item.gid === gid && item.columns.length > 0)
      if (!sheet) {
        throw new Error('Лист пустой или не удалось загрузить данные')
      }
      setSheets((current) => current.map((item) => (item.gid === gid ? cloneSheet(sheet) : item)))
      setLoadedGids((current) => new Set(current).add(gid))
      setData((current) => ({
        title: payload.title ?? current?.title ?? defaultTitle,
        sourceUrl: payload.sourceUrl ?? current?.sourceUrl,
        presentationReferenceUrl:
          payload.presentationReferenceUrl ?? current?.presentationReferenceUrl,
        sheets: current?.sheets ?? payload.sheets,
      }))
    },
    [apiBase, defaultTitle],
  )

  const ensureSheetLoaded = useCallback(
    async (gid: string, options?: { refresh?: boolean }) => {
      const existing = sheets.find((sheet) => sheet.gid === gid)
      if (!options?.refresh && loadedGids.has(gid) && existing && existing.columns.length > 0) {
        return
      }
      setSheetLoadingGid(gid)
      setError(null)
      try {
        await loadSheetData(gid, options)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка загрузки листа')
      } finally {
        setSheetLoadingGid((current) => (current === gid ? null : current))
      }
    },
    [loadSheetData, loadedGids, sheets],
  )

  const loadData = useCallback(
    async (options?: { refresh?: boolean }) => {
      setLoading(true)
      setError(null)
      try {
        if (lazySheets) {
          const params = new URLSearchParams({ meta_only: 'true' })
          if (options?.refresh) {
            params.set('refresh', 'true')
          }
          const meta = await getJson<ProductStatusData>(`${apiBase}?${params}`)
          setData(meta)
          setSheets(cloneSheets(meta.sheets))
          setLoadedGids(new Set())
          setDirty(false)

          const savedGid = loadGid()
          const initialGid =
            savedGid && meta.sheets.some((sheet) => sheet.gid === savedGid)
              ? savedGid
              : meta.sheets[0]?.gid ?? null
          setActiveGid(initialGid)
          setLoading(false)

          if (initialGid) {
            setSheetLoadingGid(initialGid)
            try {
              await loadSheetData(initialGid, options)
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Ошибка загрузки листа')
            } finally {
              setSheetLoadingGid(null)
            }
          }
          return
        }

        const url = options?.refresh ? `${apiBase}?refresh=true` : apiBase
        const payload = await getJson<ProductStatusData>(url)
        setData(payload)
        setSheets(cloneSheets(payload.sheets))
        setLoadedGids(new Set(payload.sheets.map((sheet) => sheet.gid)))
        setDirty(false)
        setActiveGid((current) => {
          const savedGid = loadGid()
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
    },
    [apiBase, lazySheets, loadGid, loadSheetData],
  )

  const handleSave = useCallback(async () => {
    if (sheets.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(`${apiBase}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(data, sheets, defaultTitle)),
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
  }, [apiBase, data, defaultTitle, sheets])

  const handleExportPresentation = useCallback(async () => {
    if (!enablePresentationExport || sheets.length === 0) return
    setExportingPresentation(true)
    setError(null)
    try {
      const response = await apiFetch(
        `${apiBase}/presentation`,
        lazySheets
          ? undefined
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildPayload(data, sheets, defaultTitle)),
            },
      )
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const blob = await response.blob()
      downloadBlob(
        blob,
        filenameFromDisposition(response.headers.get('Content-Disposition') ?? '', presentationFilename),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки презентации')
    } finally {
      setExportingPresentation(false)
    }
  }, [apiBase, data, defaultTitle, enablePresentationExport, lazySheets, presentationFilename, sheets])

  const handleExportExcel = useCallback(async () => {
    if (!enableExcelExport || sheets.length === 0) return
    setExportingExcel(true)
    setError(null)
    try {
      const response = await apiFetch(
        `${apiBase}/excel`,
        lazySheets
          ? undefined
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildPayload(data, sheets, defaultTitle)),
            },
      )
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const blob = await response.blob()
      downloadBlob(
        blob,
        filenameFromDisposition(response.headers.get('Content-Disposition') ?? '', excelFilename),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки Excel')
    } finally {
      setExportingExcel(false)
    }
  }, [apiBase, data, defaultTitle, enableExcelExport, excelFilename, lazySheets, sheets])

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
    void loadData({ refresh: true })
  }, [dirty, loadData])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (activeGid) {
      saveGid(activeGid)
    }
  }, [activeGid, saveGid])

  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.gid === activeGid) ?? sheets[0] ?? null,
    [activeGid, sheets],
  )

  const booleanColorsByColumn = useMemo(() => {
    if (!activeSheet) return {}
    const map: Record<string, ReturnType<typeof resolveBooleanColors>> = {}
    for (const column of activeSheet.columns) {
      if (isBooleanColumn(column)) {
        map[column] = resolveBooleanColors(activeSheet.rows, column)
      }
    }
    return map
  }, [activeSheet])

  const zniColumn = useMemo(
    () => activeSheet?.columns.find((column) => isZniColumn(column)) ?? null,
    [activeSheet],
  )

  const zniNumbersKey = useMemo(() => {
    if (!activeSheet || !zniColumn) return ''
    return collectZniNumbers(activeSheet.rows, zniColumn).join(',')
  }, [activeSheet, zniColumn])

  useEffect(() => {
    if (!zniNumbersKey) {
      setZniLookup({})
      return
    }

    const numbers = zniNumbersKey.split(',').filter(Boolean)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void postJson<TaskLookupResponse>('/api/tasks/lookup', { numbers })
        .then((payload) => {
          if (cancelled) return
          const next: Record<string, ChangeRequest> = {}
          for (const item of payload.items) {
            next[item.number] = item
          }
          setZniLookup(next)
        })
        .catch(() => {
          if (!cancelled) {
            setZniLookup({})
          }
        })
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [zniNumbersKey])

  const openZniModal = useCallback((item: ChangeRequest) => {
    setZniModalItem(item)
  }, [])

  const closeZniModal = useCallback(() => {
    setZniModalItem(null)
  }, [])

  const exporting = exportingPresentation || exportingExcel
  const sheetLoading = sheetLoadingGid !== null
  const busy = loading || sheetLoading || saving || exporting
  const activeSheetReady = Boolean(activeSheet && activeSheet.columns.length > 0)

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
    <RootTag className={rootClassName}>
      <ZniDetailModal item={zniModalItem} onClose={closeZniModal} />
      <header className="product-status-toolbar">
        <div className="product-status-toolbar-left">
          {headerTitle ?? (
            <TitleTag className={titleClassName}>{data?.title ?? defaultTitle}</TitleTag>
          )}
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
          {enableExcelExport ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleExportExcel()}
              disabled={busy || sheets.length === 0}
            >
              {exportingExcel ? 'Формирование…' : 'Скачать Excel'}
            </button>
          ) : null}
          {enablePresentationExport ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleExportPresentation()}
              disabled={busy || sheets.length === 0}
            >
              {exportingPresentation ? 'Формирование…' : 'Скачать презентацию'}
            </button>
          ) : null}
          <button type="button" className="btn-secondary" onClick={handleRefresh} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
        </div>
      </header>

      {afterHeader}

      {sheets.length > 0 && (
        <nav className="product-status-sheet-tabs" aria-label="Листы Google Sheets">
          {sheets.map((sheet) => (
            <button
              key={sheet.gid}
              type="button"
              className={`product-status-sheet-tab${
                activeSheet?.gid === sheet.gid ? ' product-status-sheet-tab-active' : ''
              }`}
              onClick={() => {
                setActiveGid(sheet.gid)
                if (lazySheets) {
                  void ensureSheetLoaded(sheet.gid)
                }
              }}
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
            {loading || sheetLoading ? ' · загрузка…' : ''}
          </p>
          <div className="product-status-table-toolbar-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={addRow}
              disabled={busy || !activeSheetReady}
            >
              + Строка
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={addColumn}
              disabled={busy || !activeSheetReady}
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
                  {activeSheet.columns.map((column, index) => (
                    <col key={index} className={resolveColumnClass(column)} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {activeSheet.columns.map((column) => (
                      <th
                        key={column}
                        className={[
                          resolveColumnClass(column),
                          isBooleanColumn(column) ? 'product-status-bool-header' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeSheet.rows.map((row, rowIndex) => (
                    <tr key={`${activeSheet.gid}-${rowIndex}`}>
                      {activeSheet.columns.map((column) => {
                        const isActive =
                          activeCell?.rowIndex === rowIndex && activeCell.column === column
                        const colClass = resolveColumnClass(column)
                        const cellClassName = [
                          colClass,
                          isBooleanColumn(column) ? 'product-status-bool-cell' : 'product-status-multiline',
                        ]
                          .filter(Boolean)
                          .join(' ')

                        if (isBooleanColumn(column)) {
                          const cellValue = row[column] ?? ''
                          const cellBg = booleanCellBackground(cellValue)
                          return (
                            <td
                              key={`${rowIndex}-${column}`}
                              className={cellClassName}
                              style={cellBg ? { backgroundColor: `#${cellBg}` } : undefined}
                            >
                              <input
                                type="checkbox"
                                className="product-status-bool-checkbox"
                                checked={isYesValue(cellValue)}
                                aria-label={column}
                                disabled={busy}
                                onChange={(event) => {
                                  const colors =
                                    booleanColorsByColumn[column] ??
                                    resolveBooleanColors(activeSheet.rows, column)
                                  updateCell(
                                    activeSheet.gid,
                                    rowIndex,
                                    column,
                                    styledBooleanValue(event.target.checked, colors),
                                  )
                                }}
                              />
                            </td>
                          )
                        }

                        const zniNumber = isZniColumn(column)
                          ? parseZniNumber(row[column] ?? '')
                          : null
                        const matchedZni = zniNumber ? zniLookup[zniNumber] : undefined

                        return (
                          <td
                            key={`${rowIndex}-${column}`}
                            className={[
                              cellClassName,
                              matchedZni ? 'product-status-zni-cell--matched' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {matchedZni && zniNumber ? (
                              <button
                                type="button"
                                className="zni-link product-status-zni-trigger"
                                onClick={() => openZniModal(matchedZni)}
                              >
                                {zniNumber}
                              </button>
                            ) : null}
                            <ProductStatusCell
                              ref={(handle) => {
                                if (isActive) {
                                  activeCellRef.current = handle
                                }
                              }}
                              className="product-status-cell-input"
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
            ) : loading || sheetLoading ? (
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
    </RootTag>
  )
}
