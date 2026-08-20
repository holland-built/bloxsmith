import { useCallback, useEffect, useRef, useState } from 'react'
import { dossierVerdict } from '../lib/dossierVerdict.js'
import DossierPanel from './DossierPanel.jsx'
import { Empty, Skeleton } from './ui.jsx'
import { abortAfter } from '../lib/api.js'
import { useHashParams } from '../lib/hash.js'
import { dossierMoreLine } from '../lib/dossierMore.js'
import { announceResolved, canAuditAnswer, classifyIndicator, isIPQuery } from '../lib/indicator.js'

// Everything about one thing — the page a palette search lands on.
//
// LAYOUT IS SURFACE B of .mockups/build-bloxsmith-ux/bloxsmith-ux-v11.html,
// which is the approved design and therefore the spec: one ruled ledger, one
// row per source, three fixed left lanes (jack 30px / source 178px / state
// 98px), then an identity and exactly three fields. Edge to edge, square
// corners, no cards. The lane widths, the row heights, the jack's three fill
// shapes and the fold at 560px are transcribed from it rather than reinvented.
//
// FIVE SOURCES, FIVE INDEPENDENT FETCHES. This is decision D3 and it is the
// reason this file has no combined loading state anywhere in it: each source
// owns its own useState and its own effect, so a source that takes eight
// seconds cannot keep the other four off the screen. The five stub rows are
// painted on the first render, before any fetch has been issued, and each row
// swaps its own cells in place when its own answer lands.
//
// WHY "NOTHING FOUND" IS NOT THE DEFAULT FAILURE. Four of these endpoints
// answer 200 for their own failures and put the verdict in the body
// (go/internal/server/search.go documents the contract; csp.go:76-82 documents
// the older half of it). That means a section has FOUR outcomes to tell apart,
// not two:
//
//   ok          we asked, and here are the rows
//   none        we asked, and this tenant genuinely holds no match
//   unsupported this tenant's API refused the question — the answer is
//               UNKNOWN, and rendering it as "none" would tell an operator
//               "this IP has no DNS record" when the truth is "we could not
//               ask"
//   error       the feed is down — also unknown, and also not "none"
//   na          the source cannot be asked this question, so it was never
//               asked. Not a failure and not an empty result. Two sources have
//               this outcome, for two different reasons:
//                 IPAM, whose upstream filter is address=="<q>" and which
//                 therefore answers 500 for a hostname — painting that 500 as
//                 "Unavailable" told an operator a healthy system was broken;
//                 Recent changes, whose upstream filter is
//                 (user_name~q or resource_type~q) and which therefore cannot
//                 match the changed object at all — its 200 with zero rows was
//                 being printed as "we asked, and the log holds none", the
//                 proven-absence reading this header exists to forbid, on every
//                 indicator search rather than on any failure
//               In both cases the fix is not a softer label, it is not asking.
//
// `unsupported` and `error` — the two UNKNOWN outcomes, and only those two —
// get the mockup's `why` block: a struck-through "Not this" line
// naming the reading that would be wrong, and a "This" line naming what is
// actually true. It is verbose on purpose; it is the one place on this page
// where a misread is expensive.

// ---------------------------------------------------------------------------
// small formatting helpers
// ---------------------------------------------------------------------------

const DASH = '—'

function fmt(v) {
  if (v == null || v === '') return null
  return String(v)
}

function fmtTime(v) {
  if (!v) return null
  const t = Date.parse(v)
  if (Number.isNaN(t)) return String(v)
  return new Date(t).toLocaleString()
}

// CSP object ids read "ipam/ip_space/78d386a0-3b18-11f0-…". The lane is 226px
// and the prefix is the same on every row, so the discriminating tail is what
// gets shown; the whole id stays in the title for anyone who needs to paste it.
function shortId(v) {
  if (!v) return null
  const tail = String(v).split('/').pop()
  return tail.length > 12 ? tail.slice(0, 8) + '…' : tail
}

// ---------------------------------------------------------------------------
// availability -> one of the four states
// ---------------------------------------------------------------------------
//
// `availability` is what the search and asset routes carry; `status` is what
// the older csp-audit route carries (dashboard/csp.go rowsResp: ok | empty |
// error). Both are read here so neither route needed changing for this page.
//
// A body carrying NEITHER key is treated as an error, not as ok. That is
// deliberate: an unrecognised shape is a body we cannot judge, and the safe
// reading of "I don't know what this is" is "I don't know", never "clean".
function stateOf(body, rows) {
  if (!body || typeof body !== 'object') return 'error'
  const a = body.availability ?? body.status
  if (a === 'unsupported') return 'unsupported'
  if (a === 'ok') return rows.length ? 'ok' : 'none'
  if (a === 'empty') return 'none'
  return 'error'
}

