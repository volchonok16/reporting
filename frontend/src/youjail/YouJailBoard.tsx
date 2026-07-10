import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react'
import { getJson, postJson } from '../api'
import YouJailCardDetail from './YouJailCardDetail'
import YouJailProjectsPanel from './YouJailProjectsPanel'
import type { YouJailBoard, YouJailCard, YouJailColumn, YouJailProject } from './types'
import '../youjail.css'

type ArchivedFilter = 'false' | 'true' | 'all'

function cardsForColumn(cards: YouJailCard[], columnId: number): YouJailCard[] {
  return cards
    .filter((card) => card.columnId === columnId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
}

export default function YouJailBoard() {
  const [board, setBoard] = useState<YouJailBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState<ArchivedFilter>('false')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [draggedCardId, setDraggedCardId] = useState<number | null>(null)
  const [dropTargetColumnId, setDropTargetColumnId] = useState<number | null>(null)

  const loadBoard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ archived })
      if (search.trim()) params.set('search', search.trim())
      const payload = await getJson<YouJailBoard>(`/api/youjail/board?${params}`)
      setBoard(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить доску')
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [archived, search])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBoard()
    }, search ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [loadBoard, search])

  const totalCards = board?.cards.length ?? 0
  const columns = board?.columns ?? []

  const addCard = async (event: FormEvent) => {
    event.preventDefault()
    const title = draftTitle.trim()
    if (!title) return
    setError(null)
    try {
      await postJson<YouJailCard>('/api/youjail/cards', { title })
      setDraftTitle('')
      setShowCreateForm(false)
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать карточку')
    }
  }

  const moveCardToColumn = async (cardId: number, columnId: number) => {
    try {
      await postJson<YouJailCard>(`/api/youjail/cards/${cardId}/move`, { columnId })
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переместить карточку')
    }
  }

  const handleCardUpdated = (card: YouJailCard) => {
    setBoard((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((item) => (item.id === card.id ? card : item)),
          }
        : current,
    )
  }

  const handleCardDeleted = (cardId: number) => {
    setBoard((current) =>
      current
        ? {
            ...current,
            cards: current.cards.filter((item) => item.id !== cardId),
          }
        : current,
    )
    if (selectedCardId === cardId) setSelectedCardId(null)
  }

  const clearDragState = () => {
    setDraggedCardId(null)
    setDropTargetColumnId(null)
  }

  const handleCardDragStart = (event: DragEvent<HTMLElement>, cardId: number) => {
    event.dataTransfer.setData('text/plain', String(cardId))
    event.dataTransfer.effectAllowed = 'move'
    setDraggedCardId(cardId)
  }

  const handleColumnDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleColumnDrop = (event: DragEvent<HTMLDivElement>, column: YouJailColumn) => {
    event.preventDefault()
    const cardId = Number(event.dataTransfer.getData('text/plain'))
    if (cardId) void moveCardToColumn(cardId, column.id)
    clearDragState()
  }

  const columnCards = useMemo(() => {
    if (!board) return new Map<number, YouJailCard[]>()
    return new Map(board.columns.map((column) => [column.id, cardsForColumn(board.cards, column.id)]))
  }, [board])

  return (
    <div className="youjail-page">
      <div className="youjail-toolbar">
        <div className="youjail-toolbar-title">
          <h1>YouJail</h1>
          <p>Отдельная kanban-доска с заметками, проектами, исполнителями и логами запусков.</p>
        </div>
        <div className="youjail-toolbar-actions">
          <input
            type="search"
            className="youjail-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по названию и заметкам"
          />
          <select
            className="youjail-archived-filter"
            value={archived}
            onChange={(event) => setArchived(event.target.value as ArchivedFilter)}
          >
            <option value="false">Активные</option>
            <option value="true">Архив</option>
            <option value="all">Все</option>
          </select>
          <span className="youjail-count">{loading ? '…' : `${totalCards} карточек`}</span>
          <YouJailProjectsPanel
            onCreated={(project: YouJailProject) =>
              setBoard((current) =>
                current ? { ...current, projects: [...current.projects, project] } : current,
              )
            }
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowCreateForm((current) => !current)}
          >
            + Карточка
          </button>
        </div>
      </div>

      {showCreateForm ? (
        <form className="youjail-create-form" onSubmit={(event) => void addCard(event)}>
          <input
            type="text"
            className="youjail-create-input"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            placeholder="Название карточки"
            autoFocus
          />
          <button type="submit" className="btn-primary" disabled={!draftTitle.trim()}>
            Добавить в Backlog
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setShowCreateForm(false)
              setDraftTitle('')
            }}
          >
            Отмена
          </button>
        </form>
      ) : null}

      {error ? <div className="youjail-error">{error}</div> : null}

      <div className="youjail-board" aria-busy={loading}>
        {loading && !board ? <div className="youjail-loading">Загрузка доски…</div> : null}
        {columns.map((column) => {
          const cards = columnCards.get(column.id) ?? []
          const isDropTarget = dropTargetColumnId === column.id

          return (
            <section
              key={column.id}
              className={`youjail-column is-${column.tone}${isDropTarget ? ' is-drop-target' : ''}`}
              aria-label={`${column.title}, ${cards.length}`}
            >
              <header className="youjail-column-header">
                <h2>{column.title}</h2>
                <span className="youjail-column-count">{cards.length}</span>
              </header>
              <div
                className={`youjail-column-cards${isDropTarget ? ' is-drop-target' : ''}`}
                onDragOver={handleColumnDragOver}
                onDragEnter={() => setDropTargetColumnId(column.id)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDropTargetColumnId((current) => (current === column.id ? null : current))
                  }
                }}
                onDrop={(event) => handleColumnDrop(event, column)}
              >
                {cards.length === 0 && !isDropTarget ? (
                  <div className="youjail-column-empty">Перетащите карточку сюда</div>
                ) : null}
                {cards.map((card) => (
                  <article
                    key={card.id}
                    className={`youjail-card${draggedCardId === card.id ? ' is-dragging' : ''}${card.pinned ? ' is-pinned' : ''}`}
                    draggable
                    onDragStart={(event) => handleCardDragStart(event, card.id)}
                    onDragEnd={clearDragState}
                    onClick={() => setSelectedCardId(card.id)}
                  >
                    <div className="youjail-card-top">
                      {card.pinned ? <span className="youjail-pin" title="Закреплено">📌</span> : null}
                      {card.executionStatus === 'running' ? (
                        <span className="youjail-running-dot" title="Выполняется" />
                      ) : null}
                    </div>
                    <h3 className="youjail-card-title">{card.title}</h3>
                    {card.descriptionMd ? (
                      <p className="youjail-card-notes-preview">
                        {card.descriptionMd.split('\n').find((line) => line.trim()) ?? ''}
                      </p>
                    ) : null}
                    <div className="youjail-card-meta-row">
                      {card.projectName ? <span>{card.projectName}</span> : null}
                      {card.taskTypeName ? <span>{card.taskTypeName}</span> : null}
                      {card.executor ? <span>{card.executor}</span> : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <YouJailCardDetail
        cardId={selectedCardId}
        projects={board?.projects ?? []}
        taskTypes={board?.taskTypes ?? []}
        onClose={() => setSelectedCardId(null)}
        onUpdated={handleCardUpdated}
        onDeleted={handleCardDeleted}
      />
    </div>
  )
}
