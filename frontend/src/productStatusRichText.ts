export type HighlightSegment = {
  text: string
  highlighted: boolean
}

const HIGHLIGHT_PATTERN = /\$([^$]+)\$/g

export function splitHighlightSegments(value: string): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  let last = 0
  for (const match of value.matchAll(HIGHLIGHT_PATTERN)) {
    const start = match.index ?? 0
    if (start > last) {
      segments.push({ text: value.slice(last, start), highlighted: false })
    }
    segments.push({ text: match[1], highlighted: true })
    last = start + match[0].length
  }
  if (last < value.length) {
    segments.push({ text: value.slice(last), highlighted: false })
  }
  if (segments.length === 0) {
    segments.push({ text: value, highlighted: false })
  }
  return segments
}

export function displayCellText(value: string): string {
  return value.replace(HIGHLIGHT_PATTERN, '$1')
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
      if (text) {
        result += `$${text}$`
      }
      return
    }
    result += node.textContent ?? ''
  })
  return result
}
