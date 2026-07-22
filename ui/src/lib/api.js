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
    fetch(url, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return res.json()
      })
      .then((json) => {
        if (!aliveRef.current) return
        setData(json)
        setError(null)
        setLoading(false)
      })
      .catch((err) => {
        if (!aliveRef.current) return
        setError(err)
        setLoading(false)
      })
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
