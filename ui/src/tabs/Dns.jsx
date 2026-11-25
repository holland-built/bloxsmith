import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { itemCell } from '../components/itemCell.jsx'
import { useApi } from '../lib/api.js'
import { useData } from '../lib/data.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, hiddenPanelGroup, Skeleton, TabIntro, useChartTheme } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { dnssecPanelLabel, fmtShortDay } from '../lib/chartFormat.js'
import { useHashParams } from '../lib/hash.js'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { useThemeColors } from '../lib/theme.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { useSavedChartPanels } from '../components/useSavedChartPanels.jsx'
import { cacheTime, COULD_NOT_READ, countOf, failReason, issueWord } from '../lib/plainWords.js'
import { PROBLEM_SEV, SEV_WORD } from '../lib/severity.js'
import { changeText, reading, vsYesterday } from '../lib/dnsCompare.js'
import { healthMetric } from '../lib/dnsHealth.js'
import { FAILURE_WINDOWS, failuresUrl, failuresView, NOT_CHECKED, readWindow, saveWindow } from '../lib/dnsFailures.js'
import Tip from '../components/Tip.jsx'
import { jumpToPanel } from '../lib/jumpToPanel.js'
import './Overview.css'
import './Dns.css'
import { formatTime } from '../lib/dates.js'
import { HeadlineStrip, PageTitle } from '../components/kit.jsx'
import UpdatedPill from './UpdatedPill.jsx'

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
// "Compare views" loads only when it is opened.
const ZoneCompare = lazy(() => import('../components/ZoneCompare.jsx'))

// CSPDNSServices asks Infoblox for `_limit: 200` (go/internal/dashboard/csp.go),
// so a list of exactly that many may have been cut there.
const SERVICES_LIMIT = 200

const fmtQps = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1))
const clock = (h) => {
  const d = new Date(h)
  return isNaN(d) ? String(h) : formatTime(d)
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
  const zoneWord = zonesLoading ? ['Checking', 'none'] : !zonesOk ? ['', 'none']
    : withIssues > 0 ? [SEV_WORD[PROBLEM_SEV.zoneIssues], PROBLEM_SEV.zoneIssues] : unchecked > 0 ? ['Partly checked', 'none'] : zones.length ? ['Healthy', 'ok'] : ['', 'none']

  const sg = signing(dnssec)
  const sgOk = !dnssec.loading && !sg.failed
  const sgWord = dnssec.loading ? ['Checking', 'none'] : !sgOk ? ['', 'none']
    : sg.unsigned > 0 ? [SEV_WORD.warn, 'warn'] : sg.publicRows.length ? ['Healthy', 'ok'] : ['', 'none']

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
      key: 'signing', label: 'Zone signing', panelId: 'dns-dnssec-health',
      value: sgOk ? sg.unsigned.toLocaleString() : null, loading: dnssec.loading, unit: 'not signed',
      word: sgWord[0], sev: sgWord[1],
      sub: sgOk ? `of ${sg.publicRows.length.toLocaleString()} public` : '',
      tip: sgOk ? 'Zones with public names, such as .com, that are not signed against tampering. Internal zones (reverse, .local, .lab) need no signing and are not counted.' : null,
    },
    {
      key: 'services', label: 'DNS services', panelId: 'dns-services',
      value: svcOk ? `${svc.length.toLocaleString()}${svcCapped ? '+' : ''}` : null, loading: services.loading, unit: '',
      sub: '',
      tip: svcOk ? `DNS services on this tenant.${svcCapped ? ` The list stops at ${SERVICES_LIMIT}.` : ''} Infoblox gives no up or down state, so this is a count, not a health check.` : null,
    },
  ]
}

