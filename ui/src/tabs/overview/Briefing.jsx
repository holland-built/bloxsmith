import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../../lib/api.js'
import { sinceIso } from '../../lib/changes.js'
import Tip from '../../components/Tip.jsx'
import { changeSummary, dnsTrend, licenseSummary, newIssuesWords, pageVerdict, rankProblems } from './model.js'
import './Briefing.css'

// The top of Overview, picked by the owner on 2026-11-21: is the network OK,
// what changed since yesterday, what needs a look, what is fine. The tiles,
// Services board and arrangeable charts stay below it in Overview.jsx.

const SEV_WORD = { crit: 'Critical', warn: 'Warning', note: 'Note', ok: 'Healthy', none: 'Not checked' }
const rate = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1))

// A shape as well as a colour, so a state still reads without colour vision.
function Mark({ sev }) {
  const shape = {
    crit: <path d="M8 1.5 15 14H1z" fill="currentColor" />,
    warn: <path d="M8 2.5 14 13.5H2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
    ok: <path d="m3 8.5 3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    note: <circle cx="8" cy="8" r="3" fill="currentColor" />,
    none: <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  }
  return <svg className={`br-mark ${sev}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{shape[sev] ?? shape.none}</svg>
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])
  return now
}

const tipFor = (r) => [SEV_WORD[r.sev], r.sub, r.partial ? 'The service list is limited to 500 rows, so additional services may exist' : null].filter(Boolean).join(' · ')

function Fact({ label, children, tip }) {
  return <li className="br-fact"><Tip tip={tip || null} className="br-label">{label}</Tip><span>{children}</span></li>
}

function trendWords(t) {
  if (t.state === 'loading') return 'Loading…'
  if (t.state !== 'ok') return t.state === 'error' ? 'Unavailable' : 'No traffic reported'
  if (t.pct == null) return `${rate(t.now)} queries/s, no earlier value for comparison`
  const dir = t.pct === 0 ? 'unchanged' : `${t.pct > 0 ? 'up' : 'down'} ${Math.abs(t.pct)}%`
  return `${rate(t.now)} queries/s, ${dir} from ${rate(t.was)} ${t.hours} hours ago`
}

function changeWords(c) {
  if (c.state === 'loading') return 'Loading…'
  if (c.state === 'unavailable') return 'Change log unavailable'
  if (c.state === 'undetermined') return 'Period covered could not be determined'
  if (c.state === 'empty') return 'No changes logged in 24 hours'
  const people = `${c.people.toLocaleString()} by users`
  const failed = c.failed ? `, ${c.failed.toLocaleString()} failed` : ''
  const noResult = c.noResult ? `, ${c.noResult.toLocaleString()} with no result reported` : ''
  return `${c.total.toLocaleString()} changes, ${people}${failed}${noResult}`
}

function licenseWords(l) {
  if (l.state === 'loading') return 'Loading…'
  if (l.state === 'error') return 'License feed unavailable'
  if (l.state === 'empty') return 'No licenses reported'
  const bits = []
  if (l.expired) bits.push(`${l.expired} expired`)
  if (l.soon) bits.push(`${l.soon} expiring within 90 days`)
  if (l.undated) bits.push(`${l.undated} without a valid expiration date`)
  return bits.length ? bits.join(', ') : `No licenses expiring within 90 days (${l.total} total)`
}

export default function Briefing({ board, services, dns, licenses, updated }) {
  const [since] = useState(() => sinceIso(Date.now()))
  const audit = useApi(`/api/csp-audit?since=${encodeURIComponent(since)}`, { poll: 60000 })
  const clock = useClock()
  const nowMs = Date.now()
  const verdict = pageVerdict(services, board.board.find((b) => b.name === 'Other')?.issues)
  const problems = rankProblems(board, nowMs / 1000)
  const trend = useMemo(() => dnsTrend(dns), [dns])
  const changes = changeSummary(audit, nowMs)
  const license = licenseSummary(licenses, nowMs)
  const checking = verdict.checking > 0
  const fine = services.filter((s) => s.v.sev === 'ok')
  const unchecked = services.filter((s) => s.v.sev === 'none' && s.v.word !== 'Checking')
  const licenseFine = license.state === 'ok' && !license.expired && !license.soon && !license.undated
  return (
    <>
      {board.feedDown && <p className="br-down" role="alert"><Mark sev="crit" /> Inventory data is unavailable. Hosts, subnets, and leases cannot be checked.</p>}
      <div className="ov-look br">
        <header className="br-rail">
          <p className="br-date">{clock.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>Overview</h1>
          <p className={`br-verdict ${verdict.tone}`}><Mark sev={verdict.tone} /><span data-verdict="">{verdict.word}</span></p>
          <p className="br-line">{verdict.line}</p>
          {problems[0] && <a className="br-primary" href={problems[0].href}>Start with: {problems[0].action}</a>}
          <div className="br-updated">{updated}</div>
        </header>
        <div className="br-read">
          <section aria-labelledby="br-since">
            <h2 id="br-since">Since yesterday</h2>
            <ul className="br-facts">
              <Fact label="DNS traffic">{trendWords(trend)}</Fact>
              <Fact label={changes.state === 'ok' ? `Changes (${changes.window.toLowerCase()})` : 'Changes'} tip={changes.tip}>{changeWords(changes)}</Fact>
              <Fact label="New issues" tip="Issues are dated from when this system first detected them, so 24 hours of history are required to identify new issues.">
                {newIssuesWords({ problems, allRead: board.allRead, reading: board.reading, nowS: nowMs / 1000 })}
              </Fact>
            </ul>
          </section>
          <section aria-labelledby="br-look">
            <h2 id="br-look">Items requiring attention <span>{problems.length || ''}</span></h2>
            {problems.length ? (
              <ol className="br-list">
                {problems.map((r) => (
                  <li key={r.key} className={r.sev} data-problem={r.key}>
                    <Mark sev={r.sev} />
                    <Tip tip={tipFor(r)} className="br-title">{r.title}{r.isNew && <em className="br-new">New</em>}</Tip>
                    <a className="br-btn" href={r.href} aria-label={`${r.action}: ${r.title}`}>{r.action}</a>
                  </li>
                ))}
              </ol>
            ) : <p className="br-empty">{verdict.tone === 'ok' ? 'No items require attention.' : 'No issues found so far.'}</p>}
          </section>
          <section aria-labelledby="br-fine">
            <h2 id="br-fine">Current status</h2>
            <ul className="br-facts">
              <Fact label="Healthy services">{fine.length ? fine.map((s) => s.name).join(', ') : checking ? 'Checking…' : unchecked.length === services.length ? 'No services could be checked' : 'None'}</Fact>
              <Fact label="Licenses">{licenseFine ? <><Mark sev="ok" /> {licenseWords(license)}</> : licenseWords(license)}</Fact>
              {unchecked.length > 0 && <Fact label="Not checked">{unchecked.map((s) => s.name).join(', ')}</Fact>}
            </ul>
          </section>
        </div>
      </div>
    </>
  )
}
