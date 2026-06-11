import type { CellStyle, TextStyleSegment } from './productStatusRichText'

type ProductStatusFormatToolbarProps = {
  disabled?: boolean
  hasActiveCell: boolean
  onTextStyle: (patch: Partial<TextStyleSegment>) => void
  onCellStyle: (patch: Partial<CellStyle>) => void
  onClearFormatting: () => void
}

const TEXT_PRESETS: Array<{ label: string; patch: Partial<TextStyleSegment> }> = [
  { label: 'Маркер (жёлтый)', patch: { bg: 'FFFF00' } },
  { label: 'Красный текст', patch: { fg: 'FF0000' } },
  { label: 'Синий текст', patch: { fg: '0000FF' } },
]

const CELL_PRESETS: Array<{ label: string; patch: Partial<CellStyle> }> = [
  { label: 'Заливка ячейки', patch: { bg: 'C6EFCE' } },
  { label: 'Без заливки', patch: { bg: null } },
]

export default function ProductStatusFormatToolbar({
  disabled = false,
  hasActiveCell,
  onTextStyle,
  onCellStyle,
  onClearFormatting,
}: ProductStatusFormatToolbarProps) {
  const inactive = disabled || !hasActiveCell

  return (
    <div className="product-status-format-toolbar" role="toolbar" aria-label="Форматирование ячеек">
      <span className="product-status-format-label">Выделение:</span>
      {TEXT_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="btn-secondary product-status-format-btn"
          disabled={inactive}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onTextStyle(preset.patch)}
        >
          {preset.label}
        </button>
      ))}
      <button
        type="button"
        className="btn-secondary product-status-format-btn"
        disabled={inactive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onTextStyle({ bold: true })}
      >
        Ж
      </button>
      <button
        type="button"
        className="btn-secondary product-status-format-btn"
        disabled={inactive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onTextStyle({ italic: true })}
      >
        К
      </button>
      <button
        type="button"
        className="btn-secondary product-status-format-btn"
        disabled={inactive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onTextStyle({ strike: true })}
      >
        S̶
      </button>
      <button
        type="button"
        className="btn-secondary product-status-format-btn"
        disabled={inactive}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClearFormatting}
      >
        Сбросить
      </button>
      <span className="product-status-format-sep" aria-hidden="true" />
      <span className="product-status-format-label">Ячейка:</span>
      {CELL_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="btn-secondary product-status-format-btn"
          disabled={inactive}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCellStyle(preset.patch)}
        >
          {preset.label}
        </button>
      ))}
      {!hasActiveCell && !disabled ? (
        <span className="product-status-format-hint">Кликните в ячейку и выделите текст</span>
      ) : null}
    </div>
  )
}
