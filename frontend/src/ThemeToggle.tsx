import { useState } from 'react'
import { resolveTheme, setTheme, type Theme } from './theme'

type ThemeToggleProps = {
  className?: string
  compact?: boolean
}

export default function ThemeToggle({ className = '', compact = false }: ThemeToggleProps) {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme())

  const pick = (next: Theme) => {
    setThemeState(next)
    setTheme(next)
  }

  return (
    <div
      className={`theme-toggle${compact ? ' theme-toggle-compact' : ''}${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="Тема оформления"
    >
      <button
        type="button"
        className={`theme-toggle-btn${theme === 'light' ? ' theme-toggle-btn-active' : ''}`}
        onClick={() => pick('light')}
        aria-pressed={theme === 'light'}
      >
        {compact ? '☀' : 'Светлая'}
      </button>
      <button
        type="button"
        className={`theme-toggle-btn${theme === 'dark' ? ' theme-toggle-btn-active' : ''}`}
        onClick={() => pick('dark')}
        aria-pressed={theme === 'dark'}
      >
        {compact ? '🌙' : 'Тёмная'}
      </button>
    </div>
  )
}
