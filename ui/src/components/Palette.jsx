import { useEffect, useMemo, useRef, useState } from 'react'

/** ⌘K command palette — tab jump. Fixed overlay, escapes all card clipping. */
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
    const s = q.trim().toLowerCase()
    return tabs.filter((t) => !s || t.label.toLowerCase().includes(s) || t.id.includes(s))
  }, [tabs, q])

  if (!open) return null

  function pick(t) {
    setOpen(false)
    onPick(t.id)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <div
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
          placeholder="Jump to tab…"
          className="w-full px-4 py-3 bg-transparent text-txt text-sm outline-none border-b border-line-2"
        />
        <div className="max-h-[300px] overflow-auto py-1">
          {hits.length === 0 && <div className="px-4 py-3 text-muted text-sm">no match</div>}
          {hits.map((t, i) => (
            <button
              key={t.id}
              onClick={() => pick(t)}
              onMouseEnter={() => setIdx(i)}
              className={`w-full text-left px-4 py-2 text-sm ${i === idx ? 'bg-line text-txt' : 'text-muted'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
