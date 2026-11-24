// The Failed Lookups panel (Dns tab): /api/csp/dns-failures?window=, as words
// for the screen.
//
// A failed or missing read is "not checked", never 0. A group the server could
// not count is "couldn't tell", and so is a read that came back with no rows,
// which can mean nothing failed or that DNS logging sent nothing. A real zero,
// from a read with rows, is shown as 0. Which records a number came from is said in
// one short line (csp dns_failures.go picks them by the window).

import { reading } from './dnsCompare.js'

export const NOT_CHECKED = 'not checked'
export const CANT_TELL = "couldn't tell"
export const NO_RECORDS = 'Infoblox returned no failed lookups for this time. Nothing may have failed, or DNS logging may not be sending data.'

export const FAILURE_WINDOWS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this week', label: 'This week' },
  { value: 'last 30 days', label: 'Last 30 days' },
]

export const FAILURE_CODES = [
  { key: 'nxdomain', label: 'Name not found (NXDOMAIN)', tip: 'The name asked for does not exist. Often typing errors, old settings or software looking for names that were never there.' },
  { key: 'servfail', label: 'Server failed (SERVFAIL)', tip: 'The server could not get an answer at all, often because another DNS server did not reply.' },
  { key: 'refused', label: 'Refused (REFUSED)', tip: 'The server would not answer this client, usually because the client is not allowed to ask it.' },
  { key: 'other', label: 'Other', tip: 'Any other failure code, such as NOTAUTH.' },
]

// Where the numbers came from. Every number in the panel is for the time
// picked, whichever source the server read (dns_failures.go passes the window
// as the query's date range). The line used to say "From the last 3 days of
// failure records", naming how long those records are kept, and under "Today"
// it read as though the numbers covered 3 days (2026-11-24).
export const SOURCE_LINE = {
  failure_records: 'the failed-lookup records',
  query_logs: 'the query logs',
}
const sourceLine = (source, window) => {
  const from = SOURCE_LINE[source]
  if (!from) return null
  const label = FAILURE_WINDOWS.find((w) => w.value === window)?.label ?? window
  return `Every number is for ${label.toLowerCase()}, from ${from}.`
}

// Remembered per viewer, in this browser, like the other panel settings.
export const WINDOW_KEY = 'bloxsmith:dns-failures-window'

const isWindow = (w) => FAILURE_WINDOWS.some((x) => x.value === w)

/** The saved window, or Today. Storage may be missing or switched off. */
export function readWindow(storage = globalThis.localStorage) {
  try {
    const w = storage?.getItem(WINDOW_KEY)
    return isWindow(w) ? w : 'today'
  } catch {
    return 'today'
  }
}

export function saveWindow(w, storage = globalThis.localStorage) {
  try {
    storage?.setItem(WINDOW_KEY, w)
  } catch { /* storage off: the pick lasts for this visit */ }
}

export function failuresUrl(w) {
  return `/api/csp/dns-failures?window=${encodeURIComponent(w)}`
}

export function fmtCount(n) {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * The feed for `window`, shaped for the panel:
 * { state, total, codes, names, namesText, note, source }.
 * state is 'loading', 'error' (nothing could be read) or 'ok'. total and each
 * code are { value, text }; names is a list of { name, count, text } or null
 * when its read failed, with namesText saying why.
 */
export function failuresView(feed, window) {
  if (feed?.loading && !feed?.data) return { state: 'loading' }
  const d = feed?.error ? null : feed?.data
  // An answer for another window (or none) is not this window's answer.
  const mine = d && d.window === window ? d : null
  const codesOk = mine && mine.codes_status === 'ok'
  const num = (v) => {
    if (!codesOk) return { value: null, text: NOT_CHECKED }
    const n = reading(v)
    return n == null ? { value: null, text: CANT_TELL } : { value: n, text: fmtCount(n) }
  }
  // No names is not proof that nothing failed.
  const namesOk = mine && mine.names_status === 'ok' && Array.isArray(mine.names) && mine.names.length > 0
  const namesRead = mine && mine.names_status === 'ok' && Array.isArray(mine.names)
  return {
    state: !mine || (mine.status === 'error' && !namesRead) ? 'error' : 'ok',
    total: num(mine?.total),
    codes: FAILURE_CODES.map((c) => ({ ...c, ...num(mine?.codes?.[c.key]) })),
    names: namesOk
      ? mine.names.map((r) => {
        const n = reading(r.count)
        return { name: String(r.name ?? ''), count: n, text: n == null ? CANT_TELL : fmtCount(n) }
      })
      : null,
    namesText: namesOk ? null : namesRead ? CANT_TELL : NOT_CHECKED,
    note: mine?.status === 'empty' ? NO_RECORDS : null,
    source: sourceLine(mine?.source, window),
  }
}
