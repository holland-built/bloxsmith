// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THE TRACK COUNT IS WRITTEN DOWN TWICE. THIS IS THE PRICE OF ADMISSION.
//
// ui/src/components/ui.jsx puts `grid-cols-2 md:grid-cols-4 xl:grid-cols-6` on
// the [data-card-grid] element, so the BROWSER decides how many columns exist.
// ui/src/index.css declares `--grid-tracks` on the same element behind media
// queries at the same thresholds, so READGEOMETRY can know that number without
// parsing gridTemplateColumns — which serialises implicit columns and is
// therefore a function of the very spans it is used to decide (see the comment
// above readGeometry for the three tabs that measured this).
//
// Two places, one fact. If they drift, the arithmetic is silently wrong at
// exactly one breakpoint: 4 declared columns measured as 6-wide tracks, every
// measured panel one track too narrow, and nothing crashes. That failure has no
// symptom a person would report as "the breakpoints disagree", so it gets a
// test rather than a comment asking people to be careful.
//
// The Tailwind side is not taken on trust either. `md:` and `xl:` are whatever
// tailwindcss's own theme says they are, so the thresholds are read out of the
// installed package rather than hard-coded here — a Tailwind major that moved
// a breakpoint would otherwise leave this test agreeing with a stale memory.
//
// WHAT IT CANNOT DO, said plainly: it reads text. It does not lay a grid out,
// so it cannot catch a media query that is correct but never matches (an
// `@media print`, a typo'd feature name). tests/table-sizing.spec.ts's
// transition cases are the browser half — they assert that the number of tracks
// the browser actually rendered equals the `--grid-tracks` it can read back.
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const UI_JSX = path.join(here, '..', 'components', 'ui.jsx')
const INDEX_CSS = path.join(here, '..', 'index.css')
const TW_THEME = path.join(here, '..', '..', 'node_modules', 'tailwindcss', 'theme.css')

const jsx = fs.readFileSync(UI_JSX, 'utf8')
const css = fs.readFileSync(INDEX_CSS, 'utf8')

// ---- the JSX side: what the browser is told ----

// The one element that carries the marker readGeometry looks the property up
// on. Asserted to be unique, because a second grid with a different class
// string would make "the" track count meaningless.
function cardGridClassString() {
  const lines = jsx.split('\n').filter((l) => l.includes('data-card-grid') && l.includes('className'))
  assert.equal(lines.length, 1, `expected exactly one rendered [data-card-grid] element in ui.jsx, found ${lines.length}`)
  const m = /className=\{`([^`]*)`\}/.exec(lines[0])
  assert.ok(m, `could not read the className template literal off ui.jsx's [data-card-grid]:\n${lines[0]}`)
  return m[1]
}

// { base: 2, md: 4, xl: 6 } — every grid-cols utility on that element, keyed by
// its responsive prefix.
function declaredColumns() {
  const out = {}
  for (const token of cardGridClassString().split(/\s+/)) {
    const m = /^(?:([a-z0-9]+):)?grid-cols-(\d+)$/.exec(token)
    if (m) out[m[1] ?? 'base'] = Number(m[2])
  }
  assert.ok(out.base, `ui.jsx's [data-card-grid] declares no unprefixed grid-cols-N: "${cardGridClassString()}"`)
  return out
}

// ---- the CSS side: what readGeometry is told ----

// Strips one level of nesting so the unprefixed rule can be told apart from the
// ones inside @media. Enough for this file's shape and asserted below by count.
const cssOutsideMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')

