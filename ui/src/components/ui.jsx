import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

export const COLORS = { accent: '#0070f3', purple: '#8b5cf6', warn: '#f5a623', crit: '#ee4444', ok: '#4ade80', other: '#8a8a8a' }

export const TT = {
  contentStyle: { background: '#141414', border: '1px solid #2a2a2a', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#8a8a8a' },
  itemStyle: { color: '#ededed' },
}



// ---------- shared bits ----------

export function Card({ title, note, right, span = 2, className = '', children }) {
  return (
    <div
      className={`bg-card border border-card-border rounded-card p-[18px] ${className}`}
      style={{ gridColumn: `span ${span} / span ${span}` }}
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
  if (util >= 92) return { label: 'Critical', color: COLORS.crit, bg: '#2a1215', fg: '#ff7b7b' }
  if (util >= 75) return { label: 'Warning', color: COLORS.warn, bg: '#2a2210', fg: '#f5c76b' }
  return { label: 'Healthy', color: COLORS.accent, bg: '#0d2136', fg: '#6bb2ff' }
}

