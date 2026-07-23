import { useEffect, useState } from 'react'

function parseHashParams() {
  const hash = window.location.hash || ''
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return {}
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  const out = {}
  for (const [k, v] of params.entries()) out[k] = v
  return out
}

export function useHashParams() {
  const [params, setParams] = useState(parseHashParams)

  useEffect(() => {
    function onHashChange() {
      setParams(parseHashParams())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return params
}

export function setHashParams(tabId, params) {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue
    usp.set(k, v)
  }
  const qs = usp.toString()
  window.location.hash = qs ? `${tabId}?${qs}` : tabId
}
