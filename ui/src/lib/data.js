import { useMemo } from 'react'
import { useApi } from './api.js'

// Per-tab slice selection for /api/data.
//
// A tab that shows one slice used to wait for all twelve upstream calls
// (measured: ~9s cold) to read one of them (~0.3s). `useData(['auditLogs'])`
// asks the server for just that slice.
//
// The honesty rule this module exists to enforce. The server answers a
// narrowed request with EXACTLY the slices it read: a slice nobody asked for
// is absent from both the payload and `_meta`. There is no fourth status word
// for "not requested" — the statuses are still exactly ok / empty / error.
// Absence is dangerous precisely because today's panels render "no rows and
// status !== 'error'" as <Empty/>, i.e. "you have none". Two rules make that
// impossible:
//
//   1. Requested but missing => 'error'. If the tab asked for auditLogs and the
//      key is not there, the read did not deliver. That renders the feed's
//      unavailable notice, never the empty state. (Same fail-loud default the
//      server already uses for a missing _meta key in signals.go.)
//   2. Not requested can never be read. The accessors below only answer for
//      slices the tab DECLARED; anything else throws, so an unrequested slice
//      cannot reach a status-rendering panel at all — not as empty, not as
//      error.

// The ?only= vocabulary, mirroring dataSlices in go/internal/dashboard/dashboard.go.
// A name outside this list is a 400 from the server; catching it here turns
// that into a loud developer error instead of a failed request at runtime.
export const KNOWN_SLICES = [
  'subnets', 'leases', 'dnsViews', 'zones', 'hosts', 'secPolicies', 'feeds', 'auditLogs',
]

// The guard below is a programming-error check, so it runs where programming
// errors get caught — dev servers and tests — and is compiled out of a
// production build. `import.meta.env` is Vite's (DEV false only in a real
// build); under bare `node --test` it does not exist and the guard stays on.
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || null
export const GUARD_ENABLED = ENV ? !!ENV.DEV : true

/** URL for a narrowed /api/data read. Sorted so one slice list is one URL. */
export function sliceUrl(slices) {
  if (GUARD_ENABLED) {
    const bad = [...slices].filter((s) => !KNOWN_SLICES.includes(s))
    if (bad.length) {
      throw new Error(
        `useData: /api/data has no slice named ${bad.map((s) => `"${s}"`).join(', ')}. ` +
          `The server rejects it with a 400 rather than returning a thinner payload; known slices: ${KNOWN_SLICES.join(', ')}.`,
      )
    }
  }
  return `/api/data?only=${[...slices].sort().join(',')}`
}

/**
 * Read one slice out of an /api/data payload.
 *
 * Returns { rows, status } where status is the server's own ok/empty/error —
 * except that a payload which does not contain the slice at all yields
 * 'error'. That is the requested-but-missing rule: we asked, nothing came
 * back, and a panel must say the feed is unavailable rather than "you have
 * none". A null payload (still loading, or a failed fetch) is the same case.
 */
export function sliceState(payload, name) {
  const rows = payload?.[name]
  const status = payload?._meta?.[name]
  if (!Array.isArray(rows) || typeof status !== 'string') {
    return { rows: [], status: 'error' }
  }
  return { rows, status }
}

/**
 * Accessors bound to one tab's DECLARED slice list.
 *
 * Asking for anything else throws: there is no honest answer for a slice that
 * was never requested, and returning one would let it render as empty ("you
 * have none") or as error ("it broke") — both lies about data nobody read.
 */
export function sliceAccessors(declared, payload) {
  const allowed = new Set(declared)
  const check = (name) => {
    if (GUARD_ENABLED && !allowed.has(name)) {
      throw new Error(
        `useData: slice "${name}" was not requested by this tab (declared: ${[...allowed].join(', ') || 'none'}). ` +
          'Add it to the useData() list — a slice that was never asked for has no honest state to render.',
      )
    }
  }
  return {
    rows: (name) => { check(name); return sliceState(payload, name).rows },
    status: (name) => { check(name); return sliceState(payload, name).status },
  }
}

/**
 * Fetch only the /api/data slices this tab shows.
 *
 * Returns { loading, error, data, rows(name), status(name), refetch }.
 *
 * Honest scope: this shortens the TAB's wait, not the server's work. The
 * header's connection pill (ConnStatus) still polls the full /api/data every
 * 60s from every tab and genuinely reads subnets/hosts/leases, so the full
 * aggregate is still built in the background — and, via the server's
 * projection bridge, a warm full entry answers these narrowed asks for free.
 */
export function useData(slices, opts) {
  const url = useMemo(() => sliceUrl(slices), [slices.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const api = useApi(url, opts)
  const accessors = useMemo(() => sliceAccessors(slices, api.data), [slices.join(',') , api.data]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...api, ...accessors }
}
