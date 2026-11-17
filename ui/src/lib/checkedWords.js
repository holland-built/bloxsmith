// checkedWords turns a preview's "checked" and "skipped" fields into plain
// sentences: what the free check read, which candidates it passed over and why,
// and how old the read was when it came from the 2-minute cache
// (go/internal/freecheck). Site, block and seed results name their list
// skipped_picks, because "skipped" there already says whether the site was
// skipped. Null when there is nothing to say, including a check that failed,
// which shows its own message.

const MAX_SKIPS = 3
// Under this many seconds the read is fresh, so no age is given; the same line
// freecheck's Counts.Age draws.
const FRESH_SECONDS = 5

const fmt = (n) => Number(n || 0).toLocaleString('en-US')
const count = (n, one, many) => `${fmt(n)} ${Number(n) === 1 ? one : many}`
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`)

export function checkedWords(res) {
  const c = res?.checked
  if (!c || typeof c !== 'object' || res.check_failed) return null

  const parts = []
  if (Number(c.networks) > 0) parts.push(`networks in ${count(c.spaces, 'IP space', 'IP spaces')}`)
  parts.push(count(c.ranges, 'DHCP range', 'DHCP ranges'))
  parts.push(count(Number(c.reservations || 0) + Number(c.hosts || 0), 'reservation or host', 'reservations and hosts'))

  const list = Array.isArray(res.skipped) ? res.skipped : Array.isArray(res.skipped_picks) ? res.skipped_picks : []
  const skips = list.slice(0, MAX_SKIPS).map((s) => sentence(`Skipped ${s?.candidate} because ${s?.reason}`))
  const extra = list.length - skips.length

  let age = ''
  const secs = Number(c.age_seconds)
  if (Number.isFinite(secs) && secs >= FRESH_SECONDS) {
    age = secs < 120 ? `Checked ${secs} seconds ago.` : `Checked ${Math.floor(secs / 60)} minutes ago.`
  }

  return {
    checked: `Checked against: ${parts.join(', ')}.`,
    skips,
    more: extra > 0 ? `And ${extra} more.` : '',
    age,
  }
}
