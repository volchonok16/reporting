import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import YouJailMentionTextarea from './YouJailMentionTextarea'
import { handleMentionPreviewClick } from './mentionPreview'
import { renderMarkdown } from './markdown'

type YouJailUnifiedNotesEditorProps = {
  value: string
  disabled?: boolean
  placeholder?: string
  onChange: (value: string) => void
  onBlur?: () => void
  onMentionClick?: (employeeId: number) => void
}

export default function YouJailUnifiedNotesEditor({
  value,
  disabled = false,
  placeholder = 'Текст задачи, детали, чек-лист…',
  onChange,
  onBlur,
  onMentionClick,
}: YouJailUnifiedNotesEditorProps) {
  const [editing, setEditing] = useState(false)
  const [autoFocus, setAutoFocus] = useState(false)

  const previewHtml = useMemo(() => renderMarkdown(value), [value])

  useEffect(() => {
    if (!editing) setAutoFocus(false)
  }, [editing])

  const startEditing = () => {
    if (disabled) return
    setAutoFocus(true)
    setEditing(true)
  }

  const handlePreviewClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-employee-id]')) {
      if (onMentionClick) handleMentionPreviewClick(event, onMentionClick)
      return
    }
    startEditing()
  }

  const handleBlur = () => {
    setEditing(false)
    onBlur?.()
  }

  if (editing) {
    return (
      <div className="youjail-notes-unified-field is-editing">
        <YouJailMentionTextarea
          className="youjail-notes-editor"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={onChange}
          onBlur={handleBlur}
        />
      </div>
    )
  }

  return (
    <div
      className={`youjail-notes-unified-field${disabled ? ' is-disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={startEditing}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          startEditing()
        }
      }}
    >
      <div
        className="youjail-notes-preview youjail-notes-preview-unified"
        dangerouslySetInnerHTML={{
          __html:
            previewHtml ||
            `<p class="youjail-notes-empty">${placeholder}. Нажмите, чтобы редактировать.</p>`,
        }}
        onClick={handlePreviewClick}
      />
      {!value.trim() ? (
        <p className="youjail-notes-unified-hint">Нажмите, чтобы начать писать</p>
      ) : null}
    </div>
  )
}
