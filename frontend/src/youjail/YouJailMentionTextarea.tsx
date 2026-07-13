import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { getJson } from '../api'
import OrgPhoto from '../org/OrgPhoto'
import { buildEmployeeMentionToken } from '../org/employeeMentions'
import type { Employee } from '../org/types'

type YouJailMentionTextareaProps = {
  value: string
  disabled?: boolean
  placeholder?: string
  className?: string
  autoFocus?: boolean
  autoResize?: boolean
  maxAutoHeight?: number
  onChange: (value: string) => void
  onBlur?: () => void
}

function mentionQueryAt(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor)
  const match = /(^|[\s(])@([\w\u0400-\u04FF.-]*)$/.exec(before)
  if (!match) return null
  const query = match[2] ?? ''
  const start = before.length - query.length - 1
  return { start, query }
}

function insertMention(value: string, start: number, cursor: number, employee: Employee): string {
  const token = buildEmployeeMentionToken(employee)
  return `${value.slice(0, start)}${token} ${value.slice(cursor)}`
}

export default function YouJailMentionTextarea({
  value,
  disabled = false,
  placeholder,
  className,
  autoFocus = false,
  autoResize = false,
  maxAutoHeight = 200,
  onChange,
  onBlur,
}: YouJailMentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    void getJson<Employee[]>('/api/org/employees')
      .then((items) => {
        if (!cancelled) setEmployees(items.filter((item) => item.isActive))
      })
      .catch(() => {
        if (!cancelled) setEmployees([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const suggestions = useMemo(() => {
    if (mentionStart === null) return []
    const needle = mentionQuery.trim().toLowerCase()
    return employees
      .filter((employee) => {
        if (!needle) return true
        return employee.fullName.toLowerCase().includes(needle)
      })
      .slice(0, 8)
  }, [employees, mentionQuery, mentionStart])

  useEffect(() => {
    if (!autoFocus) return
    const element = textareaRef.current
    if (!element) return
    element.focus()
    const cursor = element.value.length
    element.setSelectionRange(cursor, cursor)
  }, [autoFocus])

  const syncTextareaHeight = () => {
    if (!autoResize) return
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const nextHeight = Math.min(element.scrollHeight, maxAutoHeight)
    element.style.height = `${nextHeight}px`
    element.style.overflowY = element.scrollHeight > maxAutoHeight ? 'auto' : 'hidden'
  }

  useEffect(() => {
    syncTextareaHeight()
  }, [value, autoResize, maxAutoHeight])

  const syncMentionState = () => {
    const element = textareaRef.current
    if (!element) return
    const state = mentionQueryAt(value, element.selectionStart ?? value.length)
    if (!state) {
      setMentionStart(null)
      setMentionQuery('')
      setActiveIndex(0)
      return
    }
    setMentionStart(state.start)
    setMentionQuery(state.query)
    setActiveIndex(0)
  }

  const applyMention = (employee: Employee) => {
    const element = textareaRef.current
    if (!element || mentionStart === null) return
    const cursor = element.selectionStart ?? value.length
    const nextValue = insertMention(value, mentionStart, cursor, employee)
    onChange(nextValue)
    setMentionStart(null)
    setMentionQuery('')
    setActiveIndex(0)
    window.requestAnimationFrame(() => {
      const nextCursor = mentionStart + `${buildEmployeeMentionToken(employee)} `.length
      element.focus()
      element.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value)
    window.requestAnimationFrame(() => {
      syncMentionState()
      syncTextareaHeight()
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionStart === null || suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % suggestions.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      applyMention(suggestions[activeIndex])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMentionStart(null)
      setMentionQuery('')
    }
  }

  return (
    <div className="youjail-mention-editor">
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={syncMentionState}
        onKeyUp={syncMentionState}
        onBlur={() => {
          window.setTimeout(() => {
            setMentionStart(null)
            onBlur?.()
          }, 120)
        }}
      />
      {mentionStart !== null && suggestions.length > 0 ? (
        <div className="youjail-mention-suggestions" role="listbox">
          {suggestions.map((employee, index) => (
            <button
              key={employee.id}
              type="button"
              className={`youjail-mention-option${index === activeIndex ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyMention(employee)}
            >
              <OrgPhoto
                url={employee.photoUrl}
                name={employee.fullName}
                className="youjail-mention-photo"
                placeholderClassName="youjail-mention-photo youjail-mention-photo--placeholder"
              />
              <span>{employee.fullName}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="youjail-mention-hint">Введите @, чтобы отметить сотрудника</p>
    </div>
  )
}
