export const PRODUCT_STATUS_ATTACHMENTS_COLUMN = 'Вложения'
export const PRODUCT_STATUS_ATTACHMENTS_JSON_KEY = '__attachments'

export type ProductStatusAttachment = {
  id: number
  filename: string
  contentType?: string | null
  sizeBytes?: number
  uploadedBy?: string | null
  createdAt?: string | null
  downloadUrl: string
}

export function isAttachmentsColumn(column: string): boolean {
  return column.trim() === PRODUCT_STATUS_ATTACHMENTS_COLUMN
}

export function parseProductStatusAttachments(row: Record<string, string>): ProductStatusAttachment[] {
  const raw = row[PRODUCT_STATUS_ATTACHMENTS_JSON_KEY]
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = Number(record.id)
        const filename = typeof record.filename === 'string' ? record.filename : ''
        const downloadUrl = typeof record.downloadUrl === 'string' ? record.downloadUrl : ''
        if (!Number.isFinite(id) || id < 1 || !filename || !downloadUrl) return null
        return {
          id,
          filename,
          contentType: typeof record.contentType === 'string' ? record.contentType : null,
          sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
          uploadedBy: typeof record.uploadedBy === 'string' ? record.uploadedBy : null,
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
          downloadUrl,
        } satisfies ProductStatusAttachment
      })
      .filter((item): item is ProductStatusAttachment => item !== null)
  } catch {
    return []
  }
}

export function serializeProductStatusAttachments(items: ProductStatusAttachment[]): {
  text: string
  json: string
} {
  return {
    text: items.map((item) => item.filename).filter(Boolean).join(', '),
    json: JSON.stringify(items),
  }
}
