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

// A cold budget for the endpoints that are genuinely, measurably slower than
// the sample the 12s above was drawn from — not an escape hatch to be sprinkled
// around. There is exactly one caller (Assets.jsx) and it carries the numbers.
//
// WHY AN OVERRIDE RATHER THAN A BIGGER GLOBAL. Raising COLD_TIMEOUT_MS would
// make every genuinely dead feed in the app take this long to say so, which is
// the regression the 12s figure was chosen to avoid. The slow endpoints are
// known and few, so they name themselves instead.
export const SLOW_COLD_TIMEOUT_MS = 30000

/**
 * Budget for a request: the cold one only until this hook has loaded once.
 * `coldMs` overrides the cold budget for one call site; the warm guard is
 * deliberately NOT overridable, because a warm read comes out of the server's
 * cache in ~0.02s and anything else is a hang whatever the endpoint.
 */
export function budgetMs(warm, coldMs) {
  return warm ? WARM_TIMEOUT_MS : (coldMs ?? COLD_TIMEOUT_MS)
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

// ---------- adopting a result somebody else just fetched ----------
//
// THE DEFECT. GET /api/data was fetched TWICE on every Overview load, ~294KB
// each. Measured on the live tenant 2026-08-27 from a Playwright request trace:
//
//   t=39ms   ConnStatus, in the header, poll 60000   ends t=70ms
//   t=331ms  the Overview tab itself, poll 30000     ends t=388ms
//
// Two mounted components asking the same url, 261ms apart. They are NOT
// concurrent, so de-duplicating in-flight requests would not have caught it —
// the first was long finished before the second began. What catches it is a
// freshness window: a caller that is about to ask for something another caller
// finished moments ago takes that answer instead.
//
// WHY THERE IS NO SHARED REQUEST HERE. The obvious design — one shared promise
// per url that late callers join — was written out and reviewed, and it needed a
// shared AbortController with a waiter count, a hard request deadline, a
// generation fence against forced refetches racing older responses, and
// coordinated retry state so two callers of one url could not disagree about
// whether it had failed. Every one of those exists only because a request is
// shared WHILE IN FLIGHT. Nothing here is: each caller still owns its own fetch,
// its own timeout, its own abort and its own retry exactly as before. The only
// new thing a caller can do is decline to start one.
//
// ONLY SUCCESSES ARE PUBLISHED, and that is what keeps this small. An adopted
// error would have to reproduce failuresRef, the retry timer and the feeds
// registry's failed/retrying pair; an adopted vault-locked would swallow one of
// the two `bx:vault-locked` events a 503 raises today. Neither is worth the
// risk for a saving that only matters on the happy path, so a failure and a
// locked vault are never written here and every caller fetches them itself. The
// error and locked paths are therefore byte-identical to what they were.
//
// WHAT THIS DOES NOT FIX. Adoption needs a SETTLED result, so it collapses the
// duplicate only when the first request has already finished — a warm read, 8ms
// to 36ms per the measurements at the top of this file. On a COLD load
// /api/data takes 3.5-7.5s, ConnStatus is still in flight when Overview mounts,
// nothing has settled, and both fetch exactly as before. That is the honest
// bound: this halves the steady-state polling load, which is where the server
// cost actually lives, and does nothing for the first cold load of a session.
//
// AND ONE ACCEPTED COST, WRITTEN DOWN RATHER THAN DISCOVERED LATER. If the vault
// locks inside the window, a caller that adopts the success from just before it
// does not make the request that would have returned 503, and so does not raise
// the `bx:vault-locked` that request would have raised. It finds out on its next
// poll instead — up to 30s later.
//
// That is survivable ONLY because the lock has its own signal that this does not
// touch: ConnStatus polls /api/vault/status every 30s WITHOUT adopting, and
// `status.ready === false` drives the same locked state that the event does. A
// 503 on /api/data is the secondary detector, not the primary one. If that ever
// stops being true — if /api/data's 503 becomes the only way the app learns the
// vault is shut — this option has to come off that call site.
const adopting = new Set() // urls some mounted hook has opted in to
const adoptCounts = new Map() // url -> how many mounted hooks opted in, so the last one out clears it
const lastOk = new Map() // url -> { json, at, seq }
const seqByUrl = new Map() // url -> the sequence number of the newest request STARTED

// Exported for ui/src/lib/api.test.js only. Module state outlives a test, so a
// test that seeds a fresh result would otherwise leak it into the next one and
// turn an assertion about fetching into an assertion about ordering.
export function __resetAdoptionForTests() {
  adopting.clear()
  adoptCounts.clear()
  lastOk.clear()
  seqByUrl.clear()
}

/** The next sequence number for this url, claimed when a request starts. */
function claimSeq(url) {
  const next = (seqByUrl.get(url) ?? 0) + 1
  seqByUrl.set(url, next)
  return next
}

/**
 * Record a successful body, if this request is still the newest one started for
 * its url.
 *
 * The sequence check is the whole point. Responses do not necessarily settle in
 * the order they were sent: a slow request started first can land after a fast
 * one started second, and without this an older payload would overwrite a newer
 * one and the next caller would adopt stale data believing it fresh.
 */
function publishOk(url, seq, json) {
  if (!adopting.has(url)) return // nothing reads it, so nothing is kept
  if (seq !== seqByUrl.get(url)) return // superseded while in flight
  // Cloned on the way IN as well as on the way out. The fetching hook has
  // already been handed `json`, and a panel that sorts or splices its slice in
  // place would otherwise be editing what the next adopter is about to receive.
  // Two clones is the price of two callers never sharing one mutable payload.
  lastOk.set(url, { json: structuredClone(json), at: performance.now(), seq })
}

/**
 * The body another caller finished within `withinMs`, or null.
 *
 * TWO conditions, and the second is the one that is easy to leave out. Recent is
 * not sufficient: a newer request may already have been STARTED for this url —
 * and may already have failed — while this entry is still inside the window.
 * Adopting it then would hand out a result that has been superseded. So the
 * entry must also be the one belonging to the newest request started, which is
 * what makes `lastOk` mean "the current answer" rather than "the last answer".
 *
 * Nothing is deleted here. A miss is specific to the caller that asked, because
 * the window is the CALLER's, and another watcher with a longer window could
 * still be entitled to the same entry. Expiry belongs to the watcher cleanup,
 * which drops the whole url when the last one leaves.
 */
function freshOk(url, withinMs) {
  const hit = lastOk.get(url)
  if (!hit) return null
  if (hit.seq !== seqByUrl.get(url)) return null
  return performance.now() - hit.at <= withinMs ? hit : null
}

// performance.now(), NOT Date.now(), and this is not a style preference.
//
// Date.now() is the WALL clock. It jumps: an NTP correction, a laptop waking
// from sleep, an operator fixing their timezone. An elapsed interval measured
// across a backwards jump goes negative and every stale entry reads as fresh;
// across a forwards jump a fresh one reads as expired. performance.now() is
// monotonic and immune to both.
//
// It was also wrong under test, which is how this was caught rather than
// reasoned about. tests/page-fixtures.ts calls page.clock.setFixedTime() so
// that rendered "3 hours ago" strings cannot drift between runs — which FREEZES
// Date.now(). With a frozen wall clock every entry was 0ms old forever, so
// adoption never expired, Overview's 30s poll took the mount result again
// instead of fetching, and the two specs that drive a real re-poll
// (keyboard-reach.spec.ts:157 and layout-drag.spec.ts:443) both failed. A
// timer that never expires is a cache that never refreshes.

/**
 * Fetch a URL, optionally polling on an interval.
 * Returns { data, error, loading, retrying, refetch }.
 *
 * `adoptIfFresherThan` (ms) lets this call site skip its own request when
 * another caller of the same url finished one that recently, and take that
 * result instead. Opt-in per call site, and deliberately not a default: it is a
 * change to what "poll every N seconds" means, and it is only ever right where
 * two components genuinely want the same bytes at the same moment. See the
 * block above for why only successes are shared and what this does not fix.
 *
 * FOR POLLING CALL SITES. An adopted result does not schedule a retry, because
 * there is nothing to retry — no request was made. A polling call site already
 * never schedules its own retry (the poll IS the retry), so this matches how
 * such a call site behaves today rather than inventing an exception for it.
 */
export function useApi(url, { poll, coldMs, adoptIfFresherThan } = {}) {
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

    // Somebody else asked for this a moment ago. Take their answer and make no
    // request at all. Everything set here is what this hook's own success path
    // would have set, and nothing else: no `bx:vault-locked` (only a 503 raises
    // that, and a 503 is never published), no retry timer, no feeds-registry
    // change beyond clearing an error the way a success does.
    if (adoptIfFresherThan) {
      const hit = freshOk(url, adoptIfFresherThan)
      if (hit) {
        // The url has answered — for somebody — so this hook's next real request
        // gets the warm budget, exactly as if it had answered here.
        warmRef.current = true
        if (!aliveRef.current) return
        failuresRef.current = 0
        // Cloned, so two hooks never hold one mutable payload. Two fetches would
        // have produced two independent objects, and a panel that sorts or
        // splices its slice in place must not reach into another panel's copy.
        setData(structuredClone(hit.json))
        setError(null)
        setLoading(false)
        setRetrying(false)
        return
      }
    }

    // Claimed before the request goes out, so the ordering this establishes is
    // the order requests STARTED in, not the order they happened to finish.
    //
    // Only for a url somebody is watching. Sequencing every url the app ever
    // fetches would grow a map with one entry per distinct string for the life
    // of the page, and several call sites build their url out of user input —
    // a filter box, a search term, a selected id. Nothing is published for an
    // unwatched url anyway, so there is no order there to protect.
    const seq = adopting.has(url) ? claimSeq(url) : 0
    // Cold budget until this url has answered once, then the original hang guard.
    const { signal, cancel } = abortAfter(budgetMs(warmRef.current, coldMs))
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
        // Published before the aliveRef gate, deliberately: this is a real, fresh
        // answer for this url whatever became of the component that asked for it,
        // and the `seq` check inside is what decides whether it is still the
        // newest. Nothing is published unless some MOUNTED hook has opted in to
        // this url, so an unmounted caller cannot leave a payload behind for a
        // url nobody is watching.
        publishOk(url, seq, json)
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
    // coldMs is read inside (budgetMs above) and was missing from this list, so
    // a call site that changed it would have kept fetching on the old budget.
    // Safe to add: every caller passes a module constant
    // (tabs/Assets.jsx: SLOW_COLD_TIMEOUT_MS), so `load` does not churn identity
    // and the effect at the bottom of this hook does not refire.
  }, [url, poll, coldMs, adoptIfFresherThan])

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

  // Registration is what bounds what gets kept. `publishOk` writes nothing for a
  // url that is not in here, so the 60-odd call sites that never opt in — some of
  // which build their url from user input, and would otherwise seed an unbounded
  // map with one parsed payload per distinct string — cost nothing and retain
  // nothing. The last entry for a url is dropped when its last watcher unmounts,
  // so a tenant's data does not outlive the component that asked for it.
  useEffect(() => {
    if (!url || !adoptIfFresherThan) return undefined
    const n = (adoptCounts.get(url) ?? 0) + 1
    adoptCounts.set(url, n)
    adopting.add(url)
    return () => {
      const left = (adoptCounts.get(url) ?? 1) - 1
      if (left > 0) {
        adoptCounts.set(url, left)
        return
      }
      adoptCounts.delete(url)
      adopting.delete(url)
      lastOk.delete(url)
      seqByUrl.delete(url)
    }
  }, [url, adoptIfFresherThan])

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
