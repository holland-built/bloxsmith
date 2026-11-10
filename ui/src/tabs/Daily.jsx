import { useId, useMemo, useState } from 'react'
import { useChartTheme, Card, CardGrid, Empty, FeedUnavailable, Skeleton, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useApi } from '../lib/api.js'
import { sliceState } from '../lib/data.js'
import { sampleCountLabel, sampleScopeNote, sampleSince } from '../lib/sampleCount.js'
import { cmpMaybe, DASH, freeOf, num } from '../lib/measured.js'
import { UTIL_CRIT, utilBand } from '../lib/utilBands.js'
import { issueWord } from '../lib/plainWords.js'
import './Daily.css'

// Per-slice status for a RAW useApi('/api/data') read.
//
// This tab reads the route directly, so it does not get the honesty rule that
// ui/src/lib/data.js applies for useData() tabs. Without it, a request that
// fails outright (a 500, or the cold-request abort) leaves data.data null =>
// _meta {} => the slice status undefined => every `=== 'error'` branch below
// falls through to <Empty/> — "all hosts online", "no DNS zone issues" — for a
// read that never happened. Same rule as lib/data.js: requested but missing =>
// 'error', whether the whole request died or the payload came back without the
// slice.
//
// The vocabulary stays exactly ok / empty / error. A first read still in flight
// is not a verdict at all — it returns undefined so the panel keeps its
// skeleton rather than accusing the feed.
function feedStatus(api, name) {
  if (api.loading && !api.data) return undefined
  if (api.error || !api.data) return 'error'
  return sliceState(api.data, name).status
}

// ---------- main ----------

// The dashboard look the owner picked on 2026-11-09 (the dashboard-design
// skill, as on Overview): a short title with an "Updated" pill, the three
// counts as tiles in one card, and plain cards below. Each number is shown
// once, in its tile; what is behind it is in a tip that opens on hover,
// keyboard focus or tap, never a sentence under every number.

