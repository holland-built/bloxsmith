// What Overview's morning briefing and Services board say, worked out once so
// they can never disagree. Everything here reads the feeds Overview already
// fetches. Nothing is estimated, and a feed that did not answer stays
// "not checked" rather than becoming a 0 or a green mark.

import { feedState, isSuccess, windowLabel, withinWindow } from '../../lib/changes.js'

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
  if (k.startsWith('svc-')) return 'View services'
  if (k.startsWith('hosts')) return 'View hosts'
  if (k.startsWith('subnet')) return 'View subnets'
  if (k.startsWith('security-sitelist')) return 'Review list'
  if (k.startsWith('security')) return 'View events'
  if (k.startsWith('dns')) return 'View DNS'
  if (k.startsWith('dhcp')) return 'View leases'
  return 'Open'
}

/** "3 stopped · 25/28 up" as { up: 25, total: 28 }, or null. */
export function upCount(meta) {
  const m = /(\d+)\s*\/\s*(\d+)\s*up/.exec(meta || '')
  return m && +m[2] > 0 ? { up: +m[1], total: +m[2] } : null
}

/**
 * The page's one answer. A problem that is known is reported even while other
 * feeds are still loading. "All services healthy" needs every service to have
 * been checked in full and no open incident outside them (the board's Other
 * row). A source that was partial or failed keeps the page at "Status
 * unconfirmed" unless a real problem already makes it "Action required".
 */
export function pageVerdict(services, otherIssues = []) {
  const count = (test) => services.filter(test).length
  const total = services.length
  const act = count((s) => s.v.sev === 'crit')
  const look = count((s) => s.v.sev === 'warn')
  const checking = count((s) => s.v.word === 'Checking')
  const unchecked = count((s) => (s.v.sev === 'none' && s.v.word !== 'Checking') || (s.v.sev === 'warn' && s.b?.partial))
  const otherAct = otherIssues.filter((r) => r.sev === 'crit').length
  const otherLook = otherIssues.filter((r) => r.sev === 'warn').length
  const base = { total, act, look, checking, unchecked }
  const plural = (n) => (n === 1 ? 'services requires' : 'services require')
  const incidents = (n) => `${n} other ${n === 1 ? 'incident' : 'incidents'}`
  const line = (svc, other, need) => {
    if (!svc) return `${incidents(other)} ${other === 1 ? 'requires' : 'require'} ${need}`
    return `${svc} of ${total} ${plural(svc)} ${need}${other ? `, plus ${incidents(other)}` : ''}`
  }
  if (act || otherAct) return { ...base, tone: 'crit', word: 'Action required', line: line(act, otherAct, 'action') }
  if (unchecked) {
    const review = look + otherLook
    const also = review ? `, ${review} ${review === 1 ? 'item requires' : 'items require'} review` : ''
    return { ...base, tone: 'none', word: 'Status unconfirmed', line: `${unchecked} of ${total} services could not be fully checked${also}` }
  }
  if (look || otherLook) return { ...base, tone: 'warn', word: 'Review recommended', line: line(look, otherLook, 'review') }
  if (checking) return { ...base, tone: 'none', word: 'Checking', line: checking === total ? 'Checking services' : `${total - checking} of ${total} services checked` }
  return { ...base, tone: 'ok', word: 'All services healthy', line: `All ${total} services checked` }
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

/**
 * A service whose own health check is failing, as an open problem. This is the
 * same check that makes the service read Act or Look, so the two cannot differ.
 */
function healthProblem(b) {
  const st = b.state?.status
  if (st !== 'crit' && st !== 'warn') return null
  const up = upCount(b.state.meta)
  const title = up ? `${b.name} services: ${up.up} of ${up.total} up` : `${b.name} services: ${b.state.statusLabel || 'not healthy'}`
  return { key: `svc-${b.name}`, sev: st, title, sub: b.state.meta || '', href: '#infra', ask: `Which ${b.name} services are not running?`, seen: null, health: true, partial: b.state.availability === 'partial' }
}

/** Everything open on one service: its failing health check, then its incidents. */
export function openProblems(b) {
  const health = healthProblem(b)
  return health ? [health, ...b.issues] : b.issues
}

/**
 * The "New issues" line. "None" is only said when every source was read and
 * every open problem has a date, because an undated or unread problem could be
 * new. Takes the ranked list from rankProblems.
 */
export function newIssuesWords({ problems, allRead, reading, nowS }) {
  if (reading) return 'Checking…'
  const undated = problems.filter((r) => typeof r.seen !== 'number').length
  if (!canTellNew(problems, nowS)) {
    return undated < problems.length ? 'Not yet available. Requires 24 hours of history.' : 'Not available. No dated issues on record.'
  }
  const complete = allRead && undated === 0
  const fresh = problems.filter((r) => r.isNew).length
  if (fresh) return `${fresh} opened in the last 24 hours${complete ? '' : ', counting dated issues only'}`
  if (complete) return 'None in the last 24 hours'
  if (!allRead) return 'Not yet available. Some sources could not be read.'
  return `None among dated issues. ${undated} ${undated === 1 ? 'issue has' : 'issues have'} no date.`
}

/** Every open problem, worst first, each with the one action that fixes it. */
export function rankProblems(board, nowS) {
  const all = board.board.flatMap((b) => openProblems(b).map((r) => ({ ...r, service: b.name })))
  const provable = canTellNew(all, nowS)
  return all
    .map((r) => ({ ...r, action: ACTION(r.key), isNew: provable && typeof r.seen === 'number' && nowS - r.seen < DAY_S }))
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || KIND_RANK(a.key) - KIND_RANK(b.key))
}

/** DNS traffic now against the oldest hour in the feed, with the real gap. */
export function dnsTrend(dns) {
  const failed = !!dns.error || dns.data?.status === 'error'
  if (dns.loading && !dns.data) return { state: 'loading' }
  if (failed) return { state: 'error' }
  const rows = (dns.data?.rows ?? []).filter((r) => Number.isFinite(Number(r.avg_value)))
  if (!rows.length) return { state: 'empty' }
  const now = Number(rows.at(-1).avg_value)
  const was = rows.length > 1 ? Number(rows[0].avg_value) : null
  const hours = rows.length > 1 ? Math.round((new Date(rows.at(-1).hour) - new Date(rows[0].hour)) / 3600000) : null
  const pct = was > 0 && Number.isFinite(hours) && hours > 0 ? Math.round(((now - was) / was) * 100) : null
  return { state: 'ok', now, was, hours, pct }
}

// The server writes the literal "unknown" when no status code was recorded
// (normAudit). That and a blank are no outcome at all, so never a failure.
const hasNoResult = (row) => ['', 'unknown'].includes(String(row?.result ?? '').trim().toLowerCase())

/** The change log over the last day, saying how far back it really reaches. */
export function changeSummary(audit, nowMs) {
  const rows = withinWindow(audit.data?.rows, nowMs)
  const state = feedState({ payload: audit.data, error: audit.error, loading: audit.loading, rowsInWindow: rows })
  // Capped, yet no row has a usable date: the period covered is unknown, and
  // "nothing changed" would be false.
  if (state === 'empty' && audit.data?.truncated === true) return { state: 'undetermined' }
  if (state !== 'ok') return { state }
  const win = windowLabel({ truncated: audit.data?.truncated === true, rows, nowMs })
  return {
    state,
    total: rows.length,
    people: rows.filter((r) => r.who_kind === 'person').length,
    failed: rows.filter((r) => !isSuccess(r) && !hasNoResult(r)).length,
    noResult: rows.filter(hasNoResult).length,
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
