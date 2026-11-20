// The DNS health numbers from /api/csp/dns-health, as words for the screen.
//
// Each metric comes back on its own: status 'ok' with a value, 'empty' (the
// read worked but there were no readings), or 'error' (the read failed). A
// failed or missing read is "not checked" and no readings is "no readings",
// never a 0 or a dash that looks like one. Units were checked on the live
// tenant (csp.go dnsHealthMetrics): answer times are seconds, shares are
// 0-100, timeouts are per second.

import { reading } from './dnsCompare.js'

export const NOT_CHECKED = 'not checked'
export const NO_READINGS = 'no readings'

/** Seconds as milliseconds, with enough digits to stay honest when tiny. */
export function fmtAnswerTime(sec) {
  const ms = sec * 1000
  if (ms === 0) return '0 ms'
  if (ms < 0.1) return 'under 0.1 ms'
  if (ms < 10) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms).toLocaleString()} ms`
}

/** A 0-100 share. One decimal under 10%, whole numbers above. */
export function fmtShare(pct) {
  if (pct > 0 && pct < 0.1) return 'under 0.1%'
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

/** Timeouts per second. */
export function fmtPerSecond(v) {
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} a second`
}

const FORMAT = { seconds: fmtAnswerTime, percent: fmtShare, per_second: fmtPerSecond }

/**
 * One metric from the feed: { state, value, text }. state is 'loading',
 * 'ok', 'empty' or 'error'; text is what to print.
 */
export function healthMetric(feed, key) {
  if (feed?.loading && !feed?.data) return { state: 'loading', value: null, text: 'Loading…' }
  const m = feed?.error ? null : feed?.data?.metrics?.[key]
  if (!m || m.status === 'error') return { state: 'error', value: null, text: NOT_CHECKED }
  const v = reading(m.value)
  if (m.status !== 'ok' || v == null) return { state: 'empty', value: null, text: NO_READINGS }
  const fmt = FORMAT[m.unit]
  if (!fmt) return { state: 'error', value: null, text: NOT_CHECKED }
  return { state: 'ok', value: v, text: fmt(v) }
}

/** A per-host reading (from metrics[key].hosts) by host id or name, as text. */
export function hostMetricText(feed, key, hostIds) {
  const m = feed?.data?.metrics?.[key]
  if (!m || m.status === 'error' || feed?.error) return NOT_CHECKED
  const row = (m.hosts ?? []).find((h) => hostIds.includes(h.host) || hostIds.includes(h.host_name))
  const v = reading(row?.value)
  if (v == null) return NO_READINGS
  return (FORMAT[m.unit] ?? String)(v)
}

/** True when any metric reports per-host readings. */
export function hasPerHost(feed, keys) {
  return keys.some((k) => (feed?.data?.metrics?.[k]?.hosts ?? []).length > 0)
}

/**
 * Which of `keys` come back per host and which only for the whole account,
 * decided metric by metric: one metric with host rows must not turn another
 * that has only an account-wide reading into a column of "no readings".
 */
export function splitPerHost(feed, keys) {
  const perHost = keys.filter((k) => hasPerHost(feed, [k]))
  return { perHost, accountWide: keys.filter((k) => !perHost.includes(k)) }
}

/** The hosts named in the per-host rows of `keys`, once each, by host id. */
export function dnsHosts(feed, keys) {
  const by = new Map()
  for (const k of keys) {
    for (const h of feed?.data?.metrics?.[k]?.hosts ?? []) {
      if (h?.host && !by.has(h.host)) by.set(h.host, { host: h.host, host_name: h.host_name || h.host })
    }
  }
  return [...by.values()]
}

// Per-host CPU and memory from /api/host-metrics rows, one row per host, plus
// a row for every host in `extraHosts` (hosts with DNS readings) that sent no
// CPU or memory, so a host with any reading is listed. A missing or
// non-number reading stays null, shown as "not checked".
export function hostLoadRows(metrics, extraHosts = []) {
  const by = new Map()
  for (const h of extraHosts) by.set(h.host, { host: h.host, host_name: h.host_name || h.host, cpu: null, memory: null })
  for (const m of metrics ?? []) {
    const row = by.get(m.host) ?? { host: m.host, host_name: m.host_name || m.host, cpu: null, memory: null }
    if (m.metric_name === 'host_cpu') row.cpu = typeof m.avg_value === 'number' ? m.avg_value : null
    if (m.metric_name === 'host_memory') row.memory = typeof m.avg_value === 'number' ? m.avg_value : null
    by.set(m.host, row)
  }
  // Busiest first; hosts with no CPU reading last.
  return [...by.values()].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || String(a.host_name).localeCompare(String(b.host_name)))
}
