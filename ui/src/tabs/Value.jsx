// Value: what Infoblox and Bloxsmith gave this customer in the last 30 days,
// on one screen for a manager, with a one-page report to print. It only reads.
import { useMemo } from 'react'
import { useApi } from '../lib/api.js'
import { CardGrid, TabIntro } from '../components/ui.jsx'
import ValueSecurity from './value/ValueSecurity.jsx'
import ValuePlatform from './value/ValuePlatform.jsx'
import ValueWork from './value/ValueWork.jsx'
import ValueReport from './value/ValueReport.jsx'
import { buildModel } from './value/valueModel.js'
import './value/Value.css'

export default function Value() {
  // Thirty-day totals move slowly; once every five minutes is plenty.
  const security = useApi('/api/csp/value-security', { poll: 300000 })
  const platform = useApi('/api/csp/value-platform', { poll: 300000 })
  const daily = useApi('/api/csp/value-daily', { poll: 300000 })
  const runs = useApi('/api/desk/runs')
  const vault = useApi('/api/vault/status')
  const m = useMemo(() => buildModel({ security, platform, runs, daily, vault }), [security, platform, runs, daily, vault])
  const securityLoading = security.loading && !security.data
  const platformLoading = platform.loading && !platform.data
  const stillLoading = [security, platform, daily, runs, vault].some((f) => f.loading && !f.data)
  return (
    <div className="vl-page">
      <header className="vl-head">
        <div>
          <h1 className="text-copy font-semibold tracking-tight mb-1">Value</h1>
          <TabIntro>Results from Infoblox and Bloxsmith over the last 30 days. This page is read-only.</TabIntro>
          {m.range && <p className="vl-range">{m.range}</p>}
        </div>
        <button type="button" className="vl-print" disabled={stillLoading} onClick={() => window.print()}>Print report</button>
      </header>
      <CardGrid layoutKey="value">
        <ValueSecurity key="value-security" panelId="value-security" m={m} loading={securityLoading} />
        <ValuePlatform key="value-platform" panelId="value-platform" m={m} loading={platformLoading} />
        <ValueWork key="value-work" panelId="value-work" runs={runs} />
      </CardGrid>
      <ValueReport m={m} />
    </div>
  )
}
