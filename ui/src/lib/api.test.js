// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import {
  COLD_TIMEOUT_MS,
  WARM_TIMEOUT_MS,
  abortAfter,
  budgetMs,
  isTransientError,
  retryDelayMs,
  __resetAdoptionForTests,
  retryFailedFeeds,
  useApi,
} from './api.js'

// The slowest cold /api/data measured against the live tenant.
//
// This was 25_800 — the worst of three samples (17.1 / 23.0 / 25.8s) taken
// before v3.45.0 split the one 5,000-row subnet read into ten concurrent
// 500-row ones. Re-measured 2026-08-02 on a freshly restarted binary, 13 kept
// samples: 3.53 3.60 3.62 3.74 3.77 3.77 3.78 3.82 4.00 4.08 4.13 4.15 7.49s,
// median 3.78. The old 17-26s timings do not reproduce at all, so the constant
// was stale evidence, not a requirement the budget had to keep meeting.
//
// 7_490 is the WORST kept sample, not the median, because that is what the
// budget has to survive. It was taken on a loaded machine (concurrent builds),
// so it is pessimistic if anything.
const MEASURED_WORST_COLD_MS = 7490

// The slowest warm read measured in the same run (/api/data 0.011-0.036s,
// /api/incidents 0.008-0.018s). Rounded up to a whole millisecond.
const MEASURED_WORST_WARM_MS = 36

test('a cold request is still alive at the slowest measured cold load', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(false))
  let aborted = false
  signal.addEventListener('abort', () => {
    aborted = true
  })

  t.mock.timers.tick(MEASURED_WORST_COLD_MS)

  assert.equal(
    aborted,
    false,
    `cold budget aborted at ${MEASURED_WORST_COLD_MS}ms, which a real first load takes`,
  )
  assert.equal(signal.aborted, false)
})

test('a cold request is aborted once the cold budget elapses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(false))

  t.mock.timers.tick(COLD_TIMEOUT_MS - 1)
  assert.equal(signal.aborted, false, 'aborted one tick early')

  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true, 'a hung feed would never be cut off')
})

test('a warm request keeps the original 12s hang guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal } = abortAfter(budgetMs(true))

  t.mock.timers.tick(WARM_TIMEOUT_MS - 1)
  assert.equal(signal.aborted, false)

  t.mock.timers.tick(1)
  assert.equal(signal.aborted, true)
  assert.equal(WARM_TIMEOUT_MS, 12000, 'the hung-feed guard was 12s and stays 12s')
})

test('cancel stops a finished request from being aborted later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { signal, cancel } = abortAfter(budgetMs(false))
  cancel()

  t.mock.timers.tick(COLD_TIMEOUT_MS * 2)
  assert.equal(signal.aborted, false)
})

