import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch, deleteJson, getJson, patchJson, postForm, postJson } from '../api'
import { renderMarkdown } from './markdown'
import type {
  YouJailCard,
  YouJailExecution,
  YouJailExecutor,
  YouJailProject,
  YouJailTaskType,
} from './types'
import { YOUJAIL_EXECUTORS } from './types'

type YouJailCardDetailProps = {
  cardId: number | null
  projects: YouJailProject[]
  taskTypes: YouJailTaskType[]
  onClose: () => void
  onUpdated: (card: YouJailCard) => void
  onDeleted: (cardId: number) => void
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
  taskTypes,
  onClose,
  onUpdated,
  onDeleted,
}: YouJailCardDetailProps) {
  const [card, setCard] = useState<YouJailCard | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notesTab, setNotesTab] = useState<'edit' | 'preview'>('edit')
  const [retryFeedback, setRetryFeedback] = useState('')
  const [execution, setExecution] = useState<YouJailExecution | null>(null)
  const [runningAction, setRunningAction] = useState<string | null>(null)

  const loadCard = useCallback(async () => {
    if (cardId === null) return
    setLoading(true)
    setError(null)
    try {
      const payload = await getJson<YouJailCard>(`/api/youjail/cards/${cardId}`)
      setCard(payload)
      setExecution(payload.latestExecution ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить карточку')
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

  useEffect(() => {
    if (!execution || execution.status === 'succeeded' || execution.status === 'failed') return
    const timer = window.setInterval(() => {
      void getJson<YouJailExecution>(`/api/youjail/executions/${execution.id}`)
        .then((payload) => {
          setExecution(payload)
          if (payload.status !== 'running') {
            void loadCard()
          }
        })
        .catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [execution, loadCard])

  const previewHtml = useMemo(
    () => (card ? renderMarkdown(card.descriptionMd) : ''),
    [card?.descriptionMd, card],
  )

  const saveCard = async (patch: Record<string, unknown>) => {
    if (!card) return
    setSaving(true)
    setError(null)
    try {
      const updated = await patchJson<YouJailCard>(`/api/youjail/cards/${card.id}`, patch)
      setCard(updated)
      onUpdated(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: 'execute' | 'retry' | 'pin' | 'archive' | 'close' | 'delete') => {
    if (!card) return
    setRunningAction(action)
    setError(null)
    try {
      if (action === 'delete') {
        if (!window.confirm('Удалить карточку?')) return
        await deleteJson(`/api/youjail/cards/${card.id}`)
        onDeleted(card.id)
        onClose()
        return
      }
      const endpoint =
        action === 'execute'
          ? `/api/youjail/cards/${card.id}/execute`
          : action === 'retry'
            ? `/api/youjail/cards/${card.id}/retry`
            : `/api/youjail/cards/${card.id}/${action}`
      const payload =
        action === 'retry'
          ? await postJson<YouJailExecution>(endpoint, { retryFeedback })
          : action === 'execute'
            ? await postJson<YouJailExecution>(endpoint, {})
            : await postJson<YouJailCard>(endpoint, {})
      if (action === 'execute' || action === 'retry') {
        setExecution(payload as YouJailExecution)
        void loadCard()
      } else {
        const updated = payload as YouJailCard
        setCard(updated)
        onUpdated(updated)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Операция не удалась')
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
    setError(null)
    try {
      await postForm(`/api/youjail/cards/${card.id}/attachments`, formData)
      await loadCard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл')
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
            <p className="youjail-detail-kicker">YouJail</p>
            <h2>{card?.title ?? 'Загрузка…'}</h2>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {error ? <div className="youjail-detail-error">{error}</div> : null}
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
                  <textarea
                    className="youjail-notes-editor"
                    value={card.descriptionMd}
                    disabled={saving}
                    placeholder="Markdown-заметки: списки, **жирный**, `код`, ссылки…"
                    onChange={(event) => setCard({ ...card, descriptionMd: event.target.value })}
                    onBlur={() => void saveCard({ descriptionMd: card.descriptionMd })}
                  />
                ) : (
                  <div
                    className="youjail-notes-preview"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
              </div>

              <div className="youjail-detail-grid">
                <label className="youjail-field">
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

                <label className="youjail-field">
                  <span>Тип</span>
                  <select
                    value={card.taskTypeId ?? ''}
                    disabled={saving}
                    onChange={(event) => {
                      const taskTypeId = event.target.value ? Number(event.target.value) : null
                      const next = { ...card, taskTypeId }
                      setCard(next)
                      void saveCard({ taskTypeId })
                    }}
                  >
                    <option value="">Без типа</option>
                    {taskTypes.map((taskType) => (
                      <option key={taskType.id} value={taskType.id}>
                        {taskType.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="youjail-field">
                  <span>Исполнитель</span>
                  <select
                    value={card.executor}
                    disabled={saving}
                    onChange={(event) => {
                      const executor = event.target.value as YouJailExecutor
                      const next = { ...card, executor }
                      setCard(next)
                      void saveCard({ executor })
                    }}
                  >
                    {YOUJAIL_EXECUTORS.map((executor) => (
                      <option key={executor} value={executor}>
                        {executor}
                      </option>
                    ))}
                  </select>
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
                              (err) => setError(err instanceof Error ? err.message : 'Ошибка скачивания'),
                            )
                          }
                        >
                          {attachment.filename}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => void deleteJson(`/api/youjail/attachments/${attachment.id}`).then(loadCard)}
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
                  className="btn-primary"
                  disabled={runningAction !== null || card.executionStatus === 'running'}
                  onClick={() => void runAction('execute')}
                >
                  {runningAction === 'execute' ? 'Запуск…' : 'Выполнить'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={runningAction !== null}
                  onClick={() => void runAction('retry')}
                >
                  Повторить
                </button>
                <button type="button" className="btn-ghost" onClick={() => void runAction('pin')}>
                  {card.pinned ? 'Открепить' : 'Закрепить'}
                </button>
                <button type="button" className="btn-ghost" onClick={() => void runAction('archive')}>
                  {card.archived ? 'Вернуть' : 'В архив'}
                </button>
                <button type="button" className="btn-ghost" onClick={() => void runAction('close')}>
                  {card.closedAt ? 'Открыть' : 'Закрыть'}
                </button>
                <button type="button" className="btn-ghost youjail-danger" onClick={() => void runAction('delete')}>
                  Удалить
                </button>
              </div>

              <label className="youjail-field">
                <span>Feedback для retry</span>
                <textarea
                  className="youjail-retry-feedback"
                  value={retryFeedback}
                  onChange={(event) => setRetryFeedback(event.target.value)}
                  placeholder="Что исправить при повторном запуске"
                />
              </label>

              <section className="youjail-meta">
                <p>
                  <strong>Статус:</strong> {card.executionStatus}
                </p>
                {card.worktreePath ? (
                  <p>
                    <strong>Worktree:</strong> <code>{card.worktreePath}</code>
                  </p>
                ) : null}
                {card.closedAt ? (
                  <p>
                    <strong>Закрыта:</strong> {new Date(card.closedAt).toLocaleString('ru-RU')}
                  </p>
                ) : null}
              </section>

              <section className="youjail-execution-log">
                <h3>Лог выполнения</h3>
                {!execution ? (
                  <p className="youjail-muted">Запусков пока не было</p>
                ) : (
                  <div className="youjail-log-stream">
                    {(execution.logs ?? []).map((line) => (
                      <div key={line.id} className={`youjail-log-line is-${line.stream}`}>
                        {line.content}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