function rowsOf(body) {
  return Array.isArray(body?.rows) ? body.rows : []
}

// ---------------------------------------------------------------------------
// the five sources
// ---------------------------------------------------------------------------
//
// Each entry owns its URL, its identity/field extraction, and the two sentences
// its `why` block needs. `short` is the ribbon's label and is written out per
// source rather than derived: the ribbon used to take the first word of `label`,
// which turned "IP address management" into "IP" and "Recent changes" into
// "Recent". The five words below are transcribed from SURFACE B of the mockup.
// `noneText` is the wording for a genuine zero-row
// answer and is written per source, because "no matching DNS records" and "no
// assets carry this address" are different facts and collapsing them into one
// "no data" is exactly the failure this page is guarding against.

const SOURCES = [
  {
    key: 'assets',
    label: 'Assets',
    short: 'Assets',
    tab: 'assets',
    tabLabel: 'Assets',
    url: (q) => `/api/csp/assets?q=${encodeURIComponent(q)}`,
    noneText: 'no asset in the inventory carries this — we asked, and the inventory holds none',
    unknownText: 'whether any asset carries it',
    shape: (body) =>
      rowsOf(body).map((r, i) => ({
        id: r.cqid ?? `assets-${i}`,
        identity: fmt(r.name),
        fields: [
          ['Type', fmt(r.type)],
          ['Provider', fmt(r.provider ?? r.vendor)],
          ['Last seen', fmtTime(r.last_seen)],
        ],
      })),
  },
  {
    key: 'dns',
    label: 'DNS records',
    short: 'DNS',
    tab: 'dns',
    tabLabel: 'DNS',
    url: (q) => `/api/search/dns?q=${encodeURIComponent(q)}`,
    noneText: 'no matching DNS records — we asked every zone, and none holds this name or points at it',
    unknownText: 'which DNS records name it or point at it',
    shape: (body) =>
      rowsOf(body).map((r, i) => ({
        id: r.id ?? `dns-${i}`,
        identity: fmt(r.absolute_name_spec) ?? fmt(r.name_in_zone),
        fields: [
          ['Record', fmt(r.type)],
          ['TTL', fmt(r.ttl)],
          ['Zone', fmt(r.absolute_zone_name)],
        ],
      })),
  },
  {
    key: 'ipam',
    label: 'IP address management',
    short: 'IPAM',
    tab: 'network',
    tabLabel: 'Network',
    url: (q) => `/api/search/ipam?q=${encodeURIComponent(q)}`,
    // The only source with a shape gate. This route sends the query upstream
    // as address=="<q>", so a hostname is not a query that finds nothing — it
    // is a query with no meaning, and the live tenant answers HTTP 500 to it.
    // `applies` is what stops the request being made; without it the row read
    // "Unavailable · this source could not be read" for every hostname search,
    // which is this page telling an operator a working system is broken.
    applies: isIPQuery,
    naText: 'IPAM is searched by IP address, and this query is not one — so there was nothing to ask it.',
    noneText: 'no IPAM address object for this — we asked every IP space, and none holds it',
    unknownText: 'whether IPAM holds it as an address',
    shape: (body) =>
      rowsOf(body).map((r, i) => ({
        id: r.id ?? `ipam-${i}`,
        identity: fmt(r.address),
        fields: [
          ['State', fmt(r.state)],
          // `space` is carried per row by the server precisely because results
          // can span spaces (server/search.go), so it is one of the three.
          ['Space', shortId(r.space), fmt(r.space)],
          ['Comment', fmt(r.comment) ?? fmt(r.name)],
        ],
      })),
  },
  {
    key: 'threat',
    label: 'Threat intel',
    short: 'Threat',
    tab: 'ai',
    tabLabel: 'AI',
    url: (q) => `/api/dossier?q=${encodeURIComponent(q)}`,
    noneText: 'no threat intelligence source returned anything about this',
    unknownText: 'whether any threat source knows it',
    // The dossier body has no availability field; its state IS the verdict
    // guard. See dossierState below.
    state: (body) => dossierState(body),
    shape: (body) => {
      const sources = Array.isArray(body?.sources) ? body.sources : []
      const sum = body?.summary ?? {}
      return [
        {
          id: 'threat',
          identity: fmt(body?.query),
          fields: [
            ['Verdict', dossierVerdict(sum)],
            ['Sources examined', String(sources.length)],
            // No `?? '0'` fallback. An unreported level is an em-dash like
            // every other unknown on this page; printing 0 there was the
            // render-layer half of #89.
            ['Threat level', fmt(sum.max_threat_level)],
          ],
        },
      ]
    },
  },
  // The second gated source, and the harder case: IPAM cannot be asked about a
  // hostname, but the audit log cannot be asked about any indicator at all.
  // /api/csp-audit builds exactly one clause from q (csp.go:824):
  //
  //     "(user_name~"+rest.Lit(q)+" or resource_type~"+rest.Lit(q)+")"
  //
  // — who made the change, or what kind of object it was. The changed object's
  // own name and address are in neither field, so both sides of the `or` are
  // dead for "10.4.12.7" and for "app-dc1-prod.acme.corp" alike. The route then
  // answers 200 with zero rows, stateOf read that as `none`, and this row
  // printed "we asked, and the log holds none" — a confident negative about a
  // question that was never asked, on every single search.
  //
  // So there is no url, no noneText and no shape here: with `applies` false for
  // every query there is no state but `na` this row can reach, and code for the
  // others would be code describing an outcome the page cannot produce.
  {
    key: 'changes',
    label: 'Recent changes',
    short: 'Changes',
    tab: 'audit',
    tabLabel: 'Audit',
    applies: canAuditAnswer,
    naText:
      'The audit log is searched by who made a change and what kind of object it was — never by the name or address of the thing that changed — so there was nothing to ask it. The Audit tab searches it by user and by object kind.',
  },
]

