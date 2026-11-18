// What a preview's free check read, and why it passed over any candidate, in
// plain words (lib/checkedWords.js). Imported only by the tabs that preview a
// network or address, not from kit.jsx, so it stays out of the entry chunk.
// An offered network or address that another IP space also uses gets an amber
// warning first, under the suggestion, in every preview that shows one.
// A preview that asks for a reverse (PTR) record also gets the server's amber
// note when no reverse zone covers the address (edit/reverse.go).
import { checkedWords } from '../lib/checkedWords.js'

export default function CheckedAgainst({ res }) {
  const w = checkedWords(res)
  const rn = res?.reverse_note && <p data-reverse-note="" role="status" className="mt-2 text-note text-warn">{res.reverse_note}</p>
  if (!w) return rn || null
  return (
    <>
      {rn}
      {w.shared.map((s, i) => (
        <p key={i} data-shared-warning="" role="status" className="mt-2 text-note text-warn">{s}</p>
      ))}
      <div data-checked-against="" className="mt-2 flex flex-col gap-0.5 text-note text-muted">
        <p>{w.checked}{w.age ? ` ${w.age}` : ''}</p>
        {w.skips.map((s, i) => <p key={i}>{s}</p>)}
        {w.more && <p>{w.more}</p>}
      </div>
    </>
  )
}
