// IP space choices for the older pages (Provision, Self-Service), in the same
// order the Automate page suggests them: yours first, then the most room, each
// with its reason. When the ranked list cannot be had, it is the plain list,
// so these pages work exactly as before.
import { useMemo } from 'react'
import { SHARE_PICKER, useApi } from './api.js'

export function useSpaceOptions() {
  const ranked = useApi('/api/desk/spaces')
  const plain = useApi('/api/ipam/spaces', SHARE_PICKER)
  const list = ranked.data?.spaces?.length ? ranked.data.spaces : null
  const options = useMemo(() => (list
    ? list.map((s) => ({ value: s.id, label: s.reason ? `${s.name || s.id} (${s.reason})` : (s.name || s.id), name: s.name, yours: s.yours }))
    : (plain.data?.spaces ?? []).map((s) => ({ value: s.id, label: s.name || s.id, name: s.name }))), [list, plain.data])
  return { options, loading: plain.loading && !list, error: list ? null : plain.error, top: list?.[0]?.yours ? list[0].id : '' }
}

// sizeWords is a prefix length in plain words: 24 -> "256 addresses".
export function sizeWords(prefix) {
  const n = Number(prefix)
  if (!Number.isInteger(n) || n < 1 || n > 32) return ''
  const total = 2 ** (32 - n)
  return total === 1 ? '1 address' : `${total.toLocaleString()} addresses`
}
