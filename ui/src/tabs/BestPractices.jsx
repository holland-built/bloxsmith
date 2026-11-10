import { Card, CardGrid, FetchError, Skeleton } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'
import { order, SEVERITY, sevOf, splitCount, tally } from '../lib/bestPractices.js'
import Tip from '../components/Tip.jsx'
import './Overview.css'
import './BestPractices.css'

// Design rules checked against the tenant, worked out on the server
// (go/internal/dashboard/best_practices.go). Read-only. A check whose data
// can't prove the answer says so, and is never shown as passed.
//
// In the dashboard look the owner picked on 2026-11-09 (the dashboard-design
// skill, the same look as Overview): three numbers first (to fix, couldn't
// tell, passed), then one row per check with its count in front, so the
// number is read before the sentence. Problems come first and are the only
// bright marks; a check that couldn't tell is drawn hollow and dashed, never
// in the passed colour.

const SHOW = 50
const word = (c) => (c.status === 'problem' ? sevOf(c).label : c.status === 'passed' ? 'Passed' : "Couldn't tell")
const tone = (c) => (c.status === 'problem' ? sevOf(c).tone : c.status === 'passed' ? 'ok' : 'unknown')

// The mark in front of each row: a problem's count in its severity colour,
// a hollow dashed "?" for couldn't tell, a pale tick for passed.
function Mark({ c }) {
  if (c.status === 'problem') {
    const { n } = splitCount(c)
    return n ? <span className={`bp-count ${tone(c)}`} aria-hidden="true">{n.toLocaleString()}</span> : <span className={`bp-ring ${tone(c)}`} aria-hidden="true">!</span>
  }
  return <span className={`bp-ring ${tone(c)}`} aria-hidden="true">{c.status === 'passed' ? '✓' : '?'}</span>
}

function Problem({ c }) {
  const { rest } = splitCount(c)
  const shown = c.items.slice(0, SHOW)
  return (
    <li className="bp-row problem">
      <Mark c={c} />
      <details className="bp-main">
        <summary>
          <span className="bp-line">
            <span className="sr-only">{c.title}</span>
            <span className="bp-title" aria-hidden="true">{rest}</span>
            <span className={`ov-chip bp-chip ${tone(c)}`}>{word(c)}</span>
          </span>
        </summary>
        <div className="bp-body">
          <p className="ov-muted">{c.why}</p>
          {c.note ? <p className="ov-muted">{c.note}</p> : null}
          <ul aria-label={c.title} className="bp-items">
            {shown.map((it, i) => (
              <li key={i}>
                <span className="bp-item-name">{it.name || '(no name)'}</span>
                <span className="ov-muted">{it.detail}</span>
              </li>
            ))}
          </ul>
          {c.items.length > SHOW ? <p className="ov-muted ov-small">And {(c.items.length - SHOW).toLocaleString()} more.</p> : null}
        </div>
      </details>
      {c.link ? <a className="ov-act bp-act" href={c.link}>Open Infra</a> : null}
    </li>
  )
}

function Other({ c }) {
  const passed = c.status === 'passed'
  const sub = passed ? c.note : c.reason
  return (
    <li className={`bp-row ${tone(c)}`}>
      <Mark c={c} />
      <div className="bp-main">
        <div className="bp-line">
          <span className="bp-title">{c.title}</span>
          <span className={`ov-chip bp-chip ${tone(c)}`}>{word(c)}</span>
        </div>
        {sub ? <p className="ov-muted ov-small bp-sub">{sub}</p> : null}
      </div>
    </li>
  )
}

// One cell per check, in list order: bright only for a problem, a dashed
// outline for couldn't tell, pale for passed.
function Strip({ checks }) {
  return (
    <div className="bp-strip">
      {checks.map((c) => (
        <Tip key={c.id} className={`bp-cell ${tone(c)}`} tip={`${word(c)}: ${c.title}`}>
          <span className="sr-only">{`${word(c)}: ${c.title}`}</span>
        </Tip>
      ))}
    </div>
  )
}

// The three headline numbers. With no answer from the server they say
// Checking… or unavailable, never 0.
function Tiles({ checks, loading }) {
  const t = checks ? tally(checks) : null
  const none = loading ? 'Checking…' : 'unavailable'
  const fixTone = t?.problems ? SEVERITY[t.bySev[0][0]].tone : ''
  const of = t ? <small>of {t.total}</small> : null
  return (
    <section className="ov-card" aria-label="Checks at a glance">
      <ul className="bp-tiles">
        <li className="bp-tile" data-tile="fix">
          <span className="bp-tile-top"><span className={`bp-ring sm ${fixTone || 'none'}`} aria-hidden="true">!</span>To fix</span>
          <span className={`ov-num bp-num ${fixTone}`}>{t ? t.problems : '—'} {of}</span>
          <span className="ov-muted ov-small">{t ? t.bySev.map(([s, n]) => `${n} ${s}`).join(' · ') || 'none' : none}</span>
        </li>
        <li className="bp-tile" data-tile="unknown">
          <span className="bp-tile-top"><span className="bp-ring sm unknown" aria-hidden="true">?</span>
            <Tip tip="A list couldn't be read, came back cut short, or can't prove the answer either way. These are never counted as passed.">Couldn't tell</Tip>
          </span>
          <span className={`ov-num bp-num ${t?.unknown ? '' : 'calm'}`}>{t ? t.unknown : '—'} {of}</span>
          <span className="ov-muted ov-small">{t ? (t.unknown ? 'not a pass' : 'none') : none}</span>
        </li>
        <li className="bp-tile" data-tile="passed">
          <span className="bp-tile-top"><span className="bp-ring sm ok" aria-hidden="true">✓</span>
            <Tip tip="The whole list was read and nothing was wrong.">Passed</Tip>
          </span>
          <span className="ov-num bp-num calm">{t ? t.passed : '—'} {of}</span>
          <span className="ov-muted ov-small">{t ? (t.passed ? 'whole list read' : 'none') : none}</span>
        </li>
      </ul>
      {checks?.length ? <Strip checks={checks} /> : null}
    </section>
  )
}

export default function BestPractices() {
  const api = useApi('/api/best-practices')
  const checks = api.data?.checks ? order(api.data.checks) : null
  return (
    <div className="w-full px-6 py-5">
      <div className="ov-look">
        <div className="ov-head">
          <h1>Best practices</h1>
          <Tip className="ov-pill" tip="Checks your Infoblox design against best practices and lists what to fix. It changes nothing.">Read only</Tip>
        </div>
        <Tiles checks={checks} loading={api.loading} />
      </div>
      <div className="mt-4">
        <CardGrid layoutKey="best-practices">
          <Card key="bp-checks" panelId="bp-checks" span={6} title="Checks">
            <FetchError error={api.error} stale={!!checks} />
            {!checks && api.loading ? <Skeleton h={160} /> : null}
            {checks ? (
              <div className="ov-look">
                <ul aria-label="Best practice checks" className="bp-list">
                  {checks.map((c) => (c.status === 'problem' ? <Problem key={c.id} c={c} /> : <Other key={c.id} c={c} />))}
                </ul>
              </div>
            ) : null}
          </Card>
        </CardGrid>
      </div>
    </div>
  )
}
