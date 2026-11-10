import { lazy, Suspense, useMemo, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useData } from '../lib/data.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, hiddenPanelGroup, Skeleton, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { dnssecPanelLabel, fmtShortDay } from '../lib/chartFormat.js'
import { useHashParams } from '../lib/hash.js'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { useThemeColors } from '../lib/theme.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { useSavedChartPanels } from '../components/useSavedChartPanels.jsx'
import { issueWord } from '../lib/plainWords.js'
import { changeText, reading, vsYesterday } from '../lib/dnsCompare.js'
import Tip from '../components/Tip.jsx'
import './Overview.css'
import './Dns.css'

// THE DNS PAGE IN THE OVERVIEW'S LOOK (2026-11-10).
//
// The owner picked the dashboard-design skill's look for Overview on
// 2026-11-09, and this page now wears the same: a title with an "Updated"
// pill, one card of headline numbers whose words are a label, a number and a
// unit, and every explanation in a tip that opens on hover, focus or tap.
//
// A review found the page's real problem was order, not looks: 64 zones with
// issues sat among 1,445 sorted A to Z. So the zone count with issues is a
// headline that opens the issues-only list, the zone table puts zones with
// issues first, and the Zone Counts panel says which kinds of issue they are.
// The panels and their order are unchanged, so saved layouts keep working.

// ---------- main ----------

// The only /api/data slice this tab shows. See Audit.jsx for why the list is
// declared rather than inferred: the accessors refuse to answer for anything
// not named here, so an unrequested slice can never be rendered as empty or as
// broken. (zones pulls dnsViews server-side to resolve view names; that is the
// server's dependency closure, not something this tab reads.)
const SLICES = ['zones']

// Both charts on this tab share one shape; only they wait for recharts.
const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))

// CSPDNSServices asks Infoblox for `_limit: 200` (go/internal/dashboard/csp.go),
// so a list of exactly that many may have been cut there.
const SERVICES_LIMIT = 200

