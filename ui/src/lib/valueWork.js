// "Bloxsmith activity — 30 days" on the Value page: the jobs Bloxsmith did
// and the objects they made, counted from the runs record (/api/desk/runs,
// go/internal/runs). Pure, so the counting is tested without a browser.

// Minutes one job would take by hand in the Infoblox Portal. An estimate,
// said as one on the page.
export const MINUTES_PER_JOB = 10

export const WINDOW_DAYS = 30

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

// countWork(data, now) returns null when the runs list did not load (the
// panel says "not checked", never 0). Otherwise:
//   { jobs, objects, bySource: [[label, jobs, objects]...], older, other, hours }
// `older` is how many counted jobs carry no tenant: runs recorded before
// 13 November 2026, when the tenant was not yet written down. Runs made on
// another tenant are left out; `other` says how many, so a 0 is explained.
export function countWork(data, now = Date.now()) {
  if (!data || !Array.isArray(data.runs)) return null
  const tenant = data.tenant || ''
  const cutoff = now - WINDOW_DAYS * 24 * 60 * 60 * 1000
  const per = new Map(SOURCES.map(([s]) => [s, { jobs: 0, objects: 0 }]))
  let jobs = 0
  let objects = 0
  let older = 0
  let other = 0
  for (const r of data.runs) {
    const src = r.source || ''
    if (!per.has(src) || !DONE.has(r.status)) continue
    const t = Date.parse(r.created)
    if (!Number.isFinite(t) || t < cutoff || t > now) continue
    if (r.tenant && r.tenant !== tenant) { other += 1; continue }
    const made = Array.isArray(r.objects) ? r.objects.length : 0
    const p = per.get(src)
    p.jobs += 1
    p.objects += made
    jobs += 1
    objects += made
    if (!r.tenant) older += 1
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

// The printed report's jobs: only runs recorded on this tenant, inside the
// whole UTC days the report names (range is [first, last] as YYYY-MM-DD). A run
// with no tenant may belong to another account, so it is not credited here;
// `older` says how many were left out. Returns null when the runs did not load
// and { noPeriod: true } when the range is not two real days.
export function countReportWork(data, range) {
  if (!data || !Array.isArray(data.runs)) return null
  const from = Array.isArray(range) && range.length === 2 ? Date.parse(`${range[0]}T00:00:00Z`) : NaN
  const last = Array.isArray(range) && range.length === 2 ? Date.parse(`${range[1]}T00:00:00Z`) : NaN
  if (!Number.isFinite(from) || !Number.isFinite(last) || last < from) return { noPeriod: true }
  const end = last + 24 * 60 * 60 * 1000
  const sources = new Set(SOURCES.map(([s]) => s))
  let jobs = 0
  let objects = 0
  let older = 0
  for (const r of data.runs) {
    if (!sources.has(r.source || '') || !DONE.has(r.status)) continue
    const t = Date.parse(r.created)
    if (!Number.isFinite(t) || t < from || t >= end) continue
    if (!r.tenant) { older += 1; continue }
    if (r.tenant !== data.tenant) continue
    jobs += 1
    objects += Array.isArray(r.objects) ? r.objects.length : 0
  }
  return { jobs, objects, older, hours: hoursSaved(jobs) }
}

// Jobs x MINUTES_PER_JOB, in hours to one decimal place.
export function hoursSaved(jobs) {
  return Math.round((jobs * MINUTES_PER_JOB) / 6) / 10
}
