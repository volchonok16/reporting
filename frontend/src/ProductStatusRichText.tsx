import type { CSSProperties } from 'react'
import {
  displayCellText,
  normalizeCellValue,
  normalizeTextSegment,
  PRODUCT_STATUS_ATTENTION_FG,
  splitCellWrapper,
  splitStyleSegments,
  type CellStyle,
  type TextStyleSegment,
} from './productStatusRichTextUtils'

type ProductStatusRichTextProps = {
  value: string
  empty?: string
}

function cellStyleToCss(cellStyle: CellStyle): CSSProperties | undefined {
  const style: CSSProperties = {}
  if (cellStyle.bg) {
    style.backgroundColor = `#${cellStyle.bg}`
  }
  if (cellStyle.border) {
    style.boxShadow = `inset 0 0 0 2px #${cellStyle.border}`
  }
  return cellStyle.bg || cellStyle.border ? style : undefined
}

function segmentHasStyle(segment: TextStyleSegment): boolean {
  return Boolean(
    segment.bg || segment.fg || segment.strike || segment.bold || segment.italic || segment.underline,
  )
}

function StyledSegment({ segment }: { segment: TextStyleSegment }) {
  const normalized = normalizeTextSegment(segment)
  if (!segmentHasStyle(normalized)) {
    return <>{normalized.text}</>
  }

  const classNames = ['product-status-highlight']
  const style: CSSProperties = {}
  const data: Record<string, string> = {}

  if (normalized.bg) {
    data['data-bg'] = normalized.bg
    style.backgroundColor = `#${normalized.bg}`
  } else {
    style.backgroundColor = 'transparent'
  }

  if (normalized.fg) {
    data['data-fg'] = normalized.fg
    const fg = normalized.fg.toUpperCase()
    if (fg === PRODUCT_STATUS_ATTENTION_FG || fg === 'FF0000' || fg === 'C00000') {
      classNames.push('product-status-fg-attention')
    } else {
      style.color = `#${normalized.fg}`
    }
  } else if (normalized.bg) {
    style.color = '#141414'
  }

  const decorations: string[] = []
  if (normalized.strike) {
    data['data-strike'] = '1'
    decorations.push('line-through')
  }
  if (normalized.underline) {
    data['data-underline'] = '1'
    decorations.push('underline')
  }
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ')
  }
  if (normalized.bold) {
    data['data-bold'] = '1'
    style.fontWeight = 600
  }
  if (normalized.italic) {
    data['data-italic'] = '1'
    style.fontStyle = 'italic'
  }

  return (
    <span className={classNames.join(' ')} style={style} {...data}>
      {normalized.text}
    </span>
  )
}

export default function ProductStatusRichText({
  value,
  empty = '—',
}: ProductStatusRichTextProps) {
  const normalizedValue = normalizeCellValue(value)
  const { cellStyle, inner } = splitCellWrapper(normalizedValue)
  if (!displayCellText(normalizedValue).trim()) {
    return <>{empty}</>
  }

  const segments = splitStyleSegments(inner)
  return (
    <span className="product-status-rich-text" style={cellStyleToCss(cellStyle)}>
      {segments.map((segment, index) =>
        segment.text ? <StyledSegment key={index} segment={segment} /> : null,
      )}
    </span>
  )
}
