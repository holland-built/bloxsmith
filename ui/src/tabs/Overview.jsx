import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { useApi } from '../lib/api.js'
import { useHasArranged } from '../lib/arrangedOnce.js'
import { Card, CardGrid, Empty, FeedUnavailable, FIELD_CLS, Skeleton, Sparkline, TabIntro, useChartTheme, utilStatus } from '../components/ui.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { fmtValue } from '../lib/chartFormat.js'
import { cmpMaybe, DASH, freeOf, num } from '../lib/measured.js'


// Tap once to read it, tap again to follow it.
//
// A mouse gets two separate gestures: hover shows the number, click drills into
// the tab below, and by the time you click you have already read the value. A
// finger has only one gesture. On Top Consumers and Host Status that single tap
// fired the bar's / slice's onClick, the hash changed, and Overview unmounted
// before the tooltip could be read — measured, not assumed: tapping the donut
// went straight to `#infra?status=offline` having shown nothing at all. So on a
// phone the number those two panels exist to report was simply unreadable.
//
// The fix keeps both jobs and orders them. `onPointerDownCapture` records
// whether this gesture came from a finger (it runs before recharts' own click
// handling, so the answer is ready when the click arrives). On a mouse nothing
// changes — `drills()` always says yes. On touch the first tap on a bar or slice
// only reveals it (Chromium's tap-to-mouse compatibility events are what make
// recharts show the tooltip); a second tap on the SAME one navigates, and
// tapping a different one moves the arming there instead. Navigation stays one
// tap away, which is why this is not "tap-to-navigate lost".
function useTapThenDrill() {
  const fromTouch = useRef(false)
  const armed = useRef(null)

  const onPointerDownCapture = useCallback((e) => {
    fromTouch.current = e.pointerType === 'touch'
  }, [])

  const drills = useCallback((key) => {
    if (!fromTouch.current) return true
    if (armed.current === key) {
      armed.current = null
      return true
    }
    armed.current = key
    return false
  }, [])

  return { onPointerDownCapture, drills }
}

// ---------- main ----------

// WHAT THE THREE-ACROSS CHART ROW RESERVES WHILE /api/data IS IN FLIGHT.
//
// Measured 2026-08-27 on the live tenant: the row was 198px tall while loading
// and 278px once data landed, and everything below it dropped. All three panels
// share one CardGrid row, so the row's height is the max of the three and no
// one of them could be held still on its own — which is why there are three
// constants here rather than a fix in one panel.
//
// The cause was not a lazily-imported chart chunk. Each panel renders <Empty/>
// (`min-h-[100px]`) whenever its slice is still an empty array, and an in-flight
// request looks exactly like an empty estate to that test. So the row reserved
// 100px for content that settles at 180.
//
// Each number below is the panel's OWN existing literal, not a new measurement:
// the height prop recharts is given, the svg's own height attribute, the donut
// box's Tailwind size. Every one is width-independent — verified at 1920, 1440,
// 1280, 1024 and 900, where the grid drops from six columns to four and the row
// membership changes but none of these three heights moves — so re-spanning or
// reordering a panel through the saved layout cannot invalidate them.
const BARS_H = 180 // SubnetUsageBars, and its Suspense fallback, already agreed on this
const HEATMAP_H = 110 // the heatmap svg's height attribute
const DONUT_H = 130 // the donut box, w-[130px] h-[130px]

// Three chart shapes on this tab; only the panels drawing them wait for recharts.
const GradientArea = lazy(() => import('../charts/GradientArea.jsx'))
const SubnetUsageBars = lazy(() => import('../charts/SubnetUsageBars.jsx'))
const StatusDonut = lazy(() => import('../charts/StatusDonut.jsx'))

