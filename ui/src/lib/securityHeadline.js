// The headline numbers at the top of Security: "am I under attack, and what
// needs action". Every number here is read from a feed the page already loads;
// nothing is fetched or estimated for the headline.
//
// A tile's value is null when its feed is loading, failed, or not set up, so a
// missing number shows as a dash or a word and never as a reassuring 0.
// `tone` is set only when the number is a problem worth a look, so healthy
// tiles stay pale and the eye lands on the bad one.

import { isSample, sampleScopeNote } from './sampleCount.js'

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—')

function feedState(feed, dead) {
  if (feed.loading && !feed.data) return 'loading'
  if (dead) return 'failed'
  return 'ok'
}

// Critical and high events, from the same counts the severity legend shows.
function attacks(hub) {
  const d = hub.data ?? {}
  const state = feedState(hub, !!hub.error || d.availability === 'error')
  const value = state === 'ok' ? (d.counts?.critical ?? 0) + (d.counts?.high ?? 0) : null
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
      state === 'ok' ? `${n(d.counts?.critical ?? 0)} critical, ${n(d.counts?.high ?? 0)} high` : null,
      sampleScopeNote(d, 'events'),
    ].filter(Boolean).join(' · '),
  }
}

// Threat events the policy blocked. Good news, so it is never coloured.
function blocked(hub) {
  const d = hub.data ?? {}
  const state = feedState(hub, !!hub.error || d.availability === 'error')
  return {
    key: 'blocked',
    panelId: 'security-response-summary',
    label: 'Blocked',
    value: state === 'ok' ? d.blocked ?? 0 : null,
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
  const state = feedState(feed, !!feed.error || !!d.unavailable)
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
  const state = feedState(feed, !!feed.error || p.availability === 'error')
  const rows = p.data?.rows ?? []
  const total = p.data?.total_available
  const known = state === 'ok' && p.availability === 'ok' && typeof total === 'number'
  const value = state !== 'ok' ? null : known ? total : p.data?.count ?? rows.length
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
  const state = notSetUp ? 'notSetUp' : feedState(feed, !!feed.error || !!d.unavailable)
  return {
    key: 'credentials',
    panelId: 'security-axur-incidents',
    label: 'Credentials',
    value: state === 'ok' ? d.total_credentials ?? 0 : null,
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
