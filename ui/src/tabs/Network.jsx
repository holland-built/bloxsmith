import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import ItemLink from '../components/ItemLink.jsx'
import { itemCell } from '../components/itemCell.jsx'
import { SLOW_COLD_TIMEOUT_MS, useApi } from '../lib/api.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, hiddenPanelGroup, Skeleton, useChartTheme, utilStatus, TabIntro } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { sortRows } from '../lib/sortCompare.js'
import { withSize } from '../lib/sizes.js'
import { SERVICE_GROUPS, useOwnedServices } from '../lib/services.js'
import { useHashParams, setHashParams } from '../lib/hash.js'
import { alarmTone, DASH, freeOf, num } from '../lib/measured.js'
import { UTIL_CRIT, UTIL_WARN, utilBand } from '../lib/utilBands.js'
import { PROBLEM_SEV } from '../lib/severity.js'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { jumpToPanel } from '../lib/jumpToPanel.js'
import { useSavedChartPanels } from '../components/useSavedChartPanels.jsx'
import Tip from '../components/Tip.jsx'
import { DHCP_REQUEST_ROWS, DHCP_REQUEST_WINDOWS, dhcpTotal, HA_NOTE } from '../lib/dhcpRequests.js'
// The look the owner picked for dashboards (Overview's tokens and tiles), plus
// this page's own few rules.
import './Overview.css'
import './Network.css'
import { formatWhen } from '../lib/dates.js'
import { HeadlineStrip, PageTitle } from '../components/kit.jsx'
import UpdatedPill from './UpdatedPill.jsx'

// A single frozen empty array, shared by every `?? NO_ROWS` fallback below.
// `?? []` builds a NEW array on every render, so any useMemo depending on that
// value recomputed every render and memoized nothing — oxlint reports it as
// "depends on `rows`, which changes every render". One stable reference makes
// the dependency honest instead of suppressing the warning. When data IS
// present the reference is the fetch hook's own array, which is already stable
// between renders, so the memo now works in both states.
const NO_ROWS = Object.freeze([])


// IP address octet-order comparator (ascending); DataTable applies direction.
function ipCompare(a, b) {
  const av = (a.address || '').split('.').map(Number)
  const bv = (b.address || '').split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) - (bv[i] || 0)
  }
  return 0
}

// "Show unused networks" pages through every unused network in the tenant,
// UNUSED_PAGE at a time, from GET /api/ipam/subnets/unused (server order:
// address). The server cannot search inside an address or name (CSP answers
// 500 to address~"..."), so the search box, site list and column sorting,
// which only work on loaded rows, are switched off and the note says so.
const UNUSED_PAGE = 50

// The line under the table heading while "Show unused networks" is on.
function unusedNote(page, total) {
  const all = total == null ? '' : ` ${total.toLocaleString()} unused across all networks.`
  return `Only the first and last address in use. Page ${page + 1}, ${UNUSED_PAGE} a page, in address order.${all} Search, site and column sorting are off while this is on. /31, /32 and IPv6 networks were not checked.`
}

// A Cloud cell: AWS, Azure or GCP, with the account as its hover. Blank for
// networks that did not come from a cloud.
function cloudCell(v, r) {
  return v ? <span title={r.cloud_detail || undefined}>{v}</span> : ''
}

// ---------- main ----------

// Only the utilisation panel needs recharts, so only it waits for it.
const CategoryBars = lazy(() => import('../charts/CategoryBars.jsx'))

