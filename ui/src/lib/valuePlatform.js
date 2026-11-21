// The Value page's platform numbers from /api/csp/value-platform, as words for
// the screen.
//
// Each number comes back on its own: status 'ok' with a value, 'empty' (the
// read worked but there were no readings), 'error' (the read failed) or
// 'unavailable' (this tenant can't give it; reason is the sentence to show). A failed read is
// "not checked", never a 0. Units were checked on the live demo tenant
// (go/internal/dashboard/value_platform.go).

import { reading } from './dnsCompare.js'
import { fmtShare } from './dnsHealth.js'

export const NOT_CHECKED = 'not checked'
export const NO_READINGS = 'no readings'

/** A whole count in plain words: 5,744 / 25.4 million. */
export function fmtCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`
  return Math.round(n).toLocaleString('en-US')
}

const FORMAT = { queries: fmtCount, addresses: fmtCount, devices: fmtCount, percent: fmtShare }

export const DHCP_HA_NOTE = 'High-availability pairs each count an address, so this figure can be up to twice the number of devices served.'

// What each number is, in the order shown, with one plain line under it.
export const PLATFORM_ROWS = [
  ['queries', 'Queries answered', 'DNS queries answered by your servers.'],
  ['cache_hit', 'Answers from cache', 'Share of DNS queries answered from cache, without an external lookup.'],
  ['uptime', 'DNS server uptime', 'Share of time your DNS servers were running.'],
  ['dhcp_assigned', 'DHCP addresses assigned', 'Addresses your DHCP servers assigned to devices.'],
  ['roaming', 'Roaming devices protected', 'Devices protected by the roaming client for at least part of this period.'],
]

/** One metric as { state, value, text }. state: loading, ok, empty, error or unavailable. */
export function platformMetric(feed, key) {
  if (feed?.loading && !feed?.data) return { state: 'loading', value: null, text: 'Loading…' }
  const m = feed?.error ? null : feed?.data?.metrics?.[key]
  if (!m || m.status === 'error') return { state: 'error', value: null, text: NOT_CHECKED }
  if (m.status === 'unavailable') {
    return { state: 'unavailable', value: null, text: m.reason || 'Not available on this tenant.' }
  }
  const v = reading(m.value)
  if (m.status !== 'ok' || v == null) return { state: 'empty', value: null, text: NO_READINGS }
  const fmt = FORMAT[m.unit]
  if (!fmt) return { state: 'error', value: null, text: NOT_CHECKED }
  return { state: 'ok', value: v, text: fmt(v) }
}

/** The uptime per-host list as [{ name, text }], sorted as the server sent it. */
export function uptimeHosts(feed) {
  const m = feed?.error ? null : feed?.data?.metrics?.uptime
  if (!m || m.status !== 'ok') return []
  return (m.hosts ?? []).map((h) => {
    const v = reading(h.value)
    return { name: h.host_name || h.host, text: v == null ? NO_READINGS : fmtShare(v) }
  })
}

/** Every row for the panel: label, line, the metric, and the extra note or hosts. */
export function platformRows(feed) {
  return PLATFORM_ROWS.map(([key, label, line]) => ({
    key,
    label,
    line,
    ...platformMetric(feed, key),
    note: key === 'dhcp_assigned' ? DHCP_HA_NOTE : null,
    hosts: key === 'uptime' ? uptimeHosts(feed) : [],
  }))
}
