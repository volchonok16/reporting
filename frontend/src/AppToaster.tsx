import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { THEME_CHANGE_EVENT, resolveTheme, type Theme } from './theme'

function readDocumentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme())

  useEffect(() => {
    const sync = () => setTheme(readDocumentTheme())
    sync()
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync)
  }, [])

  return theme
}

export default function AppToaster() {
  const theme = useDocumentTheme()

  return (
    <Toaster
      theme={theme}
      position="top-right"
      richColors
      closeButton
      visibleToasts={3}
      toastOptions={{ duration: 5000 }}
      style={{ zIndex: 100000 }}
    />
  )
}
