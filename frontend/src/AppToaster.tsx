import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { resolveTheme, type Theme } from './theme'

function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme())

  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
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
      toastOptions={{ duration: 5000 }}
      style={{ zIndex: 100000 }}
    />
  )
}
