// What Overview's morning briefing and Services board say, worked out once so
// they can never disagree. Everything here reads the feeds Overview already
// fetches. Nothing is estimated, and a feed that did not answer stays
// "not checked" rather than becoming a 0 or a green mark.

import { SEV_WORD } from '../../lib/severity.js'

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

// An incident about subnets is about subnets whatever its key, the same rule
// Overview's rowOf uses to put it on the IPAM row.
const ACTION = (key, entity) => {
  const k = String(key)
  if (k.startsWith('svc-')) return 'View services'
  if (k.startsWith('hosts')) return 'View hosts'
  if (k.startsWith('subnet') || entity === 'subnet') return 'View subnets'
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
 * unconfirmed" unless a real problem already makes it "Needs action".
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
  if (act || otherAct) return { ...base, tone: 'crit', word: SEV_WORD.crit, line: line(act, otherAct, 'action') }
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
  return { key: `svc-${b.name}`, sev: st, title, sub: b.state.meta || '', href: `#infra?service=${encodeURIComponent(b.name)}&status=down`, ask: `Which ${b.name} services are not running?`, seen: null, health: true, partial: b.state.availability === 'partial' }
}

/**
 * Subnets 90% full or more with no incident raised for them yet. The IPAM tile
 * reads Review on that count alone (Overview.jsx verdict), so it is an open
 * problem too, or the tile would say Review over an empty list and row.
 */
function fullProblem(b) {
  if (b.name !== 'IPAM' || !(b.n > 0) || b.issues.some((r) => r.sev === 'crit' || r.sev === 'warn')) return null
  const title = `${b.n.toLocaleString()} ${b.n === 1 ? 'subnet is' : 'subnets are'} 90% full or more`
  return { key: 'subnet-full', sev: 'warn', title, sub: '', href: b.href, ask: 'Which subnets are nearly full?', seen: null, health: true }
}

/** Everything open on one service: its failing health check, then its incidents. */
export function openProblems(b) {
  const extra = [healthProblem(b), fullProblem(b)].filter(Boolean)
  return extra.length ? [...extra, ...b.issues] : b.issues
}

/**
 * What the attention list says when it is empty. "No items" needs every
 * service checked; when none could be checked at all, the list proves nothing.
 */
export function emptyListWords(services, verdict) {
  if (verdict.tone === 'ok') return 'No items require attention.'
  const none = services.length > 0 && services.every((s) => s.v.word === 'Not checked' || s.v.word === 'Unavailable')
  return none ? 'No services could be checked, so issues may be missing from this list.' : 'No issues found so far.'
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
    if (undated < problems.length) return 'Not yet available. Requires 24 hours of history.'
    // Nothing dated and not every source read: nothing was checked, which is
    // not the same as an empty record.
    return allRead ? 'Not available. No dated issues on record.' : 'Not checked'
  }
  const complete = allRead && undated === 0
  const fresh = problems.filter((r) => r.isNew).length
  if (fresh) return `${fresh} opened in the last 24 hours${complete ? '' : ', counting dated issues only'}`
  if (complete) return 'None in the last 24 hours'
  if (!allRead) return 'Not yet available. Some sources could not be read.'
  return `None among dated issues. ${undated} ${undated === 1 ? 'issue has' : 'issues have'} no date.`
}

// "View subnets" must open the subnets, not the incident list. 70: where the
// server starts raising subnet incidents (signals.go), as inboxRows' own link
// for subnet-utilization does.
const subnetHref = (r) => (r.entity === 'subnet' && r.href === '#incidents' ? { href: '#network?minUtil=70&links=1' } : {})

/** Every open problem, worst first, each with the one action that fixes it. */
export function rankProblems(board, nowS) {
  const all = board.board.flatMap((b) => openProblems(b).map((r) => ({ ...r, service: b.name })))
  const provable = canTellNew(all, nowS)
  return all
    .map((r) => ({ ...r, ...subnetHref(r), action: ACTION(r.key, r.entity), isNew: provable && typeof r.seen === 'number' && nowS - r.seen < DAY_S }))
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || KIND_RANK(a.key) - KIND_RANK(b.key))
}