// The shared strip, as on Infra and Assets (GUI audit B9). Each tile's
// verdict word ("Review", "Unavailable") leads its note line, so the word that
// used to sit at the tile's top right still shows beside the colour.
function stripItems(props) {
  return headlines(props).map((t) => ({
    tile: t.key,
    label: t.label,
    panelId: t.panelId,
    href: t.href || undefined,
    jumpTo: t.href ? t.panelId : undefined,
    value: t.value,
    loading: t.loading,
    unit: t.value != null && t.unit ? t.unit : undefined,
    tone: t.value != null && t.value !== '0' && (t.sev === 'warn' || t.sev === 'crit') ? t.sev : undefined,
    tip: t.tip || undefined,
    note: t.word || t.sub ? (
      <>
        {t.word ? <span className={`ov-verdict ${t.sev}`}>{t.word}</span> : null}
        {t.word && t.sub ? ' · ' : null}
        {t.sub}
      </>
    ) : undefined,
  }))
}

export default function Dns() {
  // Charts added from Build a chart; they join the grid as ordinary panels.
  const savedCharts = useSavedChartPanels('dns')
  const qps = useApi('/api/csp/dns-qps', { poll: 30000 })
  // A day's averages, so once a minute is plenty.
  const health = useApi('/api/csp/dns-health', { poll: 60000 })
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

  return (
    <div className="w-full px-6 py-5 ov-look dns-page">
      <div className="ov-head">
        <PageTitle>DNS</PageTitle>
        {/* When the zones payload arrived, not the time of this render. */}
        <UpdatedPill api={data} tip="Every number here is fetched again every 30 seconds." />
      </div>
      <TabIntro>How your DNS is answering: lookups, failures, zones and their settings.</TabIntro>
      <HeadlineStrip label="Headline numbers" items={stripItems({ qps, services, zones, zonesStatus, zonesFailed: !!data.error, zonesLoading: data.loading, dnssec })} />
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
          children: [
            <QpsHero key="dns-query-rate" panelId="dns-query-rate" qps={qps} />,
            <DnsAnswers key="dns-answers" panelId="dns-answers" health={health} />,
            <FailedLookups key="dns-failed-lookups" panelId="dns-failed-lookups" />,
          ],
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
        <ZoneTable panelId="dns-zones" zones={zones} issuesOnly={hp.issues || ''} zonesStatus={zonesStatus} loading={data.loading} readFailed={!!data.error} dnssec={dnssec} />
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
        <FeedUnavailable label="DNS Query Rate unavailable" reason={failReason(qps)} />
      ) : chartData.length === 0 ? (
        <Empty>No DNS query rate readings for this period</Empty>
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

// ---------- answers ----------

// How DNS answered over the last 24 hours: how long an answer took, split by
// where it came from, and what share were cache hits, server failures or
// names that do not exist. Each number stands on its own: a metric whose read
// failed says "not checked" and the rest are still shown (lib/dnsHealth.js).
const ANSWER_TIMES = [
  ['answer_time', 'All answers', 'The average time to answer any lookup.'],
  ['answer_time_own', 'From your own zones', 'Lookups your servers answered from zones they hold themselves.'],
  ['answer_time_upstream', 'Asked elsewhere', 'Lookups your servers had to pass on to other DNS servers on the internet.'],
]
const ANSWER_SHARES = [
  ['cache_hit', 'Answered from cache', 'The share of lookups answered from a recent answer the server kept (its cache), without asking anyone again.'],
  ['servfail', 'Failed', 'The share of lookups the server could not answer at all (SERVFAIL).'],
  ['nxdomain', 'Name not found', 'The share of lookups for a name that does not exist (NXDOMAIN). Often typing errors or old settings.'],
  ['timeouts', 'Timeouts', 'How many times a second your servers gave up waiting for another DNS server to reply.'],
]

function DnsAnswers({ panelId, health }) {
  const dead = !health.loading && (!!health.error || health.data?.status === 'error')
  const stat = ([key, label, tip]) => {
    const m = healthMetric(health, key)
    return (
      <div key={key} data-dns-health-metric={key} data-state={m.state}>
        <dt><Tip tip={tip}>{label}</Tip></dt>
        <dd className={m.state === 'ok' ? undefined : 'text-muted'} style={m.state === 'ok' ? undefined : { fontSize: 15, fontWeight: 400 }}>{m.text}</dd>
      </div>
    )
  }
  return (
    <Card panelId={panelId} span={2} title="DNS Answers — 24h">
      {health.loading && !health.data ? (
        <Skeleton h={180} />
      ) : dead ? (
        <FeedUnavailable label="DNS Answers unavailable" reason={failReason(health)} />
      ) : (
        <>
          <div className="text-note text-muted pt-1">Average time to answer</div>
          <dl className="dns-stats">{ANSWER_TIMES.map(stat)}</dl>
          <div className="text-note text-muted">How lookups ended</div>
          <dl className="dns-stats">{ANSWER_SHARES.map(stat)}</dl>
        </>
      )}
    </Card>
  )
}

// ---------- failed lookups ----------

// Failed lookups over a window the viewer picks: the total, split by
// response code, and the names that failed most (lib/dnsFailures.js). The
// server picks which records to read by how far back the window goes, and the
// line under the table says which. A read that failed says "not checked".
// "Refused (REFUSED)" -> "Refused" on screen, with the DNS code kept in the
// tip for anyone who needs it (GUI audit B10).
const CODE_RE = / \(([A-Z]+)\)$/
const codeLabel = (label) => String(label).replace(CODE_RE, '')
function codeTip(c) {
  const code = String(c.label).match(CODE_RE)?.[1]
  return code ? `${c.tip} DNS calls this ${code}.` : c.tip
}

function FailedLookups({ panelId }) {
  const [win, setWin] = useState(readWindow)
  // Totals over hours or days, so once a minute is plenty.
  const feed = useApi(failuresUrl(win), { poll: 60000 })
  const v = failuresView(feed, win)
  const someFailed = v.state === 'error' || [v.total, ...(v.codes ?? [])].some((n) => n?.text === NOT_CHECKED) || v.namesText === NOT_CHECKED
  // The server reads the top 10 only; the heading below says so.
  const names = v.names
  const pick = (w) => {
    setWin(w)
    saveWindow(w)
  }
  const columns = [
    { key: 'name', label: 'Name', mono: true, grow: true },
    { key: 'text', label: 'Failed', align: 'right', mono: true },
  ]
  return (
    <Card
      panelId={panelId}
      span={2}
      title="Failed Lookups"
      right={
        <select aria-label="Time window" className={FIELD_CLS} value={win} onChange={(e) => pick(e.target.value)}>
          {FAILURE_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
      }
    >
      {v.state === 'loading' ? (
        <Skeleton h={180} />
      ) : (
        <>
          {/* Any read failed: say so once, with a way to ask again. When only
              some failed, each of those says "not checked" on its own; when
              the whole read failed there are no numbers to show (GUI audit B2). */}
          {someFailed && (
            <p role="status" data-panel-failed="" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-copy pt-1">
              {/* FetchError's look, at body size (GUI audit R3-B2). */}
              <span className="font-semibold text-crit">{v.state === 'error' ? "Couldn't read these numbers from Infoblox." : "Couldn't read some of these numbers from Infoblox."}</span>
              <button type="button" onClick={feed.refetch} className="px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy">
                Try again
              </button>
            </p>
          )}
          {v.state !== 'error' && <>
          <dl className="dns-stats">
            <div data-failed-total="" data-state={v.total.value == null ? 'unknown' : 'ok'}>
              <dt>Failed lookups</dt>
              <dd className={v.total.value == null ? 'text-muted' : undefined} style={v.total.value == null ? { fontSize: 15, fontWeight: 400 } : undefined}>{v.total.text}</dd>
            </div>
          </dl>
          <dl className="dns-stats">
            {v.codes.map((c) => (
              <div key={c.key} data-failed-code={c.key}>
                <dt><Tip tip={codeTip(c)}>{codeLabel(c.label)}</Tip></dt>
                <dd className={c.value == null ? 'text-muted' : undefined} style={c.value == null ? { fontSize: 15, fontWeight: 400 } : undefined}>{c.text}</dd>
              </div>
            ))}
          </dl>
          <div className="text-note text-muted">The 10 names that failed most</div>
          {names == null ? (
            <div className="text-copy text-muted py-2" data-failed-names="unknown">{v.namesText}</div>
          ) : (
            <div className="mt-1.5">
              <DataTable rows={names} columns={columns} maxHeight={320} />
            </div>
          )}
          {v.note && <div className="text-copy text-muted mt-2" data-failed-note="">{v.note}</div>}
          {v.source && <div className="text-note text-muted mt-2" data-failed-source="">{v.source}</div>}
          </>}
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
      <Card panelId={panelId} span={2} title="Zone problems" className="flex flex-col justify-between">
        <Skeleton h={200} />
      </Card>
    )
  }
  // Every line here reads the same `zones` feed — a dead read means none of
  // these counts are known, not that they're all zero.
  if (zones.length === 0 && zonesStatus === 'error') {
    return (
      <Card panelId={panelId} span={2} title="Zone problems">
        <FeedUnavailable label="Zone problems unavailable" reason={COULD_NOT_READ} />
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
    // same title: they are the loading, the dead-feed and the data views of
    // one tile, so the popup must call it one thing whichever is on screen.
    // It had no heading until GUI audit B11, so a failed read left it blank.
    <Card panelId={panelId} span={2} title="Zone problems" className="flex flex-col">
      <div className="text-note text-muted pt-1 pb-2">Issues by kind</div>
      {kinds.length ? (
        <ul className="dns-kinds" aria-label="Zone issues by kind">
          {kinds.map(([k, n]) => (
            <li key={k}>
              <button type="button" className="dns-kind" onClick={() => open(k)} aria-label={`${issueWord(k)}: ${countOf(n, 'zone')}. Show them.`}>
                <span className="dns-kind-name">{issueWord(k)}</span>
                <span className="dns-kind-n" style={{ '--c': COLORS[PROBLEM_SEV.zoneIssues] }}>{n.toLocaleString()}</span>
                <i className="dns-kind-bar" aria-hidden="true" style={{ '--w': `${(n / top) * 100}%`, '--c': COLORS[PROBLEM_SEV.zoneIssues] }} />
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
    // Which server group the service runs on. Infoblox sends only the
    // group's id (csp.go normDNSServices), so the id is what there is to show.
    { key: 'pool_id', label: 'Server group', mono: true },
  ]

  return (
    <Card panelId={panelId} span={2} title="DNS Services" right={<span className="text-note text-muted">{rows.length ? countOf(rows.length, 'service') : ''}</span>}>
      {services.loading ? (
        <Skeleton h={180} />
      ) : services.error || status === 'error' ? (
        <FeedUnavailable label="DNS Services unavailable" reason={failReason(services)} />
      ) : rows.length === 0 ? (
        <Empty>No DNS services found</Empty>
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
        <FeedUnavailable label="Query Volume unavailable" reason={failReason(analytics)} />
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

function ZoneTable({ panelId, zones, issuesOnly, zonesStatus, loading, readFailed, dnssec }) {
  const { COLORS } = useChartTheme()
  const theme = useThemeColors()
  const [filter, setFilter] = useState('')
  const [comparing, setComparing] = useState(false)
  // "Compare views" is offered only when some zone name is in two or more views.
  const canCompare = useMemo(() => {
    const seen = new Set()
    for (const z of zones) {
      if (seen.has(z.fqdn)) return true
      seen.add(z.fqdn)
    }
    return false
  }, [zones])
  // Issues first by default (zoneRank), A to Z within. A header click still
  // sorts by any column.
  const [sort, setSort] = useState({ key: 'issues', dir: 'desc' })
  // `issues=1` lists every zone with an issue; `issues=<kind>` (from Zone
  // Counts) lists the zones with that one kind.
  // `issues=dnssec` lists public zones that are not signed, from the signing
  // feed, because only that feed marks which names are public.
  const notSigned = issuesOnly === 'dnssec'
  const kind = issuesOnly && issuesOnly !== '1' && !notSigned ? issuesOnly : null
  const signingFailed = !!dnssec.error || dnssec.data?.status === 'error'

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let base = zones
    if (notSigned) {
      const byId = new Map(zones.map((z) => [z.id, z]))
      base = signing({ data: dnssec.data }).publicRows
        .filter((r) => r.dnssec_status === 'UNSIGNED')
        .map((r) => ({ ...r, ...byId.get(r.id) }))
    } else if (issuesOnly) {
      base = zones.filter((z) => hasIssues(z) && (!kind || z.issues.includes(kind)))
    }
    if (!q) return base
    return base.filter((z) => [z.fqdn, z.view].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
  }, [zones, filter, issuesOnly, kind, notSigned, dnssec.data])

  // Arriving on a filtered address: the list in view once its feed has loaded.
  // Once per address, so a 30s poll never moves the page.
  const listLoading = notSigned ? dnssec.loading : loading
  const jumpedFor = useRef(null)
  useEffect(() => {
    if (!issuesOnly) { jumpedFor.current = null; return }
    if (listLoading || jumpedFor.current === issuesOnly) return
    jumpedFor.current = issuesOnly
    jumpToPanel(panelId)
  }, [issuesOnly, listLoading, panelId])

  const landingWhat = notSigned ? 'public zones not signed' : kind ? `zones with this problem: ${issueWord(kind)}` : 'zones with DNS timing problems'
  const listFailed = notSigned ? signingFailed : filtered.length === 0 && (readFailed || zonesStatus === 'error')
  const uncheckedCount = notSigned ? 0 : zones.length - zones.filter(ttlChecked).length
  const landingLine = listLoading ? `Checking ${landingWhat}…`
    : listFailed ? `Could not load zones, so the ${landingWhat} are not known.`
    : filtered.length === 0 ? (filter.trim() ? `None of the ${landingWhat} match your search.`
      : `No ${landingWhat}.${uncheckedCount ? ` ${countOf(uncheckedCount, 'zone')} could not be checked.` : ''}`)
    : `Showing ${filtered.length > 150 ? `the first 150 of ${filtered.length.toLocaleString()}` : filtered.length.toLocaleString()} ${filtered.length === 1 ? landingWhat.replace('zones', 'zone') : landingWhat}.${!notSigned && readFailed ? ' The latest read failed, so this list may be out of date.' : ''}`

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
      else if (key === 'cloud') { av = a.cloud || ''; bv = b.cloud || '' }
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
      <span className="text-note inline-flex items-center gap-1.5" style={{ color: COLORS[PROBLEM_SEV.zoneIssues] }}>
        <i aria-hidden="true" className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: COLORS[PROBLEM_SEV.zoneIssues] }} />
        {z.issues.map(issueWord).join(', ')}
      </span>
    ) : z.anomaly ? (
      <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }}>anomaly</span>
    ) : ttlChecked(z) ? '—' : (
      // Distinct from the clean '—': this zone published no TTL, so the checks
      // never ran on it. Silence here would read as "checked, nothing wrong".
      <span className="text-note italic text-dim" title="This zone publishes no cache time (TTL), so its cache times were not checked">not checked</span>
    )
    const ttl = ttlValue(z.ttl)
    return {
      id: z.id,
      fqdn: z.fqdn,
      view: z.view,
      records: (Number(z.records) || 0).toLocaleString(),
      cloud: z.cloud || '',
      cloud_detail: z.cloud_detail || '',
      // No TTL published => em-dash, never a number this zone does not have.
      // Seconds in words, "5 minutes", not a bare "300" (GUI audit R3-B4).
      ttl: cacheTime(ttl),
      issues: issuesCell,
      _hasIssues: issues,
    }
  }), [sorted, COLORS])

  // The Issues column stays whenever any zone has an issue or went unchecked.
  // Left to hideWhenConstant, a single zone with an issue made the column's
  // only non-empty cell "constant" and hid the one thing worth seeing.
  const anyFlag = zones.some((z) => hasIssues(z) || z.anomaly || !ttlChecked(z))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, keep: true, grow: true, sortable: true, render: itemCell('zone', (r) => ({ id: r.id, view: r.view }), { mono: true }) },
    { key: 'view', label: 'View', sortable: true },
    // Which public cloud the zone is synced from; the hover names the account
    // where Infoblox has one (go/internal/dashboard/cloud.go). Only when some
    // zone has one: a column with its own render is never auto-hidden.
    ...(rows.some((r) => r.cloud) ? [{ key: 'cloud', label: 'Cloud', sortable: true,
      render: (v, r) => (v ? <span title={r.cloud_detail || undefined}>{v}</span> : '') }] : []),
    { key: 'records', label: 'Records', align: 'right', mono: true, hideWhenConstant: true, sortable: true },
    // keep: DataTable auto-hides a column whose every cell is empty, and '—' is
    // an empty cell to it. A view where no zone publishes a TTL must still show
    // the TTL column full of dashes — silently dropping it reads as "TTL isn't
    // tracked" instead of "we don't know it".
    { key: 'ttl', label: 'Cache time', sortable: true, keep: true },
    // The cell is built above as markup, so it is passed through `render`:
    // DataTable lays render columns out to measure them, and without it the
    // column was sized short and cut "cache time too short" off (2026-11-25).
    // Only when anyFlag: a render column is never auto-hidden, and with no
    // flag the column must still hide as before.
    { key: 'issues', label: 'Issues', hideWhenConstant: true, keep: anyFlag, sortable: true, render: anyFlag ? (v) => v : undefined },
  ]

  return (
    <Card
      panelId={panelId}
      // A table sizes its own panel, so a declared span shows only while it
      // cannot, as when the read failed. Services 2, zones 4 and signing 2 are
      // the widths those panels take with data, so a failed read no longer
      // re-packs the page (GUI audit, Codex B). They were 3, 6 and 3.
      span={4}
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
              {notSigned ? 'not signed' : kind ? issueWord(kind) : 'issues only'} ✕
            </button>
          </span>
        ) : 'DNS Zones'
      }
      right={
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          {canCompare && (
            <button type="button" aria-expanded={comparing} onClick={() => setComparing((v) => !v)}
              title="The same zone name in two views: see which records differ"
              className="text-copy text-link underline whitespace-nowrap px-1 py-1.5">
              Compare views
            </button>
          )}
          {/* A list that failed or has not arrived has no count: a dash, not 0 (B2). */}
          <span className="text-note text-muted whitespace-nowrap">{countOf(listLoading || listFailed ? null : sorted.length, 'zone')}</span>
          <input {...MACHINE_TEXT}
            aria-label="Filter zones"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-full max-w-[170px]`}
          />
        </div>
      }
    >
      {comparing && canCompare && (
        <Suspense fallback={<Skeleton h={80} />}>
          <ZoneCompare zones={zones} onClose={() => setComparing(false)} />
        </Suspense>
      )}
      {issuesOnly && (
        <div role="status" data-landing-filter className="mt-2 flex flex-wrap items-center gap-x-3 text-copy">
          <span>{landingLine}</span>
          <button type="button" className="text-link underline whitespace-nowrap px-1 py-1.5" onClick={() => { location.hash = 'dns' }}>Show all</button>
        </div>
      )}
      {listLoading ? (
        // Same reason as ZoneKpis: an unfinished read is neither "no zones"
        // nor "the feed is dead".
        <Skeleton h={250} />
      ) : notSigned && signingFailed ? (
        <FeedUnavailable label="DNS Zones unavailable" reason={COULD_NOT_READ} />
      ) : issuesOnly && listFailed ? (
        <FeedUnavailable label="DNS Zones unavailable" reason={COULD_NOT_READ} />
      ) : !notSigned && zones.length === 0 ? (
        zonesStatus === 'error' ? <FeedUnavailable label="DNS Zones unavailable" reason={COULD_NOT_READ} /> : <Empty>No DNS zones found</Empty>
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
          rowStyle={(r) => (r._hasIssues ? { background: `color-mix(in srgb, ${COLORS[PROBLEM_SEV.zoneIssues]} 6%, transparent)` } : undefined)}
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
    id: r.id,
    fqdn: r.fqdn,
    view: r.view,
    dnssec_status: r.dnssec_status,
    dnssec_signing_policy: r.dnssec_signing_policy || '—',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true, render: itemCell('zone', (r) => ({ id: r.id }), { mono: true }) },
    { key: 'view', label: 'View', mono: true, maxCh: 22 }, // measured: opaque resource path overflows the card; cap it
    { key: 'dnssec_signing_policy', label: 'Signing rule' },
  ]

  return (
    <Card
      panelId={panelId}
      span={2}
      title="Zone signing"
      right={
        <span className="text-note text-muted">{dnssecPanelLabel(unsigned.length, DNSSEC_CAP)}</span>
      }
    >
      {dnssec.loading ? (
        <Skeleton h={280} />
      ) : failed ? (
        <FeedUnavailable label="Zone signing unavailable" reason={failReason(dnssec)} />
      ) : rows.length === 0 ? (
        <Empty>No zone signing information</Empty>
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

// Infoblox sends these in capitals ("HIGH", "NONE"). Shown as words, in
// sentence case; an override Infoblox names in DNS terms says what it does
// (GUI audit B10).
const sentence = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1).toLowerCase() : '—')
// Where a blocklist comes from, as Infoblox names it in `type`.
const RPZ_SOURCE = {
  local: 'Your own list',
  feed: 'Threat feed',
  fireeye: 'FireEye feed',
}

const RPZ_OVERRIDE = {
  NONE: 'As each entry says',
  NXDOMAIN: 'Answers "name not found"',
  NODATA: 'Answers "no records"',
  PASSTHRU: 'Lets it through',
  DROP: 'Drops the lookup',
  TCP_ONLY: 'Asks again over TCP',
}

function RpzPanel({ panelId, rpz }) {
  const rows = rpz.data?.rows ?? []
  const total = rpz.data?.count ?? rows.length
  // Same errRows() contract as DnssecHealth — status:"error" at HTTP 200.
  const status = rpz.data?.status

  const tableRows = rows.map((r, i) => ({
    fqdn: r.fqdn,
    severity: sentence(r.severity),
    policy_override: RPZ_OVERRIDE[String(r.policy_override ?? '').toUpperCase()] ?? sentence(r.policy_override),
    type: RPZ_SOURCE[String(r.type ?? '').toLowerCase()] ?? (r.type ? sentence(r.type) : '—'),
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.fqdn ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'fqdn', label: 'Zone', mono: true, grow: true },
    { key: 'severity', label: 'Severity' },
    // What the server does with a blocked name, and where the list comes
    // from, in words (GUI audit B10: "Override None", "Type local").
    { key: 'policy_override', label: 'Action' },
    { key: 'type', label: 'Source' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="Blocklist zones" right={<span className="text-note text-muted">{rows.length ? countOf(total, 'zone') : ''}</span>}>
      {rpz.loading ? (
        <Skeleton h={200} />
      ) : rpz.error || status === 'error' ? (
        <FeedUnavailable label="Blocklist zones unavailable" reason={failReason(rpz)} />
      ) : rows.length === 0 ? (
        <Empty>No blocklist zones</Empty>
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
    ttl: cacheTime(r.ttl),
    disabled: r.disabled ? 'Disabled' : 'Enabled',
    _k: `${r.name ?? ''}|${i}`,
  }))

  const columns = [
    { key: 'name', label: 'Name', mono: true, grow: true, render: itemCell('address', undefined, { mono: true }) },
    { key: 'dtc_policy', label: 'Policy' },
    // "Priority", not Infoblox's "Precedence" (GUI audit B10).
    { key: 'precedence', label: 'Priority', align: 'right', mono: true },
    { key: 'ttl', label: 'Cache time', mono: true, align: 'right' },
    { key: 'disabled', label: 'Status' },
  ]

  return (
    <Card panelId={panelId} span={3} title="Load-balanced names" right={<span className="text-note text-muted">{rows.length ? countOf(total, 'name') : ''}</span>}>
      {dtcLbdn.loading ? (
        <Skeleton h={200} />
      ) : dtcLbdn.error || status === 'error' ? (
        <FeedUnavailable label="Load-balanced names unavailable" reason={failReason(dtcLbdn)} />
      ) : rows.length === 0 ? (
        <Empty>No load-balanced names</Empty>
      ) : (
        <DataTable rows={tableRows} columns={columns} maxHeight={260} rowKey={(r) => r._k} />
      )}
    </Card>
  )
}