export default function Daily() {
  const data = useApi('/api/data', { poll: 30000 })
  const sec = useApi('/api/hub/security', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const hosts = data.data?.hosts ?? []
  const zones = data.data?.zones ?? []
  const totals = data.data?._totals
  // Each panel reads a DIFFERENT slice, so the status is per-slice — but a
  // failure of the whole request is a failure of all three.
  const meta = {
    subnets: feedStatus(data, 'subnets'),
    hosts: feedStatus(data, 'hosts'),
    zones: feedStatus(data, 'zones'),
  }
  // When this page last received /api/data, not the time on the clock: a
  // stalled poll must not keep claiming the figures are fresh.
  // The whole refresh failed and useApi is still holding the previous read.
  // Not the same as a slice reporting 'error': the backend can send current
  // rows for a slice it only read in part, and those are not old.
  const stale = !!data.error && !!data.data
  const asOf = useMemo(() => (data.data ? new Date() : null), [data.data])

  return (
    <div className="w-full px-6 py-5">
      <div className="dy-head">
        <h1>Daily report</h1>
        <Updated asOf={asOf} failed={!!data.error} />
      </div>
      {/* The panelIds sit on the call sites, not only on the Card each wrapper
          returns: CardGrid reads panelId off its OWN direct children to apply a
          saved order, and a wrapper that keeps the id inside is invisible to
          that read. Each wrapper forwards it to its Card unchanged. */}
      <CardGrid layoutKey="daily">
        <IssueKpis panelId="daily-open-issues" subnets={subnets} hosts={hosts} zones={zones} totals={totals} meta={meta} loading={data.loading} />
        <SecurityToday panelId="daily-security-today" sec={sec} />
        <TopCapacityRisks panelId="daily-top-capacity-risks" subnets={subnets} loading={data.loading} subnetsStatus={meta.subnets} stale={stale} />
        <HostsAttention panelId="daily-hosts-attention" hosts={hosts} loading={data.loading} hostsStatus={meta.hosts} stale={stale} />
        <DnsZoneIssues panelId="daily-dns-zone-issues" zones={zones} loading={data.loading} zonesStatus={meta.zones} stale={stale} />
      </CardGrid>
    </div>
  )
}

// One tip for every number, the same behaviour as Overview's: hover, keyboard
// focus or tap opens it, Escape closes it. The visible text stays the name;
// the tip is its description.
function Tip({ tip, children, className = '', ...rest }) {
  const id = useId()
  // null follows hover and focus; true is opened by a tap; false is closed by
  // Escape, which has to beat :focus-visible (a key press turns it on).
  const [open, setOpen] = useState(null)
  if (!tip) return <span className={className} {...rest}>{children}</span>
  return (
    <span
      className={`dy-tipwrap ${className}`}
      tabIndex={0}
      aria-describedby={id}
      data-open={open === true || undefined}
      data-closed={open === false || undefined}
      onClick={() => setOpen((o) => o !== true)}
      onBlur={() => setOpen(null)}
      onMouseLeave={() => setOpen((o) => (o === false ? null : o))}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      {...rest}
    >
      {children}
      <span role="tooltip" id={id} className="dy-tip">{tip}</span>
    </span>
  )
}

// When the inventory last arrived, and how often it refreshes (in the tip).
// A failed refresh says so here once, in red, instead of a fresh-looking time.
function Updated({ asOf, failed }) {
  const time = asOf ? asOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const label = failed ? 'Refresh failed' : time ? `Updated ${time}` : 'Checking…'
  const tip = failed && time ? `Last good read ${time}. Tries again every 30 seconds.` : 'Refreshes every 30 seconds.'
  return (
    <Tip tip={tip} className="dy-pill">
      <span className={`dy-live ${failed ? 'down' : time ? '' : 'wait'}`} aria-hidden="true" />
      <span>{label}</span>
    </Tip>
  )
}

// ---------- KPI cards ----------

function IssueKpis({ subnets, hosts, zones, totals, meta = {}, loading, panelId }) {
  const { COLORS } = useChartTheme()
  // `subnets` (data.subnets) is the union of the first-5,000 page and every
  // subnet with util >= 70, deduped. That union is COMPLETE for any threshold
  // >= 70 — a subnet in the red band is necessarily >= 70, so it cannot be
  // missing from the union. Counting rows here is therefore an exact
  // whole-network figure for this tile, not a coverage-set sample.
  //
  // It agrees with `_totals.subnetsCrit` (same threshold since 2026-10-04,
  // /29-/32 links included since 2026-11-10).
  //
  // The red band is inclusive at its lower edge (lib/utilBands.js), which
  // agrees with the drill-down this row links to: Network.jsx keeps
  // `u >= minUtil`, and `links=1` there keeps the /29-/32 links this counts.
  // Every subnet ≥90%, /29-/32 links included, so this is the same number
  // Network and Overview show (owner, 2026-11-10). How many of them are real
  // subnets, not links, is offered underneath.
  const critSubnets = subnets.filter((s) => utilBand(Number(s.util) || 0) === 'crit')
  const critReal = critSubnets.filter((s) => (Number(s.cidr) || 0) <= 28)
  // Offline or in error, the same rule as Overview's Hosts row, Infra's
  // "offline" filter and the Best practices check, so the four agree.
  // Pending, degraded and unknown hosts are not counted as down.
  const badHosts = hosts.filter((h) => statusBucket(h.status) === 'offline')
  const zonesWithIssues = zones.filter((z) => Array.isArray(z.issues) && z.issues.length > 0)

  // The line under each number says what is behind it, from the same rows the
  // number counts.
  const byStatus = {}
  for (const h of badHosts) {
    const k = (h.status || 'unknown').toLowerCase()
    byStatus[k] = (byStatus[k] || 0) + 1
  }
  const issueTypes = {}
  for (const z of zonesWithIssues) for (const t of z.issues) issueTypes[t] = (issueTypes[t] || 0) + 1
  const commonTypes = Object.entries(issueTypes).sort((a, b) => b[1] - a[1]).slice(0, 3)

  // Each KPI reads a DIFFERENT feed (subnets/hosts/zones) — one can be dead
  // while the other two are fine, so the gate is per-tile, not per-card.
  // `detail` is what is behind the number, from the same rows it counts; it
  // is the number's tip. `of` is what the number is out of.
  const cells = [
    {
      key: 'subnets', name: 'Subnets', unit: `≥${UTIL_CRIT}% full`, value: critSubnets.length, sev: 'warn', hash: `network?minUtil=${UTIL_CRIT}&links=1`, status: meta.subnets,
      of: typeof totals?.subnets === 'number' ? totals.subnets : null,
      detail: `${critReal.length.toLocaleString()} without /29–/32 links.`,
    },
    {
      key: 'hosts', name: 'Hosts', unit: 'not online', value: badHosts.length, sev: 'crit', hash: 'infra?status=offline', status: meta.hosts,
      of: hosts.length,
      detail: `${hosts.length.toLocaleString()} hosts loaded.` +
        (badHosts.length ? ' ' + Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(', ') + '.' : ''),
    },
    {
      key: 'zones', name: 'DNS zones', unit: 'with issues', value: zonesWithIssues.length, sev: 'warn', hash: 'dns?issues=1', status: meta.zones,
      of: zones.length,
      detail: commonTypes.length ? `Most common: ${commonTypes.map(([t, n]) => `${issueWord(t)} (${n.toLocaleString()})`).join(', ')}.` : '',
    },
  ]
  const tone = { crit: COLORS.crit, warn: COLORS.warn }

  return (
    <Card span={4} panelId={panelId} title="Open Issues">
      {loading ? (
        <Skeleton h={110} />
      ) : (
        <div className="dy-tiles-box">
        <div className="dy-tiles">
          {cells.map((c) => {
            const unavailable = c.status === 'error'
            const bad = !unavailable && c.value > 0
            const word = unavailable ? '' : bad ? (c.sev === 'crit' ? 'Act' : 'Look') : 'Healthy'
            // A click anywhere on the tile opens the list behind it, except on
            // the number, where a tap opens its tip. The name is the link a
            // keyboard or screen reader uses.
            return (
              <div
                key={c.key}
                data-daily-tile={c.key}
                className="dy-tile"
                onClick={(e) => { if (!e.target.closest('.dy-tipwrap, a')) location.hash = c.hash }}
              >
                <div className="dy-tile-top">
                  <a href={`#${c.hash}`} className="dy-name">{c.name}</a>
                  {word && <span className={`dy-verdict ${bad ? c.sev : 'ok'}`}>{word}</span>}
                </div>
                {unavailable ? (
                  <Tip tip="This feed did not answer." className="dy-num-word">
                    <span style={{ color: COLORS.crit }}>unavailable</span>
                  </Tip>
                ) : (
                  <Tip tip={c.detail || null} className="dy-num">
                    <span style={{ color: bad ? tone[c.sev] : undefined }}>{c.value.toLocaleString()}</span> <small>{c.unit}</small>
                  </Tip>
                )}
                <span className="dy-muted dy-small">{!unavailable && typeof c.of === 'number' ? `of ${c.of.toLocaleString()}` : '\u00a0'}</span>
              </div>
            )
          })}
        </div>
        </div>
      )}
    </Card>
  )
}

// ---------- security today ----------

function SecurityToday({ sec, panelId }) {
  const { COLORS } = useChartTheme()
  const counts = sec.data?.counts ?? {}
  // No `events` binding any more. This panel only ever read its LENGTH, to print
  // it as the hour's event count, and that is the number issue #157 was about:
  // the server's `returned` and `truncated` are what the heading is built from
  // now, so counting the rows here would just be the old answer arrived at a
  // second way.
  const chips = [
    { label: 'critical', value: Number(counts.critical) || 0, color: COLORS.crit },
    { label: 'high', value: Number(counts.high) || 0, color: COLORS.warn },
    { label: 'medium', value: Number(counts.medium) || 0 },
    { label: 'low', value: Number(counts.low) || 0 },
    // Blocked is good news, so it stays plain: only what needs a look is
    // coloured, and a green 33 would outshine a red 1.
    { label: 'blocked', value: Number(sec.data?.blocked) || 0 },
    { label: 'logged', value: Number(sec.data?.logged) || 0 },
  ]

  // A dead threat feed is not a quiet day. The fetch failing, or finishing with
  // no body at all, is the same "we do not know" as an explicit
  // availability:"error" — never four zeros and "0 events".
  const secDead = !sec.loading && (!!sec.error || !sec.data || sec.data.availability === 'error')

  // The four chips are counted from the rows the server had in hand, and until
  // 2026-08-20 nothing said so: the feed is fetched with a row limit, and on a
  // busy hour "blocked 50" meant "all 50 rows I looked at were blocked", not
  // "50 threats blocked this hour". Measured live that day, the cap was being
  // hit. The heading now names the sample and this line names its scope.
  const scopeNote = sampleScopeNote(sec.data, 'events')
  // When the sample starts, so a figure that moves between loads reads as a
  // moving window rather than a change in the day.
  const since = scopeNote ? sampleSince(sec.data) : null

  // The count by the title is the sample it was counted from; its tip says
  // so, and when the sample started, instead of two lines under the figures.
  const scopeTip = [scopeNote, since && `The oldest is from ${since}.`].filter(Boolean).join(' ') || null

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Security Today"
      right={
        <Tip tip={sec.loading || secDead ? null : scopeTip} className="dy-tip-end text-note text-muted">
          <span>{sec.loading || secDead ? '— events' : sampleCountLabel(sec.data, 'events')}</span>
        </Tip>
      }
    >
      {sec.loading ? (
        <Skeleton h={160} />
      ) : secDead ? (
        <FeedUnavailable reason={sec.data?.reason} label="Threat feed unavailable" />
      ) : (
        <dl className="dy-sec">
          {chips.map((c) => (
            <div key={c.label}>
              <dt className="capitalize">{c.label}</dt>
              <dd style={{ color: c.value > 0 ? c.color : undefined }}>{c.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}

// ---------- top capacity risks ----------

// A refresh that fails after a good one leaves the last rows in place (useApi
// keeps its data on error). Those rows are still worth seeing, but not as if
// they were current: Open Issues already says "unavailable" for the same feed.
function StaleNote() {
  return <p className="text-note text-warn mb-2">The last refresh failed. These rows are from the previous read.</p>
}

function TopCapacityRisks({ subnets, loading, subnetsStatus, stale, panelId }) {
  const feedDead = subnetsStatus === 'error' && subnets.length === 0
  const rows = [...subnets]
    .filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
    .map((s) => ({
      ...s,
      network: s.addr || s.cidr,
      // null when the row reported no figure. `Number(x) || 0` used to turn
      // that into 0% used with 0 free, which is the TOP of a list ranked by
      // least free space, under a Healthy pill: the subnet nobody measured,
      // shown as the worst one and as fine at once.
      // A reported total of 0 is the same as no figure: an empty block (seen
      // live as IPv6 0 / 0 rows) has no room to run out of.
      util: (num(s.total) ?? 0) > 0 ? num(s.util) : null,
      free: (num(s.total) ?? 0) > 0 ? freeOf(s) : null,
    }))
    // Unmeasured last. A subnet with no figure is not the one with least room.
    .sort((a, b) => cmpMaybe(a.free, b.free, 'asc'))

  const columns = [
    { key: 'network', label: 'Network', mono: true },
    { key: 'site', label: 'Site', keep: true },
    {
      key: 'util',
      label: 'Util',
      keep: true,
      render: (v) => {
        // utilStatus(null) would answer Healthy. Not measured is its own word.
        const st = v === null ? { bg: 'var(--pill-neutral-bg)', fg: 'var(--pill-neutral-fg)' } : utilStatus(v)
        return (
          <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium" style={{ background: st.bg, color: st.fg }}>
            {v === null ? 'Unknown' : `${v}%`}
          </span>
        )
      },
    },
    { key: 'used', label: 'Used', align: 'right', render: (v, s) => <span className="text-muted tabular-nums">{num(v) === null || num(s.total) === null ? DASH : `${num(v).toLocaleString()} / ${num(s.total).toLocaleString()}`}</span> },
    { key: 'free', label: 'Free', align: 'right', render: (v) => <span className="tabular-nums">{v === null ? DASH : v.toLocaleString()}</span> },
  ]

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Top Capacity Risks"
      note="least room left"
      right={<Tip tip="The 10 with the fewest free addresses. /29–/32 links are left out." className="dy-tip-end text-note text-muted"><span>top 10</span></Tip>}
    >
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={220} />
      ) : feedDead ? (
        <FeedUnavailable label="Subnets feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          onRowClick={(s) => { location.hash = 'network?subnet=' + encodeURIComponent(s.network || '') }}
        />
      )}
    </Card>
  )
}

// ---------- hosts needing attention ----------

function HostsAttention({ hosts, loading, hostsStatus, stale, panelId }) {
  const { COLORS } = useChartTheme()
  // Offline or in error first, then degraded, then the rest (pending,
  // unknown). Only the first are what the Hosts tile counts, so only they get
  // a red dot; degraded is amber and the rest grey.
  const rank = { offline: 0, degraded: 1 }
  const rows = hosts
    .filter((h) => !/online|active/i.test(h.status || ''))
    .map((h, i) => ({ h, i, r: rank[statusBucket(h.status)] ?? 2 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ h }) => h)
  const feedDead = hostsStatus === 'error' && hosts.length === 0
  const dot = { offline: COLORS.crit, degraded: COLORS.warn }

  const columns = [
    {
      key: 'name',
      label: 'Hostname',
      keep: true,
      render: (v, h) => (
        <span className="flex items-center gap-2 min-w-0">
          <i className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: dot[statusBucket(h.status)] ?? COLORS.other }} />
          <span className="font-mono truncate" style={{ maxWidth: 180 }} title={h.name || h.ip || ''}>
            {h.name || h.ip || '—'}
          </span>
        </span>
      ),
    },
    { key: 'status', label: 'Status', align: 'right' },
  ]

  return (
    <Card
      span={2}
      panelId={panelId}
      title="Hosts Needing Attention"
    >
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={220} />
      ) : feedDead ? (
        <FeedUnavailable label="Hosts feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>all hosts online</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          viewAllHref="#infra?status=not-online"
          onRowClick={() => { location.hash = 'infra?status=not-online' }}
        />
      )}
    </Card>
  )
}

