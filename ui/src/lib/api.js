import { useCallback, useEffect, useRef, useState } from 'react'

// Why there is a timeout at all (unchanged): some feeds (e.g. /api/dns-analytics)
// hang forever server-side, and without a cap the panel shows an eternal
// skeleton instead of its Empty state. That reason still holds.
//
// Why 12s is no longer used for the FIRST load: a cold /api/data (first request
// after a restart, server cache empty) was measured at 17.1 / 23.0 / 25.8s
// against the live tenant, 3 samples; warm was 0.02s. A flat 12s therefore
// aborted every first load and the user saw a broken dashboard, not a slow one.
//
// COLD_TIMEOUT_MS = 34_500 = the worst measurement (25.8s) plus one full
// observed spread (25.8 - 17.1 = 8.7s). n=3 is far too small to claim a p99, so
// the run-to-run spread is the only evidence of variability we actually have;
// allowing one more step of it above the worst sample is the headroom. It is a
// deliberate stopgap for the cold path — why the cold fetch costs 17-26s is
// being investigated separately, and this number should come back down with it.
export const COLD_TIMEOUT_MS = 34500
// Once a load has succeeded the data is server-cached (measured 0.02s warm), so
// the original 12s hang guard stays exactly as it was for every later request.
export const WARM_TIMEOUT_MS = 12000

/** Budget for a request: the cold one only until this hook has loaded once. */
export function budgetMs(warm) {
  return warm ? WARM_TIMEOUT_MS : COLD_TIMEOUT_MS
}

/**
 * Abort signal that trips after ms. cancel() stops the timer so a request that
 * already finished is never aborted afterwards.
 */
export function abortAfter(ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  return { signal: ac.signal, cancel: () => clearTimeout(t) }
}

/**
 * Fetch a URL, optionally polling on an interval.
 * Returns { data, error, loading, refetch }.
 */
export function useApi(url, { poll } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const aliveRef = useRef(true)
  const warmRef = useRef(false) // flips once a load has succeeded for this url

  const load = useCallback(() => {
    if (!url) return
    // Cold budget until this url has answered once, then the original hang guard.
    const { signal, cancel } = abortAfter(budgetMs(warmRef.current))
    fetch(url, { cache: 'no-store', signal })
      .then(async (res) => {
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}))
          if (body && (body.locked === true || body.error === 'vault locked')) {
            cancel()
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
        if (json === null) return
        // The url has now answered once, so later requests get the warm budget
        // even if this component unmounted mid-flight.
        warmRef.current = true
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
      .finally(cancel)
  }, [url])

  useEffect(() => {
    aliveRef.current = true
    warmRef.current = false // a new url is cold again
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
