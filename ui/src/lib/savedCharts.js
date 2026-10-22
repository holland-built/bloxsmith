// Charts saved from Build a chart onto a page (savedCharts.test.js).
//
// Each one is a saved view named __chart_<id> holding only the picks, so the
// page redraws it from whichever tenant is active. The server checks the
// picks against the builder's allow-list (dashboard/saved_chart.go) and
// refuses anything else, the same list the menus are built from. The store is
// shared across tenants, the same as layouts.

export const SAVED_CHART_PAGES = [
  { id: 'overview', name: 'Overview' },
  { id: 'dns', name: 'DNS' },
  { id: 'security', name: 'Security' },
  { id: 'network', name: 'Network' },
  { id: 'infra', name: 'Infra' },
]

const PREFIX = '__chart_'
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A random id. Never a slug of the title: the store shortens and cleans
 * names, so two titles could otherwise land in one file.
 */
export function newChartId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

export const chartViewName = (id) => `${PREFIX}${id}`

/** The POST body for one saved chart. */
export function buildChartBlob({ id, title, tab, picks }) {
  return { name: chartViewName(id), chart: { v: 1, title: title.trim(), tab, picks } }
}

/** A stored view as {id, title, tab, picks, savedAt}, or null if it is not a usable chart. */
export function parseSavedChart(record) {
  const c = record?.chart
  if (typeof record?.name !== 'string' || !record.name.startsWith(PREFIX)) return null
  if (c?.v !== 1 || typeof c.title !== 'string' || typeof c.tab !== 'string' || typeof c.picks !== 'object' || !c.picks) {
    return null
  }
  return { id: record.name.slice(PREFIX.length), title: c.title, tab: c.tab, picks: c.picks, savedAt: record.saved_at }
}

/**
 * The charts saved onto one page, oldest first so a new one joins at the
 * end. Any failure gives an empty list: a page with no saved charts is what
 * it was before this feature, and nothing on it should break.
 */
export async function loadSavedCharts(tab, fetchImpl = fetch) {
  try {
    const listRes = await fetchImpl('/api/views')
    if (!listRes.ok) return []
    const listed = ((await listRes.json())?.views ?? []).filter((v) => v?.name?.startsWith(PREFIX))
    const read = await Promise.all(
      // Each read on its own: one broken record must not hide the rest.
      listed.map(async (v) => {
        try {
          const res = await fetchImpl(`/api/views/${encodeURIComponent(v.name)}`)
          return res.ok ? parseSavedChart(await res.json()) : null
        } catch {
          return null
        }
      }),
    )
    return read
      .filter((c) => c && c.tab === tab)
      .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)))
  } catch {
    return []
  }
}

/** Saves one chart; throws with the server's reason when it is refused. */
export async function saveChart(chart, fetchImpl = fetch) {
  const res = await fetchImpl('/api/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChartBlob(chart)),
  })
  if (!res.ok) {
    const why = (await res.json().catch(() => null))?.error
    throw new Error(why || `the chart could not be saved (HTTP ${res.status})`)
  }
}

/** Takes one saved chart off its page. */
export async function removeChart(id, fetchImpl = fetch) {
  const res = await fetchImpl(`/api/views/${encodeURIComponent(chartViewName(id))}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`the chart could not be removed (HTTP ${res.status})`)
}
