import { useEffect, useState } from 'react'

/* IB_LOGO — Infoblox mark, base64 (verbatim, ported from src/50.routing-vault.jsx) */
const IB_LOGO = "data:image/png;base64,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";

// Ordered logo sources tried by BrandLogoImg — browser <img> sends Referer so Brandfetch works
function buildLogoSources(domain, bust) {
  return [
    '/api/logo' + (bust ? `?v=${bust}` : ''),
    `https://cdn.brandfetch.io/${domain}/w/128/h/128`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ]
}

// BrandLogoImg — tries sources in order via onError waterfall, falls back to IB_LOGO
export function BrandLogoImg({ domain, className, style, onClick, title, onSrcChange, bust }) {
  const sources = domain ? buildLogoSources(domain, bust) : []
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(0) }, [domain, bust])
  const src = idx < sources.length ? sources[idx] : IB_LOGO
  useEffect(() => { onSrcChange && onSrcChange(src) }, [src])
  return (
    <img
      className={className}
      src={src}
      alt={title || 'logo'}
      style={style}
      title={title}
      onClick={onClick}
      referrerPolicy="no-referrer-when-downgrade"
      onError={() => setIdx((i) => i + 1)}
    />
  )
}

function downloadLogo(src) {
  if (src.startsWith('data:')) {
    const a = document.createElement('a')
    a.href = src
    a.download = 'logo.png'
    a.click()
  } else {
    fetch(src)
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'logo.png'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      })
      .catch(() => window.open(src, '_blank'))
  }
}

function extractDomain(url) {
  const s = url.trim().replace(/^https?:\/?\/?/i, '').replace(/^www\./i, '').split('/')[0].split('?')[0]
  try {
    return new URL('https://' + s).hostname.replace(/^www\./i, '')
  } catch (e) {
    return s
  }
}

const inCls =
  'w-full px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#141414] text-[#ddd] text-sm outline-none focus:border-accent'

export function BrandEdit({ onClose, onSaved }) {
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentSrc, setCurrentSrc] = useState('')

  useEffect(() => {
    fetch('/api/brand', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b) {
          setDomain(b.domain || localStorage.getItem('orgDomain') || '')
          setName(b.name || localStorage.getItem('orgName') || '')
        } else {
          setDomain(localStorage.getItem('orgDomain') || '')
          setName(localStorage.getItem('orgName') || '')
        }
      })
      .catch(() => {
        setDomain(localStorage.getItem('orgDomain') || '')
        setName(localStorage.getItem('orgName') || '')
      })
  }, [])

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const dm = extractDomain(domain)

  const save = async () => {
    setErr('')
    setBusy(true)
    try {
      const r = await fetch('/api/brand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: dm, name }),
      })
      if (!r.ok) {
        setErr('Could not save brand settings.')
        setBusy(false)
        return
      }
      localStorage.setItem('orgDomain', dm)
      localStorage.setItem('orgName', name)
      setBusy(false)
      onSaved && onSaved()
      onClose()
    } catch (e) {
      setErr('Network error — could not save.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-[380px] max-w-full bg-[#0e0e0e] border border-[#1e1e1e] rounded-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-4">
          <h2 className="text-sm font-semibold">Logo &amp; company name</h2>
          <span className="flex-1" />
          <button className="text-muted text-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <label className="block text-[11px] text-dim mb-1">Company domain</label>
        <input className={inCls} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="infoblox.com" autoFocus />

        <label className="block text-[11px] text-dim mt-3 mb-1">Display name</label>
        <input
          className={inCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          placeholder="Acme Corp"
        />

        <div className="flex items-center gap-2 mt-3">
          <BrandLogoImg
            domain={dm}
            title="logo preview"
            className="w-7 h-7 rounded object-contain bg-[#141414] p-0.5"
            onSrcChange={setCurrentSrc}
          />
          <span className="text-[11px] text-dim">{dm || 'preview'}</span>
          <span className="flex-1" />
          <button
            className="px-2 py-1 rounded-lg border border-[#2a2a2a] text-[11px] text-muted hover:text-txt hover:border-[#3a3a3a]"
            onClick={() => downloadLogo(currentSrc || IB_LOGO)}
          >
            Download
          </button>
        </div>

        {err && <div className="mt-2 text-xs text-crit">{err}</div>}

        <div className="flex gap-2 mt-4">
          <button
            className="flex-1 px-2.5 py-1.5 rounded-lg bg-accent border border-accent text-white text-sm disabled:opacity-50"
            onClick={save}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save brand'}
          </button>
          <button className="px-2.5 py-1.5 rounded-lg border border-[#2a2a2a] text-sm text-[#ddd]" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
