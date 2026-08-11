import { useMemo, useState } from 'react'
// FetchError is the same shared component SelfService.jsx uses — /api/templates
// answers 500 and /api/ipam/spaces answers 502 on an upstream failure, and both
// collapse into the same empty list a tenant that owns nothing produces.
import { COLORS, Card, CardGrid, Empty, FetchError, Skeleton, TabIntro } from '../components/ui.jsx'
import { useApi } from '../lib/api.js'

const inputCls = 'px-2.5 py-1.5 rounded-lg border border-border bg-field text-field-txt text-sm outline-none w-full'

function itemStatus(d) {
  const m = String(d?.message || '')
  if (/is not in the template/.test(m)) return { label: 'extra', color: COLORS.crit, bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)' }
  if (/live value is/.test(m)) return { label: 'changed', color: COLORS.warn, bg: 'var(--pill-warn-bg)', fg: 'var(--pill-warn-fg)' }
  return { label: 'missing', color: COLORS.crit, bg: 'var(--pill-crit-bg)', fg: 'var(--pill-crit-fg)' }
}

export default function Drift() {
  const templatesApi = useApi('/api/templates')
  const spacesApi = useApi('/api/ipam/spaces')
  const [template, setTemplate] = useState('')
  const [ipSpace, setIpSpace] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [openCats, setOpenCats] = useState(() => new Set())

  const templates = (Array.isArray(templatesApi.data) ? templatesApi.data : []).filter((t) => !t.type || t.type === 'site')
  const spaces = spacesApi.data?.spaces ?? []

  function check() {
    if (checking || !template) return
    setChecking(true)
    setResult(null)
    setErr(null)
    fetch('/api/drift/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template, ip_space: ipSpace || undefined }),
    })
      .then(async (r) => {
        let body = null
        try { body = await r.json() } catch { body = null }
        if (!r.ok || body?.error) { setErr(body?.error || `HTTP ${r.status}`); setChecking(false); return }
        setResult(body)
        setChecking(false)
      })
      .catch((e) => { setErr(String(e?.message || e)); setChecking(false) })
  }

  const groups = useMemo(() => {
    const g = {}
    if (result && Array.isArray(result.drifts)) {
      for (const d of result.drifts) {
        const cat = d.category || 'other'
        ;(g[cat] ||= []).push(d)
      }
    }
    return g
  }, [result])

  const sortedCats = useMemo(() => {
    const sevRank = { error: 0, warning: 1, info: 2 }
    const worst = (items) => Math.min(...items.map((d) => (sevRank[d.severity] != null ? sevRank[d.severity] : 2)))
    return Object.entries(groups).sort((a, b) => worst(a[1]) - worst(b[1]) || b[1].length - a[1].length)
  }, [groups])

  function toggleCat(cat) {
    setOpenCats((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n })
  }

  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight mb-1">Drift</h1>
      <TabIntro anchor="drift">
        Compares a site template against what actually exists in Infoblox and lists what is missing, changed, or
        extra. Read-only — it reports gaps, it never closes them.
      </TabIntro>

      {/* The 720px cap that used to live on a plain <div> around these two cards
          is now on the cards themselves. A div wrapping a Card hides that Card's
          panelId from CardGrid (it reads props.panelId off its DIRECT children),
          and a grid item with max-width + auto side margins centres in its track
          exactly the way the wrapper centred inside the page. */}
      <CardGrid layoutKey="drift">
        <Card
          panelId="drift-check"
          span={6}
          className="max-w-[720px] mx-auto"
          title="Check drift"
          note="compare a site template against live Infoblox state"
        >
          <div className="flex flex-col gap-3">
            <label className="text-xs text-muted flex flex-col gap-1">
              Template
              {templatesApi.loading ? (
                <Skeleton h={38} />
              ) : (
                <select value={template} onChange={(e) => setTemplate(e.target.value)} className={inputCls}>
                  <option value="">Select a template</option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} — {t.region || ''}/{t.environment || ''}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label className="text-xs text-muted flex flex-col gap-1">
              IP space (override)
              <select value={ipSpace} onChange={(e) => setIpSpace(e.target.value)} className={inputCls}>
                <option value="">— template default —</option>
                {spaces.map((sp) => (
                  <option key={sp.id} value={sp.name}>{sp.name}</option>
                ))}
              </select>
            </label>
            <div>
              <FetchError error={templatesApi.error} stale={templates.length > 0} />
              <FetchError error={spacesApi.error} stale={spaces.length > 0} />
              {!templatesApi.loading && !templatesApi.error && templates.length === 0 && <Empty>no templates</Empty>}
              {!spacesApi.loading && !spacesApi.error && spaces.length === 0 && <Empty>no IP spaces</Empty>}
            </div>
            <button
              disabled={checking || !template}
              onClick={check}
              className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed self-start"
              style={{ background: COLORS.accent, color: '#fff' }}
            >
              {checking ? 'Checking…' : 'Check drift'}
            </button>
          </div>
        </Card>

        {err && (
          <Card key="drift-error" panelId="drift-error" span={6} className="max-w-[720px] mx-auto" title="Error">
            <div className="text-sm" style={{ color: COLORS.crit }}>{err}</div>
          </Card>
        )}

        {result && (
          <Card key="drift-result" panelId="drift-result" span={6} title="Result">
            {result.found === false ? (
              <Empty>site not found for this template</Empty>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-3 flex-wrap">
                  <span className="font-mono text-xs">{result.site || template}</span>
                  <span
                    className="inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                    style={
                      result.drifted
                        ? { background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }
                        : { background: 'var(--pill-ok-bg)', color: 'var(--pill-ok-fg)' }
                    }
                  >
                    {result.drifted ? `✕ ${result.drifts?.length || 0} items` : '✓ in-sync'}
                  </span>
                  {result.subnet_count != null && (
                    <span className="text-xs text-muted">{result.subnet_count} subnets</span>
                  )}
                </div>
                {result.summary && (
                  <div className="text-xs text-dim mb-3">
                    {typeof result.summary === 'string'
                      ? result.summary
                      : `${result.summary.total ?? 0} total · ${result.summary.errors ?? 0} error${result.summary.errors === 1 ? '' : 's'} · ${result.summary.warnings ?? 0} warning${result.summary.warnings === 1 ? '' : 's'}`}
                  </div>
                )}
                {sortedCats.length === 0 ? (
                  <Empty>no drift items</Empty>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    {sortedCats.map(([cat, items]) => {
                      const open = openCats.has(cat)
                      const shown = open ? items : items.slice(0, 6)
                      return (
                        <div key={cat}>
                          <div className="text-[10.5px] font-medium text-dim uppercase tracking-wide mb-1.5">{cat}</div>
                          <div className="flex flex-col gap-1.5">
                            {shown.map((d, i) => {
                              const st = itemStatus(d)
                              return (
                                <div key={i} className="flex items-start gap-2 text-sm">
                                  <span
                                    className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 mt-0.5"
                                    style={{ background: st.bg, color: st.fg }}
                                  >
                                    {st.label}
                                  </span>
                                  <span className="text-muted">{d.message}</span>
                                </div>
                              )
                            })}
                          </div>
                          {items.length > 6 && (
                            <button
                              onClick={() => toggleCat(cat)}
                              className="text-xs text-dim mt-1.5 underline underline-offset-2"
                            >
                              {open ? 'show less' : `+${items.length - 6} more`}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </Card>
        )}
      </CardGrid>
    </div>
  )
}