test('both budgets clear their measured worst case, and cold is never the tighter one', () => {
  assert.ok(
    COLD_TIMEOUT_MS > MEASURED_WORST_COLD_MS,
    'cold budget must exceed the slowest measured cold load',
  )
  assert.ok(
    WARM_TIMEOUT_MS > MEASURED_WORST_WARM_MS * 100,
    'warm budget must stay far above a real warm read, so a slow one reads as a hang',
  )
  // Cold is by construction the slower path, so its budget can never be the
  // tighter of the two. This is the invariant that used to be expressed as
  // "warm < the worst cold sample" — true only while the cold path was slow
  // enough for that comparison to mean anything. Now that the worst cold load
  // (7.5s) is under the warm guard (12s), the documented rule of worst + one
  // observed spread yields 11.6s, which would put cold BELOW warm. It is
  // therefore floored at the warm guard, and this assertion pins that floor.
  assert.ok(
    COLD_TIMEOUT_MS >= WARM_TIMEOUT_MS,
    'a cold budget tighter than the warm one is meaningless',
  )
  assert.equal(budgetMs(false), COLD_TIMEOUT_MS)
  assert.equal(budgetMs(true), WARM_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// Retry policy — the two pure decisions, tested without React or a network.
// ---------------------------------------------------------------------------

/** The shape api.js's load() throws for a non-ok response. */
function httpError(status) {
  return Object.assign(new Error(`${status} whatever`), { status })
}

/** The real rejection value fetch produces when our own budget aborts it. */
function abortError() {
  const ac = new AbortController()
  ac.abort()
  return ac.signal.reason
}

test('the 12s budget firing is transient — that IS the failure we are recovering from', () => {
  const err = abortError()
  assert.equal(err.name, 'AbortError', 'the fixture stopped being a real abort reason')
  assert.equal(isTransientError(err), true)
})

test('a network-level fetch failure is transient', () => {
  // undici rejects with exactly this when the connection never lands.
  assert.equal(isTransientError(new TypeError('fetch failed')), true)
})

test('5xx and 429 are transient; every other 4xx is permanent', () => {
  for (const s of [500, 502, 503, 504, 429]) {
    assert.equal(isTransientError(httpError(s)), true, `${s} should be retried`)
  }
  for (const s of [400, 401, 403, 404, 409, 422]) {
    assert.equal(
      isTransientError(httpError(s)),
      false,
      `${s} will answer the same way forever — retrying it is pure noise`,
    )
  }
})

test('an error carrying no status and no known name is not retried', () => {
  assert.equal(isTransientError(new SyntaxError('Unexpected token < in JSON')), false)
  assert.equal(isTransientError(new Error('something')), false)
  assert.equal(isTransientError(null), false)
  assert.equal(isTransientError(undefined), false)
})

test('retry delays are 2s then 8s, spread by full jitter', () => {
  // rng is injected so the bounds are asserted, not sampled.
  assert.equal(retryDelayMs(1, () => 0), 1000, 'floor of attempt 1 is base x0.5')
  assert.equal(retryDelayMs(1, () => 1), 3000, 'ceiling of attempt 1 is base x1.5')
  assert.equal(retryDelayMs(2, () => 0), 4000)
  assert.equal(retryDelayMs(2, () => 1), 12000)
  assert.equal(retryDelayMs(1, () => 0.5), 2000, 'the midpoint is the un-jittered base')
  assert.equal(retryDelayMs(2, () => 0.5), 8000)
})

test('real jitter stays inside the stated windows', () => {
  for (let i = 0; i < 500; i++) {
    const first = retryDelayMs(1)
    assert.ok(first >= 1000 && first <= 3000, `attempt 1 gave ${first}ms`)
    const second = retryDelayMs(2)
    assert.ok(second >= 4000 && second <= 12000, `attempt 2 gave ${second}ms`)
  }
})

test('there is no third retry — the terminal state is what the manual button needs', () => {
  assert.equal(retryDelayMs(3), null)
  assert.equal(retryDelayMs(4), null)
  assert.equal(retryDelayMs(99), null)
  assert.equal(retryDelayMs(0), null, 'attempts are counted from 1')
})

test('the second wait exceeds the worst measured cold load', () => {
  // Grounded in the sample set at the top of this file: a server that just
  // failed to answer inside 12s is not healthy 500ms later, so the final
  // attempt waits longer than one whole worst-case load (7.49s).
  assert.ok(
    retryDelayMs(2, () => 0.5) > MEASURED_WORST_COLD_MS,
    'the last attempt fires before the server could even have finished a slow load',
  )
})

// ---------------------------------------------------------------------------
// Retry wiring inside useApi
//
// `npm test` is bare `node --test`: no DOM, no renderer, no testing-library,
// and adding one is out of scope here. So these drive the REAL hook by swapping
// React's own hook dispatcher for a ~50-line one below. That gives genuine
// mount / re-render / unmount semantics — which is the whole point, because the
// behaviour under test IS the effect cleanup.
// ---------------------------------------------------------------------------

const reactInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((value, i) => Object.is(value, b[i]))
}

/** Mount a hook, get back its latest return value plus rerender/unmount. */
function mountHook(renderHook) {
  const slots = []
  const pendingEffects = []
  let cursor = 0
  let mounted = true
  let flushing = false
  let result

  const dispatcher = {
    useState(initial) {
      const slot = (slots[cursor] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      })
      cursor++
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!mounted || Object.is(value, slot.value)) return // React's bail-out
          slot.value = value
          render()
        },
      ]
    },
    useRef(initial) {
      const slot = (slots[cursor] ??= { current: initial })
      cursor++
      return slot
    },
    useCallback(fn, deps) {
      const slot = (slots[cursor] ??= {})
      cursor++
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps
        slot.fn = fn
      }
      return slot.fn
    },
    useEffect(fn, deps) {
      const slot = (slots[cursor] ??= { ran: false })
      cursor++
      if (slot.ran && sameDeps(slot.deps, deps)) return
      slot.ran = true
      slot.deps = deps
      slot.next = fn
      pendingEffects.push(slot)
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = (slots[cursor] ??= { ran: false })
      cursor++
      if (!slot.ran) {
        slot.ran = true
        slot.cleanup = subscribe(() => render())
      }
      return getSnapshot()
    },
  }

  function render() {
    cursor = 0
    const previous = reactInternals.H
    reactInternals.H = dispatcher
    try {
      result = renderHook()
    } finally {
      reactInternals.H = previous
    }
    flushEffects()
  }

  function flushEffects() {
    if (flushing) return // a setState inside an effect re-enters; the loop below catches it
    flushing = true
    try {
      while (pendingEffects.length) {
        const slot = pendingEffects.shift()
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = slot.next()
      }
    } finally {
      flushing = false
    }
  }

  render()

  return {
    get current() {
      return result
    },
    rerender: render,
    unmount() {
      mounted = false
      for (const slot of slots) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = null
      }
    },
  }
}