/** "vs 2h ago": how far back a DNS change is measured, from dnsTrend's hours. */
export function vsWords(hours) {
  return Number.isFinite(hours) && hours > 0 ? `vs ${hours}h ago` : 'vs first hour'
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

const rate = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1))
const hoursAgo = (h) => `${h} ${h === 1 ? 'hour' : 'hours'} ago`

/** "13.1 queries/s, up 50% since 23 hours ago (was 8.7)", from dnsTrend. */
export function trendWords(t) {
  if (t.state === 'loading') return 'Loading…'
  if (t.state !== 'ok') return t.state === 'error' ? 'Not checked' : 'No traffic reported'
  if (t.pct == null) return `${rate(t.now)} queries/s, no earlier value for comparison`
  const dir = t.pct === 0 ? 'unchanged' : `${t.pct > 0 ? 'up' : 'down'} ${Math.abs(t.pct)}%`
  // A no-break space keeps "(was 8.7)" on one line.
  return `${rate(t.now)} queries/s, ${dir} since ${hoursAgo(t.hours)} (was\u00a0${rate(t.was)})`
}

/**
 * The change log over the whole last 24 hours, from /api/csp-audit-count,
 * which counts every row rather than the newest 500. A read that failed is
 * "unavailable", never 0. When counting stopped at its ceiling or time budget
 * the totals are a floor, and the words say "more than".
 */
export function changeSummary(count) {
  if (count.loading && !count.data) return { state: 'loading' }
  const d = count.data
  if (count.error || !d || d.status !== 'ok' || !Number.isFinite(d.total)) return { state: 'unavailable' }
  if (d.complete === true && d.total === 0) return { state: 'empty' }
  const complete = d.complete === true
  return {
    state: 'ok',
    complete,
    total: d.total,
    people: d.people ?? 0,
    failed: d.failed ?? 0,
    noResult: d.no_result ?? 0,
    tip: complete ? null : `Counting stopped at ${d.total.toLocaleString()} changes, ${d.stopped_by === 'time' ? 'when it ran out of time' : 'its upper limit'}, so the real number is higher. The count still covers the whole 24 hours.`,
  }
}

/** "3,412 in the last 24 hours, 41 of them by users", from changeSummary. */
export function changeWords(c) {
  if (c.state === 'loading') return 'Loading…'
  if (c.state === 'unavailable') return 'Not checked'
  if (c.state === 'empty') return 'No changes logged in 24 hours'
  if (!c.complete) return `More than ${c.total.toLocaleString()} in the last 24 hours, at least ${c.people.toLocaleString()} of them by users`
  const failed = c.failed ? `, ${c.failed.toLocaleString()} failed` : ''
  const noResult = c.noResult ? `, ${c.noResult.toLocaleString()} with no result reported` : ''
  return `${c.total.toLocaleString()} in the last 24 hours, ${c.people.toLocaleString()} of them by users${failed}${noResult}`
}

/**
 * The attention list's heading, which carries the page's verdict: "Needs
 * action" and "8 items across 4 of 5 services". A state with nothing listed
 * keeps the verdict's own line.
 */
export function listHeading(verdict, problems, services) {
  const base = { tone: verdict.tone, word: verdict.word, detail: verdict.line }
  if (!problems.length || (verdict.tone !== 'crit' && verdict.tone !== 'warn')) return base
  const names = new Set(services.map((s) => s.name))
  const hit = new Set(problems.map((r) => r.service).filter((n) => names.has(n))).size
  const items = `${problems.length} ${problems.length === 1 ? 'item' : 'items'}`
  return { ...base, detail: hit ? `${items} across ${hit} of ${services.length} services` : items }
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
