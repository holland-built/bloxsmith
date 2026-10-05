// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// NO SIDE STRIPE WIDER THAN 1px.
//
// DESIGN.md: "No side-stripe borders wider than 1px as an accent." A thick bar
// down one edge of a box is the commonest mark of a generated page, and the
// panel wall has none. Until 2026-10-05 two grey quote rules, in the AI
// "kept result" box and in the Docs quote, were 2px and were not on the list
// of exceptions. They are 1px now.
//
// The list of exceptions is below, by file and by the text that marks the
// place, with the reason. A new one has to be written here, or this fails.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (/\.(jsx|js|css)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(p)
  }
  return out
}

// A Tailwind side border of 2px or more (border-l-2, border-r-4, border-s-8,
// border-e-[3px]), or an inline width on one side. border-l, border-r-0 and
// border-l-line (a colour) are fine.
const THICK = /\bborder-[lrse]-(?:[2-9]|\d\d|\[)|\bborder(?:Left|Right|InlineStart|InlineEnd)Width\b/

// file -> text found on the line, and why it stays.
const EXCEPTIONS = [
  ['components/DossierPage.jsx', "borderLeftColor: 'var(--color-warn)'", 'the warn-coloured rail on the one Dossier block that says something is wrong'],
]

const hits = files(SRC).flatMap((f) => {
  const rel = path.relative(SRC, f)
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((text, i) => ({ rel, line: i + 1, text }))
    .filter((l) => THICK.test(l.text) && !/^\s*(\/\/|\/\*|\*)/.test(l.text))
})
const excused = (h) => EXCEPTIONS.some(([rel, mark]) => rel === h.rel && h.text.includes(mark))

test('the pattern catches what it should and nothing else', () => {
  for (const yes of ['border-l-2', 'xl:border-r-4', 'border-s-8', 'border-e-[3px]', 'borderLeftWidth: 3']) {
    assert.ok(THICK.test(yes), yes)
  }
  for (const no of ['border-l', 'border-r-0', 'border-l-line', 'border-b-2', 'border-t', 'border-2', 'last:border-r-0']) {
    assert.ok(!THICK.test(no), no)
  }
})

test('no side stripe is wider than 1px, except the listed ones', () => {
  const bad = hits.filter((h) => !excused(h)).map((h) => `${h.rel}:${h.line}  ${h.text.trim().slice(0, 110)}`)
  assert.deepEqual(bad, [], 'make it 1px (border-l), or add it to EXCEPTIONS with the reason:\n  ' + bad.join('\n  '))
})

test('every listed exception still names exactly one place', () => {
  for (const [rel, mark, why] of EXCEPTIONS) {
    const n = hits.filter((h) => h.rel === rel && h.text.includes(mark)).length
    assert.equal(n, 1, `EXCEPTIONS entry ${rel} "${mark}" (${why}) matches ${n} places`)
  }
})