const fmtQps = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1))
const clock = (h) => {
  const d = new Date(h)
  return isNaN(d) ? String(h) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Scroll to a panel and give it focus, as the old headline strip did.
function jumpToPanel(panelId) {
  const el = document.querySelector(`[data-panel-id="${panelId}"]`)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

// The signing counts, read once so the headline and the DNSSEC panel cannot
// disagree. Only zones with public names (ending in a real TLD such as .com)
// need signing; reverse zones and names like .local or .lab do not (owner,
// 2026-11-09). public_name comes from the server (publicname.go).
function signing(dnssec) {
  const rows = dnssec.data?.rows ?? []
  // CSPDnssec returns status:"error" at HTTP 200 on an upstream failure — the
  // fetch itself never errors, so `dnssec.error` alone never catches this.
  const failed = !!dnssec.error || dnssec.data?.status === 'error'
  const publicRows = rows.filter((r) => r.public_name)
  return {
    rows,
    failed,
    publicRows,
    signed: publicRows.filter((r) => r.dnssec_status === 'SIGNED').length,
    unsigned: publicRows.filter((r) => r.dnssec_status === 'UNSIGNED').length,
    internal: rows.length - publicRows.length,
  }
}

// The headline numbers. A feed that is down or still loading is a dash or
// "Loading…", never zero; a failed poll's kept rows do not count (useData
// keeps its last payload on error, so its slice status stays 'ok'). Zones that
// publish no TTL were never checked, so the zone tile names the population it
// covers. Colour only where something needs a look.
function headlines({ qps, services, zones, zonesStatus, zonesFailed, zonesLoading, dnssec }) {
  const qpsOk = !qps.loading && !qps.error && qps.data?.status !== 'error'
  const rows = qpsOk ? qps.data?.rows ?? [] : []
  // A missing latest reading is a dash, never 0.
  const last = rows.length ? reading(rows[rows.length - 1].avg_value) : null
  const cmp = vsYesterday(rows)
  const qpsTip = last != null
    ? `Average for the hour from ${clock(rows[rows.length - 1].hour)}, so far. ${cmp ? `Same time yesterday (${clock(cmp.wasHour)}): ${fmtQps(cmp.was)} a second.` : 'No reading from this time yesterday to compare with.'}`
    : null

  const zonesOk = !zonesFailed && (zonesStatus === 'ok' || zonesStatus === 'empty')
  const checked = zonesOk ? zones.filter(ttlChecked).length : 0
  const unchecked = zonesOk ? zones.length - checked : 0
  const withIssues = zonesOk ? zones.filter(hasIssues).length : null
  const zoneWord = zonesLoading ? ['Checking', 'none'] : !zonesOk ? ['Unavailable', 'none']
    : withIssues > 0 ? ['Act', 'crit'] : unchecked > 0 ? ['Partly checked', 'none'] : zones.length ? ['Healthy', 'ok'] : ['', 'none']

  const sg = signing(dnssec)
  const sgOk = !dnssec.loading && !sg.failed
  const sgWord = dnssec.loading ? ['Checking', 'none'] : !sgOk ? ['Unavailable', 'none']
    : sg.unsigned > 0 ? ['Look', 'warn'] : sg.publicRows.length ? ['Healthy', 'ok'] : ['', 'none']

  const svc = services.data?.rows
  const svcOk = !services.loading && !services.error && services.data?.status !== 'error' && Array.isArray(svc)
  const svcCapped = svcOk && svc.length >= SERVICES_LIMIT

  return [
    {
      key: 'queries', label: 'DNS queries', panelId: 'dns-query-rate',
      value: last != null ? fmtQps(last) : null, loading: qps.loading, unit: 'a second',
      sub: cmp ? `${changeText(cmp)} vs yesterday` : '',
      tip: qpsTip,
    },
    {
      key: 'zones', label: 'Zones', panelId: 'dns-zones', href: withIssues > 0 ? '#dns?issues=1' : null,
      value: withIssues == null ? null : withIssues.toLocaleString(), loading: zonesLoading, unit: 'with issues',
      word: zoneWord[0], sev: zoneWord[1],
      sub: zonesOk ? (unchecked > 0 ? `of ${checked.toLocaleString()} checked` : `of ${zones.length.toLocaleString()}`) : '',
      tip: zonesOk ? `Zones whose cache times need fixing.${unchecked > 0 ? ` ${unchecked.toLocaleString()} publish no cache time and were not checked.` : ''}${withIssues > 0 ? ' Opens the list of them.' : ''}` : null,
    },
    {
      key: 'signing', label: 'Signing', panelId: 'dns-dnssec-health',
      value: sgOk ? sg.unsigned.toLocaleString() : null, loading: dnssec.loading, unit: 'not signed',
      word: sgWord[0], sev: sgWord[1],
      sub: sgOk ? `of ${sg.publicRows.length.toLocaleString()} public` : '',
      tip: sgOk ? 'Zones with public names, such as .com, that are not signed against tampering. Internal zones (reverse, .local, .lab) need no signing and are not counted.' : null,
    },
    {
      key: 'services', label: 'DNS services', panelId: 'dns-services',
      value: svcOk ? `${svc.length.toLocaleString()}${svcCapped ? '+' : ''}` : null, loading: services.loading, unit: '',
      sub: '',
      tip: svcOk ? `DNS services on this tenant.${svcCapped ? ` The list stops at ${SERVICES_LIMIT}.` : ''} The feed gives no up or down state, so this is a count, not a health check.` : null,
    },
  ]
}

function Tiles(props) {
  const T = headlines(props)
  return (
    <ul className="ov-card ov-kpis dns-kpis" aria-label="Headline numbers">
      {T.map((t) => {
        const tipId = `dns-tip-${t.key}`
        const body = (
          <span className="ov-kpi-in">
            <span className="ov-kpi-top"><span>{t.label}</span>{t.word ? <span className={`ov-verdict ${t.sev}`}>{t.word}</span> : null}</span>
            <span className={`ov-num dns-num ${t.value != null && t.value !== '0' ? t.sev ?? '' : ''}`}>
              {t.value == null ? (t.loading ? <small>Loading…</small> : '—') : t.value}
              {t.unit && t.value != null ? <small> {t.unit}</small> : null}
            </span>
            <span className="ov-muted ov-small">{t.sub || ' '}</span>
          </span>
        )
        const common = { className: 'ov-kpi', title: t.tip || undefined, 'aria-describedby': t.tip ? tipId : undefined, 'data-tile': t.key }
        return (
          <li key={t.key}>
            {t.href ? (
              <a href={t.href} {...common} onClick={() => setTimeout(() => jumpToPanel(t.panelId), 0)}>{body}</a>
            ) : (
              <button type="button" {...common} onClick={() => jumpToPanel(t.panelId)}>{body}</button>
            )}
            {t.tip && <span id={tipId} className="sr-only">{t.tip}</span>}
          </li>
        )
      })}
    </ul>
  )
}

// "Updated 11:02 PM" from when the zones arrived, not when the page drew.
function Updated({ at, failed }) {
  const label = failed ? 'Zones feed unavailable' : at ? `Updated ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Checking…'
  return (
    <Tip tip="Every number here is fetched again every 30 seconds." className="ov-pill" data-updated="">
      <span className={`ov-live ${failed ? 'down' : at ? '' : 'wait'}`} aria-hidden="true" />{label}
    </Tip>
  )
}

export default function Dns() {
  // Charts added from Build a chart; they join the grid as ordinary panels.
  const savedCharts = useSavedChartPanels('dns')
  const qps = useApi('/api/csp/dns-qps', { poll: 30000 })
  const services = useApi('/api/csp/dns-services', { poll: 30000 })
  // Re-enabled 2026-07-22: MCP calls now carry a bounded 12s deadline (mcp.go post()),
  // so a stalled feed errors out instead of hanging goroutines / starving the upstream.
  const analytics = useApi('/api/dns-analytics', { poll: 30000 })
  const data = useData(SLICES, { poll: 30000 })
  const dnssec = useApi('/api/csp/dnssec', { poll: 30000 })
  const rpz = useApi('/api/csp/rpz', { poll: 30000 })
  const dtcLbdn = useApi('/api/csp/dtc-lbdn', { poll: 30000 })

  const hp = useHashParams()
  // One shared read of /api/service-inventory per page load — see Security.jsx:
  // deliberately not useApi(), so it never joins the 30s poll above.
  const owned = useOwnedServices()
  const zones = data.rows('zones')
  // 'ok' | 'empty' | 'error' — 'error' also when the payload arrived without
  // the zones slice, because that read did not deliver.
  const zonesStatus = data.status('zones')
  // The time the zones payload arrived, not the time of this render.
  const fetchedAt = useMemo(() => (data.data ? new Date() : null), [data.data])

  return (
    <div className="w-full px-6 py-5 ov-look dns-page">
      <div className="ov-head">
        <h1>DNS</h1>
        <Updated at={fetchedAt} failed={!!data.error && !data.loading} />
      </div>
      <Tiles qps={qps} services={services} zones={zones} zonesStatus={zonesStatus} zonesFailed={!!data.error} zonesLoading={data.loading} dnssec={dnssec} />
      {/* Every direct child of a grid with a layoutKey carries its own panelId:
          CardGrid applies the saved order to its React children by reading
          `props.panelId` off them, while it reads the live order off the DOM. A
          wrapper whose id only exists on the <Card> inside it is visible to the
          second and invisible to the first, and the panel jumps to the end on
          reload. Each wrapper below forwards the id to its Card. */}
      <CardGrid layoutKey="dns">
        {/* Two separate runs, one group key: the panels either side of
            ZoneKpis both need a deployed DNS service, but ZoneKpis reads zone
            CONFIG, which exists whether or not one is deployed — so it is not
            mapped and cannot be swept into the group. */}
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dns,
          state: owned,
          children: [<QpsHero key="dns-query-rate" panelId="dns-query-rate" qps={qps} />],
        })}
        {/* The id sits on the call site, not on the Cards inside: ZoneKpis
            returns a different Card for loading / dead feed / data, and all
            three are the same panel. One literal id, forwarded to whichever
            Card renders — see panelHelp.test.js on the wrapper pattern. */}
        <ZoneKpis panelId="dns-zone-kpis" zones={zones} zonesStatus={zonesStatus} loading={data.loading} />
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dns,
          state: owned,
          children: [<DnsServices key="dns-services" panelId="dns-services" services={services} />],
        })}
        <QueryVolume7d panelId="dns-query-volume-7d" analytics={analytics} />
        <ZoneTable panelId="dns-zones" zones={zones} issuesOnly={hp.issues || ''} zonesStatus={zonesStatus} loading={data.loading} />
        <DnssecHealth panelId="dns-dnssec-health" dnssec={dnssec} />
        <RpzPanel panelId="dns-rpz" rpz={rpz} />
        <DtcLbdnPanel panelId="dns-dtc-lbdn" dtcLbdn={dtcLbdn} />
        {savedCharts}
      </CardGrid>
    </div>
  )
}

// ---------- hero ----------

function QpsHero({ panelId, qps }) {
  const { COLORS } = useChartTheme()
  const rows = qps.data?.rows ?? []
  const status = qps.data?.status
  const chartData = rows.map((r) => ({ label: clock(r.hour), value: Number(r.avg_value) || 0 }))
  // The big number is the latest reading as sent: a missing one is a dash,
  // not the 0 the chart has to draw it as.
  const current = rows.length ? reading(rows[rows.length - 1].avg_value) : null
  // Against the same time yesterday, never the first hour on the chart: that
  // set a quiet night against a busy afternoon. Grey either way: more DNS
  // traffic is not good or bad news on its own.
  const cmp = vsYesterday(rows)

  return (
    <Card
      panelId={panelId}
      span={4}
      title="DNS Query Rate — 24h"
      right={<span className="flex items-center gap-1.5 text-note text-muted"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.series }} />queries per second</span>}
    >
      {qps.loading ? (
        <Skeleton h={250} />
      ) : qps.error || status === 'error' ? (
        <FeedUnavailable label="DNS query rate feed unavailable" />
      ) : chartData.length === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="flex items-baseline gap-3 my-2">
            <span className="text-figure font-semibold tracking-tight">{current == null ? '—' : current.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
            {cmp && (
              <Tip
                className="text-note text-muted"
                data-qps-change=""
                tip={`${clock(cmp.nowHour)} today, so far: ${fmtQps(cmp.now)} a second. ${clock(cmp.wasHour)} yesterday: ${fmtQps(cmp.was)} a second.`}
              >
                {changeText(cmp)} vs yesterday
              </Tip>
            )}
          </div>
          {/* The big number above this chart already rounds to one decimal;
              the hover used to disagree with it by ten digits (`value :
              274.715`). Same series, same rounding, and the unit said out
              loud — the point labels are already clock times ("03:00 PM"),
              which fmtShortDay hands back untouched. */}
          <Suspense fallback={<Skeleton h={230} />}>
            <GradientArea
              label="DNS Query Rate — 24h"
              data={chartData}
              color={COLORS.series}
              gradientId="qpsFill"
              unit="queries per second"
              height={230}
              yDomain={['dataMin - 0.5', 'dataMax + 0.5']}
            />
          </Suspense>
        </>
      )}
    </Card>
  )
}

// ---------- zone ttl ----------
//
// A zone whose upstream carries no zone_authority publishes no TTL at all, so
// the backend emits ttl/neg_ttl as null and skips the TTL health checks for it
// (issues/anomaly stay null) rather than fabricating 3600 and declaring the
// zone healthy. The UI has to keep that distinction: an unknown TTL is not a
// value, so it is not a number, not a zero, and not a clean result.

/** Numeric TTL, or null when the zone never published one. */
function ttlValue(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** True when this zone was actually run through the TTL checks. */
function ttlChecked(z) {
  return Array.isArray(z.issues)
}

/** True when the checks ran and found at least one issue. */
function hasIssues(z) {
  return Array.isArray(z.issues) && z.issues.length > 0
}

// Reverse zones end in in-addr.arpa or ip6.arpa; the same rule Get an address
// uses to split its zone lists (SelfService.jsx).
const isReverseZone = (z) => /(^|\.)(in-addr|ip6)\.arpa\.?$/i.test(String(z.fqdn ?? ''))

// Zones with issues first, then zones the checks never ran on, then the rest;
// A to Z within each. Sorting A to Z alone buried 64 zones with issues among
// 1,445 (review, 2026-11-10).
const zoneRank = (z) => (hasIssues(z) ? 2 : ttlChecked(z) ? 0 : 1)

// Sort by TTL with unknowns last in BOTH directions. `Number(null) || 0` used
// to file every unknown-TTL zone at the very front of an ascending sort, right
// among the genuinely dangerous 30-second zones.
function ttlCompare(a, b, dir) {
  const av = ttlValue(a.ttl)
  const bv = ttlValue(b.ttl)
  if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1
  return dir === 'asc' ? av - bv : bv - av
}

// ---------- zone kpis ----------
//
// The headline already says how many zones have issues and out of how many,
// so this panel no longer repeats those numbers. It says which kinds of issue
// they are, largest first, each opening the zones that have it; then how the
// zones split into forward and reverse, and how many were never checked.

function ZoneKpis({ panelId, zones, zonesStatus, loading }) {
  const { COLORS } = useChartTheme()
  // A load in flight is not a verdict. Without this the panel would print
  // confident zeros (before) or a feed-unavailable notice (now that an
  // unarrived slice reads as 'error') for a read that simply has not finished.
  if (loading) {
    return (
      <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col justify-between">
        <Skeleton h={200} />
      </Card>
    )
  }
  // Every line here reads the same `zones` feed — a dead read means none of
  // these counts are known, not that they're all zero.
  if (zones.length === 0 && zonesStatus === 'error') {
    return (
      <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col justify-between">
        <FeedUnavailable label="DNS zones feed unavailable" />
      </Card>
    )
  }

  const byKind = new Map()
  for (const z of zones) if (hasIssues(z)) for (const k of new Set(z.issues)) byKind.set(k, (byKind.get(k) ?? 0) + 1)
  const kinds = [...byKind].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  const top = kinds[0]?.[1] || 1
  // Zones with no published TTL were never run through the checks. They are
  // not clean zones — they are unexamined ones.
  const unchecked = zones.length - zones.filter(ttlChecked).length
  const reverse = zones.filter(isReverseZone).length
  // The server's own "unusual settings" flag, counted as it always was, so
  // nothing the old panel showed is lost.
  const anomalies = zones.filter((z) => z.anomaly).length
  const open = (kind) => {
    location.hash = `dns?issues=${encodeURIComponent(kind)}`
    setTimeout(() => jumpToPanel('dns-zones'), 0)
  }

  return (
    // All three branches of this component are the SAME panel and carry the
    // same `panelName`: they are the loading, the dead-feed and the data views
    // of one tile, so the popup must call it one thing whichever is on screen.
    // It draws no heading, which is why its About button is named by its id.
    <Card panelId={panelId} span={2} panelName="Zone Counts" className="flex flex-col">
      <div className="text-note text-muted pt-1 pb-2">Issues by kind</div>
      {kinds.length ? (
        <ul className="dns-kinds" aria-label="Zone issues by kind">
          {kinds.map(([k, n]) => (
            <li key={k}>
              <button type="button" className="dns-kind" onClick={() => open(k)} aria-label={`${issueWord(k)}: ${n.toLocaleString()} zones. Show them.`}>
                <span className="dns-kind-name">{issueWord(k)}</span>
                <span className="dns-kind-n">{n.toLocaleString()}</span>
                <i className="dns-kind-bar" aria-hidden="true" style={{ '--w': `${(n / top) * 100}%`, '--c': COLORS.crit }} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-copy text-muted py-2">{zones.length === 0 ? 'No zones' : unchecked === zones.length ? 'None checked' : 'None found'}</div>
      )}
      <dl className="dns-split mt-auto">
        <div><dt>Forward</dt><dd>{(zones.length - reverse).toLocaleString()}</dd></div>
        <div><dt>Reverse</dt><dd>{reverse.toLocaleString()}</dd></div>
        <div><dt>Unusual settings</dt><dd style={anomalies > 0 ? { color: COLORS.warn } : undefined}>{anomalies.toLocaleString()}</dd></div>
        {unchecked > 0 && <div><dt>Not checked</dt><dd>{unchecked.toLocaleString()}</dd></div>}
      </dl>
    </Card>
  )
}

// ---------- dns services ----------

function DnsServices({ panelId, services }) {
  const rows = services.data?.rows ?? []
  const status = services.data?.status

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'comment', label: 'Comment', grow: true },
    { key: 'pool_id', label: 'Pool ID', mono: true },
  ]

  return (
    <Card panelId={panelId} span={3} title="DNS Services" right={<span className="text-note text-muted">{rows.length ? `${rows.length} services` : ''}</span>}>
      {services.loading ? (
        <Skeleton h={180} />
      ) : services.error || status === 'error' ? (
        <FeedUnavailable label="DNS services feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <DataTable rows={rows} columns={columns} maxHeight={320} rowKey={(r, i) => `${r.id ?? ''}|${i}`} />
      )}
    </Card>
  )
}

// ---------- query volume 7d (known-broken feed) ----------

function QueryVolume7d({ panelId, analytics }) {
  const { COLORS } = useChartTheme()
  // dns-analytics can legitimately return zero rows for a tenant with no query
  // activity — that must render as empty, not as a dead feed. Only a fetch
  // error or an explicit availability:"error" from the backend (a dead
  // cubejs) counts as broken; a genuinely empty "ok" fetch does not.
  const volume = analytics.data?.volume ?? []
  const broken = !!analytics.error || analytics.data?.availability === 'error'
  // `r.hour ?? i` was reading a field these rows have never carried. Verified
  // against the live feed on 2026-08-07: each row is
  // {timestamp, "timestamp.day", total_query_count} — no `hour` anywhere, so
  // every label fell through to the array index and this chart spent its life
  // labelling seven days of traffic 0,1,2,3,4,5,6 on the axis AND in the hover.
  // `hour` stays in the chain because the qps feed does use that name and this
  // panel is the one that would inherit it if the two were ever merged.
  const chartData = volume.map((r, i) => ({
    label: r.timestamp ?? r.hour ?? i,
    value: Number(r.total_query_count) || 0,
  }))

  return (
    <Card panelId={panelId} span={3} title="Query Volume — 7d">
      {analytics.loading ? (
        <Skeleton h={180} />
      ) : broken ? (
        // "no data" in the body with "feed unavailable" in small grey beside
        // the title was the wrong way round: the empty-looking half was the
        // one people read.
        <FeedUnavailable label="DNS query volume feed unavailable" reason={analytics.error?.message || undefined} />
      ) : (
        /* The label is now the day itself, so both the axis and the hover
           have to spell it — an ISO timestamp on the axis would just be a
           different kind of unreadable than the index it replaced. */
        <Suspense fallback={<Skeleton h={200} />}>
          <GradientArea
            label="Query Volume — 7d"
            data={chartData}
            color={COLORS.series}
            gradientId="volFill"
            unit="queries"
            height={200}
            tickFormat={fmtShortDay}
          />
        </Suspense>
      )}
    </Card>
  )
}

// ---------- zone table ----------

function ZoneTable({ panelId, zones, issuesOnly, zonesStatus, loading }) {
  const { COLORS } = useChartTheme()
  const theme = useThemeColors()
  const [filter, setFilter] = useState('')
  // Issues first by default (zoneRank), A to Z within. A header click still
  // sorts by any column.
  const [sort, setSort] = useState({ key: 'issues', dir: 'desc' })
  // `issues=1` lists every zone with an issue; `issues=<kind>` (from Zone
  // Counts) lists the zones with that one kind.
  const kind = issuesOnly && issuesOnly !== '1' ? issuesOnly : null

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let base = issuesOnly ? zones.filter((z) => hasIssues(z) && (!kind || z.issues.includes(kind))) : zones
    if (!q) return base
    return base.filter((z) => [z.fqdn, z.view].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [zones, filter, issuesOnly, kind])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    const byName = (a, b) => String(a.fqdn || '').localeCompare(String(b.fqdn || ''))
    arr.sort((a, b) => {
      // TTL has a third outcome — unknown — so it cannot go through the
      // number branch below, which would rank it as 0.
      if (key === 'ttl') return ttlCompare(a, b, dir)
      // Issues: zones with issues, then unchecked, then clean; more issues
      // before fewer; A to Z within, whichever way the column is turned.
      if (key === 'issues') {
        const d = zoneRank(a) - zoneRank(b) || (a.issues?.length || 0) - (b.issues?.length || 0)
        return (dir === 'asc' ? d : -d) || byName(a, b)
      }
      let av, bv
      if (key === 'fqdn') { av = a.fqdn || ''; bv = b.fqdn || '' }
      else if (key === 'view') { av = a.view || ''; bv = b.view || '' }
      else if (key === 'records') { av = Number(a.records) || 0; bv = Number(b.records) || 0 }
      else { av = a.fqdn || ''; bv = b.fqdn || '' }
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? av - bv : bv - av
    })
    return arr
  }, [filtered, sort])

  // Map zone objects -> DataTable rows. `records` is a formatted string and `issues`
  // is the crit text / anomaly pill node (or '—') so the primitive's hideWhenConstant
  // can auto-drop them when every value is "0" / "—" respectively.
  const rows = useMemo(() => sorted.map((z) => {
    const issues = hasIssues(z)
    const issuesCell = issues ? (
      <span className="text-note inline-flex items-center gap-1.5" style={{ color: COLORS.crit }}>
        <i aria-hidden="true" className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: COLORS.crit }} />
        {z.issues.map(issueWord).join(', ')}
      </span>
    ) : z.anomaly ? (
      <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>anomaly</span>
    ) : ttlChecked(z) ? '—' : (
      // Distinct from the clean '—': this zone published no TTL, so the checks
      // never ran on it. Silence here would read as "checked, nothing wrong".
      <span className="text-note italic text-dim" title="no TTL published — TTL checks did not run for this zone">not checked</span>
    )
    const ttl = ttlValue(z.ttl)
    return {
      fqdn: z.fqdn,
      view: z.view,
      records: (Number(z.records) || 0).toLocaleString(),
      // No TTL published => em-dash, never a number this zone does not have.
      ttl: ttl == null ? '—' : ttl,
      issues: issuesCell,
      _hasIssues: issues,
    }
  }), [sorted, COLORS])

  // The Issues column stays whenever any zone has an issue or went unchecked.
  // Left to hideWhenConstant, a single zone with an issue made the column's
  // only non-empty cell "constant" and hid the one thing worth seeing.
  const anyFlag = zones.some((z) => hasIssues(z) || z.anomaly || !ttlChecked(z))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, keep: true, grow: true, sortable: true },
    { key: 'view', label: 'View', sortable: true },
    { key: 'records', label: 'Records', align: 'right', mono: true, hideWhenConstant: true, sortable: true },
    // keep: DataTable auto-hides a column whose every cell is empty, and '—' is
    // an empty cell to it. A view where no zone publishes a TTL must still show
    // the TTL column full of dashes — silently dropping it reads as "TTL isn't
    // tracked" instead of "we don't know it".
    { key: 'ttl', label: 'TTL', mono: true, sortable: true, keep: true },
    { key: 'issues', label: 'Issues', hideWhenConstant: true, keep: anyFlag, sortable: true },
  ]

  return (
    <Card
      panelId={panelId}
      span={6}
      // The heading becomes a React node the moment the issues-only filter is
      // on, so without this the popup's row for this panel flipped between
      // "DNS Zones" and the raw "dns-zones" depending on how the tab was
      // filtered. The name is the heading's constant half.
      panelName="DNS Zones"
      title={
        issuesOnly ? (
          <span className="inline-flex items-center gap-2">
            DNS Zones
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => { location.hash = 'dns' }}
              className="text-note font-medium px-2 py-0.5 rounded-full cursor-pointer"
              style={{ background: theme.pillNeutralBg, color: theme.pillNeutralFg }}
            >
              {kind ? issueWord(kind) : 'issues only'} ✕
            </button>
          </span>
        ) : 'DNS Zones'
      }
      right={
        <div className="flex items-center gap-2.5">
          <span className="text-note text-muted whitespace-nowrap">{sorted.length.toLocaleString()} zones</span>
          <input {...MACHINE_TEXT}
            aria-label="Filter zones"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[170px]`}
          />
        </div>
      }
    >
      {loading ? (
        // Same reason as ZoneKpis: an unfinished read is neither "no zones"
        // nor "the feed is dead".
        <Skeleton h={250} />
      ) : zones.length === 0 ? (
        zonesStatus === 'error' ? <FeedUnavailable label="DNS zones feed unavailable" /> : <Empty />
      ) : sorted.length === 0 ? (
        <Empty>no zones match</Empty>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          sort={sort}
          onSort={setSort}
          maxHeight={420}
          rowCap={150}
          stickyHeader
          rowKey={(r, i) => (r.fqdn || '') + i}
          rowStyle={(r) => (r._hasIssues ? { background: 'rgba(238,68,68,0.06)' } : undefined)}
        />
      )}
    </Card>
  )
}