function declaredTracks() {
  const out = {}

  const base = /\[data-card-grid\]\s*\{[^}]*--grid-tracks:\s*(\d+)/.exec(cssOutsideMedia)
  assert.ok(base, 'index.css declares no unprefixed `[data-card-grid] { --grid-tracks: N }`')
  out.base = Number(base[1])

  for (const m of css.matchAll(
    /@media\s*\(width\s*>=\s*([\d.]+)rem\)\s*\{\s*\[data-card-grid\]\s*\{[^}]*--grid-tracks:\s*(\d+)/g,
  )) {
    out[`${m[1]}rem`] = Number(m[2])
  }

  // Every declaration in the file is accounted for by one of the two reads
  // above. A `--grid-tracks` this parser walked past is a rule that would take
  // effect in the browser and be invisible here, which is the one way a
  // text-reading test can pass while being wrong.
  const total = (css.match(/--grid-tracks:/g) || []).length
  assert.equal(
    total,
    Object.keys(out).length,
    `index.css holds ${total} --grid-tracks declarations but this test only parsed ${Object.keys(out).length}. ` +
      'A declaration was added in a shape the regexes above do not match — widen them, do not delete this assert.',
  )
  return out
}

// ---- Tailwind's own thresholds, read from the installed package ----

function tailwindBreakpoints() {
  const theme = fs.readFileSync(TW_THEME, 'utf8')
  const out = {}
  for (const m of theme.matchAll(/--breakpoint-([a-z0-9]+):\s*([\d.]+)rem;/g)) out[m[1]] = `${m[2]}rem`
  assert.ok(Object.keys(out).length > 0, `no --breakpoint-* found in ${TW_THEME}`)
  return out
}

test('every grid-cols utility on the card grid has a --grid-tracks to match, at the same breakpoint', () => {
  const cols = declaredColumns()
  const tracks = declaredTracks()
  const breakpoints = tailwindBreakpoints()

  assert.equal(
    tracks.base,
    cols.base,
    `index.css says --grid-tracks: ${tracks.base} at the base width, ui.jsx says grid-cols-${cols.base}`,
  )

  for (const [prefix, n] of Object.entries(cols)) {
    if (prefix === 'base') continue
    const rem = breakpoints[prefix]
    assert.ok(rem, `ui.jsx uses the "${prefix}:" prefix, which tailwindcss's theme.css does not define as a breakpoint`)
    assert.ok(
      rem in tracks,
      `ui.jsx declares ${prefix}:grid-cols-${n} (${prefix} = ${rem}), but index.css has no ` +
        `\`@media (width >= ${rem}) { [data-card-grid] { --grid-tracks: … } }\`. ` +
        'readGeometry would read the previous breakpoint\'s count above this width.',
    )
    assert.equal(
      tracks[rem],
      n,
      `at ${prefix} (${rem}): ui.jsx renders grid-cols-${n}, index.css declares --grid-tracks: ${tracks[rem]}`,
    )
  }

  // And the other direction: a media query for a width the class string never
  // changes at would move the arithmetic away from what the browser lays out.
  const expected = new Set(['base', ...Object.keys(cols).filter((p) => p !== 'base').map((p) => breakpoints[p])])
  for (const key of Object.keys(tracks)) {
    assert.ok(
      expected.has(key),
      `index.css changes --grid-tracks at ${key}, but ui.jsx's [data-card-grid] does not change grid-cols there`,
    )
  }
})

test('the widest storable span still fits the widest breakpoint', () => {
  // MAX_SPAN (lib/layout.js) is what a saved layout may hold. If the grid ever
  // declared fewer columns than that at its widest, a span the operator can
  // store could never be rendered anywhere — clampSpan would silently cap it at
  // every width and widthAnnouncement would say "needs a wider window" about a
  // window that does not exist.
  const widest = Math.max(...Object.values(declaredColumns()))
  const layout = fs.readFileSync(path.join(here, 'layout.js'), 'utf8')
  const max = Number(/export const MAX_SPAN = (\d+)/.exec(layout)[1])
  assert.equal(widest, max, `the card grid's widest breakpoint declares ${widest} columns but MAX_SPAN is ${max}`)
})

test('the implicit-column assumption is made true by construction', () => {
  // readGeometry no longer parses gridTemplateColumns, so an implicit column can
  // no longer raise the track count. This keeps one from taking visible WIDTH in
  // the frame between a card being over-spanned and applyLayout clearing it —
  // the frame in which #security's threat-events card rendered 38px wide.
  assert.match(
    cssOutsideMedia,
    /\[data-card-grid\]\s*\{[^}]*grid-auto-columns:\s*0/,
    'index.css no longer pins `grid-auto-columns: 0` on [data-card-grid]',
  )
})
