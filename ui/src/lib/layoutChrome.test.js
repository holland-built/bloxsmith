// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// THE INVARIANT: a CardGrid with no `layoutKey` creates no move handle, no
// resize hotspot, no hide button and no live region — not hidden, not
// disabled, not rendered. A tab that has not opted into saved layouts must
// render exactly the DOM it rendered before the feature existed.
//
// WHY THIS IS A SOURCE-SHAPE TEST AND NOT A RENDER. It used to be proven in a
// real browser by tests/layout-drag.spec.ts, which navigated to #network — the
// tab that had no layoutKey — and asserted zero of each. Since 2026-08-08 all
// 15 tabs carry one (19 CardGrid render sites, Provision contributing three),
// so the app has no unmanaged grid left for a browser to point at, and that
// test was asserting something about Network that had stopped being true.
//
// The honest replacement is two-part, and this is the smaller half:
//
//   - tests/layout-drag.spec.ts now proves the POSITIVE truth in a browser —
//     each of the 15 tabs grows exactly one hotspot and one hide button per
//     panel, one live region, and one move handle per panel on the tabs that
//     show two or more panels (none on the one-panel tabs, which have nowhere
//     to move a panel to).
//   - this file proves the gate is still WHERE it has to be, by reading
//     components/ui.jsx: each affordance has exactly one render site, and that
//     site sits behind `managed` (which is `!!layoutKey` and a panelId) or
//     behind `layoutKey` directly.
//
// WHAT IT CANNOT DO, said plainly: it does not mount anything. It cannot catch
// a gate that is present but computes the wrong thing, and a large enough
// rewrite of the component will make it fail for the wrong reason — at which
// point read it and rewrite it, do not delete it. `npm test` runs `node --test`
// over plain .js with no JSX transform, so mounting CardGrid here is not
// available without adding a build step to the test path. The precedent for
// reading JSX as text is panelHelp.test.js in this same directory, which
// parses every <Card> tag in ui/src/tabs/*.jsx.

const here = path.dirname(fileURLToPath(import.meta.url))
const UI_PATH = path.join(here, '..', 'components', 'ui.jsx')
const src = fs.readFileSync(UI_PATH, 'utf8')

