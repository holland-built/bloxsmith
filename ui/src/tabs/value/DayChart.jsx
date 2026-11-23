// Lookups blocked on each of the 30 days. On screen it can be read by pointer,
// tap or arrow keys; `still` is the plain picture the printed report uses.
import { useState } from 'react'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

function barClass(d, i, daily, active) {
  const c = ['vl-bar']
  if (d.value == null) c.push('is-missing')
  else if (i === daily.days.length - 1) c.push('is-latest')
  if (i === daily.peakIndex) c.push('is-peak')
  if (active) c.push('is-active')
  return c.join(' ')
}

function dayWords(d, i, daily) {
  if (d.value == null) return `${d.label}: no reading`
  const latest = i === daily.days.length - 1 ? ', may be incomplete' : ''
  return `${d.label}: ${fmt(d.value)} blocked${latest}`
}

export default function DayChart({ daily, still = false }) {
  const [picked, setPicked] = useState(null)
  const last = daily.days.length - 1
  const top = daily.peak.value
  const height = (d) => {
    if (d.value == null) return '100%'
    return top > 0 ? `${Math.max(d.value > 0 ? 1.5 : 0, (d.value / top) * 100)}%` : '0%'
  }

  if (still) {
    return (
      <div className="vl-spark" aria-hidden="true">
        {daily.days.map((d, i) => <span key={d.day} className={barClass(d, i, daily, false)} style={{ '--h': height(d) }} />)}
      </div>
    )
  }

  const index = picked ?? daily.peakIndex
  const words = dayWords(daily.days[index], index, daily)
  const pickAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    setPicked(Math.min(last, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * daily.days.length))))
  }
  const onKey = (e) => {
    const to = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: last }[e.key]
    if (e.key === 'Escape') setPicked(null)
    if (to === undefined) return
    e.preventDefault()
    setPicked(Math.min(last, Math.max(0, to)))
  }

  return (
    <figure className="vl-chart">
      <p className="vl-readout" data-chart-readout="">
        {index === daily.peakIndex && <strong>Peak day. </strong>}{words}
      </p>
      <div
        className="vl-spark is-live"
        role="slider"
        tabIndex={0}
        aria-label="DNS lookups blocked each day. Use the arrow keys to select a day."
        aria-valuemin={1}
        aria-valuemax={daily.days.length}
        aria-valuenow={index + 1}
        aria-valuetext={`${words}${index === daily.peakIndex ? ', peak day' : ''}`}
        onKeyDown={onKey}
        onPointerDown={pickAt}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons) pickAt(e) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setPicked(null) }}
      >
        {daily.days.map((d, i) => <span key={d.day} className={barClass(d, i, daily, i === index)} style={{ '--h': height(d), '--i': i }} />)}
      </div>
      <div className="vl-axis" aria-hidden="true"><span>{daily.days[0].label}</span><span>{daily.days[last].label}</span></div>
      <figcaption className="vl-legend">
        <span><i className="vl-key" />Latest day may be incomplete</span>
        {daily.missing > 0 && <span><i className="vl-key is-missing" />No data for {daily.missing} {daily.missing === 1 ? 'day' : 'days'}</span>}
      </figcaption>
    </figure>
  )
}
