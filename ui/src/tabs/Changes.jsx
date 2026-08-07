import { useEffect, useMemo, useState } from 'react'
import { Card, CardGrid, Empty, FeedUnavailable, Skeleton, useChartTheme } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import {
  FEED_PROMISE,
  NOT_ENOUGH_HISTORY,
  ROW_CAP,
  capNotice,
  feedState,
  feedSummary,
  formatClock,
  formatDate,
  groupByResource,
  isDeletion,
  isFailure,
  isOutOfHours,
  notability,
  sinceIso,
  withinWindow,
} from '../lib/changes.js'

// WHAT CHANGED — LAST 24 HOURS (#changes)
//
// A thin render layer. Every rule this screen states in words — the window,
// the grouping, the four notability categories, the cap — is proved by
// ui/src/lib/changes.test.js under `npm test`; nothing is decided here.
//
// The one promise this page makes is FEED_PROMISE: the 500 most recent events
// in the last 24 hours, newest first. It is NOT "everything that changed" —
// CSPAudit caps at 500 rows with no paging parameter, so on a busy tenant the
// oldest events inside the window are simply not fetchable from this route.

// The tape re-reads its own window every half minute so a row that ages past
// 24 h leaves the screen without a refetch. The `since` parameter is seeded
// once instead, so the URL stays stable and useApi's poll never blanks the
// panel back to a skeleton mid-session.
const WINDOW_TICK_MS = 30000
const POLL_MS = 60000

// Chip wording from the approved design. The library's generic chips stay in
// lib/changes.js (where the tests read them); these are presentation only.
const POPULATED_CHIP = {
  deletions: 'Del',
  failures: 'Fail',
  outOfHours: '20:00–08:00',
  newActors: 'New',
}

const FEED_COLS = 'grid-cols-[10px_130px_100px_110px_minmax(140px,1fr)_74px_96px]'

// The feed's columns, in the locked order from the design, named once so the
// header row and every data cell agree on which aria-colindex means what.
// `srOnly` is the colour-rail lane: it has no visible label because the design
// gives it none, but a column with no accessible name leaves its cells
// announced against nothing.
const FEED_COLUMNS = [
  { key: 'severity', label: 'Severity', srOnly: true },
  { key: 'ts', label: 'Local time' },
  { key: 'action', label: 'Op' },
  { key: 'result', label: 'Result' },
  { key: 'user', label: 'Actor' },
  { key: 'kind', label: 'Kind' },
  { key: 'flags', label: 'Flags' },
]

// Which column each cell sits in, 1-based, as aria-colindex wants it.
const COL = Object.fromEntries(FEED_COLUMNS.map((c, i) => [c.key, i + 1]))

