// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SAVED_CHART_PAGES, newChartId, chartViewName, buildChartBlob, parseSavedChart, loadSavedCharts, saveChart, removeChart,
} from './savedCharts.js'

const picks = { count: 'dns', split: 'domain', window: '7d', over: 'none', top: 10 }

// A fetch that answers from a fixed table and records what it was asked.
function fakeFetch(routes) {
  const calls = []
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body && JSON.parse(opts.body) })
    const r = routes[`${opts.method ?? 'GET'} ${url}`]
    if (!r) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }
  }
  return { impl, calls }
}

test('the pages a chart can go on, with their plain names', () => {
  assert.deepEqual(SAVED_CHART_PAGES.map((p) => p.id), ['overview', 'dns', 'security', 'network', 'infra'])
  assert.deepEqual(SAVED_CHART_PAGES.map((p) => p.name), ['Overview', 'DNS', 'Security', 'Network', 'Infra'])
})

test('a new id is random lower-case letters and digits, never the title', () => {
  const a = newChartId()
  assert.match(a, /^[a-z0-9]{12}$/)
  assert.notEqual(newChartId(), a)
  assert.equal(chartViewName('k3x9q2m7ab12'), '__chart_k3x9q2m7ab12')
})

test('the saved body is the picks and nothing else, the name trimmed', () => {
  assert.deepEqual(buildChartBlob({ id: 'k3x9q2m7ab12', title: '  Top domains ', tab: 'dns', picks }), {
    name: '__chart_k3x9q2m7ab12',
    chart: { v: 1, title: 'Top domains', tab: 'dns', picks },
  })
})

test('a stored record reads back, and a broken one is ignored', () => {
  const rec = { name: '__chart_k3x9q2m7ab12', saved_at: '2026-10-22T10:00:00Z', chart: { v: 1, title: 'Top domains', tab: 'dns', picks } }
  assert.deepEqual(parseSavedChart(rec), { id: 'k3x9q2m7ab12', title: 'Top domains', tab: 'dns', picks, savedAt: '2026-10-22T10:00:00Z' })
  assert.equal(parseSavedChart({ name: '__layout_dns', order: [] }), null)
  assert.equal(parseSavedChart({ name: '__chart_k3x9q2m7ab12', chart: { v: 2, title: 'x', tab: 'dns', picks } }), null)
  assert.equal(parseSavedChart({ name: '__chart_k3x9q2m7ab12', chart: { v: 1, title: 'x', tab: 'dns' } }), null)
  assert.equal(parseSavedChart(null), null)
})

test("a page loads only its own saved charts, oldest first, and skips every other view", async () => {
  const chart = (id, tab, at) => ({ name: `__chart_${id}`, saved_at: at, chart: { v: 1, title: id, tab, picks } })
  const { impl, calls } = fakeFetch({
    'GET /api/views': { body: { views: [
      { name: '__chart_bbbbbbbb', saved_at: '2026-10-22T11:00:00Z' },
      { name: '__chart_aaaaaaaa', saved_at: '2026-10-22T12:00:00Z' },
      { name: '__chart_cccccccc', saved_at: '2026-10-22T09:00:00Z' },
      { name: '__layout_dns', saved_at: '2026-10-22T09:00:00Z' },
    ] } },
    'GET /api/views/__chart_aaaaaaaa': { body: chart('aaaaaaaa', 'dns', '2026-10-22T12:00:00Z') },
    'GET /api/views/__chart_bbbbbbbb': { body: chart('bbbbbbbb', 'dns', '2026-10-22T11:00:00Z') },
    'GET /api/views/__chart_cccccccc': { body: chart('cccccccc', 'security', '2026-10-22T09:00:00Z') },
  })
  const got = await loadSavedCharts('dns', impl)
  assert.deepEqual(got.map((c) => c.id), ['bbbbbbbb', 'aaaaaaaa'])
  assert.ok(!calls.some((c) => c.url.includes('__layout_')), 'a layout is never read as a chart')
})

test('one chart that cannot be read does not hide the others', async () => {
  const good = { name: '__chart_aaaaaaaa', saved_at: '2026-10-22T12:00:00Z', chart: { v: 1, title: 'a', tab: 'dns', picks } }
  const impl = async (url) => {
    if (url === '/api/views') return { ok: true, json: async () => ({ views: [{ name: '__chart_aaaaaaaa' }, { name: '__chart_bbbbbbbb' }] }) }
    if (url.endsWith('aaaaaaaa')) return { ok: true, json: async () => good }
    return { ok: true, json: async () => { throw new SyntaxError('bad JSON') } }
  }
  assert.deepEqual((await loadSavedCharts('dns', impl)).map((c) => c.id), ['aaaaaaaa'])
})

test('a failed listing gives no charts rather than an error on the page', async () => {
  const { impl } = fakeFetch({ 'GET /api/views': { status: 500, body: {} } })
  assert.deepEqual(await loadSavedCharts('dns', impl), [])
})

test('save posts the body and throws when the server refuses it; remove deletes by id', async () => {
  const { impl, calls } = fakeFetch({
    'POST /api/views': { body: { ok: true } },
    'DELETE /api/views/__chart_k3x9q2m7ab12': { body: { ok: true } },
  })
  await saveChart({ id: 'k3x9q2m7ab12', title: 'Top domains', tab: 'dns', picks }, impl)
  assert.deepEqual(calls[0].body, buildChartBlob({ id: 'k3x9q2m7ab12', title: 'Top domains', tab: 'dns', picks }))
  await removeChart('k3x9q2m7ab12', impl)
  assert.equal(calls[1].method, 'DELETE')

  const refused = fakeFetch({ 'POST /api/views': { status: 400, body: { ok: false, error: "that combination of choices isn't available" } } })
  await assert.rejects(saveChart({ id: 'k3x9q2m7ab12', title: 'x', tab: 'dns', picks }, refused.impl), /isn't available/)
})
