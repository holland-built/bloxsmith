import { useSyncExternalStore } from 'react'

// Has this reader ever rearranged a panel?
//
// WHAT IT IS FOR. Overview's intro carries 30 words teaching drag-to-rearrange
// and answering "how do I save my layout" (the answer being that there is
// nothing to press). That is onboarding: it is worth a lot on the first visit
// and nothing on the four hundredth, and until now it sat permanently at the
// top of the app's main page. Once the gesture has actually been performed the
// sentence has done its job and goes away for good.
//
// WHY A SUCCESSFUL SAVE IS THE SIGNAL, not the drag itself. The sentence's
// claim is "your arrangement saves automatically". A drag whose save FAILED
// has not demonstrated that — it has demonstrated the opposite — so the tip
// stays up. The flag is set on the resolved half of the one commit path in
// CardGrid, which is also the only place that knows a save succeeded.
//
// WHY localStorage AND NOT THE SAVED LAYOUT ON THE SERVER. "Does a saved layout
// exist" is a tempting proxy and is the wrong one twice over: it is loaded
// asynchronously, so the tip would render and then vanish a moment later —
// a flash of text on every single page load, which is worse than the text — and
// a layout can exist for reasons other than a person dragging something. This
// is a fact about a reader, not about a tenant, so it lives with the reader.
//
// WHY IT IS A STORE AND NOT A useState. The flag is written deep inside
// CardGrid's save handler and read at the top of Overview, which is neither its
// parent nor its child. lib/api.js already solved exactly this shape with
// useSyncExternalStore for feed health; this is the same pattern, smaller.

const KEY = 'bx:arranged-once'

const listeners = new Set()
// Cached rather than read from localStorage on every render: getSnapshot must
// return a stable value while nothing has changed, or useSyncExternalStore
// re-renders forever.
let snapshot = read()

function read() {
  // Private browsing and storage-disabled builds throw on access rather than
  // returning null. Failing closed means the tip keeps showing, which is the
  // safe direction: a reader sees a sentence they have already read, rather
  // than losing the only place the app explains its own arranging.
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function hasArranged() {
  return snapshot
}

// Called once, from the success arm of CardGrid's save. Cheap to call again:
// after the first time it changes nothing and notifies nobody.
export function markArranged() {
  if (snapshot) return
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Storage refused. The flag still flips for this session, so the tip stops
    // repeating itself while the reader is here; it simply returns next time.
  }
  snapshot = true
  for (const l of listeners) l()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useHasArranged() {
  // The server snapshot is `false`, i.e. "show the tip". There is no
  // server-side render in this app today, and if there ever is, showing a
  // first-timer's tip is the correct thing to send to someone we know nothing
  // about.
  return useSyncExternalStore(subscribe, hasArranged, () => false)
}

// Tests only — module state outlives a single test otherwise.
export function resetArrangedForTests() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* nothing to clear */ }
  snapshot = false
  for (const l of listeners) l()
}
