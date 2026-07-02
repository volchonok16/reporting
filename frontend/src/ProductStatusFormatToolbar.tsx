import type { CellStyle, TextStyleSegment } from './productStatusRichText'

type ProductStatusFormatToolbarProps = {
  disabled?: boolean
  hasActiveCell: boolean
  onTextStyle: (patch: Partial<TextStyleSegment>) => void
  onCellStyle: (patch: Partial<CellStyle>) => void
  onClearFormatting: () => void
}

type PresetButton<T> = {
  label: string
  title?: string
  patch: Partial<T>
  className?: string
}

const HIGHLIGHT_PRESETS: PresetButton<TextStyleSegment>[] = [
  { label: 'Ж', title: 'Маркер жёлтый', patch: { bg: 'FFFF00' }, className: 'product-status-swatch-yellow' },
  { label: 'З', title: 'Маркер зелёный', patch: { bg: 'C6EFCE' }, className: 'product-status-swatch-green' },
  { label: 'Р', title: 'Маркер розовый', patch: { bg: 'FFC7CE' }, className: 'product-status-swatch-pink' },
  { label: 'Г', title: 'Маркер голубой', patch: { bg: 'BDD7EE' }, className: 'product-status-swatch-blue' },
]

const TEXT_COLOR_PRESETS: PresetButton<TextStyleSegment>[] = [
  { label: 'A', title: 'Чёрный текст', patch: { fg: '000000' }, className: 'product-status-fg-black' },
  { label: 'A', title: 'Красный текст', patch: { fg: 'FF0000' }, className: 'product-status-fg-red' },
  { label: 'A', title: 'Синий текст', patch: { fg: '0000FF' }, className: 'product-status-fg-blue' },
  { label: 'A', title: 'Зелёный текст', patch: { fg: '008000' }, className: 'product-status-fg-green' },
  { label: 'A', title: 'Серый текст', patch: { fg: '808080' }, className: 'product-status-fg-gray' },
]

const CELL_FILL_PRESETS: PresetButton<CellStyle>[] = [
  { label: 'Зелёная', patch: { bg: 'C6EFCE' } },
  { label: 'Жёлтая', patch: { bg: 'FFEB9C' } },
  { label: 'Голубая', patch: { bg: 'DDEBF7' } },
  { label: 'Серая', patch: { bg: 'EDEDED' } },
  { label: 'Без заливки', patch: { bg: null } },
]

const CELL_BORDER_PRESETS: PresetButton<CellStyle>[] = [
  { label: 'Красная', patch: { border: 'FF0000' } },
  { label: 'Синяя', patch: { border: '4472C4' } },
  { label: 'Зелёная', patch: { border: '00B050' } },
  { label: 'Без рамки', patch: { border: null } },
]

function FormatButton<T>({
  preset,
  inactive,
  onApply,
}: {
  preset: PresetButton<T>
  inactive: boolean
  onApply: (patch: Partial<T>) => void
}) {
  return (
    <button
      type="button"
      className={['btn-secondary product-status-format-btn', preset.className].filter(Boolean).join(' ')}
      disabled={inactive}
      title={preset.title ?? preset.label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onApply(preset.patch)}
    >
      {preset.label}
    </button>
  )
}

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
      <div className="product-status-format-row">
        <span className="product-status-format-label">Маркер:</span>
        {HIGHLIGHT_PRESETS.map((preset) => (
          <FormatButton key={preset.title} preset={preset} inactive={inactive} onApply={onTextStyle} />
        ))}
        <span className="product-status-format-sep" aria-hidden="true" />
        <span className="product-status-format-label">Цвет:</span>
        {TEXT_COLOR_PRESETS.map((preset) => (
          <FormatButton key={preset.title} preset={preset} inactive={inactive} onApply={onTextStyle} />
        ))}
        <span className="product-status-format-sep" aria-hidden="true" />
        <button
          type="button"
          className="btn-secondary product-status-format-btn product-status-format-btn-strong"
          disabled={inactive}
          title="Жирный"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onTextStyle({ bold: true })}
        >
          Ж
        </button>
        <button
          type="button"
          className="btn-secondary product-status-format-btn product-status-format-btn-em"
          disabled={inactive}
          title="Курсив"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onTextStyle({ italic: true })}
        >
          К
        </button>
        <button
          type="button"
          className="btn-secondary product-status-format-btn product-status-format-btn-strike"
          disabled={inactive}
          title="Зачёркнутый"
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
      </div>
      <div className="product-status-format-row">
        <span className="product-status-format-label">Ячейка:</span>
        {CELL_FILL_PRESETS.map((preset) => (
          <FormatButton key={preset.label} preset={preset} inactive={inactive} onApply={onCellStyle} />
        ))}
        <span className="product-status-format-sep" aria-hidden="true" />
        <span className="product-status-format-label">Рамка:</span>
        {CELL_BORDER_PRESETS.map((preset) => (
          <FormatButton key={preset.label} preset={preset} inactive={inactive} onApply={onCellStyle} />
        ))}
        {!hasActiveCell && !disabled ? (
          <span className="product-status-format-hint">
            Кликните в ячейку. Без выделения стиль применится ко всей ячейке.
          </span>
        ) : null}
      </div>
    </div>
  )
}
