// Network sizes in plain words. A prefix like /24 means nothing to most
// people, so the screen says how many addresses it is, and size boxes ask how
// many devices need an address. API payloads still carry the prefix number.

const n = (v) => (v === '' || v == null ? NaN : Number(v))

// addressCount is the total number of addresses in a prefix: 24 -> 256.
// IPv6 (family 6) returns a BigInt, because /64 is past what a Number holds.
export function addressCount(prefix, family = 4) {
  const p = n(prefix)
  const bits = family === 6 ? 128 : 32
  if (!Number.isInteger(p) || p < (family === 6 ? 0 : 1) || p > bits) return null
  return family === 6 ? 2n ** BigInt(bits - p) : 2 ** (bits - p)
}

// usableCount is how many devices fit: the total less the network and
// broadcast addresses. /31 is a two-address link and /32 a single host.
export function usableCount(prefix) {
  const total = addressCount(prefix)
  if (total == null) return null
  return total <= 2 ? total : total - 2
}

// prefixForDevices is the smallest IPv4 network with room for that many
// devices: 180 -> 24. It never picks /31 or /32, so 1 or 2 devices get a /30.
// Null when the count is not a whole number from 1 up.
export function prefixForDevices(devices) {
  const d = n(devices)
  if (!Number.isInteger(d) || d < 1) return null
  for (let p = 30; p >= 1; p--) if (usableCount(p) >= d) return p
  return null
}

const count = (total) => (total === 1 || total === 1n ? '1 address' : `${total.toLocaleString('en-US')} addresses`)

// sizeWords is a prefix length in plain words: 24 -> "256 addresses".
// Pass family 6 for an IPv6 prefix.
export function sizeWords(prefix, family = 4) {
  const total = addressCount(prefix, family)
  return total == null ? '' : count(total)
}

// validPrefix is the typed size if it is a whole number the family allows,
// else ''. A size box must never hand 24.5 to the server, which would cut it to 24.
export function validPrefix(v, family = 4) {
  const p = n(v)
  return Number.isInteger(p) && p >= 1 && p <= (family === 6 ? 128 : 32) ? String(p) : ''
}

// sizeLine says what a size gives you: "/24: 256 addresses, 254 usable by devices".
export function sizeLine(prefix) {
  const total = addressCount(prefix)
  if (total == null) return ''
  return `/${Number(prefix)}: ${count(total)}, ${usableCount(prefix).toLocaleString('en-US')} usable by devices`
}

// withSize adds the address count to a network written as address/prefix:
// "10.0.0.0/24" -> "10.0.0.0/24 (256 addresses)". Anything else comes back as is.
export function withSize(network) {
  const s = network == null ? '' : String(network)
  const m = s.match(/^(\S+)\/(\d{1,3})$/)
  if (!m) return s
  const total = addressCount(m[2], m[1].includes(':') ? 6 : 4)
  return total == null ? s : `${s} (${count(total)})`
}
