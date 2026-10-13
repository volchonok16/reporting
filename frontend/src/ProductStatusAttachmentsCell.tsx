import { useState } from 'react'
import { apiFetch, deleteJson, postForm } from './api'
import { notifyProblem, notifySuccess, notifyWarning } from './toast'
import type { ProductStatusAttachment } from './productStatusAttachments'

type ProductStatusAttachmentsCellProps = {
  apiBase: string
  sheetGid: string
  rowId: number | null
  attachments: ProductStatusAttachment[]
  readOnly: boolean
  disabled?: boolean
  onChange: (next: ProductStatusAttachment[]) => void
}

const MAX_BYTES = 50 * 1024 * 1024

async function downloadAttachment(path: string, filename: string) {
  const response = await apiFetch(path)
  if (!response.ok) throw new Error('Не удалось скачать вложение')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function ProductStatusAttachmentsCell({
  apiBase,
  sheetGid,
  rowId,
  attachments,
  readOnly,
  disabled = false,
  onChange,
}: ProductStatusAttachmentsCellProps) {
  const [busy, setBusy] = useState(false)
  const canEdit = !readOnly && !disabled && rowId != null && rowId > 0

  const upload = async (file: File) => {
    if (!canEdit || rowId == null) {
      notifyWarning('Сначала сохраните строку, затем прикрепите файл')
      return
    }
    if (file.size > MAX_BYTES) {
      notifyWarning('Файл слишком большой (макс. 50 МБ)')
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    setBusy(true)
    try {
      const created = await postForm<ProductStatusAttachment>(
        `${apiBase}/rows/${rowId}/attachments?gid=${encodeURIComponent(sheetGid)}`,
        formData,
      )
      onChange([...attachments, created])
      notifySuccess('Файл прикреплён')
    } catch (err) {
      notifyProblem(err, 'Не удалось загрузить файл')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (attachment: ProductStatusAttachment) => {
    if (!canEdit) return
    setBusy(true)
    try {
      await deleteJson(`${apiBase}/attachments/${attachment.id}`)
      onChange(attachments.filter((item) => item.id !== attachment.id))
      notifySuccess('Файл удалён')
    } catch (err) {
      notifyProblem(err, 'Не удалось удалить файл')
    } finally {
      setBusy(false)
    }
  }

  const emptyHint = readOnly
    ? '—'
    : rowId == null
      ? 'Сначала сохраните строку'
      : 'Нет файлов'

  return (
    <div className="product-status-attachments-cell">
      {attachments.length === 0 ? (
        <span className="product-status-attachments-empty">{emptyHint}</span>
      ) : (
        <ul className="product-status-attachments-list">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="product-status-attachment-chip">
              <button
                type="button"
                className="product-status-attachment-link"
                title={attachment.filename}
                disabled={busy}
                onClick={() =>
                  void downloadAttachment(attachment.downloadUrl, attachment.filename).catch((err) =>
                    notifyProblem(err, 'Ошибка скачивания'),
                  )
                }
              >
                <span className="product-status-attachment-icon" aria-hidden="true" />
                <span className="product-status-attachment-name">{attachment.filename}</span>
              </button>
              {canEdit ? (
                <button
                  type="button"
                  className="product-status-attachment-remove"
                  aria-label={`Удалить ${attachment.filename}`}
                  disabled={busy}
                  onClick={() => void remove(attachment)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <label className={`product-status-attachment-add${busy ? ' is-busy' : ''}`}>
          + Файл
          <input
            type="file"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
              event.currentTarget.value = ''
            }}
          />
        </label>
      ) : null}
    </div>
  )
}