export default function Changes() {
  const [since] = useState(() => sinceIso(Date.now()))
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), WINDOW_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const url = `/api/csp-audit?since=${encodeURIComponent(since)}`
  const { data, error, loading } = useApi(url, { poll: POLL_MS })

  const rows = useMemo(() => withinWindow(data?.rows, nowMs), [data, nowMs])
  const truncated = data?.truncated === true
  const cap = capNotice(data)
  const band = useMemo(() => notability(rows, { truncated }), [rows, truncated])
  const groups = useMemo(() => groupByResource(rows), [rows])
  const summary = useMemo(() => feedSummary(rows), [rows])
  const state = feedState({ payload: data, error, loading, rowsInWindow: rows })

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-1">What changed — last 24 hours</h1>
      <p className="text-xs text-muted mb-3 max-w-[80ch]">
        Infoblox portal activity, {FEED_PROMISE}. This is a window on the audit route, not a change log: it
        cannot show more than {ROW_CAP} events, and it holds no history from before the window.
      </p>
      <CardGrid>
        <Card panelId="changes-notability" span={6} title="Notability" note="four questions asked of this window, each answered or explicitly not answered">
          {state === 'loading' ? (
            <Skeleton h={120} />
          ) : state === 'unavailable' ? (
            <FeedUnavailable label="CSP audit feed unavailable" reason="nothing can be said about the last 24 hours" />
          ) : (
            <NotabilityBand band={band} />
          )}
          {/* The live region is rendered in every state, empty, and filled when
              the answer lands. A role="status" that is inserted already carrying
              its text is announced unreliably — and this particular text is the
              one that tells the operator they are NOT seeing everything that
              changed, so a missed announcement is a missed 500-row cap. The
              wrapper carries no spacing of its own, so while it is empty it
              occupies no height and the band below is unmoved. */}
          <div data-changes-cap-region="" role="status" aria-live="polite">
            {cap.capped && <CapBanner text={cap.text} />}
          </div>
        </Card>

        <Card
          panelId="changes-changed-objects"
          span={6}
          title="Changed objects"
          note="grouped by what was touched, newest group first"
          right={state === 'ok' ? <span className="text-[11px] text-muted">{summary.listed} rows · {summary.groups} groups</span> : null}
        >
          {state === 'loading' ? (
            <Skeleton h={250} />
          ) : state === 'unavailable' ? (
            <FeedUnavailable label="CSP audit feed unavailable" reason="the portal audit read did not complete" />
          ) : state === 'empty' ? (
            <Empty>nothing changed in the last 24 hours</Empty>
          ) : (
            <>
              <SpanBar summary={summary} />
              <Feed groups={groups} />
              <Legend />
            </>
          )}
        </Card>
      </CardGrid>
    </div>
  )
}

// ---------- the notability band ----------

// One ruled strip of four cells, each with its count in a fixed left lane, so
// the four numbers sit at the same x-offset and the reason reads to the right.
function NotabilityBand({ band }) {
  return (
    <div
      data-changes-band=""
      className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 rounded-lg border border-border overflow-hidden"
    >
      {band.map((cell) => (
        <BandCell key={cell.key} cell={cell} />
      ))}
    </div>
  )
}