// The verdict guard, mirrored — NOT re-implemented and NOT edited.
// DossierPanel.jsx:282-293 refuses to paint a verdict unless the body carries a
// summary object AND at least one examined source, because a body with
// summary:{malicious:false} and sources:[] once painted a false CLEAN for an
// indicator nothing had actually checked. The ledger row above the panel shows
// a Verdict field, so it has to refuse the same bodies the panel refuses, on
// the same predicate. If that predicate ever changes, it changes in the panel
// and this must follow it — the panel is the original, this is the copy.
function dossierState(body) {
  if (!body || typeof body !== 'object') return 'error'
  const hasSummary = body.summary != null && typeof body.summary === 'object'
  const sources = Array.isArray(body.sources) ? body.sources : null
  const hasVerdictShape = hasSummary && sources != null && sources.length > 0
  if (body.unavailable || body.error != null || body.locked === true || !hasVerdictShape) return 'error'
  return 'ok'
}

// ---------------------------------------------------------------------------
// one source, one fetch, one piece of state
// ---------------------------------------------------------------------------

const WAITING = { state: 'loading', rows: [], reason: null, body: null }
const NOQUERY = { state: 'noquery', rows: [], reason: null, body: null }
const NOTAPPLICABLE = { state: 'na', rows: [], reason: null, body: null }

// What this source is before any network happens. Computed for the FIRST
// render as well as inside the effect, so a gated source never flashes a
// loading jack for a request that is not going to be made.
function settledBefore(src, q) {
  if (!q) return NOQUERY
  if (src.applies && !src.applies(q)) return NOTAPPLICABLE
  return null
}

// How long a section waits before it gives up and says so.
//
// The shared useApi budget (lib/api.js, 12s) is far too short for this page and
// applying it would abort answers that were on their way. Measured against the
// dev server on the live tenant on 2026-08-07, every sample in seconds:
//   /api/search/dns    n=4   0.15 0.16 0.19 0.20
//   /api/search/ipam   n=4   0.10 0.10 0.10 0.14
//   /api/csp/assets    n=4   1.59 1.59 1.97 5.60
//   /api/dossier       n=7   0.0007 0.001 1.55 1.66 2.27 30.28 30.28
// The two 30.28s samples are cold fan-outs to real threat sources for an
// indicator the tenant had never seen (8.8.8.8, 1.1.1.1) and they ANSWERED 200 —
// a 12s budget would have thrown both away and reported "unknown" about a
// working source, which is the same lie this page exists to avoid, told the
// other way round.
//
// So the floor is not the measurement, it is the server's own ceiling: the Go
// REST client is built with a 35s per-call timeout (go/internal/rest/rest.go:23,
// which is also why /api/csp-audit came back in exactly 35.0s), so nothing
// upstream of a single call can outlive 35s and a client budget below that would
// be giving up on requests the server was still going to answer. 45_000 is that
// 35s ceiling plus 10s of handler and fan-out headroom. It is a hang guard, not
// a latency target — the point is that a section that will never answer says so
// in 45 seconds instead of showing a skeleton for ever.
const DOSSIER_TIMEOUT_MS = 45000

