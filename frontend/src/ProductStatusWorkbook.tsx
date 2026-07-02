import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getJson, apiFetch, postJson, readApiError } from './api'
import { notifyLoading, notifyProblem, notifySuccess, notifyWarning } from './toast'
import { type ProductStatusCellHandle } from './ProductStatusCell'
import ProductStatusFormatToolbar from './ProductStatusFormatToolbar'
import ProductStatusTableRow, { type ActiveCell, PRODUCT_STATUS_ROW_ID_KEY } from './ProductStatusTableRow'
import {
  collectZniNumbers,
  isZniColumn,
} from './productStatusZni'
import { resolveBooleanColors } from './productStatusBoolean'
import { displayCellText, type CellStyle, type TextStyleSegment } from './productStatusRichText'
import {
  clearProductStatusCache,
  readProductStatusCache,
  writeProductStatusCache,
} from './productStatusClientCache'
import type { ChangeRequest, TaskLookupResponse } from './zniTypes'
import ZniDetailModal from './ZniDetailModal'

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

type ProductStatusCellUpdate = {
  gid: string
  rowIndex: number
  columnIndex: number
  value: string
  column?: string
}

type ProductStatusSavePayload = {
  updates: ProductStatusCellUpdate[]
  deletedRows: Array<{ gid: string; rowId: number }>
}

type ProductStatusHistoryEntry = {
  id: number
  rowId: number | null
  officeName: string
  action: string
  fieldName: string | null
  oldValue: string | null
  newValue: string | null
  changedBy: string | null
  changedAt: string
}

type ProductStatusHistoryData = {
  items: ProductStatusHistoryEntry[]
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
  fixedColumns?: boolean
  enableRowDelete?: boolean
  enableHistory?: boolean
  canEditAdminColumns?: boolean
}

const ADMIN_ONLY_COLUMNS = new Set(['Проект координация'])

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

function diffSheetToUpdates(baseline: ProductStatusSheet, current: ProductStatusSheet): ProductStatusCellUpdate[] {
  const updates: ProductStatusCellUpdate[] = []

  for (let columnIndex = baseline.columns.length; columnIndex < current.columns.length; columnIndex += 1) {
    const column = current.columns[columnIndex]
    updates.push({
      gid: current.gid,
      rowIndex: 0,
      columnIndex,
      value: column,
      column,
    })
    for (let rowIndex = 0; rowIndex < current.rows.length; rowIndex += 1) {
      updates.push({
        gid: current.gid,
        rowIndex: rowIndex + 1,
        columnIndex,
        value: current.rows[rowIndex][column] ?? '',
        column,
      })
    }
  }

  const sharedColumnCount = Math.min(baseline.columns.length, current.columns.length)
  const sharedRowCount = Math.min(baseline.rows.length, current.rows.length)
  for (let rowIndex = 0; rowIndex < sharedRowCount; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < sharedColumnCount; columnIndex += 1) {
      const column = current.columns[columnIndex]
      const previousValue = baseline.rows[rowIndex]?.[column] ?? ''
      const nextValue = current.rows[rowIndex]?.[column] ?? ''
      if (previousValue !== nextValue) {
        updates.push({
          gid: current.gid,
          rowIndex: rowIndex + 1,
          columnIndex,
          value: nextValue,
          column,
        })
      }
    }
  }

  for (let rowIndex = baseline.rows.length; rowIndex < current.rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < current.columns.length; columnIndex += 1) {
      const column = current.columns[columnIndex]
      updates.push({
        gid: current.gid,
        rowIndex: rowIndex + 1,
        columnIndex,
        value: current.rows[rowIndex][column] ?? '',
        column,
      })
    }
  }

  return updates
}

function collectDeletedRows(
  baseline: ProductStatusSheet,
  current: ProductStatusSheet,
): Array<{ gid: string; rowId: number }> {
  const currentIds = new Set(
    current.rows
      .map((row) => row[PRODUCT_STATUS_ROW_ID_KEY])
      .filter((value): value is string => Boolean(value)),
  )
  const deleted: Array<{ gid: string; rowId: number }> = []
  for (const row of baseline.rows) {
    const rowId = row[PRODUCT_STATUS_ROW_ID_KEY]
    if (!rowId || currentIds.has(rowId)) continue
    const parsed = Number(rowId)
    if (!Number.isNaN(parsed) && parsed > 0) {
      deleted.push({ gid: current.gid, rowId: parsed })
    }
  }
  return deleted
}

