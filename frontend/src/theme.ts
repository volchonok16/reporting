export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'reporting.theme'
const THEME_INSTANT_CLASS = 'theme-switch-instant'
export const THEME_CHANGE_EVENT = 'reporting-theme-change'

export function getStoredTheme(): Theme | null {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' ? value : null
}

export function resolveTheme(): Theme {
  const stored = getStoredTheme()
  if (stored) return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.add(THEME_INSTANT_CLASS)
  root.dataset.theme = theme
  // Применить новые CSS-переменные без анимации transition на всей странице.
  void root.offsetHeight
  root.classList.remove(THEME_INSTANT_CLASS)
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }))
}

export function setTheme(theme: Theme): void {
  if (rootTheme() === theme) return
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

function rootTheme(): Theme | null {
  const value = document.documentElement.dataset.theme
  return value === 'light' || value === 'dark' ? value : null
}

export function initTheme(): Theme {
  const theme = resolveTheme()
  applyTheme(theme)
  return theme
}
