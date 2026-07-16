import { displayCellText, normalizeCellValue, splitCellWrapper } from './productStatusRichText'

export type EmbeddedTable = {
  rows: number
  cols: number
  cells: string[][]
}

export type EmbeddedTableDoc = {
  text: string
  table: EmbeddedTable
}

export const TABLE_TOKEN_PREFIX = '<<tablejson:'
export const TABLE_TOKEN_SUFFIX = '>>'

export function serializeEmbeddedTableDoc(doc: EmbeddedTableDoc): string {
  const payload = JSON.stringify({ text: doc.text, table: doc.table })
  return `${TABLE_TOKEN_PREFIX}${btoa(unescape(encodeURIComponent(payload)))}${TABLE_TOKEN_SUFFIX}`
}

export function parseEmbeddedTableDoc(value: string): EmbeddedTableDoc | null {
  const { inner } = splitCellWrapper(normalizeCellValue(value))
  if (!inner.startsWith(TABLE_TOKEN_PREFIX) || !inner.endsWith(TABLE_TOKEN_SUFFIX)) {
    return null
  }
  const encoded = inner.slice(TABLE_TOKEN_PREFIX.length, -TABLE_TOKEN_SUFFIX.length)
  try {
    const raw = decodeURIComponent(escape(atob(encoded)))
    const parsed = JSON.parse(raw) as EmbeddedTable | EmbeddedTableDoc
    const table = (parsed as EmbeddedTableDoc).table ?? (parsed as EmbeddedTable)
    const text = typeof (parsed as EmbeddedTableDoc).text === 'string' ? (parsed as EmbeddedTableDoc).text : ''
    if (!table || table.rows < 1 || table.cols < 1 || !Array.isArray(table.cells)) return null
    const cells = Array.from({ length: table.rows }, (_, row) =>
      Array.from({ length: table.cols }, (_, col) => table.cells[row]?.[col] ?? ''),
    )
    return { text, table: { rows: table.rows, cols: table.cols, cells } }
  } catch {
    return null
  }
}

export function createEmbeddedTable(rows: number, cols: number): EmbeddedTable {
  return {
    rows,
    cols,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
  }
}

export function serializeDocWithTable(doc: EmbeddedTableDoc): string {
  return serializeEmbeddedTableDoc(doc)
}

export function cloneEmbeddedTable(table: EmbeddedTable): EmbeddedTable {
  return {
    rows: table.rows,
    cols: table.cols,
    cells: table.cells.map((row) => [...row]),
  }
}

export function cloneEmbeddedTableDoc(doc: EmbeddedTableDoc): EmbeddedTableDoc {
  return {
    text: doc.text,
    table: cloneEmbeddedTable(doc.table),
  }
}

/** Только preamble — без строк таблицы. */
export function preambleFromCellValue(value: string): string {
  const embedded = parseEmbeddedTableDoc(value)
  if (embedded) return embedded.text
  return displayCellText(value)
}

function readPreambleFromHost(host: HTMLElement): string {
  const preambleEl = host.querySelector('.product-status-inline-table-preamble')
  if (preambleEl instanceof HTMLTextAreaElement) {
    return preambleEl.value
  }
  return preambleEl?.textContent ?? ''
}

export function readTableDocFromHost(host: HTMLElement, table: EmbeddedTable): EmbeddedTableDoc {
  const text = readPreambleFromHost(host)
  const nextCells: string[][] = []
  host.querySelectorAll('.product-status-inline-table tbody tr').forEach((rowElement) => {
    const row: string[] = []
    rowElement.querySelectorAll('.product-status-inline-table-cell').forEach((cellElement) => {
      row.push(cellElement.textContent ?? '')
    })
    if (row.length > 0) {
      nextCells.push(row)
    }
  })
  if (nextCells.length === 0) {
    return { text, table }
  }
  return {
    text,
    table: {
      rows: nextCells.length,
      cols: Math.max(...nextCells.map((row) => row.length), table.cols),
      cells: nextCells,
    },
  }
}

export function tableToTsv(table: EmbeddedTable): string {
  return table.cells.map((row) => row.join('\t')).join('\n')
}

export function extractEmbeddedTablePayload(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (parseEmbeddedTableDoc(trimmed)) return trimmed
  const start = trimmed.indexOf(TABLE_TOKEN_PREFIX)
  const end = trimmed.lastIndexOf(TABLE_TOKEN_SUFFIX)
  if (start < 0 || end <= start) return null
  const candidate = trimmed.slice(start, end + TABLE_TOKEN_SUFFIX.length)
  return parseEmbeddedTableDoc(candidate) ? candidate : null
}

/** Fallback, если браузер не дал доступ к системному буферу. */
let lastCopiedEmbeddedTable: string | null = null

export async function writeEmbeddedTableClipboard(serialized: string): Promise<boolean> {
  lastCopiedEmbeddedTable = serialized
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(serialized)
      return true
    }
  } catch {
    /* permission / insecure context */
  }
  return true
}

export async function readEmbeddedTableClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      const fromSystem = extractEmbeddedTablePayload(await navigator.clipboard.readText())
      if (fromSystem) {
        lastCopiedEmbeddedTable = fromSystem
        return fromSystem
      }
    }
  } catch {
    /* ignore */
  }
  return lastCopiedEmbeddedTable && parseEmbeddedTableDoc(lastCopiedEmbeddedTable)
    ? lastCopiedEmbeddedTable
    : null
}

export function setLastCopiedEmbeddedTable(serialized: string): void {
  lastCopiedEmbeddedTable = serialized
}

/**
 * Если preamble — точный дубль (ABC+ABC или ABC\\nABC), оставляем одну копию.
 * Защита на случай orphan-текста в contentEditable при вставке таблицы.
 */
export function collapseExactDuplicatePreamble(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ')
  const trimmed = normalized.replace(/^\n+|\n+$/g, '')
  if (trimmed.length < 2) return text

  if (trimmed.length % 2 === 0) {
    const half = trimmed.slice(0, trimmed.length / 2)
    if (half.length > 0 && half + half === trimmed) return half
  }

  const nl = trimmed.indexOf('\n')
  if (nl > 0) {
    const withoutBlank = trimmed.replace(/\n\n+/g, '\n')
    const parts = withoutBlank.split('\n')
    if (parts.length >= 2 && parts.length % 2 === 0) {
      const halfLen = parts.length / 2
      const first = parts.slice(0, halfLen).join('\n')
      const second = parts.slice(halfLen).join('\n')
      if (first && first === second) return first
    }
    const doubled = trimmed.match(/^([\s\S]+)\n\n?\1$/)
    if (doubled?.[1]) return doubled[1]
  }

  return text
}

/** Preamble из contentEditable (после commitPending) или из table-host. */
export function resolvePreambleForTableInsert(options: {
  tableDoc: EmbeddedTableDoc | null
  tableHost: HTMLElement | null
  serializedPlain: string
}): string {
  let preamble: string
  if (options.tableDoc && options.tableHost) {
    preamble = readTableDocFromHost(options.tableHost, options.tableDoc.table).text
  } else {
    const embedded = parseEmbeddedTableDoc(options.serializedPlain)
    preamble = embedded ? embedded.text : displayCellText(options.serializedPlain)
  }
  return collapseExactDuplicatePreamble(preamble)
}
