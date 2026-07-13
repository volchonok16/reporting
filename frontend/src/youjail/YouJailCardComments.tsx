import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { apiFetch, patchJson, postForm } from '../api'
import { handleEmployeeMentionClick } from '../org/employeeMentionClick'
import OrgPhoto from '../org/OrgPhoto'
import { notifyProblem, notifySuccess, notifyWarning } from '../toast'
import { validateYouJailAttachment } from './limits'
import YouJailMentionTextarea from './YouJailMentionTextarea'
import { renderMarkdown } from './markdown'
import type { YouJailCardComment } from './types'

type YouJailCardCommentsProps = {
  cardId: number
  comments: YouJailCardComment[]
  disabled?: boolean
  canManageOrg?: boolean
  orgEmployeeId?: number | null
  onCommentAdded: () => void
  onMentionClick?: (employeeRef: string) => void
}

function formatCommentDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isCommentEdited(comment: YouJailCardComment): boolean {
  const created = Date.parse(comment.createdAt)
  const updated = Date.parse(comment.updatedAt)
  return !Number.isNaN(created) && !Number.isNaN(updated) && updated - created > 1000
}

function canEditComment(
  comment: YouJailCardComment,
  canManageOrg: boolean,
  orgEmployeeId: number | null | undefined,
): boolean {
  if (comment.canEdit) return true
  if (canManageOrg) return true
  return orgEmployeeId != null && comment.authorEmployeeId === orgEmployeeId
}