function useSource(src, q) {
  const [res, setRes] = useState(() => settledBefore(src, q) ?? WAITING)

  useEffect(() => {
    const before = settledBefore(src, q)
    if (before) {
      setRes(before)
      return undefined
    }
    // `live` is what makes a stale answer harmless: change the query mid-flight
    // and the previous request's resolution is dropped rather than painted over
    // the new one.
    let live = true
    setRes(WAITING)
    // Borrowed from lib/api.js rather than re-implemented — same helper, same
    // discipline, its own budget for the reason above.
    const { signal, cancel } = abortAfter(DOSSIER_TIMEOUT_MS)
    fetch(src.url(q), { cache: 'no-store', signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!live) return
        // The locked vault, handled the way every other panel in this app
        // handles it (lib/api.js:75-86). A 503 with locked:true is not this feed
        // failing — it is the whole app having no credentials — and the event is
        // what raises the unlock prompt. The row still reads `error`, because
        // for THIS section the answer is genuinely unknown.
        if (r.status === 503 && body && (body.locked === true || body.error === 'vault locked')) {
          window.dispatchEvent(new Event('bx:vault-locked'))
          setRes({ state: 'error', rows: [], reason: 'vault locked', body: null })
          return
        }
        // A non-200 has no availability body to read (that is the whole reason
        // these routes answer 200), so it can only be an error — and it must
        // never fall through to a "none" reading.
        if (!r.ok) {
          setRes({ state: 'error', rows: [], reason: (body && (body.error || body.reason)) || `HTTP ${r.status}`, body: null })
          return
        }
        const state = src.state ? src.state(body) : stateOf(body, rowsOf(body))
        setRes({
          state,
          rows: state === 'ok' ? src.shape(body) : [],
          reason: body?.reason ?? body?.upstream ?? body?.unavailable ?? null,
          body,
        })
      })
      .catch((e) => {
        if (!live) return
        // The abort is named in the reason. "This source could not be read" with
        // no cause invites the reading that the feed is broken; what actually
        // happened is that we stopped waiting, and the row's why block prints
        // this sentence verbatim.
        const gaveUp = e?.name === 'AbortError'
        setRes({
          state: 'error',
          rows: [],
          reason: gaveUp
            ? `no answer in ${DOSSIER_TIMEOUT_MS / 1000}s, so the page stopped waiting`
            : String(e?.message || e),
          body: null,
        })
      })
      .finally(cancel)
    return () => {
      live = false
      cancel()
    }
  }, [src, q])

  return res
}

// ---------------------------------------------------------------------------
// the jack: colour AND fill shape, so it survives greyscale
// ---------------------------------------------------------------------------

const JACK = {
  ok: { border: 'var(--color-ok)', fill: 'var(--color-ok)', label: 'Loaded' },
  none: { border: 'var(--color-dim)', fill: 'transparent', label: 'None' },
  loading: { border: 'var(--color-muted)', fill: 'transparent', label: 'Loading' },
  unsupported: { border: 'var(--color-warn)', fill: 'var(--color-warn)', label: 'Unavailable' },
  error: { border: 'var(--color-warn)', fill: 'var(--color-warn)', label: 'Unavailable' },
  noquery: { border: 'var(--color-dim)', fill: 'transparent', label: 'No query' },
  // Deliberately the dim hollow ring, NOT the barred warn ring: the mockup
  // reserves barred+warn for "unavailable", and this state is the opposite of
  // an alarm. It shares its shape with `none` and `noquery` — the two other
  // outcomes that are calm and complete — and the state word tells the three
  // apart, exactly as the mockup already tells "None" from "No query".
  // Spelled out for a screen reader, since "N/A" is read as two letters.
  na: { border: 'var(--color-dim)', fill: 'transparent', label: 'N/A', aria: 'Not applicable' },
}

function Jack({ state }) {
  const j = JACK[state] ?? JACK.error
  const barred = state === 'unsupported' || state === 'error'
  return (
    <span
      role="img"
      aria-label={j.aria ?? j.label}
      className={'relative block w-[11px] h-[11px] rounded-full border-[1.5px] ' + (state === 'loading' ? 'motion-safe:animate-pulse' : '')}
      style={{ borderColor: j.border }}
    >
      <span
        aria-hidden="true"
        className={'absolute ' + (barred ? 'inset-y-[4px] inset-x-[1px]' : 'inset-[2px] rounded-full')}
        style={{ background: j.fill }}
      />
    </span>
  )
}

