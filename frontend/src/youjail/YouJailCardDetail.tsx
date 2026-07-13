import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { apiFetch, deleteJson, getJson, patchJson, postForm, postJson } from '../api'
import EmployeeCardModal from '../org/EmployeeCardModal'
import '../org/org.css'
import { notifyError, notifyProblem, notifySuccess } from '../toast'
import YouJailAssigneeSelect from './YouJailAssigneeSelect'
import YouJailMentionTextarea from './YouJailMentionTextarea'
import { handleMentionPreviewClick } from './mentionPreview'
import YouJailTagSelect from './YouJailTagSelect'
import YouJailZniField from './YouJailZniField'
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
        if (!window.confirm('Удалить карточку без возможности восстановления?')) return
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
        notifySuccess(updated.closedAt ? 'Карточка закрыта' : 'Карточка снова открыта')
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
        aria-label="Карточка"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="youjail-detail-header">
          <div className="youjail-detail-header-main">
            <p className="youjail-detail-kicker">
              <span>{card?.cardKey ?? '…'}</span>
              {card?.projectName ? <span className="youjail-detail-project">{card.projectName}</span> : null}
              {card?.pinned ? <span className="youjail-detail-badge is-pinned">Закреплена</span> : null}
              {card?.archived ? <span className="youjail-detail-badge is-archived">Архив</span> : null}
              {card?.closedAt ? <span className="youjail-detail-badge is-closed">Закрыта</span> : null}
            </p>
            {card ? (
              <input
                type="text"
                className="youjail-detail-title-input"
                value={card.title}
                disabled={saving}
                aria-label="Название карточки"
                onChange={(event) => setCard({ ...card, title: event.target.value })}
                onBlur={() => void saveCard({ title: card.title })}
              />
            ) : (
              <h2>Загрузка…</h2>
            )}
          </div>
          <div className="youjail-detail-header-actions">
            {saving ? <span className="youjail-saving-badge">Сохранение…</span> : null}
            <button type="button" className="youjail-detail-close" onClick={onClose} aria-label="Закрыть">
              ×
            </button>
          </div>
        </header>

        {loading || !card ? <div className="youjail-detail-loading">Загрузка карточки…</div> : null}

        {card ? (
          <div className="youjail-detail-body youjail-detail-body-single">
            <div className="youjail-detail-main">
              <section className="youjail-notes-card">
                <div className="youjail-notes-card-head">
                  <h3>Описание</h3>
                  <p className="youjail-muted">Пишите ниже — сверху сразу виден результат. Поддерживаются списки, **жирный**, `код`, @сотрудник.</p>
                </div>
                <div
                  className="youjail-notes-preview youjail-notes-preview-main"
                  dangerouslySetInnerHTML={{
                    __html:
                      previewHtml ||
                      '<p class="youjail-notes-empty">Пока пусто. Начните вводить текст в поле ниже.</p>',
                  }}
                  onClick={handlePreviewClick}
                />
                <YouJailMentionTextarea
                  className="youjail-notes-editor youjail-notes-editor-pane"
                  value={card.descriptionMd}
                  disabled={saving}
                  placeholder="Текст задачи, детали, чек-лист…"
                  onChange={(descriptionMd) => setCard({ ...card, descriptionMd })}
                  onBlur={() => void saveCard({ descriptionMd: card.descriptionMd })}
                />
              </section>

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

                <YouJailZniField
                  value={card.zniNumbers ?? ''}
                  linked={card.znis ?? []}
                  disabled={saving}
                  onChange={(zniNumbers) => setCard({ ...card, zniNumbers })}
                  onBlur={(zniNumbers) => void saveCard({ zniNumbers })}
                />

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
                  <span>Срок</span>
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
                    Прикрепить файл
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
                  <p className="youjail-muted youjail-empty-hint">Файлы можно прикрепить кнопкой выше</p>
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
                          className="btn-ghost youjail-attachment-remove"
                          aria-label={`Удалить ${attachment.filename}`}
                          onClick={() =>
                            void deleteJson(`/api/youjail/attachments/${attachment.id}`)
                              .then(() => {
                                notifySuccess('Вложение удалено')
                                return loadCard()
                              })
                              .catch((err) => notifyProblem(err, 'Не удалось удалить вложение'))
                          }
                        >
                          Удалить
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="youjail-detail-actions-section">
                <h3>Действия</h3>
                <div className="youjail-detail-actions">
                  <button
                    type="button"
                    className="youjail-action-btn"
                    disabled={runningAction !== null}
                    onClick={() => void runAction('pin')}
                  >
                    {card.pinned ? 'Открепить' : 'Закрепить'}
                  </button>
                  <button
                    type="button"
                    className="youjail-action-btn"
                    disabled={runningAction !== null}
                    onClick={() => void runAction('archive')}
                  >
                    {card.archived ? 'Вернуть из архива' : 'В архив'}
                  </button>
                  <button
                    type="button"
                    className="youjail-action-btn"
                    disabled={runningAction !== null}
                    onClick={() => void runAction('close')}
                  >
                    {card.closedAt ? 'Открыть снова' : 'Закрыть'}
                  </button>
                  <button
                    type="button"
                    className="youjail-action-btn youjail-action-btn-danger"
                    disabled={runningAction !== null}
                    onClick={() => void runAction('delete')}
                  >
                    Удалить
                  </button>
                </div>
              </section>

              <div className="youjail-meta youjail-meta-footer">
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
