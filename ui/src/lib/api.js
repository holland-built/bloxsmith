import { useCallback, useEffect, useRef, useState } from 'react'

// Why there is a timeout at all (unchanged): some feeds (e.g. /api/dns-analytics)
// hang forever server-side, and without a cap the panel shows an eternal
// skeleton instead of its Empty state. That reason still holds.
//
// The cold path used to need its own enlarged budget: a cold /api/data was
// measured at 17.1 / 23.0 / 25.8s (n=3), so a flat 12s aborted every first load
// and COLD_TIMEOUT_MS was set to 34_500 as an admitted stopgap, to be brought
// back down once the cold fetch got cheaper. v3.45.0 did that — it split the
// one 5,000-row subnet read into ten concurrent 500-row ones — so this was
// re-measured on 2026-08-02 against the dev server on the live tenant.
//
// Cold = server cache empty. Every sample was taken on a freshly restarted
// binary (a dev-serve rebuild empties the in-process TTL cache); samples the
// restart killed mid-flight, and samples a polling browser tab had already
// re-warmed, were discarded rather than counted. Every kept sample, in seconds:
//   cold /api/data      n=13  3.53 3.60 3.62 3.74 3.77 3.77 3.78 3.82 4.00
//                             4.08 4.13 4.15 7.49        median 3.78
//   cold /api/incidents n=6   3.35 3.47 3.61 3.63 4.10 4.50   median 3.62
//   warm, both routes   n=21  0.008 - 0.036
// The old 17-26s cold timings no longer reproduce at all.
//
// Applying the same rule the 34_500 was built from — worst sample plus one full
// observed spread — gives 7.49 + (7.49 - 3.35) = 11.6s pooled, and 11.4s for
// /api/data alone. Both fall BELOW the 12s warm guard, and a cold budget
// tighter than the warm one would be meaningless, since cold is by construction
// the slower of the two paths. So the cold budget is floored at the warm guard
// instead of being set to what the rule produced: 12_000 is that floor, not a
// measurement, and it is the one number here not taken from a sample.
//
// n=19 is still far too small to claim a p99 and none is claimed; run-to-run
// spread remains the only evidence of variability there is. All of it was
// collected on a busy machine (load average 5.5-7.8, concurrent builds running)
// — the 7.49s worst case landed inside one — so if these are wrong they are
// pessimistic. What has changed is that the cold path no longer needs a budget
// of its own, and a genuinely hung first load is now reported in 12s, not 34.5s.
export const COLD_TIMEOUT_MS = 12000
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
