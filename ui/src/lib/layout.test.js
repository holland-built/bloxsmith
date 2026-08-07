// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSaveBlob, clampSpan, insertionIndex, layoutViewName, loadLayout, moveItem,
  parseLoad, resolveSpan, saveLayout, shiftItem, sortByOrder, spanFromWidth,
  stepSpan, unseenPanelIds, validateSave, widthAnnouncement,
} from './layout.js'

// P9a — the guard item 8 is built on. A layout is order + column span and
// nothing else, so a pixel offset must have nowhere to live: not as a
// top-level key, not inside `layout`, not smuggled in as a fractional span.

const GOOD = {
  name: '__layout_overview',
  order: ['dns-hero', 'kpi-stack'],
  layout: { version: 1, spans: { 'dns-hero': 4, 'kpi-stack': 2 } },
}

test('a well-formed save blob is accepted', () => {
  assert.equal(validateSave(GOOD).ok, true)
})

test('P9a: a pixel-carrying blob is rejected — top-level x/y', () => {
  assert.equal(validateSave({ ...GOOD, x: 120, y: 40 }).ok, false)
})

test('P9a: a pixel offset smuggled INSIDE layout is rejected', () => {
  assert.equal(
    validateSave({ ...GOOD, layout: { version: 1, spans: { 'dns-hero': 4 }, px: { 'dns-hero': 320 } } }).ok,
    false,
  )
})

test('P9a: a span must be an integer — a fractional span is a pixel in disguise', () => {
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: 2.5 } } }).ok, false)
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: '3' } } }).ok, false)
})

test('P9a: spans outside 1-6 are rejected, 1 and 6 are accepted', () => {
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: 0 } } }).ok, false)
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: 7 } } }).ok, false)
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: -2 } } }).ok, false)
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: 1 } } }).ok, true)
  assert.equal(validateSave({ ...GOOD, layout: { version: 1, spans: { a: 6 } } }).ok, true)
})

// ---------- parseLoad: tolerant of the envelope, strict about the payload ----------

// Byte-for-byte what GET /api/views/__probe_delete_me answered on the live
// dev server before this file existed — ViewWrite's whitelist adds widgets,
// folder and saved_at whether the caller sent them or not.
const SERVER_ENVELOPE = {
  folder: '',
  layout: { spans: { 'dns-hero': 4 }, version: 1 },
  name: '__layout_overview',
  order: ['dns-hero', 'kpi-stack'],
  saved_at: '2026-08-07T02:25:55Z',
  widgets: {},
}

test('parseLoad accepts the real server envelope, widgets/folder/saved_at and all', () => {
  const got = parseLoad(SERVER_ENVELOPE)
  assert.deepEqual(got, { order: ['dns-hero', 'kpi-stack'], spans: { 'dns-hero': 4 } })
})

test('parseLoad still rejects an unknown key nested inside layout', () => {
  // The envelope is tolerated; the payload is not. A smuggled pixel offset
  // would live exactly here, so this falls back to the unsaved default.
  assert.equal(parseLoad({ ...SERVER_ENVELOPE, layout: { version: 1, spans: {}, x: 12 } }), null)
})

test('parseLoad rejects an out-of-range span and a bad version', () => {
  assert.equal(parseLoad({ ...SERVER_ENVELOPE, layout: { version: 1, spans: { a: 9 } } }), null)
  assert.equal(parseLoad({ ...SERVER_ENVELOPE, layout: { version: 2, spans: {} } }), null)
})

test('parseLoad rejects a non-record, so a 404 body or garbage renders the default', () => {
  assert.equal(parseLoad(null), null)
  assert.equal(parseLoad({ error: 'not found' }), null)
  assert.equal(parseLoad('nope'), null)
})

// ---------- the clamp: a saved span is stored unclamped, rendered clamped ----------

// The grid is grid-cols-2 md:grid-cols-4 xl:grid-cols-6, so trackCount is 2 /
// 4 / 6 at those three breakpoints. Every expected value below is written by
// hand from that fact, not recomputed from the code.

test('a saved span wider than the breakpoint is clamped to the tracks that exist', () => {
  assert.equal(clampSpan(6, 2), 2) // span 6 at 390px: only 2 tracks exist
  assert.equal(clampSpan(6, 4), 4)
  assert.equal(clampSpan(6, 6), 6)
  assert.equal(clampSpan(4, 2), 2)
  assert.equal(clampSpan(3, 2), 2)
})

test('a span that already fits is left alone, and the floor is 1 track', () => {
  assert.equal(clampSpan(2, 6), 2)
  assert.equal(clampSpan(1, 2), 1)
  assert.equal(clampSpan(0, 6), 1)
})

