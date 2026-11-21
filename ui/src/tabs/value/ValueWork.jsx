// "Bloxsmith activity — 30 days": jobs Bloxsmith finished on this tenant,
// the objects they made, and a time-saved estimate. The count comes from the
// page's model, so it is the same one the printed report shows.
import { Card, FetchError, Skeleton } from '../../components/ui.jsx'
import { MINUTES_PER_JOB } from '../../lib/valueWork.js'
import ValueStat from './ValueStat.jsx'

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export default function ValueWork({ panelId, runs: api, w: counted, loading }) {
  const noPeriod = !!counted?.noPeriod
  const w = noPeriod ? null : counted
  const stats = w && [
    { key: 'jobs', label: 'Jobs completed', state: 'ok', text: w.jobs.toLocaleString() },
    { key: 'objects', label: 'Objects created in Infoblox', state: 'ok', text: w.objects.toLocaleString() },
    { key: 'hours', label: 'Estimated time saved', state: 'ok', text: plural(w.hours, 'hour', 'hours'), note: `Based on ${MINUTES_PER_JOB} minutes per job if completed manually in the Infoblox Portal.` },
  ]
  return (
    <Card panelId={panelId} title="Bloxsmith activity — 30 days" span={6}>
      <div className="vl-panel" data-value-work="">
        <FetchError error={api.error} />
        {loading && !api.error ? <Skeleton h={100} /> : null}
        {!loading && noPeriod ? (
          <dl className="vl-strip"><ValueStat s={{ key: 'jobs', label: 'Jobs completed', state: 'unavailable', text: 'Not available' }} /></dl>
        ) : null}
        {!loading && !counted ? <p className="text-copy text-muted" data-value-work-state="not-checked">Jobs completed: not checked. Bloxsmith's job history could not be read.</p> : null}
        {!loading && w ? (
          <>
            {w.jobs > 0 ? <dl className="vl-strip">{stats.map((s) => <ValueStat key={s.key} s={s} />)}</dl> : null}
            {w.bySource.length > 0 ? (
              <ul aria-label="Jobs by page" className="vl-list">
                {w.bySource.map(([label, jobs, objects]) => (
                  <li key={label}>{label}: {plural(jobs, 'job', 'jobs')}, {plural(objects, 'object', 'objects')} created</li>
                ))}
              </ul>
            ) : <p className="vl-note">No Bloxsmith jobs are recorded for this account in this period.</p>}
            {w.older > 0 ? (
              <p className="vl-note">Excludes {plural(w.older, 'older job', 'older jobs')} with no account on record.</p>
            ) : null}
            {w.other > 0 ? (
              <p className="vl-note">Excludes {plural(w.other, 'job', 'jobs')} completed on another account.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  )
}
