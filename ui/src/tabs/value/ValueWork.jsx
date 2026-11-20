// "Work done in Bloxsmith — 30 days": jobs Bloxsmith finished on this tenant,
// the objects they made, and a time-saved estimate. Counted in
// lib/valueWork.js from the runs record the Made with Bloxsmith page lists.
import { useApi } from '../../lib/api.js'
import { Card, FetchError, Skeleton } from '../../components/ui.jsx'
import { countWork, MINUTES_PER_JOB } from '../../lib/valueWork.js'

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export default function ValueWork({ panelId }) {
  const api = useApi('/api/desk/runs')
  const w = api.error ? null : countWork(api.data)
  return (
    <Card panelId={panelId} title="Work done in Bloxsmith — 30 days" span={6}>
      <div className="px-3 pb-3" data-value-work="">
        <FetchError error={api.error} />
        {!w && api.loading && !api.error ? <Skeleton h={100} /> : null}
        {!w && !api.loading ? <p className="text-copy text-muted" data-value-work-state="not-checked">Jobs done: not checked. The list of changes Bloxsmith made could not be read.</p> : null}
        {w ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-copy">
              <dt className="text-muted">Jobs done</dt><dd data-value-jobs="" className="font-semibold">{w.jobs.toLocaleString()}</dd>
              <dt className="text-muted">Items made in Infoblox</dt><dd data-value-objects="" className="font-semibold">{w.objects.toLocaleString()}</dd>
              <dt className="text-muted">Time saved</dt><dd data-value-hours="" className="font-semibold">{plural(w.hours, 'hour', 'hours')}</dd>
            </dl>
            <p className="text-note text-muted mt-2">Estimate: {MINUTES_PER_JOB} minutes for each job done by hand in the Infoblox Portal.</p>
            {w.bySource.length > 0 ? (
              <ul aria-label="Jobs by page" className="mt-3 text-note">
                {w.bySource.map(([label, jobs, objects]) => (
                  <li key={label} className="py-1 border-t border-border">
                    {label}: {plural(jobs, 'job', 'jobs')}, {plural(objects, 'item', 'items')} made
                  </li>
                ))}
              </ul>
            ) : <p className="text-note text-muted mt-3">No jobs done in Bloxsmith on this tenant in the last 30 days.</p>}
            {w.older > 0 ? (
              <p className="text-note text-muted mt-2">Includes {plural(w.older, 'older job', 'older jobs')} from before 13 November 2026 whose tenant isn't recorded.</p>
            ) : null}
            {w.other > 0 ? (
              <p className="text-note text-muted mt-2">Not counted: {plural(w.other, 'job', 'jobs')} made on another tenant.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  )
}
