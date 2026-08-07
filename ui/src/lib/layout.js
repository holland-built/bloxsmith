// Layout persistence — order + column span only, never pixels (items 6 + 7).
//
// WHY THE SCHEMA IS SHAPED LIKE THIS. `ViewWrite`
// (go/internal/store/store.go:154-161) builds its stored record from an
// explicit whitelist — name, widgets, order, layout, folder, saved_at — and
// silently discards every other top-level key. So a blob shaped
// `{name, version, spans}` would POST with `{"ok":true}` and read back with
// version and spans gone. `order` therefore sits top-level, and `version` and
// `spans` nest INSIDE `layout`. Verified by hand against the live endpoint
// before this file was written: a POST carrying an extra top-level `bogus` key
// came back from GET as `{folder, layout, name, order, saved_at, widgets}`
// with `bogus` absent.
//
// TWO VALIDATORS, NOT ONE — save and load are asymmetric. `ViewRead` hands
// back that whole record, so a strict "no unknown top-level keys" rule applied
// on load would reject every layout the server ever returns.

export const LAYOUT_VERSION = 1

// The grid is grid-cols-2 md:4 xl:6 (ui.jsx), so 6 is the widest span that has
// any meaning. A span outside 1-6, or a non-integer one, is not a column count.
export const MIN_SPAN = 1
export const MAX_SPAN = 6

export function layoutViewName(tabId) {
  return `__layout_${tabId}`
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function bad(error) {
  return { ok: false, error }
}

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k))
}

// The payload check both validators share: `order` and `layout` only, integer
// spans in range, and nothing else at either level. This is where a pixel
// offset would have to live, so this is where it is made unrepresentable.
function checkPayload(payload) {
  const extra = extraKeys(payload, ['order', 'layout'])
  if (extra.length) return bad(`unknown payload key(s): ${extra.join(', ')}`)

  const { order, layout } = payload
  if (!Array.isArray(order)) return bad('order must be an array')
  if (order.some((id) => typeof id !== 'string' || id === '')) {
    return bad('order must hold non-empty panel id strings')
  }
  if (new Set(order).size !== order.length) return bad('order must not repeat a panel id')

  if (!isPlainObject(layout)) return bad('layout must be an object')
  const layoutExtra = extraKeys(layout, ['version', 'spans'])
  if (layoutExtra.length) return bad(`unknown layout key(s): ${layoutExtra.join(', ')}`)
  if (layout.version !== LAYOUT_VERSION) return bad(`layout.version must be ${LAYOUT_VERSION}`)

  const spans = layout.spans
  if (!isPlainObject(spans)) return bad('layout.spans must be an object')
  for (const [id, span] of Object.entries(spans)) {
    if (id === '') return bad('layout.spans key must be a non-empty panel id')
    if (typeof span !== 'number' || !Number.isInteger(span)) {
      return bad(`span for "${id}" must be an integer, got ${JSON.stringify(span)}`)
    }
    if (span < MIN_SPAN || span > MAX_SPAN) {
      return bad(`span for "${id}" must be ${MIN_SPAN}-${MAX_SPAN}, got ${span}`)
    }
  }
  return { ok: true }
}

// validateSave — STRICT. Exactly {name, order, layout:{version, spans}}, no
// extra key at either level. Called before every POST, so nothing the layout
// path writes can carry a pixel.
export function validateSave(blob) {
  if (!isPlainObject(blob)) return bad('blob must be an object')
  const extra = extraKeys(blob, ['name', 'order', 'layout'])
  if (extra.length) return bad(`unknown top-level key(s): ${extra.join(', ')}`)
  if (typeof blob.name !== 'string' || blob.name.trim() === '') return bad('name required')
  return checkPayload({ order: blob.order, layout: blob.layout })
}

// parseLoad — tolerant of the envelope, strict about the payload. ViewWrite
// stamps widgets/folder/saved_at onto every record whether the caller sent
// them or not, so rejecting unknown TOP-LEVEL keys here would reject every
// layout the server has ever returned. The payload is checked exactly as
// strictly as on save, so an unknown key inside `layout` — where a smuggled
// pixel offset would live — still falls back to the unsaved default.
//
// Returns {order, spans}, or null for "there is no usable saved layout",
// which every caller renders as today's untouched layout.
export function parseLoad(record) {
  if (!isPlainObject(record)) return null
  const payload = { order: record.order, layout: record.layout }
  if (!checkPayload(payload).ok) return null
  return { order: [...payload.order], spans: { ...payload.layout.spans } }
}

