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

function relatedCardLabel(card: YouJailRelatedCard): string {
  const key = card.cardKeyGlobal || card.cardKey
  return card.boardName ? `${key} · ${card.boardName}` : key
}

function cardGlobalKey(card: YouJailRelatedCard): string {
  return (card.cardKeyGlobal || card.cardKey).toUpperCase()
}

export default function YouJailCardLinksField({
  value,
  relatedCards,
  currentCardKey,
  disabled = false,
  onChange,
  onBlur,
  onOpenCard,
}: YouJailCardLinksFieldProps) {
  const [draft, setDraft] = useState('')

  const committedKeys = useMemo(() => parseCardKeys(value), [value])
  const manualCards = relatedCards.filter((card) => card.linkKind === 'manual')
  const zniCards = relatedCards.filter((card) => card.linkKind === 'zni')

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

  return (
    <div className="youjail-links-field">
      <label className="youjail-field youjail-field-full">
        <span>Связанные карточки</span>
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
        Введите ключ и нажмите Enter — поле очистится. Связь снимается крестиком у карточки.
        Формат: <code>MAIN-1</code>, <code>PERSONAL134-2</code>.
      </p>

      {manualCards.length > 0 || zniCards.length > 0 ? (
        <div className="youjail-related-cards">
          {manualCards.length > 0 ? (
            <div className="youjail-related-group">
              <p className="youjail-related-label">Связи вручную</p>
              {manualCards.map((card) => (
                <div key={`manual-${card.id}`} className="youjail-link-chip-row">
                  <button
                    type="button"
                    className="youjail-related-card-btn"
                    onClick={() => onOpenCard?.(card.id, card.boardId)}
                  >
                    <span className="youjail-related-card-key">{relatedCardLabel(card)}</span>
                    <span className="youjail-related-card-title">{card.title}</span>
                    {card.columnTitle ? (
                      <span className="youjail-related-card-column">{card.columnTitle}</span>
                    ) : null}
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
              ))}
            </div>
          ) : null}
          {zniCards.length > 0 ? (
            <div className="youjail-related-group">
              <p className="youjail-related-label">Та же ЗНИ на доске</p>
              {zniCards.map((card) => (
                <button
                  key={`zni-${card.id}`}
                  type="button"
                  className="youjail-related-card-btn is-zni"
                  onClick={() => onOpenCard?.(card.id, card.boardId)}
                >
                  <span className="youjail-related-card-key">{relatedCardLabel(card)}</span>
                  <span className="youjail-related-card-title">{card.title}</span>
                  {card.columnTitle ? (
                    <span className="youjail-related-card-column">{card.columnTitle}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export { parseCardKeys, formatCardKeys }
