type RoadmapUseCaseFieldProps = {
  itemNumber: string
  value: boolean
  disabled?: boolean
  saving?: boolean
  onChange: (hasUc: boolean) => void
}

export function RoadmapUseCaseField({
  itemNumber,
  value,
  disabled = false,
  saving = false,
  onChange,
}: RoadmapUseCaseFieldProps) {
  const selectId = `roadmap-uc-${itemNumber}`

  return (
    <div className="roadmap-bar-uc">
      <label className="roadmap-bar-uc-label" htmlFor={selectId}>
        Use Case
      </label>
      <select
        id={selectId}
        className="roadmap-bar-uc-select"
        value={value ? 'yes' : 'no'}
        disabled={disabled || saving}
        aria-label="Use Case"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.target.value === 'yes'
          if (next !== value) {
            onChange(next)
          }
        }}
      >
        <option value="no">Нет</option>
        <option value="yes">Да</option>
      </select>
    </div>
  )
}
