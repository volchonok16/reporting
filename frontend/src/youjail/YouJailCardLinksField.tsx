import { useCallback, useMemo, useState } from 'react'
import type { YouJailRelatedCard } from './types'

type YouJailCardLinksFieldProps = {
  value: string
  relatedCards: YouJailRelatedCard[]
  currentCardKey?: string
  disabled?: boolean
  onChange: (value: string) => void
  onBlur: (value: string) => void
  onOpenCard?: (cardId: number, boardId?: number) => void
}

const CARD_KEYS_PLACEHOLDER = 'MAIN-1, PERSONAL134-2'

function parseCardKeys(value: string): string[] {
  const text = value.trim()
  if (!text) return []
  const seen = new Set<string>()
  const keys: string[] = []
  for (const part of text.split(/[,;]+/)) {
    const token = part.trim().toUpperCase()
    if (!token || seen.has(token)) continue
    seen.add(token)
    keys.push(token)
  }
  return keys
}

function formatCardKeys(keys: string[]): string {
  return keys.join(', ')
}

function cardGlobalKey(card: YouJailRelatedCard): string {
  return (card.cardKeyGlobal || card.cardKey).toUpperCase()
}

function relatedCardKeyLabel(card: YouJailRelatedCard): string {
  return card.cardKeyGlobal || card.cardKey
}

export default function YouJailCardLinksField({
  value,
  relatedCards,
  disabled = false,
  onChange,
  onBlur,
  onOpenCard,
}: YouJailCardLinksFieldProps) {
  const [draft, setDraft] = useState('')

  const committedKeys = useMemo(() => parseCardKeys(value), [value])
  const manualCards = relatedCards.filter((card) => card.linkKind === 'manual')
  const zniCards = relatedCards.filter((card) => card.linkKind === 'zni')

  const manualCardsByKey = useMemo(() => {
    const map = new Map<string, YouJailRelatedCard>()
    for (const card of manualCards) {
      map.set(cardGlobalKey(card), card)
    }
    return map
  }, [manualCards])

  const orphanKeys = useMemo(
    () => committedKeys.filter((key) => !manualCardsByKey.has(key)),
    [committedKeys, manualCardsByKey],
  )

  const totalLinks = manualCards.length + zniCards.length + orphanKeys.length

  const commitDraft = useCallback(() => {
    const added = parseCardKeys(draft)
    if (added.length === 0) return
    const merged = formatCardKeys([...new Set([...committedKeys, ...added])])
    setDraft('')
    onChange(merged)
    onBlur(merged)
  }, [committedKeys, draft, onBlur, onChange])

  const removeCardLink = useCallback(
    (globalKey: string) => {
      const merged = formatCardKeys(committedKeys.filter((key) => key !== globalKey))
      onChange(merged)
      onBlur(merged)
    },
    [committedKeys, onBlur, onChange],
  )

  const renderManualCard = (card: YouJailRelatedCard) => (
    <div key={`manual-${card.id}`} className="youjail-link-chip-row">
      <button
        type="button"
        className="youjail-related-card-chip is-manual"
        onClick={() => onOpenCard?.(card.id, card.boardId)}
      >
        <div className="youjail-related-card-chip-head">
          <span className="youjail-related-card-chip-icon" aria-hidden>
            ↗
          </span>
          <span className="youjail-related-card-key">{relatedCardKeyLabel(card)}</span>
          {card.boardName ? <span className="youjail-related-card-board">{card.boardName}</span> : null}
          {card.columnTitle ? (
            <span className="youjail-related-card-column-pill">{card.columnTitle}</span>
          ) : null}
        </div>
        <p className="youjail-related-card-title">{card.title}</p>
      </button>
      {!disabled ? (
        <button
          type="button"
          className="youjail-link-remove"
          aria-label={`Убрать связь с ${cardGlobalKey(card)}`}
          onClick={() => removeCardLink(cardGlobalKey(card))}
        >
          ×
        </button>
      ) : null}
    </div>
  )

  const renderOrphanKey = (key: string) => (
    <div key={`orphan-${key}`} className="youjail-link-chip-row">
      <div className="youjail-related-card-chip is-missing">
        <div className="youjail-related-card-chip-head">
          <span className="youjail-related-card-key">{key}</span>
          <span className="youjail-related-card-missing-label">не найдена</span>
        </div>
        <p className="youjail-related-card-missing-hint">Проверьте ключ или доступ к доске</p>
      </div>
      {!disabled ? (
        <button
          type="button"
          className="youjail-link-remove"
          aria-label={`Убрать связь с ${key}`}
          onClick={() => removeCardLink(key)}
        >
          ×
        </button>
      ) : null}
    </div>
  )

  const renderZniCard = (card: YouJailRelatedCard) => (
    <button
      key={`zni-${card.id}`}
      type="button"
      className="youjail-related-card-chip is-zni"
      onClick={() => onOpenCard?.(card.id, card.boardId)}
    >
      <div className="youjail-related-card-chip-head">
        <span className="youjail-related-card-chip-icon" aria-hidden>
          ↗
        </span>
        <span className="youjail-related-card-key">{relatedCardKeyLabel(card)}</span>
        <span className="youjail-related-card-kind-pill">по ЗНИ</span>
        {card.columnTitle ? (
          <span className="youjail-related-card-column-pill">{card.columnTitle}</span>
        ) : null}
      </div>
      <p className="youjail-related-card-title">{card.title}</p>
    </button>
  )

  return (
    <div className="youjail-links-field">
      <div className="youjail-links-section-head">
        <span className="youjail-links-section-title">Связанные карточки</span>
        {totalLinks > 0 ? <span className="youjail-links-count">{totalLinks}</span> : null}
      </div>

      {totalLinks > 0 ? (
        <div className="youjail-related-cards">
          {manualCards.length > 0 || orphanKeys.length > 0 ? (
            <div className="youjail-related-group">
              {(manualCards.length > 0 || orphanKeys.length > 0) && zniCards.length > 0 ? (
                <p className="youjail-related-label">Вручную</p>
              ) : null}
              {manualCards.map(renderManualCard)}
              {orphanKeys.map(renderOrphanKey)}
            </div>
          ) : null}
          {zniCards.length > 0 ? (
            <div className="youjail-related-group">
              <p className="youjail-related-label">Та же ЗНИ на доске</p>
              {zniCards.map(renderZniCard)}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="youjail-muted youjail-links-empty">Пока нет связанных карточек</p>
      )}

      <label className="youjail-field youjail-field-full youjail-links-add-field">
        <span className="youjail-sr-only">Добавить связь</span>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={committedKeys.length > 0 ? 'Добавить ключ…' : CARD_KEYS_PLACEHOLDER}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitDraft()
            }
          }}
          onBlur={() => commitDraft()}
        />
      </label>
      <p className="youjail-muted youjail-links-hint">
        Ключ и Enter — добавить связь. Крестик у карточки — убрать. Формат: <code>MAIN-1</code>,{' '}
        <code>PERSONAL134-2</code>.
      </p>
    </div>
  )
}

export { parseCardKeys, formatCardKeys }