const STATE_TONE = {
  ok: 'text-[var(--color-ok)]',
  none: 'text-dim',
  loading: 'text-muted',
  unsupported: 'text-[var(--pill-warn-fg)]',
  error: 'text-[var(--pill-warn-fg)]',
  noquery: 'text-dim',
  na: 'text-dim',
}

// ---------------------------------------------------------------------------
// the ledger grid
// ---------------------------------------------------------------------------
//
// Three fixed lanes then four fluid ones, per the mockup. Below 561px — the
// mockup's own fold — the fact cells stack under the source name and the jack
// lane keeps its full-height column, so the vertical scan of five jacks
// survives the fold instead of being replaced by something else.
// Split from `LANES` on purpose: the ledger head needs these columns AND
// `hidden min-[561px]:grid`, and shipping `grid` and `hidden` on the same
// element leaves which one wins to the order Tailwind happens to emit its
// display utilities in — a coin flip, not a layout.
const LANE_COLS =
  'grid-cols-[30px_1fr] ' +
  'min-[561px]:grid-cols-[30px_178px_98px_minmax(226px,1.15fr)_minmax(190px,1fr)_minmax(170px,0.9fr)_minmax(226px,1.15fr)]'

const LANES = 'grid ' + LANE_COLS

const CELL =
  'col-start-2 min-[561px]:col-start-auto px-[10px] py-[7px] border-b border-line min-w-0 ' +
  'min-[561px]:py-0 min-[561px]:px-[11px] min-[561px]:min-h-[34px] min-[561px]:border-b-0 min-[561px]:border-r min-[561px]:border-line ' +
  'flex items-center'

function FieldCell({ k, v, title }) {
  return (
    <div className={CELL + ' gap-[9px] overflow-hidden'}>
      <span className="text-[11px] uppercase tracking-[0.1em] text-dim font-medium whitespace-nowrap">{k}</span>
      <span className="font-mono text-[13px] text-field-txt truncate" title={title || undefined}>
        {v ?? <span className="text-dim">{DASH}</span>}
      </span>
    </div>
  )
}

function SkeletonCell({ w }) {
  return (
    <div className={CELL}>
      <span className="block h-[9px] bg-line-2" style={{ width: w }} />
    </div>
  )
}

// The left-hand three lanes: jack, source name, state word. Shared by every row
// shape below so the three can never drift apart between states.
function LeftLanes({ state, label }) {
  return (
    <>
      <div className="row-start-1 [grid-row:1/span_6] min-[561px]:[grid-row:auto] flex justify-center items-start min-[561px]:items-center pt-[11px] min-[561px]:pt-0 border-r border-line">
        <Jack state={state} />
      </div>
      <div className={CELL + ' text-[12px] font-semibold tracking-[0.05em] text-txt whitespace-nowrap overflow-hidden text-ellipsis'}>
        {label}
      </div>
      <div className={CELL + ' font-mono text-[11px] font-bold tracking-[0.1em] uppercase whitespace-nowrap ' + (STATE_TONE[state] ?? '')}>
        {JACK[state]?.label ?? 'Unavailable'}
      </div>
    </>
  )
}

// A message that replaces the identity + three fields, spanning the four fluid
// lanes. Used by every non-ok state.
function MessageCell({ tone = 'warn', children }) {
  return (
    <div
      className={
        CELL +
        ' min-[561px]:col-span-4 min-[561px]:border-r-0 text-[13px] ' +
        (tone === 'warn' ? 'text-[var(--pill-warn-fg)]' : 'text-muted')
      }
    >
      {children}
    </div>
  )
}

// The mockup's `why` block: the wrong reading, then the right one. It exists
// only for the two unknown states, and it is the reason this page cannot be
// misread as a clean bill of health for a source that was never reached.
function Why({ src, q, state, reason }) {
  const subject = q || 'this query'
  return (
    <div className={'grid grid-cols-[30px_1fr] border-b border-line bg-card'} data-dossier-why={src.key}>
      <div className="border-r border-line" />
      <div className="px-3 pt-[10px] pb-3 border-l-2" style={{ borderLeftColor: 'var(--color-warn)' }}>
        <div className="flex flex-col min-[561px]:flex-row gap-[10px] items-baseline text-[12px] leading-[1.5] mb-1 text-dim">
          <span className="text-[11px] uppercase tracking-[0.1em] font-bold w-auto min-[561px]:w-[118px] shrink-0">Not this</span>
          <span>
            Nothing found — we asked a source and it told us {subject} has none.
          </span>
        </div>
        <div className="flex flex-col min-[561px]:flex-row gap-[10px] items-baseline text-[12px] leading-[1.5] text-field-txt">
          <span className="text-[11px] uppercase tracking-[0.1em] font-bold w-auto min-[561px]:w-[118px] shrink-0 text-[var(--pill-warn-fg)]">This</span>
          <span>
            {state === 'unsupported'
              ? 'We could not ask. The question never reached a source, so for '
              : 'The source did not answer. Nothing was read, so for '}
            <span className="font-mono">{subject}</span>, {src.unknownText} is <b>unknown</b>, not clean.
            {reason ? <> Reported reason: <span className="font-mono text-[11px]">{reason}</span></> : null}
          </span>
        </div>
        <div className="mt-[9px] flex gap-[7px]">
          <a
            href={`#${src.tab}`}
            className="inline-flex items-center h-[23px] px-[10px] text-[12px] no-underline border border-border bg-field text-field-txt hover:border-border-hover"
          >
            Open {src.tabLabel} tab
          </a>
        </div>
      </div>
    </div>
  )
}

