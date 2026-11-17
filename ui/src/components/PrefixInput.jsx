// The exact network-size box. Only the Editor uses it, so it lives in its own
// file and stays out of the entry chunk that every page downloads.
import { useState } from 'react'
import { FIELD_CLS } from './ui.jsx'
import { MACHINE_TEXT } from '../lib/machineText.js'
import { sizeWords, validPrefix } from '../lib/sizes.js'

// A network size typed as the number after the slash, for sizes that must be
// exact: finding an existing network, or an IPv6 one. The line under it says
// how many addresses that is.
export function PrefixInput({ prefix, onPrefix, family = 4, label = 'Size: the number after the slash', required = false, disabled, title }) {
  const [typed, setTyped] = useState(null)
  const current = String(prefix ?? '')
  // Show what was typed; the form only ever holds a whole, in-range size.
  const shown = typed !== null && validPrefix(typed, family) === current ? typed : current
  const bad = shown !== '' && validPrefix(shown, family) === ''
  const words = !bad && current ? sizeWords(current, family) : ''
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-note text-muted">
        <span>{label}{required ? ' *' : ''}</span>
        <input {...MACHINE_TEXT} type="number" min="1" max={family === 6 ? 128 : 32} step="1" inputMode="numeric"
          className={`${FIELD_CLS} w-full disabled:opacity-60`} placeholder={family === 6 ? '64' : '24'}
          value={shown} disabled={disabled} title={title} data-prefix-input=""
          onChange={(e) => { setTyped(e.target.value); onPrefix(validPrefix(e.target.value, family)) }} />
      </label>
      {bad && <p data-size-words="" aria-live="polite" className="text-note text-warn">Enter a whole number from 1 to {family === 6 ? 128 : 32}.</p>}
      {words && <p data-size-words="" aria-live="polite" className="text-note text-muted">/{current} is {words}</p>}
    </div>
  )
}
