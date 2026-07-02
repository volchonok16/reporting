import type { TextStyleSegment } from './productStatusRichText'
import { PRODUCT_STATUS_ATTENTION_FG } from './productStatusRichText'

type ProductStatusFormatToolbarProps = {
  disabled?: boolean
  hasActiveCell: boolean
  onTextStyle: (patch: Partial<TextStyleSegment>) => void
  onClearFormatting: () => void
}

type PresetButton = {
  label: string
  title?: string
  patch: Partial<TextStyleSegment>
  className?: string
}

const HIGHLIGHT_PRESETS: PresetButton[] = [
  { label: 'Жёлтый', patch: { bg: 'FFFF00' }, className: 'product-status-swatch-yellow' },
  { label: 'Зелёный', patch: { bg: 'C6EFCE' }, className: 'product-status-swatch-green' },
  { label: 'Розовый', patch: { bg: 'FFC7CE' }, className: 'product-status-swatch-pink' },
  { label: 'Голубой', patch: { bg: 'BDD7EE' }, className: 'product-status-swatch-blue' },
]

const TEXT_COLOR_PRESETS: PresetButton[] = [
  {
    label: 'Красный',
    title: 'Красный текст (как «Обратить внимание»)',
    patch: { fg: PRODUCT_STATUS_ATTENTION_FG },
    className: 'product-status-fg-attention',
  },
  { label: 'Синий', title: 'Синий текст', patch: { fg: '0000FF' }, className: 'product-status-fg-blue' },
  { label: 'Чёрный', title: 'Чёрный текст', patch: { fg: '000000' }, className: 'product-status-fg-black' },
  { label: 'Зелёный', title: 'Зелёный текст', patch: { fg: '008000' }, className: 'product-status-fg-green' },
  { label: 'Серый', title: 'Серый текст', patch: { fg: '808080' }, className: 'product-status-fg-gray' },
]

function FormatButton({
  preset,
  inactive,
  onApply,
}: {
  preset: PresetButton
  inactive: boolean
  onApply: (patch: Partial<TextStyleSegment>) => void
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
  onClearFormatting,
}: ProductStatusFormatToolbarProps) {
  const inactive = disabled || !hasActiveCell

  return (
    <div className="product-status-format-toolbar" role="toolbar" aria-label="Форматирование текста">
      <span className="product-status-format-label">Маркер:</span>
      {HIGHLIGHT_PRESETS.map((preset) => (
        <FormatButton key={preset.label} preset={preset} inactive={inactive} onApply={onTextStyle} />
      ))}
      <span className="product-status-format-sep" aria-hidden="true" />
      <span className="product-status-format-label">Цвет:</span>
      {TEXT_COLOR_PRESETS.map((preset) => (
        <FormatButton key={preset.label} preset={preset} inactive={inactive} onApply={onTextStyle} />
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
  )
}