export default function Overview() {
  const arrangedOnce = useHasArranged()
  const dns = useApi('/api/csp/dns-qps', { poll: 30000 })
  // The other half of the pair described in ConnStatus.jsx: the header's status
  // dot polls this same url, and on a warm load whichever of the two asks second
  // adopts the first's result instead of fetching 294KB again.
  const data = useApi('/api/data', { poll: 30000, adoptIfFresherThan: 2000 })
  const licenses = useApi('/api/csp/license-alerts', { poll: 30000 })

  const subnets = data.data?.subnets ?? []
  const leases = data.data?.leases ?? []
  const hosts = data.data?.hosts ?? []
  const totals = data.data?._totals ?? {}
  const meta = data.data?._meta ?? {}

  // The whole /api/data request failed — a 500, or the cold-request abort
  // (measured 17-26s cold against a 12s warm budget). There is then no payload
  // at all: no `_meta`, so every per-slice status is undefined, and every
  // slice reads as [] — which the panels below would render as "you have
  // none" over a dead backend. This is the same rule lib/data.js gives the
  // useData() tabs (see its header: "Requested but missing => 'error'"); these
  // tabs read /api/data raw and so have to apply it themselves. The status
  // vocabulary stays exactly ok / empty / error.
  //
  // Not while loading: a request still in flight is a Skeleton, not a failure.
  const feedDown = !data.loading && (!!data.error || data.data == null)
  const sliceStatus = (name) => (feedDown ? 'error' : meta[name])

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-3">Overview</h1>
      {/* The layout sentence lives HERE and on no other tab, because Overview
          is the only grid with a layoutKey — every other tab renders a plain
          grid with no handles, no resize edge and nothing to persist. Telling
          those tabs' readers they can rearrange would be describing a feature
          they do not have.
          "…saves automatically" is the whole answer to "how do I save my
          layout", and it is written out because the honest answer is that
          there is nothing to press: every drop and every resize commit writes
          the view by itself. A reader hunting a Save button finds none and
          concludes their arrangement was lost.

          AND IT STOPS ONCE IT HAS BEEN LEARNED. It is onboarding, not
          reference: worth 30 words on the first visit and worth nothing on the
          four hundredth, where it is just permanent instructions above the
          thing you came to read. The moment a rearrangement actually saves
          (lib/arrangedOnce.js) it is retired for good on this browser. What
          stays is the one-line summary of what the tab IS, which does not go
          out of date the way a lesson does.

          NOTHING IS LOST WHEN IT GOES. The Arrange panels button below is
          always there, and the window it opens says the same thing in full —
          "Changes here save right away — there is no Save button" — so the
          answer to "how do I save my layout" is still one click away from this
          page forever. The Docs button beside this line has it too. */}
      <TabIntro anchor="overview">
        Your estate at a glance — DNS load, address use, subnet fullness and host health.
        {!arrangedOnce && (
          <>
            {' '}On this tab you can drag a panel’s ⠿ handle to rearrange it, or drag its right
            edge to resize, and your arrangement saves automatically.
          </>
        )}
      </TabIntro>
      {totals.degraded && (
        <div className="text-note text-dim mb-2">
          some estate-wide counts could not be fetched this cycle — figures below marked as provisional
        </div>
      )}
      {/* panelId sits on the wrapper component, not only on the Card inside
          it, because CardGrid reads it off its own direct children to work out
          the saved order. Each component forwards it to its Card, which is
          what registers the saved span. Nothing here changes what renders
          until a layout has actually been saved for this tab: with no saved
          view the GET 404s, no order is applied and no span is overridden. */}
      <CardGrid layoutKey="overview">
        <DnsHero panelId="dns-hero" dns={dns} />
        <KpiStack panelId="kpi-stack" subnets={subnets} leases={leases} totals={totals} leasesStatus={sliceStatus('leases')} subnetsStatus={sliceStatus('subnets')} />
        {/* These three share one grid row, so all three take `loading` — the
            row's height is the max of them and reserving in only one or two
            would leave the third to resize it. */}
        <TopUtilization panelId="top-consumers" subnets={subnets} totals={totals} subnetsStatus={sliceStatus('subnets')} loading={data.loading} />
        <SubnetHeatmap panelId="subnet-heatmap" subnets={subnets} totals={totals} subnetsStatus={sliceStatus('subnets')} loading={data.loading} />
        <HostStatus panelId="host-status" hosts={hosts} totals={totals} hostsStatus={sliceStatus('hosts')} loading={data.loading} />
        <SubnetTable panelId="subnet-table" subnets={subnets} totals={totals} subnetsStatus={sliceStatus('subnets')} loading={data.loading} />
        <LicenseInventory panelId="license-inventory" licenses={licenses} />
      </CardGrid>
    </div>
  )
}

// ---------- license inventory ----------

// Coarsens a day count into a glanceable label: whole days under ~2 years,
// otherwise months (under ~5 years) or whole years beyond that.
function formatRemaining(days) {
  if (days == null) return '—'
  const abs = Math.abs(days)
  const sign = days < 0 ? 'ago' : ''
  if (abs < 730) return `${abs.toLocaleString()}d${sign ? ' ' + sign : ''}`
  if (abs < 1825) return `~${Math.round(abs / 30.44)}mo${sign ? ' ' + sign : ''}`
  return `~${Math.round(abs / 365.25)}y${sign ? ' ' + sign : ''}`
}

function LicenseInventory({ licenses, panelId }) {
  const { COLORS } = useChartTheme()
  const rows = licenses.data?.licenses ?? []
  const unavailable = !!licenses.error || licenses.data?.status === 'error'

  const columns = [
    { key: 'name', label: 'Name', grow: true },
    { key: 'sku', label: 'SKU', mono: true, grow: true },
    {
      key: 'state',
      label: 'State',
      render: (state, r) => (
        <span className="flex items-center gap-1.5">
          <span>{state || '—'}</span>
          {r._evaluation && (
            <span className="inline-block rounded-full px-2 py-0.5 text-note font-medium bg-line text-muted">Eval</span>
          )}
        </span>
      ),
    },
    { key: 'expiry', label: 'Expiry' },
    {
      key: 'remaining',
      label: 'Time Left',
      align: 'right',
      sortable: true,
      // Unknown expiry sorts as +Infinity, never -Infinity: ascending order means
      // "most imminent first", so -Infinity would park unparseable rows at the top
      // as if they were the most urgent thing on the panel.
      sortAccessor: (r) => (r._days == null ? Infinity : r._days),
      render: (_v, r) => (
        <span style={r._days != null && r._days < 30 ? { color: COLORS.crit } : r._days != null && r._days < 90 ? { color: COLORS.warn } : undefined} className={r._days == null ? 'text-muted' : ''}>
          {formatRemaining(r._days)}
        </span>
      ),
    },
    {
      key: 'quantity',
      // "QTY" not "Quantity": the auto-sizer measures header text in the cell
      // font, so it under-measures uppercase letter-spaced headers whose cells
      // are short ("1,000"). "QUANTITY" clipped to "QUAN…" even at full width.
      // Known gap — tests/table-sizing.spec.ts only asserts on body cells, so
      // it does not catch clipped headers.
      label: 'Qty',
      align: 'right',
      render: (q) => <span className="text-muted">{typeof q === 'number' ? q.toLocaleString() : '—'}</span>,
    },
  ]

  const now = Date.now()
  const tableRows = rows.map((l, i) => {
    let expiry = '—'
    let days = null
    if (l.expiry) {
      const d = new Date(l.expiry)
      if (!isNaN(d)) {
        expiry = d.toLocaleDateString()
        days = Math.round((d.getTime() - now) / 86400000)
      } else {
        expiry = l.expiry
      }
    }
    return {
      name: l.name || '—',
      sku: l.sku || '—',
      state: l.state || '—',
      expiry,
      remaining: formatRemaining(days),
      quantity: typeof l.quantity === 'number' ? l.quantity : Number(l.quantity) || 0,
      _evaluation: !!l.evaluation,
      _days: days,
      _key: l.id ?? i,
    }
  })

  return (
    <Card
      panelId={panelId}
      // span 6, not 4: this panel now carries six columns (name, sku, state,
      // expiry, time left, quantity). At span 4 the added column pushed the
      // total past the card width, so the auto-sizer shrank headers until
      // "QUANTITY" clipped to "QUAN…" — while two grid columns sat empty to the
      // right. Full width removes both the clip and the dead space.
      span={6}
      title="License Inventory"
      right={unavailable ? null : <span className="text-note text-muted tabular-nums">{rows.length.toLocaleString()} licenses</span>}
    >
      {licenses.loading ? (
        <Skeleton h={220} />
      ) : unavailable ? (
        <FeedUnavailable label="License feed unavailable" />
      ) : rows.length === 0 ? (
        <Empty>no license data available</Empty>
      ) : (
        <DataTable
          rows={tableRows}
          columns={columns}
          rowKey={(r) => r._key}
          maxHeight={280}
          rowCap={50}
        />
      )}
    </Card>
  )
}