// One source = one primary row. A source that returns several objects gets
// continuation rows beneath it with the three left lanes blank, so the five
// jacks still stack into a single vertical scan (the mockup's stated point) and
// no real row is silently dropped.
const MAX_ROWS = 6

function SourceSection({ src, q, onResult }) {
  const res = useSource(src, q)
  const { state, rows, reason } = res

  // Reported UP, never fetched twice: the ribbon needs this section's state,
  // and the threat panel below the ledger needs this section's body. `onResult`
  // is a useCallback in the page below precisely so this effect fires when the
  // result object actually changes and not on every render. (`res` is a new
  // object only when a fetch resolves — the loading and no-query values are
  // module constants.)
  useEffect(() => {
    onResult(src.key, res)
  }, [onResult, src.key, res])

  const shown = rows.slice(0, MAX_ROWS)
  // NOT `rows.length - shown.length`. That arithmetic is only right while the
  // server handed over everything it found, and search.go caps at its own
  // searchLimit and says so in the payload (#153). The rows in hand are not the
  // rows that matched, so the count of one is not the count of the other.
  const moreLine = dossierMoreLine(res.body, rows.length, shown.length)

  return (
    <div data-dossier-section={src.key}>
      <div
        className={LANES + ' border-b border-line bg-card hover:bg-line-2'}
        data-dossier-source={src.key}
        data-dossier-state={state}
      >
        <LeftLanes state={state} label={src.label} />

        {state === 'loading' && (
          <>
            <SkeletonCell w="172px" />
            <SkeletonCell w="92px" />
            <SkeletonCell w="78px" />
            <SkeletonCell w="104px" />
          </>
        )}

        {state === 'ok' && shown[0] && (
          <>
            <div className={CELL + ' font-mono text-[13px] font-semibold text-txt truncate'}>
              {shown[0].identity ?? DASH}
            </div>
            {shown[0].fields.map(([k, v, title]) => (
              <FieldCell key={k} k={k} v={v} title={title} />
            ))}
          </>
        )}

        {state === 'none' && <MessageCell tone="muted">{src.noneText}</MessageCell>}
        {state === 'na' && <MessageCell tone="muted">{src.naText}</MessageCell>}
        {state === 'noquery' && <MessageCell tone="muted">No query yet.</MessageCell>}
        {state === 'unsupported' && <MessageCell>This tenant&rsquo;s API can&rsquo;t be asked for this.</MessageCell>}
        {state === 'error' && <MessageCell>This source could not be read.</MessageCell>}
      </div>

      {state === 'ok' &&
        shown.slice(1).map((r) => (
          <div key={r.id} className={LANES + ' border-b border-line bg-card hover:bg-line-2'} data-dossier-extra={src.key}>
            <div className="row-start-1 [grid-row:1/span_6] min-[561px]:[grid-row:auto] border-r border-line" />
            <div className={CELL} />
            <div className={CELL} />
            <div className={CELL + ' font-mono text-[13px] font-semibold text-txt truncate'}>{r.identity ?? DASH}</div>
            {r.fields.map(([k, v, title]) => (
              <FieldCell key={k} k={k} v={v} title={title} />
            ))}
          </div>
        ))}

      {state === 'ok' && moreLine && (
        <div className={LANES + ' border-b border-line bg-card'}>
          <div className="border-r border-line" />
          <div className={CELL + ' min-[561px]:col-span-6 min-[561px]:border-r-0 text-[12px] text-muted'}>
            {moreLine}
          </div>
        </div>
      )}

      {(state === 'unsupported' || state === 'error') && <Why src={src} q={q} state={state} reason={reason} />}

    </div>
  )
}

// ---------------------------------------------------------------------------
// the ribbon: the same five jacks, compressed to one line
// ---------------------------------------------------------------------------

