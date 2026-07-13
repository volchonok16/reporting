import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { deleteJson, getJson, patchJson, postJson } from '../api'
import OrgPhoto from '../org/OrgPhoto'
import YouJailCardDetail from './YouJailCardDetail'
import { mentionPreviewText } from './markdown'
import YouJailProjectsPanel from './YouJailProjectsPanel'
import type { YouJailBoard, YouJailBoardMeta, YouJailCard, YouJailColumn, YouJailProject } from './types'
import '../youjail.css'

const BOARD_STORAGE_KEY = 'youjail.activeBoardId'

type ArchivedFilter = 'false' | 'true' | 'all'

function cardsForColumn(cards: YouJailCard[], columnId: number): YouJailCard[] {
  return cards
    .filter((card) => card.columnId === columnId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
}

export default function YouJailBoard() {
  const [board, setBoard] = useState<YouJailBoard | null>(null)
  const [activeBoardId, setActiveBoardId] = useState<number | null>(() => {
    const saved = localStorage.getItem(BOARD_STORAGE_KEY)
    return saved ? Number(saved) : null
  })
  const [newBoardName, setNewBoardName] = useState('')
  const [showBoardForm, setShowBoardForm] = useState(false)
  const [newColumnTitle, setNewColumnTitle] = useState('')
  const [showColumnForm, setShowColumnForm] = useState(false)
  const [editingColumnId, setEditingColumnId] = useState<number | null>(null)
  const [editingColumnTitle, setEditingColumnTitle] = useState('')
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
      if (activeBoardId) params.set('boardId', String(activeBoardId))
      if (search.trim()) params.set('search', search.trim())
      const payload = await getJson<YouJailBoard>(`/api/youjail/board?${params}`)
      setBoard(payload)
      if (payload.board?.id) {
        setActiveBoardId(payload.board.id)
        localStorage.setItem(BOARD_STORAGE_KEY, String(payload.board.id))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить доску')
      setBoard(null)
    } finally {
      setLoading(false)
    }
  }, [activeBoardId, archived, search])

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
      await postJson<YouJailCard>('/api/youjail/cards', {
        title,
        boardId: activeBoardId ?? board?.board.id,
      })
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

  const createBoard = async (event: FormEvent) => {
    event.preventDefault()
    const name = newBoardName.trim()
    if (!name) return
    setError(null)
    try {
      const created = await postJson<YouJailBoardMeta>('/api/youjail/boards', { name })
      setNewBoardName('')
      setShowBoardForm(false)
      setActiveBoardId(created.id)
      localStorage.setItem(BOARD_STORAGE_KEY, String(created.id))
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать доску')
    }
  }

  const deleteBoard = async () => {
    const boardId = activeBoardId ?? board?.board.id
    if (!boardId || !board) return
    const cardCount = board.cards.length
    const message =
      cardCount > 0
        ? `Удалить доску «${board.board.name}» вместе с ${cardCount} карточками?`
        : `Удалить доску «${board.board.name}»?`
    if (!window.confirm(message)) return
    setError(null)
    try {
      await deleteJson(`/api/youjail/boards/${boardId}`)
      localStorage.removeItem(BOARD_STORAGE_KEY)
      setActiveBoardId(null)
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить доску')
    }
  }

  const createColumn = async (event: FormEvent) => {
    event.preventDefault()
    const title = newColumnTitle.trim()
    const boardId = activeBoardId ?? board?.board.id
    if (!title || !boardId) return
    setError(null)
    try {
      await postJson<YouJailColumn>(`/api/youjail/boards/${boardId}/columns`, { title })
      setNewColumnTitle('')
      setShowColumnForm(false)
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить колонку')
    }
  }

  const saveColumnTitle = async (columnId: number) => {
    const title = editingColumnTitle.trim()
    if (!title) return
    setError(null)
    try {
      await patchJson<YouJailColumn>(`/api/youjail/columns/${columnId}`, { title })
      setEditingColumnId(null)
      setEditingColumnTitle('')
      await loadBoard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переименовать колонку')
    }
  }

  const startColumnEdit = (column: YouJailColumn) => {
    setEditingColumnId(column.id)
    setEditingColumnTitle(column.title)
  }

  const handleColumnTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>, columnId: number) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveColumnTitle(columnId)
    }
    if (event.key === 'Escape') {
      setEditingColumnId(null)
      setEditingColumnTitle('')
    }
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
          <select
            className="youjail-board-select"
            value={activeBoardId ?? board?.board.id ?? ''}
            onChange={(event) => {
              const nextId = Number(event.target.value)
              setActiveBoardId(nextId)
              localStorage.setItem(BOARD_STORAGE_KEY, String(nextId))
            }}
          >
            {(board?.boards ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary" onClick={() => setShowBoardForm((current) => !current)}>
            + Доска
          </button>
          <button
            type="button"
            className="btn-ghost youjail-danger"
            disabled={!board || (board.boards?.length ?? 0) <= 1}
            onClick={() => void deleteBoard()}
          >
            Удалить доску
          </button>
          <button type="button" className="btn-secondary" onClick={() => setShowColumnForm((current) => !current)}>
            + Колонка
          </button>
          <input
            type="search"
            className="youjail-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Fuzzy-поиск (опечатки, часть слова)"
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

      {showBoardForm ? (
        <form className="youjail-create-form" onSubmit={(event) => void createBoard(event)}>
          <input
            type="text"
            className="youjail-create-input"
            value={newBoardName}
            onChange={(event) => setNewBoardName(event.target.value)}
            placeholder="Название новой доски"
            autoFocus
          />
          <button type="submit" className="btn-primary" disabled={!newBoardName.trim()}>
            Создать доску
          </button>
          <button type="button" className="btn-ghost" onClick={() => setShowBoardForm(false)}>
            Отмена
          </button>
        </form>
      ) : null}

      {showColumnForm ? (
        <form className="youjail-create-form" onSubmit={(event) => void createColumn(event)}>
          <input
            type="text"
            className="youjail-create-input"
            value={newColumnTitle}
            onChange={(event) => setNewColumnTitle(event.target.value)}
            placeholder="Название новой колонки"
            autoFocus
          />
          <button type="submit" className="btn-primary" disabled={!newColumnTitle.trim()}>
            Добавить колонку
          </button>
          <button type="button" className="btn-ghost" onClick={() => setShowColumnForm(false)}>
            Отмена
          </button>
        </form>
      ) : null}

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
                {editingColumnId === column.id ? (
                  <input
                    className="youjail-column-title-input"
                    value={editingColumnTitle}
                    autoFocus
                    onChange={(event) => setEditingColumnTitle(event.target.value)}
                    onBlur={() => void saveColumnTitle(column.id)}
                    onKeyDown={(event) => handleColumnTitleKeyDown(event, column.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="youjail-column-title-btn"
                    title="Переименовать колонку"
                    onClick={() => startColumnEdit(column)}
                  >
                    <h2>{column.title}</h2>
                  </button>
                )}
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
                        {mentionPreviewText(card.descriptionMd)}
                      </p>
                    ) : null}
                    <div className="youjail-card-meta-row">
                      {card.assigneeName ? (
                        <span className="youjail-card-assignee">
                          <OrgPhoto
                            url={card.assigneePhotoUrl}
                            name={card.assigneeName}
                            className="youjail-card-assignee-photo"
                            placeholderClassName="youjail-card-assignee-photo youjail-card-assignee-photo--placeholder"
                          />
                          {card.assigneeName}
                        </span>
                      ) : null}
                      {card.projectName ? <span>{card.projectName}</span> : null}
                      {card.taskTypeName ? <span>{card.taskTypeName}</span> : null}
                      {card.executor ? <span className="youjail-card-agent">{card.executor}</span> : null}
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
