export type HighlightSegment = {
  text: string
  color: string | null
}

const LEGACY_HIGHLIGHT_PATTERN = /\$([^$]+)\$/g
const COLOR_HIGHLIGHT_PATTERN = /\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}/g

export function splitHighlightSegments(value: string): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  const combined = /\$([^$]+)\$|\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}/g
  let last = 0
  for (const match of value.matchAll(combined)) {
    const start = match.index ?? 0
    if (start > last) {
      segments.push({ text: value.slice(last, start), color: null })
    }
    if (match[1] !== undefined) {
      segments.push({ text: match[1], color: 'FFFF00' })
    } else {
      segments.push({ text: match[3], color: match[2].toUpperCase() })
    }
    last = start + match[0].length
  }
  if (last < value.length) {
    segments.push({ text: value.slice(last), color: null })
  }
  if (segments.length === 0) {
    segments.push({ text: value, color: null })
  }
  return segments
}

export function displayCellText(value: string): string {
  return value
    .replace(LEGACY_HIGHLIGHT_PATTERN, '$1')
    .replace(COLOR_HIGHLIGHT_PATTERN, '$2')
}

export function serializeEditableCell(root: HTMLElement): string {
  let result = ''
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) {
      return
    }
    if (node.tagName === 'MARK') {
      const text = node.textContent ?? ''
      if (!text) {
        return
      }
      const color = (node.dataset.color ?? 'FFFF00').toUpperCase()
      if (color === 'FFFF00') {
        result += `$${text}$`
        return
      }
      result += `{{${color}:${text}}}`
      return
    }
    result += node.textContent ?? ''
  })
  return result
}
