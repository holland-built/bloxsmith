import { useEffect, useMemo, useState } from 'react'
import { Card, CardGrid, Empty, FeedUnavailable, FOCUS_RING, Skeleton, useChartTheme } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import {
  NOT_ENOUGH_HISTORY,
  OOH_END_HOUR,
  OOH_START_HOUR,
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
  shortActor,
  sinceIso,
  windowLabel,
  withinWindow,
} from '../lib/changes.js'
import Tip from '../components/Tip.jsx'
import './Overview.css'
import './Changes.css'

// WHAT CHANGED (#changes)
//
// Restyled 2026-11-10 in the dashboard look the owner picked (Overview.css,
// the dashboard-design skill): a short label and a number on screen, every
// explanation in a tip. The honesty rule of v3.131.0 stays: when the feed
// stopped at its row limit, no tile says None, counts read "6+", and the
// window pill names the time really covered instead of "last 24 hours".
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

const FEED_COLS = 'grid-cols-[10px_150px_90px_110px_minmax(160px,1fr)_80px_190px]'

// The feed's columns, in the locked order from the design, named once so the
// header row and every data cell agree on which aria-colindex means what.
// `srOnly` is the colour-rail lane: it has no visible label because the design
// gives it none, but a column with no accessible name leaves its cells
// announced against nothing.
const FEED_COLUMNS = [
  { key: 'severity', label: 'Severity', srOnly: true },
  { key: 'ts', label: 'Local time' },
  { key: 'action', label: 'Action' },
  { key: 'result', label: 'Result' },
  { key: 'user', label: 'Who' },
  { key: 'kind', label: 'Type' },
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
  const win = windowLabel({ truncated, rows, nowMs })
  // When the payload arrived, not when this render ran: the half-minute
  // window tick must not make an old read look fresh.
  const fetchedAt = useMemo(() => (data ? new Date() : null), [data])

  return (
    <div className="w-full px-6 py-5">
      <div className="ov-look chg">
        <div className="ov-head">
          <h1>What changed</h1>
          <span className="chg-pills">
            {/* The window the page can honestly claim: "Last 24 hours" only
                when the feed was not cut off at its row limit. */}
            {/* No claim at all until a read has established what it covers. */}
            {state === 'loading' || state === 'unavailable' ? null : (
              <Tip tip={win.tip} className="ov-pill" data-changes-window="">
                {win.text}
              </Tip>
            )}
            <span className="ov-pill">
              <span aria-hidden="true" className={`ov-live${state === 'unavailable' ? ' down' : state === 'loading' ? ' wait' : ''}`} />
              {state === 'loading' ? 'Checking…' : state === 'unavailable' ? 'Not updated' : `Updated ${fetchedAt ? fetchedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`}
            </span>
          </span>
        </div>
        <CardGrid layoutKey="changes">
          <Card panelId="changes-notability" span={6} title="Worth a look">
            {state === 'loading' ? (
              <Skeleton h={96} />
            ) : state === 'unavailable' ? (
              <FeedUnavailable label="CSP audit feed unavailable" reason="nothing can be said about the last 24 hours" />
            ) : (
              <NotabilityBand band={band} listed={summary.listed} />
            )}
            {/* The live region is rendered in every state, empty, and filled when
                the answer lands. A role="status" that is inserted already carrying
                its text is announced unreliably — and this particular text is the
                one that tells the operator they are NOT seeing everything that
                changed, so a missed announcement is a missed 500-row cap. The
                wrapper carries no spacing of its own, so while it is empty it
                occupies no height and the band below is unmoved. */}
            <div data-changes-cap-region="" role="status" aria-live="polite">
              {cap.capped && <CapNote text={cap.text} />}
            </div>
          </Card>

          <Card panelId="changes-changed-objects" span={6} title="Changed objects">
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
              </>
            )}
          </Card>
        </CardGrid>
      </div>
    </div>
  )
}

// ---------- the four tiles ----------

