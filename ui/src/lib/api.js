import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Fetch a URL, optionally polling on an interval.
 * Returns { data, error, loading, refetch }.
 */
export function useApi(url, { poll } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const aliveRef = useRef(true)

  const load = useCallback(() => {
    if (!url) return
    // Hard 12s timeout — some feeds (e.g. /api/dns-analytics) hang forever server-side;
    // without this the panel shows an eternal skeleton instead of its Empty state.
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 12000)
    fetch(url, { cache: 'no-store', signal: ac.signal })
      .then(async (res) => {
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}))
          if (body && (body.locked === true || body.error === 'vault locked')) {
            clearTimeout(t)
            ac.abort()
            if (aliveRef.current) {
              setData(null)
              setLoading(false)
            }
            window.dispatchEvent(new Event('bx:vault-locked'))
            return null
          }
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json) => {
        if (json === null || !aliveRef.current) return
        setData(json)
        setError(null)
        setLoading(false)
      })
      .catch((err) => {
        if (!aliveRef.current) return
        setError(err)
        setLoading(false)
      })
      .finally(() => clearTimeout(t))
  }, [url])

  useEffect(() => {
    aliveRef.current = true
    setLoading(true)
    load()
    let id
    if (poll) id = setInterval(load, poll)
    return () => {
      aliveRef.current = false
      if (id) clearInterval(id)
    }
  }, [load, poll])

  return { data, error, loading, refetch: load }
}
