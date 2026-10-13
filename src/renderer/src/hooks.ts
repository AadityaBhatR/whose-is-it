import { useEffect, useState } from 'react'

/** True only while this window is focused AND visible. */
export function useWindowFocus(): boolean {
  const read = () => document.visibilityState === 'visible' && document.hasFocus()
  const [focused, setFocused] = useState(read)
  useEffect(() => {
    const update = () => setFocused(read())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    const t = setInterval(update, 500) // belt and braces (some OS overlays skip blur)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
      clearInterval(t)
    }
  }, [])
  return focused
}

/** Re-render every `ms` and return Date.now(). */
export function useNow(ms = 200): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export const fmtSecs = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