// ---------- precedence: user span > measured need > declared span ----------

test('a user span beats the measured need, even a wider one', () => {
  // The whole point of the override: the operator chose 2, the fit system
  // measured 4, and the operator wins.
  assert.deepEqual(resolveSpan({ userSpan: 2, measuredSpan: 4, trackCount: 6 }), { source: 'user', span: 2 })
  assert.deepEqual(resolveSpan({ userSpan: 6, measuredSpan: 1, trackCount: 6 }), { source: 'user', span: 6 })
})

test('the user span is clamped to the live track count at render time', () => {
  // Stored unclamped, so widening the window restores the intent — this is
  // only the render-time clamp.
  assert.deepEqual(resolveSpan({ userSpan: 6, measuredSpan: 1, trackCount: 2 }), { source: 'user', span: 2 })
  assert.deepEqual(resolveSpan({ userSpan: 6, measuredSpan: 1, trackCount: 4 }), { source: 'user', span: 4 })
})

test('with no user span the measured need wins', () => {
  assert.deepEqual(resolveSpan({ userSpan: null, measuredSpan: 3, trackCount: 6 }), { source: 'measured', span: 3 })
})

test('with neither, the declared span keeps its class and nothing is written inline', () => {
  // span null is the signal applyLayout uses to skip the element entirely, so
  // a non-measuring panel with no override is byte-identical to today.
  assert.deepEqual(resolveSpan({ userSpan: null, measuredSpan: null, trackCount: 6 }), { source: 'declared', span: null })
  assert.deepEqual(resolveSpan({ trackCount: 6 }), { source: 'declared', span: null })
})

// ---------- order: the DOM is reordered, CSS `order` is never used ----------
//
// CSS `order` moves boxes visually and leaves DOM order untouched, so screen
// readers and Tab focus would still follow the original JSX order and item 8's
// keyboard move mode would announce a position assistive tech cannot observe.
// These tests are on the array the grid renders, which is the thing that has
// to move.

const idOf = (x) => x.id

test('children are rearranged into the saved order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(sortByOrder(items, ['c', 'a', 'b'], idOf).map(idOf), ['c', 'a', 'b'])
})

test('a panelId absent from the saved order keeps its declared position, at the end', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  // b and d were saved; a and c were not, so they follow in their JSX order.
  assert.deepEqual(sortByOrder(items, ['d', 'b'], idOf).map(idOf), ['d', 'b', 'a', 'c'])
})

test('children with no panelId are never moved out of their declared run', () => {
  // HiddenPanels wrappers and plain divs sit in a CardGrid with no panelId.
  const items = [{ id: 'a' }, { id: null }, { id: 'b' }, { id: null }]
  const out = sortByOrder(items, ['b', 'a'], idOf)
  assert.deepEqual(out.map((x) => x.id), ['b', 'a', null, null])
})

test('a saved order naming panels that no longer exist changes nothing about the rest', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(sortByOrder(items, ['gone', 'b', 'also-gone', 'a'], idOf).map(idOf), ['b', 'a'])
})

test('an empty or missing order returns the very same array, untouched', () => {
  // Identity, not just equality: the no-saved-layout path must not even
  // allocate a new children array, let alone reorder one.
  const items = [{ id: 'a' }, { id: 'b' }]
  assert.equal(sortByOrder(items, [], idOf), items)
  assert.equal(sortByOrder(items, null, idOf), items)
})

// ---------- the wire: the exact body ViewWrite will actually keep ----------
//
// `ViewWrite` (go/internal/store/store.go:154-161) builds its record from an
// explicit whitelist and silently discards everything else, so the shape below
// is not cosmetic — a top-level `version`/`spans` blob POSTs with {"ok":true}
// and reads back empty. Hand-written literal, on purpose.

test('the POST body nests version and spans inside layout, and order stays top-level', () => {
  assert.deepEqual(buildSaveBlob('overview', ['dns-hero', 'kpi-stack'], { 'dns-hero': 4 }), {
    name: '__layout_overview',
    order: ['dns-hero', 'kpi-stack'],
    layout: { version: 1, spans: { 'dns-hero': 4 } },
  })
})

test('the view name carries the __layout_ prefix, which viewSanitize leaves alone', () => {
  // store.go:62 allows A-Za-z0-9._- , so underscores survive unchanged and the
  // name the UI asks for is the filename the server writes.
  assert.equal(layoutViewName('overview'), '__layout_overview')
})

