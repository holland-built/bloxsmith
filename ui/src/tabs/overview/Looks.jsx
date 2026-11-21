import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../../lib/api.js'
import { healthMetric } from '../../lib/dnsHealth.js'
import { sinceIso } from '../../lib/changes.js'
import Tip from '../../components/Tip.jsx'
import LookSwitcher from './LookSwitcher.jsx'
import { canTellNew, changeSummary, dnsTrend, licenseSummary, pageVerdict, rankProblems, stripCells } from './model.js'
import './Looks.css'

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
  return <svg className={`lk-mark ${sev}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{shape[sev] ?? shape.none}</svg>
}

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])
  return now
}

const tipFor = (r) => [SEV_WORD[r.sev], r.sub, r.partial ? 'The service list stops at 500 rows, so more may exist' : null].filter(Boolean).join(' · ')

// ---------- a. command center ----------

function ProblemRow({ r, rank }) {
  return (
    <li className={`lka-row ${r.sev}`} data-problem={r.key}>
      <span className="lka-rank">{rank}</span>
      <Mark sev={r.sev} />
      <Tip tip={tipFor(r)} className="lka-title">
        {r.title}
        {r.isNew && <em className="lk-new">New</em>}
      </Tip>
      <span className="lka-acts">
        {r.ask && <a className="lk-quiet" href={`#ai?q=${encodeURIComponent(r.ask)}`} aria-label={`Ask why: ${r.title}`}>Ask why</a>}
        <a className="lk-btn" href={r.href} aria-label={`${r.action}: ${r.title}`}>{r.action}</a>
      </span>
    </li>
  )
}

