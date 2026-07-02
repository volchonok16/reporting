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

/** Красный текста — тот же оттенок, что строка «Обратить внимание» (--attention-text). */
export const PRODUCT_STATUS_ATTENTION_FG = 'B91C1C'

/** Цвет текста без фоновой подсветки — как в Google Sheets и экспорте PPTX. */
export function normalizeTextSegment(segment: TextStyleSegment): TextStyleSegment {
  if (segment.fg && segment.bg) {
    return { ...segment, bg: null }
  }
  return segment
}

function isYellowHighlightHex(hex: string): boolean {
  const value = hex.toUpperCase()
  if (value === 'FFFF00' || value === 'FFF2CC' || value === 'FFE599') {
    return true
  }
  const red = parseInt(value.slice(0, 2), 16) / 255
  const green = parseInt(value.slice(2, 4), 16) / 255
  const blue = parseInt(value.slice(4, 6), 16) / 255
  return red >= 0.7 && green >= 0.65 && blue <= 0.85 && red + green > blue + 0.9
}

/** Убирает жёлтую заливку ячейки, если внутри есть цветной текст. */
export function normalizeCellValue(value: string): string {
  const { cellStyle, inner } = splitCellWrapper(value)
  const hasForeground = splitStyleSegments(inner).some((segment) => segment.fg)
  const bg = hasForeground && cellStyle.bg && isYellowHighlightHex(cellStyle.bg) ? null : cellStyle.bg
  if (!bg && !cellStyle.border) {
    return inner
  }
  const attrs: string[] = []
  if (bg) attrs.push(`bg:${bg}`)
  if (cellStyle.border) attrs.push(`border:${cellStyle.border}`)
  return `<<cell:${attrs.join(';')}>>${inner}<<>>`
}

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
      segments.push(
        normalizeTextSegment({
          text: match[2],
          bg: typeof attrs.bg === 'string' ? attrs.bg : null,
          fg: typeof attrs.fg === 'string' ? attrs.fg : null,
          strike: Boolean(attrs.strike),
          bold: Boolean(attrs.bold),
          italic: Boolean(attrs.italic),
        }),
      )
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
  const normalized = normalizeTextSegment(segment)
  if (!normalized.text) return ''
  if (
    normalized.bg &&
    !normalized.fg &&
    !normalized.strike &&
    !normalized.bold &&
    !normalized.italic
  ) {
    if (normalized.bg === 'FFFF00') return `$${normalized.text}$`
    return `{{${normalized.bg}:${normalized.text}}}`
  }
  const parts: string[] = []
  if (normalized.bg) parts.push(`bg:${normalized.bg}`)
  if (normalized.fg) parts.push(`fg:${normalized.fg}`)
  if (normalized.strike) parts.push('strike')
  if (normalized.bold) parts.push('bold')
  if (normalized.italic) parts.push('italic')
  if (parts.length === 0) return normalized.text
  return `[[${parts.join(';')}::${normalized.text}]]`
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
    if (node.classList.contains('product-status-highlight')) {
      const text = node.textContent ?? ''
      if (!text) return
      segments.push(
        normalizeTextSegment({
          text,
          bg: node.dataset.bg?.toUpperCase() ?? null,
          fg: node.dataset.fg?.toUpperCase() ?? null,
          strike: node.dataset.strike === '1',
          bold: node.dataset.bold === '1',
          italic: node.dataset.italic === '1',
        }),
      )
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

function readMarkStyle(node: HTMLElement): TextStyleSegment {
  return normalizeTextSegment({
    text: node.textContent ?? '',
    bg: node.dataset.bg?.toUpperCase() ?? null,
    fg: node.dataset.fg?.toUpperCase() ?? null,
    strike: node.dataset.strike === '1',
    bold: node.dataset.bold === '1',
    italic: node.dataset.italic === '1',
  })
}

function applyPatchToSegment(
  segment: TextStyleSegment,
  patch: Partial<TextStyleSegment>,
): TextStyleSegment {
  return {
    text: segment.text,
    bg: patch.bg !== undefined ? patch.bg : segment.bg,
    fg: patch.fg !== undefined ? patch.fg : segment.fg,
    strike: patch.strike !== undefined ? patch.strike : segment.strike,
    bold: patch.bold !== undefined ? patch.bold : segment.bold,
    italic: patch.italic !== undefined ? patch.italic : segment.italic,
  }
}

const STYLED_TEXT_TAG = 'SPAN'

function decorateStyledText(element: HTMLElement, segment: TextStyleSegment) {
  const normalized = normalizeTextSegment(segment)
  element.className = 'product-status-highlight'
  if (normalized.bg) {
    element.dataset.bg = normalized.bg
    element.style.backgroundColor = `#${normalized.bg}`
  } else {
    delete element.dataset.bg
    // span/mark без явного bg — без подсветки (не браузерный жёлтый <mark>)
    element.style.backgroundColor = 'transparent'
  }
  if (normalized.fg) {
    element.dataset.fg = normalized.fg
    element.classList.remove('product-status-fg-attention')
    const fg = normalized.fg.toUpperCase()
    if (fg === PRODUCT_STATUS_ATTENTION_FG || fg === 'FF0000' || fg === 'C00000') {
      element.classList.add('product-status-fg-attention')
      element.style.color = ''
    } else {
      element.style.color = `#${normalized.fg}`
    }
  } else {
    delete element.dataset.fg
    element.classList.remove('product-status-fg-attention')
    element.style.color = ''
  }
  if (normalized.strike) {
    element.dataset.strike = '1'
    element.style.textDecoration = 'line-through'
  } else {
    delete element.dataset.strike
    element.style.textDecoration = ''
  }
  if (normalized.bold) {
    element.dataset.bold = '1'
    element.style.fontWeight = '600'
  } else {
    delete element.dataset.bold
    element.style.fontWeight = ''
  }
  if (normalized.italic) {
    element.dataset.italic = '1'
    element.style.fontStyle = 'italic'
  } else {
    delete element.dataset.italic
    element.style.fontStyle = ''
  }
}

export function createStyledMark(segment: TextStyleSegment): HTMLElement {
  const normalized = normalizeTextSegment(segment)
  const element = document.createElement(STYLED_TEXT_TAG)
  element.textContent = normalized.text
  decorateStyledText(element, normalized)
  return element
}

export function applyStyleToSelection(root: HTMLElement, patch: Partial<TextStyleSegment>): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false
  }
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    return false
  }

  const styled = document.createElement(STYLED_TEXT_TAG)
  const current = readMarkStyle(styled)
  const next = applyPatchToSegment({ ...current, text: '' }, patch)
  decorateStyledText(styled, next)

  try {
    range.surroundContents(styled)
  } catch {
    const fragment = range.extractContents()
    styled.appendChild(fragment)
    range.insertNode(styled)
    const merged = applyPatchToSegment(readMarkStyle(styled), patch)
    decorateStyledText(styled, merged)
  }

  selection.removeAllRanges()
  return true
}

