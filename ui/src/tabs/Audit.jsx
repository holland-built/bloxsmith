import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { chainRows, eventTally, readShortfall } from '../lib/auditChain.js'
import { sampleCountLabel } from '../lib/sampleCount.js'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'

// A refusal and an error are the two event kinds an operator scans for, so they
// are the two that get a colour. Everything else is one neutral tone rather than
// a palette: there are six event kinds on this tenant today and no fixed set, so
// colour-per-kind would mean a legend that changes shape with the data.
function eventColor(event, COLORS) {
  if (/refused|denied|rbac/.test(event)) return COLORS.warn
  if (/error|unreadable|failed|orphaned/.test(event)) return COLORS.crit
  return COLORS.ok
}

function fmtTs(ts) {
  const d = new Date(ts)
  return isNaN(d) ? String(ts ?? '—') : d.toLocaleString()
}

// mono, single-line, clipped timestamp cell (reused by both tables)
function monoTs(v) {
  const s = fmtTs(v)
  return (
    <span className="block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[12px]" style={{ maxWidth: 180 }} title={s}>
      {s}
    </span>
  )
}

// The chain's `ts` is float epoch SECONDS and the portal feed's is an ISO
// string; lib/auditChain.js resolves both to `_ms` so the cell and the sort
// comparator can no longer disagree. A row with no usable time renders a dash
// rather than a date nobody can defend. See that file's header for the 1970 bug.
function chainTs(_v, row) {
  return row._ms == null ? <span className="text-dim">—</span> : monoTs(row._ms)
}

// ---------- main ----------

// ONE fetch of /api/audit/log, owned here and handed to both panels that read
// it, so the summary and the table can never describe different reads of the
// same log. It used to be fetched inside AuditTable for the chain verdict alone.
//
// THIS TAB NO LONGER READS /api/data (issue #168). It asked for the `auditLogs`
// slice, which is the INFOBLOX PORTAL audit feed at `_limit: 100`
// (go/internal/dashboard/dashboard.go:625, whose own comment says so) — and the
// summary and the "Bloxsmith actions" table both rendered it, under a
// chain-integrity verdict belonging to a log that was never on screen. The
// portal feed is still on this tab, once, in the panel that says it is external
// and fetches it at five times the limit with a search box.
//
// The slice itself is left alone: it is still served, still declared in
// lib/data.js, and no tab consumes it now. Wiring it up somewhere useful, or
// retiring it, is its own decision and not this fix's to take.
export default function Audit() {
  const chain = useApi('/api/audit/log', { poll: 30000 })
  const entries = useMemo(() => chainRows(chain.data?.entries), [chain.data])

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-3">Audit</h1>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="audit">
        <ActivitySummary panelId="audit-activity-summary" entries={entries} chain={chain} />
        <AuditTable panelId="audit-log" entries={entries} chain={chain} />
        <CspAuditTable panelId="audit-csp-portal" />
      </CardGrid>
    </div>
  )
}

// ---------- activity summary ----------

// Every panel below distinguishes four states, and they are four because
// collapsing any pair of them is how a fault reads as a fact:
//
//   loading            — a skeleton, never an empty list
//   chain.error        — the feed is unavailable; NOT "nothing happened"
//   readShortfall(...) — the feed answered and the list under it is short
//   entries.length 0   — a log that was read and is genuinely empty
//
// The third is the one that did not exist before: /api/audit/log returned 200
// with a shortened or empty `entries` when the file could not be read or held
// lines that would not decode, and only the chain-integrity line mentioned it.
// See go/internal/server/state.go and lib/auditChain.js:readShortfall.
function ShortRead({ chain }) {
  const { COLORS } = useChartTheme()
  const note = readShortfall(chain.data)
  if (!note) return null
  return (
    <div className="text-[12px] font-medium mb-2" style={{ color: COLORS.warn }}>
      this list is incomplete — {note}
    </div>
  )
}

// A ROW PER KIND, NOT A BAR CHART, and the swap was forced by looking at it.
//
// This panel drew a CategoryBars of the tally. Rendered against the live log it
// was worse than useless: event names run to 23 characters
// ("write-refused-read-only"), recharts drops X-axis ticks that would collide,
// and what survived was three labels spread under six bars — so the 382-tall
// bar for `write-authorized` sat above the words "write-refused-read-only".
// A label under the wrong bar is the same defect this whole panel was fixed
// for, arrived at from the other direction.
//
// The old chart worked because its categories were CREATE / UPDATE / DELETE:
// three, short, and fixed. Event kinds are none of those. A ranked list keeps
// every name beside its own number at any length, and it drops recharts from
// this tab's critical path entirely.
const KINDS_SHOWN = 5