/** Let every queued promise callback run. Timers stay under the test's control. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

const jsonOk = (body) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
const jsonStatus = (code, body) => () =>
  Promise.resolve(new Response(JSON.stringify(body ?? { error: 'no' }), { status: code }))

/**
 * Freeze the clock, the jitter and the network. rng 0 puts every retry at the
 * bottom of its window (1000ms then 4000ms), so the ticks below are exact.
 */
function harness(t, plan) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.mock.method(Math, 'random', () => 0)
  const calls = []
  const realFetch = globalThis.fetch
  const realWindow = globalThis.window
  const vaultEvents = []
  globalThis.fetch = (url) => {
    calls.push(url)
    const step = plan[Math.min(calls.length - 1, plan.length - 1)]
    return step(url)
  }
  globalThis.window = { dispatchEvent: (e) => vaultEvents.push(e.type) }
  t.after(() => {
    globalThis.fetch = realFetch
    globalThis.window = realWindow
  })
  return { calls, vaultEvents }
}

test('a transient failure retries itself and the panel gets its data, with no reload', async (t) => {
  const { calls } = harness(t, [jsonStatus(500), jsonOk({ rows: 7 })])
  const hook = mountHook(() => useApi('/api/data'))
  await settle()

  assert.equal(calls.length, 1)
  assert.ok(hook.current.error, 'the first failure must still surface immediately')
  assert.equal(hook.current.retrying, true, 'and must say it is trying again')
  assert.equal(hook.current.loading, false, 'loading stays false — no call site sees a new state')

  t.mock.timers.tick(1000) // attempt 1 wait, rng pinned to the floor
  await settle()

  assert.equal(calls.length, 2)
  assert.deepEqual(hook.current.data, { rows: 7 })
  assert.equal(hook.current.error, null)
  assert.equal(hook.current.retrying, false)
  hook.unmount()
})

test('a 404 is never retried — it will answer the same way forever', async (t) => {
  const { calls } = harness(t, [jsonStatus(404)])
  const hook = mountHook(() => useApi('/api/gone'))
  await settle()
  t.mock.timers.tick(60_000)
  await settle()

  assert.equal(calls.length, 1, 'a permanent answer must cost exactly one request')
  assert.equal(hook.current.retrying, false)
  assert.ok(hook.current.error)
  hook.unmount()
})

test('a permanently dead feed stops at three requests, then sits in a terminal state', async (t) => {
  const { calls } = harness(t, [jsonStatus(500)])
  const hook = mountHook(() => useApi('/api/dead'))
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(calls.length, 2)
  t.mock.timers.tick(4000)
  await settle()
  assert.equal(calls.length, 3)

  t.mock.timers.tick(600_000)
  await settle()
  assert.equal(calls.length, 3, 'three attempts total is the cap, not a starting point')
  assert.equal(hook.current.retrying, false, 'terminal state — this is where the button belongs')
  assert.ok(hook.current.error)
  hook.unmount()
})

