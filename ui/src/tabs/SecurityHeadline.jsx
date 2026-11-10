import { useId } from 'react'
import { securityHeadline } from '../lib/securityHeadline.js'
import './Overview.css'
import './Security.css'

// The row of headline numbers at the top of Security, in the look Overview
// uses (the dashboard-design skill the owner picked on 2026-11-09): one card,
// tiles divided by hairlines, a number with a short label, and the
// explanation in the tile's tip.
//
// Each tile jumps to the panel its number comes from.

function jump(panelId) {
  const el = document.querySelector(`[data-panel-id="${panelId}"]`)
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

const STATE_WORD = { loading: 'Loading…', failed: 'Unknown', notSetUp: 'Not set up' }

// Same tile as Overview's: the explanation is the tile's title and its
// accessible description, so a screen reader hears the label first.
function Tile({ t }) {
  const id = useId()
  const shown = t.value === null ? STATE_WORD[t.state] ?? '—' : t.value.toLocaleString()
  const tip = t.value === null ? (t.state === 'failed' ? 'Not reported by the feed, so this is not known' : t.state === 'notSetUp' ? 'Add an Axur key under Settings' : '') : t.tip
  // The tip sits beside the button, not inside it, so the button's name is
  // only its label and number; the tip is its description.
  return (
    <>
      <button
        type="button"
        className="ov-kpi sec-kpi"
        data-tone={t.tone || undefined}
        data-key={t.key}
        title={tip || undefined}
        aria-describedby={tip ? id : undefined}
        onClick={() => jump(t.panelId)}
      >
        <span className="ov-kpi-in">
          <span className="ov-kpi-top">
            <span>{t.label}</span>
            {t.right && <span className="ov-muted ov-small">{t.right}</span>}
          </span>
          <span className={`ov-num sec-num${t.value === null ? ' sec-none' : ''}`}>
            {shown}
            {t.value !== null && t.unit ? <small> {t.unit}</small> : null}
          </span>
        </span>
      </button>
      {tip && <span id={id} className="sr-only">{tip}</span>}
    </>
  )
}

export function SecurityHeadline(feeds) {
  const tiles = securityHeadline(feeds)
  return (
    <section className="ov-card ov-kpis sec-kpis" aria-label="Headline numbers">
      {tiles.map((t) => <Tile key={t.key} t={t} />)}
    </section>
  )
}
