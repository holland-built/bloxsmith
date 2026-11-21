// What the three trial looks for Overview (?variant=a, b, c) show, worked out
// once so they can never disagree. Everything here reads the feeds Overview
// already fetches. Nothing is estimated, and a feed that did not answer stays
// "not checked" rather than becoming a 0 or a green mark.

import { feedState, isFailure, windowLabel, withinWindow } from '../../lib/changes.js'

const DAY_S = 86400
const SEV_RANK = { crit: 0, warn: 1, note: 2 }

// Within a severity, what stops people working comes before what will later.
const KIND_RANK = (key) => {
  const k = String(key)
  if (k.startsWith('svc-')) return 0
  if (k.startsWith('hosts')) return 1
  if (k.startsWith('subnet')) return 2
  if (k.startsWith('security')) return 3
  return 4
}

const ACTION = (key) => {
  const k = String(key)
  if (k.startsWith('svc-')) return 'See services'
  if (k.startsWith('hosts')) return 'See hosts'
  if (k.startsWith('subnet')) return 'See subnets'
  if (k.startsWith('security-sitelist')) return 'Review list'
  if (k.startsWith('security')) return 'See events'
  if (k.startsWith('dns')) return 'See DNS'
  if (k.startsWith('dhcp')) return 'See leases'
  return 'Open'
}

/** "3 stopped · 25/28 up" as { up: 25, total: 28 }, or null. */
export function upCount(meta) {
  const m = /(\d+)\s*\/\s*(\d+)\s*up/.exec(meta || '')
  return m && +m[2] > 0 ? { up: +m[1], total: +m[2] } : null
}

/**
 * The page's one answer. A problem that is known is reported even while other
 * feeds are still loading. "All OK" needs every service to have been checked.
 */
export function pageVerdict(services) {
  const count = (test) => services.filter(test).length
  const total = services.length
  const act = count((s) => s.v.sev === 'crit')
  const look = count((s) => s.v.sev === 'warn')
  const checking = count((s) => s.v.word === 'Checking')
  const unchecked = count((s) => s.v.sev === 'none' && s.v.word !== 'Checking')
  const base = { total, act, look, checking, unchecked }
  const plural = (n) => (n === 1 ? 'services needs' : 'services need')
  if (act) return { ...base, tone: 'crit', word: 'Not OK', line: `${act} of ${total} ${plural(act)} action` }
  if (look) return { ...base, tone: 'warn', word: 'Needs a look', line: `${look} of ${total} ${plural(look)} a look` }
  if (checking) return { ...base, tone: 'none', word: 'Checking', line: checking === total ? 'Checking your services' : `${total - checking} of ${total} services checked` }
  if (unchecked) return { ...base, tone: 'none', word: "Can't confirm", line: `${unchecked} of ${total} services could not be checked` }
  return { ...base, tone: 'ok', word: 'All OK', line: `All ${total} services checked` }
}

/**
 * Whether "new since yesterday" can be proven. Bloxsmith dates an issue from
 * when it first saw it, so on an install younger than a day everything looks
 * new. Only an issue already on record over a day ago proves the record is
 * long enough to tell.
 */
export function canTellNew(issues, nowS) {
  const seen = issues.map((r) => r.seen).filter((t) => typeof t === 'number')
  return seen.length > 0 && nowS - Math.min(...seen) >= DAY_S
}

/** Every open problem, worst first, each with the one action that fixes it. */
export function rankProblems(board, nowS) {
  const issues = board.board.flatMap((b) => b.issues.map((r) => ({ ...r, service: b.name })))
  const provable = canTellNew(issues, nowS)
  const health = board.board.flatMap((b) => {
    const st = b.state?.status
    if (st !== 'crit' && st !== 'warn') return []
    const up = upCount(b.state.meta)
    const title = up ? `${b.name} services: ${up.up} of ${up.total} up` : `${b.name} services: ${b.state.statusLabel || 'not healthy'}`
    return [{ key: `svc-${b.name}`, sev: st, title, sub: b.state.meta || '', href: '#infra', ask: `Which ${b.name} services are not running?`, service: b.name, seen: null, partial: b.state.availability === 'partial' }]
  })
  return [...health, ...issues]
    .map((r) => ({ ...r, action: ACTION(r.key), isNew: provable && typeof r.seen === 'number' && nowS - r.seen < DAY_S }))
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || KIND_RANK(a.key) - KIND_RANK(b.key))
}

/**
 * Cells for a service's status strip. Up to 60 servers get one cell each.
 * Larger counts are a share of 60 cells, and any real problem keeps one cell.
 */
export function stripCells(service) {
  const up = upCount(service.b?.state?.meta)
  if (up && up.total <= 60) return { count: up.total, bad: up.total - up.up, exact: true }
  if (up) return { count: 60, bad: up.up === up.total ? 0 : Math.max(1, Math.round((1 - up.up / up.total) * 60)), exact: false }
  const n = service.b?.n
  const of = service.b?.of
  if (typeof n === 'number' && typeof of === 'number' && of > 0) {
    return { count: 60, bad: n > 0 ? Math.max(1, Math.round((n / of) * 60)) : 0, exact: false }
  }
  return null
}

/** DNS traffic now against the oldest hour in the feed, with the real gap. */
export function dnsTrend(dns) {
  const failed = !!dns.error || dns.data?.status === 'error'
  if (dns.loading && !dns.data) return { state: 'loading', bars: [] }
  if (failed) return { state: 'error', bars: [] }
  const rows = (dns.data?.rows ?? []).filter((r) => Number.isFinite(Number(r.avg_value)))
  if (!rows.length) return { state: 'empty', bars: [] }
  const bars = rows.map((r) => ({ hour: r.hour, value: Number(r.avg_value) }))
  const now = bars.at(-1).value
  const was = bars.length > 1 ? bars[0].value : null
  const hours = bars.length > 1 ? Math.round((new Date(bars.at(-1).hour) - new Date(bars[0].hour)) / 3600000) : null
  const pct = was > 0 && Number.isFinite(hours) && hours > 0 ? Math.round(((now - was) / was) * 100) : null
  return { state: 'ok', bars, now, was, hours, pct, max: Math.max(...bars.map((b) => b.value)) }
}

/** The change log over the last day, saying how far back it really reaches. */
export function changeSummary(audit, nowMs) {
  const rows = withinWindow(audit.data?.rows, nowMs)
  const state = feedState({ payload: audit.data, error: audit.error, loading: audit.loading, rowsInWindow: rows })
  if (state !== 'ok') return { state }
  const win = windowLabel({ truncated: audit.data?.truncated === true, rows, nowMs })
  return {
    state,
    total: rows.length,
    people: rows.filter((r) => r.who_kind === 'person').length,
    failed: rows.filter(isFailure).length,
    capped: win.capped,
    window: win.text,
    tip: win.tip,
  }
}

/** Licenses that run out within 90 days. An unreadable date is not "fine". */
export function licenseSummary(licenses, nowMs) {
  if (licenses.loading && !licenses.data) return { state: 'loading' }
  if (licenses.error || licenses.data?.status === 'error') return { state: 'error' }
  const rows = licenses.data?.licenses ?? []
  if (!rows.length) return { state: 'empty' }
  const days = rows.map((l) => {
    const t = l.expiry ? Date.parse(l.expiry) : NaN
    return Number.isNaN(t) ? null : (t - nowMs) / 86400000
  })
  return {
    state: 'ok',
    total: rows.length,
    expired: days.filter((d) => d !== null && d < 0).length,
    soon: days.filter((d) => d !== null && d >= 0 && d <= 90).length,
    undated: days.filter((d) => d === null).length,
  }
}
