import type { ChangeRequest } from './zniTypes'

const BOARD_LABELS: Record<string, string> = {
  digital_streams_b2b: 'Digital',
  tele2_products: 'Продукты',
  reports: 'Reports',
  b2b_product_core: 'CORE',
  b2b_product_partners: 'КАТС',
  b2b_voice_products: 'Голосовые продукты',
  b2b_m2m_platform: 'М2М / IoT',
  b2b_sms_target: 'SMS',
  b2b_solar: 'Solar',
  b2b_umnico: 'Umnico',
  be_t2_team: 'Bercut',
  esb_analytics: 'ESB',
}

export function boardNameLabel(name?: string | null, code?: string | null): string {
  if (code && BOARD_LABELS[code]) return BOARD_LABELS[code]
  if (name && BOARD_LABELS[name]) return BOARD_LABELS[name]
  if (name === 'Digital Streams B2b') return 'Digital'
  if (name === 'BE Analytics') return 'Bercut'
  if (name === 'ESB Analytics') return 'ESB'
  return name || '—'
}

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}.${year}`
}

export function formatPlannedDate(item: ChangeRequest): string {
  if (item.plannedLabel) return item.plannedLabel
  return formatDate(item.plannedDate)
}

export function formatEctReservation(value?: boolean): string {
  return value ? 'ДА' : 'НЕТ'
}

export function businessGoalParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'))
        current = []
      }
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join('\n'))
  }
  return paragraphs.length > 0 ? paragraphs : [text]
}

export function customerNameParts(name?: string | null): string[] {
  if (!name?.trim()) return []
  return name.trim().split(/\s+/).slice(0, 3)
}