test('a polling feed gets no backoff retry — the poll IS its retry', async (t) => {
  const { calls } = harness(t, [jsonStatus(500)])
  const hook = mountHook(() => useApi('/api/hub', { poll: 30_000 }))
  await settle()

  t.mock.timers.tick(20_000) // past both backoff windows, short of the interval
  await settle()
  assert.equal(calls.length, 1, 'a backoff timer alongside the poll could double-fire')
  assert.equal(hook.current.retrying, false)

  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(calls.length, 2, 'the interval still recovers it on its own')
  hook.unmount()
})

test('a vault-locked 503 costs exactly one request and never reaches the retry path', async (t) => {
  const { calls, vaultEvents } = harness(t, [jsonStatus(503, { locked: true })])
  const hook = mountHook(() => useApi('/api/data'))
  await settle()
  t.mock.timers.tick(600_000)
  await settle()

  assert.equal(calls.length, 1, 'the locked vault must never be hammered')
  assert.deepEqual(vaultEvents, ['bx:vault-locked'])
  assert.equal(hook.current.error, null, 'locked is handled, not an error')
  assert.equal(hook.current.retrying, false)
  hook.unmount()
})

test('a success refills the attempt budget', async (t) => {
  const { calls } = harness(t, [jsonStatus(500), jsonOk({ ok: 1 }), jsonStatus(500)])
  const hook = mountHook(() => useApi('/api/data'))
  await settle()
  t.mock.timers.tick(1000) // retry -> success
  await settle()
  assert.equal(calls.length, 2)

  hook.current.refetch() // fails again
  await settle()
  assert.equal(hook.current.retrying, true)
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(calls.length, 4, 'the post-success failure got attempt 1, not attempt 3')
  hook.unmount()
})

test('retryFailedFeeds loads a failed feed again, including one that had given up', async (t) => {
  const { calls } = harness(t, [
    jsonStatus(500),
    jsonStatus(500),
    jsonStatus(500),
    jsonOk({ back: true }),
  ])
  const hook = mountHook(() => useApi('/api/dead'))
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  t.mock.timers.tick(4000)
  await settle()
  assert.equal(calls.length, 3, 'budget spent')

  retryFailedFeeds()
  t.mock.timers.tick(500) // the 0-500ms spread
  await settle()

  assert.equal(calls.length, 4)
  assert.deepEqual(hook.current.data, { back: true })
  hook.unmount()
})

test('unmounting cancels a scheduled retry — no request lands after the panel is gone', async (t) => {
  const { calls } = harness(t, [jsonStatus(500)])
  const hook = mountHook(() => useApi('/api/data'))
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(hook.current.retrying, true, 'a retry must actually be pending, or this proves nothing')

  hook.unmount()
  t.mock.timers.tick(600_000)
  await settle()

  assert.equal(calls.length, 1, 'a retry fired for a component that no longer exists')
})

test('changing the url cancels the retry queued for the old one', async (t) => {
  const { calls } = harness(t, [jsonStatus(500)])
  let url = '/api/first'
  const hook = mountHook(() => useApi(url))
  await settle()
  assert.deepEqual(calls, ['/api/first'])
  assert.equal(hook.current.retrying, true)

  url = '/api/second'
  hook.rerender()
  await settle()
  assert.deepEqual(calls, ['/api/first', '/api/second'])

  t.mock.timers.tick(600_000)
  await settle()
  assert.deepEqual(
    calls.filter((u) => u === '/api/first'),
    ['/api/first'],
    'a retry for the url this hook already left',
  )
  hook.unmount()
})

// ---------------------------------------------------------------------------
// adoptIfFresherThan — taking a result somebody else just fetched
//
// THE DEFECT. /api/data was fetched twice on every Overview load, ~294KB each:
// the header's ConnStatus at t=39ms and the Overview tab at t=331ms, measured on
// the live tenant 2026-08-27. Two components, same url, 261ms apart.
//
// These drive the real hook through the same dispatcher the retry tests above
// use, because what is under test is again effect lifetime: which requests go
// out, what is retained between them, and what is dropped on unmount.
// ---------------------------------------------------------------------------

// Small enough that a test can step past it with the mocked clock rather than
// sleeping, and the ratio to the request timings below is the same one the real
// 2000ms window has to the real 261ms gap.
const WINDOW = 200

test.beforeEach(() => __resetAdoptionForTests())

