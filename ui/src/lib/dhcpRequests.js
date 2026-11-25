// The DHCP Requests panel (Network tab): /api/csp/dhcp-requests, as words for
// the screen. Each total stands alone. A failed or missing read is
// "not checked" and a read with no samples is "no readings", never 0.
//
// The numbers are totals of counts taken every 5 minutes (checked on the live
// tenant, csp dhcp_requests.go), so they are shown as whole counts.

import { reading } from './dnsCompare.js'

export const NOT_CHECKED = 'not checked'
export const NO_READINGS = 'no readings'

export const DHCP_REQUEST_ROWS = [
  { key: 'discover', label: 'Requests for an address', tip: 'DHCP DISCOVER messages: a device on the network asking for an address.' },
  { key: 'no_address', label: 'Requests that got no address', tip: 'Requests your DHCP servers did not give an address to, for example because the range was full.' },
]

export const DHCP_REQUEST_WINDOWS = [
  { key: 'today', label: 'Today' },
  { key: 'last_30_days', label: 'Last 30 days' },
]

export const HA_NOTE = 'If your DHCP servers work in pairs, one backing up the other, both answer each request, so these counts can be up to twice the devices asking.'

/** One total: { state, value, text }. state is 'loading', 'ok', 'empty' or 'error'. */
export function dhcpTotal(feed, metric, window) {
  if (feed?.loading && !feed?.data) return { state: 'loading', value: null, text: 'Loading…' }
  const t = feed?.error ? null : feed?.data?.metrics?.[metric]?.[window]
  if (!t || t.status === 'error') return { state: 'error', value: null, text: NOT_CHECKED }
  const v = reading(t.value)
  if (t.status !== 'ok' || v == null) return { state: 'empty', value: null, text: NO_READINGS }
  return { state: 'ok', value: v, text: Math.round(v).toLocaleString('en-US') }
}
