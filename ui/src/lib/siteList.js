// Reads domains out of pasted text or a CSV file for Site lists.
//
// Pasted text: one domain per line, or separated by commas or spaces.
// CSV: the first cell of each row that looks like a domain; a first row that
// holds no domain is taken as the header and skipped. Everything else that is
// not a domain is returned in `bad`, so the page can say what it left out
// instead of dropping it quietly. The server checks every domain again.

// Same rule as the server's isFQDN: two or more labels, a letters-only TLD.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
export function isDomain(s) {
  if (!s || s.length > 253) return false
  const labels = s.split('.')
  if (labels.length < 2) return false
  const tld = labels[labels.length - 1]
  if (!/^[a-z]{2,63}$/.test(tld)) return false
  return labels.every((l) => LABEL.test(l))
}

const clean = (s) => String(s).trim().replace(/^["']|["']$/g, '').trim().toLowerCase().replace(/\.$/, '')

function collect(cells) {
  const seen = new Set()
  const domains = []
  const bad = []
  for (const c of cells) {
    const d = clean(c)
    if (!d) continue
    if (isDomain(d)) {
      if (!seen.has(d)) { seen.add(d); domains.push(d) }
    } else bad.push(String(c).trim())
  }
  return { domains, bad }
}

export function parsePasted(text) {
  return collect(String(text || '').split(/[\s,;]+/))
}

export function parseCsv(text) {
  const rows = String(text || '').split(/\r?\n/).filter((r) => r.trim())
  const first = (row) => clean(row.split(/[,;\t]/)[0])
  const cells = rows.map(first)
  if (cells.length && !isDomain(cells[0])) cells.shift()
  return collect(cells)
}