export default function Network() {
  // Charts added from Build a chart; they join the grid as ordinary panels.
  const savedCharts = useSavedChartPanels('network')
  const data = useApi('/api/data', { poll: 30000 })
  const ipam = useApi('/api/csp/ipam-util', { poll: 30000 })
  const dhcp = useApi('/api/csp/dhcp-leases', { poll: 30000 })
  // Totals over a day and a month, so once a minute is plenty.
  const dhcpRequests = useApi('/api/csp/dhcp-requests', { poll: 60000 })
  // Read once per page load, no poll: it reads every address block and every
  // top-level subnet (about 7 s on an 11,000-subnet tenant), hence the slow budget.
  const overlaps = useApi('/api/ipam/overlaps', { coldMs: SLOW_COLD_TIMEOUT_MS })
  const hp = useHashParams()
  // One shared read of /api/service-inventory per page load — see Security.jsx.
  const owned = useOwnedServices()

  const subnets = data.data?.subnets ?? []
  const totals = data.data?._totals
  const meta = data.data?._meta ?? {}

  // The whole /api/data request failed — a 500, or the cold-request abort
  // (measured 17-26s cold against a 12s warm budget). There is then no payload
  // at all: no `_meta`, so every per-slice status is undefined, and every
  // slice reads as [] — which the panels below would render as "you have
  // none" over a dead backend. This is the same rule lib/data.js gives the
  // useData() tabs (see its header: "Requested but missing => 'error'"); this
  // tab reads /api/data raw and so has to apply it itself. The status
  // vocabulary stays exactly ok / empty / error.
  //
  // Not while loading: a request still in flight is a Skeleton, not a failure.
  const feedDown = !data.loading && (!!data.error || data.data == null)
  const subnetsStatus = feedDown ? 'error' : meta.subnets

  const leasesRef = useRef(null)
  // Needs a look's "See full subnets" lands on the table, not two charts above it.
  const subnetsRef = useRef(null)
  useEffect(() => {
    const el = hp.focus === 'leases' ? leasesRef.current : hp.focus === 'subnets' ? subnetsRef.current
      : hp.focus === 'overlaps' ? document.querySelector('[data-panel-id="network-overlaps"]') : null
    el?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [hp.focus])

  return (
    <div className="w-full px-6 py-5">
      <div className="ov-look">
        <div className="ov-head net-h1">
          <PageTitle>Network</PageTitle>
          <UpdatedPill api={data} tip="When the subnet inventory last arrived. It refreshes every 30 seconds." />
        </div>
      </div>
      <TabIntro>How full your subnets and IP spaces are, and every DHCP lease.</TabIntro>
      {/* The shared strip, as on Infra and Assets (GUI audit B9). */}
      <HeadlineStrip label="Headline numbers" items={headlines(subnets, totals, subnetsStatus, dhcp)} />
      {/* Every direct child of a grid with a layoutKey carries its own panelId,
          because CardGrid reads the saved order off `props.panelId` of its own
          children while it reads the live order off the DOM. A wrapper whose id
          only exists on the <Card> inside it is invisible to the first and
          visible to the second, which is exactly the mismatch the guard in
          components/ui.jsx logs. Each wrapper below forwards the id to its
          Card, which is what registers the saved span. */}
      <CardGrid layoutKey="network">
        <UtilBands panelId="network-utilization-distribution" subnets={subnets} totals={totals} subnetsStatus={subnetsStatus} loading={data.loading} />
        <IpamSpaces panelId="network-ipam-spaces" ipam={ipam} />
        <Overlaps panelId="network-overlaps" overlaps={overlaps} only={hp.overlaps} hp={hp} />
        {/* Leases are issued by a deployed DHCP service. The IPAM panels above
            and the subnet table below read address-space config, which exists
            with no DHCP service at all — so neither is mapped.

            hiddenPanelGroup is a function, not a component, so each panel in
            the run stays a direct child of the grid and keeps its own panelId —
            see its comment in components/ui.jsx for why that matters to a saved
            layout. The id lives here rather than on the <Card> inside
            DhcpLeases for the same reason it does on Overview: the grid reads
            it off this element. */}
        <ExhaustionTable panelId="network-exhaustion" subnets={subnets} totals={totals} hp={hp} subnetsStatus={subnetsStatus} loading={data.loading} readFailed={!!data.error} innerRef={subnetsRef} />
        {hiddenPanelGroup({
          ...SERVICE_GROUPS.dhcp,
          state: owned,
          children: [
            <DhcpLeases key="network-dhcp-leases" panelId="network-dhcp-leases" dhcp={dhcp} innerRef={leasesRef} />,
            <DhcpRequests key="network-dhcp-requests" panelId="network-dhcp-requests" requests={dhcpRequests} />,
          ],
        })}
        {savedCharts}
      </CardGrid>
    </div>
  )
}

// ---------- headline numbers ----------

// The counts across the top, each a jump to its panel. The two band counts are
// Utilization Distribution's own bars (the amber and the red band of
// lib/utilBands.js), counted from the same rows, so the number and the bar it
// jumps to always agree.
//
// Those rows are meant to hold every subnet at 70% or more, but the server's
// at-risk pager is capped (dashboard.go atRiskPageCap/RowCap/TimeCap) and sets
// _totals.degraded when a cap trips. The bands are only called estate-wide
// when the loaded >= 70 rows reach _totals.subnetsWarn and nothing was capped;
// otherwise the labels say they count the loaded rows. A feed that is down or
// loading is a dash, never zero.
function headlines(subnets, totals, subnetsStatus, dhcp) {
  const t = totals ?? {}
  const subOk = subnetsStatus === 'ok' || subnetsStatus === 'empty'
  const util = subOk ? subnets.map((s) => num(s.util)).filter((u) => u !== null) : []
  const band = (test) => (subOk ? util.filter(test).length : null)
  const complete = subOk && t.degraded !== true && Number.isFinite(t.subnetsWarn) &&
    util.filter((u) => utilBand(u) !== 'ok').length >= t.subnetsWarn
  const scope = subOk && !complete ? ' (of loaded)' : ''
  const leases = dhcp.data?.count
  const leasesOk = !dhcp.loading && !dhcp.error && dhcp.data?.status !== 'error' && Number.isFinite(leases)
  const fmt = (v) => (v == null ? null : v.toLocaleString())
  const over = band((u) => utilBand(u) === 'crit')
  const mid = band((u) => utilBand(u) === 'warn')
  const loadedWord = scope ? ' Counted over the subnets loaded, not all of them.' : ''
  return [
    { panelId: 'network-utilization-distribution', label: 'Subnets', value: fmt(subOk && Number.isFinite(t.subnets) ? t.subnets : null),
      tip: 'Every subnet, all sizes.' },
    { panelId: 'network-utilization-distribution', label: `≥${UTIL_CRIT}%${scope}`, value: fmt(over), tone: alarmTone(over, PROBLEM_SEV.subnetsFull),
      tip: `Subnets ${UTIL_CRIT}% full or more, tiny networks of 8 addresses or fewer included.${loadedWord}` },
    { panelId: 'network-utilization-distribution', label: `${UTIL_WARN}–${UTIL_CRIT - 1}%${scope}`, value: fmt(mid), tone: alarmTone(mid, 'warn'),
      tip: `Subnets ${UTIL_WARN}% to ${UTIL_CRIT - 1}% full, tiny networks of 8 addresses or fewer included.${loadedWord}` },
    { panelId: 'network-dhcp-leases', label: 'Leases', value: fmt(leasesOk ? leases : null), tip: 'Leases on record from DHCP, in every state.' },
  ]
}

// A subnet's size as the count Infoblox reports, which is what Used plus Free
// add up to. It used to be worked out from the prefix ("(256 addresses)"),
// which disagreed with Used and Free when Infoblox counted 254 (2026-11-24).
// A live tenant reports 256 for a /24, so the prefix cannot be trusted either
// way. With no count from the server, withSize's words stay.
function subnetSize(network, total) {
  const t = num(total)
  return Number.isFinite(t) && t > 0 ? `${network} (${t.toLocaleString('en-US')} addresses)` : withSize(network)
}

// ---------- utilization distribution ----------

// Healthy in the same pale green everywhere on this page: chart, bars, table.
// 70%, not 35%: at 35% the bar measured 2.1:1 on a dark panel and 1.8:1 on a
// light one, under the 3:1 a chart mark needs (GUI audit B13). 70% is 4.6:1
// and 3.6:1, still quieter than the amber and red bands beside it.
const paleOk = (ok = 'var(--color-ok)') => `color-mix(in srgb, ${ok} 70%, transparent)`
const barColor = (status) => (status.label === 'Healthy' ? paleOk() : status.color)

function UtilBands({ panelId, subnets, totals, subnetsStatus, loading }) {
  const { COLORS } = useChartTheme()
  const BANDS = [
    // Healthy is pale, as on Infra's host donut, so the full bands are what
    // the eye lands on even when nearly every subnet is fine.
    { key: 'ok', label: `<${UTIL_WARN}%`, test: (u) => utilBand(u) === 'ok', color: paleOk(COLORS.ok) },
    { key: 'warn', label: `${UTIL_WARN}–${UTIL_CRIT - 1}%`, test: (u) => utilBand(u) === 'warn', color: COLORS.warn },
    { key: 'crit', label: `≥${UTIL_CRIT}%`, test: (u) => utilBand(u) === 'crit', color: COLORS.crit },
  ]
  // A subnet with no reported utilisation belongs in no band — counted as 0 it
  // lands in "<70%" and inflates the healthy bar with subnets nobody measured.
  // It is excluded from the bands and declared in the scope label.
  const measured = subnets.filter((s) => num(s.util) !== null)
  const unmeasured = subnets.length - measured.length
  const counts = BANDS.map((b) => ({
    label: b.label,
    value: measured.filter((s) => b.test(num(s.util))).length,
    color: b.color,
  }))
  const hasData = measured.length > 0
  const estateTotal = Number.isFinite(totals?.subnets) ? totals.subnets : null
  const unmeasuredLabel = unmeasured > 0 ? ` · ${unmeasured.toLocaleString()} util unknown` : ''
  // "0 loaded" over a dead feed reads as an empty estate; the count is
  // unknown, so it prints as an em-dash.
  const scopeLabel = subnetsStatus === 'error'
    ? ''
    : estateTotal !== null
      ? `${subnets.length.toLocaleString()} loaded of ${estateTotal.toLocaleString()} total${unmeasuredLabel}`
      : `${subnets.length.toLocaleString()} loaded (total unavailable)${unmeasuredLabel}`

  return (
    <Card panelId={panelId} span={4} title="Utilization Distribution" right={<span className="text-note text-muted">{scopeLabel}</span>}>
      {!hasData ? (
        loading && subnets.length === 0 ? (
          <Skeleton h={220} />
        ) : subnetsStatus === 'error' ? (
          <FeedUnavailable label="Subnet information is unavailable" />
        ) : subnets.length > 0 ? (
          <Empty>no loaded subnet reports utilisation</Empty>
        ) : (
          <Empty>No subnets found</Empty>
        )
      ) : (
        /* Already said "<70% · 486 subnets" before ChartTip existed; that
           tooltip now lives in charts/CategoryBars.jsx along with the bars. */
        <Suspense fallback={<Skeleton h={220} />}>
          <CategoryBars label="Utilization Distribution" data={counts} unit="subnets" height={220} xKey="label" showY />
        </Suspense>
      )}
    </Card>
  )
}

// ---------- IPAM spaces ----------

const IPAM_SPACES_CAP = 12

function IpamSpaces({ panelId, ipam }) {
  // A space whose feed reports no total has no capacity to be "top used" against,
  // so it is not ranked. Those are dropped by the filter; everything that
  // survives it is what the cap below is measured against, so the label states a
  // denominator that was actually counted rather than the raw feed length.
  const eligible = (ipam.data?.rows ?? NO_ROWS)
    .filter((r) => (Number(r.total) || 0) > 0)
    .map((r) => ({ ...r, used: Number(r.used) || 0, total: Number(r.total) || 0, pct: ((Number(r.used) || 0) / (Number(r.total) || 1)) * 100 }))
    .sort((a, b) => b.used - a.used)
  const rows = eligible.slice(0, IPAM_SPACES_CAP)
  // Bars measure addresses used against the busiest row, the same figure the
  // number beside each bar and the sort use. They used to show % full, so the
  // busiest spaces in large pools drew almost no bar.
  const maxUsed = Math.max(1, ...rows.map((r) => r.used))
  // The cap was silent until 2026-08-19: against the live tenant this ranked 31
  // spaces and drew 12, and the panel said only "addresses used" — so 19 spaces
  // were missing with nothing on screen admitting it. Same wording as Overview's
  // "top 12 of N subnets", which is this repo's standard for a capped ranking.
  //
  // AND THE LIST ITSELF CAN BE A SLICE. The server makes one read of at most
  // 500 spaces (go/internal/dashboard/csp.go, CSPIpamUtil) and says `atLimit`
  // when that read came back full. On a tenant with more spaces than that, the
  // busiest ones may not be among them: seen live on 2026-10-04, this panel's
  // "top" space showed 24 addresses while single subnets below it used 512.
  // "top 12 of 496" would then claim a ranking over everything, so the label
  // names what was actually read and a line under the bars says why.
  const atLimit = ipam.data?.atLimit === true && Number.isFinite(ipam.data?.limit)
  const capLabel = atLimit
    ? `top ${rows.length} of the first ${ipam.data.limit.toLocaleString()} read`
    : eligible.length > rows.length ? `top ${rows.length} of ${eligible.length.toLocaleString()}` : null
  // CSPIpamUtil returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `ipam.error` alone never catches this.
  const status = ipam.data?.status

  return (
    <Card panelId={panelId} span={2} title="IP spaces — most used" right={<span className="text-note text-muted">addresses used{capLabel ? ` · ${capLabel}` : ''}</span>}>
      {ipam.loading ? (
        <Skeleton h={220} />
      ) : ipam.error || status === 'error' ? (
        <FeedUnavailable label="IP space information is unavailable" />
      ) : rows.length === 0 ? (
        <Empty>{ipam.data?.rows?.length > 0 ? 'No IP spaces report how full they are' : 'No IP spaces found'}</Empty>
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          {rows.map((r, i) => {
            const status = utilStatus(r.pct)
            return (
              <div key={`${r.id ?? r.label ?? ''}|${i}`} className="flex items-center gap-2 text-note">
                <span className="w-[110px] truncate text-muted" title={r.label}>{r.label ? (
                  // inline-flex so a touch screen's 44px link height (index.css,
                  // pointer: coarse) applies; an inline link ignores min-height.
                  <ItemLink kind="space" value={r.label} id={String(r.id || '').startsWith('ipam/ip_space/') ? r.id : undefined} className="inline-flex items-center max-w-full">
                    <span className="truncate">{r.label}</span>
                  </ItemLink>
                ) : r.id || '—'}</span>
                <div className="h-[6px] rounded-full bg-line overflow-hidden flex-1">
                  <div className="h-full" style={{ width: `${(r.used / maxUsed) * 100}%`, background: barColor(status) }} />
                </div>
                <span className="w-12 text-right text-muted">{r.used.toLocaleString()}</span>
                {/* The bar's colour is how full the space is; its length is
                    addresses used. Saying the percent in words means a short
                    red bar on a small, nearly full space explains itself. */}
                <span className="w-[64px] text-right text-muted whitespace-nowrap">{`${Math.round(r.pct)}% full`}</span>
              </div>
            )
          })}
          {atLimit && (
            <p data-ipam-partial="" className="mt-1 text-note text-dim">
              Only the first {ipam.data.limit.toLocaleString()} spaces were read, which is the most the server reads at
              once. A busier space may be missing from this list.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// ---------- overlapping ranges ----------

// One row per address range used by 2 or more IP spaces, the most spaces
// first. A row is ranges that TOUCH, not one range shared everywhere, so an
// opened row lists every space with its own ranges in it. The server
// (go/internal/dashboard/overlaps.go) answers status:"error" with a plain
// sentence when it could not read every block and subnet, and then sends no
// rows at all: a partial list could hide an overlap.
// An IP space in the Infoblox Portal's IPAM page. Shape checked in a
// signed-in browser on 2026-11-16: the space's uuid, the part of its id after
// "ipam/ip_space/". base is the server's own Infoblox address (it sends
// `portal`), so another region opens its own Portal.
function spacePortalUrl(base, id) {
  const host = typeof base === 'string' && /^https:\/\/[^/?#]+$/.test(base) ? base : 'https://csp.infoblox.com'
  const uuid = String(id).split('/').pop()
  return `${host}/#/perspective/ipam/address_space/ipam/ip_space/${encodeURIComponent(uuid)}`
}

// A range in Bloxsmith's Editor, with its block or subnet picked.
const editorUrl = (r) =>
  `#editor?type=${r.kind}&id=${encodeURIComponent(r.id)}&q=${encodeURIComponent(r.prefix.split('/')[0])}`
const KIND_WORD = { address_block: 'address block', subnet: 'subnet' }

// Does this space (by id or name) use a range in the group?
const usesSpace = (g, want) => {
  const w = String(want).toLowerCase()
  return g.members.some((m) => m.id === want || String(m.name || '').toLowerCase() === w)
}

function Overlaps({ panelId, overlaps, only, hp }) {
  const [open, setOpen] = useState(null)
  const listId = useId()
  // The server already sends the most spaces first; sorted here too so the
  // order on screen never depends on that.
  const all = useMemo(() => [...(overlaps.data?.groups ?? NO_ROWS)].sort((a, b) => b.spaces - a.spaces), [overlaps.data])
  // #network?overlaps=<space>, from an IP space's Show overlaps: only the
  // ranges that space shares with another.
  const groups = useMemo(() => (only ? all.filter((g) => usesSpace(g, only)) : all), [all, only])
  const onlyName = only ? (all.flatMap((g) => g.members).find((m) => m.id === only)?.name || only) : ''
  const failed = !!overlaps.error || (!overlaps.loading && overlaps.data?.status !== 'ok')
  const maxSpaces = Math.max(1, ...groups.map((g) => g.spaces))

  return (
    <Card panelId={panelId} span={2} title="Overlapping ranges" right={<span className="text-note text-muted">IP spaces using each range</span>}>
      {overlaps.loading ? (
        <Skeleton h={220} />
      ) : failed ? (
        // A request that failed outright has no list at all, so it gives the
        // request's own error; the "could be wrong" line is for a partial read (B6).
        <FeedUnavailable label="Overlapping ranges unavailable" reason={overlaps.error ? overlaps.error.message : overlaps.data?.error || "Couldn't read every subnet, so the list could be wrong."} />
      ) : (
        <>
        {only && (
          <p data-overlaps-only="" className="flex flex-wrap items-center gap-x-3 text-note text-muted mb-1">
            <span>Only ranges {onlyName} shares with another IP space.</span>
            <button type="button" className="text-link underline" onClick={() => setHashParams('network', { ...hp, overlaps: undefined, focus: undefined })}>
              Show all
            </button>
          </p>
        )}
        {groups.length === 0 ? (
        <Empty>{only ? `${onlyName} shares no address range with another IP space.` : 'No address range is used in more than one IP space.'}</Empty>
      ) : (
        <ul className="flex flex-col gap-1 mt-1 max-h-[420px] overflow-auto">
          {groups.map((g, i) => {
            const isOpen = open === g.range
            return (
              <li key={g.range}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `${listId}-${i}` : undefined}
                  onClick={() => setOpen(isOpen ? null : g.range)}
                  className="w-full flex items-center gap-2 text-note text-left py-0.5 px-1 rounded-control cursor-pointer hover:bg-line"
                >
                  <span aria-hidden="true" className="w-3 text-muted">{isOpen ? '−' : '+'}</span>
                  <span className="w-[120px] truncate text-muted font-mono" title={g.range}>{g.range}</span>
                  <span className="h-[6px] rounded-full bg-line overflow-hidden flex-1">
                    <span className="block h-full" style={{ width: `${(g.spaces / maxSpaces) * 100}%`, background: 'var(--color-series)' }} />
                  </span>
                  <span className="w-[72px] text-right text-muted tabular-nums">{g.spaces.toLocaleString()} spaces</span>
                </button>
                {isOpen && (
                  <ul id={`${listId}-${i}`} data-overlap-spaces="" className="ml-2 mt-1 mb-2 pl-2 border-l border-line flex flex-col gap-0.5 text-note">
                    {g.members.map((m) => (
                      <li key={m.id} className="flex flex-wrap gap-x-2">
                        <a
                          href={spacePortalUrl(overlaps.data?.portal, m.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${m.name} in Infoblox (opens in a new tab)`}
                          className="text-link underline"
                        >
                          {m.name}<span className="text-muted"> in Infoblox</span>
                        </a>
                        <span className="font-mono">
                          {m.ranges.map((r, j) => (
                            <span key={r.id || r.prefix}>
                              {j > 0 && <span className="text-muted">, </span>}
                              {r.kind === 'address_block' ? (
                                // An address block has its own menu (right-click or Shift+F10).
                                <ItemLink kind="block" value={r.prefix} id={r.id} space={m.id} label={`${withSize(r.prefix)}, open this address block in the Editor`} className="underline">{withSize(r.prefix)}</ItemLink>
                              ) : (
                                <a href={editorUrl(r)} aria-label={`${withSize(r.prefix)}, open this ${KIND_WORD[r.kind] || 'range'} in the Editor`} className="text-link underline">{withSize(r.prefix)}</a>
                              )}
                            </span>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
        )}
        </>
      )}
    </Card>
  )
}

// ---------- DHCP leases ----------

// A lease set never to end comes back ending in the year 9999; that is a
// date nobody reads as "never", so it says so.
function endsWord(ms, raw) {
  if (isNaN(ms)) return raw || '—'
  return new Date(ms).getUTCFullYear() >= 9999 ? 'never' : formatWhen(ms)
}

// Some DHCP clients send their name wrapped in quote marks ("Mac"); the marks
// are not part of the name.
const unquote = (v) => (typeof v === 'string' ? v.replace(/^"(.*)"$/, '$1') : v)

function DhcpLeases({ panelId, dhcp, innerRef }) {
  const hp = useHashParams()
  const rows = dhcp.data?.rows ?? NO_ROWS
  // CSPDHCPLeases returns status:"error" at HTTP 200 on an upstream failure —
  // the fetch itself never errors, so `dhcp.error` alone never catches this.
  const status = dhcp.data?.status
  const [q, setQ] = useState(hp.lease || '')
  const [state, setState] = useState('')

  useEffect(() => {
    if (hp.lease) setQ(hp.lease)
  }, [hp.lease])

  const states = useMemo(() => [...new Set(rows.map((r) => r.state).filter(Boolean))].sort(), [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (state && r.state !== state) return false
      if (!needle) return true
      return [r.address, r.hostname, r.hardware].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [rows, q, state])

  // Precompute ends timestamp + display label; default order is ends-desc.
  const tableRows = useMemo(() => {
    return filtered
      .map((r) => {
        const ms = r.ends ? new Date(r.ends).getTime() : NaN
        return {
          ...r,
          hostname: unquote(r.hostname),
          _endsMs: isNaN(ms) ? 0 : ms,
          endsLabel: endsWord(ms, r.ends),
        }
      })
      .sort((a, b) => b._endsMs - a._endsMs)
  }, [filtered])

  const columns = [
    { key: 'address', label: 'Address', mono: true, sortable: true, comparator: ipCompare, render: itemCell('address', undefined, { mono: true }) },
    { key: 'hostname', label: 'Hostname', grow: true, sortable: true, render: itemCell('address') },
    { key: 'endsLabel', label: 'Ends', mono: true, sortable: true, comparator: (a, b) => (a._endsMs || 0) - (b._endsMs || 0) },
    { key: 'hardware', label: 'Hardware', mono: true, priority: 'low', sortable: true },
    { key: 'state', label: 'State', sortable: true },
  ]

  return (
    // No wrapper div. The span must live on the GRID ITEM, and with the wrapper
    // gone the Card is that item, so the span class sits on the Card's own
    // element.
    // The wrapper had to go for two reasons: a plain div carrying the span class
    // is one of the two shapes CardGrid's layoutKey guard rejects, because the
    // panelId it can see on the DOM is not on the child it sorts; and once this
    // tile is hidden the Card renders null while the div stayed a grid item,
    // holding a blank gap open where the panel used to be. `innerRef` is Card's
    // own ref-forwarding prop, so #network?focus=leases still scrolls here.
    <Card
      innerRef={innerRef}
      panelId={panelId}
      // 4, not 6 (GUI audit, Codex B): a table sizes its own panel, so the
      // declared span shows only while it cannot, as when the read failed.
      // At 6 a failed read moved this panel onto a row of its own.
      span={4}
      title="DHCP Leases"
      right={
        <div className="flex flex-wrap items-center justify-end gap-2 max-w-full">
          {/* Last on a phone, beside the state picker, not alone left of the
              search box (B15). A failed or unfinished read has no count (B2). */}
          <span className="text-note text-muted max-md:order-last">{dhcp.loading || dhcp.error || status === 'error' ? '—' : `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()}`}</span>
          <input {...MACHINE_TEXT}
            aria-label="Search address, hostname, MAC"
            placeholder="Address, name or hardware"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={`${FIELD_CLS} w-[220px] max-w-full`}
          />
          <select
            aria-label="Filter by state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            className={FIELD_CLS}
          >
            <option value="">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      }
    >
      {dhcp.loading ? (
        <Skeleton h={200} />
      ) : dhcp.error || status === 'error' ? (
        <FeedUnavailable label="DHCP lease information is unavailable" />
      ) : rows.length === 0 ? (
        <Empty>No DHCP leases found</Empty>
      ) : tableRows.length === 0 ? (
        <Empty>no leases match</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable rows={tableRows} columns={columns} maxHeight={420} rowCap={150} stickyHeader emptyText="no leases match" />
        </div>
      )}
    </Card>
  )
}

// ---------- dhcp requests ----------

// How many devices asked DHCP for an address, and how many requests got none,
// as totals for today and the last 30 days (lib/dhcpRequests.js). Each number
// stands alone: one that could not be read says "not checked".
function DhcpRequests({ panelId, requests }) {
  // Any number that failed is said once, with a way to ask again. When only
  // some failed each of those says "not checked"; when all did, no numbers
  // are shown under the error (GUI audit B2).
  const states = DHCP_REQUEST_WINDOWS.flatMap((w) => DHCP_REQUEST_ROWS.map((r) => dhcpTotal(requests, r.key, w.key).state))
  const allFailed = states.every((st) => st === 'error')
  const someFailed = states.some((st) => st === 'error')
  return (
    <Card panelId={panelId} span={2} title="DHCP Requests">
      {requests.loading && !requests.data ? (
        <Skeleton h={140} />
      ) : (
        <>
          {someFailed && (
            <p role="status" data-panel-failed="" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-note text-crit pt-1">
              {allFailed ? "Couldn't read these numbers from Infoblox." : "Couldn't read some of these numbers from Infoblox."}
              <button type="button" onClick={requests.refetch} className="px-2.5 py-1 rounded-control border border-border bg-field text-field-txt text-note">
                Try again
              </button>
            </p>
          )}
          {!allFailed && DHCP_REQUEST_WINDOWS.map((w) => (
            <div key={w.key} data-dhcp-window={w.key}>
              <div className="text-note text-muted pt-1">{w.label}</div>
              <dl className="flex flex-wrap gap-x-6 gap-y-2 mt-1 mb-3 tabular-nums">
                {DHCP_REQUEST_ROWS.map((r) => {
                  const t = dhcpTotal(requests, r.key, w.key)
                  return (
                    <div key={r.key} data-dhcp-request={r.key} data-state={t.state}>
                      <dt className="text-note text-muted"><Tip tip={r.tip}>{r.label}</Tip></dt>
                      <dd className={t.state === 'ok' ? 'text-figure font-medium' : 'text-copy text-muted'}>{t.text}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          ))}
          <p className="text-note text-muted mt-2">{HA_NOTE}</p>
        </>
      )}
    </Card>
  )
}

// ---------- exhaustion table ----------

// Where an unknown (null) number sorts: always the BOTTOM of whichever
// direction is on screen. Ordering it as 0 would present an unmeasured subnet
// as the emptiest one; putting it at the top of the default worst-first sort
// would present it as the most exhausted. Neither is known.
//
// MAX_SAFE_INTEGER rather than Infinity because sortRows subtracts the two
// accessor values, and Infinity - Infinity is NaN — a NaN comparator makes
// Array#sort's result implementation-defined.
const UNKNOWN_RANK = Number.MAX_SAFE_INTEGER

// Per-key accessors for the controlled sort; sortRows does the string/number
// branch. Direction-dependent, so it is built per sort rather than frozen.
function exhaustionSort(dir) {
  const unknown = dir === 'asc' ? UNKNOWN_RANK : -UNKNOWN_RANK
  return {
    network: (r) => r.addr || r.cidr || '',
    site: (r) => r.site || '',
    cloud: (r) => r.cloud || '',
    used: (r) => num(r.used) ?? unknown,
    free: (r) => freeOf(r) ?? unknown,
    util: (r) => num(r.util) ?? unknown,
  }
}

// The cap this table is actually drawn at, named so panelHelpValues.test.js can
// bind the help sentence to it — the same arrangement as DNSSEC_CAP in Dns.jsx.
// It is handed to DataTable rather than applied here on purpose: DataTable can
// only print "showing N of M" over the rows it is given, so a slice upstream of
// it is a cap nothing can label.
const EXHAUSTION_CAP = 150

const isPercent = (n) => Number.isFinite(n) && n >= 0 && n <= 100

function ExhaustionTable({ panelId, subnets, totals, hp, subnetsStatus, loading, readFailed, innerRef }) {
  const [filter, setFilter] = useState(hp.subnet || '')
  const [site, setSite] = useState('')
  const [sort, setSort] = useState({ key: 'util', dir: 'desc' })
  // Only a real percentage is a filter. Anything else in the address is ignored.
  const askedUtil = hp.minUtil?.trim() ? Number(hp.minUtil) : NaN
  const minUtil = isPercent(askedUtil) ? askedUtil : null

  useEffect(() => {
    if (hp.subnet) setFilter(hp.subnet)
  }, [hp.subnet])

  // /29-/32 are infra links (point-to-point/loopback), always ~100%, so they
  // are left out by default or they'd bury real exhaustion (old app: 67db14e).
  // links=1 puts them back, so a "subnets ≥90%" count that includes them
  // (Overview, Daily, the tile above) opens a list of the same length.
  const links = hp.links === '1'
  // "Show unused networks" (unused=1) pages through every network in the
  // tenant with nothing in use but its network and broadcast address (see
  // UNUSED_PAGE). It covers every size the rule can judge (/30 and up), so the
  // tiny-networks switch and the util filter do not apply to it. The count in
  // its label is the tenant-wide one (_totals.subnetsUnused).
  const unused = hp.unused === '1'
  const [unusedPage, setUnusedPage] = useState(0)
  useEffect(() => { if (!unused) setUnusedPage(0) }, [unused])
  const unusedApi = useApi(unused ? `/api/ipam/subnets/unused?offset=${unusedPage * UNUSED_PAGE}&limit=${UNUSED_PAGE}` : null)
  const unusedTotal = Number.isFinite(totals?.subnetsUnused) ? totals.subnetsUnused : null
  const base = useMemo(() => (unused ? unusedApi.data?.subnets ?? NO_ROWS : links ? subnets : subnets.filter((s) => (Number(s.cidr) || 0) <= 28)),
    [subnets, links, unused, unusedApi.data])
  const sites = useMemo(() => [...new Set(base.map((s) => s.site).filter(Boolean))].sort(), [base])

  const filtered = useMemo(() => {
    if (unused) return base
    const q = filter.trim().toLowerCase()
    return base.filter((s) => {
      if (site && s.site !== site) return false
      // An unknown utilisation cannot satisfy "util >= N", so it is excluded
      // explicitly. Counted as 0 it would pass a minUtil of 0 as if measured
      // at zero, and fail every other threshold for the wrong reason.
      if (minUtil !== null) {
        const u = num(s.util)
        if (u === null || u < minUtil) return false
      }
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [base, filter, site, minUtil, unused])

  const sorted = useMemo(() => (unused ? filtered : sortRows(filtered, sort, exhaustionSort(sort.dir))), [filtered, sort, unused])

  // Arriving on a "N% full or more" address: fullest first, and the list in
  // view once it has loaded. Once per address, so a 30s poll never moves the page.
  const landing = minUtil !== null && !unused ? `${minUtil}|${links}` : null
  const jumpedFor = useRef(null)
  useEffect(() => { if (landing) setSort({ key: 'util', dir: 'desc' }) }, [landing])
  useEffect(() => {
    if (!landing) { jumpedFor.current = null; return }
    if (loading || jumpedFor.current === landing) return
    jumpedFor.current = landing
    jumpToPanel(panelId)
  }, [landing, loading, panelId])
  const landingWhat = `subnets ${minUtil}% full or more${links ? '' : ', not counting tiny networks'}`
  const listFailed = !!readFailed || subnetsStatus === 'error'
  // The rows hold every subnet at 70% or more only when the server's capped
  // pager finished and they reach its count (the same test as the headlines).
  const atRisk = subnets.filter((s) => { const u = num(s.util); return u !== null && u >= UTIL_WARN }).length
  const listComplete = totals?.degraded !== true && (minUtil !== null && minUtil >= UTIL_WARN
    ? Number.isFinite(totals?.subnetsWarn) && atRisk >= totals.subnetsWarn
    : Number.isFinite(totals?.subnets) && subnets.length >= totals.subnets)
  const landingLine = loading && !subnets.length ? `Checking ${landingWhat}…`
    : sorted.length === 0 && listFailed ? `Could not load subnets, so the ${landingWhat} are not known.`
    : sorted.length === 0 ? (filter.trim() || site ? `None of the ${landingWhat} match your search.`
      : listComplete ? `No ${landingWhat}.`
      : `None found in the subnets loaded. Not every subnet could be read, so some may be ${minUtil}% full or more.`)
    : `Showing ${sorted.length > EXHAUSTION_CAP ? `the fullest ${EXHAUSTION_CAP} of ${sorted.length.toLocaleString()}` : sorted.length.toLocaleString()} ${sorted.length === 1 ? landingWhat.replace('subnets', 'subnet') : landingWhat}, fullest first.${listFailed ? ' The latest read failed, so this list may be out of date.' : ''}${listComplete ? '' : ' Not every subnet could be read, so there may be more.'}`

  // NO cap is applied here, deliberately. This used to be `sorted.slice(0, 20)`,
  // and the 20 was invisible: DataTable only prints its "showing N of M" footer
  // over the rows it is HANDED, so slicing upstream meant it was handed 20,
  // 20 < its rowCap of 150, and it correctly reported no truncation. Against the
  // live tenant that hid 467 of the 487 loaded subnets behind a panel whose whole
  // job is to say which ones run out first, with the filter and site controls
  // right there implying the rest could be reached. Measured 2026-08-19.
  //
  // The full sorted set goes to DataTable instead, which caps at rowCap={150}
  // below and labels that cap itself — the same arrangement the leases table
  // twenty lines up already uses, and the repo's standard everywhere else.

  // Normalize numerics + derive network/free so column keys match sort keys.
  // util/used/free stay null when unmeasured — every cell below renders that
  // as —, and utilStatus() is never asked to grade it.
  const tableRows = useMemo(
    () =>
      sorted.map((s) => ({
        ...s,
        util: num(s.util),
        used: num(s.used),
        free: freeOf(s),
        network: (s.addr ? subnetSize(s.cidr ? `${s.addr}/${s.cidr}` : s.addr, s.total) : s.cidr) || '—',
      })),
    [sorted],
  )

  // Controlled sort: DataTable renders header arrows + reports clicks; the
  // component still owns sorting.
  function onSort(next) {
    setSort((s) => (s.key === next.key ? { key: next.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: next.key, dir: 'desc' }))
  }

  const columns = [
    { key: 'network', label: 'Network', mono: true, sortable: true, render: itemCell('network', (r) => ({ id: r.id, value: r.addr && r.cidr != null && r.cidr !== '' ? `${r.addr}/${r.cidr}` : undefined }), { mono: true }) },
    { key: 'site', label: 'Site', sortable: true, render: itemCell('site') },
    // Which public cloud the network was found in; the hover names the
    // account where Infoblox has one (go/internal/dashboard/cloud.go). Only
    // when some network has one: a column with its own render is never
    // auto-hidden, so it would otherwise sit empty on tenants with no cloud.
    ...(tableRows.some((r) => r.cloud) ? [{ key: 'cloud', label: 'Cloud', sortable: true, render: cloudCell }] : []),
    {
      key: 'util',
      label: 'Utilization',
      sortable: true,
      grow: true,
      render: (_v, r) => {
        const status = r.util === null ? null : utilStatus(r.util)
        return (
          <div className="flex items-center gap-2">
            <div className="h-[5px] rounded-full bg-line overflow-hidden flex-1 min-w-[70px]">
              {/* no bar at all for an unknown util — a zero-width bar and a 0%
                  bar are indistinguishable, and one of them is a lie */}
              {status && <div className="h-full" style={{ width: `${Math.min(100, r.util)}%`, background: barColor(status) }} />}
            </div>
            <span className="text-muted w-9 text-right">{r.util === null ? DASH : `${r.util}%`}</span>
          </div>
        )
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) => {
        // utilStatus(null) answers "Healthy" (null >= 92 and null >= 75 are
        // both false) — a green badge on a subnet nobody measured. Unknown
        // gets its own neutral badge instead.
        if (r.util === null) {
          return <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium bg-line text-muted">Unknown</span>
        }
        const status = utilStatus(r.util)
        // Healthy is a quiet word with no fill, so the red and amber chips
        // are the only coloured ones in the column.
        if (status.label === 'Healthy') {
          return <span className="inline-block rounded-full px-2.5 py-0.5 text-note text-muted">{status.label}</span>
        }
        return (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: status.bg, color: status.fg }}>
            {status.label}
          </span>
        )
      },
    },
    { key: 'used', label: 'Used', align: 'right', sortable: true, render: (v) => <span className="text-muted tabular-nums">{v === null ? DASH : v.toLocaleString()}</span> },
    { key: 'free', label: 'Free', align: 'right', sortable: true, render: (v) => <span className="text-muted tabular-nums">{v === null ? DASH : `${v.toLocaleString()} free`}</span> },
  ]

  return (
    <Card
      innerRef={innerRef}
      panelId={panelId}
      // 4, not 6 (GUI audit, Codex B): a table sizes its own panel, so the
      // declared span shows only while it cannot, as when the read failed.
      // At 6 a failed read moved this panel onto a row of its own.
      span={4}
      // The heading is a fragment — it carries a clear-filter chip when the tab
      // has been drilled into — and a fragment is not a name, so "Arrange this
      // page" listed this panel as "network-exhaustion". The words are the
      // heading's own, minus the chip.
      panelName="Which Subnets Run Out First?"
      title={
        <>
          Which Subnets Run Out First?
          {minUtil !== null && !unused && (
            <button
              type="button"
              aria-label="Clear filter"
              className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-note font-normal bg-field border border-border text-muted cursor-pointer"
              onClick={() => setHashParams('network', {})}
              title="clear filter"
            >
              util ≥ {minUtil}% ✕
            </button>
          )}
        </>
      }
      note={unused ? unusedNote(unusedPage, unusedTotal)
        : links ? 'tiny networks (8 addresses or fewer) included' : 'tiny networks (8 addresses or fewer) left out'}
      right={
        <div className="flex flex-wrap items-center justify-end gap-2 max-w-full">
          <label className="flex items-center gap-1.5 text-note text-muted whitespace-nowrap"
            title="Networks where nothing but the first and last address is taken">
            <input
              type="checkbox"
              checked={unused}
              onChange={(e) => setHashParams('network', { ...hp, unused: e.target.checked ? '1' : undefined })}
            />
            Show unused networks{unusedTotal == null ? '' : ` (${unusedTotal.toLocaleString()})`}
          </label>
          {!unused && <label className="flex items-center gap-1.5 text-note text-muted whitespace-nowrap">
            <input
              type="checkbox"
              checked={links}
              onChange={(e) => setHashParams('network', { ...hp, links: e.target.checked ? '1' : undefined })}
            />
            Tiny networks
          </label>}
          <input {...MACHINE_TEXT}
            aria-label="Filter networks"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={unused}
            className={`${FIELD_CLS} w-[170px] max-w-full disabled:opacity-40`}
          />
          <select
            aria-label="Filter by site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            disabled={unused}
            className={`${FIELD_CLS} disabled:opacity-40`}
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      }
    >
      {landing && (
        <div role="status" data-landing-filter className="mt-2 flex flex-wrap items-center gap-x-3 text-copy">
          <span>{landingLine}</span>
          <button type="button" className="text-link underline whitespace-nowrap px-1 py-1.5" onClick={() => setHashParams('network', {})}>Show all</button>
        </div>
      )}
      {unused && !unusedApi.data ? (
        unusedApi.error ? <FeedUnavailable label="Unused networks unavailable" onRetry={unusedApi.refetch} /> : <Skeleton />
      ) : !unused && loading && subnets.length === 0 ? (
        <Skeleton />
      ) : base.length === 0 ? (
        subnetsStatus === 'error' && !unused ? <FeedUnavailable label="Subnet information is unavailable" />
          : <Empty>{unused ? 'No unused networks found' : subnets.length > 0 ? 'No networks of /28 or larger' : 'No subnets found'}</Empty>
      ) : tableRows.length === 0 ? (
        landing && listFailed ? <FeedUnavailable label="Subnet information is unavailable" />
          : <Empty>{landing && !listComplete ? 'none in the subnets loaded' : 'no subnets match'}</Empty>
      ) : (
        <div className="mt-2.5">
          <DataTable rows={tableRows} columns={unused ? columns.map((c) => ({ ...c, sortable: false })) : columns}
            sort={unused ? undefined : sort} onSort={unused ? undefined : onSort} maxHeight={420} rowCap={EXHAUSTION_CAP} />
        </div>
      )}
      {unused && (
        <div className="mt-2 flex items-center justify-end gap-3 text-note">
          <button type="button" className="text-link disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={unusedPage === 0} onClick={() => setUnusedPage((p) => p - 1)}>Previous</button>
          <span className="text-muted">Page {unusedPage + 1}</span>
          <button type="button" className="text-link disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!unusedApi.data?.more} onClick={() => setUnusedPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </Card>
  )
}