function CommandCenter({ verdict, problems, services, updated }) {
  const [all, setAll] = useState(false)
  const first = problems[0]
  const shown = all ? problems : problems.slice(0, 6)
  return (
    <div className="ov-look lk lka">
      <div className="ov-head"><h1>Overview</h1>{updated}</div>
      <div className="lka-grid">
        <section className={`lka-verdict ${verdict.tone}`} aria-label="Network status right now">
          <div className="lka-now"><Mark sev={verdict.tone} /> Right now</div>
          <p className="lka-word" data-verdict="">{verdict.word}</p>
          <p className="lka-line">{verdict.line}</p>
          {first ? (
            <div className="lka-first">
              <span>Do this first</span>
              <strong>{first.title}</strong>
              <a className="lk-primary" href={first.href}>{first.action}</a>
            </div>
          ) : (
            <div className="lka-first"><span>{verdict.tone === 'ok' ? 'Nothing needs you' : 'Nothing found yet'}</span></div>
          )}
          <ul className="lka-services" aria-label="Services">
            {services.map((s) => (
              <li key={s.name}>
                <a href={s.b?.href} className={s.v.sev} aria-label={`${s.name}: ${s.v.word}`}>
                  <i aria-hidden="true" />
                  <b>{s.name}</b>
                  <span>{s.v.word}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
        <section className="ov-card lka-list" aria-labelledby="lka-h">
          <div className="ov-card-head"><h2 id="lka-h">Fix in this order</h2><span className="ov-muted">{problems.length ? `${problems.length} open` : ''}</span></div>
          {problems.length ? (
            <>
              <ol>{shown.map((r, i) => <ProblemRow key={r.key} r={r} rank={i + 1} />)}</ol>
              {problems.length > 6 && (
                <button type="button" className="lk-more" aria-expanded={all} onClick={() => setAll(!all)}>
                  {all ? 'Show fewer' : `Show ${problems.length - 6} more`}
                </button>
              )}
            </>
          ) : (
            <p className="lk-empty">{verdict.tone === 'ok' ? 'No open problems.' : verdict.checking ? 'Checking your services…' : verdict.unchecked === verdict.total ? 'No service could be checked.' : 'No problems found, but some services could not be checked.'}</p>
          )}
        </section>
      </div>
    </div>
  )
}

// ---------- b. live wall ----------

function Cells({ s }) {
  const c = stripCells(s)
  if (!c) return <div className="lkb-cells nodata" role="img" aria-label={`${s.name}: no data`} />
  const tone = s.v.sev === 'crit' ? 'crit' : 'warn'
  const label = c.exact ? `${s.name}: ${c.count - c.bad} of ${c.count} up` : `${s.name}: about ${c.bad} of ${c.count} cells flagged`
  return (
    <div className="lkb-cells" role="img" aria-label={label}>
      {Array.from({ length: c.count }, (_, i) => <i key={i} className={i < c.bad ? tone : ''} />)}
    </div>
  )
}

function DnsBars({ trend }) {
  if (trend.state !== 'ok') {
    return <p className="lk-empty">{trend.state === 'loading' ? 'Loading DNS traffic…' : trend.state === 'error' ? 'DNS traffic unavailable' : 'No DNS traffic reported'}</p>
  }
  return (
    <div className="lkb-bars" role="img" aria-label={`DNS queries per second by hour. Latest ${rate(trend.now)}, highest ${rate(trend.max)}.`}>
      {trend.bars.map((b, i) => (
        <i key={b.hour} className={i === trend.bars.length - 1 ? 'open' : ''} style={{ height: `${Math.max(4, (b.value / (trend.max || 1)) * 100)}%` }} />
      ))}
    </div>
  )
}

function Vital({ label, m }) {
  return <div className="lkb-vital"><span>{label}</span><b className={m.state === 'ok' ? '' : 'off'}>{m.text}</b></div>
}

function LiveWall({ verdict, problems, services, trend, health, updated }) {
  const clock = useClock()
  return (
    <div className="ov-look lk lkb">
      <header className={`lkb-top ${verdict.tone}`}>
        <h1 className="sr-only">Overview</h1>
        <span className="lkb-state"><Mark sev={verdict.tone} /><b data-verdict="">{verdict.word}</b></span>
        <span className="lkb-line">{verdict.line}</span>
        <span className="lkb-clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
        {updated}
      </header>
      <div className="lkb-grid">
        <section className="lkb-panel lkb-strips" aria-label="Services">
          {services.map((s) => (
            <a key={s.name} href={s.b?.href} className={`lkb-strip ${s.v.sev}`} aria-label={`${s.name}: ${s.v.word}. ${s.tip}`}>
              <span className="lkb-name"><Mark sev={s.v.sev} /><b>{s.name}</b><small>{s.v.word}</small></span>
              <Cells s={s} />
              <span className="lkb-num">{s.value === '—' ? <b className="off">No data</b> : <><b>{s.value}</b><small>{s.unit}{s.right ? ` · ${s.right}` : ''}</small></>}</span>
            </a>
          ))}
        </section>
        <section className="lkb-panel lkb-dns" aria-label="DNS, last 24 hours">
          <div className="lkb-dnshead">
            <span>DNS queries/s</span>
            <b>{trend.state === 'ok' ? rate(trend.now) : 'No data'}</b>
            {trend.pct != null && <small>{trend.pct === 0 ? '±0%' : `${trend.pct > 0 ? '▲' : '▼'} ${Math.abs(trend.pct)}%`} vs {trend.hours}h ago</small>}
          </div>
          <DnsBars trend={trend} />
          <div className="lkb-vitals">
            <Vital label="Answer time" m={healthMetric(health, 'answer_time')} />
            <Vital label="Cache hits" m={healthMetric(health, 'cache_hit')} />
            <Vital label="Timeouts" m={healthMetric(health, 'timeouts')} />
          </div>
        </section>
        <section className="lkb-panel lkb-queue" aria-labelledby="lkb-q">
          <h2 id="lkb-q">Open problems <span>{problems.length || ''}</span></h2>
          {problems.length ? (
            <ol>
              {problems.map((r) => (
                <li key={r.key} className={r.sev} data-problem={r.key}>
                  <Mark sev={r.sev} />
                  <a href={r.href} title={tipFor(r)} aria-label={`${r.action}: ${r.title}`}>{r.title}</a>
                </li>
              ))}
            </ol>
          ) : <p className="lk-empty">{verdict.tone === 'ok' ? 'None open' : 'None found yet'}</p>}
        </section>
      </div>
    </div>
  )
}

// ---------- c. morning briefing ----------

function Fact({ label, children, tip }) {
  return <li className="lkc-fact"><Tip tip={tip || null} className="lkc-label">{label}</Tip><span>{children}</span></li>
}

function trendWords(t) {
  if (t.state === 'loading') return 'Loading…'
  if (t.state !== 'ok') return t.state === 'error' ? 'Unavailable' : 'No traffic reported'
  if (t.pct == null) return `${rate(t.now)} queries/s, nothing to compare with yet`
  const dir = t.pct === 0 ? 'level' : `${t.pct > 0 ? 'up' : 'down'} ${Math.abs(t.pct)}%`
  return `${rate(t.now)} queries/s, ${dir} from ${rate(t.was)} ${t.hours} hours ago`
}

function changeWords(c) {
  if (c.state === 'loading') return 'Loading…'
  if (c.state === 'unavailable') return 'Change log unavailable'
  if (c.state === 'empty') return 'No changes logged in 24 hours'
  const people = `${c.people.toLocaleString()} by people`
  const failed = c.failed ? `, ${c.failed.toLocaleString()} failed` : ''
  return `${c.total.toLocaleString()} changes, ${people}${failed}`
}

function licenseWords(l) {
  if (l.state === 'loading') return 'Loading…'
  if (l.state === 'error') return 'License feed unavailable'
  if (l.state === 'empty') return 'No licenses reported'
  const bits = []
  if (l.expired) bits.push(`${l.expired} expired`)
  if (l.soon) bits.push(`${l.soon} due within 90 days`)
  if (l.undated) bits.push(`${l.undated} with no readable date`)
  return bits.length ? bits.join(', ') : `None of ${l.total} due within 90 days`
}

function Briefing({ verdict, problems, services, trend, changes, licenses, updated }) {
  const clock = useClock()
  const hour = clock.getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const newOnes = problems.filter((r) => r.isNew)
  const anyDated = problems.some((r) => typeof r.seen === 'number')
  const provable = canTellNew(problems, clock.getTime() / 1000)
  const checking = verdict.checking > 0
  const fine = services.filter((s) => s.v.sev === 'ok')
  const unchecked = services.filter((s) => s.v.sev === 'none' && s.v.word !== 'Checking')
  const licenseFine = licenses.state === 'ok' && !licenses.expired && !licenses.soon && !licenses.undated
  return (
    <div className="ov-look lk lkc">
      <header className="lkc-rail">
        <p className="lkc-date">{clock.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1>{hello}</h1>
        <p className={`lkc-verdict ${verdict.tone}`}><Mark sev={verdict.tone} /><span data-verdict="">{verdict.word}</span></p>
        <p className="lkc-line">{verdict.line}</p>
        {problems[0] && <a className="lk-primary" href={problems[0].href}>Start with: {problems[0].action}</a>}
        <div className="lkc-updated">{updated}</div>
      </header>
      <div className="lkc-read">
        <section aria-labelledby="lkc-1">
          <h2 id="lkc-1">Since yesterday</h2>
          <ul className="lkc-facts">
            <Fact label="DNS traffic">{trendWords(trend)}</Fact>
            <Fact label={changes.state === 'ok' ? `Changes, ${changes.window.toLowerCase()}` : 'Changes'} tip={changes.tip}>{changeWords(changes)}</Fact>
            <Fact label="New problems" tip="Bloxsmith dates a problem from the first time it saw it, so it needs a full day of history before it can say what is new.">
              {provable
                ? (newOnes.length ? `${newOnes.length} opened in the last 24 hours` : 'None in the last 24 hours')
                : checking ? 'Checking…' : anyDated ? 'Can’t tell yet, no record older than a day' : 'Can’t tell, no dated problems on record'}
            </Fact>
          </ul>
        </section>
        <section aria-labelledby="lkc-2">
          <h2 id="lkc-2">Needs a look <span>{problems.length || ''}</span></h2>
          {problems.length ? (
            <ol className="lkc-list">
              {problems.map((r) => (
                <li key={r.key} className={r.sev} data-problem={r.key}>
                  <Mark sev={r.sev} />
                  <Tip tip={tipFor(r)} className="lkc-title">{r.title}{r.isNew && <em className="lk-new">New</em>}</Tip>
                  <a className="lk-btn" href={r.href} aria-label={`${r.action}: ${r.title}`}>{r.action}</a>
                </li>
              ))}
            </ol>
          ) : <p className="lk-empty">{verdict.tone === 'ok' ? 'Nothing needs a look.' : 'Nothing found yet.'}</p>}
        </section>
        <section aria-labelledby="lkc-3">
          <h2 id="lkc-3">What is fine</h2>
          <ul className="lkc-facts">
            <Fact label="Services">{fine.length ? fine.map((s) => s.name).join(', ') : checking ? 'Checking…' : unchecked.length === services.length ? 'None could be checked' : 'None fully healthy right now'}</Fact>
            <Fact label="Licenses">{licenseFine ? <><Mark sev="ok" /> {licenseWords(licenses)}</> : licenseWords(licenses)}</Fact>
            {unchecked.length > 0 && <Fact label="Not checked">{unchecked.map((s) => s.name).join(', ')}</Fact>}
          </ul>
        </section>
      </div>
    </div>
  )
}

// ---------- the page ----------

export default function OverviewLooks({ look, board, services, dns, health, licenses, updated }) {
  const [since] = useState(() => sinceIso(Date.now()))
  const audit = useApi(`/api/csp-audit?since=${encodeURIComponent(since)}`, { poll: 60000 })
  const nowMs = Date.now()
  const verdict = pageVerdict(services)
  const problems = rankProblems(board, nowMs / 1000)
  const trend = useMemo(() => dnsTrend(dns), [dns])
  const shared = { verdict, problems, services, updated }
  return (
    <div className="w-full px-6 py-5 lk-page">
      {board.feedDown && <p className="lk-down" role="alert"><Mark sev="crit" /> Inventory feed unavailable. Hosts, subnets and leases can't be checked.</p>}
      {look === 'a' && <CommandCenter {...shared} />}
      {look === 'b' && <LiveWall {...shared} trend={trend} health={health} />}
      {look === 'c' && <Briefing {...shared} trend={trend} changes={changeSummary(audit, nowMs)} licenses={licenseSummary(licenses, nowMs)} />}
      <LookSwitcher current={look} />
    </div>
  )
}
