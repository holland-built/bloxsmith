import { useRef, useState } from 'react'
import { FIELD_CLS } from './ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'

// Shared by Provision and Self-Service, the two forms that pick from lists
// long enough to need a search (hundreds of spaces, hundreds of subnets).
const inputCls = `${FIELD_CLS} w-full`

const RESULTS_CAP = 50

// A dropdown with a search box above it. A tenant can have hundreds of IP
// spaces (801 on the live one, 2026-09-25), which made the plain list a long
// scroll. Typing narrows the options; the list itself stays a native <select>,
// so keyboard use and screen readers work as they did.
//
// The chosen option always stays in the list, even when the search no longer
// matches it, so narrowing the search never silently changes the selection.
export default function FilterSelect({ label, value, onChange, options, placeholder, disabled }) {
  const [q, setQ] = useState('')
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const needle = q.trim().toLowerCase()
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options
  const chosen = value && !shown.some((o) => o.value === value) ? options.find((o) => o.value === value) : null
  // The matches, shown as you type so nobody has to open the dropdown to see
  // them. Capped for the page's sake; the dropdown below still holds every match.
  const results = needle && !disabled ? shown.slice(0, RESULTS_CAP) : []
  const pick = (v) => {
    onChange(v)
    setQ('')
    // The list goes away with the search, so focus goes back to the box rather
    // than falling to the page.
    inputRef.current?.focus()
  }
  const buttons = () => [...(listRef.current?.querySelectorAll('button') ?? [])]
  const clear = () => { setQ(''); inputRef.current?.focus() }
  const onListKey = (e) => {
    const all = buttons()
    const i = all.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); all[Math.min(i + 1, all.length - 1)]?.focus() }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i <= 0) inputRef.current?.focus()
      else all[i - 1].focus()
    }
    else if (e.key === 'Escape') { e.preventDefault(); clear() }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <input {...MACHINE_TEXT}
        ref={inputRef}
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Type to search ${options.length.toLocaleString()} ${options.length === 1 ? 'option' : 'options'}`}
        className={inputCls}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); buttons()[0]?.focus() }
          else if (e.key === 'Enter') { e.preventDefault(); if (results.length) pick(results[0].value) }
          else if (e.key === 'Escape' && q) { e.preventDefault(); clear() }
        }}
        disabled={disabled || options.length === 0}
      />
      {results.length > 0 && (
        <ul ref={listRef} aria-label={`Matching ${label.toLowerCase()}`} onKeyDown={onListKey} className="flex flex-col max-h-[240px] overflow-y-auto rounded-control border border-border bg-field">
          {results.map((o, i) => (
            <li key={`${i}:${o.value}`}>
              <button
                type="button"
                onClick={() => pick(o.value)}
                aria-current={o.value === value ? 'true' : undefined}
                className={`w-full text-left text-copy px-3 py-1.5 hover:bg-line focus-visible:bg-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${o.value === value ? 'font-semibold text-txt' : 'text-field-txt'}`}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Said out loud as the matches change, since a list appearing is silent.
          Kept in the page with no search, only hidden, because a live region
          that appears already holding its text is announced unreliably. */}
      <span role="status" className={needle ? 'text-note text-dim' : 'sr-only'}>
        {!needle ? '' : shown.length === 0
          ? `No ${label.toLowerCase()} matches “${q.trim()}”.`
          : shown.length > RESULTS_CAP
            ? `Showing ${RESULTS_CAP} of ${shown.length.toLocaleString()} matches. Keep typing to narrow it, or use the list below.`
            : `${shown.length.toLocaleString()} ${shown.length === 1 ? 'match' : 'matches'}.`}
      </span>
      <select aria-label={label} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{needle ? `${placeholder} (${shown.length.toLocaleString()} of ${options.length.toLocaleString()} match)` : placeholder}</option>
        {chosen && <option value={chosen.value}>{chosen.label}</option>}
        {/* Index in the key: two spaces can share a name, and the site and seed
            pickers use the name as the value. */}
        {shown.map((o, i) => <option key={`${i}:${o.value}`} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