function collectSheetUpdates(
  baselineByGid: Map<string, ProductStatusSheet>,
  sheets: ProductStatusSheet[],
  loadedGids: Set<string>,
): ProductStatusSavePayload {
  const updates: ProductStatusCellUpdate[] = []
  const deletedRows: Array<{ gid: string; rowId: number }> = []
  for (const sheet of sheets) {
    if (!loadedGids.has(sheet.gid) || sheet.columns.length === 0) {
      continue
    }
    const baseline = baselineByGid.get(sheet.gid)
    if (!baseline || baseline.columns.length === 0) {
      continue
    }
    updates.push(...diffSheetToUpdates(baseline, sheet))
    deletedRows.push(...collectDeletedRows(baseline, sheet))
  }
  return { updates, deletedRows }
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
  if (key.includes('координац')) return 'col-project'
  if (isPresentationFlagColumn(column) || isAttentionColumn(column)) return 'col-presentation-flag'
  if (key === 'дата' || key.startsWith('дата')) return 'col-date'
  if (key === 'новость') return 'col-news'
  if (key === 'проект') return 'col-project'
  if (key.includes('зачем')) return 'col-why'
  if (key.includes('полное описание') || key.includes('для презентации')) return 'col-description'
  if (key.includes('описание')) return 'col-description'
  return undefined
}

