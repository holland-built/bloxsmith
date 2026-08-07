import { useSyncExternalStore } from 'react'

// Whole-app spacing mode, mirroring the theme mechanism next door: a value on
// <html> that CSS reads (`html[data-density="compact"]` in index.css), and a
// localStorage key so the choice outlives the tab.
//
// It is a plain .js module rather than a second React provider inside
// theme.jsx for two reasons. First, `npm test` is bare `node --test`, which
// cannot load a .jsx extension — services.js is here for the same reason — and
// the fallback direction below is the part most worth pinning. Second, the
// density has to be on <html> whether or not any component that cares is
// mounted: the switch also lives inside the Settings sheet, which only mounts
// while the sheet is open, so a provider-effect-driven version would be one
// unmount away from a page with no density on it at all.
//
// The fallback is one-directional on purpose. Comfortable is today's spacing to
// the pixel, so an unreadable or unrecognised stored value costs nothing;
// falling back to compact would silently re-space the whole app off a typo.

const STORAGE_KEY = 'density'

export const DENSITIES = ['comfortable', 'compact']
export const DEFAULT_DENSITY = 'comfortable'

/** Anything that is not one of DENSITIES is comfortable. */
export function normalizeDensity(raw) {
  return DENSITIES.includes(raw) ? raw : DEFAULT_DENSITY
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode, sandboxed iframe: the switch still works, it just stops
    // surviving a reload.
    return null
  }
}

let current = normalizeDensity(readStored())
const listeners = new Set()

function applyToDocument(density) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.density = density
}

// At import, not in an effect: the app bundle runs before React paints, so the
// stored density is on <html> for the first frame and there is no comfortable-
// then-compact flash to watch.
applyToDocument(current)

export function getDensity() {
  return current
}

export function setDensity(next) {
  const density = normalizeDensity(next)
  if (density === current) return
  current = density
  try {
    localStorage.setItem(STORAGE_KEY, density)
  } catch {
    // See readStored: unusable storage costs stickiness, not the change.
  }
  applyToDocument(density)
  for (const l of listeners) l()
}

export function subscribeDensity(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current density, re-rendering the caller when it changes. */
export function useDensity() {
  return useSyncExternalStore(subscribeDensity, getDensity, getDensity)
}
