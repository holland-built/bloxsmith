import { useEffect, useState } from 'react'

// A number that goes up each time the browser finishes loading a web font.
//
// Tables and panel headers size themselves by measuring text on a canvas. If
// that measurement ran before Inter arrived (main.jsx waits for it, but only
// up to 1.5s), it used the stand-in font. Components that measure put this
// value in their measure effect's dependencies, so they measure again, with
// the real font, the moment it loads.
export function useFontsLoaded() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : null
    if (!fonts?.addEventListener) return undefined
    const bump = () => setN((v) => v + 1)
    fonts.addEventListener('loadingdone', bump)
    return () => fonts.removeEventListener('loadingdone', bump)
  }, [])
  return n
}
