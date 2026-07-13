import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { postJson } from '../api'
import type { YouJailTag } from './types'

type YouJailTagSelectProps = {
  value: YouJailTag[]
  allTags: YouJailTag[]
  disabled?: boolean
  onChange: (tags: YouJailTag[]) => void
  onTagsCatalogUpdated?: (tags: YouJailTag[]) => void
}

function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export default function YouJailTagSelect({
  value,
  allTags,
  disabled = false,
  onChange,
  onTagsCatalogUpdated,
}: YouJailTagSelectProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const selectedIds = useMemo(() => new Set(value.map((tag) => tag.id)), [value])

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allTags
      .filter((tag) => !selectedIds.has(tag.id))
      .filter((tag) => !needle || tag.name.toLowerCase().includes(needle))
      .slice(0, 12)
  }, [allTags, query, selectedIds])

  const exactMatch = useMemo(() => {
    const needle = normalizeTagName(query).toLowerCase()
    if (!needle) return null
    return allTags.find((tag) => tag.name.toLowerCase() === needle) ?? null
  }, [allTags, query])

  const canCreate =
    normalizeTagName(query).length > 0 &&
    !exactMatch &&
    !value.some((tag) => tag.name.toLowerCase() === normalizeTagName(query).toLowerCase())

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  const addTag = (tag: YouJailTag) => {
    if (selectedIds.has(tag.id)) return
    onChange([...value, tag])
    setQuery('')
    setOpen(false)
    setError(null)
  }

  const removeTag = (tagId: number) => {
    onChange(value.filter((tag) => tag.id !== tagId))
  }

  const createTag = async () => {
    const name = normalizeTagName(query)
    if (!name || disabled || creating) return
    setCreating(true)
    setError(null)
    try {
      const created = await postJson<YouJailTag>('/api/youjail/tags', { name })
      onTagsCatalogUpdated?.(
        [...allTags.filter((tag) => tag.id !== created.id), created].sort((left, right) =>
          left.name.localeCompare(right.name, 'ru'),
        ),
      )
      addTag(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать тег')
    } finally {
      setCreating(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (exactMatch) {
        addTag(exactMatch)
        return
      }
      if (canCreate) {
        void createTag()
      }
      return
    }
    if (event.key === 'Backspace' && !query && value.length > 0) {
      removeTag(value[value.length - 1].id)
    }
    if (event.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="youjail-tag-select" ref={rootRef}>
      <div className={`youjail-tag-input${disabled ? ' is-disabled' : ''}`}>
        {value.map((tag) => (
          <span
            key={tag.id}
            className="youjail-tag-chip"
            style={tag.color ? { backgroundColor: `${tag.color}22`, color: tag.color, borderColor: `${tag.color}55` } : undefined}
          >
            {tag.name}
            {!disabled ? (
              <button
                type="button"
                className="youjail-tag-chip-remove"
                aria-label={`Удалить тег ${tag.name}`}
                onClick={() => removeTag(tag.id)}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        <input
          type="text"
          value={query}
          disabled={disabled || creating}
          placeholder={value.length === 0 ? 'Добавить тег…' : ''}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      {error ? <p className="youjail-error-inline">{error}</p> : null}
      {open && !disabled ? (
        <div className="youjail-tag-suggestions" role="listbox">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="youjail-tag-suggestion"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(tag)}
            >
              <span
                className="youjail-tag-suggestion-dot"
                style={{ backgroundColor: tag.color ?? 'var(--accent)' }}
              />
              {tag.name}
            </button>
          ))}
          {canCreate ? (
            <button
              type="button"
              className="youjail-tag-suggestion youjail-tag-suggestion-create"
              disabled={creating}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void createTag()}
            >
              Создать тег «{normalizeTagName(query)}»
            </button>
          ) : null}
          {suggestions.length === 0 && !canCreate ? (
            <p className="youjail-muted youjail-tag-suggestions-empty">Нет подходящих тегов</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
