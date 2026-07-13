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

export default function YouJailCardLinksField({
  value,
  relatedCards,
  currentCardKey,
  disabled = false,
  onChange,
  onBlur,
  onOpenCard,
}: YouJailCardLinksFieldProps) {
  const manualCards = relatedCards.filter((card) => card.linkKind === 'manual')
  const zniCards = relatedCards.filter((card) => card.linkKind === 'zni')

  return (
    <div className="youjail-links-field">
      <label className="youjail-field youjail-field-full">
        <span>Связанные карточки</span>
        <input
          type="text"
          value={value}
          disabled={disabled}
          placeholder={currentCardKey ? `MAIN-1, ${currentCardKey}` : CARD_KEYS_PLACEHOLDER}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            const normalized = formatCardKeys(parseCardKeys(value))
            if (normalized !== value) onChange(normalized)
            onBlur(normalized)
          }}
        />
      </label>
      <p className="youjail-muted youjail-links-hint">
        Ключи с любых доступных досок через запятую. Командные: <code>MAIN-1</code>, <code>SMS-5</code>.
        Личные: <code>PERSONAL134-2</code> (slug доски + номер). Сокращение <code>MY-2</code> — только если
        карточка одна среди доступных личных досок.
      </p>

      {manualCards.length > 0 || zniCards.length > 0 ? (
        <div className="youjail-related-cards">
          {manualCards.length > 0 ? (
            <div className="youjail-related-group">
              <p className="youjail-related-label">Связи вручную</p>
              {manualCards.map((card) => (
                <button
                  key={`manual-${card.id}`}
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
