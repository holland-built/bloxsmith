// Lookups blocked on each of the 30 days. The full chart can be read by
// pointer, tap or arrow keys; compact is a small picture with no controls.
import { useState } from 'react'

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const short = (n) => (n >= 1000 ? `${n / 1000}k` : String(n))

/** Round axis ticks from 0 up to at least v, five at most. */
export function niceTicks(v) {
  if (!(v > 0)) return [0, 1]
  const pow = 10 ** Math.floor(Math.log10(v))
  const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => Math.ceil(v / s) <= 4)
  return Array.from({ length: Math.ceil(v / step) + 1 }, (_, i) => i * step)
}

function barClass(d, i, daily, active) {
  const c = ['vl-bar']
  if (d.value == null) c.push('is-missing')
  else if (i === daily.days.length - 1) c.push('is-latest')
  if (i === daily.peakIndex) c.push('is-peak')
  if (active) c.push('is-active')
  return c.join(' ')
}

export default function DayChart({ daily, compact = false }) {
  const [picked, setPicked] = useState(null)
  const ticks = niceTicks(daily.peak.value)
  const top = ticks.at(-1)
  const height = (d) => (d.value == null ? '100%' : `${Math.max(d.value > 0 ? 1.5 : 0, (d.value / top) * 100)}%`)

  if (compact) {
    return (
      <div className="vl-spark" aria-hidden="true">
        {daily.days.map((d, i) => <span key={d.day} className={barClass(d, i, daily, false)} style={{ '--h': height(d) }} />)}
      </div>
    )
  }

  const index = picked ?? daily.peakIndex
  const day = daily.days[index]
  const edge = index < 6 ? 'start' : index > daily.days.length - 7 ? 'end' : 'middle'
  const isLatest = index === daily.days.length - 1
  const words = day.value == null ? 'no data' : `${fmt(day.value)} blocked`
  const onKey = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (e.key === 'Escape') setPicked(null)
    if (!step) return
    e.preventDefault()
    const next = Math.min(daily.days.length - 1, Math.max(0, index + step))
    setPicked(next)
    e.currentTarget.querySelectorAll('button')[next]?.focus()
  }
  const labelled = daily.days.map((d, i) => ({ d, i })).filter(({ i }) => i % 7 === 0 && i < daily.days.length - 3)
  labelled.push({ d: daily.days.at(-1), i: daily.days.length - 1 })

  return (
    <figure className="vl-chart">
      <div className="vl-plot">
        <div className="vl-grid" aria-hidden="true">
          {ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}><b>{short(t)}</b></span>)}
        </div>
        <div className="vl-callout" data-edge={edge} style={{ '--x': `${((index + 0.5) / daily.days.length) * 100}%` }} aria-live="polite">
          {index === daily.peakIndex && <strong>Busiest day</strong>}
          <span>{day.label}: {words}{isLatest && day.value != null ? ', may still be adding up' : ''}</span>
        </div>
        <div className="vl-bars" role="group" aria-label="Lookups blocked each day. Use the left and right arrow keys to read a day." onKeyDown={onKey} onPointerLeave={() => setPicked(null)}>
          {daily.days.map((d, i) => (
            <button
              key={d.day}
              type="button"
              tabIndex={i === index ? 0 : -1}
              aria-pressed={i === index}
              aria-label={`${d.label}: ${d.value == null ? 'no data' : `${fmt(d.value)} blocked`}${i === daily.peakIndex ? ', busiest day' : ''}`}
              className={barClass(d, i, daily, i === index)}
              style={{ '--h': height(d), '--i': i }}
              onPointerEnter={() => setPicked(i)}
              onFocus={() => setPicked(i)}
              onClick={() => setPicked(i)}
            ><span /></button>
          ))}
        </div>
      </div>
      <div className="vl-axis" aria-hidden="true">
        {labelled.map(({ d, i }) => <span key={d.day} style={{ left: `${((i + 0.5) / daily.days.length) * 100}%` }} data-last={i === daily.days.length - 1 || undefined}>{d.label}</span>)}
      </div>
      <figcaption className="vl-legend">
        <span><i className="vl-key is-latest" />Latest day may still be adding up</span>
        {daily.missing > 0 && <span><i className="vl-key is-missing" />No data for {daily.missing} {daily.missing === 1 ? 'day' : 'days'}</span>}
      </figcaption>
    </figure>
  )
}