// clampSpan — a render concern, never a storage one.
//
// SPAN_CLASS (ui.jsx) is deliberately responsive: a declared span 6 renders
// col-span-2 on the base 2-track grid, md:col-span-4, xl:col-span-6. Writing a
// saved `span 6 / span 6` inline at 390px would ask for 6 of 2 tracks, which
// creates implicit columns and overflows the page horizontally. So the saved
// span is stored exactly as the operator chose it and clamped only against the
// track count read live from the grid — widening the window then restores
// their intent instead of having silently destroyed it.
export function clampSpan(span, trackCount) {
  return Math.max(MIN_SPAN, Math.min(span, trackCount))
}

// resolveSpan — the single precedence rule: user span > measured need >
// declared span. applyLayout has one write site for el.style.gridColumn and
// the user override writes the same property, so without this the two race
// each other re-applying. `span: null` means "write nothing", which leaves the
// declared SPAN_CLASS in charge — the byte-identical path for every panel that
// neither measures nor carries an override.
export function resolveSpan({ userSpan = null, measuredSpan = null, trackCount }) {
  if (userSpan != null) return { source: 'user', span: clampSpan(userSpan, trackCount) }
  if (measuredSpan != null) return { source: 'measured', span: clampSpan(measuredSpan, trackCount) }
  return { source: 'declared', span: null }
}

// ---------- item 8: the maths behind the pointer, kept out of the browser ----------
//
// Everything a drag or a resize has to DECIDE lives here as a pure function,
// so the browser test only has to prove the wiring. That split is deliberate:
// pointer-event tests are slow and brittle, and an arithmetic bug found in a
// Playwright run costs an order of magnitude more to diagnose than the same
// bug found by `node --test`.

// spanFromWidth — the inverse of applyLayout's widthOf(). A span-s item is
// s tracks plus the (s-1) gaps it swallows, i.e. s*(track+gap) - gap, so the
// span a dragged width wants is (px + gap) / (track + gap), rounded.
//
// Rounded, not floored: floor makes the card feel like it lags a track behind
// the pointer, because the edge only snaps once the pointer has passed the
// full next track. Rounding snaps at the halfway point, which is where the
// user's eye already put the boundary.
//
// The result is always a whole number in 1..trackCount — there is no code path
// through this function that yields a fraction, which is what makes "whole
// integers only" a property of the arithmetic rather than of a later check.
export function spanFromWidth(px, track, gap, trackCount) {
  // A grid whose computed style has not resolved yet (display:none, a tab that
  // has not painted) reports track 0 or NaN. Guarding on `track`, not on
  // track+gap: a zero track with a real gap still divides cleanly and would
  // hand back a confident, meaningless span (400px / a 12px "step" = 6).
  // Returning the minimum beats propagating that, or a NaN, into a saved span.
  if (!(track > 0) || !(trackCount >= 1)) return MIN_SPAN
  const step = track + (gap > 0 ? gap : 0)
  const s = Math.round((px + gap) / step)
  return Math.max(MIN_SPAN, Math.min(s, trackCount))
}

// stepSpan — keyboard width change. Clamped to the STORED range 1-6, not to
// the live track count: the same reason clampSpan exists separately. Pressing
// Up at 390px must still be able to record "6 columns wide", to be honoured
// when the window is wide enough to show it.
export function stepSpan(span, delta) {
  return Math.max(MIN_SPAN, Math.min(MAX_SPAN, span + delta))
}