function readSegmentsFromRoot(root: HTMLElement): TextStyleSegment[] {
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
    if (node.classList.contains('product-status-highlight')) {
      const text = node.textContent ?? ''
      if (text) {
        segments.push(readMarkStyle(node))
      }
      return
    }
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
  })
  return segments
}

function renderSegmentsToRoot(root: HTMLElement, segments: TextStyleSegment[]) {
  root.replaceChildren()
  for (const segment of segments) {
    if (!segment.text) continue
    const normalized = normalizeTextSegment(segment)
    const hasStyle =
      normalized.bg || normalized.fg || normalized.strike || normalized.bold || normalized.italic
    if (!hasStyle) {
      root.append(document.createTextNode(normalized.text))
    } else {
      root.append(createStyledMark(normalized))
    }
  }
  if (!root.childNodes.length) {
    root.append(document.createTextNode(''))
  }
}

/** Применяет стиль к выделению или ко всему содержимому ячейки, если выделения нет. */
export function applyStyleToCellOrSelection(
  root: HTMLElement,
  patch: Partial<TextStyleSegment>,
): boolean {
  if (applyStyleToSelection(root, patch)) {
    return true
  }

  const segments = readSegmentsFromRoot(root)
  if (segments.length === 0) {
    const styled = applyPatchToSegment(
      { text: '\u00A0', bg: null, fg: null, strike: false, bold: false, italic: false },
      patch,
    )
    const hasStyle =
      styled.bg || styled.fg || styled.strike || styled.bold || styled.italic
    if (!hasStyle) {
      return false
    }
    root.replaceChildren(createStyledMark(styled))
    return true
  }

  renderSegmentsToRoot(
    root,
    segments.map((segment) => applyPatchToSegment(segment, patch)),
  )
  return true
}

export function clearFormattingInCell(root: HTMLElement): boolean {
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    if (root.contains(range.commonAncestorContainer)) {
      if (!selection.isCollapsed) {
        const text = range.toString()
        if (text) {
          range.deleteContents()
          range.insertNode(document.createTextNode(text))
          selection.removeAllRanges()
          return true
        }
      } else if (root.querySelector('.product-status-highlight')) {
        const plainText = root.textContent ?? ''
        root.replaceChildren(document.createTextNode(plainText))
        selection.removeAllRanges()
        return true
      }
    }
  }

  if (!root.querySelector('.product-status-highlight')) {
    return false
  }

  const plainText = root.textContent ?? ''
  root.replaceChildren(document.createTextNode(plainText))
  return true
}

/** @deprecated Use clearFormattingInCell */
export function clearFormattingInSelection(root: HTMLElement): boolean {
  return clearFormattingInCell(root)
}

export function applyCellStylePatch(value: string, patch: Partial<CellStyle>): string {
  const { cellStyle, inner } = splitCellWrapper(value)
  const nextStyle: CellStyle = {
    bg: patch.bg !== undefined ? patch.bg : cellStyle.bg,
    border: patch.border !== undefined ? patch.border : cellStyle.border,
  }
  if (!nextStyle.bg && !nextStyle.border) {
    return inner
  }
  const attrs: string[] = []
  if (nextStyle.bg) attrs.push(`bg:${nextStyle.bg}`)
  if (nextStyle.border) attrs.push(`border:${nextStyle.border}`)
  return `<<cell:${attrs.join(';')}>>${inner}<<>>`
}

export function wrapCellValue(inner: string, cellStyle: CellStyle): string {
  return serializeEditableCell(
    (() => {
      const root = document.createElement('div')
      for (const segment of splitStyleSegments(inner)) {
        if (!segment.text) continue
        const hasStyle =
          segment.bg || segment.fg || segment.strike || segment.bold || segment.italic
        if (!hasStyle) {
          root.append(document.createTextNode(segment.text))
        } else {
          root.append(createStyledMark(segment))
        }
      }
      return root
    })(),
    cellStyle,
  )
}
