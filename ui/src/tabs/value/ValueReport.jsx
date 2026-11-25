// The Monthly report. It stays hidden on screen and is what the browser prints
// from the Value page (Value.css), so it needs no window or route of its own.
import DayChart from './DayChart.jsx'
import { answerSentence, BLOCKED_COUNTS, missedNote } from './valueModel.js'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

// The failure sentence once per section, as on screen (screen audit A9).
function Missed({ stats }) {
  const note = missedNote(stats)
  return note ? <p className="vl-note">{note}</p> : null
}

function Row({ s }) {
  return (
    <tr data-stat={s.key} data-state={s.state}>
      <th scope="row">{s.label}{s.note && s.state !== 'unavailable' && <small>{s.note}</small>}</th>
      <td className={s.state === 'ok' ? '' : 'vl-word'}>{s.text}</td>
    </tr>
  )
}

export default function ValueReport({ m }) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  return (
    <article className="vl-report" data-value-report="">
      <header>
        <div>
          <h2>Monthly value report</h2>
          {m.account && <p className="vl-account" data-report-account="">{m.account}</p>}
          <p>{m.range ?? 'Last 30 days'}</p>
        </div>
        <p>Prepared {today}</p>
      </header>
      <p className="vl-answer">{answerSentence(m)}</p>
      <div className="vl-report-top">
        <div>
          <p className={m.blocked.state === 'ok' ? 'vl-big' : 'vl-big vl-word'}>{m.blocked.text}</p>
          <p className="vl-hero-label">{m.blocked.label}</p>
          <p className="vl-note">{BLOCKED_COUNTS}</p>
          {m.blocked.note && <p className="vl-note">{m.blocked.note}</p>}
        </div>
        {m.daily.state === 'ok' ? (
          <div>
            <DayChart daily={m.daily} still />
            <p className="vl-note">Blocked per day. Peak: {m.daily.peak.label}, {fmt(m.daily.peak.value)}. The latest day may be incomplete.</p>
            {m.daily.gapNote && <p className="vl-note" data-report-gaps="">{m.daily.gapNote}</p>}
          </div>
        ) : <p className="vl-note">Daily figures are not available.</p>}
      </div>
      <div className="vl-report-cols">
        <section>
          <h3>Security</h3>
          <Missed stats={[m.blocked, m.zero_day, m.sus_to_mal, m.roaming]} />
          <table><tbody><Row s={m.zero_day} /><Row s={m.sus_to_mal} /><Row s={m.roaming} /></tbody></table>
        </section>
        <section>
          <h3>DNS and DHCP</h3>
          <Missed stats={[m.queries, m.cache_hit, m.uptime, m.dhcp_assigned]} />
          <table><tbody><Row s={m.queries} /><Row s={m.cache_hit} /><Row s={m.uptime} /><Row s={m.dhcp_assigned} /></tbody></table>
        </section>
      </div>
      <section>
        <h3>Bloxsmith activity</h3>
        <table><tbody><Row s={m.work} /></tbody></table>
      </section>
      <footer>Source: Infoblox and Bloxsmith records. Figures that could not be read are marked and are not counted as zero.</footer>
    </article>
  )
}
