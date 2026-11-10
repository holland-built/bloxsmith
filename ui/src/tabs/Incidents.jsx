import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useReadOnly } from '../lib/writeTarget.js'
import { ReadOnlyNote } from '../components/kit.jsx'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { fmtShortDay } from '../lib/chartFormat.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { categoryWord, plainMessage } from '../lib/plainWords.js'
import './Overview.css'
import './Incidents.css'

// ---------- severity vocab ----------
// Signals carry crit/warn/ok (this app) or critical/high/medium/low (upstream) —
// normalize both into one palette so chips, KPIs, and the table agree.
function sevMeta(s, COLORS) {
  const v = String(s || '').toLowerCase()
  if (v === 'crit' || v === 'critical') return { key: 'critical', label: 'Critical', color: COLORS.crit }
  if (v === 'high') return { key: 'high', label: 'High', color: COLORS.sevHigh }
  if (v === 'warn' || v === 'medium') return { key: 'medium', label: 'Medium', color: COLORS.warn }
  // info: a minor item such as unsigned public zones (signals.go).
  if (v === 'low' || v === 'info' || v === 'ok') return { key: 'low', label: 'Low', color: COLORS.accent }
  return { key: 'unknown', label: v || 'Unknown', color: COLORS.other }
}

// Sort rank so Critical > High > Medium > Low (ascending puts Critical first).
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }
function sevRank(s, COLORS) {
  return SEV_RANK[sevMeta(s, COLORS).key] ?? 4
}

// MCP IQ Actions carry priority (low/medium/high), not this app's severity vocab.
const PRIORITY_TO_SEVERITY = { low: 'low', medium: 'medium', high: 'high' }
function mcpSeverity(row) {
  if (row?.severity) return row.severity
  const p = String(row?.priority || '').toLowerCase()
  return PRIORITY_TO_SEVERITY[p] || 'low'
}

function ageLabel(epoch) {
  const t = Number(epoch)
  if (!t) return '—'
  const secs = Math.max(0, Date.now() / 1000 - t)
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

function SeverityPill({ severity }) {
  const { COLORS } = useChartTheme()
  const m = sevMeta(severity, COLORS)
  return (
    <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: `${m.color}22`, color: m.color }}>
      {m.label}
    </span>
  )
}

// ack identity: (category, entity_id, detected_at) — a re-broken entity is a new
// problem, not the one already dismissed (old app: incAckKey)
const ackKey = (s) => `${s.category}|${s.entity_id}|${Math.floor(Number(s.detected_at) || 0)}`

// Acks are kept in this browser so a reload or a tab switch doesn't undo them.
// Each one is dropped after 14 days, so the list can't grow forever.
const ACKS_KEY = 'bx:incident-acks'
const ACK_DAYS = 14
function loadAcks() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACKS_KEY) || '{}')
    const cutoff = Date.now() - ACK_DAYS * 86400000
    const out = {}
    for (const [k, at] of Object.entries(saved)) if (Number(at) > cutoff) out[k] = Number(at)
    return out
  } catch {
    return {}
  }
}
function saveAcks(acks) {
  try { localStorage.setItem(ACKS_KEY, JSON.stringify(acks)) } catch { /* storage off: acks last for this visit */ }
}

// ---------- main ----------

// Only the IQ action trend needs recharts, so only it waits for it.
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))