// ---------- dnssec health ----------

const DNSSEC_CAP = 150

function DnssecHealth({ panelId, dnssec }) {
  const { COLORS } = useChartTheme()
  // The same counts as the Signing headline, from the same helper.
  const { rows, failed, publicRows, signed: signedCount, unsigned: unsignedCount, internal: internalCount } = signing(dnssec)
  const signedShare = publicRows.length ? (signedCount / publicRows.length) * 100 : null

  // This panel used to say "worst 150" over `unsigned.slice(0, DNSSEC_CAP)` of
  // whatever order the upstream happened to return. Checked the live payload on
  // 2026-08-07: a row carries fqdn, view, id, dnssec_status and
  // dnssec_signing_policy, and nothing else. There is no severity, no age, no
  // record count — nothing that ranks one unsigned zone above another, so
  // "worst" was a claim the data cannot make and the cut was also non-repeatable
  // between reloads. Sorting A–Z cannot invent severity, but it does make the
  // 150 you see the same 150 every time, and the header now says which 150 they
  // are. If the upstream ever adds a real severity field, sort by that instead
  // and the header should say so.
  const unsigned = publicRows
    .filter((r) => r.dnssec_status === 'UNSIGNED')
    .sort((a, b) => String(a.fqdn ?? '').localeCompare(String(b.fqdn ?? '')))
  const shown = unsigned.slice(0, DNSSEC_CAP)

  const tableRows = shown.map((r, i) => ({
    fqdn: r.fqdn,
    view: r.view,
    dnssec_status: r.dnssec_status,
    dnssec_signing_policy: r.dnssec_signing_policy || '—',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'view', label: 'View', mono: true, maxCh: 22 }, // measured: opaque resource path overflows the card; cap it
    { key: 'dnssec_signing_policy', label: 'Signing Policy' },
  ]

  return (
    <Card
      panelId={panelId}
      span={3}
      title="DNSSEC Health"
      right={
        <span className="text-note text-muted">{dnssecPanelLabel(unsigned.length, DNSSEC_CAP)}</span>
      }
    >
      {dnssec.loading ? (
        <Skeleton h={280} />
      ) : failed ? (
        <FeedUnavailable label="DNSSEC feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no DNSSEC data</Empty>
      ) : (
        <>
          {/* Not signed leads, in amber when there are any: it is the one
              that needs a look. Signed is never green: a count of signed
              zones is not good news when most public ones are not. */}
          <dl className="dns-stats">
            <div>
              <dt>Not signed</dt>
              <dd style={unsignedCount > 0 ? { color: COLORS.warn } : undefined}>{unsignedCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Signed</dt>
              <dd>{signedCount.toLocaleString()}</dd>
            </div>
            {signedShare != null && (
              <div>
                <dt><Tip tip={`Of the ${publicRows.length.toLocaleString()} zones with public names.`}>Signed share</Tip></dt>
                <dd>{signedShare.toFixed(1)}%</dd>
              </div>
            )}
            <div>
              <dt><Tip tip="Reverse zones and names such as .local or .lab, which need no signing.">Internal</Tip></dt>
              <dd className="text-muted">{internalCount.toLocaleString()}</dd>
            </div>
          </dl>
          {publicRows.length === 0 ? (
            <Empty>no zones with public names</Empty>
          ) : unsigned.length === 0 ? (
            <Empty>all zones with public names are signed</Empty>
          ) : (
            <DataTable rows={tableRows} columns={columns} maxHeight={260} rowCap={DNSSEC_CAP} rowKey={(r) => r._k} />
          )}
        </>
      )}
    </Card>
  )
}

// ---------- rpz policy zones ----------

function RpzPanel({ panelId, rpz }) {
  const rows = rpz.data?.rows ?? []
  const total = rpz.data?.count ?? rows.length
  // Same errRows() contract as DnssecHealth — status:"error" at HTTP 200.
  const status = rpz.data?.status

  const tableRows = rows.map((r, i) => ({
    fqdn: r.fqdn,
    severity: r.severity || '—',
    policy_override: r.policy_override || '—',
    type: r.type || '—',
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'severity', label: 'Severity' },
    { key: 'policy_override', label: 'Policy Override' },
    { key: 'type', label: 'Type' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="RPZ Policy Zones" right={<span className="text-note text-muted">{rows.length ? `${total.toLocaleString()} zones` : ''}</span>}>
      {rpz.loading ? (
        <Skeleton h={200} />
      ) : rpz.error || status === 'error' ? (
        <FeedUnavailable label="RPZ feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no RPZ zones</Empty>
      ) : (
        <DataTable rows={tableRows} columns={columns} maxHeight={260} rowKey={(r) => r._k} />
      )}
    </Card>
  )
}

// ---------- dtc load-balanced names ----------

function DtcLbdnPanel({ panelId, dtcLbdn }) {
  const rows = dtcLbdn.data?.rows ?? []
  const total = dtcLbdn.data?.count ?? rows.length
  // Same errRows() contract as DnssecHealth/RpzPanel — status:"error" at HTTP 200.
  const status = dtcLbdn.data?.status

  const tableRows = rows.map((r, i) => ({
    name: r.name,
    dtc_policy: r.dtc_policy || '—',
    precedence: r.precedence,
    ttl: r.ttl,
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.name ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'name', label: 'Name', mono: true, grow: true },
    { key: 'dtc_policy', label: 'Policy' },
    { key: 'precedence', label: 'Precedence', align: 'right', mono: true },
    { key: 'ttl', label: 'TTL', mono: true, align: 'right' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="DTC Load-Balanced Names" right={<span className="text-note text-muted">{rows.length ? `${total.toLocaleString()} names` : ''}</span>}>
      {dtcLbdn.loading ? (
        <Skeleton h={200} />
      ) : dtcLbdn.error || status === 'error' ? (
        <FeedUnavailable label="DTC LBDN feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no LBDN records</Empty>
      ) : (
        <DataTable rows={tableRows} columns={columns} maxHeight={260} rowKey={(r) => r._k} />
      )}
    </Card>
  )
}
