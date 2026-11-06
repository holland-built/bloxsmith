import { Card, CardGrid, COLORS, FetchError, Skeleton, TabIntro } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'

// Design rules checked against the tenant, worked out on the server
// (go/internal/dashboard/best_practices.go). Read-only. A check whose data
// can't prove the answer says so, and is never shown as passed.

const SEVERITY = {
  high: { label: 'High', color: COLORS.crit },
  medium: { label: 'Medium', color: COLORS.warn },
  low: { label: 'Low', color: 'var(--color-txt)' },
}
const RANK = { high: 0, medium: 1, low: 2 }
const SHOW = 50

function order(checks) {
  const group = (c) => (c.status === 'problem' ? 0 : c.status === 'unknown' ? 1 : 2)
  return [...checks].sort((a, b) => group(a) - group(b) || (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3))
}

function Problem({ c }) {
  const sev = SEVERITY[c.severity] || SEVERITY.low
  const shown = c.items.slice(0, SHOW)
  return (
    <li className="py-3 border-b border-line last:border-b-0">
      <details>
        <summary className="cursor-pointer">
          <span className="font-semibold" style={{ color: sev.color }}>{sev.label}</span>
          <span className="ml-3 text-txt">{c.title}</span>
        </summary>
        <div className="mt-2 pl-1 text-copy">
          <p className="text-muted">{c.why}</p>
          {c.note ? <p className="text-muted mt-1">{c.note}</p> : null}
          <ul aria-label={c.title} className="mt-2 max-w-[640px]">
            {shown.map((it, i) => (
              <li key={i} className="flex justify-between gap-6 py-1 border-b border-line last:border-b-0">
                <span className="text-txt break-all">{it.name || '(no name)'}</span>
                <span className="text-muted shrink-0">{it.detail}</span>
              </li>
            ))}
          </ul>
          {c.items.length > SHOW ? <p className="text-note text-muted mt-1">And {c.items.length - SHOW} more.</p> : null}
          {c.link ? <a className="inline-block mt-2 underline underline-offset-2 text-txt" href={c.link}>Open Infra</a> : null}
        </div>
      </details>
    </li>
  )
}

function Other({ c }) {
  const passed = c.status === 'passed'
  return (
    <li className="py-3 border-b border-line last:border-b-0">
      <span className="font-semibold" style={{ color: passed ? COLORS.ok : 'var(--color-muted)' }}>
        {passed ? 'Passed' : "Couldn't tell"}
      </span>
      <span className="ml-3 text-txt">{c.title}</span>
      {!passed && c.reason ? <p className="text-copy text-muted mt-1">{c.reason}</p> : null}
      {passed && c.note ? <p className="text-copy text-muted mt-1">{c.note}</p> : null}
    </li>
  )
}

export default function BestPractices() {
  const api = useApi('/api/best-practices')
  const checks = api.data?.checks ? order(api.data.checks) : null
  const problems = checks ? checks.filter((c) => c.status === 'problem').length : 0
  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-1">Best practices</h1>
      <TabIntro>Checks your Infoblox design against best practices and lists what to fix. It changes nothing.</TabIntro>
      <CardGrid layoutKey="best-practices">
        <Card
          key="bp-checks"
          panelId="bp-checks"
          span={6}
          title="Checks"
          note={checks ? (problems ? `${problems} of ${checks.length} need attention` : `${checks.length} checked`) : undefined}
        >
          <FetchError error={api.error} stale={!!checks} />
          {!checks && api.loading ? <Skeleton h={160} /> : null}
          {checks ? (
            <ul aria-label="Best practice checks" className="text-copy">
              {checks.map((c) => (c.status === 'problem' ? <Problem key={c.id} c={c} /> : <Other key={c.id} c={c} />))}
            </ul>
          ) : null}
        </Card>
      </CardGrid>
    </div>
  )
}
