import type { RoadmapPriority } from '../zniTypes'

export const ROADMAP_PRIORITY_OPTIONS: {
  value: RoadmapPriority
  label: string
  hint: string
}[] = [
  { value: 'red', label: 'Обязательно', hint: 'точно должна пойти' },
  { value: 'yellow', label: 'Средний', hint: 'средний приоритет' },
  { value: 'green', label: 'Можно пропустить', hint: 'не обязательно' },
]

export function roadmapPriorityBarClass(priority: RoadmapPriority | null | undefined): string | null {
  if (!priority) return null
  return `priority-${priority}`
}

type RoadmapPriorityPickerProps = {
  value: RoadmapPriority | null | undefined
  disabled?: boolean
  saving?: boolean
  onChange: (priority: RoadmapPriority | null) => void
}

export function RoadmapPriorityPicker({
  value,
  disabled = false,
  saving = false,
  onChange,
}: RoadmapPriorityPickerProps) {
  return (
    <div className="roadmap-priority-picker" role="group" aria-label="Приоритет колбаски">
      {ROADMAP_PRIORITY_OPTIONS.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            className={`roadmap-priority-btn roadmap-priority-btn-${option.value}${
              active ? ' is-active' : ''
            }`}
            title={`${option.label} — ${option.hint}`}
            aria-pressed={active}
            disabled={disabled || saving}
            onClick={() => onChange(active ? null : option.value)}
          >
            <span className="roadmap-priority-dot" aria-hidden="true" />
            <span className="roadmap-priority-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
