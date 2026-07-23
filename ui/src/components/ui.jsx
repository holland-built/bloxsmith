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

// Static tooltip style via vars — flips with theme without re-render.
export const TT = {
  contentStyle: { background: 'var(--color-field)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: 'var(--color-muted)' },
  itemStyle: { color: 'var(--color-txt)' },
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

