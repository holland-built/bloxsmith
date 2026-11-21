// "Bloxsmith activity — 30 days" on the Value page: the jobs Bloxsmith did
// and the objects they made, counted from the runs record (/api/desk/runs,
// go/internal/runs). Pure, so the counting is tested without a browser.

// Minutes one job would take by hand in the Infoblox Portal. An estimate,
// said as one on the page.
export const MINUTES_PER_JOB = 10

// The pages that make things, in the order the panel lists them. A recorded
// delete ("delete") is not work made, so it is left out.
export const SOURCES = [
  ['', 'Automate'],
  ['address', 'Get an address: addresses'],
  ['dns', 'Get an address: DNS names'],
  ['lists', 'Site lists'],
  ['editor', 'Editor'],
]

// Only "built" counts. Remove (go/internal/server/desk.go) also runs on a
// failed run and then overwrites its status with "removed" or
// "remove-failed", so those statuses cannot tell a finished job that was
// undone from a failed one that was cleaned up. Undone jobs are left out
// with them, and the panel says so.
const DONE = new Set(['built'])

// The one job count on the Value page, for the panel and the printed report:
// runs recorded on this tenant, inside the whole UTC days the page names (range
// is [first, last] as YYYY-MM-DD). Returns null when the runs list did not load
// (the page says "not checked", never 0), { noPeriod: true } when the range is
// not two real days, and otherwise:
//   { jobs, objects, bySource: [[label, jobs, objects]...], older, other, hours }
// `older` is how many runs in those days carry no tenant: runs recorded before
// 13 November 2026, when the tenant was not yet written down. They may belong
// to another account, so they are not credited. `other` is how many were made
// on another tenant.
export function countWork(data, range) {
  if (!data || !Array.isArray(data.runs)) return null
  const from = Array.isArray(range) && range.length === 2 ? Date.parse(`${range[0]}T00:00:00Z`) : NaN
  const last = Array.isArray(range) && range.length === 2 ? Date.parse(`${range[1]}T00:00:00Z`) : NaN
  if (!Number.isFinite(from) || !Number.isFinite(last) || last < from) return { noPeriod: true }
  const end = last + 24 * 60 * 60 * 1000
  const per = new Map(SOURCES.map(([s]) => [s, { jobs: 0, objects: 0 }]))
  let jobs = 0
  let objects = 0
  let older = 0
  let other = 0
  for (const r of data.runs) {
    const src = r.source || ''
    if (!per.has(src) || !DONE.has(r.status)) continue
    const t = Date.parse(r.created)
    if (!Number.isFinite(t) || t < from || t >= end) continue
    if (!r.tenant) { older += 1; continue }
    if (r.tenant !== data.tenant) { other += 1; continue }
    const made = Array.isArray(r.objects) ? r.objects.length : 0
    const p = per.get(src)
    p.jobs += 1
    p.objects += made
    jobs += 1
    objects += made
  }
  return {
    jobs,
    objects,
    bySource: SOURCES.map(([s, label]) => [label, per.get(s).jobs, per.get(s).objects]).filter(([, j]) => j > 0),
    older,
    other,
    hours: hoursSaved(jobs),
  }
}

// Jobs x MINUTES_PER_JOB, in hours to one decimal place.
export function hoursSaved(jobs) {
  return Math.round((jobs * MINUTES_PER_JOB) / 6) / 10
}