// Four tiles in one strip, divided by hairlines: a label, a number, a word for
// its state, and one short line. Every explanation is in the tile's tip.
function NotabilityBand({ band, listed }) {
  return (
    <div data-changes-band="" className="chg-tiles">
      {band.map((cell) => (
        <BandCell key={cell.key} cell={cell} listed={listed} />
      ))}
    </div>
  )
}

const TILE_LABEL = {
  deletions: 'Deletions',
  failures: 'Failed',
  outOfHours: 'Out of hours',
  newActors: 'New accounts',
}

// Deletions and failures are the two worth a look, so only they turn red when
// there are any. Out of hours and new accounts are facts, not faults: their
// numbers stay ink however large, so a busy night never shouts.
const ALARM = new Set(['deletions', 'failures'])

function tileLine(cell, listed) {
  if (cell.state === 'unknown') return cell.key === 'newActors' && !/cap/.test(cell.reason) ? 'too little history' : 'older rows not read'
  if (cell.key === 'outOfHours') return `${OOH_START_HOUR}:00–0${OOH_END_HOUR}:00 local`
  if (cell.key === 'newActors') return cell.state === 'populated' ? cell.actors.map(shortActor).join(', ') : 'none in the recent half'
  if (cell.atLeast) return 'older rows not read'
  return `of ${listed} ${listed === 1 ? 'change' : 'changes'}`
}

function BandCell({ cell, listed }) {
  const unknown = cell.state === 'unknown'
  const populated = cell.state === 'populated'
  const alarm = populated && ALARM.has(cell.key)
  const word = unknown ? 'Unknown' : populated ? (alarm ? 'Look' : '') : 'None'
  const tip = (
    <>
      {unknown && <>{NOT_ENOUGH_HISTORY[0].toUpperCase() + NOT_ENOUGH_HISTORY.slice(1)}: {cell.reason}. </>}
      {cell.atLeast && <>At least this many: the {ROW_CAP}-row limit was reached, so older rows were not read. </>}
      {cell.caption}
      {cell.key === 'newActors' && populated && <span className="ov-tip-sub">{cell.actors.join(', ')}</span>}
    </>
  )
  return (
    <Tip as="div" tip={tip} data-changes-cell={cell.key} data-state={cell.state} className="chg-tile">
      <span className="ov-kpi-top">
        <span>{TILE_LABEL[cell.key]}</span>
        <span className={`ov-verdict ${alarm ? 'crit' : 'none'}`}>{word}</span>
      </span>
      {/* An unknown answer is a dash, never a 0. A zero here would be read as
          "none happened", which is the exact misreading the cap guard exists
          to prevent. The dash carries that meaning to the eye only — read
          aloud it is nothing at all — so the word it stands for goes beside
          it, hidden from view and not from the accessibility tree. */}
      <span className={`ov-num${alarm ? ' chg-alarm' : ''}`}>
        {unknown ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not answered</span>
          </>
        ) : (
          `${cell.count}${cell.atLeast ? '+' : ''}`
        )}
      </span>
      <span className="ov-muted ov-small chg-line">{tileLine(cell, listed)}</span>
    </Tip>
  )
}

// The row limit, in grey: it is a fact about the feed, not a problem in the
// network. The full sentence is the tip.
function CapNote({ text }) {
  return (
    <Tip tip={text} className="chg-cap" data-changes-cap="">
      <span aria-hidden="true" className="chg-cap-i">i</span>
      Only the {ROW_CAP} most recent
      {/* The live region announces this note, so the whole sentence rides
          along for a screen reader, not only the short label. */}
      <span className="sr-only">. {text}</span>
    </Tip>
  )
}

// ---------- the feed ----------

