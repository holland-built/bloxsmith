// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// A CAP THAT NOTHING CAN LABEL.
//
// DataTable prints "showing N of M — filter to narrow" when it is handed more
// rows than its rowCap. That footer is the repo's answer to a truncated table,
// and it has one blind spot that is invisible from inside DataTable: it can
// only count the rows it is GIVEN. Slice the list before handing it over and
// DataTable sees a short list, correctly reports no truncation, and the rows
// that were dropped upstream leave no trace anywhere on the page.
//
// That is what ui/src/tabs/Network.jsx did until 2026-08-19. "Which Subnets Run
// Out First?" ran `sorted.slice(0, 20)` and passed the 20 on to a DataTable
// whose rowCap was 150, so the footer could never fire. Measured against the
// live tenant on the day this test was written: 487 subnets loaded, 460 after
// the panel's own /29-/32 exclusion, 20 drawn, nothing on screen saying so —
// under a filter box and a site selector whose whole purpose is to narrow a set
// the user cannot see the size of. "IPAM Spaces — Top Used" had the same shape:
// 31 ranked, 12 drawn, and a right-hand label reading only "addresses used".
//
// ---------------------------------------------------------------------------
// WHAT THIS TEST PROVES, AND WHAT IT DOES NOT.
//
// It is a SOURCE-SHAPE test, like layoutChrome.test.js and panelHelpTruth.test.js
// — it reads the file as text. It cannot render, so it cannot prove the footer
// appears; tests/ has the browser half of that. What it CAN prove is the thing
// the browser half kept missing, because a capped table and an uncapped one look
// identical once the cap is upstream: that neither panel drops rows in a place
// nothing is able to count them.
//
// It is deliberately NOT a general "no .slice() near a DataTable" scan. A cap
// applied upstream is legitimate whenever the panel states its own denominator
// — Overview's "top 12 of N subnets" does exactly that — so a blanket rule would
// fire on correct code. These two panels are named because these two were wrong.
// A third panel with this defect will not be caught here.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NETWORK = fs.readFileSync(path.join(HERE, '..', 'tabs', 'Network.jsx'), 'utf8')

test('the exhaustion table hands DataTable every matching row, so its cap is DataTable\'s to print', () => {
  // The rows prop is built from `sorted` itself. Pre-fix this read
  // `top20.map(`, and `top20` was `sorted.slice(0, 20)`.
  assert.match(
    NETWORK,
    /const tableRows = useMemo\(\s*\(\) =>\s*sorted\.map\(/,
    'the exhaustion table must map over the full sorted set — a slice here is a cap DataTable cannot see, let alone label',
  )
  // Anchored to an ASSIGNMENT (`= sorted.slice(`) rather than to the bare call.
  // The first version of this line banned the substring outright and failed on
  // the comment three lines above the code, which quotes the old expression to
  // record what was wrong. A guard that cannot tell code from prose about code
  // teaches people to delete the prose.
  assert.doesNotMatch(
    NETWORK,
    /=\s*sorted\.slice\(/,
    'nothing may slice `sorted` before it reaches DataTable; raise or lower EXHAUSTION_CAP instead',
  )
  assert.match(NETWORK, /const EXHAUSTION_CAP = 150/, 'the cap is a named constant so panelHelpValues.test.js can bind the help sentence to it')
  assert.match(
    NETWORK,
    /rowCap=\{EXHAUSTION_CAP\}/,
    'the cap must be applied BY DataTable — that is the only place that prints "showing N of M"',
  )
})

test('the IPAM spaces panel states the denominator its top-12 was taken from', () => {
  // This panel keeps its upstream cap: it is a bar list, not a DataTable, so
  // there is no footer to inherit. It owes a label instead, and the label has
  // to count what was actually ranked rather than the raw feed length.
  assert.match(NETWORK, /const IPAM_SPACES_CAP = 12/, 'the cap is a named constant, not a bare 12 in a chain')
  assert.match(
    NETWORK,
    /const rows = eligible\.slice\(0, IPAM_SPACES_CAP\)/,
    'the ranked set and the drawn set must be separate bindings, or there is nothing left to count against',
  )
  assert.match(
    NETWORK,
    /const capLabel = eligible\.length > rows\.length \? `top \$\{rows\.length\} of \$\{eligible\.length\.toLocaleString\(\)\}` : null/,
    'the label is "top N of M" over the ELIGIBLE rows — the denominator has to be a number this code counted',
  )
  assert.match(
    NETWORK,
    /addresses used\{capLabel \? ` · \$\{capLabel\}` : ''\}/,
    'and it has to actually be rendered — a computed label nothing prints is worse than no label, because the code reads as fixed',
  )
})