// ---------- DNS zone issues ----------

function DnsZoneIssues({ zones, loading, zonesStatus, stale, panelId }) {
  const rows = zones
    .filter((z) => Array.isArray(z.issues) && z.issues.length > 0)
    // rowLabel names the row's button for the zone. Without it the name comes
    // from the first cell, which here is only the count of issues.
    .map((z) => ({ ...z, count: z.issues.length, issuesText: z.issues.map(issueWord).join(', '), rowLabel: z.fqdn }))
  const feedDead = zonesStatus === 'error' && zones.length === 0

  const columns = [
    {
      key: 'count',
      label: '',
      keep: true,
      width: '2.5rem',
      render: (v) => (
        <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium" style={{ background: 'var(--pill-neutral-bg)', color: 'var(--pill-neutral-fg)' }}>
          {v}
        </span>
      ),
    },
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'issuesText', label: 'Issues' },
  ]

  return (
    <Card
      span={2}
      panelId={panelId}
      title="DNS Zone Issues"
      // No count here: the DNS zones tile above is that number. The whole
      // list is one click away instead.
      right={<a href="#dns?issues=1" className="dy-act">Open DNS</a>}
    >
      {!loading && stale && !feedDead && <StaleNote />}
      {loading ? (
        <Skeleton h={160} />
      ) : feedDead ? (
        <FeedUnavailable label="DNS zones feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no DNS zone issues</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          limit={10}
          onRowClick={() => { location.hash = 'dns?issues=1' }}
        />
      )}
    </Card>
  )
}

// Mirrors statusBucket() in Infra.jsx and Overview.jsx, which do not export
// it. Keep the three in step.
function statusBucket(s) {
  s = s || ''
  if (/^unknown$/i.test(s)) return 'unknown'
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}