function ActivitySummary({ entries, chain, panelId }) {
  const { COLORS } = useChartTheme()
  const tally = useMemo(() => eventTally(chain.data?.entries), [chain.data])

  // The kinds past the cut are summed into one row rather than dropped, so the
  // rows still add up to the count in the header. A list that silently stops at
  // five describes a subset of the number printed beside it.
  const rows = useMemo(() => {
    const shown = tally.slice(0, KINDS_SHOWN).map((t) => ({ ...t, color: eventColor(t.event, COLORS) }))
    const rest = tally.slice(KINDS_SHOWN)
    if (rest.length) {
      shown.push({
        event: `${rest.length} other kind${rest.length === 1 ? '' : 's'}`,
        count: rest.reduce((n, t) => n + t.count, 0),
        color: COLORS.other,
      })
    }
    return shown
  }, [tally, COLORS])

  const total = entries.length
  const biggest = rows.length ? Math.max(...rows.map((r) => r.count)) : 0

  return (
    <Card
      panelId={panelId}
      span={2}
      title="Activity Summary"
      right={<span className="text-[11px] text-muted">{total.toLocaleString()} recorded {total === 1 ? 'event' : 'events'}</span>}
    >
      <ShortRead chain={chain} />
      {chain.loading ? (
        <Skeleton h={200} />
      ) : chain.error ? (
        <FeedUnavailable label="Audit log unavailable" />
      ) : total === 0 ? (
        <Empty />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.event}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[12px] truncate" title={r.event}>{r.event}</span>
                <span className="text-[13px] font-semibold tabular-nums" style={{ color: r.color }}>
                  {r.count.toLocaleString()}
                </span>
              </div>
              {/* Proportion of the largest row, so the shape of the log is
                  readable at a glance. It is scaled to the biggest kind rather
                  than to the total: with one kind at 382 and four at 1, bars
                  scaled to 837 would all render as the same invisible sliver. */}
              <div className="h-1.5 rounded-full bg-field overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${biggest ? Math.max((r.count / biggest) * 100, 1) : 0}%`, background: r.color }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ---------- local audit log table ----------

function EventPill({ event }) {
  const { COLORS } = useChartTheme()
  const color = eventColor(event || '', COLORS)
  return (
    <span className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: `${color}22`, color }}>
      {event || '—'}
    </span>
  )
}

// The audit chain hashes each entry to the one before it AND signs each entry
// with a key held outside the log's directory, with a separately sealed record
// of how many entries there should be — so an edited, deleted or truncated log
// is detectable by something an attacker with write access cannot recompute.
// /api/audit/log carries that verdict as three states: chain_valid true
// (intact), chain_valid false + broken_index (tampered), or chain_verify_error
// (the check itself could not run). A fetch failure is folded into the same
// "could not verify" state — it must never be allowed to read as "chain is
// fine" just because nothing loaded.
//
// The reason strings matter here. "could not verify" covers a lost or rotated
// key as well as an unreadable file, and an operator who sees it needs to know
// which — so chain_verify_error is shown, not just its existence. Likewise
// broken_reason distinguishes a forged entry from a truncated tail.
// The verdict above is produced by the same program that writes the log, which
// is the one thing an operator cannot independently rely on. This names the
// command that answers the same question with nothing running — read-only, on a
// copied log, on another machine. It is not decoration: without it, an operator
// has no way to know the option exists.
function OfflineCheckHint() {
  return (
    <span className="text-dim">
      {' · check it yourself with '}
      <code className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-field">bloxsmith audit verify</code>
    </span>
  )
}

function ChainVerdict({ result, error, loading }) {
  const { COLORS } = useChartTheme()
  if (loading) return null
  if (error || result == null || result.chain_verify_error) {
    const why = error ? 'the check could not be loaded' : result?.chain_verify_error
    return (
      <div className="text-[12px] font-medium mb-2" style={{ color: COLORS.warn }}>
        chain integrity could not be verified
        {why ? <span className="font-normal text-dim"> — {why}</span> : null}
        <span className="font-normal"><OfflineCheckHint /></span>
      </div>
    )
  }
  if (result.chain_valid === false) {
    return (
      <div className="text-sm font-semibold mb-2" style={{ color: COLORS.crit }}>
        chain tampered — broken at entry #{result.broken_index}
        {result.broken_reason ? <span className="font-normal text-[12px]"> — {result.broken_reason}</span> : null}
        <span className="font-normal text-[12px]"><OfflineCheckHint /></span>
      </div>
    )
  }
  if (result.chain_valid === true) {
    return (
      <div className="text-[11px] text-dim mb-2">
        chain intact — signature and entry count verified
        <OfflineCheckHint />
      </div>
    )
  }
  // Unrecognized shape: same rule as a fetch failure — don't imply "fine".
  return (
    <div className="text-[12px] font-medium mb-2" style={{ color: COLORS.warn }}>
      chain integrity could not be verified
    </div>
  )
}

// Entries the server could NOT write. This is a different fact from the chain
// verdict above and is deliberately not folded into it: a refused append leaves
// the chain on disk genuinely intact, because the entry was never written and
// nothing was tampered with. Saying "tampered" here would be an accusation
// nobody made, and saying "intact" alone would let a shorter list of entries
// read as a quiet day.
//
// HONEST LIMIT: append_failures is an in-memory counter scoped to "since this
// process started". A restart resets it to 0 and the banner disappears — the
// entry it was counting is still gone, and nothing on disk records that it ever
// existed. So this is a live warning, not an audit of past losses.
//
// Absent field (an older server that predates the counter) renders nothing at
// all — not an all-clear. Only a number greater than zero renders.
function AppendFailures({ result }) {
  const { COLORS } = useChartTheme()
  const n = result?.append_failures
  if (typeof n !== 'number' || n <= 0) return null
  const last = result.last_append_failure
  return (
    <div className="text-sm font-semibold mb-2" style={{ color: COLORS.crit }}>
      {n} audit record{n === 1 ? '' : 's'} failed to write since the server started
      {last?.event ? (
        <span className="font-normal text-[12px]">
          {' — last: '}
          <code className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-field">{last.event}</code>
          {last.error ? <span className="text-dim"> ({last.error})</span> : null}
        </span>
      ) : null}
      <span className="font-normal text-[12px] text-dim">
        {' · the chain on disk is unaffected; the missing record cannot be recovered'}
      </span>
    </div>
  )
}

function AuditTable({ entries, chain, panelId }) {
  const [filter, setFilter] = useState('')
  const [event, setEvent] = useState('')
  const [sort, setSort] = useState({ key: 'ts', dir: 'desc' })

  // The kinds actually present, so the selector cannot offer a filter that
  // matches nothing. The old one listed CREATE/UPDATE/DELETE, which are portal
  // vocabulary and appear in no entry this log has ever written.
  const kinds = useMemo(() => eventTally(chain.data?.entries).map((t) => t.event), [chain.data])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return entries.filter((r) => {
      if (event && r.event !== event) return false
      return !q || r._search.includes(q)
    })
  }, [entries, filter, event])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      if (key === 'ts') {
        // Nulls last in both directions: a row with no usable time is not older
        // than everything, it is unknown, and burying it at one end under a
        // sort the reader chose would hide it.
        if (a._ms == null || b._ms == null) return a._ms == null ? (b._ms == null ? 0 : 1) : -1
        return dir === 'asc' ? a._ms - b._ms : b._ms - a._ms
      }
      const av = String(a[key] ?? ''), bv = String(b[key] ?? '')
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return arr
  }, [filtered, sort])

  const columns = [
    { key: 'ts', label: 'Time', sortable: true, render: chainTs },
    {
      key: 'actor',
      label: 'Actor',
      sortable: true,
      render: (v) => (
        <span className="block truncate max-w-[140px]" title={v}>{v || '—'}</span>
      ),
    },
    { key: 'event', label: 'Event', sortable: true, render: (v) => <EventPill event={v} /> },
    {
      key: 'detail',
      label: 'Detail',
      sortable: true,
      render: (v) => (
        <span className="block truncate font-mono text-[11px]" title={v}>{v || '—'}</span>
      ),
    },
  ]

  return (
    <Card
      panelId={panelId}
      span={4}
      title="Audit Log"
      note="Bloxsmith actions"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-[150px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <select
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          >
            <option value="">All events</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          {/* The filtered count, and the set it was filtered FROM when they
              differ. A bare "37" beside a filter box reads as the size of the
              log rather than as the size of what the filter left. */}
          {sorted.length > 0 && (
            <span className="text-[11px] text-muted">
              {sorted.length.toLocaleString()}
              {sorted.length !== entries.length ? ` of ${entries.length.toLocaleString()}` : ''}
            </span>
          )}
        </div>
      }
    >
      <ChainVerdict result={chain.data} error={chain.error} loading={chain.loading} />
      <AppendFailures result={chain.data} />
      <ShortRead chain={chain} />
      {chain.loading ? (
        <Skeleton h={250} />
      ) : chain.error ? (
        <FeedUnavailable label="Audit log unavailable" />
      ) : entries.length === 0 ? (
        <Empty />
      ) : sorted.length === 0 ? (
        <Empty>no entries match</Empty>
      ) : (
        <DataTable
          rows={sorted}
          columns={columns}
          rowKey={(r) => r._key}
          rowCap={50}
          maxHeight={420}
          stickyHeader
          sort={sort}
          onSort={(next) =>
            setSort((s) => (s.key === next.key ? { key: next.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: next.key, dir: 'desc' }))
          }
        />
      )}
    </Card>
  )
}

