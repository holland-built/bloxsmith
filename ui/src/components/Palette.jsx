import { useEffect, useMemo, useRef, useState } from 'react'
import { classifyIndicator } from '../lib/indicator.js'
import { FOCUS_RING } from './ui.jsx'

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
  // Where focus was when the palette opened, and whether picking a result has
  // already sent it elsewhere (a tab change moves focus to the page itself).
  const openerRef = useRef(null)
  const pickedRef = useRef(false)

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
    if (open) {
      openerRef.current = document.activeElement
      inputRef.current?.focus()
    } else {
      if (!pickedRef.current) openerRef.current?.focus?.()
      pickedRef.current = false
      openerRef.current = null
    }
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

  // The highlighted row stays in view as ↑/↓ move through a long list.
  useEffect(() => {
    if (!open || !hits[idx]) return
    document.getElementById(`palette-opt-${hits[idx].id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, idx, hits])

  if (!open) return null

  function pick(t) {
    pickedRef.current = true
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
        className="w-[420px] max-w-full rounded-surface border border-border bg-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0) }}
          onKeyDown={(e) => {
            // The input is the only tab stop in here, so Tab has nowhere to go
            // but out into the page behind the overlay.
            if (e.key === 'Tab') e.preventDefault()
            else if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0))
            else if (e.key === 'Enter' && hits[idx]) pick(hits[idx])
          }}
          placeholder="Search… (tabs, IP, hostname)"
          role="combobox"
          aria-label="Search tabs, IP or hostname"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={hits[idx] ? `palette-opt-${hits[idx].id}` : undefined}
          className={`w-full px-4 py-3 bg-transparent text-txt text-copy outline-none border-b border-line-2 ${FOCUS_RING}`}
        />
        <div id="palette-list" role="listbox" aria-label="Results" className="max-h-[300px] overflow-auto py-1">
          {hits.length === 0 && <div className="px-4 py-3 text-muted text-copy">no match</div>}
          {hits.map((t, i) => (
            <button
              key={t.id}
              id={`palette-opt-${t.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === idx}
              onClick={() => pick(t)}
              onMouseEnter={() => setIdx(i)}
              className={`w-full flex items-center justify-between gap-3 text-left px-4 py-2 text-copy ${i === idx ? 'bg-line text-txt ring-1 ring-inset ring-accent' : 'text-muted'}`}
            >
              <span className="truncate">{t.label}</span>
              {t.note && (
                <span className="shrink-0 font-mono text-note uppercase tracking-[0.09em] text-dim">{t.note}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
