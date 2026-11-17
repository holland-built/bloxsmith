// What a preview's free check read, and why it passed over any candidate, in
// plain words (lib/checkedWords.js). Imported only by the tabs that preview a
// network or address, not from kit.jsx, so it stays out of the entry chunk.
import { checkedWords } from '../lib/checkedWords.js'

export default function CheckedAgainst({ res }) {
  const w = checkedWords(res)
  if (!w) return null
  return (
    <div data-checked-against="" className="mt-2 flex flex-col gap-0.5 text-note text-muted">
      <p>{w.checked}{w.age ? ` ${w.age}` : ''}</p>
      {w.skips.map((s, i) => <p key={i}>{s}</p>)}
      {w.more && <p>{w.more}</p>}
    </div>
  )
}