// A section that has not reported yet is LOADING, not unavailable. `results` is
// {} until each section's onResult effect runs, which is after the first paint,
// so `results[key]?.state` is undefined on that frame — and Jack's own fallback
// for an unrecognised state is `error`, which is right for a state we cannot
// judge and wrong for one that simply has not arrived. Left undefaulted the
// ribbon opened with five warn rings labelled "Unavailable" beside five blank
// state words: one frame to an eye, the whole story to a screen reader.
const ribbonState = (results, key) => results[key]?.state ?? 'loading'

function Ribbon({ results }) {
  return (
    <div className="flex flex-wrap min-[561px]:h-[25px] border-b border-card-border bg-card">
      {SOURCES.map((s) => (
        <div
          key={s.key}
          data-dossier-ribbon={s.key}
          className="flex items-center gap-2 px-3 h-[24px] min-[561px]:h-auto w-1/2 min-[561px]:w-auto border-r border-line text-[11px]"
        >
          <Jack state={ribbonState(results, s.key)} />
          <span className="uppercase tracking-[0.09em] text-muted">{s.short}</span>
          <span className={'font-mono tracking-[0.08em] font-bold text-[11px] ' + (STATE_TONE[ribbonState(results, s.key)] ?? '')}>
            {JACK[ribbonState(results, s.key)]?.label ?? ''}
          </span>
        </div>
      ))}
      <div className="flex-1 flex items-center px-3 py-[6px] min-[561px]:py-0 text-[11px] text-dim leading-[1.45]">
        Each source is asked on its own — a slow one holds nothing else up.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// what the page says out loud
// ---------------------------------------------------------------------------
//
// Nothing on this page was announced. The five state words are real text, so a
// screen-reader user could go and read them — but nothing said that anything had
// CHANGED, so there was no reason to go and look, and pressing Enter in the
// query box produced silence.
//
// The pacing is the whole difficulty, and it is set by measurement, not taste.
// Four of the five sections settle within milliseconds of each other (three fast
// fetches plus the ungated "Recent changes" row, which never waits on a network
// at all) while /api/dossier has been measured at 30.3s cold. One announcement
// per section would therefore be a four-message burst, each overwriting the
// previous before a screen reader could finish speaking it, followed half a
// minute later by a fifth. So:
//
//   COLLECT  everything that settles inside this window becomes ONE sentence.
//   HOLD     a message is never replaced sooner than this after it appeared,
//            so a straggler cannot cut short the batch before it.
//
// Both are floors, not schedules: the queue drains as fast as the hold allows,
// and a section that settles alone is announced on its own.
const ANNOUNCE_COLLECT_MS = 400
const ANNOUNCE_HOLD_MS = 1600

function useAnnouncer(q, results) {
  const [message, setMessage] = useState('')
  // Bumped by a flush so this effect re-runs and drains whatever settled while
  // the previous message was holding.
  const [flushes, setFlushes] = useState(0)
  const announced = useRef(new Set()) // settled AND already spoken
  const pending = useRef(new Set()) // settled, waiting for the next flush
  const holdUntil = useRef(0)
  const lastQ = useRef(null)

  useEffect(() => {
    // A new query resets everything and says so. This branch returns without
    // reading `results`, which still describes the PREVIOUS query at this point
    // — the sections have not re-reported yet, and treating their old resolved
    // states as this query's answers would announce results nothing has fetched.
    if (lastQ.current !== q) {
      lastQ.current = q
      announced.current = new Set()
      pending.current = new Set()
      holdUntil.current = Date.now() + ANNOUNCE_HOLD_MS
      setMessage(q ? `Searching the estate for ${q}.` : '')
      return undefined
    }

    for (const src of SOURCES) {
      const state = results[src.key]?.state
      if (!state || state === 'loading' || announced.current.has(src.key)) continue
      announced.current.add(src.key)
      pending.current.add(src.key)
    }
    if (!pending.current.size) return undefined

    const wait = Math.max(ANNOUNCE_COLLECT_MS, holdUntil.current - Date.now())
    const t = setTimeout(() => {
      // Built in ledger order at flush time, so the sentence reads down the page
      // in the order the rows are printed rather than in the order they landed.
      const batch = SOURCES.filter((s) => pending.current.has(s.key)).map((s) => ({
        label: s.label,
        state: results[s.key]?.state,
      }))
      pending.current = new Set()
      holdUntil.current = Date.now() + ANNOUNCE_HOLD_MS
      setMessage(announceResolved(batch, SOURCES.length - announced.current.size))
      setFlushes((n) => n + 1)
    }, wait)
    // Cleared and rescheduled whenever another section lands inside the collect
    // window — that is what merges the burst into one sentence.
    return () => clearTimeout(t)
  }, [q, results, flushes])

  return message
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

export default function DossierPage() {
  const params = useHashParams()
  const q = (params.q || '').trim()
  const [draft, setDraft] = useState(q)
  const kind = classifyIndicator(q)

  // The hash is the source of truth: arriving from the palette, from the AI
  // tab, or from a pasted URL all have to fill the box the same way.
  useEffect(() => {
    setDraft(q)
  }, [q])

  const submit = () => {
    const v = draft.trim()
    window.location.hash = v ? `dossier?q=${encodeURIComponent(v)}` : 'dossier'
  }

  // Five states, lifted only so the ribbon can show the same five jacks the
  // rail below shows. Each source still owns its own fetch; this is a mirror,
  // not a coordinator, and nothing waits on it.
  const [results, setResults] = useState({})
  // useCallback with an empty dep list: `setStates` is stable, so this identity
  // never changes, so the effect in each section fires on a real state change
  // rather than on every render of this page (which would be an endless loop —
  // report -> setResults -> re-render -> new report identity -> report).
  const report = useCallback(
    (key, res) => setResults((s) => (s[key] === res ? s : { ...s, [key]: res })),
    [],
  )

  const announcement = useAnnouncer(q, results)

  return (
    <div>
      <h1 className="sr-only">Search result — everything about {q || 'one thing'}</h1>

      {/* The one thing on this page that is for listening rather than reading.
          It is in the tree from the first render — an aria-live region added at
          the same moment as its first message is announced by nothing. */}
      <div data-dossier-live role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {/* Query bar */}
      <div className="flex flex-col min-[561px]:flex-row min-[561px]:h-[40px] border-b border-border bg-field">
        <div className="flex items-center px-3 h-[34px] min-[561px]:h-auto border-b min-[561px]:border-b-0 min-[561px]:border-r border-card-border font-mono text-[11px] tracking-[0.12em] text-dim">
          QUERY
        </div>
        <label className="flex-1 flex items-center px-3 h-[34px] min-[561px]:h-auto min-w-0 border-b min-[561px]:border-b-0 min-[561px]:border-r border-card-border">
          <span className="sr-only">Search the estate</span>
          <input
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            className="bg-transparent outline-none border-0 font-mono text-[16px] font-semibold text-txt tracking-[0.04em] w-full min-w-0"
          />
        </label>
        <div className="flex items-center gap-[9px] px-[13px] h-[34px] min-[561px]:h-auto">
          <span className="text-[11px] uppercase tracking-[0.09em] text-dim">Recognised as</span>
          <span className="font-mono text-[12px] text-field-txt tracking-[0.06em] uppercase font-semibold">
            {kind ? kind.label : q ? 'Free text' : DASH}
          </span>
        </div>
      </div>

      <Ribbon results={results} />

      {/* Ledger head */}
      <div className={'hidden min-[561px]:grid ' + LANE_COLS + ' bg-field border-b border-border'}>
        <div />
        {['Source', 'State', 'Identity'].map((h) => (
          <div key={h} className="h-6 flex items-center px-[11px] border-r border-line text-[11px] uppercase tracking-[0.1em] text-dim font-semibold">
            {h}
          </div>
        ))}
        <div className="col-span-3 h-6 flex items-center px-[11px] text-[11px] uppercase tracking-[0.1em] text-dim font-semibold">
          Fields returned by this source
        </div>
      </div>

      {SOURCES.map((src) => (
        <SourceSection key={src.key} src={src} q={q} onResult={report} />
      ))}

      {/* Threat intel is the one source with more than three fields worth
          reading, so its ledger row is the summary and the existing panel is
          the detail — embedded unedited, verdict guard and all. It sits BELOW
          the whole ledger rather than inside it: dropping a 300px panel between
          rows 4 and 5 breaks the single vertical scan of five jacks that is the
          point of the ledger. */}
      {q && (
        <div data-dossier-panel className="px-[11px] py-3 border-b border-line bg-card">
          <h2 className="text-[11px] uppercase tracking-[0.1em] text-dim font-semibold mb-2">
            Threat intel — full detail
          </h2>
          {(results.threat?.state ?? 'loading') === 'loading'
            ? <Skeleton h={140} />
            : <DossierPanel data={results.threat?.body} />}
        </div>
      )}

      {!q && (
        <Empty>Type an IP or a hostname above and press Enter to search the estate.</Empty>
      )}
    </div>
  )
}
