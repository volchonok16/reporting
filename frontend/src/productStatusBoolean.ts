import {
  displayCellText,
  splitCellWrapper,
  splitStyleSegments,
} from './productStatusRichText'

/** Зелёная заливка «да» и красная «нет» — как в Google Sheets dropdown. */
export const BOOLEAN_YES_BG = 'C6EFCE'
export const BOOLEAN_NO_BG = 'F4CCCC'

export type BooleanColors = {
  yes: string
  no: string
}

function cellDisplayBackground(value: string): string | null {
  const { cellStyle, inner } = splitCellWrapper(value)
  if (cellStyle.bg) {
    return cellStyle.bg
  }
  const segments = splitStyleSegments(inner).filter((segment) => segment.text)
  if (segments.length === 1 && segments[0].bg && !segments[0].fg) {
    return segments[0].bg
  }
  return null
}

export function resolveBooleanColors(
  rows: Record<string, string>[],
  column: string,
): BooleanColors {
  let yes: string | null = null
  let no: string | null = null
  for (const row of rows) {
    const raw = (row[column] ?? '').trim()
    if (!raw) continue
    const text = displayCellText(raw).trim().toLowerCase()
    const bg = cellDisplayBackground(raw)
    if (!bg) continue
    if (text === 'да') {
      yes = yes ?? bg
    } else if (text === 'нет') {
      no = no ?? bg
    }
  }
  return {
    yes: yes ?? BOOLEAN_YES_BG,
    no: no ?? BOOLEAN_NO_BG,
  }
}

export function styledBooleanValue(checked: boolean, colors: BooleanColors): string {
  const text = checked ? 'да' : 'нет'
  const bg = checked ? colors.yes : colors.no
  return `<<cell:bg:${bg}>>${text}<<>>`
}

export function booleanCellBackground(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  return cellDisplayBackground(raw)
}
