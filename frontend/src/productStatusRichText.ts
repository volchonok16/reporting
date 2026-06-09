export type CellStyle = {
  bg: string | null
  border: string | null
}

export type TextStyleSegment = {
  text: string
  bg: string | null
  fg: string | null
  strike: boolean
  bold: boolean
  italic: boolean
}

export type HighlightSegment = TextStyleSegment

const CELL_WRAPPER_PATTERN = /^<<cell:([^>]+)>>(.*)<<>>$/s
const STYLE_SEGMENT_PATTERN =
  /\[\[((?:[^;\]]|;)+)::((?:[^\[]|\[(?!\[))*?)\]\]|\$([^$]+)\$|\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}/g

function parseStyleAttrs(raw: string): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {}
  for (const chunk of raw.split(';')) {
    const token = chunk.trim()
    if (!token) continue
    if (token === 'strike' || token === 's') parsed.strike = true
    else if (token === 'bold' || token === 'b') parsed.bold = true
    else if (token === 'italic' || token === 'i') parsed.italic = true
    else if (token.includes(':')) {
      const [key, value] = token.split(':', 2)
      parsed[key.trim()] = value.trim().toUpperCase()
    }
  }
  return parsed
}

export function splitCellWrapper(value: string): { cellStyle: CellStyle; inner: string } {
  const match = value.match(CELL_WRAPPER_PATTERN)
  if (!match) {
    return { cellStyle: { bg: null, border: null }, inner: value }
  }
  const attrs = parseStyleAttrs(match[1])
  return {
    cellStyle: {
      bg: typeof attrs.bg === 'string' ? attrs.bg : null,
      border: typeof attrs.border === 'string' ? attrs.border : null,
    },
    inner: match[2],
  }
}

export function splitHighlightSegments(value: string): TextStyleSegment[] {
  const { inner } = splitCellWrapper(value)
  return splitStyleSegments(inner)
}

export function splitStyleSegments(value: string): TextStyleSegment[] {
  const segments: TextStyleSegment[] = []
  let last = 0
  for (const match of value.matchAll(STYLE_SEGMENT_PATTERN)) {
    const start = match.index ?? 0
    if (start > last) {
      segments.push({
        text: value.slice(last, start),
        bg: null,
        fg: null,
        strike: false,
        bold: false,
        italic: false,
      })
    }
    if (match[1] !== undefined) {
      const attrs = parseStyleAttrs(match[1])
      segments.push({
        text: match[2],
        bg: typeof attrs.bg === 'string' ? attrs.bg : null,
        fg: typeof attrs.fg === 'string' ? attrs.fg : null,
        strike: Boolean(attrs.strike),
        bold: Boolean(attrs.bold),
        italic: Boolean(attrs.italic),
      })
    } else if (match[3] !== undefined) {
      segments.push({
        text: match[3],
        bg: 'FFFF00',
        fg: null,
        strike: false,
        bold: false,
        italic: false,
      })
    } else {
      segments.push({
        text: match[5],
        bg: match[4].toUpperCase(),
        fg: null,
        strike: false,
        bold: false,
        italic: false,
      })
    }
    last = start + match[0].length
  }
  if (last < value.length) {
    segments.push({
      text: value.slice(last),
      bg: null,
      fg: null,
      strike: false,
      bold: false,
      italic: false,
    })
  }
  if (segments.length === 0) {
    segments.push({
      text: value,
      bg: null,
      fg: null,
      strike: false,
      bold: false,
      italic: false,
    })
  }
  return segments
}

export function displayCellText(value: string): string {
  const { inner } = splitCellWrapper(value)
  return inner
    .replace(/\[\[(?:[^;\]]|;)+::((?:[^\[]|\[(?!\[))*?)\]\]/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\{\{[0-9A-Fa-f]{6}:([^}]*)\}\}/g, '$1')
}

function encodeStyleSegment(segment: TextStyleSegment): string {
  if (!segment.text) return ''
  if (
    segment.bg &&
    !segment.fg &&
    !segment.strike &&
    !segment.bold &&
    !segment.italic
  ) {
    if (segment.bg === 'FFFF00') return `$${segment.text}$`
    return `{{${segment.bg}:${segment.text}}}`
  }
  const parts: string[] = []
  if (segment.bg) parts.push(`bg:${segment.bg}`)
  if (segment.fg) parts.push(`fg:${segment.fg}`)
  if (segment.strike) parts.push('strike')
  if (segment.bold) parts.push('bold')
  if (segment.italic) parts.push('italic')
  if (parts.length === 0) return segment.text
  return `[[${parts.join(';')}::${segment.text}]]`
}

export function serializeEditableCell(root: HTMLElement, cellStyle: CellStyle): string {
  const segments: TextStyleSegment[] = []
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (text) {
        segments.push({
          text,
          bg: null,
          fg: null,
          strike: false,
          bold: false,
          italic: false,
        })
      }
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'MARK') {
      const text = node.textContent ?? ''
      if (!text) return
      segments.push({
        text,
        bg: node.dataset.bg?.toUpperCase() ?? null,
        fg: node.dataset.fg?.toUpperCase() ?? null,
        strike: node.dataset.strike === '1',
        bold: node.dataset.bold === '1',
        italic: node.dataset.italic === '1',
      })
    } else {
      const text = node.textContent ?? ''
      if (text) {
        segments.push({
          text,
          bg: null,
          fg: null,
          strike: false,
          bold: false,
          italic: false,
        })
      }
    }
  })
  const inner = segments.map(encodeStyleSegment).join('')
  if (!cellStyle.bg && !cellStyle.border) return inner
  const attrs: string[] = []
  if (cellStyle.bg) attrs.push(`bg:${cellStyle.bg}`)
  if (cellStyle.border) attrs.push(`border:${cellStyle.border}`)
  return `<<cell:${attrs.join(';')}>>${inner}<<>>`
}