export default function Incidents() {
  const incApi = useApi('/api/incidents', { poll: 20000 })
  const actionsApi = useApi('/api/actions', { poll: 30000 })

  const [acks, setAcks] = useState(loadAcks)
  const [category, setCategory] = useState('')
  // A severity tile filters Triage the way a category chip does.
  const [severity, setSeverity] = useState('')
  const [openActionId, setOpenActionId] = useState(null)
  // per-action-id pending/error state for the resolve/reopen control (rows are independent)
  const [actionStatusState, setActionStatusState] = useState({})

  const categories = incApi.data?.incidents ?? []
  const signals = Array.isArray(incApi.data?.signals) ? incApi.data.signals : []
  // signals is capped server-side (SignalsCap); signals_total is the true pre-cap count.
  const signalsTotal = Number.isFinite(incApi.data?.signals_total) ? incApi.data.signals_total : signals.length
  const signalsTruncated = !!incApi.data?.signals_truncated
  // true when subnets/zones/leases — the feeds BuildSignals reads — didn't all
  // read cleanly; a zero-signal result under this condition is NOT a clean
  // estate, it's an unverified one (see dashboard.SignalsMeta).
  const signalsDegraded = !!incApi.data?.signals_degraded
  const incidentsMeta = incApi.data?._meta ?? {}

  const actionsRows = Array.isArray(actionsApi.data)
    ? actionsApi.data
    : actionsApi.data?.actions || actionsApi.data?.results || actionsApi.data?.data || []
  // FetchActions degrades to {actions:[], availability:"error"} on a
  // dead upstream — a genuinely empty tenant stays availability:"ok" with its
  // own "unavailable" NOTE string, so only the availability flag disambiguates.
  const actionsUnavailable = actionsApi.data?.availability === 'error'
  const actionsReason = actionsUnavailable ? actionsApi.data?.unavailable : undefined
  const retryActions = () => actionsApi.refetch()

  function toggleAck(s) {
    const k = ackKey(s)
    setAcks((p) => {
      const n = { ...p }
      if (n[k]) delete n[k]
      else n[k] = Date.now()
      saveAcks(n)
      return n
    })
  }

  async function setActionStatus(id, nextStatus) {
    setActionStatusState((p) => ({ ...p, [id]: { pending: true, error: null } }))
    try {
      const res = await fetch(`/api/actions/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })
      let body = null
      try { body = await res.json() } catch { /* non-json body */ }
      if (res.status === 403) {
        setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: 'operator required' } }))
        return
      }
      if (!res.ok || !body?.ok) {
        setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: body?.error || `failed (${res.status})` } }))
        return
      }
      // Not optimistic: only clear pending + drop error once the server confirms,
      // then let a refetch drive the real row status.
      setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: null } }))
      await actionsApi.refetch()
    } catch (e) {
      setActionStatusState((p) => ({ ...p, [id]: { pending: false, error: e?.message || 'network error' } }))
    }
  }

  return (
    <div data-layout="record" className="w-full px-6 py-5">
      <div className="ov-look inc-head">
        <div className="ov-head">
          <h1>Incidents</h1>
          <Updated api={incApi} />
        </div>
      </div>
      <CardGrid layoutKey="incidents">
        {/* The severity counts lead (owner, 2026-11-10): they sat under the
            whole Triage table, so the page's answer was the last thing on it.
            panelId sits on the wrapper, not on the Card: SeverityKpis renders a
            different Card on its error branch, and both are the same panel. */}
        <SeverityKpis panelId="incidents-severity" signals={signals} truncated={signalsTruncated} loading={incApi.loading} error={incApi.error} severity={severity} onSeverity={setSeverity} />
        <CategoryChips panelId="incidents-categories" categories={categories} signals={signals} truncated={signalsTruncated} loading={incApi.loading} error={incApi.error} category={category} onCategory={setCategory} degraded={signalsDegraded} meta={incidentsMeta} />
        <IncidentsTable
          panelId="incidents-triage"
          signals={signals}
          signalsTotal={signalsTotal}
          signalsTruncated={signalsTruncated}
          loading={incApi.loading}
          error={incApi.error}
          degraded={signalsDegraded}
          meta={incidentsMeta}
          category={category}
          onCategory={setCategory}
          severity={severity}
          onSeverity={setSeverity}
          acks={acks}
          onToggleAck={toggleAck}
          onClearAcks={() => { setAcks({}); saveAcks({}) }}
        />
        <SocQueue
          panelId="incidents-soc-queue"
          rows={actionsRows}
          loading={actionsApi.loading}
          error={actionsApi.error}
          unavailable={actionsUnavailable}
          reason={actionsReason}
          onRetry={retryActions}
          statusState={actionStatusState}
          onSetStatus={setActionStatus}
          openActionId={openActionId}
          onOpenAction={setOpenActionId}
        />
        <ActionTrendStrip panelId="incidents-action-volume" rows={actionsRows} loading={actionsApi.loading} error={actionsApi.error} unavailable={actionsUnavailable} reason={actionsReason} onRetry={retryActions} />
      </CardGrid>
    </div>
  )
}

// ---------- the head: when the list was last read ----------

// The same tip as Overview's: hover, keyboard focus or tap opens it, Escape
// closes it. The visible text stays the name; the tip is the description.
function Tip({ tip, children, className = '' }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span
      className={`ov-tipwrap ${className}`}
      tabIndex={0}
      aria-describedby={id}
      data-open={open || undefined}
      onClick={() => setOpen((o) => !o)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
    >
      {children}
      <span role="tooltip" id={id} className="ov-tip">{tip}</span>
    </span>
  )
}

// The time the incidents list arrived, not the time of this render. A failed
// refresh says so, and the time stays on the last list that did arrive.
function Updated({ api }) {
  const at = useMemo(() => (api.data ? new Date() : null), [api.data])
  const time = at ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const dot = api.error ? 'down' : at ? '' : 'wait'
  const text = api.error ? (time ? `Couldn't refresh · ${time}` : "Couldn't load") : time ? `Updated ${time}` : 'Loading…'
  return (
    <Tip className="ov-pill" tip="Incidents to triage, by category and severity. The list refreshes every 20 seconds.">
      <span aria-hidden="true" className={`ov-live ${dot}`} />
      {text}
    </Tip>
  )
}

// ---------- category chips ----------

// How a category's total splits by severity, counted from the same rows the
// Severity panel counts. The chip used to show only its worst severity beside
// the total, so "C 1,745" read as 1,745 critical when the Severity panel said
// 953. Null when the loaded rows cannot account for the whole total (the
// server capped the list, or the two disagree): a split that does not add up
// to the number beside it would be a second disagreement.
function categorySplit(category, count, signals, truncated, COLORS) {
  if (truncated) return null
  const n = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  let total = 0
  for (const s of signals) {
    if (s.category !== category) continue
    n[sevMeta(s.severity, COLORS).key]++
    total++
  }
  // Severity Counts has no cell for an unknown severity, so a split naming
  // one would count rows the panel beside it does not.
  if (total !== count || n.unknown) return null
  return Object.keys(n)
    .filter((k) => n[k])
    .map((k) => `${n[k].toLocaleString()} ${k}`)
    .join(', ')
}

function CategoryChips({ categories, signals = [], truncated = false, loading, error, category, onCategory, degraded, meta = {}, panelId }) {
  const { COLORS } = useChartTheme()
  const failed = Object.entries(meta).filter(([, v]) => v === 'error').map(([k]) => k)
  return (
    <Card panelId={panelId} span={6} title="Categories">
      {loading ? (
        <Skeleton h={40} />
      ) : error ? (
        // A failed /api/incidents leaves categories at [] — without this branch
        // a dead backend rendered "no active categories", i.e. all-clear.
        <FeedUnavailable
          label="Categories unavailable"
          reason={error.message ? `could not load incidents: ${error.message}` : 'could not load incidents'}
        />
      ) : categories.length === 0 && degraded ? (
        <FeedUnavailable
          label="Category check incomplete"
          reason={failed.length ? `feeds unavailable: ${failed.join(', ')}` : undefined}
        />
      ) : categories.length === 0 ? (
        <Empty>no active categories</Empty>
      ) : (
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => {
            const on = category === c.category
            const m = sevMeta(c.severity, COLORS)
            const count = Number(c.count) || 0
            const split = categorySplit(c.category, count, signals, truncated, COLORS)
            return (
              <button
                key={c.category}
                type="button"
                aria-pressed={on}
                onClick={() => onCategory(on ? '' : c.category)}
                className="inc-chip"
              >
                {/* Hidden from screen readers: the dot is the worst severity, and
                    read first it would say "Critical" ahead of the split. */}
                <i aria-hidden="true" className="w-2 h-2 rounded-mark inline-block" style={{ background: m.color }} title={m.label} />
                <b>{count.toLocaleString()}</b>
                <span className="text-muted">{categoryWord(c.category)}</span>
                <span className="text-muted">· {split ?? `worst: ${m.label.toLowerCase()}`}</span>
              </button>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------- severity tiles ----------

const SEV_TILES = [
  { key: 'critical', label: 'Critical', tone: 'crit' },
  { key: 'high', label: 'High', tone: 'high' },
  { key: 'medium', label: 'Medium', tone: 'warn' },
  { key: 'low', label: 'Low', tone: 'low' },
]

// The page's answer, first: how many incidents at each severity. Critical and
// high are the loudest marks on the page when they are above zero; medium is
// plain ink with an amber dot; low and every zero stay grey. A tile picks the
// severity Triage shows, the way a category chip picks a category.
function SeverityKpis({ signals, truncated, loading, error, panelId, severity, onSeverity }) {
  const { COLORS } = useChartTheme()
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const s of signals) {
    const m = sevMeta(s.severity, COLORS)
    if (counts[m.key] != null) counts[m.key]++
  }
  const total = counts.critical + counts.high + counts.medium + counts.low
  const tiles = SEV_TILES.map((c) => {
    const n = counts[c.key]
    const on = severity === c.key
    const tip = `${n.toLocaleString()} ${c.label.toLowerCase()} of ${total.toLocaleString()}${truncated ? ' shown' : ''}.${on ? ' Triage shows only these; select again to show all.' : n ? ' Select to show only these in Triage.' : ''}`
    return { c, n, on, tone: n > 0 ? c.tone : 'none', tip }
  })

  // A failed fetch leaves `signals` at [], so every count is 0. Printing those
  // zeros asserts "no critical incidents" on the strength of a dead backend —
  // the counts are unknown, not zero, so they render as em-dashes under an
  // explicit failure banner.
  if (error) {
    return (
      <Card panelId={panelId} span={6} panelName="Severity Counts" note="counts unknown — fetch failed">
        <FeedUnavailable
          label="Severity counts unavailable"
          reason={error.message ? `could not load incidents: ${error.message}` : 'could not load incidents'}
        />
        <div className="ov-look inc-look">
          <div className="inc-kpis">
            {SEV_TILES.map((c) => (
              <div key={c.key} className="ov-kpi" style={{ cursor: 'default' }}>
                <span className="ov-kpi-in">
                  <span className="ov-kpi-top">{c.label}</span>
                  <span className="ov-num inc-num none">—</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card
      panelId={panelId}
      span={6}
      // Both branches of this component are one panel and share the name: the
      // four tiles are their own labels, so there is no heading to read and the
      // popup used to list it as "incidents-severity".
      panelName="Severity Counts"
      note={truncated ? 'of shown signals — list is capped' : undefined}
    >
      {loading ? (
        <Skeleton h={88} />
      ) : (
        <div className="ov-look inc-look">
          <div className="inc-kpis" role="group" aria-label="Incidents by severity">
            {tiles.map(({ c, n, on, tone, tip }) => {
              return (
                <button
                  key={c.key}
                  type="button"
                  className="ov-kpi"
                  aria-pressed={on}
                  disabled={!n && !on}
                  onClick={() => onSeverity(on ? '' : c.key)}
                  title={tip}
                  aria-describedby={`inc-sev-tip-${c.key}`}
                >
                  <span className="ov-kpi-in">
                    <span className="ov-kpi-top inc-sev"><i aria-hidden="true" className={`ov-dot ${tone === 'none' ? '' : tone}`} />{c.label}</span>
                    <span className={`ov-num inc-num ${tone}`}>{n.toLocaleString()}</span>
                    <span className="ov-muted ov-small">of {total.toLocaleString()}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {/* Outside the buttons, so each tile's name stays short, and hidden,
              so it is read only as the tile's description, not again as text. */}
          {tiles.map(({ c, tip }) => <span key={c.key} id={`inc-sev-tip-${c.key}`} hidden>{tip}</span>)}
        </div>
      )}
    </Card>
  )
}

// ---------- incidents table ----------

// The thing a signal is about, by name. Zone and subnet messages start with it
// ("aws.private.: High Neg-TTL", "Windows Wireless at 80% utilization").
function subjectOf(s) {
  const msg = String(s.message || '')
  if (s.entity_type === 'zone' && msg.includes(': ')) return msg.split(': ')[0]
  if (s.entity_type === 'subnet' && / at \d+% utilization$/.test(msg)) return msg.replace(/ at \d+% utilization$/, '') || s.entity_id
  if (s.entity_type === 'posture') return 'All DNS zones'
  return s.entity_id || '—'
}

function IncidentsTable({ signals, signalsTotal, signalsTruncated, loading, error, degraded, meta = {}, category, onCategory, severity, onSeverity, acks, onToggleAck, onClearAcks, panelId }) {
  const { COLORS } = useChartTheme()
  const [filter, setFilter] = useState('')
  const failedFeeds = Object.entries(meta).filter(([, v]) => v === 'error').map(([k]) => k)

  // Filter, then default-order newest-first; DataTable takes over once a header is clicked.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return signals
      .filter((s) => {
        if (category && s.category !== category) return false
        if (severity && sevMeta(s.severity, COLORS).key !== severity) return false
        if (!q) return true
        return [s.category, s.entity_id, s.message].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      })
      // Worst first, then newest: the one critical used to sit under eleven
      // identical mediums because the order was newest only.
      .sort((a, b) => sevRank(a.severity, COLORS) - sevRank(b.severity, COLORS) || (Number(b.detected_at) || 0) - (Number(a.detected_at) || 0))
  }, [signals, category, severity, filter, COLORS])
  const filteredBy = [category && categoryWord(category), severity && SEV_TILES.find((t) => t.key === severity)?.label].filter(Boolean).join(' · ')

  const columns = [
    {
      key: 'ack',
      label: 'Ack',
      keep: true,
      render: (_v, s) => (
        <input
          type="checkbox"
          checked={!!acks[ackKey(s)]}
          onChange={() => onToggleAck(s)}
          aria-label="Acknowledge signal"
        />
      ),
    },
    { key: 'category', label: 'Category', sortable: true, render: (v) => categoryWord(v) },
    // What it is about, by name. The id stays on hover for anyone matching it
    // against Infoblox; a zone's name is the start of its message.
    { key: 'entity_id', label: 'What', sortable: true, render: (v, s) => <span title={v || undefined}>{subjectOf(s)}</span> },
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      comparator: (a, b) => sevRank(a.severity, COLORS) - sevRank(b.severity, COLORS),
      render: (_v, s) => <SeverityPill severity={s.severity} />,
    },
    { key: 'message', label: 'Message', grow: true, render: (v) => plainMessage(v) },
    {
      key: 'detected_at',
      label: 'Age',
      mono: true,
      sortable: true,
      comparator: (a, b) => (Number(a.detected_at) || 0) - (Number(b.detected_at) || 0),
      // first_seen_unknown (store.go's degraded StampFirstSeen branch) means
      // detected_at was deliberately never stamped — rendering a computed age
      // here would print a confident-looking "0s"/"—" for a value that is
      // genuinely unknown, not zero.
      render: (v, s) => (s.first_seen_unknown ? 'unknown' : ageLabel(v)),
    },
  ]

  return (
    <Card
      panelId={panelId}
      span={4}
      title="Triage"
      note={filteredBy ? `only ${filteredBy}` : undefined}
      right={
        <div className="flex items-center gap-2">
          <input {...MACHINE_TEXT}
            aria-label="Filter incidents"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[150px]`}
          />
          {filteredBy && (
            <button onClick={() => { onCategory(''); onSeverity('') }} className="px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy">
              Clear filter
            </button>
          )}
          <button onClick={onClearAcks} className="px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy">
            Clear acks
          </button>
          <span className="text-note text-muted">{signalsTotal.toLocaleString()}</span>
        </div>
      }
    >
      {loading ? (
        <Skeleton h={280} />
      ) : error ? (
        <FeedUnavailable label="Incidents feed unavailable" reason={error.message || undefined} />
      ) : signals.length === 0 && degraded ? (
        <FeedUnavailable
          label="Check could not be completed"
          reason={failedFeeds.length ? `feeds unavailable: ${failedFeeds.join(', ')}` : 'one or more feeds failed'}
        />
      ) : signals.length === 0 ? (
        <Empty>no issues detected — all metrics within normal thresholds</Empty>
      ) : rows.length === 0 ? (
        <Empty>no signals match</Empty>
      ) : (
        <>
          {degraded && (
            <div className="text-note mb-1.5" style={{ color: COLORS.warn }}>
              incomplete check — {failedFeeds.length ? `could not read: ${failedFeeds.join(', ')}` : 'one or more feeds failed'}, some issues may be missing
            </div>
          )}
          {signalsTruncated && (
            <div className="text-note text-muted mb-1.5">
              showing {signals.length.toLocaleString()} of {signalsTotal.toLocaleString()} signals — filter to narrow
            </div>
          )}
          <DataTable
            rows={rows}
            columns={columns}
            maxHeight={420}
            rowCap={150}
            rowKey={(s) => ackKey(s)}
            rowStyle={(s) => ({ opacity: acks[ackKey(s)] ? 0.45 : 1 })}
          />
        </>
      )}
    </Card>
  )
}

// ---------- SOC action queue ----------

// An IQ action is either active or resolved: those are the only two states
// /api/actions/{id}/status accepts (dashboard.UpdateAction). The queue used to
// show only the button, so a tenant whose actions were all resolved read as a
// column of "Reopen". Each row now says its state, open rows first, and the
// action fits it: Resolve on an open row, a quiet Reopen on a resolved one.
// A status upstream sends that is neither is shown as it came, and is offered
// Resolve, as before.
function actionState(r) {
  const raw = String(r?.status || '').toLowerCase()
  if (raw === 'resolved') return { resolved: true, word: 'Resolved', cls: 'done' }
  if (raw === 'active') return { resolved: false, word: 'Open', cls: 'open' }
  return { resolved: false, word: raw || 'Unknown', cls: 'open' }
}

function SocQueue({ rows, loading, error, unavailable, reason, onRetry, statusState, onSetStatus, openActionId, onOpenAction, panelId }) {
  const ro = useReadOnly()
  const { COLORS } = useChartTheme()
  // Open first, then worst first, so what still needs doing leads.
  const ordered = useMemo(
    () =>
      rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => Number(actionState(a.r).resolved) - Number(actionState(b.r).resolved) || sevRank(mcpSeverity(a.r), COLORS) - sevRank(mcpSeverity(b.r), COLORS) || a.i - b.i)
        .map(({ r }) => r),
    [rows, COLORS],
  )
  const open = rows.filter((r) => !actionState(r).resolved).length
  const columns = [
    {
      key: 'sev',
      label: 'Sev',
      sortable: true,
      comparator: (a, b) => sevRank(mcpSeverity(a), COLORS) - sevRank(mcpSeverity(b), COLORS),
      render: (_v, r) => <SeverityPill severity={mcpSeverity(r)} />,
    },
    {
      key: 'action',
      label: 'Action',
      keep: true,
      grow: true,
      render: (_v, r) => (
        <button
          type="button"
          className="line-clamp-2 text-left underline decoration-dotted underline-offset-2 hover:text-link"
          onClick={() => onOpenAction(r.id)}
        >
          {r.title || r.name || r.message || r.display_id || r.id || '—'}
        </button>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) => {
        const st = statusState[r.id] || {}
        const s = actionState(r)
        const next = s.resolved ? 'active' : 'resolved'
        return (
          <div className="flex flex-col gap-0.5">
            <div className="inc-status">
              <span className={`inc-state ${s.cls}`}>{s.word}</span>
              <button
                type="button"
                disabled={st.pending || ro.readOnly}
                title={ro.readOnly ? 'Off: this tenant is read-only' : undefined}
                onClick={() => onSetStatus(r.id, next)}
                data-busy={st.pending || st.error ? '' : undefined}
                className={s.resolved ? 'inc-quiet' : 'inc-act'}
              >
                {st.pending ? 'saving…' : s.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </div>
            {st.error && <span className="text-note text-crit" style={{ color: COLORS.crit }}>{st.error}</span>}
          </div>
        )
      },
    },
  ]

  // Open and resolved add up to the rows the queue and the Action Volume
  // chart both count, so the three numbers agree.
  const right =
    rows.length > 0 ? (
      <span className="text-note text-muted">
        {open.toLocaleString()} open · {(rows.length - open).toLocaleString()} resolved
      </span>
    ) : undefined

  return (
    <Card panelId={panelId} span={2} title="IQ Actions" note="IQ for Threat Defense" right={right}>
      {loading ? (
        <Skeleton h={280} />
      ) : unavailable ? (
        <FeedUnavailable label="IQ Actions feed unavailable" reason={reason} onRetry={onRetry} />
      ) : error ? (
        <FeedUnavailable label="IQ Actions feed unavailable" reason={error.message || undefined} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <Empty>no pending actions</Empty>
      ) : (
        <>
          <ReadOnlyNote ro={ro} what="Resolve and Reopen are off." />
          <DataTable rows={ordered} columns={columns} maxHeight={420} rowCap={150} rowKey={(r, i) => `${r.id ?? r.display_id ?? ''}|${i}`} />
          {openActionId != null && <ActionDetailDrawer actionId={openActionId} onClose={() => onOpenAction(null)} />}
        </>
      )}
    </Card>
  )
}

// ---------- action detail drawer ----------

// The same modal machinery as DocsPanel, HeaderHelp and TenantManager, copied
// for the reason HeaderHelp.jsx gives. Until this was added the drawer covered
// the page but took no focus: Tab kept walking the queue behind the scrim, and
// Escape did nothing.
const DRAWER_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function ActionDetailDrawer({ actionId, onClose }) {
  const detail = useApi(`/api/actions/${actionId}`)
  const panelRef = useRef(null)

  const action = detail.data?.action || detail.data

  // Focus goes to the panel when it opens, and back to the row that opened it
  // when it closes. The row outlives the drawer (SocQueue stays mounted), so
  // the drawer can hand focus back itself.
  useEffect(() => {
    const opener = document.activeElement
    panelRef.current?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...panelRef.current.querySelectorAll(DRAWER_FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!items.length) {
      e.preventDefault()
      panelRef.current.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const cur = document.activeElement
    if (e.shiftKey && (cur === first || cur === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-detail-title"
        tabIndex={-1}
        // bg-panel WAS NOT A TOKEN. `@theme` in index.css declares no
        // --color-panel, so Tailwind emitted no rule at all and this drawer
        // painted its content straight onto the bg-black/40 scrim behind it.
        // bg-card is the surface every other drawer and dialog uses
        // (DocsPanel, HeaderHelp, TenantManager).
        className="h-full w-full max-w-[420px] bg-card border-l border-card-border p-4 overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id="action-detail-title" className="text-copy font-semibold">Action detail</h2>
          <button type="button" onClick={onClose} className="px-2 py-1 rounded-control border border-border bg-field text-field-txt text-note" aria-label="Close">
            Close
          </button>
        </div>
        {detail.loading ? (
          <Skeleton h={200} />
        ) : detail.error ? (
          <FeedUnavailable label="Action detail unavailable" reason={detail.error.message || undefined} />
        ) : !action ? (
          <Empty>action not found</Empty>
        ) : (
          <dl className="text-copy space-y-2">
            {Object.entries(action).map(([k, v]) => (
              <div key={k} className="flex flex-col border-b border-line-2 pb-1.5">
                <dt className="text-note text-muted uppercase tracking-wide">{k}</dt>
                <dd className="font-mono break-words">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}

// ---------- action volume trend strip ----------

function ActionTrendStrip({ rows, loading, error, unavailable, reason, onRetry, panelId }) {
  const { COLORS } = useChartTheme()

  const { byDay, byPriority } = useMemo(() => {
    const days = {}
    const pri = { low: 0, medium: 0, high: 0 }
    for (const r of rows) {
      const t = Date.parse(r.last_activity)
      if (!Number.isNaN(t)) {
        const d = new Date(t).toISOString().slice(0, 10)
        days[d] = (days[d] || 0) + 1
      }
      // The same mapping the queue uses, so these counts add up to the queue's
      // total and call each row what the queue calls it. Counting only
      // low/medium/high dropped every other row (225 here vs 228 in the queue).
      const sev = mcpSeverity(r)
      pri[sev] = (pri[sev] || 0) + 1
    }
    // The whole date is kept, not `date.slice(5)`: "01-27" is a machine's way of
    // writing a day, and it is also ambiguous outside the US. fmtShortDay turns
    // it into "Jan 27" for both the axis and the hover, reading the digits out of
    // the string rather than through Date, so no bar shifts by a timezone.
    const byDay = Object.entries(days)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, count]) => ({ date, count }))
    return { byDay, byPriority: pri }
  }, [rows])

  return (
    <Card panelId={panelId} span={2} title="Action Volume" note="by day">
      {loading ? (
        <Skeleton h={220} />
      ) : unavailable ? (
        <FeedUnavailable label="IQ Actions feed unavailable" reason={reason} onRetry={onRetry} />
      ) : error ? (
        <FeedUnavailable label="IQ Actions feed unavailable" reason={error.message || undefined} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <Empty>no IQ actions to trend</Empty>
      ) : (
        <>
          <Suspense fallback={<Skeleton h={150} />}>
            <CategoryBars
              label="Action Volume"
              data={byDay}
              unit="actions"
              height={150}
              xKey="date"
              yKey="count"
              tickFormat={fmtShortDay}
              fill={COLORS.series}
              minTickGap={20}
            />
          </Suspense>
          <div className="flex items-center justify-between mt-2 text-note">
            <span style={{ color: COLORS.sevHigh }}>High {byPriority.high}</span>
            <span style={{ color: COLORS.warn }}>Medium {byPriority.medium}</span>
            <span style={{ color: COLORS.accent }}>Low {byPriority.low}</span>
            {Object.entries(byPriority).filter(([k, n]) => !['low', 'medium', 'high'].includes(k) && n > 0).map(([k, n]) => (
              <span key={k} className="text-muted capitalize">{k} {n}</span>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