function BandCell({ cell }) {
  const { COLORS } = useChartTheme()
  const unknown = cell.state === 'unknown'
  const populated = cell.state === 'populated'
  const tone = !populated ? COLORS.other : cell.key === 'outOfHours' ? COLORS.warn : COLORS.crit

  return (
    <div
      data-changes-cell={cell.key}
      data-state={cell.state}
      className="grid grid-cols-[62px_1fr] bg-field border-b xl:border-b-0 border-r border-line last:border-r-0 last:border-b-0"
    >
      {/* An unknown answer is a dash, never a 0. A zero in this lane would be
          read as "none happened", which is the exact misreading the two guards
          below the count exist to prevent. The dash carries that meaning to the
          eye only — read aloud it is nothing at all, indistinguishable from an
          empty lane — so the word it stands for goes beside it, hidden from
          view and not from the accessibility tree. */}
      <div className="flex items-start justify-center pt-2.5 text-[26px] leading-none font-semibold tabular-nums" style={{ color: unknown ? COLORS.other : tone }}>
        {unknown ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not answered</span>
          </>
        ) : (
          cell.count
        )}
      </div>
      <div className="px-3 py-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2.5">
          <span className="text-[12px] font-semibold">{cell.label}</span>
          <Chip tone={populated ? (cell.key === 'outOfHours' ? 'warn' : 'crit') : 'quiet'}>
            {populated ? POPULATED_CHIP[cell.key] : cell.chip}
          </Chip>
        </div>
        <p className="mt-1.5 text-[12px] text-muted leading-[1.45]">
          {unknown && (
            <span className="text-field-txt font-semibold">
              {NOT_ENOUGH_HISTORY[0].toUpperCase() + NOT_ENOUGH_HISTORY.slice(1)} — {cell.reason}.{' '}
            </span>
          )}
          {cell.caption}
        </p>
        {cell.state === 'populated' && cell.key === 'newActors' && (
          <p className="mt-1 text-[11px] text-dim truncate" title={cell.actors.join(', ')}>
            {cell.actors.join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}

function CapBanner({ text }) {
  const { COLORS } = useChartTheme()
  return (
    <div
      data-changes-cap=""
      className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-border bg-field px-3 py-2"
      style={{ borderColor: COLORS.warn }}
    >
      <Chip tone="warn">Capped</Chip>
      <span className="text-[12px] text-muted leading-[1.45]">{text}</span>
    </div>
  )
}

// ---------- the feed ----------

// States its own arithmetic, so the only derived number on this page can be
// checked by hand against the two clocks either side of it.
function SpanBar({ summary }) {
  return (
    <div data-changes-span="" className="flex flex-wrap gap-x-5 gap-y-1 px-1 pb-2 text-[10.5px] uppercase tracking-wide text-dim">
      <span>rows listed here <b className="text-field-txt">{summary.listed}</b></span>
      <span>groups <b className="text-field-txt">{summary.groups}</b></span>
      <span>earliest <b className="text-field-txt">{summary.earliestClock}</b></span>
      <span>latest <b className="text-field-txt">{summary.latestClock}</b></span>
      <span>
        span <b className="text-field-txt">{summary.spanText}</b>{' '}
        <span className="text-dim normal-case">( {summary.latestClock} − {summary.earliestClock} )</span>
      </span>
    </div>
  )
}

// The tape is a real table, declared with ARIA rather than <table> markup.
//
// The design locks the geometry — 28px rows against the parent table
// component's 54px, one sticky header, and the object name lifted out of the
// rows into interleaved group headers — and that is exactly what a CSS grid
// does and what <table> layout does not. Roles carry the semantics instead, so
// nothing about the rendered box model moves: every className below is the one
// that was there before this change.
//
// Each group is its own rowgroup AND names itself with a level-3 heading, which
// is what makes the groups jumpable — heading navigation is the shortcut screen
// reader users actually reach for, and a rowgroup alone has none.
function Feed({ groups }) {
  return (
    <div
      className="max-h-[520px] overflow-auto"
      role="table"
      aria-label="Changed objects, grouped by resource"
      aria-colcount={FEED_COLUMNS.length}
    >
      <div
        role="row"
        className={`grid ${FEED_COLS} gap-x-3 sticky top-0 z-10 bg-card border-b border-border px-1 py-1.5 text-[10.5px] uppercase tracking-wide text-dim`}
      >
        {FEED_COLUMNS.map((col, i) => (
          <span key={col.key} role="columnheader" aria-colindex={i + 1}>
            {/* The rail lane's label is nested rather than applied to the grid
                item itself: sr-only is position:absolute, so labelling the item
                directly would pull it out of the grid and shift all six visible
                headings one column left. */}
            {col.srOnly ? <span className="sr-only">{col.label}</span> : col.label}
          </span>
        ))}
      </div>
      {groups.map((group) => (
        <div
          key={group.resource}
          data-changes-group={group.resource}
          role="rowgroup"
          aria-label={`${group.resource} — ${groupCounts(group)}`}
        >
          <GroupHeader group={group} />
          {group.rows.map((row, i) => (
            <FeedRow key={row.id ?? `${group.resource}-${i}`} row={row} />
          ))}
        </div>
      ))}
    </div>
  )
}

// Counts describe the rows listed under this header and nothing else — the
// band above counts the whole window, so the two will not add up.
function groupCounts(group) {
  const parts = [`${group.total} ${group.total === 1 ? 'row' : 'rows'}`]
  if (group.successes) parts.push(`${group.successes} success`)
  if (group.failures) parts.push(`${group.failures} not successful`)
  if (group.deletions) parts.push(`${group.deletions} deleted`)
  return parts.join(' · ')
}

function GroupHeader({ group }) {
  return (
    <div role="row" className={`grid ${FEED_COLS} gap-x-3 items-center bg-line-2 border-b border-border px-1 py-1.5`}>
      <span role="cell" aria-colindex={COL.severity} />
      <span
        role="rowheader"
        aria-colindex={COL.ts}
        aria-colspan={2}
        className="col-span-2 text-[12px] font-semibold truncate"
        title={group.resource}
      >
        <span role="heading" aria-level={3}>{group.resource}</span>
      </span>
      <span role="cell" aria-colindex={COL.result} aria-colspan={4} className="col-span-4 text-[11px] text-dim truncate">
        {groupCounts(group)}
      </span>
    </div>
  )
}

function FeedRow({ row }) {
  const { COLORS } = useChartTheme()
  const del = isDeletion(row)
  const failed = isFailure(row)
  const ooh = isOutOfHours(row)
  const rail = del || failed ? COLORS.crit : ooh ? COLORS.warn : COLORS.other
  // The rail is a colour and nothing else, so it is invisible to anyone reading
  // by ear or in greyscale. The word behind the colour rides with it. It is not
  // simply the Flags column repeated: a routine row has an EMPTY Flags cell and
  // a grey rail, and "Routine" is the only place that state is ever stated.
  const railWord = del || failed ? 'Critical' : ooh ? 'Out of hours' : 'Routine'
  // Both halves of this timestamp read in the browser's zone. The header above
  // says "Local time" and means it for the date as well as the clock.
  const date = formatDate(row.ts)

  return (
    <div role="row" className={`grid ${FEED_COLS} gap-x-3 items-center border-b border-line px-1 h-[28px] text-[11.5px]`}>
      <span
        role="cell"
        aria-colindex={COL.severity}
        className="inline-block w-[6px] h-[6px] rounded-full"
        style={{ background: rail }}
      >
        <span className="sr-only">{railWord}</span>
      </span>
      <span role="cell" aria-colindex={COL.ts} className="font-mono text-[11px] whitespace-nowrap">
        <span className="text-dim mr-1.5">{date}</span>
        {formatClock(row.ts)}
      </span>
      <span role="cell" aria-colindex={COL.action} className="truncate" style={del ? { color: COLORS.crit } : undefined} title={row.action}>{row.action || '—'}</span>
      <span role="cell" aria-colindex={COL.result} className="truncate" style={{ color: failed ? COLORS.crit : COLORS.ok }} title={row.result}>
        {row.result || 'not reported'}
      </span>
      <span role="cell" aria-colindex={COL.user} className="truncate text-muted" title={`${row.user || '—'}${row.who_role ? ` · ${row.who_role}` : ''}`}>
        {row.user || '—'}
      </span>
      <span role="cell" aria-colindex={COL.kind} className="truncate text-dim">{row.who_kind || '—'}</span>
      <span role="cell" aria-colindex={COL.flags} className="flex items-center gap-1">
        {del && <Chip tone="crit">Del</Chip>}
        {failed && <Chip tone="crit">Fail</Chip>}
        {ooh && <Chip tone="warn">OOH</Chip>}
      </span>
    </div>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[10.5px] text-dim">
      <span><b className="text-muted">DEL</b> deletion</span>
      <span><b className="text-muted">FAIL</b> result was not "success"</span>
      <span><b className="text-muted">OOH</b> outside 20:00–08:00 on your local clock</span>
      <span>Group counts describe the rows listed here, not the whole window</span>
      <span>Band counts describe the 24-hour window, so they will not add up to these rows</span>
    </div>
  )
}

function Chip({ tone = 'quiet', children }) {
  const { COLORS } = useChartTheme()
  const color = tone === 'crit' ? COLORS.crit : tone === 'warn' ? COLORS.warn : COLORS.other
  return (
    <span
      className="shrink-0 rounded-md border px-1.5 py-[1px] text-[10px] leading-[14px] whitespace-nowrap"
      style={{ color, borderColor: color }}
    >
      {children}
    </span>
  )
}
