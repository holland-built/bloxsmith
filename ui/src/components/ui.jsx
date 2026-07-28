import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useThemeColors } from '../lib/theme.jsx'

// Static COLORS as CSS var() strings: fine for inline HTML styles (auto-flip with
// theme), NOT for Recharts SVG props/gradients — chart code uses useChartTheme()
// which resolves real hex per theme.
export const COLORS = {
  accent: 'var(--color-accent)', purple: 'var(--color-purple)', warn: 'var(--color-warn)',
  crit: 'var(--color-crit)', ok: 'var(--color-ok)', other: 'var(--color-other)',
}

export function useChartTheme() {
  const colors = useThemeColors()
  return {
    COLORS: {
      accent: colors.accent,
      purple: colors.purple,
      warn: colors.warn,
      crit: colors.crit,
      ok: colors.ok,
      other: colors.other,
      sevHigh: colors.sevHigh,
    },
    TT: {
      contentStyle: { background: colors.field, border: `1px solid ${colors.border}`, borderRadius: 8, fontSize: 12 },
      labelStyle: { color: colors.muted },
      itemStyle: { color: colors.txt },
    },
  }
}



// ---------- shared bits ----------

export function CardGrid({ className = '', children }) {
  return (
    <div className={`grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 ${className}`}>
      {children}
    </div>
  )
}

const SPAN_CLASS = {
  1: 'col-span-1',
  2: 'col-span-2 md:col-span-2 xl:col-span-2',
  3: 'col-span-2 md:col-span-2 xl:col-span-3',
  4: 'col-span-2 md:col-span-4 xl:col-span-4',
  5: 'col-span-2 md:col-span-4 xl:col-span-5',
  6: 'col-span-2 md:col-span-4 xl:col-span-6',
}

export function Card({ title, note, right, span = 2, className = '', children }) {
  const spanClass = SPAN_CLASS[span] || SPAN_CLASS[6]
  return (
    <div
      className={`bg-card border border-card-border rounded-card p-[18px] ${spanClass} ${className}`}
    >
      {title && (
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          {note && <span className="text-[11px] text-dim">{note}</span>}
          <span className="flex-1" />
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

// One-line "what this tab does" line under a tab title, with a link to the
// matching section of docs/TABS.md. Always-visible text rather than a hover
// tooltip: the nav collapses tabs into a ⋯ menu at narrow widths and hover
// does not exist on touch, so a tooltip is the one place this can't be read.
const DOCS_URL = 'https://github.com/holland-built/bloxsmith/blob/master/docs/TABS.md'

export function TabIntro({ anchor, children }) {
  return (
    <p className="text-xs text-muted mb-3 max-w-[80ch]">
      {children}{' '}
      <a
        href={anchor ? `${DOCS_URL}#${anchor}` : DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2 whitespace-nowrap"
      >
        Docs →
      </a>
    </p>
  )
}

// ---------- write flow ----------
//
// One Preview -> Apply flow for every surface that writes to Infoblox
// (Provision, Self-Service, Editor). Before this, each tab had its own model:
// Editor previewed then revealed Apply, Provision made you untick a checkbox
// and re-run, and Self-Service's two cards used one label ("Dry Run") for two
// different behaviours — one called the server, one only echoed the typed
// values back in a success-styled box.
//
// The rules this encodes:
//   - Preview always runs server-side. A preview that never left the browser
//     validates nothing but still reads as confirmation.
//   - Apply is only reachable from a fresh preview, so what you apply is what
//     you reviewed.
//   - Editing an input after previewing marks the preview stale and hides
//     Apply. Silently applying against changed inputs is the failure mode the
//     whole flow exists to prevent.
//
// This owns the button state machine and the framing only — each tab keeps its
// own fetch/stream logic and renders its own preview body as children, because
// Provision streams SSE while the others are request/response.

const PA_BTN = 'px-3.5 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed'

export function PreviewApply({
  status = 'idle', // 'idle' | 'busy' | 'previewed' | 'applied'
  stale = false,
  disabled = false,
  applyDisabled = false, // extra gate on Apply only (admin role, typed confirm)
  applyNote,
  onPreview,
  onApply,
  previewLabel = 'Preview',
  applyLabel = 'Apply',
  busyLabel = 'Working…',
  destructive = false,
  error,
  message,
  children,
}) {
  const busy = status === 'busy'
  const showApply = status === 'previewed' && !stale && !busy

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={busy || disabled}
          className={PA_BTN}
          style={{ background: COLORS.accent, color: '#fff' }}
        >
          {busy ? busyLabel : previewLabel}
        </button>
        {showApply && (
          <button
            type="button"
            onClick={onApply}
            disabled={applyDisabled}
            className={PA_BTN}
            style={{ background: destructive ? COLORS.crit : COLORS.ok, color: '#fff' }}
          >
            {applyLabel}
          </button>
        )}
        {showApply && applyDisabled && applyNote && (
          <span className="text-[11px]" style={{ color: COLORS.warn }}>{applyNote}</span>
        )}
        {status === 'previewed' && stale && (
          <span className="text-[11px]" style={{ color: COLORS.warn }}>
            inputs changed — preview again
          </span>
        )}
      </div>

      {error && (
        <div
          className="text-sm rounded-lg px-3 py-2"
          style={{ background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)', border: `1px solid ${COLORS.crit}` }}
        >
          {error}
        </div>
      )}
      {/* A stale preview's message ("review it, then apply") is no longer true —
          the warning above replaces it rather than sitting next to it. */}
      {!error && message && !stale && (
        <div
          className="text-sm rounded-lg px-3 py-2"
          style={{ background: 'var(--pill-ok-bg)', color: 'var(--pill-ok-fg)', border: `1px solid ${COLORS.ok}` }}
        >
          {message}
        </div>
      )}

      {/* Dimmed when stale: the body below still shows the OLD payload, and it
          must not read as describing the current inputs. */}
      <div className={stale ? 'opacity-40' : undefined}>{children}</div>
    </div>
  )
}

// Renders a previewed payload. Never styled as success — a preview is a
// statement of intent, not a result, and green reads as "it worked".
export function PreviewBox({ data, note = 'preview — nothing applied yet' }) {
  if (data == null) return null
  return (
    <div className="rounded-lg border border-border bg-field p-3">
      <div className="text-[11px] text-dim mb-1.5">{note}</div>
      <pre className="text-xs whitespace-pre-wrap max-h-[320px] overflow-auto text-muted">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}

export function Empty({ children = 'no data' }) {
  return <div className="h-full min-h-[100px] flex items-center justify-center text-muted text-sm">{children}</div>
}

export function Skeleton({ h = 140 }) {
  return <div className="animate-pulse bg-line rounded-lg w-full" style={{ height: h }} />
}

export function Sparkline({ values, color, h = 30 }) {
  if (!values || values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100
      const y = h - ((v - min) / range) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" points={pts} />
    </svg>
  )
}

export function utilStatus(util) {
  if (util >= 92) return { label: 'Critical', color: 'var(--color-crit)', bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)' }
  if (util >= 75) return { label: 'Warning', color: 'var(--color-warn)', bg: 'var(--pill-warn-bg)', fg: 'var(--pill-warn-fg)' }
  return { label: 'Healthy', color: 'var(--color-accent)', bg: 'var(--pill-ok-bg)', fg: 'var(--pill-ok-fg)' }
}