test('the second caller of a url adopts the first result instead of fetching it again', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 7 })])
  const first = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data'], 'the first caller fetches normally')

  const second = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data'], 'the second caller made no request of its own')
  assert.deepEqual(second.current.data, { rows: 7 }, 'and it still got the data')
  assert.equal(second.current.loading, false)
  assert.equal(second.current.error, null)

  first.unmount()
  second.unmount()
})

test('an adopted payload is a copy, so two panels cannot mutate each other', async (t) => {
  harness(t, [jsonOk({ rows: [1, 2, 3] })])
  const first = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  const second = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()

  assert.notEqual(second.current.data, first.current.data, 'not the same object')
  assert.deepEqual(second.current.data, first.current.data, 'but the same value')
  second.current.data.rows.push(4)
  assert.deepEqual(first.current.data.rows, [1, 2, 3], 'the first caller is untouched')

  first.unmount()
  second.unmount()
})

test('past the window, the second caller fetches for itself', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 7 }), jsonOk({ rows: 8 })])
  // performance.now is stubbed rather than mocked through t.mock.timers, because
  // harness() has already enabled those and enabling twice throws. Only the
  // clock the window is measured against needs to move — and that clock is the
  // monotonic one, not Date; see the note beside freshOk() for why.
  let now = 1_000_000
  t.mock.method(performance, 'now', () => now)
  const first = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()

  now += WINDOW + 1
  const second = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'], 'the stale result was not adopted')
  assert.deepEqual(second.current.data, { rows: 8 })

  first.unmount()
  second.unmount()
})

// The ordering guard. Responses do not settle in the order they were sent, and
// without a sequence number an older payload landing late would overwrite a
// newer one — after which the next caller adopts stale data believing it fresh.
test('a slow first response that lands after a fast second one is not adopted', async (t) => {
  let releaseSlow
  const slow = new Promise((r) => (releaseSlow = r))
  const { calls } = harness(t, [
    () => slow.then(() => new Response(JSON.stringify({ rows: 'stale' }), { status: 200 })),
    jsonOk({ rows: 'fresh' }),
  ])

  const a = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  const b = mountHook(() => useApi('/api/data', { adoptIfFresherThan: 0 })) // never adopts; always fetches
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'])
  assert.deepEqual(b.current.data, { rows: 'fresh' })

  releaseSlow()
  await settle()

  const c = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(
    c.current.data,
    { rows: 'fresh' },
    'the late-landing older request did not overwrite the newer result',
  )

  a.unmount()
  b.unmount()
  c.unmount()
})

// Failures are never published, so every caller fetches one for itself and the
// retry, failuresRef and feeds-registry paths stay exactly as they were.
test('a failure is never adopted — the next caller asks for itself', async (t) => {
  const { calls } = harness(t, [jsonStatus(500), jsonOk({ rows: 7 })])
  const first = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()
  assert.equal(first.current.error?.status, 500)

  const second = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'], 'the error was not shared')
  assert.deepEqual(second.current.data, { rows: 7 })

  first.unmount()
  second.unmount()
})

// A locked vault raises `bx:vault-locked` once per 503 received. Adopting a
// locked outcome would have suppressed the second caller's request AND its
// event, quietly halving the count. Locked results are not published, so the
// count is whatever it was before this option existed.
test('a locked vault still raises one event per caller, exactly as before', async (t) => {
  const { calls, vaultEvents } = harness(t, [jsonStatus(503, { locked: true })])
  const first = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()
  const second = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()

  assert.deepEqual(calls, ['/api/data', '/api/data'], 'the locked response was not shared')
  assert.deepEqual(vaultEvents, ['bx:vault-locked', 'bx:vault-locked'])

  first.unmount()
  second.unmount()
})

// The retention bound. Nothing is kept for a url no adopter is watching, which
// is what keeps the ~60 call sites that never opt in — several of which build
// their url out of user input, a filter box or a selected id — from seeding an
// unbounded map with one parsed payload per distinct string.
test('nothing is retained for a url that no adopter is watching', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 7 }), jsonOk({ rows: 8 })])
  const plain = mountHook(() => useApi('/api/data'))
  await settle()

  const adopter = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'], 'nothing was there to adopt')
  assert.deepEqual(adopter.current.data, { rows: 8 })

  plain.unmount()
  adopter.unmount()
})

