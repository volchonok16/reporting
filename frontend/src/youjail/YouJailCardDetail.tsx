import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { apiFetch, deleteJson, getJson, patchJson, postForm, postJson } from '../api'
import EmployeeCardModal from '../org/EmployeeCardModal'
import '../org/org.css'
import { notifyError, notifyProblem, notifySuccess } from '../toast'
import YouJailAssigneeSelect from './YouJailAssigneeSelect'
import YouJailCardExecution from './YouJailCardExecution'
import YouJailMentionTextarea from './YouJailMentionTextarea'
import { handleMentionPreviewClick } from './mentionPreview'
import YouJailTagSelect from './YouJailTagSelect'
import { renderMarkdown } from './markdown'
import type {
  YouJailCard,
  YouJailProject,
  YouJailTag,
} from './types'

type YouJailCardDetailProps = {
  cardId: number | null
  projects: YouJailProject[]
  allTags: YouJailTag[]
  canManageOrg?: boolean
  onClose: () => void
  onUpdated: (card: YouJailCard) => void
  onDeleted: (cardId: number) => void
  onTagsCatalogUpdated?: (tags: YouJailTag[]) => void
}

function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromLocalInputValue(value: string): string | null {
  if (!value.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export default function YouJailCardDetail({
  cardId,
  projects,
  allTags,
  canManageOrg = false,
  onClose,
  onUpdated,
  onDeleted,
  onTagsCatalogUpdated,
}: YouJailCardDetailProps) {
  const [card, setCard] = useState<YouJailCard | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mentionEmployeeId, setMentionEmployeeId] = useState<number | null>(null)
  const [notesTab, setNotesTab] = useState<'edit' | 'preview'>('edit')
  const [runningAction, setRunningAction] = useState<string | null>(null)

  const loadCard = useCallback(async () => {
    if (cardId === null) return
    setLoading(true)
    try {
      const payload = await getJson<YouJailCard>(`/api/youjail/cards/${cardId}`)
      setCard(payload)
    } catch (err) {
      notifyError(err, 'Не удалось загрузить карточку')
      setCard(null)
    } finally {
      setLoading(false)
    }
  }, [cardId])

  const refreshCard = useCallback(async () => {
    if (cardId === null) return
    try {
      const payload = await getJson<YouJailCard>(`/api/youjail/cards/${cardId}`)
      setCard(payload)
      onUpdated(payload)
    } catch {
      // фоновый опрос во время выполнения
    }
  }, [cardId, onUpdated])

  useEffect(() => {
    void loadCard()
  }, [loadCard])

  useEffect(() => {
    if (!cardId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cardId, onClose])

  const previewHtml = useMemo(
    () => (card ? renderMarkdown(card.descriptionMd) : ''),
    [card?.descriptionMd, card],
  )

  const handlePreviewClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      handleMentionPreviewClick(event, setMentionEmployeeId)
    },
    [],
  )

  const saveCard = async (patch: Record<string, unknown>) => {
    if (!card) return
    setSaving(true)
    try {
      const updated = await patchJson<YouJailCard>(`/api/youjail/cards/${card.id}`, patch)
      setCard(updated)
      onUpdated(updated)
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: 'pin' | 'archive' | 'close' | 'delete') => {
    if (!card) return
    setRunningAction(action)
    try {
      if (action === 'delete') {
        if (!window.confirm('Удалить карточку?')) return
        await deleteJson(`/api/youjail/cards/${card.id}`)
        notifySuccess('Карточка удалена')
        onDeleted(card.id)
        onClose()
        return
      }
      const updated = await postJson<YouJailCard>(`/api/youjail/cards/${card.id}/${action}`, {})
      setCard(updated)
      onUpdated(updated)
      if (action === 'pin') {
        notifySuccess(updated.pinned ? 'Карточка закреплена' : 'Карточка откреплена')
      } else if (action === 'archive') {
        notifySuccess(updated.archived ? 'Карточка в архиве' : 'Карточка возвращена из архива')
      } else if (action === 'close') {
        notifySuccess(updated.closedAt ? 'Карточка закрыта' : 'Карточка открыта')
      }
    } catch (err) {
      notifyProblem(err, 'Операция не удалась')
    } finally {
      setRunningAction(null)
    }
  }

  const downloadAttachment = async (path: string, filename: string) => {
    const response = await apiFetch(path)
    if (!response.ok) {
      throw new Error('Не удалось скачать вложение')
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  const uploadAttachment = async (file: File) => {
    if (!card) return
    const formData = new FormData()
    formData.append('file', file)
    setRunningAction('upload')
    try {
      await postForm(`/api/youjail/cards/${card.id}/attachments`, formData)
      notifySuccess('Файл загружен')
      await loadCard()
    } catch (err) {
      notifyProblem(err, 'Не удалось загрузить файл')
    } finally {
      setRunningAction(null)
    }
  }

  if (cardId === null) return null

  return (
    <div className="youjail-detail-backdrop" onClick={onClose}>
      <aside
        className="youjail-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Карточка YouJail"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="youjail-detail-header">
          <div>
            <p className="youjail-detail-kicker">
              {card?.cardKey ?? 'YouJail'}
              {card?.projectName ? <span className="youjail-detail-project">{card.projectName}</span> : null}
            </p>
            <h2>{card?.title ?? 'Загрузка…'}</h2>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {loading || !card ? <div className="youjail-detail-loading">Загрузка карточки…</div> : null}

        {card ? (
          <div className="youjail-detail-body">
            <div className="youjail-detail-main">
              <label className="youjail-field">
                <span>Название</span>
                <input
                  type="text"
                  value={card.title}
                  disabled={saving}
                  onChange={(event) => setCard({ ...card, title: event.target.value })}
                  onBlur={() => void saveCard({ title: card.title })}
                />
              </label>

              <div className="youjail-notes">
                <div className="youjail-notes-tabs">
                  <button
                    type="button"
                    className={`youjail-notes-tab${notesTab === 'edit' ? ' is-active' : ''}`}
                    onClick={() => setNotesTab('edit')}
                  >
                    Заметки
                  </button>
                  <button
                    type="button"
                    className={`youjail-notes-tab${notesTab === 'preview' ? ' is-active' : ''}`}
                    onClick={() => setNotesTab('preview')}
                  >
                    Просмотр
                  </button>
                </div>
                {notesTab === 'edit' ? (
                  <>
                    <YouJailMentionTextarea
                      className="youjail-notes-editor"
                      value={card.descriptionMd}
                      disabled={saving}
                      placeholder="Markdown-заметки: списки, **жирный**, `код`, @сотрудник…"
                      onChange={(descriptionMd) => setCard({ ...card, descriptionMd })}
                      onBlur={() => void saveCard({ descriptionMd: card.descriptionMd })}
                    />
                    {card.descriptionMd.trim() ? (
                      <div className="youjail-notes-live-preview">
                        <p className="youjail-notes-live-preview-label">Как видят отметки:</p>
                        <div
                          className="youjail-notes-preview youjail-notes-preview-inline"
                          dangerouslySetInnerHTML={{ __html: previewHtml }}
                          onClick={handlePreviewClick}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div
                    className="youjail-notes-preview"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                    onClick={handlePreviewClick}
                  />
                )}
              </div>

              <div className="youjail-detail-grid">
                <label className="youjail-field youjail-field-full">
                  <span>Проект</span>
                  <select
                    value={card.projectId ?? ''}
                    disabled={saving}
                    onChange={(event) => {
                      const projectId = event.target.value ? Number(event.target.value) : null
                      const next = { ...card, projectId }
                      setCard(next)
                      void saveCard({ projectId })
                    }}
                  >
                    <option value="">Без проекта</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="youjail-field youjail-field-full">
                  <span>Теги</span>
                  <YouJailTagSelect
                    value={card.tags}
                    allTags={allTags}
                    disabled={saving}
                    onChange={(tags) => {
                      const next = { ...card, tags }
                      setCard(next)
                      void saveCard({ tagIds: tags.map((tag) => tag.id) })
                    }}
                    onTagsCatalogUpdated={onTagsCatalogUpdated}
                  />
                </label>

                <label className="youjail-field">
                  <span>Ответственный</span>
                  <YouJailAssigneeSelect
                    value={card.assigneeEmployeeId}
                    disabled={saving}
                    onChange={(assigneeEmployeeId) => {
                      const next = { ...card, assigneeEmployeeId }
                      setCard(next)
                      void saveCard({ assigneeEmployeeId })
                    }}
                  />
                </label>

                <label className="youjail-field">
                  <span>Запланировано</span>
                  <input
                    type="datetime-local"
                    value={toLocalInputValue(card.scheduledAt)}
                    disabled={saving}
                    onChange={(event) => {
                      const scheduledAt = fromLocalInputValue(event.target.value)
                      const next = { ...card, scheduledAt }
                      setCard(next)
                      void saveCard({ scheduledAt })
                    }}
                  />
                </label>
              </div>

              <section className="youjail-attachments">
                <div className="youjail-section-head">
                  <h3>Вложения</h3>
                  <label className="btn-secondary youjail-upload-btn">
                    + Файл
                    <input
                      type="file"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (file) void uploadAttachment(file)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                </div>
                {card.attachments.length === 0 ? (
                  <p className="youjail-muted">Вложений пока нет</p>
                ) : (
                  <ul className="youjail-attachment-list">
                    {card.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <button
                          type="button"
                          className="youjail-attachment-link"
                          onClick={() =>
                            void downloadAttachment(attachment.downloadUrl, attachment.filename).catch(
                              (err) => notifyProblem(err, 'Ошибка скачивания'),
                            )
                          }
                        >
                          {attachment.filename}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            void deleteJson(`/api/youjail/attachments/${attachment.id}`)
                              .then(() => {
                                notifySuccess('Вложение удалено')
                                return loadCard()
                              })
                              .catch((err) => notifyProblem(err, 'Не удалось удалить вложение'))
                          }
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="youjail-detail-side">
              <div className="youjail-detail-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('pin')}
                >
                  {card.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('archive')}
                >
                  {card.archived ? 'Вернуть' : 'В архив'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('close')}
                >
                  {card.closedAt ? 'Открыть' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  className="btn-ghost youjail-danger"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('delete')}
                >
                  Удалить
                </button>
              </div>

              <YouJailCardExecution card={card} disabled={saving} onRefreshCard={refreshCard} />

              <div className="youjail-meta">
                {card.assigneeName ? <p>Ответственный: {card.assigneeName}</p> : null}
                {card.createdBy ? <p>Автор: {card.createdBy}</p> : null}
                <p>Создана: {new Date(card.createdAt).toLocaleString('ru-RU')}</p>
                <p>Обновлена: {new Date(card.updatedAt).toLocaleString('ru-RU')}</p>
                {card.closedAt ? <p>Закрыта: {new Date(card.closedAt).toLocaleString('ru-RU')}</p> : null}
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      {mentionEmployeeId !== null ? (
        <EmployeeCardModal
          employeeId={mentionEmployeeId}
          canManage={canManageOrg}
          onClose={() => setMentionEmployeeId(null)}
          onOpenEmployee={setMentionEmployeeId}
        />
      ) : null}
    </div>
  )
}