// widthAnnouncement — what an arrow press tells a screen reader, which must be
// what the operator will ACTUALLY get at the breakpoint they are on.
//
// stepSpan deliberately stores the span unclamped (see its comment), so at
// 390px a card can hold 6 and render 2. Announcing the stored number there was
// measured saying the wrong thing twice in a row: at 390 with 2 tracks,
// ArrowUp announced "Width 3 of 6 columns" and then "Width 4 of 6 columns"
// while the card stayed 342px wide both times — the only channel that user has
// reported a change that did not happen.
//
// So the rendered width leads, and the stored intent is named separately
// rather than dropped: "Set to 4" is true, it is simply not in effect yet, and
// hiding it would make widening the window look like a bug of its own.
//
// A grid whose computed style has not resolved reports no track count at all;
// there is then no honest denominator, so none is claimed.
export function widthAnnouncement(storedSpan, trackCount) {
  if (!(trackCount >= 1)) return `Width ${storedSpan} columns`
  const shown = clampSpan(storedSpan, trackCount)
  const base = `Width ${shown} of ${trackCount} columns`
  return shown === storedSpan ? base : `${base}. Set to ${storedSpan}, which needs a wider window.`
}

// unseenPanelIds — the panels a saved order can record but never restore.
//
// CardGrid reads the live order off the DOM (snapshot -> panelItems, which
// descends into a wrapper to find data-panel-id) but applies a saved order to
// the REACT children (sortByOrder, which reads props.panelId off the direct
// child and ranks anything without one last). A panel wrapped in a
// <HiddenPanels> fragment, or in a plain div carrying the span class, is
// visible to the first and invisible to the second — so the tab saves an order
// it cannot honour and pushes the whole wrapped run to the end on reload.
//
// The two are not made to compose here, and that is a decision rather than an
// omission: a hidden run collapses N panels into ONE grid child, so while it
// is collapsed there is no arrangement of N ids that describes what is on
// screen. What this does instead is compute the disagreement so the call site
// can refuse to answer silently.
//
// One-directional on purpose. A child naming a panel the DOM does not show is
// ordinary conditional rendering; only a panel the children cannot name breaks
// sorting.
export function unseenPanelIds(domIds, childIds) {
  const known = new Set(childIds.filter((id) => id != null))
  return domIds.filter((id) => !known.has(id))
}

// insertionIndex — which slot a drop at (x, y) is asking for, counted against
// the rects of the grid items IN THEIR CURRENT ORDER, including the card being
// dragged. The result is 0..rects.length, i.e. "insert before item n".
//
// The rule is reading order, and it is deliberately not "nearest centre".
// Nearest-centre picks a card and then has to guess which SIDE of it the drop
// meant, which reads as unpredictable at a row boundary — dropping in the gap
// between two rows would jump to whichever row happened to be a few pixels
// closer. Counting instead asks one yes/no question per card ("is this card
// before the pointer?") and produces a slot directly:
//
//   - the pointer is below the card entirely -> that card is before it
//   - the pointer is above the card entirely -> it is not (and nor is any
//     card after it, since the rects are in order)
//   - same row -> the card's horizontal midpoint decides
//
// so a drop anywhere in the dead space under the last row lands at the end,
// which is what dragging a panel "to the bottom" plainly means.
export function insertionIndex(rects, x, y) {
  let idx = 0
  for (const r of rects) {
    if (y > r.bottom) { idx++; continue }
    if (y < r.top) continue
    if (x > (r.left + r.right) / 2) idx++
  }
  return idx
}

// moveItem — the pointer drop. `to` is an insertionIndex, counted against the
// list that still CONTAINS the dragged card, so it has to be decremented once
// the card is pulled out of it. Getting that wrong is the classic drag-and-drop
// off-by-one: every rightward drop lands one slot short.
//
// Both slots that mean "where the card already is" (its own index, and the one
// immediately after it) therefore collapse to no move at all.
export function moveItem(order, from, to) {
  if (!Array.isArray(order) || from < 0 || from >= order.length) return order
  const next = [...order]
  const [item] = next.splice(from, 1)
  const at = Math.max(0, Math.min(to > from ? to - 1 : to, next.length))
  next.splice(at, 0, item)
  return next
}