// The line each attribute is rendered on, ignoring the places it appears
// inside a string (CardGrid's focus-restore effect builds a querySelector out
// of `[data-layout-handle]`, which is a read and not a render).
function renderSites(attr) {
  const lines = src.split('\n')
  const out = []
  lines.forEach((line, i) => {
    if (!line.includes(attr)) return
    if (line.includes('querySelector') || line.includes('querySelectorAll')) return
    out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

// The nearest enclosing gate above a render site: the first line at or above
// it that opens one of the conditional forms this component uses.
function gateAbove(lineNumber) {
  const lines = src.split('\n')
  for (let i = lineNumber - 1; i >= 0 && i > lineNumber - 40; i--) {
    const line = lines[i]
    const m = /^\s*(?:const \w+ = (managed(?: && reorderable)?|reorderable) \? \(|\{(managed) && \(|\{(layoutKey) &&)/.exec(line)
    if (m) return { gate: m[1] || m[2] || m[3], line: i + 1, text: line.trim() }
  }
  return null
}

// attribute -> the gate its single render site must sit behind.
//
// `managed` for the per-Card affordances, because a Card also needs a panelId
// before it can be moved: a handle on a panel no saved layout can name would
// move something nothing could record. `layoutKey` for the two grid-level
// elements, which have no panel of their own.
//
// THE MOVE HANDLE CARRIES A SECOND CONDITION, and it is not tidiness. Since
// 2026-08-08 it is gated on `reorderable` — Card's `managed && !!grid.reorderable`
// — because a grid showing ONE panel has nowhere to move it to. #editor renders
// exactly one panel and always will: it grew a drag handle with no target, a
// move mode whose arrow keys moved nothing, and a help sentence claiming both.
// The resize hotspot and the hide button stay on `managed` alone, because both
// do real work on a one-panel grid.
const GATED = {
  'data-layout-handle': 'reorderable', // the move handle, on a grid that has two panels to swap
  'data-layout-resize=': 'managed', // the right-edge resize hotspot
  'data-layout-hide': 'managed', // the per-panel hide button
  'data-layout-live': 'layoutKey', // the one announcement region per grid
  'data-testid="hidden-tiles"': 'layoutKey', // the bring-a-tile-back strip
}

test('components/ui.jsx is where this invariant lives, and it is readable', () => {
  assert.ok(src.length > 0, `${UI_PATH} is empty`)
  assert.match(src, /export function CardGrid\(/, 'CardGrid has moved out of components/ui.jsx')
  assert.match(src, /export function Card\(/, 'Card has moved out of components/ui.jsx')
})

test('`managed` is exactly "this grid persists layouts, and this panel can be named"', () => {
  // The grid half: one switch, derived from layoutKey and nothing else.
  assert.match(
    src,
    /managed: !!layoutKey,/,
    'CardGrid no longer derives `managed` from layoutKey alone — the whole feature hangs off that one prop',
  )
  // The Card half: the grid says yes AND this panel has a stable identity.
  assert.match(
    src,
    /const managed = !!\(grid\?\.managed && panelId\)/,
    'Card no longer requires BOTH a managed grid and a panelId before it grows chrome',
  )
})

test('`reorderable` is exactly "this grid is showing two or more panels right now"', () => {
  // The grid half. Counted from the children the grid is rendering, minus
  // whatever the operator has hidden — not from a constant, and not from the
  // DOM: a hidden tile renders nothing to count, and a DOM count would be a
  // frame behind the first render. It must be recomputed when the children
  // change, because #drift shows one panel until a drift check runs and two
  // afterwards.
  // Matched as ONE block, deps included, because CardGrid holds a second memo
  // (`ordered`) over the same three dependencies — asserting the dep list on
  // its own would be satisfied by that one and prove nothing about this one.
  const memo = /const reorderable = useMemo\(\(\) => \{\n([\s\S]*?)\n {2}\}, \[([^\]]*)\]\)/.exec(src)
  assert.ok(
    memo,
    'CardGrid no longer computes `reorderable` in a useMemo — a one-panel grid would go back to claiming it can be rearranged',
  )
  const [, body, deps] = memo
  assert.match(
    body,
    /const hidden = new Set\(layout\?\.hidden \?\? \[\]\)/,
    'the visible-panel count no longer subtracts the hidden tiles, so hiding one of two panels would leave the handle behind',
  )
  assert.match(
    body,
    /if \(id && !hidden\.has\(id\)\) visible\+\+/,
    'the count no longer requires a panelId — hiddenPanelGroup’s "N panels hidden" row would be counted as a panel',
  )
  assert.match(body, /if \(visible >= 2\) return true/, 'the threshold is no longer two visible panels')
  assert.equal(
    deps,
    'children, layout, layoutKey',
    'the count is no longer recomputed on a children or layout change, so it would go stale on #drift',
  )
  // The Card half: this grid says yes, and this Card is managed.
  assert.match(
    src,
    /const reorderable = managed && !!grid\.reorderable/,
    'Card no longer reads `reorderable` off the grid before it grows a move handle',
  )
})

test('the generated help sentence about moving rides the same switch as the handle it names', () => {
  // The whole point of the split: the move sentence names the ⠿ handle, so it
  // must appear exactly where that handle does. Read as source rather than
  // rendered because `npm test` cannot mount JSX (see the header).
  assert.match(
    src,
    /reorderable \? `\$\{LAYOUT_HELP_MOVE\} \$\{LAYOUT_HELP_REST\}` : LAYOUT_HELP_REST/,
    'the help body no longer picks its sentences with `reorderable` — a one-panel panel would promise a move it cannot do',
  )
  const rest = /const LAYOUT_HELP_REST =\n([\s\S]*?)\n\n/.exec(src)
  assert.ok(rest, 'LAYOUT_HELP_REST has been renamed or removed')
  // The half that is appended unconditionally may not mention the handle or the
  // gesture — those belong to LAYOUT_HELP_MOVE, which is gated.
  assert.doesNotMatch(rest[1], /⠿/, 'LAYOUT_HELP_REST names the ⠿ handle, which a one-panel grid does not render')
  assert.doesNotMatch(rest[1], /\bmove\b/i, 'LAYOUT_HELP_REST claims a move, which a one-panel grid cannot do')
})

test('each layout affordance has exactly one render site', () => {
  // More than one site means the gate checked below is not the only gate, and
  // this whole file would be proving something about half the renders.
  for (const attr of Object.keys(GATED)) {
    const sites = renderSites(attr)
    assert.equal(
      sites.length,
      1,
      `${attr} is rendered in ${sites.length} places (${sites.map((s) => s.line).join(', ')}); ` +
        'this test can only vouch for a single gated site',
    )
  }
})

test('every layout affordance is behind the layoutKey gate — not hidden, not disabled, not rendered', () => {
  for (const [attr, expected] of Object.entries(GATED)) {
    const [site] = renderSites(attr)
    const gate = gateAbove(site.line)
    assert.ok(
      gate,
      `${attr} (line ${site.line}) has no \`managed\`/\`layoutKey\` gate above it — an unmanaged ` +
        'CardGrid would render it',
    )
    assert.equal(
      gate.gate,
      expected,
      `${attr} (line ${site.line}) is gated on \`${gate.gate}\` (line ${gate.line}), expected \`${expected}\``,
    )
  }
})

test('an unmanaged grid does no layout work either — no request, no state, no sort', () => {
  // The three places CardGrid could still do something for a tab that never
  // opted in. Each returns before it acts.
  assert.match(
    src,
    /if \(!layoutKey\) return undefined\n\s*let live = true/,
    'the layout GET is no longer skipped for a grid with no layoutKey — an unmanaged tab would issue a request',
  )
  assert.match(
    src,
    /if \(!layoutKey\) return children/,
    'sortByOrder is no longer skipped for a grid with no layoutKey — an unmanaged tab would re-key and remount its panels',
  )
  assert.match(
    src,
    /if \(!layoutKey \|\| !ref\.current\) return/,
    'the wrapped-panel guard no longer skips a grid with no layoutKey',
  )
  assert.match(
    src,
    /if \(!layoutKey \|\| !id\) return/,
    'registerTitle no longer skips a grid with no layoutKey — an unmanaged tab would take a re-render it never used to',
  )
})

test('the hidden-tiles strip is additionally gated on something actually being hidden', () => {
  // An always-rendered empty strip would be a permanent band of chrome on
  // every clean dashboard. tests/hidden-tiles.spec.ts asserts the absence in a
  // browser; this is the same rule read at its source.
  assert.match(
    src,
    /\{layoutKey && hiddenTiles\.length > 0 && \(/,
    'the hidden-tiles strip is no longer gated on hiddenTiles.length',
  )
})