function YouJailAuthImage({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    void apiFetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error('Не удалось загрузить изображение')
        const blob = await response.blob()
        objectUrl = URL.createObjectURL(blob)
        if (!cancelled) setSrc(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  if (!src) {
    return <div className={`youjail-comment-image-placeholder${className ? ` ${className}` : ''}`} />
  }

  return <img src={src} alt={alt} className={className} loading="lazy" />
}

export default function YouJailCardComments({
  cardId,
  comments,
  disabled = false,
  canManageOrg = false,
  orgEmployeeId = null,
  onCommentAdded,
  onMentionClick,
}: YouJailCardCommentsProps) {
  const [bodyMd, setBodyMd] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null)
  const [editBodyMd, setEditBodyMd] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  const sortedComments = useMemo(
    () =>
      [...comments].sort((left, right) => {
        const leftTime = Date.parse(left.createdAt)
        const rightTime = Date.parse(right.createdAt)
        if (leftTime !== rightTime) return rightTime - leftTime
        return right.id - left.id
      }),
    [comments],
  )

  const filePreview = useMemo(
    () =>
      files.map((file) => ({
        file,
        isImage: file.type.startsWith('image/'),
        url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })),
    [files],
  )

  useEffect(() => {
    return () => {
      for (const item of filePreview) {
        if (item.url) URL.revokeObjectURL(item.url)
      }
    }
  }, [filePreview])

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    if (selected.length === 0) return
    for (const file of selected) {
      const validationError = validateYouJailAttachment(file)
      if (validationError) {
        notifyWarning(`${file.name}: ${validationError}`)
        event.target.value = ''
        return
      }
    }
    setFiles((current) => [...current, ...selected])
    event.target.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))
  }

  const downloadFile = async (path: string, filename: string) => {
    const response = await apiFetch(path)
    if (!response.ok) throw new Error('Не удалось скачать файл')
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  const submitComment = async () => {
    const text = bodyMd.trim()
    if (!text && files.length === 0) {
      notifyWarning('Введите текст или прикрепите файл')
      return
    }
    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('body_md', text)
      for (const file of files) {
        formData.append('files', file)
      }
      await postForm<YouJailCardComment>(`/api/youjail/cards/${cardId}/comments`, formData)
      setBodyMd('')
      setFiles([])
      notifySuccess('Комментарий добавлен')
      onCommentAdded()
    } catch (err) {
      notifyProblem(err, 'Не удалось отправить комментарий')
    } finally {
      setSubmitting(false)
    }
  }

  const startEdit = (comment: YouJailCardComment) => {
    setEditingCommentId(comment.id)
    setEditBodyMd(comment.bodyMd)
  }

  const cancelEdit = () => {
    setEditingCommentId(null)
    setEditBodyMd('')
  }

  const saveEdit = async (comment: YouJailCardComment) => {
    const text = editBodyMd.trim()
    if (!text && comment.attachments.length === 0) {
      notifyWarning('Комментарий не может быть пустым')
      return
    }
    setSavingEdit(true)
    try {
      await patchJson<YouJailCardComment>(`/api/youjail/comments/${comment.id}`, { bodyMd: text })
      cancelEdit()
      notifySuccess('Комментарий обновлён')
      onCommentAdded()
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить комментарий')
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <section className="youjail-comments-card">
      <div className="youjail-comments-head">
        <h3>Комментарии</h3>
        <p className="youjail-muted">Обсуждение задачи — можно прикреплять файлы и изображения.</p>
      </div>

      <div className="youjail-comment-compose">
        <YouJailMentionTextarea
          className="youjail-comment-editor"
          value={bodyMd}
          disabled={disabled || submitting}
          placeholder="Написать комментарий…"
          autoResize
          onChange={setBodyMd}
        />
        {filePreview.length > 0 ? (
          <ul className="youjail-comment-draft-files">
            {filePreview.map((item, index) => (
              <li key={`${item.file.name}-${index}`}>
                {item.isImage && item.url ? (
                  <img src={item.url} alt={item.file.name} className="youjail-comment-draft-thumb" />
                ) : (
                  <span className="youjail-comment-draft-name">{item.file.name}</span>
                )}
                <button
                  type="button"
                  className="btn-ghost youjail-comment-draft-remove"
                  aria-label={`Убрать ${item.file.name}`}
                  onClick={() => removeFile(index)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="youjail-comment-compose-actions">
          <label className="youjail-comment-attach-btn">
            <input
              type="file"
              multiple
              disabled={disabled || submitting}
              onChange={handleFilesChange}
            />
            Прикрепить
          </label>
          <button
            type="button"
            className="youjail-comment-submit"
            disabled={disabled || submitting || (!bodyMd.trim() && files.length === 0)}
            onClick={() => void submitComment()}
          >
            {submitting ? 'Отправка…' : 'Отправить'}
          </button>
        </div>
      </div>

      {sortedComments.length === 0 ? (
        <p className="youjail-muted youjail-empty-hint">Пока нет комментариев</p>
      ) : (
        <ul className="youjail-comment-list">
          {sortedComments.map((comment) => {
            const isEditing = editingCommentId === comment.id
            const edited = isCommentEdited(comment)
            const showEdit = canEditComment(comment, canManageOrg, orgEmployeeId)

            return (
            <li key={comment.id} className="youjail-comment-item">
              <div className="youjail-comment-meta">
                <OrgPhoto
                  url={comment.authorPhotoUrl}
                  name={comment.authorName ?? 'Пользователь'}
                  className="youjail-comment-photo"
                  placeholderClassName="youjail-comment-photo youjail-comment-photo--placeholder"
                />
                <div className="youjail-comment-meta-text">
                  <strong>{comment.authorName ?? 'Пользователь'}</strong>
                  <div className="youjail-comment-meta-line">
                    <time className="youjail-comment-time" dateTime={comment.createdAt}>
                      {formatCommentDate(comment.createdAt)}
                    </time>
                    {edited ? (
                      <span
                        className="youjail-comment-edited"
                        title={`Изменён ${formatCommentDate(comment.updatedAt)}`}
                      >
                        изменён
                      </span>
                    ) : null}
                    {showEdit && !isEditing ? (
                      <button
                        type="button"
                        className="btn-ghost youjail-comment-edit-btn"
                        disabled={disabled || savingEdit}
                        onClick={() => startEdit(comment)}
                      >
                        Редактировать
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
              {isEditing ? (
                <div className="youjail-comment-edit">
                  <YouJailMentionTextarea
                    className="youjail-comment-editor"
                    value={editBodyMd}
                    disabled={disabled || savingEdit}
                    placeholder="Текст комментария…"
                    autoResize
                    autoFocus
                    onChange={setEditBodyMd}
                  />
                  <div className="youjail-comment-edit-actions">
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={disabled || savingEdit}
                      onClick={cancelEdit}
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      className="youjail-comment-submit"
                      disabled={
                        disabled ||
                        savingEdit ||
                        (!editBodyMd.trim() && comment.attachments.length === 0)
                      }
                      onClick={() => void saveEdit(comment)}
                    >
                      {savingEdit ? 'Сохранение…' : 'Сохранить'}
                    </button>
                  </div>
                </div>
              ) : comment.bodyMd.trim() ? (
                <div
                  className="youjail-comment-body youjail-notes-preview"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.bodyMd) }}
                  onClick={(event) => {
                    if (onMentionClick) handleEmployeeMentionClick(event, onMentionClick)
                  }}
                />
              ) : null}
              {comment.attachments.length > 0 ? (
                <div className="youjail-comment-attachments">
                  {comment.attachments.map((attachment) =>
                    attachment.isImage ? (
                      <button
                        key={attachment.id}
                        type="button"
                        className="youjail-comment-image-btn"
                        onClick={() =>
                          void downloadFile(attachment.downloadUrl, attachment.filename).catch((err) =>
                            notifyProblem(err, 'Ошибка скачивания'),
                          )
                        }
                      >
                        <YouJailAuthImage
                          path={attachment.downloadUrl}
                          alt={attachment.filename}
                          className="youjail-comment-image"
                        />
                      </button>
                    ) : (
                      <button
                        key={attachment.id}
                        type="button"
                        className="youjail-comment-file"
                        onClick={() =>
                          void downloadFile(attachment.downloadUrl, attachment.filename).catch((err) =>
                            notifyProblem(err, 'Ошибка скачивания'),
                          )
                        }
                      >
                        {attachment.filename}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