// ...but sharing is by URL, not by caller, and that IS the intent: once some
// component has opted this url in, a plain caller's response is the same bytes
// and is worth adopting. Pinned explicitly, because the test above reads at a
// glance as though plain callers were excluded, and they are not.
test('once a url is watched, even a plain caller\'s result can be adopted', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 'from-adopter' }), jsonOk({ rows: 'from-plain' })])
  const adopter = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()

  // A second, non-opting caller of the same url fetches for itself and its
  // result becomes the current one.
  const plain = mountHook(() => useApi('/api/data'))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'])

  const later = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'], 'the plain caller\'s result was adoptable')
  assert.deepEqual(later.current.data, { rows: 'from-plain' })

  adopter.unmount()
  plain.unmount()
  later.unmount()
})

// F1's guard, stated as behaviour: a cached success is not adopted once a NEWER
// request has been started for the same url, even while it is inside the window.
// Recent is not the same as current.
test('a cached success is not adopted once a newer request has started', async (t) => {
  let releasePending
  const pending = new Promise((r) => (releasePending = r))
  const { calls } = harness(t, [
    jsonOk({ rows: 'first' }),
    () => pending.then(() => new Response(JSON.stringify({ rows: 'second' }), { status: 200 })),
    jsonOk({ rows: 'third' }),
  ])

  const a = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(a.current.data, { rows: 'first' })

  // Starts request #2 and leaves it in flight. adoptIfFresherThan 0 never adopts.
  const b = mountHook(() => useApi('/api/data', { adoptIfFresherThan: 0 }))
  await settle()
  assert.deepEqual(calls.length, 2)

  // The 'first' entry is still well inside the window, but it is no longer the
  // newest request started, so it must not be handed out.
  const c = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.equal(calls.length, 3, 'the superseded entry was not adopted')

  releasePending()
  await settle()
  a.unmount()
  b.unmount()
  c.unmount()
})

// F2's guard: the hook that DID the fetching must not be able to edit what the
// next adopter receives. The clone-on-adopt test covers the other direction.
test('the fetching hook cannot mutate what a later adopter receives', async (t) => {
  harness(t, [jsonOk({ rows: [1, 2, 3] })])
  const fetcher = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()

  fetcher.current.data.rows.push('scribbled')

  const adopter = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(adopter.current.data.rows, [1, 2, 3], 'the adopter got the response, not the edit')

  fetcher.unmount()
  adopter.unmount()
})

// The accepted cost, pinned so it is a decision rather than a surprise: a vault
// that locks inside the window is not noticed by the caller that adopts. See the
// block above adoptIfFresherThan in api.js for why that is survivable —
// /api/vault/status polls separately and is never adopted.
test('a vault that locks inside the window is missed by the adopting caller', async (t) => {
  const { calls, vaultEvents } = harness(t, [jsonOk({ rows: 7 }), jsonStatus(503, { locked: true })])
  const first = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(vaultEvents, [], 'nothing locked yet')

  const second = mountHook(() => useApi('/api/data', { poll: 30_000, adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data'], 'it adopted rather than discovering the lock')
  assert.deepEqual(vaultEvents, [], 'and so raised no event — this is the accepted cost')
  assert.deepEqual(second.current.data, { rows: 7 })

  first.unmount()
  second.unmount()
})

// A tenant's data must not outlive the components that asked for it.
test('the stored result is dropped when the last watcher unmounts', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 7 }), jsonOk({ rows: 8 })])
  const first = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  first.unmount()

  const later = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data', '/api/data'], 'the payload did not survive the unmount')
  assert.deepEqual(later.current.data, { rows: 8 })
  later.unmount()
})

// ...but it DOES survive while a second watcher is still mounted, or every
// tab switch away from Overview would throw away the header's copy.
test('the stored result survives one watcher leaving while another stays', async (t) => {
  const { calls } = harness(t, [jsonOk({ rows: 7 })])
  const a = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  const b = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  a.unmount()

  const c = mountHook(() => useApi('/api/data', { adoptIfFresherThan: WINDOW }))
  await settle()
  assert.deepEqual(calls, ['/api/data'], 'still exactly one request in total')
  assert.deepEqual(c.current.data, { rows: 7 })
  b.unmount()
  c.unmount()
})
