import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

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
 * Should this failure be asked again, or is the answer final?
 *
 * Transient means a second ask could plausibly succeed: our own budget aborting
 * (which is the failure this whole mechanism exists for — under load a feed hit
 * the 12s guard above and the panel then stayed broken until a page reload), a
 * network-level fetch rejection, a 5xx, or a 429. A 400/403/404 answers the
 * same way forever, so retrying it only adds load to a server already in
 * trouble.
 *
 * The 429 branch is currently unreachable and included anyway. Checked on
 * 2026-08-08: this server has no inbound rate limiter, and every status it
 * writes is a literal (200, 404, 409, 425, 500, 503 — httpx.go:555 takes its
 * status from the caller, never from an upstream response). The only 429s in
 * go/ are ones it READS, from GitHub and Groq. Classifying it costs nothing and
 * is already right if a limiter or a proxy ever puts one in front.
 */
export function isTransientError(err) {
  if (!err) return false
  // Name rather than instanceof: the abort reason is a DOMException, and a
  // fetch that never connected rejects with a TypeError from another realm.
  if (err.name === 'AbortError' || err.name === 'TypeError') return true
  if (typeof err.status !== 'number') return false
  return err.status >= 500 || err.status === 429
}

// 2s, then 8s. A warm read answers in 0.008-0.036s, so the first retry catches
// a blip almost free without hammering a server that failed half a second ago.
// The second is deliberately longer than the worst cold load ever measured here
// (7.49s): a feed that just failed to answer inside 12s will not be healthy
// again in 500ms, so it gets one full worst-case load of room first. Two
// entries IS the cap — three attempts total, then a terminal state, because an
// unbounded retry is just poll under another name and leaves the manual button
// nothing to act on.
const RETRY_BASE_MS = [2000, 8000]

/**
 * Wait before the attempt after this one, or null when the budget is spent.
 *
 * Full jitter, x(0.5-1.5), not a polite +-10%: the observed failure mode is
 * every no-poll panel dying at once, so the job is spreading them across a
 * window, not nudging them. rng is injectable so tests assert the bounds
 * instead of sampling them.
 */
export function retryDelayMs(attempt, rng = Math.random) {
  const base = RETRY_BASE_MS[attempt - 1]
  if (base === undefined) return null
  return Math.round(base * (0.5 + rng()))
}

// ---------- which mounted feeds are currently broken ----------
//
// Module state read through useSyncExternalStore, the shape services.js already
// proves out, and for the same reason: every FeedUnavailable on every tab needs
// this answer and none of them sits in a subtree a provider could wrap. The
// alternative was threading a retry callback through 63 useApi call sites and
// 75 render sites by hand, which is the per-call-site mistake this codebase has
// already had to undo once.

const feeds = new Set() // entries: { failed, retrying, retry(delayMs) }
const feedListeners = new Set()
let feedSnapshot = { failed: false, retrying: false }

function publishFeeds() {
  let failed = false
  let retrying = false
  for (const feed of feeds) {
    if (feed.failed) failed = true
    if (feed.retrying) retrying = true
  }
  // Same object identity while nothing changed, which useSyncExternalStore
  // requires of getSnapshot.
  if (failed === feedSnapshot.failed && retrying === feedSnapshot.retrying) return
  feedSnapshot = { failed, retrying }
  for (const listener of feedListeners) listener()
}

function subscribeFeeds(listener) {
  feedListeners.add(listener)
  return () => feedListeners.delete(listener)
}

function getFeedSnapshot() {
  return feedSnapshot
}

/**
 * Is anything on the page broken, and is anything already trying again?
 * `failed` stays true while a retry is pending, so the pair tells "trying
 * again..." apart from "this is as far as it got, here is a button".
 */
export function useFeedRecovery() {
  return useSyncExternalStore(subscribeFeeds, getFeedSnapshot, getFeedSnapshot)
}

/**
 * Load every currently-failed feed again with its attempt budget reset —
 * including polling ones, which otherwise wait out their interval. Spread over
 * 0-500ms because one click can fire every panel on the page at once.
 */
export function retryFailedFeeds() {
  for (const feed of feeds) {
    if (feed.failed) feed.retry(Math.round(Math.random() * 500))
  }
}

/**
 * Fetch a URL, optionally polling on an interval.
 * Returns { data, error, loading, retrying, refetch }.
 */
export function useApi(url, { poll } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const aliveRef = useRef(true)
  const warmRef = useRef(false) // flips once a load has succeeded for this url
  const failuresRef = useRef(0) // consecutive failures for this url
  const retryTimerRef = useRef(null)
  // One stable object for the whole life of the hook; only its fields change,
  // so the registry never has to re-register to stay current.
  const entryRef = useRef({ failed: false, retrying: false, retry: null })

  // Named so the retry timer can call it without a ref hop.
  const load = useCallback(function run() {
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
        // The status rides along on the error: it is the only thing that tells
        // a retryable 503 apart from a 404 that will never change its mind.
        if (!res.ok) {
          throw Object.assign(new Error(`${res.status} ${res.statusText}`), {
            status: res.status,
          })
        }
        return res.json()
      })
      .then((json) => {
        if (json === null) return
        // The url has now answered once, so later requests get the warm budget
        // even if this component unmounted mid-flight.
        warmRef.current = true
        if (!aliveRef.current) return
        failuresRef.current = 0
        setData(json)
        setError(null)
        setLoading(false)
        setRetrying(false)
      })
      .catch((err) => {
        if (!aliveRef.current) return
        // error stays set and loading stays false for the whole retry wait, so
        // no existing branch at any call site sees a state it did not see
        // before; `retrying` is the only new signal.
        setError(err)
        setLoading(false)
        const attempt = (failuresRef.current += 1)
        // A poll IS the retry — it re-fires on its own interval regardless of
        // the error — and a second timer alongside it could put two loads in
        // flight at once, which this function does not guard against.
        const delay = poll || !isTransientError(err) ? null : retryDelayMs(attempt)
        if (delay === null) {
          setRetrying(false)
          return
        }
        setRetrying(true)
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          if (aliveRef.current) run()
        }, delay)
      })
      .finally(cancel)
  }, [url, poll])

  /** Start over: full attempt budget, optionally after a spreading delay. */
  const retry = useCallback(
    (delayMs = 0) => {
      clearTimeout(retryTimerRef.current)
      failuresRef.current = 0
      setRetrying(true)
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        if (aliveRef.current) load()
      }, delayMs)
    },
    [load],
  )

  useEffect(() => {
    const entry = entryRef.current
    feeds.add(entry)
    return () => {
      feeds.delete(entry)
      publishFeeds()
    }
  }, [])

  // No dep array: this mirrors state into the registry entry, and publishes
  // only when one of the two booleans actually moved.
  useEffect(() => {
    const entry = entryRef.current
    entry.retry = retry
    const failed = error !== null
    if (entry.failed === failed && entry.retrying === retrying) return
    entry.failed = failed
    entry.retrying = retrying
    publishFeeds()
  })

  useEffect(() => {
    aliveRef.current = true
    warmRef.current = false // a new url is cold again
    failuresRef.current = 0 // and gets a full retry budget
    setLoading(true)
    load()
    let id
    if (poll) id = setInterval(load, poll)
    return () => {
      aliveRef.current = false
      if (id) clearInterval(id)
      // A retry queued for the url this hook is leaving must never land on the
      // one it is arriving at, and must never land at all after unmount.
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [load, poll])

  return { data, error, loading, retrying, refetch: load }
}
