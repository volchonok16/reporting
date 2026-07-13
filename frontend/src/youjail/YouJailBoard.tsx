import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { deleteJson, getJson, patchJson, postJson } from '../api'
import { notifyError, notifyProblem, notifySuccess, notifyWarning } from '../toast'
import OrgPhoto from '../org/OrgPhoto'
import YouJailBoardAccessPanel from './YouJailBoardAccessPanel'
import YouJailCardDetail from './YouJailCardDetail'
import { mentionPreviewText } from './markdown'
import YouJailProjectsPanel from './YouJailProjectsPanel'
import YouJailTeamsPanel from './YouJailTeamsPanel'
import type { YouJailBoard, YouJailBoardMeta, YouJailCard, YouJailColumn, YouJailProject } from './types'
import '../youjail.css'

const BOARD_STORAGE_KEY = 'youjail.activeBoardId'

const COLUMN_TONES = [
  { value: 'backlog', label: 'Новые' },
  { value: 'progress', label: 'В работе' },
  { value: 'blocked', label: 'Заблокировано' },
  { value: 'done', label: 'Готово' },
  { value: 'custom', label: 'Своя' },
] as const

type ArchivedFilter = 'false' | 'true' | 'all'
type ColumnDropPosition = 'before' | 'after'

function cardsForColumn(cards: YouJailCard[], columnId: number): YouJailCard[] {
  return cards
    .filter((card) => card.columnId === columnId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
}

function defaultMoveTargetId(columns: YouJailColumn[], excludeColumnId: number): number | null {
  const others = columns.filter((column) => column.id !== excludeColumnId)
  const backlog = others.find((column) => column.columnKey === 'backlog')
  return backlog?.id ?? others[0]?.id ?? null
}

type YouJailBoardProps = {
  canManageOrg?: boolean
}

export default function YouJailBoard({ canManageOrg = false }: YouJailBoardProps) {
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
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState<ArchivedFilter>('false')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const [draggedCardId, setDraggedCardId] = useState<number | null>(null)
  const [dropTargetColumnId, setDropTargetColumnId] = useState<number | null>(null)
  const [boardEditMode, setBoardEditMode] = useState(false)
  const [draggedColumnId, setDraggedColumnId] = useState<number | null>(null)
  const [columnDropTarget, setColumnDropTarget] = useState<{
    columnId: number
    position: ColumnDropPosition
  } | null>(null)
  const [columnPendingDelete, setColumnPendingDelete] = useState<YouJailColumn | null>(null)
  const [deleteMoveTargetId, setDeleteMoveTargetId] = useState<number | null>(null)
  const [deletingColumn, setDeletingColumn] = useState(false)
  const [inlineNewColumnTitle, setInlineNewColumnTitle] = useState('')
  const cardWasDraggedRef = useRef(false)

  const loadBoard = useCallback(async () => {
    setLoading(true)
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
      notifyError(err, 'Не удалось загрузить доску')
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
  const canManageBoard = Boolean(board?.board.canManage)

  const addCard = async (event: FormEvent) => {
    event.preventDefault()
    const title = draftTitle.trim()
    if (!title) return
    try {
      await postJson<YouJailCard>('/api/youjail/cards', {
        title,
        boardId: activeBoardId ?? board?.board.id,
      })
      setDraftTitle('')
      setShowCreateForm(false)
      notifySuccess('Карточка создана')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось создать карточку')
    }
  }

  const moveCardToColumn = async (cardId: number, columnId: number) => {
    try {
      await postJson<YouJailCard>(`/api/youjail/cards/${cardId}/move`, { columnId })
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось переместить карточку')
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

  const clearColumnDragState = () => {
    setDraggedColumnId(null)
    setColumnDropTarget(null)
  }

  const reorderColumns = (draggedId: number, targetId: number, position: ColumnDropPosition) => {
    if (!board || draggedId === targetId) return null
    const current = [...board.columns]
    const fromIndex = current.findIndex((column) => column.id === draggedId)
    const targetIndex = current.findIndex((column) => column.id === targetId)
    if (fromIndex < 0 || targetIndex < 0) return null

    const [moved] = current.splice(fromIndex, 1)
    let insertIndex = targetIndex
    if (fromIndex < targetIndex) insertIndex -= 1
    if (position === 'after') insertIndex += 1
    current.splice(insertIndex, 0, moved)
    return current.map((column, index) => ({ ...column, sortOrder: index + 1 }))
  }

  const persistColumnOrder = async (nextColumns: YouJailColumn[]) => {
    setBoard((current) => (current ? { ...current, columns: nextColumns } : current))
    try {
      await Promise.all(
        nextColumns.map((column) =>
          patchJson<YouJailColumn>(`/api/youjail/columns/${column.id}`, { sortOrder: column.sortOrder }),
        ),
      )
    } catch (err) {
      notifyProblem(err, 'Не удалось изменить порядок колонок')
      await loadBoard()
    }
  }

  const handleCardDragStart = (event: DragEvent<HTMLElement>, cardId: number) => {
    if (boardEditMode) {
      event.preventDefault()
      return
    }
    cardWasDraggedRef.current = false
    event.dataTransfer.setData('text/plain', String(cardId))
    event.dataTransfer.effectAllowed = 'move'
    if (event.dataTransfer.setDragImage) {
      const target = event.currentTarget
      event.dataTransfer.setDragImage(target, Math.min(24, target.clientWidth / 2), 16)
    }
    setDraggedCardId(cardId)
    window.requestAnimationFrame(() => {
      cardWasDraggedRef.current = true
    })
  }

  const handleColumnDragOver = (event: DragEvent<HTMLElement>, column: YouJailColumn) => {
    event.preventDefault()
    if (boardEditMode && draggedColumnId !== null) {
      event.dataTransfer.dropEffect = 'move'
      if (draggedColumnId === column.id) {
        setColumnDropTarget(null)
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const position: ColumnDropPosition =
        event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      setColumnDropTarget({ columnId: column.id, position })
      return
    }
    if (!boardEditMode && draggedCardId !== null) {
      event.dataTransfer.dropEffect = 'move'
      setDropTargetColumnId(column.id)
    }
  }

  const handleColumnDragLeave = (event: DragEvent<HTMLElement>, columnId: number) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
      setDropTargetColumnId((current) => (current === columnId ? null : current))
      setColumnDropTarget((current) => (current?.columnId === columnId ? null : current))
    }
  }

  const handleColumnDrop = (event: DragEvent<HTMLElement>, column: YouJailColumn) => {
    event.preventDefault()
    if (boardEditMode && draggedColumnId !== null) {
      const position = columnDropTarget?.columnId === column.id ? columnDropTarget.position : 'after'
      const nextColumns = reorderColumns(draggedColumnId, column.id, position)
      if (nextColumns) void persistColumnOrder(nextColumns)
      clearColumnDragState()
      return
    }

    const cardId = Number(event.dataTransfer.getData('text/plain'))
    if (cardId) void moveCardToColumn(cardId, column.id)
    clearDragState()
  }

  const handleColumnDragStart = (event: DragEvent<HTMLButtonElement>, columnId: number) => {
    event.stopPropagation()
    event.dataTransfer.setData('application/x-youjail-column', String(columnId))
    event.dataTransfer.effectAllowed = 'move'
    setDraggedColumnId(columnId)
  }

  const handleColumnDragEnd = () => {
    clearColumnDragState()
  }

  const createBoard = async (event: FormEvent) => {
    event.preventDefault()
    const name = newBoardName.trim()
    if (!name) return
    try {
      const created = await postJson<YouJailBoardMeta>('/api/youjail/boards', { name })
      setNewBoardName('')
      setShowBoardForm(false)
      setActiveBoardId(created.id)
      localStorage.setItem(BOARD_STORAGE_KEY, String(created.id))
      notifySuccess('Доска создана')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось создать доску')
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
    try {
      await deleteJson(`/api/youjail/boards/${boardId}`)
      localStorage.removeItem(BOARD_STORAGE_KEY)
      setActiveBoardId(null)
      notifySuccess('Доска удалена')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось удалить доску')
    }
  }

  const createColumn = async (event: FormEvent, titleOverride?: string) => {
    event.preventDefault()
    const title = (titleOverride ?? newColumnTitle).trim()
    const boardId = activeBoardId ?? board?.board.id
    if (!title || !boardId) return
    try {
      await postJson<YouJailColumn>(`/api/youjail/boards/${boardId}/columns`, { title })
      setNewColumnTitle('')
      setInlineNewColumnTitle('')
      setShowColumnForm(false)
      notifySuccess('Колонка добавлена')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось добавить колонку')
    }
  }

  const requestDeleteColumn = (column: YouJailColumn, cardCount: number) => {
    if (columns.length <= 1) {
      notifyWarning('Нельзя удалить последнюю колонку на доске')
      return
    }
    if (cardCount === 0) {
      if (!window.confirm(`Удалить колонку «${column.title}»?`)) return
      void confirmDeleteColumn(column.id, null)
      return
    }
    setColumnPendingDelete(column)
    setDeleteMoveTargetId(defaultMoveTargetId(columns, column.id))
  }

  const confirmDeleteColumn = async (columnId: number, moveToColumnId: number | null) => {
    setDeletingColumn(true)
    try {
      const query = moveToColumnId ? `?moveToColumnId=${moveToColumnId}` : ''
      await deleteJson(`/api/youjail/columns/${columnId}${query}`)
      setColumnPendingDelete(null)
      setDeleteMoveTargetId(null)
      if (editingColumnId === columnId) {
        setEditingColumnId(null)
        setEditingColumnTitle('')
      }
      notifySuccess('Колонка удалена')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось удалить колонку')
    } finally {
      setDeletingColumn(false)
    }
  }

  const cancelColumnDelete = () => {
    if (deletingColumn) return
    setColumnPendingDelete(null)
    setDeleteMoveTargetId(null)
  }

  const saveColumnTitle = async (columnId: number) => {
    const title = editingColumnTitle.trim()
    if (!title) return
    try {
      await patchJson<YouJailColumn>(`/api/youjail/columns/${columnId}`, { title })
      setEditingColumnId(null)
      setEditingColumnTitle('')
      notifySuccess('Колонка переименована')
      await loadBoard()
    } catch (err) {
      notifyProblem(err, 'Не удалось переименовать колонку')
    }
  }

  const saveColumnTone = async (columnId: number, tone: string) => {
    try {
      const updated = await patchJson<YouJailColumn>(`/api/youjail/columns/${columnId}`, { tone })
      setBoard((current) =>
        current
          ? {
              ...current,
              columns: current.columns.map((column) => (column.id === columnId ? updated : column)),
            }
          : current,
      )
    } catch (err) {
      notifyProblem(err, 'Не удалось изменить цвет колонки')
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

  const boardTeams = board?.board.teams ?? []
  const isPersonalBoard = Boolean(board?.board.isPersonal)

  return (
    <div className="youjail-page">
      <div className="youjail-toolbar">
        <div className="youjail-toolbar-title">
          <h1>{board?.board.name ?? 'YouJail'}</h1>
          <div className="youjail-board-teams-row">
            {isPersonalBoard ? (
              <span className="youjail-board-team-chip is-personal">Личная доска</span>
            ) : (
              <>
                <span className="youjail-board-teams-label">Команды:</span>
                {boardTeams.length > 0 ? (
                  boardTeams.map((team) => (
                    <span key={team.id} className="youjail-board-team-chip">
                      {team.name}
                    </span>
                  ))
                ) : (
                  <span className="youjail-board-team-chip is-muted">только админы</span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="youjail-toolbar-actions">
          <div className="youjail-toolbar-group youjail-toolbar-group-board">
            <label className="youjail-toolbar-field">
              <span className="youjail-sr-only">Доска</span>
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
                    {item.isPersonal ? `${item.name} · личная` : item.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="youjail-count-badge" title="Карточек на доске">
              {loading ? '…' : totalCards}
            </span>
          </div>

          <div className="youjail-toolbar-group">
            <input
              type="search"
              className="youjail-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Поиск по карточкам…"
              aria-label="Поиск по карточкам"
            />
            <select
              className="youjail-archived-filter"
              value={archived}
              onChange={(event) => setArchived(event.target.value as ArchivedFilter)}
              aria-label="Показать карточки"
            >
              <option value="false">Активные</option>
              <option value="true">Архив</option>
              <option value="all">Все</option>
            </select>
          </div>

          <button
            type="button"
            className="btn-primary youjail-btn-add-card"
            onClick={() => setShowCreateForm((current) => !current)}
          >
            + Карточка
          </button>

          {canManageBoard ? (
            <div className="youjail-toolbar-group youjail-toolbar-group-manage">
              <button
                type="button"
                className={`youjail-columns-btn${boardEditMode ? ' is-active' : ''}`}
                onClick={() => {
                  setBoardEditMode((current) => {
                    if (current) {
                      setEditingColumnId(null)
                      setEditingColumnTitle('')
                      setShowColumnForm(false)
                      cancelColumnDelete()
                      clearColumnDragState()
                    }
                    return !current
                  })
                }}
              >
                {boardEditMode ? 'Готово' : 'Колонки'}
              </button>
              {!boardEditMode ? (
                <button type="button" className="btn-secondary" onClick={() => setShowColumnForm((current) => !current)}>
                  + Колонка
                </button>
              ) : null}
              {board ? (
                <YouJailBoardAccessPanel
                  board={board.board}
                  onUpdated={(updatedBoard) =>
                    setBoard((current) =>
                      current
                        ? {
                            ...current,
                            board: updatedBoard,
                            boards: current.boards.map((item) =>
                              item.id === updatedBoard.id ? updatedBoard : item,
                            ),
                          }
                        : current,
                    )
                  }
                />
              ) : null}
            </div>
          ) : null}

          {canManageOrg ? (
            <div className="youjail-toolbar-group youjail-toolbar-group-admin">
              <button type="button" className="btn-secondary" onClick={() => setShowBoardForm((current) => !current)}>
                + Доска
              </button>
              <YouJailProjectsPanel
                projects={board?.projects ?? []}
                onCreated={(project: YouJailProject) =>
                  setBoard((current) =>
                    current ? { ...current, projects: [...current.projects, project] } : current,
                  )
                }
                onUpdated={(project: YouJailProject) =>
                  setBoard((current) =>
                    current
                      ? {
                          ...current,
                          projects: current.projects.map((item) => (item.id === project.id ? project : item)),
                        }
                      : current,
                  )
                }
              />
              <YouJailTeamsPanel
                canManageOrg={canManageOrg}
                activeBoard={board?.board ?? null}
                onBoardTeamsUpdated={(updatedBoard) =>
                  setBoard((current) =>
                    current
                      ? {
                          ...current,
                          board: updatedBoard,
                          boards: current.boards.map((item) =>
                            item.id === updatedBoard.id ? updatedBoard : item,
                          ),
                        }
                      : current,
                  )
                }
              />
              <button
                type="button"
                className="btn-ghost youjail-danger"
                disabled={!board || (board.boards?.length ?? 0) <= 1 || isPersonalBoard}
                onClick={() => void deleteBoard()}
              >
                Удалить доску
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {!boardEditMode && board && !loading ? (
        <p className="youjail-page-hint">
          Нажмите на карточку, чтобы открыть. Перетащите карточку в другую колонку, чтобы изменить статус.
        </p>
      ) : null}

      {canManageOrg && showBoardForm ? (
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

      {canManageBoard && showColumnForm ? (
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

      {boardEditMode ? (
        <div className="youjail-edit-banner" role="status">
          <div className="youjail-edit-banner-main">
            <strong>Редактирование колонок</strong>
            <span>
              Перетащите ⋮⋮ для порядка · нажмите название, чтобы переименовать · выберите цвет · удалите ненужные колонки. Нажмите «Готово», чтобы снова перетаскивать карточки.
            </span>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditingColumnId(null)
              setEditingColumnTitle('')
              setShowColumnForm(false)
              cancelColumnDelete()
              clearColumnDragState()
              setBoardEditMode(false)
            }}
          >
            Готово
          </button>
        </div>
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
            Добавить
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

      <div
        className={`youjail-board${draggedCardId !== null ? ' is-card-dragging' : ''}${boardEditMode ? ' is-edit-mode' : ''}`}
        aria-busy={loading}
      >
        {loading && !board ? <div className="youjail-loading">Загрузка доски…</div> : null}
        {columns.map((column) => {
          const cards = columnCards.get(column.id) ?? []
          const isDropTarget = !boardEditMode && dropTargetColumnId === column.id
          const isColumnDragging = boardEditMode && draggedColumnId === column.id
          const isColumnDropBefore =
            boardEditMode &&
            columnDropTarget?.columnId === column.id &&
            columnDropTarget.position === 'before'
          const isColumnDropAfter =
            boardEditMode &&
            columnDropTarget?.columnId === column.id &&
            columnDropTarget.position === 'after'

          return (
            <section
              key={column.id}
              className={`youjail-column is-${column.tone}${isDropTarget ? ' is-drop-target' : ''}${isColumnDragging ? ' is-column-dragging' : ''}${isColumnDropBefore ? ' is-column-drop-before' : ''}${isColumnDropAfter ? ' is-column-drop-after' : ''}`}
              aria-label={`${column.title}, ${cards.length}`}
              onDragOver={(event) => handleColumnDragOver(event, column)}
              onDragLeave={(event) => handleColumnDragLeave(event, column.id)}
              onDrop={(event) => handleColumnDrop(event, column)}
            >
              <header
                className={`youjail-column-header${boardEditMode ? ' youjail-column-header-edit' : ''}`}
              >
                <div className="youjail-column-header-row">
                  {boardEditMode ? (
                    <button
                      type="button"
                      className="youjail-column-drag-handle"
                      draggable
                      title="Перетащите колонку"
                      aria-label={`Переместить колонку ${column.title}`}
                      onDragStart={(event) => handleColumnDragStart(event, column.id)}
                      onDragEnd={handleColumnDragEnd}
                    >
                      ⋮⋮
                    </button>
                  ) : null}
                  {canManageBoard && boardEditMode && editingColumnId === column.id ? (
                    <input
                      className="youjail-column-title-input"
                      value={editingColumnTitle}
                      autoFocus
                      onChange={(event) => setEditingColumnTitle(event.target.value)}
                      onBlur={() => void saveColumnTitle(column.id)}
                      onKeyDown={(event) => handleColumnTitleKeyDown(event, column.id)}
                    />
                  ) : canManageBoard && boardEditMode ? (
                    <button
                      type="button"
                      className="youjail-column-title-btn"
                      title="Переименовать колонку"
                      onClick={() => startColumnEdit(column)}
                    >
                      <h2>{column.title}</h2>
                    </button>
                  ) : (
                    <h2>{column.title}</h2>
                  )}
                  <span className="youjail-column-count">{cards.length}</span>
                  {canManageBoard && boardEditMode && columns.length > 1 ? (
                    <button
                      type="button"
                      className="youjail-column-delete-btn"
                      title={`Удалить колонку «${column.title}»`}
                      aria-label={`Удалить колонку ${column.title}`}
                      onClick={() => requestDeleteColumn(column, cards.length)}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
                {canManageBoard && boardEditMode ? (
                  <div className="youjail-column-tones" role="radiogroup" aria-label={`Цвет колонки ${column.title}`}>
                    {COLUMN_TONES.map((tone) => (
                      <button
                        key={tone.value}
                        type="button"
                        role="radio"
                        aria-checked={column.tone === tone.value}
                        aria-label={tone.label}
                        title={tone.label}
                        className={`youjail-column-tone is-${tone.value}${column.tone === tone.value ? ' is-active' : ''}`}
                        onClick={() => void saveColumnTone(column.id, tone.value)}
                      />
                    ))}
                  </div>
                ) : null}
              </header>
              {boardEditMode ? (
                <div className="youjail-column-edit-summary">
                  {cards.length === 0 ? (
                    <p>Колонка пустая — можно удалить без переноса карточек</p>
                  ) : (
                    <p>
                      <strong>{cards.length}</strong>{' '}
                      {cards.length === 1 ? 'карточка' : cards.length < 5 ? 'карточки' : 'карточек'}
                      {' · '}при удалении будут перенесены в другую колонку
                    </p>
                  )}
                </div>
              ) : (
              <div className={`youjail-column-cards${isDropTarget ? ' is-drop-target' : ''}`}>
                {cards.length === 0 && !isDropTarget ? (
                  <div className="youjail-column-empty">Перетащите карточку сюда</div>
                ) : null}
                {cards.map((card) => (
                  <div key={card.id} className="youjail-card-slot">
                    <article
                      className={`youjail-card${draggedCardId === card.id ? ' is-dragging' : ''}${card.pinned ? ' is-pinned' : ''}`}
                      draggable={!boardEditMode}
                      onDragStart={(event) => handleCardDragStart(event, card.id)}
                      onDragEnd={() => {
                        clearDragState()
                        window.setTimeout(() => {
                          cardWasDraggedRef.current = false
                        }, 0)
                      }}
                      onClick={() => {
                        if (boardEditMode || cardWasDraggedRef.current) return
                        setSelectedCardId(card.id)
                      }}
                    >
                    <div className="youjail-card-top">
                      {card.pinned ? <span className="youjail-pin" title="Закреплено">📌</span> : null}
                      {card.projectName ? (
                        <span className="youjail-card-project">{card.projectName}</span>
                      ) : null}
                    </div>
                    <h3 className="youjail-card-title">
                      <span className="youjail-card-key">{card.cardKey}</span>
                      {card.title}
                    </h3>
                    {(card.znis ?? []).length > 0 ? (
                      <div className="youjail-card-zni-row">
                        {(card.znis ?? []).map((zni) => (
                          <span key={zni.number} className="youjail-card-zni-chip" title={zni.title}>
                            {zni.number}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {card.descriptionMd ? (
                      <p className="youjail-card-notes-preview">
                        {mentionPreviewText(card.descriptionMd)}
                      </p>
                    ) : null}
                    <div className="youjail-card-meta-row">
                      {card.tags.length > 0 ? (
                        <div className="youjail-card-tags">
                          {card.tags.map((tag) => (
                            <span
                              key={tag.id}
                              className="youjail-card-tag"
                              style={
                                tag.color
                                  ? {
                                      backgroundColor: `${tag.color}22`,
                                      color: tag.color,
                                      borderColor: `${tag.color}55`,
                                    }
                                  : undefined
                              }
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
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
                    </div>
                    </article>
                  </div>
                ))}
              </div>
              )}
            </section>
          )
        })}
        {boardEditMode && canManageBoard ? (
          <section className="youjail-column youjail-column-add">
            <form
              className="youjail-column-add-form"
              onSubmit={(event) => void createColumn(event, inlineNewColumnTitle)}
            >
              <h2>Новая колонка</h2>
              <input
                type="text"
                value={inlineNewColumnTitle}
                onChange={(event) => setInlineNewColumnTitle(event.target.value)}
                placeholder="Название колонки"
              />
              <button type="submit" className="btn-primary" disabled={!inlineNewColumnTitle.trim()}>
                Добавить
              </button>
            </form>
          </section>
        ) : null}
      </div>

      {columnPendingDelete ? (
        <div className="youjail-delete-backdrop" onClick={cancelColumnDelete}>
          <div
            className="youjail-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="youjail-delete-column-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="youjail-delete-column-title">Удалить колонку «{columnPendingDelete.title}»?</h3>
            <p className="youjail-muted">
              В колонке{' '}
              <strong>
                {columnCards.get(columnPendingDelete.id)?.length ?? 0}
              </strong>{' '}
              {(columnCards.get(columnPendingDelete.id)?.length ?? 0) === 1
                ? 'карточка'
                : (columnCards.get(columnPendingDelete.id)?.length ?? 0) < 5
                  ? 'карточки'
                  : 'карточек'}
              . Выберите, куда их перенести:
            </p>
            <label className="youjail-field">
              <span>Перенести в</span>
              <select
                value={deleteMoveTargetId ?? ''}
                disabled={deletingColumn}
                onChange={(event) =>
                  setDeleteMoveTargetId(event.target.value ? Number(event.target.value) : null)
                }
              >
                {columns
                  .filter((column) => column.id !== columnPendingDelete.id)
                  .map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="youjail-delete-actions">
              <button type="button" className="btn-ghost" disabled={deletingColumn} onClick={cancelColumnDelete}>
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary youjail-danger-btn"
                disabled={deletingColumn || !deleteMoveTargetId}
                onClick={() => void confirmDeleteColumn(columnPendingDelete.id, deleteMoveTargetId)}
              >
                {deletingColumn ? 'Удаление…' : 'Удалить колонку'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <YouJailCardDetail
        cardId={selectedCardId}
        projects={board?.projects ?? []}
        allTags={board?.tags ?? []}
        canManageOrg={canManageOrg}
        onClose={() => setSelectedCardId(null)}
        onUpdated={handleCardUpdated}
        onDeleted={handleCardDeleted}
        onTagsCatalogUpdated={(tags) =>
          setBoard((current) => (current ? { ...current, tags } : current))
        }
      />
    </div>
  )
}
