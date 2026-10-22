import { useSyncExternalStore } from 'react'

// The Build a chart tab's "Show cube names" switch: off shows plain names, on
// shows the real cube and field names so an engineer can copy them. Kept per
// browser. A plain .js module for the reason density.js is one: `npm test` is
// bare `node --test`, which cannot load .jsx.

const STORAGE_KEY = 'cubeNames'

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    // Private mode: the switch still works, it just isn't kept.
    return false
  }
}

let current = readStored()
const listeners = new Set()

export function getCubeNames() {
  return current
}

export function setCubeNames(next) {
  const on = next === true
  if (on === current) return
  current = on
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // See readStored.
  }
  for (const l of listeners) l()
}

export function subscribeCubeNames(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether cube names are showing, re-rendering the caller when it changes. */
export function useCubeNames() {
  return useSyncExternalStore(subscribeCubeNames, getCubeNames, getCubeNames)
}
