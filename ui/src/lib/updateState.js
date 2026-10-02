import { useSyncExternalStore } from 'react'

// ONE ANSWER TO "IS THERE A NEWER VERSION, AND IS IT INSTALLING?", read by the
// header's Update button and by the Settings sheet's Updates section.
//
// WHY IT IS HERE AND NOT IN EITHER COMPONENT. Each of them used to keep its own
// copy: the header asked on page load and every six hours, the sheet asked when
// you pressed "Check for updates". So the sheet could find version 3.56.0 and
// tell you to use the button at the top, and that button — which had not heard —
// was not there until you reloaded the page. A module-level store with
// useSyncExternalStore is what lib/density.js already does for the same reason:
// the value has to outlive whichever component happens to be mounted.
//
// Endpoints: GET /api/update/check -> {current,latest,available,url,selfUpdate}
//            POST /api/update/apply -> starts the swap + restart
//            GET /api/update/status -> {phase,pct,error} poll target

const fetchT = (url, opts, ms) => {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms || 8000)
  return fetch(url, { ...(opts || {}), signal: ac.signal, cache: 'no-store' }).finally(() =>
    clearTimeout(t)
  )
}

// info: the last /api/update/check answer, or null before the first one.
// phase: idle | applying | restarting | error.
let state = { info: null, phase: 'idle', error: '' }
const listeners = new Set()

function set(patch) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUpdate() {
  return useSyncExternalStore(subscribe, () => state)
}

// How many checks have been sent, and the number of the newest one whose
// answer is in `state.info`.
let asked = 0
let stored = 0

/**
 * Asks the server whether a newer version exists and stores the answer for
 * everything that is listening. `force` skips the server's own half-hour
 * memory (go/update.go). Resolves to the answer; rejects when the request never
 * landed, which is a different fact from the server saying its own request to
 * GitHub failed (that arrives as `info.error`).
 */
export async function checkForUpdate(force) {
  const mine = ++asked
  const r = await fetchT(force ? '/api/update/check?force=1' : '/api/update/check', null, 15000)
  const info = await r.json()
  // Answers can land out of order: an ordinary check still in flight when the
  // forced one is pressed would otherwise overwrite the fresher result.
  if (mine > stored) {
    stored = mine
    // Pressing the button is the operator asking to look again, so an earlier
    // failed install should not keep speaking over the new answer.
    set(force && state.phase === 'error' ? { info, phase: 'idle', error: '' } : { info })
  }
  return info
}

let applying = false

/** Downloads and installs the version in `state.info`, then reloads the page. */
async function applyUpdate() {
  if (applying) return
  applying = true
  set({ phase: 'applying', error: '' })
  const oldVer = (state.info && state.info.current) || ''
  let done = false
  const fail = (m) => {
    if (done) return
    done = true
    applying = false
    set({ phase: 'error', error: m || 'update failed' })
  }
  const confirmThenReload = () => {
    if (done) return
    set({ phase: 'restarting' })
    const deadline = Date.now() + 20000
    const probe = async () => {
      if (done) return
      try {
        const c = await fetchT('/api/update/check', null, 6000).then((x) => x.json())
        if (c && c.current && c.current !== oldVer) {
          done = true
          applying = false
          window.location.reload()
          return
        }
      } catch {
        // mid-restart — keep probing
      }
      if (Date.now() > deadline) {
        fail('update applied but could not confirm — refresh to verify the version')
        return
      }
      setTimeout(probe, 1500)
    }
    probe()
  }
  try {
    const r = await fetchT('/api/update/apply', { method: 'POST' }, 12000)
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      fail(j.error || 'HTTP ' + r.status)
      return
    }
    let lastPhase = 'starting'
    let lastChange = Date.now()
    const tick = async () => {
      if (done) return
      let s
      try {
        s = await fetchT('/api/update/status', null, 8000).then((x) => x.json())
      } catch {
        confirmThenReload()
        return
      }
      if (done) return
      if (s.phase === 'error') {
        fail(s.error)
        return
      }
      if (s.phase === 'done' || s.pct >= 100) {
        confirmThenReload()
        return
      }
      if (s.running === false && (!s.phase || s.phase === 'idle')) {
        confirmThenReload()
        return
      }
      if (s.phase !== lastPhase) {
        lastPhase = s.phase
        lastChange = Date.now()
      } else if (Date.now() - lastChange > 180000) {
        fail('update stalled — refresh to check the version')
        return
      }
      setTimeout(tick, 1200)
    }
    setTimeout(tick, 1200)
  } catch {
    confirmThenReload()
  }
}

/**
 * What pressing an update button does: install in place when this copy can
 * update itself, otherwise open the release page.
 */
export function startUpdate() {
  const info = state.info
  if (!info) return
  if (info.selfUpdate) applyUpdate()
  else if (info.url) window.open(info.url, '_blank', 'noopener,noreferrer')
}
