import { useId, useState } from 'react'
import { FIELD_CLS } from './ui.jsx'
import { oneBoxTarget } from '../lib/oneBox.js'

// One box for the two things people type: something to look up (an IP, a
// subnet, a name) and a question. lib/oneBox.js decides where Enter goes, and
// the hint says so before Enter is pressed.
export default function OneBox({ big = false, autoFocus = false }) {
  const id = useId()
  const [v, setV] = useState('')
  const target = oneBoxTarget(v)
  return (
    <form
      role="search"
      aria-label="Search or ask"
      onSubmit={(e) => {
        e.preventDefault()
        if (target) location.hash = target.hash
      }}
      className="w-full"
    >
      <label htmlFor={id} className="sr-only">Search or ask</label>
      <div className="relative">
        <input
          id={id}
          data-onebox=""
          autoFocus={autoFocus}
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder={big ? 'An IP, a subnet, a name, or a question' : 'Search or ask'}
          aria-describedby={target ? `${id}-hint` : undefined}
          className={`${FIELD_CLS} w-full ${big ? 'h-12 px-4' : 'h-9'} ${target && !big ? 'pr-36' : ''}`}
        />
        {target && (
          <span
            id={`${id}-hint`}
            className={big ? 'block mt-1.5 text-note text-accent' : 'absolute right-3 top-1/2 -translate-y-1/2 text-note text-accent pointer-events-none'}
          >
            Enter: {target.says}
          </span>
        )}
      </div>
    </form>
  )
}
