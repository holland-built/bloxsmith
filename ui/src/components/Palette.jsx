import { useEffect, useMemo, useRef, useState } from 'react'
import { classifyIndicator } from '../lib/indicator.js'

/**
 * ⌘K command palette — tab jump, plus estate search. Fixed overlay, escapes all
 * card clipping.
 *
 * The only thing that changed for estate search is the RESULT LIST. Opening,
 * closing, focus, ↑/↓ and Enter are untouched, and so is the tab filter: an
 * empty query still lists every tab, and a tab-name query still returns exactly
 * the tabs it used to. The indicator row is PREPENDED and only when
 * classifyIndicator() recognises the trimmed query as an IP or a hostname —
 * which is why typing "dns" or "overview" cannot produce one (see
 * lib/indicator.test.js, where every tab-shaped string is asserted to classify
 * as null).
 */
export default function Palette({ tabs, onPick }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    const on = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQ('')
        setIdx(0)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const hits = useMemo(() => {
    const raw = q.trim()
    const s = raw.toLowerCase()
    const tabHits = tabs.filter((t) => !s || t.label.toLowerCase().includes(s) || t.id.includes(s))
    const kind = classifyIndicator(raw)
    if (!kind) return tabHits
    return [
      {
        id: 'estate-search',
        label: `Search estate for ${raw}`,
        note: kind.label,
        hash: `dossier?q=${encodeURIComponent(raw)}`,
      },
      ...tabHits,
    ]
  }, [tabs, q])

  if (!open) return null

  function pick(t) {
    setOpen(false)
    // A tab still goes through onPick, so App.jsx keeps owning tab navigation.
    // Only the indicator row carries its own hash, and only it bypasses onPick.
    if (t.hash) window.location.hash = t.hash
    else onPick(t.id)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[420px] rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0))
            else if (e.key === 'Enter' && hits[idx]) pick(hits[idx])
          }}
          placeholder="Search… (tabs, IP, hostname)"
          aria-activedescendant={hits[idx] ? `palette-opt-${hits[idx].id}` : undefined}
          className="w-full px-4 py-3 bg-transparent text-txt text-sm outline-none border-b border-line-2"
        />
        <div role="listbox" className="max-h-[300px] overflow-auto py-1">
          {hits.length === 0 && <div className="px-4 py-3 text-muted text-sm">no match</div>}
          {hits.map((t, i) => (
            <button
              key={t.id}
              id={`palette-opt-${t.id}`}
              role="option"
              aria-selected={i === idx}
              onClick={() => pick(t)}
              onMouseEnter={() => setIdx(i)}
              className={`w-full flex items-center justify-between gap-3 text-left px-4 py-2 text-sm ${i === idx ? 'bg-line text-txt' : 'text-muted'}`}
            >
              <span className="truncate">{t.label}</span>
              {t.note && (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.09em] text-dim">{t.note}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
