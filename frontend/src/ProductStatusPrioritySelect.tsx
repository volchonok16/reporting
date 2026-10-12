type ProductStatusPrioritySelectProps = {
  value: string
  options: string[]
  rangeHint?: string
  disabled?: boolean
  ariaLabel?: string
  onChange: (next: string) => void
  onFocus?: () => void
  onBlur?: () => void
}

export default function ProductStatusPrioritySelect({
  value,
  options,
  rangeHint,
  disabled = false,
  ariaLabel,
  onChange,
  onFocus,
  onBlur,
}: ProductStatusPrioritySelectProps) {
  const normalized = value.trim()
  const hasCurrent = Boolean(normalized) && options.includes(normalized)

  return (
    <select
      className="product-status-priority-select"
      value={hasCurrent ? normalized : normalized ? `__legacy__:${normalized}` : ''}
      disabled={disabled || options.length === 0}
      aria-label={ariaLabel}
      title={
        options.length === 0
          ? 'Сначала выберите проект координации'
          : rangeHint
            ? `Число из диапазона ${rangeHint}`
            : 'Приоритет'
      }
      onFocus={onFocus}
      onBlur={onBlur}
      onChange={(event) => {
        const next = event.target.value
        if (next.startsWith('__legacy__:')) {
          onChange(next.slice('__legacy__:'.length))
          return
        }
        onChange(next)
      }}
    >
      <option value="">{options.length === 0 ? 'Выберите проект' : '—'}</option>
      {!hasCurrent && normalized ? (
        <option value={`__legacy__:${normalized}`}>{normalized} (вне диапазона)</option>
      ) : null}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
}
