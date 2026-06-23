type RoadmapUseCaseFieldProps = {
  value: boolean
  disabled?: boolean
  saving?: boolean
  onChange: (hasUc: boolean) => void
}

export function RoadmapUseCaseField({
  value,
  disabled = false,
  saving = false,
  onChange,
}: RoadmapUseCaseFieldProps) {
  return (
    <div className="roadmap-bar-uc" role="group" aria-label="Use Case">
      <span className="roadmap-bar-uc-label">Use Case</span>
      <div className="roadmap-bar-uc-options">
        <button
          type="button"
          className={`roadmap-bar-uc-btn${!value ? ' is-active' : ''}`}
          aria-pressed={!value}
          disabled={disabled || saving}
          onClick={(event) => {
            event.stopPropagation()
            if (!value) return
            onChange(false)
          }}
        >
          Нет
        </button>
        <button
          type="button"
          className={`roadmap-bar-uc-btn is-yes${value ? ' is-active' : ''}`}
          aria-pressed={value}
          disabled={disabled || saving}
          onClick={(event) => {
            event.stopPropagation()
            if (value) return
            onChange(true)
          }}
        >
          Да
        </button>
      </div>
    </div>
  )
}
