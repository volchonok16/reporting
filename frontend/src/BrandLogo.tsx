import { useEffect, useState } from 'react'
import { resolveTheme, THEME_CHANGE_EVENT, type Theme } from './theme'

type BrandLogoProps = {
  className?: string
  height?: number
  /** full = t2 + Бизнес; mark = avatar favicon-style */
  variant?: 'full' | 'mark'
}

const LOGO_BLACK = '/brand/T2_B2B_Logo_black.svg'
const LOGO_WHITE = '/brand/T2_B2B_Logo_white.svg'
const LOGO_MARK = '/brand/T2_B2B_Avatar.svg'

export default function BrandLogo({ className = '', height = 36, variant = 'full' }: BrandLogoProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof document !== 'undefined' ? resolveTheme() : 'light',
  )

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<Theme>).detail
      if (next === 'light' || next === 'dark') setThemeState(next)
      else setThemeState(resolveTheme())
    }
    window.addEventListener(THEME_CHANGE_EVENT, onChange)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange)
  }, [])

  if (variant === 'mark') {
    return (
      <img
        className={`brand-logo brand-logo-mark${className ? ` ${className}` : ''}`}
        src={LOGO_MARK}
        alt="T2 Бизнес"
        height={height}
        width={height}
        decoding="async"
      />
    )
  }

  const src = theme === 'dark' ? LOGO_WHITE : LOGO_BLACK
  const width = Math.round(height * (920 / 276))

  return (
    <img
      className={`brand-logo brand-logo-full${className ? ` ${className}` : ''}`}
      src={src}
      alt="T2 Бизнес"
      height={height}
      width={width}
      decoding="async"
    />
  )
}
