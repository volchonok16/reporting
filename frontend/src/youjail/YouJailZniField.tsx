import { useEffect, useMemo, useState } from 'react'
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
  const [lookup, setLookup] = useState<Record<string, YouJailLinkedZni>>({})
  const [modalItem, setModalItem] = useState<ChangeRequest | null>(null)

  const parsedNumbers = useMemo(() => parseZniNumbers(value), [value])
  const lookupKey = parsedNumbers.join(',')

  useEffect(() => {
    if (!lookupKey) {
      setLookup({})
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void postJson<YouJailZniLookupResponse>('/api/youjail/zni/lookup', {
        numbers: parsedNumbers,
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
  }, [lookupKey, parsedNumbers])

  const displayItems = linked.length > 0 ? linked : parsedNumbers.map((number) => lookup[number]).filter(Boolean)
  const missingNumbers = parsedNumbers.filter((number) => !lookup[number] && !linked.some((item) => item.number === number))

  return (
    <div className="youjail-zni-field">
      <label className="youjail-field youjail-field-full">
        <span>ЗНИ</span>
        <input
          type="text"
          value={value}
          disabled={disabled}
          placeholder={ZNI_NUMBERS_PLACEHOLDER}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            const normalized = formatZniNumbers(parseZniNumbers(value))
            if (normalized !== value) {
              onChange(normalized)
            }
            onBlur(normalized)
          }}
        />
      </label>
      <p className="youjail-muted youjail-zni-hint">
        Номера через запятую. Данные подтягиваются из синхронизированной базы ЗНИ.
      </p>

      {displayItems.length > 0 ? (
        <div className="youjail-zni-links">
          {displayItems.map((item) => (
            <button
              key={item.number}
              type="button"
              className="youjail-zni-link"
              onClick={() => setModalItem(toChangeRequest(item))}
            >
              <span className="youjail-zni-link-number">{item.number}</span>
              <span className="youjail-zni-link-title">{item.title}</span>
              {item.boardName ? <span className="youjail-zni-link-board">{item.boardName}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {missingNumbers.length > 0 ? (
        <p className="youjail-zni-missing">
          Не найдены в базе: {missingNumbers.join(', ')}
        </p>
      ) : null}

      <ZniDetailModal item={modalItem} onClose={() => setModalItem(null)} />
    </div>
  )
}
