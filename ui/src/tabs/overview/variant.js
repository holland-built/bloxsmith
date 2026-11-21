import { useEffect, useState } from 'react'

export const LOOKS = ['a', 'b', 'c']

// Which trial look the address asks for. Both /?variant=a and #overview?variant=a
// work, and the part after # wins because that is what the switcher writes.
// "none" is today's page with the switcher still showing. Anything else,
// including no variant at all, is today's page with nothing added.
export function readVariant(hash, search) {
  const inHash = String(hash || '').split('?')[1]
  const raw = new URLSearchParams(inHash || '').get('variant') ?? new URLSearchParams(search || '').get('variant')
  if (raw === 'none') return { look: null, switcher: true }
  return LOOKS.includes(raw) ? { look: raw, switcher: true } : { look: null, switcher: false }
}

export function useVariant() {
  const [variant, setVariant] = useState(() => readVariant(location.hash, location.search))
  useEffect(() => {
    const on = () => setVariant(readVariant(location.hash, location.search))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return variant
}
