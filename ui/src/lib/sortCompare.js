// The one comparison the tables sort by.
//
// Text is compared with digit runs read as numbers. A plain string compare
// puts "10.1.2.10" before "10.1.2.9" and "host-10" before "host-2", which is
// alphabetical and is not the order anyone managing addresses or numbered
// hosts expects; the Network column sorted that way until 2026-10-03.
//
// A missing value sorts before everything in ascending order (so last in
// descending), which is what the table has always done. It is handled here
// rather than left to the text compare, where null became the word "null" and
// landed between "node" and "ops" — and, in the descending branch of the
// controlled sort, threw.
//
// Plain .js so `npm test` (bare node --test) can import it.

const text = new Intl.Collator(undefined, { numeric: true })

export function compareCells(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return text.compare(String(a), String(b))
}

// Sort a copy of `rows` by a controlled {key,dir} sort using a per-key accessor
// map ({ key: (row) => value }), so callers stop re-implementing the branch.
// Falls back to row[key] for unmapped keys.
export function sortRows(rows, sort, accessors) {
  if (!sort || !sort.key) return rows
  const { key, dir } = sort
  const get = accessors[key] || ((r) => r[key])
  return [...rows].sort((a, b) => {
    const r = compareCells(get(a), get(b))
    return dir === 'asc' ? r : -r
  })
}
