// Shared pieces for the Kentik-inspired layout: status pills, a headline
// number strip, a red/amber/ok share bar, a
// summary card that links to another tab, and the breadcrumb bar.
//
// Colours come only from tokens in index.css, so both themes and the contrast
// tests cover them. Red means critical, amber means warning, and the accent
// blue means healthy, the same meaning the charts already use.
import { FOCUS_RING } from './ui.jsx'

const TONE = {
  crit: { bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)', dot: 'var(--color-crit)' },
  warn: { bg: 'var(--pill-warn-bg)', fg: 'var(--pill-warn-fg)', dot: 'var(--color-warn)' },
  ok: { bg: 'var(--pill-ok-bg)', fg: 'var(--pill-ok-fg)', dot: 'var(--color-accent)' },
  neutral: { bg: 'var(--pill-neutral-bg)', fg: 'var(--pill-neutral-fg)', dot: 'var(--color-other)' },
}

export function StatusPill({ tone = 'neutral', children }) {
  const t = TONE[tone] || TONE.neutral
  return (
    <span className="inline-block rounded-mark px-2 py-0.5 text-note font-semibold whitespace-nowrap" style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  )
}

// The headline numbers across the top of a page. Each one is a button that
// jumps to the panel about it (scrolls it into view and moves focus there), so
// the numbers lead and the detail stays one click away. A value that is null
// was not measured and shows a dash, never a zero.
export function HeadlineStrip({ items, label }) {
  const jump = (panelId) => {
    const el = document.querySelector(`[data-panel-id="${panelId}"]`)
    // A panel taken off the page has no element. Send focus to Arrange panels,
    // where it can be put back, rather than doing nothing.
    if (!el) {
      const arrange = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Arrange panels')
      arrange?.focus()
      return
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  }
  return (
    <ul aria-label={label} className="flex flex-wrap rounded-surface bg-card border border-card-border mb-3">
      {items.map((it) => (
        <li key={it.label} className="border-r border-line last:border-r-0">
          <button type="button" onClick={() => jump(it.panelId)} className={`text-left px-4 py-2.5 hover:bg-line ${FOCUS_RING}`}>
            <span className="flex items-center gap-1.5 text-note text-muted">
              <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: it.color }} />
              {it.label}
            </span>
            <span className="text-figure font-semibold tabular-nums text-txt">
              {it.value == null ? '—' : it.value}
              {it.unit ? <span className="text-note font-normal text-muted"> {it.unit}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// Shares of one whole as a single bar: critical, warning, healthy, other.
// The label says what is being counted so the bar is never read as address
// use. If any share is unknown (null) the bar is not drawn at all: a bar of
// zeros would claim "none" about a count nobody measured.
export function SegmentedBar({ crit, warn, ok, other = 0, label }) {
  if ([crit, warn, ok, other].some((n) => n == null)) {
    return <p className="text-note text-dim">{label}: breakdown unavailable</p>
  }
  const total = crit + warn + ok + other
  const pct = (n) => (total ? (n / total) * 100 : 0)
  return (
    <div role="img" aria-label={`${label}: ${crit} critical, ${warn} warning, ${ok} healthy${other ? `, ${other} other` : ''}`} className="flex h-2 rounded-full overflow-hidden bg-line">
      <span style={{ width: `${pct(crit)}%`, background: 'var(--color-crit)' }} />
      <span style={{ width: `${pct(warn)}%`, background: 'var(--color-warn)' }} />
      <span style={{ width: `${pct(ok)}%`, background: 'var(--color-accent)' }} />
      <span style={{ width: `${pct(other)}%`, background: 'var(--color-other)' }} />
    </div>
  )
}

// A summary of another tab: a title, up to three counts, and a link to go
// there. `unavailable` replaces the counts rather than showing zeros.
export function ModuleCard({ title, counts = [], href, linkLabel, unavailable, children }) {
  return (
    <section className="rounded-surface bg-card border border-card-border p-4" aria-label={title}>
      <h2 className="text-copy font-semibold mb-2">{title}</h2>
      {unavailable ? (
        <p className="text-note text-dim mb-3">{unavailable}</p>
      ) : (
        <dl className="flex gap-5 mb-3">
          {counts.map((c) => (
            <div key={c.label}>
              <dt className="text-note text-muted">{c.label}</dt>
              <dd className="text-figure font-semibold tabular-nums" style={{ color: TONE[c.tone] && c.tone !== 'neutral' ? TONE[c.tone].dot : undefined }}>
                {c.value == null ? '—' : c.value.toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {children}
      {href && (
        <a href={href} className={`inline-flex items-center gap-1 mt-2 px-2.5 py-1 rounded-control border border-border text-copy text-txt no-underline hover:border-border-hover ${FOCUS_RING}`}>
          {linkLabel} <span aria-hidden="true">›</span>
        </a>
      )}
    </section>
  )
}

// The bar under the top bar: where you are, and this page's actions.
export function PageBar({ group, page, children }) {
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-2 border-b border-line bg-card">
      <nav aria-label="Breadcrumb" className="text-copy">
        <ol className="flex items-center gap-2">
          <li className="text-muted">{group}</li>
          <li aria-hidden="true" className="text-dim">›</li>
          <li aria-current="page" className="font-semibold">{page}</li>
        </ol>
      </nav>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}