// The listed rows in numbers: how many, over how many objects, and the span
// they cover. The exact clocks are the tip.
function SpanBar({ summary }) {
  const tip = `${summary.listed} rows in ${summary.groups} groups, from ${summary.earliestClock} to ${summary.latestClock} (${summary.spanText}).`
  return (
    <div data-changes-span="" className="chg-span">
      <Tip tip={tip}>
        <b>{summary.listed}</b> {summary.listed === 1 ? 'change' : 'changes'} · <b>{summary.groups}</b> {summary.groups === 1 ? 'object' : 'objects'} ·{' '}
        {summary.earliestClock}–{summary.latestClock}
      </Tip>
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
      // tabIndex: a box that scrolls has to be reachable, or a keyboard cannot
      // scroll it. The rows hold nothing focusable of their own.
      // relative: each row's sr-only label is position:absolute, and without a
      // positioned box here they escape it and stretch the page ~28px a row.
      tabIndex={0}
      className={`relative max-h-[520px] overflow-auto outline-none ${FOCUS_RING}`}
      role="table"
      aria-label="Changed objects, grouped by resource"
      aria-colcount={FEED_COLUMNS.length}
    >
      <div
        role="row"
        className={`grid ${FEED_COLS} gap-x-3 sticky top-0 z-10 bg-card border-b border-border px-2 py-1.5 text-note chg-colhead`}
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

// Counts describe the rows listed under this header. The band above counts
// the same rows, all groups together.
function groupCounts(group) {
  const parts = [`${group.total} ${group.total === 1 ? 'row' : 'rows'}`]
  if (group.successes) parts.push(`${group.successes} success`)
  if (group.failures) parts.push(`${group.failures} not successful`)
  if (group.deletions) parts.push(`${group.deletions} deleted`)
  return parts.join(' · ')
}

function GroupHeader({ group }) {
  return (
    <div role="row" className={`grid ${FEED_COLS} gap-x-3 items-center border-b border-border px-2 py-1.5 chg-group`}>
      <span role="cell" aria-colindex={COL.severity} />
      <span
        role="rowheader"
        aria-colindex={COL.ts}
        aria-colspan={2}
        className="col-span-2 text-note font-semibold truncate"
        title={group.resource}
      >
        <span role="heading" aria-level={3}>{group.resource}</span>
      </span>
      <span role="cell" aria-colindex={COL.result} aria-colspan={4} className="col-span-4 text-note chg-dim truncate">
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
    <div role="row" className={`grid ${FEED_COLS} gap-x-3 items-center border-b border-line px-2 h-[30px] text-note`}>
      <span
        role="cell"
        aria-colindex={COL.severity}
        className="inline-block w-[7px] h-[7px] rounded-full"
        style={{ background: rail }}
      >
        <span className="sr-only">{railWord}</span>
      </span>
      <span role="cell" aria-colindex={COL.ts} className="tabular-nums whitespace-nowrap">
        <span className="chg-dim mr-1.5">{date}</span>
        {formatClock(row.ts)}
      </span>
      <span role="cell" aria-colindex={COL.action} className="truncate" style={del ? { color: COLORS.crit } : undefined} title={row.action}>{row.action || '—'}</span>
      {/* Success is the normal case, so it stays grey; only a failure is coloured. */}
      <span role="cell" aria-colindex={COL.result} className={`truncate${failed ? '' : ' chg-dim'}`} style={failed ? { color: COLORS.crit } : undefined} title={row.result}>
        {row.result || 'not reported'}
      </span>
      <span role="cell" aria-colindex={COL.user} className="truncate" title={`${row.user || '—'}${row.who_role ? ` · ${row.who_role}` : ''}`}>
        {shortActor(row.user) || '—'}
      </span>
      <span role="cell" aria-colindex={COL.kind} className="truncate chg-dim">{row.who_kind || '—'}</span>
      <span role="cell" aria-colindex={COL.flags} className="flex items-center gap-1">
        {del && <span data-flag="deleted" className="ov-chip crit">Deleted</span>}
        {failed && <span data-flag="failed" className="ov-chip crit">Failed</span>}
        {ooh && <span data-flag="ooh" className="ov-chip none">Out of hours</span>}
      </span>
    </div>
  )
}