// shiftItem — one arrow press. Separate from moveItem rather than expressed in
// terms of it: "move right one position" is `to = from + 2` in insertionIndex
// coordinates, which is exactly the confusing arithmetic moveItem's comment is
// about, and keyboard code should not have to know it.
//
// Returns the very same array when nothing moves, so pressing Left at
// position 0 does not re-render the grid or announce a move that did not
// happen.
export function shiftItem(order, id, delta) {
  if (!Array.isArray(order)) return order
  const from = order.indexOf(id)
  if (from < 0) return order
  const to = Math.max(0, Math.min(from + delta, order.length - 1))
  if (to === from) return order
  const next = [...order]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

// sortByOrder — rearranges the REAL children, never CSS `order`.
//
// CSS `order` moves boxes visually and leaves DOM order untouched: screen
// readers and Tab focus would still follow the original JSX order, P8's "the
// card DOM order matches the saved order" would be unsatisfiable, and item 8's
// keyboard move mode would announce a position assistive tech cannot observe.
//
// A stable sort on rank, where rank is the panel's index in the saved order
// and Infinity for anything the saved order does not name. So a panel added to
// a tab after the layout was saved — and every child with no panelId at all,
// like a HiddenPanels wrapper — keeps its declared position, at the end.
//
// Returns the very same array when there is nothing to apply, so the
// no-saved-layout path does not even allocate.
export function sortByOrder(items, order, keyOf) {
  if (!Array.isArray(order) || order.length === 0) return items
  const rankOf = new Map(order.map((id, i) => [id, i]))
  // MAX_SAFE_INTEGER, not Infinity: two unnamed panels would compare
  // Infinity - Infinity = NaN, and a NaN comparator is undefined behaviour
  // that only reaches the right answer here by luck (NaN is falsy, so `||`
  // silently rescues it). A finite sentinel subtracts to a clean 0.
  const UNNAMED = Number.MAX_SAFE_INTEGER
  const ranked = items.map((item, i) => {
    const key = keyOf(item)
    const rank = key == null ? UNNAMED : (rankOf.get(key) ?? UNNAMED)
    return { item, rank, i }
  })
  // Array.prototype.sort is stable in every engine this ships to, but the
  // declared-index tiebreak makes the "keeps its declared position" rule
  // explicit rather than inherited.
  ranked.sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
  return ranked.map((r) => r.item)
}

// ---------- the wire ----------

// The one place the POST body is constructed. Nothing else in the app should
// hand-roll this shape, because getting the nesting wrong fails SILENTLY: the
// server answers {"ok":true} and the discarded keys are simply never seen again.
export function buildSaveBlob(tabId, order, spans) {
  return {
    name: layoutViewName(tabId),
    order: [...order],
    layout: { version: LAYOUT_VERSION, spans: { ...spans } },
  }
}

// THE LISTING IS CHECKED FIRST, AND THAT IS NOT AN OPTIMISATION.
//
// The obvious implementation asks GET /api/views/__layout_<tab> straight away
// and treats the 404 as "nothing saved". That works, and it made every single
// Overview load print `Failed to load resource: 404 (Not Found)` in the
// console — because "no layout saved" is the DEFAULT state of every tab, and
// the browser logs a 404 whether or not the code handles it.
// tests/tabs-smoke.spec.ts asserts Overview loads with no console errors and
// caught it. Nothing in JS can suppress that log, so the only fix is not to
// provoke the 404: GET /api/views always answers 200, and the per-view read
// only happens when the name is actually there.
//
// A failed listing, a network error, a view deleted between the two calls, and
// a record that fails the strict payload check all land in the same place, for
// the same reason: there is no layout we can trust, so none is applied and the
// tab renders exactly as it did before this file existed.
export async function loadLayout(tabId, fetchImpl = fetch) {
  const name = layoutViewName(tabId)
  try {
    const listRes = await fetchImpl('/api/views')
    if (!listRes.ok) return null
    const listed = (await listRes.json())?.views
    if (!Array.isArray(listed) || !listed.some((v) => v?.name === name)) return null

    const res = await fetchImpl(`/api/views/${encodeURIComponent(name)}`)
    // Still checked: the view can be deleted between the listing and this read.
    if (!res.ok) return null
    return parseLoad(await res.json())
  } catch {
    return null
  }
}

// Validated before it is sent, not after. This is item 7's guard standing
// between the drag UI of item 8 and the disk: a pixel offset stashed "just
// temporarily" in the blob throws here and never reaches the network.
export async function saveLayout(tabId, { order, spans }, fetchImpl = fetch) {
  const blob = buildSaveBlob(tabId, order, spans)
  const verdict = validateSave(blob)
  if (!verdict.ok) throw new Error(`refusing to save an invalid layout: ${verdict.error}`)
  const res = await fetchImpl('/api/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(blob),
  })
  return res.ok
}