function isAdminOnlyColumn(column: string): boolean {
  return ADMIN_ONLY_COLUMNS.has(column.trim())
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

function findColumn(columns: string[], matcher: (column: string) => boolean): string | undefined {
  return columns.find(matcher)
}

function resolveRowHighlight(
  row: Record<string, string>,
  columns: string[],
): { isPresentation: boolean; isAttention: boolean } {
  const presentationColumn = findColumn(columns, isPresentationFlagColumn)
  const attentionColumn = findColumn(columns, isAttentionColumn)
  return {
    isPresentation: presentationColumn ? isYesValue(row[presentationColumn] ?? '') : false,
    isAttention: attentionColumn ? isYesValue(row[attentionColumn] ?? '') : false,
  }
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
  fixedColumns = false,
  enableRowDelete = false,
  enableHistory = false,
  canEditAdminColumns = false,
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
  const [zniLookup, setZniLookup] = useState<Record<string, ChangeRequest>>({})
  const [zniModalItem, setZniModalItem] = useState<ChangeRequest | null>(null)
  const [historyItems, setHistoryItems] = useState<ProductStatusHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadedGids, setLoadedGids] = useState<Set<string>>(() => new Set())
  const [sheetLoadingGid, setSheetLoadingGid] = useState<string | null>(null)
  const activeCellRef = useRef<ProductStatusCellHandle | null>(null)
  const baselineByGidRef = useRef<Map<string, ProductStatusSheet>>(new Map())

  const rememberBaseline = useCallback((sheet: ProductStatusSheet) => {
    baselineByGidRef.current.set(sheet.gid, cloneSheet(sheet))
  }, [])

  const resetBaselines = useCallback(() => {
    baselineByGidRef.current = new Map()
  }, [])

  const syncBaselinesFromSheets = useCallback((nextSheets: ProductStatusSheet[], gids: Set<string>) => {
    for (const sheet of nextSheets) {
      if (gids.has(sheet.gid) && sheet.columns.length > 0) {
        rememberBaseline(sheet)
      }
    }
  }, [rememberBaseline])

  const loadSheetData = useCallback(
    async (gid: string, options?: { refresh?: boolean }) => {
      if (!options?.refresh) {
        const cached = readProductStatusCache(apiBase, { gid })
        if (cached) {
          const sheet = cached.sheets.find((item) => item.gid === gid && item.columns.length > 0)
          if (sheet) {
            setSheets((current) => current.map((item) => (item.gid === gid ? cloneSheet(sheet) : item)))
            setLoadedGids((current) => new Set(current).add(gid))
            rememberBaseline(sheet)
            setData((current) => ({
              title: cached.title ?? current?.title ?? defaultTitle,
              sourceUrl: cached.sourceUrl ?? current?.sourceUrl,
              presentationReferenceUrl:
                cached.presentationReferenceUrl ?? current?.presentationReferenceUrl,
              sheets: current?.sheets ?? cached.sheets,
            }))
            return
          }
        }
      }

      const params = new URLSearchParams({ gid })
      if (options?.refresh) {
        params.set('refresh', 'true')
      }
      const payload = await getJson<ProductStatusData>(`${apiBase}?${params}`)
      writeProductStatusCache(apiBase, payload, { gid })
      const sheet = payload.sheets.find((item) => item.gid === gid && item.columns.length > 0)
      if (!sheet) {
        throw new Error('Лист пустой или не удалось загрузить данные')
      }
      setSheets((current) => current.map((item) => (item.gid === gid ? cloneSheet(sheet) : item)))
      setLoadedGids((current) => new Set(current).add(gid))
      rememberBaseline(sheet)
      setData((current) => ({
        title: payload.title ?? current?.title ?? defaultTitle,
        sourceUrl: payload.sourceUrl ?? current?.sourceUrl,
        presentationReferenceUrl:
          payload.presentationReferenceUrl ?? current?.presentationReferenceUrl,
        sheets: current?.sheets ?? payload.sheets,
      }))
    },
    [apiBase, defaultTitle, rememberBaseline],
  )

  const loadSheetQuiet = useCallback(
    async (gid: string, options?: { refresh?: boolean }) => {
      setSheetLoadingGid(gid)
      try {
        await loadSheetData(gid, options)
      } catch (err) {
        notifyProblem(err, 'Ошибка загрузки листа')
        throw err
      } finally {
        setSheetLoadingGid((current) => (current === gid ? null : current))
      }
    },
    [loadSheetData],
  )

  const ensureSheetLoaded = useCallback(
    async (gid: string, options?: { refresh?: boolean }) => {
      const existing = sheets.find((sheet) => sheet.gid === gid)
      if (!options?.refresh && loadedGids.has(gid) && existing && existing.columns.length > 0) {
        return
      }
      await loadSheetQuiet(gid, options)
    },
    [loadedGids, loadSheetQuiet, sheets],
  )

  const loadData = useCallback(
    async (options?: { refresh?: boolean }) => {
      setLoading(true)
      const showToast = Boolean(options?.refresh)
      const mainToastId = showToast
        ? notifyLoading('Обновление данных…', 'product-status-load')
        : null
      const completeMainToast = (err?: unknown) => {
        if (!showToast || mainToastId == null) return
        if (err) {
          notifyProblem(err, 'Ошибка загрузки', mainToastId)
          return
        }
        notifySuccess('Данные обновлены', mainToastId)
      }

      try {
        if (options?.refresh) {
          clearProductStatusCache(apiBase)
          resetBaselines()
        }

        if (lazySheets) {
          if (!options?.refresh) {
            const cachedMeta = readProductStatusCache(apiBase, { metaOnly: true })
            if (cachedMeta) {
              setData(cachedMeta)
              setSheets(cloneSheets(cachedMeta.sheets))
              setLoadedGids(new Set())
              resetBaselines()
              setDirty(false)

              const savedGid = loadGid()
              const initialGid =
                savedGid && cachedMeta.sheets.some((sheet) => sheet.gid === savedGid)
                  ? savedGid
                  : cachedMeta.sheets[0]?.gid ?? null
              setActiveGid(initialGid)
              if (initialGid) {
                setSheetLoadingGid(initialGid)
              }
              setLoading(false)

              if (initialGid) {
                await loadSheetQuiet(initialGid, options)
              }
              return
            }
          }

          const params = new URLSearchParams({ meta_only: 'true' })
          if (options?.refresh) {
            params.set('refresh', 'true')
          }
          const meta = await getJson<ProductStatusData>(`${apiBase}?${params}`)
          writeProductStatusCache(apiBase, meta, { metaOnly: true })
          setData(meta)
          setSheets(cloneSheets(meta.sheets))
          setLoadedGids(new Set())
          resetBaselines()
          setDirty(false)

          const savedGid = loadGid()
          const initialGid =
            savedGid && meta.sheets.some((sheet) => sheet.gid === savedGid)
              ? savedGid
              : meta.sheets[0]?.gid ?? null
          setActiveGid(initialGid)
          if (initialGid) {
            setSheetLoadingGid(initialGid)
          }
          setLoading(false)

          if (initialGid) {
            await loadSheetQuiet(initialGid, options)
          }
          completeMainToast()
          return
        }

        if (!options?.refresh) {
          const cached = readProductStatusCache(apiBase)
          if (cached) {
            setData(cached)
            setSheets(cloneSheets(cached.sheets))
            setLoadedGids(new Set(cached.sheets.map((sheet) => sheet.gid)))
            resetBaselines()
            for (const sheet of cached.sheets) {
              if (sheet.columns.length > 0) {
                rememberBaseline(sheet)
              }
            }
            setDirty(false)
            setActiveGid((current) => {
              const savedGid = loadGid()
              if (savedGid && cached.sheets.some((sheet) => sheet.gid === savedGid)) {
                return savedGid
              }
              if (current && cached.sheets.some((sheet) => sheet.gid === current)) {
                return current
              }
              return cached.sheets[0]?.gid ?? null
            })
            completeMainToast()
            return
          }
        }

        const url = options?.refresh ? `${apiBase}?refresh=true` : apiBase
        const payload = await getJson<ProductStatusData>(url)
        writeProductStatusCache(apiBase, payload)
        setData(payload)
        setSheets(cloneSheets(payload.sheets))
        setLoadedGids(new Set(payload.sheets.map((sheet) => sheet.gid)))
        resetBaselines()
        for (const sheet of payload.sheets) {
          if (sheet.columns.length > 0) {
            rememberBaseline(sheet)
          }
        }
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
        completeMainToast()
      } catch (err) {
        completeMainToast(err)
      } finally {
        setLoading(false)
      }
    },
    [apiBase, lazySheets, loadGid, loadSheetQuiet, rememberBaseline, resetBaselines],
  )

  const loadHistory = useCallback(
    async (gid: string) => {
      if (!enableHistory) return
      setHistoryLoading(true)
      try {
        const payload = await getJson<ProductStatusHistoryData>(
          `${apiBase}/history?${new URLSearchParams({ gid })}`,
        )
        setHistoryItems(payload.items)
      } catch (err) {
        setHistoryItems([])
        notifyProblem(err, 'Ошибка загрузки истории')
      } finally {
        setHistoryLoading(false)
      }
    },
    [apiBase, enableHistory],
  )

  const handleSave = useCallback(async () => {
    if (sheets.length === 0) return
    const payload = collectSheetUpdates(baselineByGidRef.current, sheets, loadedGids)
    if (payload.updates.length === 0 && payload.deletedRows.length === 0) {
      setDirty(false)
      return
    }
    setSaving(true)
    const toastId = notifyLoading('Сохранение…', 'product-status-save')
    try {
      const response = await apiFetch(`${apiBase}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      syncBaselinesFromSheets(sheets, loadedGids)
      setDirty(false)
      clearProductStatusCache(apiBase)
      if (enableHistory && activeGid) {
        void loadHistory(activeGid)
      }
      notifySuccess('Сохранено', toastId)
    } catch (err) {
      notifyProblem(err, 'Ошибка сохранения', toastId)
    } finally {
      setSaving(false)
    }
  }, [activeGid, apiBase, enableHistory, loadHistory, loadedGids, sheets, syncBaselinesFromSheets])

  const deleteRow = useCallback(
    (rowIndex: number) => {
      if (!activeGid) return
      if (!window.confirm('Удалить строку? Изменение попадёт в презентацию после сохранения.')) {
        return
      }
      setDirty(true)
      setSheets((current) =>
        current.map((sheet) => {
          if (sheet.gid !== activeGid) return sheet
          return {
            ...sheet,
            rows: sheet.rows.filter((_, index) => index !== rowIndex),
            totalShown: sheet.rows.length - 1,
          }
        }),
      )
      setActiveCell((current) => {
        if (!current) return null
        if (current.rowIndex === rowIndex) return null
        if (current.rowIndex > rowIndex) {
          return { ...current, rowIndex: current.rowIndex - 1 }
        }
        return current
      })
    },
    [activeGid],
  )

  const isReadOnlyColumn = useCallback(
    (column: string) => isAdminOnlyColumn(column) && !canEditAdminColumns,
    [canEditAdminColumns],
  )

  const handleExportPresentation = useCallback(async () => {
    if (!enablePresentationExport || sheets.length === 0) return
    setExportingPresentation(true)
    const toastId = notifyLoading('Формирование презентации…', 'product-status-presentation')
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
      notifySuccess('Презентация сформирована', toastId)
    } catch (err) {
      notifyProblem(err, 'Ошибка выгрузки презентации', toastId)
    } finally {
      setExportingPresentation(false)
    }
  }, [apiBase, data, defaultTitle, enablePresentationExport, lazySheets, presentationFilename, sheets])

  const handleExportExcel = useCallback(async () => {
    if (!enableExcelExport || sheets.length === 0) return
    setExportingExcel(true)
    const toastId = notifyLoading('Формирование Excel…', 'product-status-excel')
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
      notifySuccess('Excel сформирован', toastId)
    } catch (err) {
      notifyProblem(err, 'Ошибка выгрузки Excel', toastId)
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
      notifyWarning(`Столбец «${name}» уже есть на этом листе`)
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

  const handleActiveCellFocus = useCallback((cell: ActiveCell) => {
    setActiveCell(cell)
  }, [])

  const handleActiveCellBlur = useCallback((cell: ActiveCell) => {
    setActiveCell((current) =>
      current?.rowIndex === cell.rowIndex && current.column === cell.column ? null : current,
    )
  }, [])

  const handleRefresh = useCallback(() => {
    if (dirty && !window.confirm('Есть несохранённые изменения. Обновить данные?')) {
      return
    }
    void loadData({ refresh: true })
  }, [dirty, loadData])

  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData

  useEffect(() => {
    void loadDataRef.current()
  }, [apiBase])

  useEffect(() => {
    if (activeGid) {
      saveGid(activeGid)
    }
  }, [activeGid, saveGid])

  useEffect(() => {
    if (!enableHistory || !activeGid || !loadedGids.has(activeGid)) {
      setHistoryItems([])
      return
    }
    void loadHistory(activeGid)
  }, [activeGid, enableHistory, loadHistory, loadedGids])

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
    setZniLookup({})
  }, [activeGid])

  useEffect(() => {
    if (!zniNumbersKey) {
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
        .catch((err) => {
          if (!cancelled) {
            setZniLookup({})
            notifyProblem(err, 'Не удалось загрузить данные ЗНИ')
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
  const toolbarBusy = loading || sheetLoading || saving || exporting
  const cellBusy = saving || exporting
  const activeSheetReady = Boolean(activeSheet && activeSheet.columns.length > 0)
  const tablePending = Boolean(activeSheetReady && sheetLoading && sheetLoadingGid === activeGid)

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
            disabled={toolbarBusy || sheets.length === 0 || !dirty}
          >
            Сохранить
          </button>
          {enableExcelExport ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleExportExcel()}
              disabled={toolbarBusy || sheets.length === 0}
            >
              Скачать Excel
            </button>
          ) : null}
          {enablePresentationExport ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleExportPresentation()}
              disabled={toolbarBusy || sheets.length === 0}
            >
              Скачать презентацию
            </button>
          ) : null}
          <button type="button" className="btn-secondary" onClick={handleRefresh} disabled={toolbarBusy}>
            Обновить
          </button>
        </div>
      </header>

      {afterHeader}

      {sheets.length > 0 && (
        <nav className="product-status-sheet-tabs" aria-label="Продуктовые офисы">
          {sheets.map((sheet) => (
            <button
              key={sheet.gid}
              type="button"
              className={`product-status-sheet-tab${
                activeSheet?.gid === sheet.gid ? ' product-status-sheet-tab-active' : ''
              }`}
              onClick={() => {
                const needsLoad =
                  lazySheets &&
                  (!loadedGids.has(sheet.gid) ||
                    !sheets.find((item) => item.gid === sheet.gid && item.columns.length > 0))
                if (needsLoad) {
                  setSheetLoadingGid(sheet.gid)
                }
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
        disabled={toolbarBusy}
        hasActiveCell={activeCell !== null}
        onTextStyle={applyTextStyle}
        onCellStyle={applyCellStyle}
        onClearFormatting={clearFormatting}
      />

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
          </p>
          <div className="product-status-table-toolbar-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={addRow}
              disabled={toolbarBusy || !activeSheetReady}
            >
              + Строка
            </button>
            {!fixedColumns ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={addColumn}
                disabled={toolbarBusy || !activeSheetReady}
              >
                + Столбец
              </button>
            ) : null}
          </div>
        </div>
        <div className="table">
          <div
            className={[
              'table-scroll',
              'product-status-table-scroll',
              tablePending ? 'product-status-table-scroll--pending' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {activeSheetReady ? (
              <table className="product-status-table">
                <colgroup>
                  {enableRowDelete ? <col className="col-row-actions" /> : null}
                  {activeSheet!.columns.map((column, index) => (
                    <col key={index} className={resolveColumnClass(column)} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {enableRowDelete ? (
                      <th className="product-status-row-actions-header" aria-label="Действия" />
                    ) : null}
                    {activeSheet!.columns.map((column) => (
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
                  {activeSheet!.rows.map((row, rowIndex) => {
                    const { isPresentation, isAttention } = resolveRowHighlight(
                      row,
                      activeSheet!.columns,
                    )
                    const rowClassName = [
                      isPresentation ? 'product-status-row--presentation' : '',
                      isAttention ? 'product-status-row--attention' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')

                    return (
                      <ProductStatusTableRow
                        key={`${activeSheet!.gid}-${row[PRODUCT_STATUS_ROW_ID_KEY] ?? rowIndex}`}
                        sheetGid={activeSheet!.gid}
                        rowIndex={rowIndex}
                        row={row}
                        columns={activeSheet!.columns}
                        rowClassName={rowClassName || undefined}
                        cellBusy={cellBusy}
                        activeCell={activeCell}
                        booleanColorsByColumn={booleanColorsByColumn}
                        zniLookup={zniLookup}
                        onUpdateCell={updateCell}
                        onActiveCellFocus={handleActiveCellFocus}
                        onActiveCellBlur={handleActiveCellBlur}
                        onOpenZniModal={openZniModal}
                        activeCellRef={activeCellRef}
                        resolveColumnClass={resolveColumnClass}
                        isBooleanColumn={isBooleanColumn}
                        isReadOnlyColumn={isReadOnlyColumn}
                        enableRowDelete={enableRowDelete}
                        onDeleteRow={deleteRow}
                      />
                    )
                  })}
                </tbody>
              </table>
            ) : loading || sheetLoading ? (
              <div
                className="table-empty product-status-table-placeholder"
                aria-busy="true"
                aria-label="Загрузка"
              />
            ) : (
              <div className="table-empty">Нет данных в таблице.</div>
            )}
            {tablePending ? (
              <div className="product-status-table-loading-overlay" aria-hidden="true" />
            ) : null}
            {activeSheet && !loading && activeSheet.rows.length === 0 && activeSheetReady ? (
              <div className="table-empty">На этом листе нет данных.</div>
            ) : null}
          </div>
        </div>
      </section>

      {enableHistory ? (
        <section className="table-section product-status-history-section">
          <div className="product-status-table-toolbar">
            <h3 className="product-status-history-title">История изменений</h3>
            <p className="table-meta">
              {activeSheet ? `Офис «${activeSheet.name}»` : 'Выберите офис'}
              {historyLoading ? ' · загрузка…' : ` · записей ${historyItems.length}`}
            </p>
          </div>
          <div className="table">
            <div className="table-scroll product-status-history-scroll">
              {historyItems.length > 0 ? (
                <table className="product-status-history-table">
                  <thead>
                    <tr>
                      <th>Когда</th>
                      <th>Действие</th>
                      <th>Поле</th>
                      <th>Было</th>
                      <th>Стало</th>
                      <th>Кто</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyItems.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.changedAt).toLocaleString('ru-RU')}</td>
                        <td>{entry.action}</td>
                        <td>{entry.fieldName ?? '—'}</td>
                        <td className="product-status-history-value">
                          {entry.oldValue ? displayCellText(entry.oldValue) : '—'}
                        </td>
                        <td className="product-status-history-value">
                          {entry.newValue ? displayCellText(entry.newValue) : '—'}
                        </td>
                        <td>{entry.changedBy ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="table-empty">
                  {historyLoading ? 'Загрузка истории…' : 'Изменений пока нет.'}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </RootTag>
  )
}
