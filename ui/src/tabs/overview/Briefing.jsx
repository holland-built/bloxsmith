import { useEffect, useMemo, useState } from 'react'
import { retryFailedFeeds, useApi, useFeedRecovery } from '../../lib/api.js'
import Tip from '../../components/Tip.jsx'
import { changeSummary, changeWords, dnsTrend, emptyListWords, licenseSummary, listHeading, newIssuesWords, pageVerdict, rankProblems, trendWords } from './model.js'
import './Briefing.css'
import { PageTitle } from '../../components/kit.jsx'

// The top of Overview, picked by the owner on 2026-11-21: is the network OK,
// what changed recently, what needs a look, what is fine. The tiles,
// Services board and arrangeable charts stay below it in Overview.jsx.

const SEV_WORD = { crit: 'Critical', warn: 'Warning', note: 'Note', ok: 'Healthy', none: 'Not checked' }

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

function licenseWords(l) {
  if (l.state === 'loading') return 'Loading…'
  if (l.state === 'error') return 'License information is unavailable'
  if (l.state === 'empty') return 'No licenses reported'
  const bits = []
  if (l.expired) bits.push(`${l.expired} expired`)
  if (l.soon) bits.push(`${l.soon} expiring within 90 days`)
  if (l.undated) bits.push(`${l.undated} without a valid expiration date`)
  return bits.length ? bits.join(', ') : `No licenses expiring within 90 days (${l.total} total)`
}

// The inventory failed: say what that means, that Bloxsmith keeps trying, and
// offer the same Try again every unavailable panel has (screen audit A3).
function InventoryDown() {
  const { retrying } = useFeedRecovery()
  return (
    <div className="br-down" role="alert">
      <Mark sev="crit" />
      <span>Inventory data is unavailable. Hosts, subnets, and leases cannot be checked. Bloxsmith tries again every 30 seconds.</span>
      {retrying
        ? <span className="br-down-wait">Trying again…</span>
        : <button type="button" className="br-down-retry" onClick={retryFailedFeeds}>Try again</button>}
    </div>
  )
}

export default function Briefing({ board, services, dns, licenses, updated }) {
  // The whole last 24 hours counted on the server, not the newest 500 rows.
  const audit = useApi('/api/csp-audit-count', { poll: 60000 })
  const clock = useClock()
  const nowMs = Date.now()
  const verdict = pageVerdict(services, board.board.find((b) => b.name === 'Other')?.issues)
  const problems = rankProblems(board, nowMs / 1000)
  const trend = useMemo(() => dnsTrend(dns), [dns])
  const changes = changeSummary(audit)
  const heading = listHeading(verdict, problems, services)
  const license = licenseSummary(licenses, nowMs)
  const checking = verdict.checking > 0
  const fine = services.filter((s) => s.v.sev === 'ok')
  const unchecked = services.filter((s) => s.v.sev === 'none' && s.v.word !== 'Checking')
  const licenseFine = license.state === 'ok' && !license.expired && !license.soon && !license.undated
  return (
    <>
      {board.feedDown && <InventoryDown />}
      <div className="ov-look br">
        <header className="br-rail">
          <PageTitle>Overview</PageTitle>
          <p className="br-date">{clock.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <div className="br-updated">{updated}</div>
        </header>
        <div className="br-read">
          <section aria-labelledby="br-look">
            <h2 id="br-look" className={`br-verdict ${heading.tone}`}>
              <Mark sev={heading.tone} /><span data-verdict="">{heading.word}</span> <span className="br-line">{heading.detail}</span>
            </h2>
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
            ) : <p className="br-empty" data-empty-list="">{emptyListWords(services, verdict)}</p>}
          </section>
          <section aria-labelledby="br-since">
            <h2 id="br-since">Last few hours</h2>
            <ul className="br-facts">
              <Fact label="DNS traffic">{trendWords(trend)}</Fact>
              <Fact label="Changes" tip={changes.tip}>{changeWords(changes)}</Fact>
              <Fact label="New issues" tip="Issues are dated from when this system first detected them, so 24 hours of history are required to identify new issues.">
                {newIssuesWords({ problems, allRead: board.allRead, reading: board.reading, nowS: nowMs / 1000 })}
              </Fact>
            </ul>
          </section>
          <section aria-labelledby="br-fine">
            <h2 id="br-fine">Current status</h2>
            <ul className="br-facts">
              <Fact label="Healthy services">{fine.length ? fine.map((s) => s.name).join(', ') : checking ? 'Checking…' : unchecked.length === services.length ? 'No services could be checked' : 'None'}</Fact>
              <Fact label="Licenses">{licenseFine ? <><Mark sev="ok" /> {licenseWords(license)}</> : licenseWords(license)}</Fact>
              {unchecked.length > 0 && <Fact label="Not fully checked">{unchecked.map((s) => s.name).join(', ')}</Fact>}
            </ul>
          </section>
        </div>
      </div>
    </>
  )
}
