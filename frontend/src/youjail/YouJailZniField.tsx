import { useCallback, useEffect, useMemo, useState } from 'react'
import { postJson } from '../api'
import { formatZniNumbers, parseZniNumbers, ZNI_NUMBERS_PLACEHOLDER } from '../productStatusZni'
import ZniDetailModal from '../ZniDetailModal'
import type { ChangeRequest } from '../zniTypes'

export type YouJailLinkedZni = {
  number: string
  title: string
  url?: string | null
  status?: string | null
  boardColumn?: string | null
  boardName?: string | null
}

type YouJailZniLookupResponse = {
  items: YouJailLinkedZni[]
}

type YouJailZniFieldProps = {
  value: string
  linked: YouJailLinkedZni[]
  disabled?: boolean
  onChange: (value: string) => void
  onBlur: (value: string) => void
}

function toChangeRequest(item: YouJailLinkedZni): ChangeRequest {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    status: item.status,
    boardColumn: item.boardColumn,
    boardName: item.boardName,
    errors: [],
  }
}

export default function YouJailZniField({
  value,
  linked,
  disabled = false,
  onChange,
  onBlur,
}: YouJailZniFieldProps) {
  const [draft, setDraft] = useState('')
  const [lookup, setLookup] = useState<Record<string, YouJailLinkedZni>>({})
  const [modalItem, setModalItem] = useState<ChangeRequest | null>(null)

  const committedNumbers = useMemo(() => parseZniNumbers(value), [value])

  const draftNumbers = useMemo(() => parseZniNumbers(draft), [draft])
  const lookupKey = draftNumbers.join(',')

  useEffect(() => {
    if (!lookupKey) {
      setLookup({})
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void postJson<YouJailZniLookupResponse>('/api/youjail/zni/lookup', {
        numbers: draftNumbers,
      })
        .then((payload) => {
          if (cancelled) return
          const next: Record<string, YouJailLinkedZni> = {}
          for (const item of payload.items) {
            next[item.number] = item
          }
          setLookup(next)
        })
        .catch(() => {
          if (!cancelled) setLookup({})
        })
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [draftNumbers, lookupKey])

  const commitDraft = useCallback(() => {
    const added = parseZniNumbers(draft)
    if (added.length === 0) return
    const merged = formatZniNumbers([...new Set([...committedNumbers, ...added])])
    setDraft('')
    onChange(merged)
    onBlur(merged)
  }, [committedNumbers, draft, onBlur, onChange])

  const removeZni = useCallback(
    (number: string) => {
      const merged = formatZniNumbers(committedNumbers.filter((item) => item !== number))
      onChange(merged)
      onBlur(merged)
    },
    [committedNumbers, onBlur, onChange],
  )

  const displayItems = useMemo(() => {
    const linkedByNumber = new Map(linked.map((item) => [item.number, item]))
    return committedNumbers.map((number) => linkedByNumber.get(number) ?? { number, title: number })
  }, [committedNumbers, linked])

  const missingNumbers = draftNumbers.filter((number) => !lookup[number])

  return (
    <div className="youjail-zni-field">
      <label className="youjail-field youjail-field-full">
        <span>ЗНИ</span>
        <input
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={committedNumbers.length > 0 ? 'Добавить номер…' : ZNI_NUMBERS_PLACEHOLDER}
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
      <p className="youjail-muted youjail-zni-hint">
        Введите номер и нажмите Enter — поле очистится. Связь снимается крестиком у карточки ЗНИ.
      </p>

      {displayItems.length > 0 ? (
        <div className="youjail-zni-links">
          {displayItems.map((item) => (
            <div key={item.number} className="youjail-link-chip-row">
              <button
                type="button"
                className="youjail-zni-link"
                onClick={() => setModalItem(toChangeRequest(item))}
              >
                <span className="youjail-zni-link-number">{item.number}</span>
                <span className="youjail-zni-link-title">{item.title}</span>
                {item.boardName ? <span className="youjail-zni-link-board">{item.boardName}</span> : null}
              </button>
              {!disabled ? (
                <button
                  type="button"
                  className="youjail-link-remove"
                  aria-label={`Убрать связь с ЗНИ ${item.number}`}
                  onClick={() => removeZni(item.number)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {missingNumbers.length > 0 ? (
        <p className="youjail-zni-missing">Не найдены в базе: {missingNumbers.join(', ')}</p>
      ) : null}

      <ZniDetailModal item={modalItem} onClose={() => setModalItem(null)} />
    </div>
  )
}
