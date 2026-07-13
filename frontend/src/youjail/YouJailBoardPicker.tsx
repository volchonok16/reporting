import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { notifyProblem, notifySuccess } from '../toast'
import type { YouJailBoardMeta } from './types'

type YouJailBoardPickerProps = {
  boards: YouJailBoardMeta[]
  activeBoardId: number | null
  onSelect: (boardId: number) => void
  onTogglePin: (boardId: number) => Promise<YouJailBoardMeta>
}

function sortBoards(boards: YouJailBoardMeta[]): YouJailBoardMeta[] {
  return [...boards].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru')
  })
}

function boardLabel(board: YouJailBoardMeta): string {
  return board.isPersonal ? `${board.name} · личная` : board.name
}

function BoardKindIcon({ board }: { board: YouJailBoardMeta }) {
  if (board.isPersonal) {
    return (
      <span className="youjail-board-picker-icon is-personal" aria-hidden>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
      </span>
    )
  }
  return (
    <span className="youjail-board-picker-icon is-team" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M4 6h4v4H4V6zm6 0h10v4H10V6zM4 14h4v4H4v-4zm6 0h10v4H10v-4z" />
      </svg>
    </span>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
      {filled ? (
        <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03-1 1.03 1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
      ) : (
        <path d="M14 4v5c0 1.12.37 2.16 1 3H5c.55 0 1 .45 1 1s-.45 1-1 1v2h6v6l1-1 1 1v-6h6v-2c-.55 0-1-.45-1-1h-4.17c.63-.84 1-1.88 1-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1zm-2 0h4v5c0 1.65-1.35 3-3 3s-3-1.35-3-3V4z" />
      )}
    </svg>
  )
}

export function sortYouJailBoards(boards: YouJailBoardMeta[]): YouJailBoardMeta[] {
  return sortBoards(boards)
}

export default function YouJailBoardPicker({
  boards,
  activeBoardId,
  onSelect,
  onTogglePin,
}: YouJailBoardPickerProps) {
  const [open, setOpen] = useState(false)
  const [pinningBoardId, setPinningBoardId] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const sortedBoards = useMemo(() => sortBoards(boards), [boards])
  const pinnedBoards = useMemo(() => sortedBoards.filter((board) => board.pinned), [sortedBoards])
  const otherBoards = useMemo(() => sortedBoards.filter((board) => !board.pinned), [sortedBoards])
  const activeBoard = sortedBoards.find((board) => board.id === activeBoardId) ?? sortedBoards[0] ?? null

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleTogglePin = async (boardId: number, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setPinningBoardId(boardId)
    try {
      const updated = await onTogglePin(boardId)
      notifySuccess(updated.pinned ? 'Доска закреплена' : 'Доска откреплена')
    } catch (err) {
      notifyProblem(err, 'Не удалось изменить закрепление')
    } finally {
      setPinningBoardId(null)
    }
  }

  const renderBoardItem = (board: YouJailBoardMeta) => {
    const isActive = board.id === activeBoardId
    return (
      <div
        key={board.id}
        className={`youjail-board-picker-item${isActive ? ' is-active' : ''}${board.pinned ? ' is-pinned' : ''}`}
      >
        <button
          type="button"
          className="youjail-board-picker-select"
          onClick={() => {
            onSelect(board.id)
            setOpen(false)
          }}
        >
          <BoardKindIcon board={board} />
          <span className="youjail-board-picker-label">{boardLabel(board)}</span>
          {isActive ? <span className="youjail-board-picker-check" aria-hidden>✓</span> : null}
        </button>
        <button
          type="button"
          className={`youjail-board-picker-pin${board.pinned ? ' is-active' : ''}`}
          aria-label={board.pinned ? `Открепить ${board.name}` : `Закрепить ${board.name}`}
          title={board.pinned ? 'Открепить' : 'Закрепить'}
          disabled={pinningBoardId === board.id}
          onClick={(event) => void handleTogglePin(board.id, event)}
        >
          <PinIcon filled={board.pinned} />
        </button>
      </div>
    )
  }

  return (
    <div className={`youjail-board-picker${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="youjail-board-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {activeBoard ? <BoardKindIcon board={activeBoard} /> : null}
        <span className="youjail-board-picker-trigger-label">
          {activeBoard ? boardLabel(activeBoard) : 'Выберите доску'}
        </span>
        <span className="youjail-board-picker-chevron" aria-hidden />
      </button>

      {open ? (
        <div className="youjail-board-picker-menu" role="listbox" aria-label="Доски YouJail">
          {pinnedBoards.length > 0 ? (
            <div className="youjail-board-picker-section">
              <p className="youjail-board-picker-section-title">Закреплённые</p>
              {pinnedBoards.map(renderBoardItem)}
            </div>
          ) : null}
          {otherBoards.length > 0 ? (
            <div className="youjail-board-picker-section">
              {pinnedBoards.length > 0 ? (
                <p className="youjail-board-picker-section-title">Все доски</p>
              ) : null}
              {otherBoards.map(renderBoardItem)}
            </div>
          ) : null}
          {sortedBoards.length === 0 ? (
            <p className="youjail-board-picker-empty">Нет доступных досок</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
