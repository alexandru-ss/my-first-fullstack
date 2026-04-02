import { useCallback, useState } from 'react'

const STORAGE_KEY = 'theme'

// Reads the theme that the inline script in index.html already applied to <html>.
// Falling back to OS preference so state is always in sync on first render.
// rerender-lazy-state-init: passed as a reference to useState, not called here.
function getInitialTheme() {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme() {
  // rerender-lazy-state-init: initializer runs once; avoids re-reading localStorage every render.
  const [theme, setTheme] = useState(getInitialTheme)

  // rerender-functional-setstate: functional update makes toggleTheme a stable reference
  // (empty dep array) with no stale-closure risk.
  const toggleTheme = useCallback(() => {
    setTheme(current => {
      const next = current === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  return { theme, toggleTheme }
}