test('a view listed but gone by the time it is read is "no saved layout"', async () => {
  // The delete-between-the-two-calls race, and the only remaining path on
  // which a 404 can still be seen.
  //
  // The body is a PERFECTLY VALID layout record on purpose. An earlier version
  // of this test used the server's real `{error:"not found"}` body and passed
  // even with the res.ok check deleted — parseLoad rejected that body anyway,
  // so the status check was never the thing under test. With a valid-looking
  // body, only the status can tell "not found" from "here is your layout".
  const fetchImpl = async (url) => {
    if (url === '/api/views') {
      return { ok: true, status: 200, json: async () => ({ views: [{ name: '__layout_overview' }] }) }
    }
    return { ok: false, status: 404, json: async () => ({ order: ['a'], layout: { version: 1, spans: { a: 3 } } }) }
  }
  assert.equal(await loadLayout('overview', fetchImpl), null)
})

// A tiny stand-in for the two endpoints, so a test can say what the tenant has
// saved and then assert on exactly which requests were made.
function fakeServer({ listed = [], record = null, listOk = true }) {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url === '/api/views') {
      return { ok: listOk, status: listOk ? 200 : 500, json: async () => ({ views: listed.map((name) => ({ name, saved_at: 'x', folder: '' })) }) }
    }
    if (record) return { ok: true, status: 200, json: async () => record }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  }
  return { fetchImpl, seen }
}

test('loadLayout asks for the right URL and parses the envelope', async () => {
  const { fetchImpl, seen } = fakeServer({
    listed: ['__layout_overview'],
    record: {
      folder: '', name: '__layout_overview', saved_at: '2026-08-07T02:25:55Z', widgets: {},
      order: ['b', 'a'], layout: { version: 1, spans: { b: 6 } },
    },
  })
  const got = await loadLayout('overview', fetchImpl)
  assert.deepEqual(seen, ['/api/views', '/api/views/__layout_overview'])
  assert.deepEqual(got, { order: ['b', 'a'], spans: { b: 6 } })
})

test('a tab with no saved layout never requests the view, so it never provokes a 404', async () => {
  // Not a style preference. The browser logs every 404 to the console as an
  // error, tests/tabs-smoke.spec.ts asserts Overview loads with none, and "no
  // layout saved" is the DEFAULT state of every tab — so the common path was
  // printing a red console error on every single page load. The listing
  // endpoint answers 200 with an empty array instead.
  const { fetchImpl, seen } = fakeServer({ listed: ['some-other-view'] })
  assert.equal(await loadLayout('overview', fetchImpl), null)
  assert.deepEqual(seen, ['/api/views'], 'the per-view GET must not be issued at all')
})

test('a listing that fails is "no saved layout", not a second guess', async () => {
  const { fetchImpl, seen } = fakeServer({ listOk: false })
  assert.equal(await loadLayout('overview', fetchImpl), null)
  assert.deepEqual(seen, ['/api/views'])
})

test('a load that throws is "no saved layout" too, never an unhandled rejection', async () => {
  const fetchImpl = async () => { throw new Error('offline') }
  assert.equal(await loadLayout('overview', fetchImpl), null)
})

test('saveLayout POSTs the validated body to /api/views', async () => {
  let call = null
  const fetchImpl = async (url, opts) => { call = { url, opts }; return { ok: true, status: 200 } }
  assert.equal(await saveLayout('overview', { order: ['a'], spans: { a: 2 } }, fetchImpl), true)
  assert.equal(call.url, '/api/views')
  assert.equal(call.opts.method, 'POST')
  assert.deepEqual(JSON.parse(call.opts.body), {
    name: '__layout_overview',
    order: ['a'],
    layout: { version: 1, spans: { a: 2 } },
  })
})

test('saveLayout refuses to POST a blob the validator rejects — item 7s guard on the wire', async () => {
  let called = false
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 } }
  await assert.rejects(
    () => saveLayout('overview', { order: ['a'], spans: { a: 320 } }, fetchImpl),
    /span for "a" must be 1-6/,
  )
  assert.equal(called, false, 'an invalid layout must never reach the network')
})

// ---------------------------------------------------------------------------
// Item 8 — the geometry and index maths behind pointer drag/resize, kept pure
// so the browser test only has to prove the wiring, not the arithmetic.
//
// The grid used throughout: 6 tracks of 180px with a 12px gap, so a span-s
// item is s*180 + (s-1)*12 wide: 180, 372, 564, 756, 948, 1140. Every expected
// value below is worked out from those six numbers by hand.
// ---------------------------------------------------------------------------

const TRACK = 180
const GAP = 12
const TRACKS = 6

