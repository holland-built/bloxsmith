import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'

const ThemeContext = createContext(null)

function readStoredMode() {
  try {
    return localStorage.getItem('theme') || 'dark'
  } catch (e) {
    return 'dark'
  }
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function resolveEffective(mode) {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode === 'light' ? 'light' : 'dark'
}

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(readStoredMode)
  const [effective, setEffective] = useState(() => resolveEffective(readStoredMode()))

  const setMode = useCallback((next) => {
    setModeState(next)
    try {
      localStorage.setItem('theme', next)
    } catch (e) {
      // ignore
    }
  }, [])

  useEffect(() => {
    const eff = resolveEffective(mode)
    setEffective(eff)
    document.documentElement.setAttribute('data-theme', eff)

    if (mode === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        const next = mq.matches ? 'dark' : 'light'
        setEffective(next)
        document.documentElement.setAttribute('data-theme', next)
      }
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
  }, [mode])

  const value = useMemo(() => ({ mode, setMode, effective }), [mode, setMode, effective])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function useThemeColors() {
  const { effective } = useTheme()
  return useMemo(() => ({
    accent: cssVar('--color-accent'),
    purple: cssVar('--color-purple'),
    warn: cssVar('--color-warn'),
    crit: cssVar('--color-crit'),
    ok: cssVar('--color-ok'),
    other: cssVar('--color-other'),
    sevHigh: cssVar('--color-sev-high'),
    grid: cssVar('--color-grid'),
    tick: cssVar('--color-tick'),
    field: cssVar('--color-field'),
    border: cssVar('--color-border'),
    txt: cssVar('--color-txt'),
    muted: cssVar('--color-muted'),
    dim: cssVar('--color-dim'),
    pillCritBg: cssVar('--pill-crit-bg'),
    pillCritFg: cssVar('--pill-crit-fg'),
    pillWarnBg: cssVar('--pill-warn-bg'),
    pillWarnFg: cssVar('--pill-warn-fg'),
    pillOkBg: cssVar('--pill-ok-bg'),
    pillOkFg: cssVar('--pill-ok-fg'),
    pillNeutralBg: cssVar('--pill-neutral-bg'),
    pillNeutralFg: cssVar('--pill-neutral-fg'),
  }), [effective])
}