// ---------- CSP portal audit ----------

function CspAuditTable({ panelId }) {
  const { COLORS } = useChartTheme()
  const [q, setQ] = useState('')
  const [result, setResult] = useState(null)
  // Starts true: the mount-time load below fires before first paint reads it,
  // so the panel shows the loading skeleton instead of a flash of "enter a
  // search" while that first fetch is in flight.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // The last query actually searched (not the live input) — distinguishes
  // "nothing here yet" (mount-time load, no query typed) from "your search
  // matched nothing" (the user typed a filter that matched zero rows).
  const [lastQuery, setLastQuery] = useState('')

  function runSearch(query) {
    const searched = query ?? q
    setLoading(true)
    setError(null)
    setLastQuery(searched)
    const params = new URLSearchParams()
    if (searched) params.set('q', searched)
    fetch(`/api/csp-audit?${params.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => setResult(j))
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  // Every other panel in this tab auto-loads; this one used to sit on a
  // "enter a search" prompt until the user guessed to click Search, even
  // though an empty query returns the last 500 rows of real activity
  // (csp.go CSPAudit — no clauses added when q is blank). Load recent
  // activity on mount; the search box then FILTERS that same feed.
  useEffect(() => {
    runSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = result?.rows ?? []

  const columns = [
    { key: 'ts', label: 'Time', render: monoTs },
    {
      key: 'user',
      label: 'Who',
      keep: true,
      render: (v, r) => (
        <span className="block truncate max-w-[160px]" title={r.user}>
          {r.user || '—'} {r.who_kind && <span className="text-dim text-[10.5px]">({r.who_kind})</span>}
        </span>
      ),
    },
    { key: 'action', label: 'Action' },
    { key: 'resource', label: 'Resource' },
    {
      key: 'result',
      label: 'Result',
      render: (v) => (
        <span className="line-clamp-2" style={{ color: /fail/i.test(v || '') ? COLORS.crit : COLORS.ok }}>{v || '—'}</span>
      ),
    },
  ]

  return (
    <Card
      panelId={panelId}
      span={6}
      title="CSP Portal Audit"
      note="external — Infoblox portal activity"
      right={
        <div className="flex items-center gap-2">
          <input
            placeholder="Search user or resource…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch(q)}
            className="w-[220px] px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none"
          />
          <button onClick={() => runSearch(q)} className="px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm">
            {loading ? 'Searching…' : 'Search'}
          </button>
          {/* `500` here is the `_limit` CSPAudit sends upstream, not a fact
              about the tenant (go/internal/dashboard/csp.go). The server has
              always returned `truncated` alongside the rows and this chip threw
              it away, printing the request cap as though it were the number of
              matching entries — the v3.67.5 defect, on a panel the sweep that
              found it had not reached.

              sampleCount.js reads `returned`, which this payload calls `count`;
              rows.length is that same number and is additionally what is on
              screen, so it is the one passed. There is no `total` to pass: the
              upstream tells us there are more and not how many. */}
          {rows.length > 0 && (
            <span className="text-[11px] text-muted">
              {sampleCountLabel({ returned: rows.length, truncated: result?.truncated }, 'entries')}
            </span>
          )}
        </div>
      }
    >
      {loading ? (
        <Skeleton h={250} />
      ) : error ? (
        <Empty>search failed</Empty>
      ) : rows.length === 0 ? (
        // csp.go:849-851 returns HTTP 200 with {rows:[],count:0,status:"error"}
        // on any upstream failure — a fetch that never actually searched must
        // not be reported with the same wording as a genuine empty result.
        result?.status === 'error' ? (
          <FeedUnavailable label="CSP audit feed unavailable" />
        ) : lastQuery ? (
          <Empty>no entries match</Empty>
        ) : (
          <Empty>nothing here yet</Empty>
        )
      ) : (
        <DataTable rows={rows} columns={columns} rowCap={150} maxHeight={420} stickyHeader />
      )}
    </Card>
  )
}
