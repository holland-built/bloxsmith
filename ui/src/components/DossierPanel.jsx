import { useChartTheme } from './ui.jsx'

// ---------- parsing helpers ----------

function parseDetail(entry) {
  if (entry == null) return null
  const raw = entry.detail
  if (raw == null) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  if (typeof raw === 'object') return raw
  return null
}

function sourceBlob(entry) {
  // any of detail/whois/geo/malware, parsed if needed
  const d = parseDetail(entry)
  if (d != null) return d
  for (const k of ['whois', 'geo', 'malware']) {
    if (entry && entry[k] != null) return entry[k]
  }
  return null
}

function findSource(sources, key) {
  return sources.find((s) => s && s.source === key)
}

function fmt(v) {
  if (v == null || v === '') return null
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function Pill({ children, tone = 'muted' }) {
  const style =
    tone === 'crit'
      ? { background: 'var(--pill-crit-bg)', color: 'var(--pill-crit-fg)' }
      : tone === 'ok'
      ? { background: 'var(--pill-ok-bg)', color: 'var(--pill-ok-fg)' }
      : tone === 'warn'
      ? { background: 'var(--pill-warn-bg)', color: 'var(--pill-warn-fg)' }
      : {}
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-full border ${tone === 'muted' ? 'border-border text-muted' : 'border-transparent'}`}
      style={style}
    >
      {children}
    </span>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-3">
      <h4 className="text-[11px] font-semibold text-muted uppercase tracking-wide mb-1.5">{title}</h4>
      {children}
    </div>
  )
}

function Dl({ rows }) {
  const filtered = rows.filter((r) => r[1] != null && r[1] !== '')
  if (!filtered.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {filtered.map(([k, v]) => (
        <span key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="font-mono text-field-txt break-all">{v}</dd>
        </span>
      ))}
    </dl>
  )
}

// ---------- ATP threat intel ----------

function extractAtpRecords(blob, query) {
  if (!blob) return []
  let recs = null
  if (Array.isArray(blob.records)) recs = blob.records
  else if (blob.results && typeof blob.results === 'object') {
    // keyed by indicator, or a flat array under some other key
    if (Array.isArray(blob.results[query])) recs = blob.results[query]
    else {
      const firstArr = Object.values(blob.results).find((v) => Array.isArray(v))
      if (firstArr) recs = firstArr
    }
  } else if (Array.isArray(blob)) recs = blob
  if (!Array.isArray(recs)) return []
  return recs.map((r) => ({
    class: r.class ?? r.threat_class ?? null,
    property: r.property ?? r.threat_property ?? null,
    threat_level: r.threat_level ?? r.confidence ?? null,
    feed: r.feed_name ?? r.feed ?? null,
    detected: r.detected ?? r.imported ?? r.up_to_date ?? null,
  }))
}

function ThreatIntelTable({ records }) {
  if (!records.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-muted text-left">
            <th className="pr-3 pb-1 font-medium">class</th>
            <th className="pr-3 pb-1 font-medium">property</th>
            <th className="pr-3 pb-1 font-medium">threat level</th>
            <th className="pr-3 pb-1 font-medium">feed</th>
            <th className="pr-3 pb-1 font-medium">detected</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="pr-3 py-1 text-field-txt">{fmt(r.class) ?? '—'}</td>
              <td className="pr-3 py-1 text-field-txt">{fmt(r.property) ?? '—'}</td>
              <td className="pr-3 py-1 text-field-txt">{fmt(r.threat_level) ?? '—'}</td>
              <td className="pr-3 py-1 text-field-txt">{fmt(r.feed) ?? '—'}</td>
              <td className="pr-3 py-1 text-field-txt">{fmt(r.detected) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- reputation grid ----------

function repVerdict(blob) {
  if (blob == null) return null
  try {
    if (typeof blob === 'string') {
      try { blob = JSON.parse(blob) } catch { return blob }
    }
    if (Array.isArray(blob)) return blob.length ? `${blob.length} hit(s)` : 'clear'
    if (typeof blob === 'object') {
      const v =
        blob.verdict ?? blob.status ?? blob.threat_level ?? blob.malicious ?? blob.matches ?? blob.result ?? blob.classification
      if (v != null) return fmt(v)
      const keys = Object.keys(blob)
      if (!keys.length) return 'clear'
      return `${keys.length} field(s)`
    }
  } catch { /* fall through */ }
  return null
}

function parseGsb(blob) {
  if (!blob || typeof blob !== 'object') return null
  const status = blob.status
  if (status == null) return null
  return { verdict: fmt(status), tone: /no match/i.test(String(status)) ? 'ok' : 'warn' }
}

function parseMatchesCount(blob) {
  if (!blob || typeof blob !== 'object' || !Array.isArray(blob.matches)) return null
  const n = blob.matches.length
  return n ? { verdict: `${n} match(es)`, tone: 'warn' } : { verdict: 'clear', tone: 'ok' }
}

function parseUnavailable(blob) {
  if (!blob || typeof blob !== 'object') return null
  if (blob.info != null || blob.reason != null) return { verdict: 'unavailable', tone: 'muted' }
  return null
}

function parseMalwareAnalysisV3(blob) {
  if (!blob || typeof blob !== 'object') return null
  const stats = blob.last_analysis_stats
  if (!stats || typeof stats !== 'object') return null
  const malicious = Number(stats.malicious) || 0
  const total = ['harmless', 'malicious', 'suspicious', 'undetected'].reduce((sum, k) => sum + (Number(stats[k]) || 0), 0)
  return { verdict: `${malicious} malicious / ${total} engines`, tone: malicious > 0 ? 'warn' : 'ok' }
}

const REP_PARSERS = {
  gsb: parseGsb,
  threatfox: parseMatchesCount,
  urlhaus: parseMatchesCount,
  malware_analysis: parseUnavailable,
  mandiant: parseUnavailable,
  malware_analysis_v3: parseMalwareAnalysisV3,
}

// ---------- infra parsing ----------

function parseGeo(blob) {
  if (!blob) return null
  return {
    country: blob.country ?? blob.country_name ?? null,
    city: blob.city ?? null,
    asn: blob.asn ?? blob.as ?? blob.autonomous_system ?? null,
    org: blob.org ?? blob.isp ?? null,
  }
}

function parseSsl(blob) {
  if (!blob) return null
  const cert = blob.certificate ?? blob
  return {
    issuer: cert.issuer ?? null,
    subject: cert.subject ?? null,
    valid_to: cert.valid_to ?? cert.not_after ?? cert.expiry ?? null,
  }
}

function parseWhois(blob) {
  if (!blob) return null
  const w = blob.whois ?? blob
  return {
    registrar: w.registrar ?? null,
    created: w.creation_date ?? w.created ?? w.created_date ?? null,
    expires: w.expiration_date ?? w.expires ?? w.expiry_date ?? null,
    nameservers: Array.isArray(w.name_servers) ? w.name_servers : Array.isArray(w.nameservers) ? w.nameservers : null,
  }
}

function parseDns(blob) {
  if (!blob) return null
  const recs = Array.isArray(blob) ? blob : Array.isArray(blob.records) ? blob.records : null
  return recs
}

// ---------- categorization ----------

function parseWebCat(blob) {
  if (!blob) return null
  const cats = blob.categories ?? blob.category ?? null
  if (cats == null) return null
  return Array.isArray(cats) ? cats : [cats]
}

// ---------- raw fallback ----------

function RawSources({ items }) {
  if (!items.length) return null
  return (
    <details className="mt-3 pt-2 border-t border-border">
      <summary className="text-[11px] text-muted cursor-pointer select-none">raw sources ({items.length})</summary>
      <div className="mt-2 space-y-2">
        {items.map(({ source, blob }) => (
          <div key={source}>
            <div className="text-[11px] text-dim font-mono mb-0.5">{source}</div>
            <pre className="font-mono text-[10.5px] text-muted whitespace-pre-wrap p-2 rounded-lg border border-border bg-field max-h-[240px] overflow-auto">
              {typeof blob === 'string' ? blob : JSON.stringify(blob, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  )
}

// ---------- main ----------

export default function DossierPanel({ data }) {
  const { COLORS } = useChartTheme()
  if (!data) return null
  if (data.unavailable) {
    return <div className="text-[11px] text-muted mt-3">External intel unavailable: {String(data.unavailable)}</div>
  }

  const sum = data.summary || {}
  const sources = Array.isArray(data.sources) ? data.sources : []
  const query = data.query

  const usedSources = new Set()
  const rawFallback = []
  const markUsed = (key) => usedSources.add(key)

  // Verdict
  const mal = !!sum.malicious
  const classes = Array.isArray(sum.threat_classes) ? sum.threat_classes : []
  const properties = Array.isArray(sum.properties) ? sum.properties : []
  const verdictMeta = [
    ['Country', sum.country],
    ['Registrar', sum.registrar],
    ['Actor', sum.actor],
  ]

  // ATP
  const atpEntry = findSource(sources, 'atp')
  const atpBlob = atpEntry ? sourceBlob(atpEntry) : null
  const atpRecords = atpBlob ? extractAtpRecords(atpBlob, query) : []
  if (atpEntry) { markUsed('atp'); if (!atpRecords.length && atpBlob) rawFallback.push({ source: 'atp', blob: atpBlob }) }

  // WHOIS
  const whoisEntry = findSource(sources, 'whois')
  const whoisBlob = whoisEntry ? sourceBlob(whoisEntry) : null
  const whois = whoisBlob ? parseWhois(whoisBlob) : null
  const whoisRows = whois
    ? [
        ['Registrar', fmt(whois.registrar)],
        ['Created', fmt(whois.created)],
        ['Expires', fmt(whois.expires)],
        ['Nameservers', whois.nameservers && whois.nameservers.length ? whois.nameservers.join(', ') : null],
      ]
    : []
  const hasWhois = whoisRows.some((r) => r[1] != null && r[1] !== '')
  if (whoisEntry) { markUsed('whois'); if (!hasWhois && whoisBlob) rawFallback.push({ source: 'whois', blob: whoisBlob }) }

  // Reputation grid
  const REP_SOURCES = ['gsb', 'mandiant', 'threatfox', 'urlhaus', 'malware_analysis', 'malware_analysis_v3']
  const repCells = REP_SOURCES.map((key) => {
    const entry = findSource(sources, key)
    if (!entry) return null
    markUsed(key)
    const blob = sourceBlob(entry)
    const parser = REP_PARSERS[key]
    const parsed = parser ? parser(blob) : null
    if (parsed != null) {
      if (blob != null) rawFallback.push({ source: key, blob })
      return { key, verdict: parsed.verdict, tone: parsed.tone }
    }
    const verdict = repVerdict(blob)
    if (verdict == null) {
      if (blob != null) rawFallback.push({ source: key, blob })
      return null
    }
    return { key, verdict, tone: null }
  }).filter(Boolean)

  // Infrastructure
  const geoEntry = findSource(sources, 'geo')
  const geoBlob = geoEntry ? sourceBlob(geoEntry) : null
  const geo = geoBlob ? parseGeo(geoBlob) : null
  if (geoEntry) { markUsed('geo'); if (!geo && geoBlob) rawFallback.push({ source: 'geo', blob: geoBlob }) }

  const sslEntry = findSource(sources, 'ssl_cert')
  const sslBlob = sslEntry ? sourceBlob(sslEntry) : null
  const ssl = sslBlob ? parseSsl(sslBlob) : null
  if (sslEntry) { markUsed('ssl_cert'); if (!ssl && sslBlob) rawFallback.push({ source: 'ssl_cert', blob: sslBlob }) }

  const nsEntry = findSource(sources, 'nameserver')
  const nsBlob = nsEntry ? sourceBlob(nsEntry) : null
  if (nsEntry) { markUsed('nameserver'); if (nsBlob) rawFallback.push({ source: 'nameserver', blob: nsBlob }) }

  const dnsEntry = findSource(sources, 'dns')
  const dnsBlob = dnsEntry ? sourceBlob(dnsEntry) : null
  const dnsRecs = dnsBlob ? parseDns(dnsBlob) : null
  if (dnsEntry) { markUsed('dns'); if (!dnsRecs && dnsBlob) rawFallback.push({ source: 'dns', blob: dnsBlob }) }

  const infraRows = [
    ...(geo ? [['Country', fmt(geo.country)], ['City', fmt(geo.city)], ['ASN', fmt(geo.asn)], ['Org', fmt(geo.org)]] : []),
    ...(ssl ? [['SSL issuer', fmt(ssl.issuer)], ['SSL expiry', fmt(ssl.valid_to)]] : []),
  ]
  const hasInfra = infraRows.some((r) => r[1] != null && r[1] !== '') || (dnsRecs && dnsRecs.length)

  // Categorization
  const webCatEntry = findSource(sources, 'infoblox_web_cat')
  const webCatBlob = webCatEntry ? sourceBlob(webCatEntry) : null
  const webCats = webCatBlob ? parseWebCat(webCatBlob) : null
  if (webCatEntry) { markUsed('infoblox_web_cat'); if (!webCats && webCatBlob) rawFallback.push({ source: 'infoblox_web_cat', blob: webCatBlob }) }

  const tldEntry = findSource(sources, 'tld_risk')
  const tldBlob = tldEntry ? sourceBlob(tldEntry) : null
  const tldRisk = tldBlob && (tldBlob.risk ?? tldBlob.score ?? tldBlob.level) != null ? fmt(tldBlob.risk ?? tldBlob.score ?? tldBlob.level) : null
  if (tldEntry) { markUsed('tld_risk'); if (!tldRisk && tldBlob) rawFallback.push({ source: 'tld_risk', blob: tldBlob }) }

  const inforankEntry = findSource(sources, 'inforank')
  const inforankBlob = inforankEntry ? sourceBlob(inforankEntry) : null
  const inforankScore = inforankBlob && (inforankBlob.score ?? inforankBlob.rank) != null ? fmt(inforankBlob.score ?? inforankBlob.rank) : null
  if (inforankEntry) { markUsed('inforank'); if (!inforankScore && inforankBlob) rawFallback.push({ source: 'inforank', blob: inforankBlob }) }

  const rpzEntry = findSource(sources, 'rpz_feeds')
  const rpzBlob = rpzEntry ? sourceBlob(rpzEntry) : null
  const rpzList = Array.isArray(rpzBlob) ? rpzBlob : Array.isArray(rpzBlob?.feeds) ? rpzBlob.feeds : null
  if (rpzEntry) { markUsed('rpz_feeds'); if (!(rpzList && rpzList.length) && rpzBlob) rawFallback.push({ source: 'rpz_feeds', blob: rpzBlob }) }

  const customEntry = findSource(sources, 'custom_lists')
  const customBlob = customEntry ? sourceBlob(customEntry) : null
  const customList = Array.isArray(customBlob) ? customBlob : Array.isArray(customBlob?.lists) ? customBlob.lists : null
  if (customEntry) { markUsed('custom_lists'); if (!(customList && customList.length) && customBlob) rawFallback.push({ source: 'custom_lists', blob: customBlob }) }

  const hasCategorization = (webCats && webCats.length) || tldRisk != null || inforankScore != null || (rpzList && rpzList.length) || (customList && customList.length)

  // Everything else not explicitly handled -> raw fallback (only if it has content)
  sources.forEach((entry) => {
    if (!entry || !entry.source || usedSources.has(entry.source)) return
    const blob = sourceBlob(entry)
    if (blob != null && (typeof blob !== 'object' || Object.keys(blob).length)) {
      rawFallback.push({ source: entry.source, blob })
    }
  })

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <h3 className="text-[12px] font-semibold text-muted mb-2">External intel (Dossier)</h3>

      {/* Verdict header */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span
          className="font-mono text-[12px] font-semibold px-2.5 py-1 rounded-lg"
          style={{ background: mal ? 'var(--pill-crit-bg)' : 'var(--pill-ok-bg)', color: mal ? 'var(--pill-crit-fg)' : 'var(--pill-ok-fg)' }}
        >
          {mal ? 'MALICIOUS' : 'CLEAN'}
        </span>
        {sum.max_threat_level != null && <span className="font-mono text-[11px] text-muted">threat {String(sum.max_threat_level)}</span>}
        {data.type && <span className="font-mono text-[11px] text-dim">{String(data.type)}</span>}
      </div>
      {!!(classes.length || properties.length) && (
        <div className="flex gap-1 flex-wrap mb-2">
          {classes.map((c, i) => <Pill key={`c${i}`} tone={mal ? 'crit' : 'muted'}>{String(c)}</Pill>)}
          {properties.map((p, i) => <Pill key={`p${i}`}>{String(p)}</Pill>)}
        </div>
      )}
      <Dl rows={verdictMeta} />

      {/* Threat intel */}
      {!!atpRecords.length && (
        <Section title="Threat intel">
          <ThreatIntelTable records={atpRecords} />
        </Section>
      )}

      {/* WHOIS */}
      {hasWhois && (
        <Section title="WHOIS">
          <Dl rows={whoisRows} />
        </Section>
      )}

      {/* Reputation grid */}
      {!!repCells.length && (
        <Section title="Reputation">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {repCells.map(({ key, verdict, tone }) => {
              const muted = tone === 'muted'
              const ok = tone ? tone === 'ok' : /^clear$/i.test(verdict)
              return (
                <div key={key} className="px-2 py-1.5 rounded-lg border border-border bg-field">
                  <div className="text-[10px] text-muted font-mono uppercase">{key}</div>
                  <div
                    className={`text-[11px] font-mono ${muted ? 'text-muted' : ''}`}
                    style={muted ? undefined : { color: ok ? COLORS.ok : COLORS.warn }}
                  >
                    {verdict}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>
      )}

      {/* Infrastructure */}
      {hasInfra && (
        <Section title="Infrastructure">
          <Dl rows={infraRows} />
          {!!(dnsRecs && dnsRecs.length) && (
            <div className="mt-1 font-mono text-[11px] text-field-txt space-y-0.5">
              {dnsRecs.map((r, i) => (
                <div key={i}>{typeof r === 'object' ? JSON.stringify(r) : String(r)}</div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Categorization */}
      {hasCategorization && (
        <Section title="Categorization">
          <div className="flex flex-wrap gap-1 mb-1.5">
            {(webCats || []).map((c, i) => <Pill key={`wc${i}`}>{String(c)}</Pill>)}
            {(rpzList || []).map((f, i) => <Pill key={`rpz${i}`} tone="warn">{typeof f === 'object' ? JSON.stringify(f) : String(f)}</Pill>)}
            {(customList || []).map((f, i) => <Pill key={`cl${i}`}>{typeof f === 'object' ? JSON.stringify(f) : String(f)}</Pill>)}
          </div>
          <Dl rows={[['TLD risk', tldRisk], ['InfoRank score', inforankScore]]} />
        </Section>
      )}

      {/* Raw fallback — never hide data */}
      <RawSources items={rawFallback} />
    </div>
  )
}
