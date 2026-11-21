// Three preview looks for the Value page, opened with ?variant=a, b or c. All
// three read the same model (looksData.js) and only read.
import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../../lib/api.js'
import { Skeleton } from '../../components/ui.jsx'
import DayChart from './DayChart.jsx'
import { answerSentence, buildModel, NO_EARLIER } from './looksData.js'
import './ValueLooks.css'

const LOOKS = [['a', 'Scoreboard'], ['b', '30-day story'], ['c', 'Report']]
const fmt = (n) => Math.round(n).toLocaleString('en-US')

/** The look named in the address (#value?variant=a or ?variant=a#value), or null. */
export function readVariant() {
  const inHash = location.hash.split('?')[1] ?? ''
  const v = new URLSearchParams(inHash).get('variant') ?? new URLSearchParams(location.search).get('variant')
  return LOOKS.some(([id]) => id === v) ? v : null
}

export function useVariant() {
  const [variant, setVariant] = useState(readVariant)
  useEffect(() => {
    const onChange = () => setVariant(readVariant())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return variant
}

function Switcher({ variant }) {
  return (
    <nav className="vl-switch" aria-label="Preview looks">
      <span>Preview</span>
      {LOOKS.map(([id, label]) => (
        <a key={id} href={`#value?variant=${id}`} aria-current={variant === id ? 'page' : undefined}>{label}</a>
      ))}
      <a href="#value">Current</a>
    </nav>
  )
}

function Stat({ s, compare = false }) {
  const ok = s.state === 'ok'
  return (
    <div className="vl-stat" data-stat={s.key} data-state={s.state}>
      <dt>{s.label}</dt>
      <dd className={ok ? 'vl-num' : 'vl-num vl-word'}>{s.text}</dd>
      {s.note && <dd className="vl-note">{s.note}</dd>}
      {compare && ok && s.key !== 'blocked' && <dd className="vl-note">{NO_EARLIER}</dd>}
    </div>
  )
}

function ChartMissing({ daily }) {
  const words = {
    loading: 'Loading the 30 days…',
    error: "The day-by-day numbers weren't checked. This page tries again every 5 minutes.",
    empty: 'Infoblox has no day-by-day numbers for these 30 days.',
  }
  return <p className="vl-chart-note" data-state={daily.state}>{words[daily.state]}</p>
}

function Scoreboard({ m }) {
  return (
    <div className="vl-look vl-a">
      <section className="vl-hero">
        <div>
          <p className="vl-question">What you got in the last 30 days</p>
          <p className={m.blocked.state === 'ok' ? 'vl-huge' : 'vl-huge vl-word'} data-stat="blocked">{m.blocked.text}</p>
          <p className="vl-hero-label">{m.blocked.label}</p>
          <p className="vl-note">{m.blocked.note}</p>
        </div>
        {m.daily.state === 'ok' && (
          <div className="vl-hero-spark">
            <DayChart daily={m.daily} compact />
            <p className="vl-note">Busiest day {m.daily.peak.label}: {fmt(m.daily.peak.value)}</p>
          </div>
        )}
      </section>
      <dl className="vl-strip">{m.supporting.map((s) => <Stat key={s.key} s={s} compare />)}</dl>
    </div>
  )
}

function Story({ m }) {
  const d = m.daily
  const tied = [m.zero_day, m.sus_to_mal, m.queries, m.cache_hit, m.roaming, m.uptime, m.dhcp_assigned, m.work]
  return (
    <div className="vl-look vl-b">
      <section className="vl-story">
        <header>
          <p className={m.blocked.state === 'ok' ? 'vl-big' : 'vl-big vl-word'} data-stat="blocked">{m.blocked.text}</p>
          <p className="vl-hero-label">{m.blocked.label}{m.range ? `, ${m.range}` : ''}</p>
          <p className="vl-note">{m.blocked.note}</p>
        </header>
        {d.state === 'ok' ? <DayChart daily={d} /> : <ChartMissing daily={d} />}
        {d.state === 'ok' && (
          <dl className="vl-daystats">
            <div><dt>Busiest day</dt><dd className="vl-num">{fmt(d.peak.value)}</dd><dd className="vl-note">{d.peak.label}{d.timesAverage ? `, ${d.timesAverage.toFixed(1)} times the average` : ''}</dd></div>
            <div><dt>Average day</dt><dd className="vl-num">{fmt(d.average)}</dd><dd className="vl-note">Across {d.days.length - d.missing} days with data</dd></div>
            <div><dt>Quietest day</dt><dd className="vl-num">{fmt(d.low.value)}</dd><dd className="vl-note">{d.low.label}</dd></div>
          </dl>
        )}
      </section>
      <h2 className="vl-h2">Same 30 days</h2>
      <dl className="vl-strip">{tied.map((s) => <Stat key={s.key} s={s} />)}</dl>
    </div>
  )
}

function ReportRow({ s }) {
  return (
    <tr data-stat={s.key} data-state={s.state}>
      <th scope="row">{s.label}{s.note && <small>{s.note}</small>}</th>
      <td className={s.state === 'ok' ? '' : 'vl-word'}>{s.text}</td>
    </tr>
  )
}

function Report({ m }) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  return (
    <div className="vl-look vl-c">
      <div className="vl-report-bar">
        <button type="button" onClick={() => window.print()}>Print or Save as PDF</button>
      </div>
      <article className="vl-report">
        <header>
          <div>
            <h2>Monthly value report</h2>
            <p>{m.range ?? 'Last 30 days'}</p>
          </div>
          <p>Prepared {today}</p>
        </header>
        <p className="vl-answer">{answerSentence(m)}</p>
        <div className="vl-report-top">
          <div>
            <p className={m.blocked.state === 'ok' ? 'vl-big' : 'vl-big vl-word'} data-stat="blocked">{m.blocked.text}</p>
            <p className="vl-hero-label">{m.blocked.label}</p>
            <p className="vl-note">{m.blocked.note}</p>
          </div>
          {m.daily.state === 'ok' ? (
            <div className="vl-hero-spark">
              <DayChart daily={m.daily} compact />
              <p className="vl-note">Blocked per day. Busiest {m.daily.peak.label}: {fmt(m.daily.peak.value)}</p>
            </div>
          ) : <ChartMissing daily={m.daily} />}
        </div>
        <div className="vl-report-cols">
          <section>
            <h3>Security</h3>
            <table><tbody><ReportRow s={m.zero_day} /><ReportRow s={m.sus_to_mal} /><ReportRow s={m.roaming} /></tbody></table>
          </section>
          <section>
            <h3>DNS and DHCP</h3>
            <table><tbody><ReportRow s={m.queries} /><ReportRow s={m.cache_hit} /><ReportRow s={m.uptime} /><ReportRow s={m.dhcp_assigned} /></tbody></table>
          </section>
        </div>
        <section>
          <h3>Work in Bloxsmith</h3>
          <table><tbody><ReportRow s={m.work} /></tbody></table>
        </section>
        <footer>From Infoblox and Bloxsmith records. Numbers that could not be read are marked, never counted as zero.</footer>
      </article>
    </div>
  )
}

export default function ValueLooks({ variant }) {
  const security = useApi('/api/csp/value-security', { poll: 300000 })
  const platform = useApi('/api/csp/value-platform', { poll: 300000 })
  const daily = useApi('/api/csp/value-daily', { poll: 300000 })
  const runs = useApi('/api/desk/runs')
  const m = useMemo(
    () => buildModel({ security, platform, runs, daily }),
    [security, platform, runs, daily],
  )
  const first = security.loading && !security.data
  return (
    <div className="vl-page" data-look={variant}>
      <header className="vl-head">
        <h1>Value</h1>
        {variant !== 'c' && <p>{m.range ?? 'Last 30 days'}</p>}
      </header>
      {first ? <Skeleton h={320} /> : variant === 'a' ? <Scoreboard m={m} /> : variant === 'b' ? <Story m={m} /> : <Report m={m} />}
      <Switcher variant={variant} />
    </div>
  )
}