// ---------- hero ----------

function DnsHero({ dns, panelId }) {
  const { COLORS } = useChartTheme()
  const rows = dns.data?.rows ?? []
  const status = dns.data?.status
  const chartData = rows.map((r) => {
    let label = r.hour
    const d = new Date(r.hour)
    if (!isNaN(d)) label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return { label, value: Number(r.avg_value) || 0 }
  })
  const current = chartData.at(-1)?.value
  const first = chartData[0]?.value
  const delta = first ? ((current - first) / first) * 100 : null
  const flat = delta != null && Math.abs(delta) < 0.05

  return (
    <Card
      panelId={panelId}
      span={4}
      // The heading is a clickable <span> so it can deep-link to the DNS tab,
      // and a React node is not a name — "Arrange this page" listed this panel
      // as "dns-hero". The words are the heading's own, verbatim, so the row in
      // the popup and the heading on screen are the same phrase to look for.
      panelName="DNS Query Rate — 24h"
      title={<span role="button" tabIndex={0} onClick={() => { location.hash = 'dns' }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'dns' } }} className="cursor-pointer hover:opacity-80 transition-opacity">DNS Query Rate — 24h</span>}
      right={<span className="flex items-center gap-1.5 text-note text-muted"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.accent }} />avg qps</span>}
    >
      {dns.loading ? (
        <Skeleton h={250} />
      ) : dns.error || status === 'error' ? (
        <FeedUnavailable label="DNS query rate feed unavailable" />
      ) : chartData.length === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="flex items-center gap-4 my-2">
            <span className="text-figure font-semibold tracking-tight">{current?.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
            {delta != null && (
              <span className="text-note" style={{ color: flat ? COLORS.other : delta >= 0 ? COLORS.ok : COLORS.crit }}>
                {flat ? '— flat' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}%`} vs first hour
              </span>
            )}
          </div>
          {/* The headline above this chart already rounds the same series to
              one decimal; the tooltip used to answer `value : 346.1144444444444`
              for the very same point. One decimal, and the unit spelled out. */}
          <Suspense fallback={<Skeleton h={230} />}>
            <GradientArea
              data={chartData}
              color={COLORS.accent}
              gradientId="dnsFill"
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

// ---------- kpi stack ----------

function KpiStack({ subnets, leases, totals, leasesStatus, subnetsStatus, panelId }) {
  const { COLORS } = useChartTheme()
  const leasesDown = leasesStatus === 'error'
  const subnetsDown = subnetsStatus === 'error'
  // Unmeasured utilisation is left OUT of the sparkline rather than plotted as
  // 0 — a floor of fake zeros draws a fleet of empty subnets that don't exist.
  const utils = subnets.map((s) => num(s.util)).filter((u) => u !== null).sort((a, b) => a - b)
  const activeLeases = leases.filter((l) => l.state === 'active').length

  const hasSubnetsTotal = typeof totals.subnets === 'number'
  const hasCritTotal = typeof totals.subnetsCrit === 'number'
  // A subnet whose utilisation was never reported is neither ≥90% nor under
  // it. It is counted in neither direction, and the label says how many rows
  // the figure actually covers.
  const measured = subnets.filter((s) => num(s.util) !== null)
  const rowCritSubnets = measured.filter((s) => num(s.util) >= 90).length
  const unmeasured = subnets.length - measured.length

  const cells = [
    { label: 'Active Leases', value: leasesDown ? DASH : activeLeases.toLocaleString(), color: COLORS.accent, hash: 'network?focus=leases', status: leasesStatus },
    hasSubnetsTotal
      ? { label: 'Subnets', value: totals.subnets.toLocaleString(), color: COLORS.purple, hash: 'network' }
      : { label: 'Subnets (loaded rows)', value: subnetsDown ? DASH : subnets.length.toLocaleString(), color: COLORS.purple, hash: 'network', status: subnetsStatus },
    hasCritTotal
      ? { label: 'Subnets ≥90%', value: totals.subnetsCrit.toLocaleString(), color: COLORS.crit, hash: 'network?minUtil=90' }
      : {
          label: unmeasured > 0 ? 'Subnets ≥90% (loaded rows w/ known util)' : 'Subnets ≥90% (loaded rows)',
          value: subnetsDown ? DASH : rowCritSubnets.toLocaleString(),
          color: COLORS.crit,
          hash: 'network?minUtil=90',
          status: subnetsStatus,
        },
  ]

  return (
    // No title by design — the three cells below are their own headings, and a
    // fourth heading above them would say nothing. `panelName` is the words for
    // the places that have to name this panel in a sentence, and it draws
    // nothing: without it the popup called it "kpi-stack". Named for what the
    // cells actually count (leases, subnets, and the subnets ≥90% full).
    <Card panelId={panelId} span={2} panelName="Leases & Subnets" className="flex flex-col justify-between">
      {cells.map((c, i) => {
        const unavailable = c.status === 'error'
        return (
          <div
            key={c.label}
            role="button"
            tabIndex={0}
            onClick={() => { location.hash = c.hash }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = c.hash } }}
            className={`py-3.5 cursor-pointer hover:bg-line rounded-control transition-colors px-1 -mx-1 ${i < cells.length - 1 ? 'border-b border-line-2' : ''}`}
          >
            <div className="text-muted text-note">{c.label}</div>
            {unavailable ? (
              <div className="text-copy font-semibold my-1" style={{ color: COLORS.crit }}>unavailable</div>
            ) : (
              <div className="text-figure font-semibold tracking-tight my-1">{c.value}</div>
            )}
            {utils.length > 1 && !unavailable ? (
              <>
                <Sparkline values={utils} color={c.color} />
                <div className="text-note text-dim mt-0.5">util of loaded rows (sorted), not history or estate</div>
              </>
            ) : (
              // THE +54px THAT MOVED EVERY ROW BELOW THIS PANEL.
              //
              // The placeholder used to be the 30px spacer alone. It stood in
              // for the Sparkline and reserved nothing for the caption under
              // it, so each of the three cells grew 18px the moment /api/data
              // landed — 54px in total, and this panel is the taller half of
              // the top row, so the whole page dropped by it.
              //
              // The caption is rendered rather than measured: same element,
              // same text, same classes, in the same child order, hidden. Its
              // height is then the settled height by construction and cannot
              // drift if the font, the line-height or the wording changes — a
              // constant here would have to be re-measured every time one did.
              //
              // `visibility: hidden` and not `display: none`, which reserves
              // nothing, and not `opacity: 0`, which would leave the text
              // selectable and readable by a screen reader.
              //
              // This branch also covers a genuinely small estate and a failed
              // feed, and it reserves there too. Deliberate: reserving only
              // while loading would trade this shift for a 54px SHRINK on any
              // tenant with one or no measured subnet. The cost is 18px of
              // blank per cell in those two states.
              <>
                <div className="h-[30px]" />
                <div className="text-note text-dim mt-0.5" style={{ visibility: 'hidden' }} aria-hidden="true">
                  util of loaded rows (sorted), not history or estate
                </div>
              </>
            )}
          </div>
        )
      })}
    </Card>
  )
}

// ---------- top utilization ----------

function TopUtilization({ subnets, totals = {}, subnetsStatus, panelId, loading = false }) {
  const { COLORS } = useChartTheme()
  const tap = useTapThenDrill()
  // Rank by addresses USED, not util% — util ranking is a wall of 100% /32 infra links
  // (learned in old app: commits 7789ae8 / 46e591c)
  //
  // A subnet whose `used` is null was never measured, so it has no place in a
  // ranking BY addresses used — it is excluded and counted in the label,
  // rather than ranked as if it used zero addresses.
  const named = subnets.filter((s) => s.addr || s.cidr)
  const measured = named.filter((s) => num(s.used) !== null)
  const unmeasured = named.length - measured.length
  const top = [...measured].sort((a, b) => num(b.used) - num(a.used)).slice(0, 12)
  const estateLabel = typeof totals.subnets === 'number'
    ? `top 12 of ${totals.subnets.toLocaleString()} subnets`
    : `top 12 · estate total unknown`
  const unmeasuredLabel = unmeasured > 0 ? ` · ${unmeasured.toLocaleString()} unmeasured` : ''

  return (
    <Card panelId={panelId} span={2} title="Top Consumers" right={<span className="text-note text-muted">addresses used · {estateLabel}{unmeasuredLabel}</span>}>
      {top.length === 0 ? (
        // Loading is tested BEFORE the empty states, because an in-flight
        // request and an empty estate are indistinguishable from `top` alone
        // and only the first of the two should reserve height.
        loading ? (
          <Skeleton h={BARS_H} />
        ) : subnetsStatus === 'error' ? (
          <FeedUnavailable label="Subnets feed unavailable" />
        ) : named.length > 0 ? (
          <Empty>no loaded subnet reports addresses used</Empty>
        ) : (
          <Empty />
        )
      ) : (
        <div onPointerDownCapture={tap.onPointerDownCapture}>
        <Suspense fallback={<Skeleton h={BARS_H} />}>
          <SubnetUsageBars
            data={top}
            color={COLORS.purple}
            height={BARS_H}
            onBarClick={(payload) => {
              const addr = payload?.addr
              if (!addr || !tap.drills(addr)) return
              location.hash = 'network?subnet=' + encodeURIComponent(addr)
            }}
          />
        </Suspense>
        </div>
      )}
    </Card>
  )
}

// ---------- subnet heatmap ----------

function SubnetHeatmap({ subnets, totals = {}, subnetsStatus, panelId, loading = false }) {
  const { COLORS } = useChartTheme()
  // The readout that replaced the native <title>: which square, and where the
  // pointer is inside the grid so the chip can follow it.
  const [tip, setTip] = useState(null)
  const gridRef = useRef(null)
  // ROVING TABINDEX, AND WHY NOT 288 TAB STOPS.
  //
  // Every square was a pointer-only control: onClick with no tabIndex, no role
  // and no key handler, so the drill-down to a subnet existed for a mouse and
  // for nothing else. Giving each square tabIndex={0} would fix that and put up
  // to 288 stops between the heatmap and the next panel, which is its own
  // defect. One stop enters the grid, arrows move inside it, Enter or Space
  // drills in — the pattern the squares already imply by being a grid.
  //
  // THE FOCUS IS HELD BY SUBNET, NOT BY POSITION. `cells` is re-sorted by
  // utilisation on every 30s poll, so a positional index means the ring and the
  // tab stop can land on a different subnet than the one the operator was
  // reading — silently, while they read it. The square that was 4th is simply
  // not the same thing a moment later. Keying the refs the same way keeps the
  // rect mounted across a reorder, so DOM focus survives it too.
  const [focusKey, setFocusKey] = useState(null)
  const [gridFocused, setGridFocused] = useState(false)
  const cellRefs = useRef(new Map())

  // Every square calls this on enter AND on move, because a finger dragged
  // across the grid never fires `enter` again after the first square.
  const showTip = useCallback((e, addr, util) => {
    const box = gridRef.current?.getBoundingClientRect()
    if (!box) return
    setTip({ addr, util, x: e.clientX - box.left, y: e.clientY - box.top, w: box.width, h: box.height })
  }, [])
  // Cleared from the grid, not from each square: moving between two squares
  // fires the old one's `leave` and the new one's `enter`, and if those two ever
  // arrive in the other order the readout would blank out mid-drag.
  const hideTip = useCallback(() => setTip(null), [])

  // Worst N only — a cell per subnet at 5k subnets = sub-pixel rects (invisible). Cap + say so.
  const CAP = 288 // 24 x 12
  // /29-/32 are infra links, always ~100% — they'd paint the whole map red (old app: 67db14e)
  const all = subnets.filter((s) => (s.addr || s.cidr) && (Number(s.cidr) || 0) <= 28)
  // A null util has no colour on a util heatmap: painted as 0 it is a cool,
  // near-transparent "healthy" tile, which is a claim about a subnet nobody
  // measured. Unmeasured subnets are left off the map and counted in the
  // label instead.
  const measured = all.filter((s) => num(s.util) !== null)
  const unmeasured = all.length - measured.length
  const cells = [...measured].sort((a, b) => num(b.util) - num(a.util)).slice(0, CAP)
  const cols = 24
  const rows = Math.max(1, Math.ceil(cells.length / cols))
  const gap = 0.6
  const cw = 100 / cols
  const ch = 100 / rows
  const drill = (addr) => { if (addr) location.hash = 'network?subnet=' + encodeURIComponent(addr) }

  // The readout follows the pointer for a mouse and the cell for a keyboard, so
  // arrowing across the grid says the same thing hovering does.
  const showTipAt = useCallback((i, addr, util) => {
    const box = gridRef.current?.getBoundingClientRect()
    if (!box) return
    const r = Math.floor(i / cols)
    const c = i % cols
    setTip({
      addr, util, w: box.width, h: box.height,
      x: (c + 0.5) / cols * box.width,
      y: (r + 0.5) / rows * box.height,
    })
  }, [cols, rows])

  // A subnet's stable identity. `addr` alone is not enough: two rows can carry
  // the same address in different IP spaces, and a duplicate React key silently
  // drops one of them.
  const cellKey = (s) => s.id ?? `${s.addr ?? s.cidr ?? ''}`
  // Falls back to the first square whenever the remembered subnet has dropped
  // out of the set. Without a fallback no square carries tabIndex 0 and the
  // grid leaves the tab order altogether — the exact defect this change fixes.
  const foundIdx = cells.findIndex((s) => cellKey(s) === focusKey)
  const rovingIdx = foundIdx >= 0 ? foundIdx : 0

  const estateTotal = typeof totals.subnets === 'number' ? totals.subnets.toLocaleString() : null
  const heatmapLabel = cells.length < measured.length
    ? `worst ${cells.length} of ${measured.length.toLocaleString()} loaded${estateTotal ? ` (${estateTotal} in estate)` : ''}`
    : `util by subnet — ${cells.length.toLocaleString()} loaded${estateTotal ? ` of ${estateTotal}` : ''}`
  const unmeasuredLabel = unmeasured > 0 ? ` · ${unmeasured.toLocaleString()} util unknown` : ''

  return (
    <Card panelId={panelId} span={2} title="Subnet Heatmap" right={<span className="text-note text-muted">{heatmapLabel}{unmeasuredLabel}</span>}>
      {cells.length === 0 ? (
        // This panel has no Suspense boundary of its own — it draws inline SVG
        // — so its height follows /api/data directly, and loading is the only
        // signal that separates "still asking" from "nothing to draw".
        loading ? (
          <Skeleton h={HEATMAP_H} />
        ) : subnetsStatus === 'error' ? (
          <FeedUnavailable label="Subnets feed unavailable" />
        ) : all.length > 0 ? (
          <Empty>no loaded subnet reports utilisation</Empty>
        ) : (
          <Empty />
        )
      ) : (
        <>
          {/* The 288 squares used to say what they were through a native
              <title>: about a second of hovering before the OS drew it, no way
              to make it match anything else on the page, and nothing at all on a
              touchscreen — which is the whole complaint this panel was raised
              on. It is replaced, not supplemented: keeping both would draw two
              tooltips on a mouse. The aria-label on each square is the one thing
              <title> did well, kept.

              This wrapper is `relative` so the readout can be positioned against
              the grid. It sits inside the card BODY; nothing here goes near the
              card header or the layout machinery that measures it. */}
          <div ref={gridRef} className="relative" onPointerLeave={hideTip}>
            {/* touch-action: none so a finger dragged along the grid keeps
                delivering pointermove to these squares instead of being taken
                over as a page scroll — the same reason the layout drag handle
                carries `touch-none`. A tap is unaffected and still navigates. */}
            <svg
              width="100%" height={HEATMAP_H} viewBox="0 0 100 100" preserveAspectRatio="none"
              style={{ touchAction: 'none' }}
              role="group"
              aria-label="Subnet utilisation heatmap. Arrow keys move between subnets, Enter opens one."
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) { setGridFocused(false); hideTip() }
              }}
            >
              {cells.map((s, i) => {
                const util = num(s.util) // never null: `cells` is the measured set
                const addr = s.addr || s.cidr
                const r = Math.floor(i / cols)
                const c = i % cols
                const color = util >= 92 ? COLORS.crit : util >= 75 ? COLORS.warn : COLORS.accent
                const opacity = Math.max(0.15, Math.min(1, util / 100))
                return (
                  <rect
                    key={cellKey(s)}
                    ref={(el) => {
                      const k = cellKey(s)
                      if (el) cellRefs.current.set(k, el)
                      else cellRefs.current.delete(k)
                    }}
                    x={c * cw + gap / 2}
                    y={r * ch + gap / 2}
                    width={cw - gap}
                    height={ch - gap}
                    rx={0.8}
                    fill={color}
                    // fillOpacity, NOT opacity. `opacity` applies to the whole
                    // element, stroke included, so the focus ring on a 10%-used
                    // subnet was painted at 15% — the faintest ring on the least
                    // alarming square, which is backwards. With no stroke at
                    // rest the two properties render identically, so nothing
                    // about the unfocused map changes.
                    fillOpacity={opacity}
                    role="button"
                    tabIndex={i === rovingIdx ? 0 : -1}
                    aria-label={`${addr} — ${fmtValue(util)}% used`}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    // The focus ring is drawn rather than left to the browser: a
                    // UA outline on an SVG child is painted in user units and
                    // clipped by the viewBox, so on the edge squares half of it
                    // is not there. A stroke is inside the square by
                    // construction. It is only painted while the grid holds
                    // focus, so a mouse never sees it.
                    stroke={gridFocused && i === rovingIdx ? 'var(--color-txt)' : 'none'}
                    // 0.6 user units, which is exactly `gap`. An SVG stroke is
                    // centred on the edge, so half of it (0.3) falls outside the
                    // rect — and every rect is inset by gap/2 = 0.3 from its
                    // cell boundary and from the viewBox edge. So the ring lands
                    // in the gutter on interior squares and stops precisely at
                    // the viewBox on perimeter ones. At 0.9 it was clipped.
                    strokeWidth={gridFocused && i === rovingIdx ? 0.6 : 0}
                    onFocus={() => { setGridFocused(true); setFocusKey(cellKey(s)); showTipAt(i, addr, util) }}
                    onPointerEnter={(e) => showTip(e, addr, util)}
                    onPointerMove={(e) => showTip(e, addr, util)}
                    onClick={() => drill(addr)}
                    onKeyDown={(e) => {
                      const moveTo = (n) => {
                        const next = cells[Math.min(cells.length - 1, Math.max(0, n))]
                        if (!next) return
                        e.preventDefault()
                        setFocusKey(cellKey(next))
                        cellRefs.current.get(cellKey(next))?.focus()
                      }
                      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key]
                      if (step !== undefined) return moveTo(i + step)
                      if (e.key === 'Home') return moveTo(0)
                      if (e.key === 'End') return moveTo(cells.length - 1)
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(addr) }
                    }}
                  />
                )
              })}
            </svg>
            {tip && (
              <div
                data-heatmap-readout
                className="absolute z-10 pointer-events-none whitespace-nowrap rounded-control border border-border bg-field px-2 py-1 text-note shadow-sm"
                style={{
                  // Clamped to the grid on both axes so the chip can never
                  // escape the card body — half its own width in from each edge
                  // horizontally, and pushed back up when the pointer is on the
                  // bottom row.
                  left: Math.min(Math.max(tip.x, 74), Math.max(74, tip.w - 74)),
                  top: Math.min(Math.max(tip.y + 12, 2), Math.max(2, tip.h - 26)),
                  transform: 'translateX(-50%)',
                }}
              >
                <span className="font-medium">{tip.addr}</span>
                <span className="text-muted"> — {fmtValue(tip.util)}% used</span>
              </div>
            )}
          </div>
          <div className="flex gap-3.5 mt-2 text-note text-muted">
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.accent }} />ok</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.warn }} />&gt;75%</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-mark inline-block" style={{ background: COLORS.crit }} />&gt;92%</span>
          </div>
        </>
      )}
    </Card>
  )
}

// ---------- host status ----------

// "unknown" is the backend's word (go/internal/dashboard/norm.go) for a host
// whose upstream status was absent or unrecognised — deliberately not the real
// lifecycle state "pending" it used to masquerade as. It is its own bucket, not
// part of Other: "we do not know this host's state" is a fact an operator acts
// on, and folding it into a catch-all made this donut disagree with Infra's
// (Unknown 2% / Other 8% there vs a single Other 10% here) about the same hosts.
//
// Mirrors statusBucket() / BUCKET_LABEL / the bucket order in ui/src/tabs/
// Infra.jsx, which does not export them. Keep the two in step: same names, same
// order, same colours, so the two screens read as one number.
function statusBucket(s) {
  s = s || ''
  if (/^unknown$/i.test(s)) return 'unknown'
  if (/online|up|active/i.test(s)) return 'active'
  if (/degraded|warn/i.test(s)) return 'degraded'
  if (/off|down|error|fail/i.test(s)) return 'offline'
  return 'other'
}

const BUCKET_LABEL = { active: 'Active', degraded: 'Degraded', offline: 'Offline', unknown: 'Unknown', other: 'Other' }

function HostStatus({ hosts, totals = {}, hostsStatus, panelId, loading = false }) {
  const { COLORS } = useChartTheme()
  const tap = useTapThenDrill()
  const buckets = { Active: 0, Degraded: 0, Offline: 0, Unknown: 0, Other: 0 }
  for (const h of hosts) buckets[BUCKET_LABEL[statusBucket(h.status)]]++
  const colorMap = {
    Active: COLORS.accent,
    Degraded: COLORS.warn,
    Offline: COLORS.crit,
    Unknown: COLORS.other,
    Other: COLORS.purple,
  }
  const hasHostTotal = typeof totals.hosts === 'number'
  const total = hasHostTotal ? totals.hosts : hosts.length
  const loaded = hosts.length
  const pieData = Object.entries(buckets)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value, color: colorMap[name] }))

  return (
    <Card panelId={panelId} span={2} title="Host Status">
      {total === 0 ? (
        // The donut's own Suspense fallback already fills its 130px box, so the
        // lazy chunk was never this panel's problem — the <Empty/> below it was.
        loading ? (
          <Skeleton h={DONUT_H} />
        ) : hostsStatus === 'error' ? (
          <FeedUnavailable label="Hosts feed unavailable" />
        ) : (
          <Empty />
        )
      ) : (
        <div className="flex items-center gap-4">
          {/* w-[130px] h-[130px] is DONUT_H. The two are kept in step by
              tests/overview-cls.spec.ts, which fails if the box and the
              reservation ever disagree. */}
          <div className="relative w-[130px] h-[130px] shrink-0" onPointerDownCapture={tap.onPointerDownCapture}>
            <Suspense fallback={<div className="w-full h-full" />}>
              <StatusDonut
                data={pieData}
                valueFormat={(v) => `${fmtValue(v)} ${Number(v) === 1 ? 'host' : 'hosts'}`}
                onSliceClick={(d) => {
                  if (!d?.name || !tap.drills(d.name)) return
                  location.hash = 'infra?status=' + d.name.toLowerCase()
                }}
              />
            </Suspense>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-copy font-semibold">{total.toLocaleString()}</span>
              <span className="text-dim text-note">{hasHostTotal ? 'hosts' : 'hosts (loaded)'}</span>
            </div>
          </div>
          <div className="flex-1 flex flex-col gap-2">
            {pieData.map((d) => (
              <div
                key={d.name}
                role="button"
                tabIndex={0}
                onClick={() => { location.hash = 'infra?status=' + d.name.toLowerCase() }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'infra?status=' + d.name.toLowerCase() } }}
                className="flex items-center gap-1.5 text-note cursor-pointer hover:bg-line rounded-control transition-colors px-1 -mx-1"
              >
                <i className="w-2 h-2 rounded-mark inline-block" style={{ background: d.color }} />
                <span className="text-muted flex-1">{d.name}</span>
                <b>{((d.value / loaded) * 100).toFixed(0)}%</b>
              </div>
            ))}
          </div>
        </div>
      )}
      {hasHostTotal && loaded !== total && (
        <div className="text-note text-dim mt-2">breakdown of {loaded.toLocaleString()} loaded of {total.toLocaleString()} total</div>
      )}
    </Card>
  )
}

// ---------- table ----------

// The subnet table's scroll box, reserved before the rows exist and held after
// they arrive. One constant rather than a literal in three places: the skeleton
// only reserves the right space while it equals what the table occupies, and
// two of these drifting apart reintroduces the shift silently.
const TABLE_H = 420

function SubnetTable({ subnets, totals = {}, subnetsStatus, panelId, loading = false }) {
  const [filter, setFilter] = useState('')
  const [site, setSite] = useState('')
  const [sort, setSort] = useState({ key: 'util', dir: 'desc' })

  const sites = useMemo(() => [...new Set(subnets.map((s) => s.site).filter(Boolean))].sort(), [subnets])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return subnets.filter((s) => {
      // /29-/32 infra links are always ~100% — they bury real exhaustion (old app: 67db14e)
      if ((Number(s.cidr) || 0) > 28) return false
      if (site && s.site !== site) return false
      if (!q) return true
      return [s.addr, s.cidr, s.site, s.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [subnets, filter, site])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const { key, dir } = sort
    arr.sort((a, b) => {
      if (key === 'network' || key === 'site') {
        const av = key === 'network' ? a.addr || a.cidr || '' : a.site || ''
        const bv = key === 'network' ? b.addr || b.cidr || '' : b.site || ''
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      // util (and anything unmapped) plus free: both can be null, and
      // cmpMaybe parks null at the bottom of whichever direction is shown
      // instead of ordering it as 0.
      if (key === 'free') return cmpMaybe(freeOf(a), freeOf(b), dir)
      return cmpMaybe(num(a.util), num(b.util), dir)
    })
    return arr
  }, [filtered, sort])

  const rows = useMemo(
    () =>
      sorted.map((s) => {
        const util = num(s.util)
        const free = freeOf(s)
        // utilStatus(null) would answer "Healthy" (null >= 92 and null >= 75
        // are both false), i.e. a green badge on a subnet nobody measured.
        // Unknown gets its own neutral badge and no colour bar.
        const st = util === null ? null : utilStatus(util)
        return {
          network: s.addr || s.cidr || '—',
          site: s.site || '—',
          util,
          free,
          status: st ? st.label : 'Unknown',
          _addr: s.addr || s.cidr,
          _color: st?.color,
          _bg: st?.bg,
          _fg: st?.fg,
        }
      }),
    [sorted],
  )

  function exportCsv() {
    const header = ['Network', 'Site', 'Utilization', 'Status', 'Free']
    const lines = [header.join(',')]
    for (const s of sorted) {
      // "unknown", not 0% / 0 free — the CSV outlives the screen and is the
      // artefact people paste into a capacity plan.
      const util = num(s.util)
      const free = freeOf(s)
      const status = util === null ? 'Unknown' : utilStatus(util).label
      const network = s.addr || s.cidr || ''
      const utilCell = util === null ? 'unknown' : `${util}%`
      const freeCell = free === null ? 'unknown' : free
      lines.push([network, s.site || '', utilCell, status, freeCell].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'top-subnets.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns = [
    { key: 'network', label: 'Network', mono: true, sortable: true },
    { key: 'site', label: 'Site', sortable: true },
    {
      key: 'util',
      label: 'Utilization',
      sortable: true,
      grow: true,
      render: (util, r) => (
        <div className="flex items-center gap-2">
          <div className="h-[5px] rounded-full bg-line overflow-hidden flex-1 min-w-[70px]">
            {/* no bar at all for an unknown util — a zero-width bar and a 0%
                bar are indistinguishable, and one of them is a lie */}
            {util !== null && <div className="h-full" style={{ width: `${Math.min(100, util)}%`, background: r._color }} />}
          </div>
          <span className="text-muted w-9 text-right">{util === null ? DASH : `${util}%`}</span>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (_v, r) =>
        r.util === null ? (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium bg-line text-muted">Unknown</span>
        ) : (
          <span className="inline-block rounded-full px-2.5 py-0.5 text-note font-medium" style={{ background: r._bg, color: r._fg }}>
            {r.status}
          </span>
        ),
    },
    {
      key: 'free',
      label: 'Free',
      align: 'right',
      sortable: true,
      render: (free) => <span className="text-muted">{free === null ? DASH : `${free.toLocaleString()} free`}</span>,
    },
  ]

  return (
    <Card
      panelId={panelId}
      span={6}
      title="Top Subnets by Utilization"
      note="excl. /29–/32 infra links"
      right={
        <div className="flex items-center gap-2">
          <span className="text-note text-muted tabular-nums">
            {/* "0 loaded" over a dead feed reads as an empty estate; the count
                is unknown, so it prints as an em-dash. */}
            {subnetsStatus === 'error'
              ? `${DASH} loaded`
              : typeof totals.subnets === 'number'
                ? `showing ${rows.length.toLocaleString()} of ${totals.subnets.toLocaleString()}`
                : `${rows.length.toLocaleString()} loaded`}
          </span>
          <input
            aria-label="Filter subnets"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD_CLS} w-[170px]`}
          />
          {/* "Site", not "Filter subnets by site". The input above is already
              labelled "Filter subnets", and a label that CONTAINS another's
              makes every substring locator ambiguous: layout-drag.spec.ts:453
              asks for getByLabel('Filter subnets') and got two elements. The
              select filters by site and sits beside a control that says it
              filters subnets, so the shorter name is the clearer one too. */}
          <select
            aria-label="Site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className={FIELD_CLS}
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button onClick={exportCsv} className="px-2.5 py-1.5 rounded-control border border-border bg-field text-field-txt text-copy">
            Export CSV
          </button>
        </div>
      }
    >
      {/* The in-flight branch is a Skeleton at TABLE_H, not <Empty/>.
          It used to be <Empty/>, which stands about 72px tall, and the table
          that replaces it stands TABLE_H: measured on 2026-08-27, that one swap
          was 0.1988 of the page's 0.1994 desktop CLS, against a 0.1 threshold.
          The mobile Lighthouse profile scored 0.004 and hid it entirely,
          because at 390px the panel is below the fold when it grows.

          THE SKELETON ALONE IS ONLY HALF OF IT, and the missing half is the
          minHeight below. maxHeight pins the table's height only for an estate
          with enough subnets to overflow it — the live tenant reports 72,299,
          so that is the ordinary case — but a small estate renders a short
          table, and a skeleton sized to the cap would then be taller than what
          replaces it. The panel would collapse rather than grow: the same
          shift, pointing the other way, and for a 3-subnet estate a worse one
          than the bug being fixed. min and max together make the box TABLE_H in
          every state that has a table in it.

          Loading is its OWN branch rather than a case of "no rows yet", and
          what is left unreserved is deliberate: a tenant with genuinely zero
          subnets, or a dead feed, still steps down from TABLE_H to a short box
          once. That is chosen over standing a screen-tall empty rectangle in
          front of someone whose estate has nothing in it — the reserved space
          exists to stop the common case moving, not to make every case
          equally tall. */}
      {loading && subnets.length === 0 ? (
        <Skeleton h={TABLE_H} />
      ) : subnets.length === 0 ? (
        subnetsStatus === 'error' ? <FeedUnavailable label="Subnets feed unavailable" /> : <Empty />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          sort={sort}
          onSort={(next) =>
            setSort((cur) =>
              cur.key === next.key
                ? { key: next.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
                : { key: next.key, dir: 'desc' },
            )
          }
          onRowClick={(r) => {
            if (r._addr) location.hash = 'network?subnet=' + encodeURIComponent(r._addr)
          }}
          rowKey={(r, i) => r.network + i}
          maxHeight={TABLE_H}
          minHeight={TABLE_H}
          rowCap={150}
          emptyText="no subnets match"
        />
      )}
    </Card>
  )
}
