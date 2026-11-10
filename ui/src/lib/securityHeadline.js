// The headline numbers at the top of Security: "am I under attack, and what
// needs action". Every number here is read from a feed the page already loads;
// nothing is fetched or estimated for the headline.
//
// A tile's value is null when its feed is loading, failed, not set up, or
// answered without the field the tile counts, so a missing number shows as a
// word and never as a reassuring 0. A field that is absent, null or not a
// finite number is never read as 0.
// `tone` is set only when the number is a problem worth a look, so healthy
// tiles stay pale and the eye lands on the bad one.

import { isSample, sampleScopeNote } from './sampleCount.js'

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—')
const fin = Number.isFinite
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 'ok' only with a payload in hand, no failure, and the field this tile
// counts present as usable data (`usable`). Anything else is 'failed', which
// the tile shows as Unknown.
function feedState(feed, dead, usable) {
  if (feed.loading && !feed.data) return 'loading'
  if (dead || !isObj(feed.data) || !usable) return 'failed'
  return 'ok'
}

// Critical and high events, from the same counts the severity legend shows.
function attacks(hub) {
  const d = hub.data ?? {}
  const state = feedState(hub, !!hub.error || d.availability === 'error', fin(d.counts?.critical) && fin(d.counts?.high))
  const value = state === 'ok' ? d.counts.critical + d.counts.high : null
  const sample = state === 'ok' && isSample(d)
  return {
    key: 'attacks',
    panelId: 'security-triage-inbox',
    label: 'Critical or high',
    value,
    unit: 'events',
    state,
    // On a capped page the count covers only the latest events, so the tile
    // says so on screen: a 0 here is not "no attacks today".
    right: sample ? `latest ${n(d.returned ?? d.events?.length)}` : null,
    tone: value > 0 ? 'crit' : null,
    tip: [
      state === 'ok' ? `${n(d.counts.critical)} critical, ${n(d.counts.high)} high` : null,
      sampleScopeNote(d, 'events'),
    ].filter(Boolean).join(' · '),
  }
}

// Threat events the policy blocked. Good news, so it is never coloured.
function blocked(hub) {
  const d = hub.data ?? {}
  const state = feedState(hub, !!hub.error || d.availability === 'error', fin(d.blocked))
  return {
    key: 'blocked',
    panelId: 'security-response-summary',
    label: 'Blocked',
    value: state === 'ok' ? d.blocked : null,
    unit: 'events',
    state,
    right: null,
    tone: null,
    tip: ['Threat events your security policy blocked', sampleScopeNote(d, 'events')].filter(Boolean).join(' · '),
  }
}

// Lookalike domains flagged as suspicious, out of all those detected.
function lookalikes(feed) {
  const d = feed.data ?? {}
  const rows = Array.isArray(d.domains) ? d.domains : []
  const state = feedState(feed, !!feed.error || !!d.unavailable, Array.isArray(d.domains))
  const value = state === 'ok' ? rows.filter((r) => r.suspicious).length : null
  return {
    key: 'lookalikes',
    panelId: 'security-lookalike-domains',
    label: 'Suspicious lookalikes',
    value,
    unit: '',
    state,
    right: state === 'ok' ? `of ${n(rows.length)}` : null,
    tone: value > 0 ? 'warn' : null,
    tip: 'Marked suspicious, out of all the lookalikes detected',
  }
}

// Exposures reported upstream. The total when upstream
// gave one; otherwise the rows that arrived, and the tile says "loaded".
function exposures(feed) {
  const p = feed.data ?? {}
  const rows = p.data?.rows
  const total = p.data?.total_available
  const count = p.data?.count
  // The reported total when there is one; otherwise the rows that arrived,
  // counted by `count` or by the rows themselves. None of the three is Unknown.
  const loaded = fin(count) ? count : Array.isArray(rows) ? rows.length : null
  const state = feedState(feed, !!feed.error || p.availability === 'error', fin(total) || loaded !== null)
  const known = state === 'ok' && p.availability === 'ok' && fin(total)
  const value = state !== 'ok' ? null : known ? total : loaded
  return {
    key: 'exposures',
    panelId: 'security-exposures',
    label: 'Exposures',
    value,
    unit: '',
    state,
    right: state === 'ok' && !known && value > 0 ? 'loaded' : null,
    tone: null,
    tip: known ? 'All exposures reported' : 'Exposures loaded; the full total was not reported',
  }
}

// Supplier credentials exposed, from Axur. Not set up is its own word.
function credentials(feed) {
  const d = feed.data ?? {}
  const notSetUp = !feed.error && d.configured === false
  const state = notSetUp ? 'notSetUp' : feedState(feed, !!feed.error || !!d.unavailable, fin(d.total_credentials))
  return {
    key: 'credentials',
    panelId: 'security-axur-incidents',
    label: 'Credentials',
    value: state === 'ok' ? d.total_credentials : null,
    unit: 'exposed',
    state,
    right: state === 'ok' && Array.isArray(d.vendors) ? `${n(d.vendors.length)} suppliers` : null,
    tone: null,
    tip: 'Credentials exposed across the suppliers Axur monitors',
  }
}

export function securityHeadline({ hub, lookalikes: look, exposures: exp, axur }) {
  return [attacks(hub), blocked(hub), lookalikes(look), exposures(exp), credentials(axur)]
}
