import { useSyncExternalStore } from 'react'

// How often the screen's data reloads by itself, remembered per browser. The
// same shape as density.js, and a plain .js module for the same reason: `npm
// test` is bare `node --test`, which cannot load a .jsx file.
//
// The fallback is 30 sec because that leaves every feed's interval exactly as
// it was before this choice existed.

const STORAGE_KEY = 'refreshEvery'

export const REFRESH_CHOICES = [
  { value: '30s', label: '30 sec', ms: 30_000 },
  { value: '1m', label: '1 min', ms: 60_000 },
  { value: '5m', label: '5 min', ms: 300_000 },
  { value: '15m', label: '15 min', ms: 900_000 },
  { value: 'off', label: 'Off', ms: null },
]
export const DEFAULT_REFRESH = '30s'

// A feed that polls faster than the shortest choice is following something
// happening now, so the choice never slows it.
const FAST_FEED_MS = 30_000

/** Anything that is not one of REFRESH_CHOICES is the default. */
export function normalizeRefresh(raw) {
  return REFRESH_CHOICES.some((c) => c.value === raw) ? raw : DEFAULT_REFRESH
}

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode, sandboxed iframe, or no browser: the choice still works, it
    // just stops surviving a reload.
    return null
  }
}

let current = normalizeRefresh(readStored())
const listeners = new Set()

export function getRefresh() {
  return current
}

/** The chosen interval in ms, or null when automatic refresh is off. */
export function getRefreshMs() {
  return REFRESH_CHOICES.find((c) => c.value === current).ms
}

export function setRefresh(next) {
  const value = normalizeRefresh(next)
  if (value === current) return
  current = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // See readStored: unusable storage costs stickiness, not the change.
  }
  for (const l of listeners) l()
}

export function subscribeRefresh(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current choice, re-rendering the caller when it changes. */
export function useRefreshChoice() {
  return useSyncExternalStore(subscribeRefresh, getRefresh, getRefresh)
}

/**
 * How often this feed should load, or null if it should not load by itself.
 * Live feeds and feeds under 30 sec keep their own interval whatever the
 * choice; every other feed runs at the slower of its own interval and the choice.
 */
export function feedIntervalMs(poll, live, choiceMs) {
  if (live || poll < FAST_FEED_MS) return poll
  if (choiceMs === null) return null
  return Math.max(poll, choiceMs)
}

/** Has this feed's interval passed, counted in ticks of its own poll timer? */
export function isFeedDue(ticks, poll, live, choiceMs) {
  const every = feedIntervalMs(poll, live, choiceMs)
  return every !== null && ticks * poll >= every
}