test('spanFromWidth returns the exact span at each track boundary', () => {
  assert.equal(spanFromWidth(180, TRACK, GAP, TRACKS), 1)
  assert.equal(spanFromWidth(372, TRACK, GAP, TRACKS), 2)
  assert.equal(spanFromWidth(564, TRACK, GAP, TRACKS), 3)
  assert.equal(spanFromWidth(756, TRACK, GAP, TRACKS), 4)
  assert.equal(spanFromWidth(948, TRACK, GAP, TRACKS), 5)
  assert.equal(spanFromWidth(1140, TRACK, GAP, TRACKS), 6)
})

test('spanFromWidth snaps at the halfway point between two spans', () => {
  // Halfway between span 1 (180) and span 2 (372) is 276.
  assert.equal(spanFromWidth(275, TRACK, GAP, TRACKS), 1)
  assert.equal(spanFromWidth(277, TRACK, GAP, TRACKS), 2)
})

test('spanFromWidth is always a whole number in 1..trackCount', () => {
  assert.equal(spanFromWidth(0, TRACK, GAP, TRACKS), 1)
  assert.equal(spanFromWidth(-500, TRACK, GAP, TRACKS), 1)
  assert.equal(spanFromWidth(9000, TRACK, GAP, TRACKS), 6)
  // A 2-track grid (the 390px breakpoint) can never yield 3.
  assert.equal(spanFromWidth(9000, TRACK, GAP, 2), 2)
  for (const px of [1, 199, 333, 401, 700, 1139]) {
    assert.equal(Number.isInteger(spanFromWidth(px, TRACK, GAP, TRACKS)), true)
  }
})

test('spanFromWidth refuses a degenerate grid rather than returning NaN', () => {
  assert.equal(spanFromWidth(400, 0, GAP, TRACKS), 1)
  assert.equal(spanFromWidth(400, NaN, GAP, TRACKS), 1)
})

test('stepSpan steps by one and clamps to the stored 1-6 range', () => {
  assert.equal(stepSpan(3, 1), 4)
  assert.equal(stepSpan(3, -1), 2)
  assert.equal(stepSpan(6, 1), 6)
  assert.equal(stepSpan(1, -1), 1)
})

// ---------- drag: which slot did the pointer land in ----------
//
// A hand-drawn 5-panel grid, two rows. Row 1 sits at y 0-100, row 2 at
// y 120-220; the three columns are x 0-200, 220-420 and 440-640, so the
// horizontal midpoints are 100, 320 and 540.
//
//   row 1:  [ A 0-200 ] [ B 220-420 ] [ C 440-640 ]
//   row 2:  [ D 0-200 ] [ E 220-420 ]
//
// Every expected index below was counted off that picture by hand.
const GRID_RECTS = [
  { left: 0, right: 200, top: 0, bottom: 100 },
  { left: 220, right: 420, top: 0, bottom: 100 },
  { left: 440, right: 640, top: 0, bottom: 100 },
  { left: 0, right: 200, top: 120, bottom: 220 },
  { left: 220, right: 420, top: 120, bottom: 220 },
]

test('insertionIndex: the left half of the first card is position 0', () => {
  assert.equal(insertionIndex(GRID_RECTS, 10, 50), 0)
  assert.equal(insertionIndex(GRID_RECTS, 99, 50), 0)
})

test('insertionIndex: crossing a card midpoint advances one slot', () => {
  assert.equal(insertionIndex(GRID_RECTS, 101, 50), 1) // past A's midpoint
  assert.equal(insertionIndex(GRID_RECTS, 500, 50), 2) // past B, short of C
  assert.equal(insertionIndex(GRID_RECTS, 600, 50), 3) // past C: end of row 1
})

test('insertionIndex: a lower row counts every card above it', () => {
  assert.equal(insertionIndex(GRID_RECTS, 10, 150), 3) // start of row 2
  assert.equal(insertionIndex(GRID_RECTS, 300, 150), 4)
  assert.equal(insertionIndex(GRID_RECTS, 400, 150), 5) // the very end
})

test('insertionIndex: a pointer above or below everything still lands in range', () => {
  assert.equal(insertionIndex(GRID_RECTS, 300, -50), 0)
  assert.equal(insertionIndex(GRID_RECTS, 300, 9999), 5)
  assert.equal(insertionIndex([], 10, 10), 0)
})

// ---------- the two ways an order changes ----------

const ORDER = ['a', 'b', 'c', 'd']

