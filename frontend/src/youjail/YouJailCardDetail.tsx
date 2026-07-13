import { useCallback, useEffect, useState } from 'react'
import { apiFetch, deleteJson, getJson, patchJson, postForm, postJson } from '../api'
import EmployeeCardModal from '../org/EmployeeCardModal'
import '../org/org.css'
import { notifyError, notifyProblem, notifySuccess, notifyWarning } from '../toast'
import { validateYouJailAttachment } from './limits'
import YouJailAssigneeSelect from './YouJailAssigneeSelect'
import YouJailCardComments from './YouJailCardComments'
import YouJailCardHistory from './YouJailCardHistory'
import YouJailCardLinksField from './YouJailCardLinksField'
import YouJailUnifiedNotesEditor from './YouJailUnifiedNotesEditor'
import YouJailTagSelect from './YouJailTagSelect'
import YouJailZniField from './YouJailZniField'
import type { YouJailCard, YouJailProject, YouJailTag } from './types'

type YouJailCardDetailProps = {
  cardId: number | null
  projects: YouJailProject[]
  allTags: YouJailTag[]
  canManageOrg?: boolean
  onClose: () => void
  onUpdated: (card: YouJailCard) => void
  onDeleted: (cardId: number) => void
  onOpenCard?: (cardId: number, boardId?: number) => void
  onTagsCatalogUpdated?: (tags: YouJailTag[]) => void
}

function toLocalDateValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromLocalDateValue(value: string): string | null {
  if (!value.trim()) return null
  const [yearRaw, monthRaw, dayRaw] = value.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  if (!year || !month || !day) return null
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
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
  onOpenCard,
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

  const applyCard = (updated: YouJailCard) => {
    setCard(updated)
    onUpdated(updated)
  }

  const saveCard = async (patch: Record<string, unknown>) => {
    if (!card) return
    setSaving(true)
    try {
      const updated = await patchJson<YouJailCard>(`/api/youjail/cards/${card.id}`, patch)
      applyCard(updated)
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
      applyCard(updated)
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
    if (!response.ok) throw new Error('Не удалось скачать вложение')
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
    const validationError = validateYouJailAttachment(file)
    if (validationError) {
      notifyWarning(validationError)
      return
    }
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
            {card ? (
              <div className="youjail-detail-header-menu">
                <button
                  type="button"
                  className="youjail-header-action"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('pin')}
                >
                  {card.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button
                  type="button"
                  className="youjail-header-action"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('archive')}
                >
                  {card.archived ? 'Из архива' : 'В архив'}
                </button>
                <button
                  type="button"
                  className="youjail-header-action"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('close')}
                >
                  {card.closedAt ? 'Открыть' : 'Закрыть'}
                </button>
                <button
                  type="button"
                  className="youjail-header-action is-danger"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('delete')}
                >
                  Удалить
                </button>
              </div>
            ) : null}
            {saving ? <span className="youjail-saving-badge">Сохранение…</span> : null}
            <button type="button" className="youjail-detail-close" onClick={onClose} aria-label="Закрыть">
              ×
            </button>
          </div>
        </header>

        {card ? (
          <section className="youjail-detail-quick-bar">
            <label className="youjail-quick-field youjail-quick-field-assignee">
              <span className="youjail-quick-label">Ответственный</span>
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

            <label className="youjail-quick-field youjail-quick-field-date">
              <span className="youjail-quick-label">Срок</span>
              <input
                type="date"
                className="youjail-quick-date"
                value={toLocalDateValue(card.scheduledAt)}
                disabled={saving}
                onChange={(event) => {
                  const scheduledAt = fromLocalDateValue(event.target.value)
                  const next = { ...card, scheduledAt }
                  setCard(next)
                  void saveCard({ scheduledAt })
                }}
              />
            </label>

            <div className="youjail-quick-field youjail-quick-field-attachments">
              <div className="youjail-quick-attachments-head">
                <span className="youjail-quick-label">Вложения</span>
                <label className="youjail-quick-attach-btn">
                  + Файл
                  <input
                    type="file"
                    hidden
                    disabled={runningAction === 'upload'}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void uploadAttachment(file)
                      event.currentTarget.value = ''
                    }}
                  />
                </label>
              </div>
              {card.attachments.length === 0 ? (
                <p className="youjail-quick-attachments-empty">Пока нет файлов</p>
              ) : (
                <ul className="youjail-quick-attachment-list">
                  {card.attachments.map((attachment) => (
                    <li key={attachment.id} className="youjail-quick-attachment-chip">
                      <button
                        type="button"
                        className="youjail-quick-attachment-link"
                        title={attachment.filename}
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
                        className="youjail-quick-attachment-remove"
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
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        {loading || !card ? <div className="youjail-detail-loading">Загрузка карточки…</div> : null}

        {card ? (
          <div className="youjail-detail-body">
            <div className="youjail-detail-main">
              <section className="youjail-notes-card">
                <div className="youjail-notes-card-head">
                  <h3>Описание</h3>
                  <p className="youjail-muted">
                    Нажмите на поле, чтобы редактировать. Поддерживаются списки, **жирный**, `код`, @сотрудник.
                  </p>
                </div>
                <YouJailUnifiedNotesEditor
                  value={card.descriptionMd}
                  disabled={saving}
                  placeholder="Текст задачи, детали, чек-лист…"
                  onChange={(descriptionMd) => setCard({ ...card, descriptionMd })}
                  onBlur={() => void saveCard({ descriptionMd: card.descriptionMd })}
                  onMentionClick={setMentionEmployeeId}
                />
              </section>

              <YouJailCardComments
                cardId={card.id}
                comments={card.comments ?? []}
                disabled={saving}
                onCommentAdded={() => void loadCard()}
              />

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
              </div>
            </div>

            <aside className="youjail-detail-side">
              <section className="youjail-side-card">
                <h3>Связи</h3>
                <YouJailZniField
                  value={card.zniNumbers ?? ''}
                  linked={card.znis ?? []}
                  disabled={saving}
                  onChange={(zniNumbers) => setCard({ ...card, zniNumbers })}
                  onBlur={(zniNumbers) => void saveCard({ zniNumbers })}
                />
                <YouJailCardLinksField
                  value={card.relatedCardKeys ?? ''}
                  relatedCards={card.relatedCards ?? []}
                  currentCardKey={card.cardKey}
                  disabled={saving}
                  onChange={(relatedCardKeys) => setCard({ ...card, relatedCardKeys })}
                  onBlur={(relatedCardKeys) => void saveCard({ relatedCardKeys })}
                  onOpenCard={onOpenCard}
                />
              </section>

              <YouJailCardHistory events={card.history ?? []} />
            </aside>
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
