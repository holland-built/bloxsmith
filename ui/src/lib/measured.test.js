// Run with: npm test  (node --test, no test framework dependency)
//
// These four helpers had NO unit tests before 2026-08-20, which is the quieter
// half of why they were duplicated: nothing was attached to them, so there was
// nothing to notice a second copy. `num` in particular is the rule that keeps
// "nobody measured this subnet" from rendering as "this subnet is empty", and
// it was being re-typed rather than imported.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cmpMaybe, DASH, freeOf, num } from './measured.js'

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('num keeps unknown and zero apart', () => {
  // The whole point. A real measured zero survives as 0; the four ways a value
  // can be absent all become null, and null is what renders as a dash.
  assert.equal(num(0), 0, 'a measured zero is a measurement')
  assert.equal(num('0'), 0, 'the server sends these as strings')
  assert.equal(num(null), null)
  assert.equal(num(undefined), null)
  assert.equal(num(''), null, 'an empty string is absence, not zero')
  assert.equal(num('not a number'), null)
  assert.equal(num(NaN), null)
  assert.equal(num(Infinity), null, 'infinite is not a count of anything')
  assert.equal(num(42), 42)
  assert.equal(num('1204'), 1204)
})

test('freeOf refuses to subtract from something nobody measured', () => {
  assert.equal(freeOf({ total: 256, used: 8 }), 248)
  assert.equal(freeOf({ total: 256, used: 0 }), 256, 'a subnet with nothing used has all of it free')
  assert.equal(freeOf({ total: null, used: 8 }), null)
  assert.equal(freeOf({ total: 256, used: null }), null)
  assert.equal(freeOf({}), null)
  // total 0 is a real measurement, so the answer is a real 0, not null.
  assert.equal(freeOf({ total: 0, used: 0 }), 0)
})

test('cmpMaybe sorts unknown to the bottom whichever way the column is sorted', () => {
  // Not "unknown is small" or "unknown is large" — unknown is LAST in the
  // direction on screen, which is the only reading that is not a claim. Sorting
  // worst-first must not put an unmeasured subnet at the top as the most
  // exhausted, and sorting best-first must not put it there as the emptiest.
  assert.ok(cmpMaybe(null, 5, 'asc') > 0, 'ascending: unknown after a number')
  assert.ok(cmpMaybe(null, 5, 'desc') > 0, 'descending: unknown STILL after a number')
  assert.ok(cmpMaybe(5, null, 'asc') < 0)
  assert.ok(cmpMaybe(5, null, 'desc') < 0)
  assert.equal(cmpMaybe(null, null, 'asc'), 0)
  assert.equal(cmpMaybe(1, 2, 'asc'), -1)
  assert.equal(cmpMaybe(1, 2, 'desc'), 1)
  // A measured zero sorts as a number, not as unknown. If these two were
  // conflated the whole distinction above would be decorative.
  assert.ok(cmpMaybe(0, 5, 'asc') < 0, 'zero is a number and sorts like one')
  assert.ok(cmpMaybe(0, null, 'asc') < 0, 'zero comes before unknown')
})

test('DASH is the one glyph, defined once', () => {
  assert.equal(DASH, '—')
})

// ---------------------------------------------------------------------------
// The duplication guard.
//
// Overview.jsx and Network.jsx held byte-identical copies of `num`, `freeOf`
// and `DASH`, comments and all, and DossierPage.jsx held a third `DASH`. The
// risk was never the extra lines: it was that the comment on `num` is the only
// written record of why a null must not become a 0, so a fix to one copy left
// the other still making the claim. Nothing stopped a fourth copy appearing.
test('no tab or component redefines what this module owns', () => {
  const OWNED = ['num', 'freeOf', 'cmpMaybe', 'DASH']
  const offenders = []
  for (const dir of ['tabs', 'components']) {
    for (const name of fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith('.jsx'))) {
      const src = fs.readFileSync(path.join(SRC, dir, name), 'utf8')
      for (const sym of OWNED) {
        // Anchored to a definition at the start of a line. A local `const num =
        // …` inside a function is a different, deliberately-shadowed thing and
        // is not what went wrong here.
        const def = new RegExp(`^(?:export\\s+)?(?:function\\s+${sym}\\s*\\(|const\\s+${sym}\\s*=)`, 'm')
        if (def.test(src)) offenders.push(`${dir}/${name} defines ${sym}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `import these from lib/measured.js instead of redefining them:\n${offenders.join('\n')}`,
  )
})