test('moveItem drops a card into a slot counted against the ORIGINAL list', () => {
  assert.deepEqual(moveItem(ORDER, 0, 2), ['b', 'a', 'c', 'd'])
  assert.deepEqual(moveItem(ORDER, 3, 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveItem(ORDER, 0, 4), ['b', 'c', 'd', 'a'])
})

test('moveItem: dropping a card back on itself is not a move', () => {
  // Slot 1 and slot 2 are both "where b already is" — the slot index counts
  // the dragged card itself, so both must be no-ops rather than off-by-ones.
  assert.deepEqual(moveItem(ORDER, 1, 1), ['a', 'b', 'c', 'd'])
  assert.deepEqual(moveItem(ORDER, 1, 2), ['a', 'b', 'c', 'd'])
})

test('moveItem ignores an index that names nothing', () => {
  assert.deepEqual(moveItem(ORDER, -1, 2), ORDER)
  assert.deepEqual(moveItem(ORDER, 9, 2), ORDER)
})

test('shiftItem moves a card one position for one arrow press', () => {
  assert.deepEqual(shiftItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(shiftItem(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
  assert.deepEqual(shiftItem(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd'])
})

test('shiftItem stops at both ends and ignores an unknown id', () => {
  const start = ['a', 'b', 'c']
  assert.deepEqual(shiftItem(start, 'a', -1), ['a', 'b', 'c'])
  assert.deepEqual(shiftItem(start, 'c', 1), ['a', 'b', 'c'])
  assert.deepEqual(shiftItem(start, 'zzz', 1), ['a', 'b', 'c'])
})

// ---------- what an arrow press announces ----------
//
// The stored span is deliberately unclamped (see clampSpan), so at 390px a
// card can hold "6" and render 2. Announcing the stored number there is a
// measured lie: verified live at 390 with 2 tracks, ArrowUp announced "Width 3
// of 6 columns" and then "Width 4 of 6 columns" while the card stayed 342px
// wide both times. The announcement is the only channel a screen-reader user
// has, so it says what the card is ACTUALLY given, and names the stored intent
// separately rather than pretending it took effect.
//
// Every expected string below is written by hand.

test('an announcement inside the breakpoint is the plain width', () => {
  assert.equal(widthAnnouncement(5, 6), 'Width 5 of 6 columns')
  assert.equal(widthAnnouncement(1, 6), 'Width 1 of 6 columns')
  assert.equal(widthAnnouncement(2, 2), 'Width 2 of 2 columns')
})

test('a stored span wider than the breakpoint announces what renders, then what was stored', () => {
  assert.equal(
    widthAnnouncement(3, 2),
    'Width 2 of 2 columns. Set to 3, which needs a wider window.',
  )
  assert.equal(
    widthAnnouncement(6, 4),
    'Width 4 of 4 columns. Set to 6, which needs a wider window.',
  )
})

test('with no track count read, the announcement claims no denominator at all', () => {
  // geometry() returns null for a grid whose computed style has not resolved.
  // "of 6 columns" would then be an invented number.
  assert.equal(widthAnnouncement(4, null), 'Width 4 columns')
  assert.equal(widthAnnouncement(4, 0), 'Width 4 columns')
  assert.equal(widthAnnouncement(4, undefined), 'Width 4 columns')
})

// ---------- the panels a saved order can record but never restore ----------
//
// snapshot() reads data-panel-id off the grid's DOM children, so a panel
// wrapped in a HiddenPanels fragment or a plain div IS written into the saved
// order. sortByOrder reads props.panelId off the React children, where that
// same panel is invisible and ranks last. The two disagreeing silently is the
// one outcome that is not acceptable, so the disagreement is computed here and
// shouted about at the call site.

test('a grid whose DOM ids all appear on its own children has nothing to report', () => {
  assert.deepEqual(unseenPanelIds(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  assert.deepEqual(unseenPanelIds([], ['a']), [])
})

test('a panel the children cannot name is reported', () => {
  // 'b' is on screen (a wrapper renders its Card) but the wrapper carries no
  // panelId, so sortByOrder ranks it MAX_SAFE_INTEGER and pushes it to the end.
  assert.deepEqual(unseenPanelIds(['a', 'b', 'c'], ['a', null, 'c']), ['b'])
  assert.deepEqual(unseenPanelIds(['a', 'b', 'c'], [null, null, null]), ['a', 'b', 'c'])
})

test('a child naming a panel that is not on screen is NOT a conflict', () => {
  // A conditionally rendered panel is a normal thing; the saved order simply
  // does not mention it this render. Only the other direction breaks sorting.
  assert.deepEqual(unseenPanelIds(['a'], ['a', 'b']), [])
})
