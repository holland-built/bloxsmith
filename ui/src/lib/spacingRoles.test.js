// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// SPACING NEVER GOT THE TREATMENT TYPE AND CORNERS DID, AND THIS IS NOT THAT.
//
// Type went to three roles (#189, #190) and radius to three (#188). Spacing has
// had --sp-card-pad, --sp-grid-gap and --sp-cell-y since the density work and
// has never had a pass of its own, so ui/src still writes arbitrary pixel values
// by hand in a hundred-odd places.
//
// This file does not fix that. It stops it growing, and it says exactly what was
// counted so the next person does not have to re-count it.
//
// WHAT IS IN SCOPE, and the line is drawn on purpose. Padding, margin, gap and
// inset only. Not w-, h-, min-w-, min-h-, max-w-, max-h-.
//
// A width is the SIZE OF A THING — a panel, a scroll region, a sparkline bar,
// a fixed ledger column. A padding is a distance between things. They answer
// different questions, and a scale built for the second does not fit the first:
// `w-[420px]` is a decision about how wide a drawer should be, and there is no
// step on any spacing rhythm that it is trying and failing to land on. Filing it
// under spacing would be the same mistake typeScale.test.js declines to make
// with App.jsx's 9px caret, which is a glyph standing in for an icon rather than
// a type size that lost an argument.
//
// Measured on the commit before this one: 106 arbitrary pixel utilities in
// ui/src, of which 79 are sizes and 27 are spacing, and the 27 sit in 3 files
// where the 79 are spread across 25. So the scope cut is not a way of making a
// large number small — the spacing debt really is concentrated, and the size
// debt really is somewhere else. The 79 are not forgiven, they are a different
// job, and nobody should read a green run here as "spacing is done".
//
// Every one of those figures is PRINTED by the failure message below rather than
// only written here, so the next person reads the current number instead of
// trusting a comment's. After the extraction below the in-scope figure was 23.
//
// IT IS NOW 0. The 23 were the open look change this header used to describe as
// "landing them on 8 and 12 is the real answer ... it needs a mockup set and a
// pick". Both happened: .mockups/spacing-scale/all.html rendered four
// directions and the owner picked v2 — ladder 0/4/8/16, the sub-4 nudges
// deleted rather than rounded, and no 12. So the sentence below about it being
// "recorded as open rather than done quietly" describes how it got done, not
// something still outstanding.
//
// The 79 SIZES ARE STILL NOT FORGIVEN and are still a different job. A green run
// here still does not mean w-[420px] found a home.
//
// EXTRACTION FIRST, THEN NORMALISATION — BOTH NOW DONE, IN THAT ORDER.
// #189/#190 set the precedent both ways: naming a value that already renders is
// authorised, and MOVING it is a look change that docs/SCREENS.md puts behind a
// variant set and the owner naming one.
//
// Step one, extraction. Of the 27 in scope, exactly four shared a role —
// DossierPage's ledger inset, written out four times as px-[11px], where the
// head cells, the field cells and the embedded panel all have to keep one left
// edge. Those four became --sp-ledger-inset, declared at 11px, which is what
// they already painted. Nothing moved.
//
// Step two, normalisation. The remaining 23 were one-off optical nudges at
// values that repeat nowhere, spread across fourteen distinct numbers:
// gap-[7/9/10px], px-[9/10/13px], py-[1/6/7px], pt-[2/10/11px], pb-[3px],
// mt-[7/9px], inset-[2px], inset-x-[1px], inset-y-[4px]. A token per value would
// have been renaming rather than systematising — fourteen names for fourteen
// numbers, most used once, is a worse file than the one it replaced. Landing
// them on a ladder was the real answer, and that needed a mockup set and a pick.
// Both happened: .mockups/spacing-scale/all.html rendered four directions and
// the owner chose v2 — ladder 0/4/8/16, sub-4 nudges deleted rather than
// rounded, no 12. All 23 are gone, and --sp-ledger-inset went 11px -> 8px with
// them, because under that ladder everything from 6 to 11 lands on 8.
//
// ONE THING GOT HARDER TO GUARD BECAUSE OF IT, and it is why the ledger test
// below grew a third assertion. At 11px the token's value was distinctive: a
// ledger cell that drifted off it had to write px-[11px], which the ratchet
// above catches. At 8px the value collides with px-2, so a drifting cell can now
// render pixel-identically through a perfectly ordinary utility that no ratchet
// would ever flag. Landing on a scale makes the code tidier and the drift
// quieter, and only an explicit check on the ledger cells covers the difference.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOT = 'ui/src'
const SKIP_DIRS = new Set(['node_modules'])
const SOURCE_EXT = new Set(['.jsx', '.js', '.ts', '.tsx'])

// TEST FILES ARE NOT CALL SITES, and skipping them is load-bearing rather than
// tidy. This file alone carries every class in the census as an object key and
// most of them again in a fixture and a failure message; counting itself took
// the in-scope figure from 23 to 63 on the first run after the walk widened
// beyond .jsx. A fixture's class is a string about the app, not a class the app
// ships — the same distinction that stopped tests/ being excluded from the
// Tailwind content globs wholesale, where a class whose only static spelling
// lived in a fixture would have vanished from the build.
const isTestFile = (name) => /\.(test|spec)\.[jt]sx?$/.test(name)

// The properties this file claims jurisdiction over. Sizes are absent
// deliberately; the header says why.
const SPACING = String.raw`p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y`

// (^|[^-\w]) is what keeps `min-[561px]:` from being read as an `m-[...]`
// utility. Tailwind's own breakpoint variants are spelled with brackets too, so
// a pattern anchored only on the property name matches inside them — and the
// first version of this regex counted every responsive variant in the file as a
// margin. The prefix is captured and discarded rather than using a lookbehind,
// which older Node builds do not all carry.
//
// A var() body is NOT a hit. `px-[var(--sp-ledger-inset)]` is the fixed shape,
// not the debt, so the character class excludes letters and parentheses and
// admits only a number with a unit.
// NEGATIVES ARE COUNTED, and Tailwind spells them two ways. `-mt-[4px]` puts
// the minus on the utility; `mt-[-4px]` puts it in the value. The first version
// of this pattern missed BOTH — the prefix class rejected the leading dash, and
// the value class rejected an inner one — so either spelling walked past the
// budget. Codex's finding 2 on this diff, and the fixture below now carries one
// of each so the hole cannot reopen quietly.
const ARBITRARY = new RegExp(
  String.raw`(^|[^-\w])(-?(?:${SPACING})-\[-?[0-9.]+(?:px|rem|em|ch|%)\])`,
  'g',
)

// The same shape for the properties this file does NOT police, used only to
// print the out-of-scope figure alongside the in-scope one. A scope boundary
// that nobody can see the other side of is a claim rather than a measurement.
const SIZES = String.raw`w|h|min-w|min-h|max-w|max-h|size|basis|top|left|right|bottom`
const ARBITRARY_SIZE = new RegExp(
  String.raw`(^|[^-\w])(-?(?:${SIZES})-\[-?[0-9.]+(?:px|rem|em|ch|%)\])`,
  'g',
)

// A CENSUS, not a total, and the difference is what makes this a ratchet rather
// than a ceiling.
//
// A single number can only say "no more than 23". Remove one nudge, add a
// different one, and 23 is still 23 — the debt was swapped, not paid, and
// nothing noticed. Codex's finding 1 on this diff, and it was right.
//
// So each class carries its own count. A count may FALL and a class may vanish,
// because paying debt must never fail a build — that is the same call
// typeScale.test.js makes about its exception budget, for the same reason. What
// fails is a count that rises or a class that appears, and either has to be
// written in here, in the diff that adds it, where a reviewer sees it.
//
// COUNTED, not estimated, and the distinction earned itself: the total said 17
// first, from a hand-tally off a grep whose alternation was missing inset-x- and
// inset-y-. The test failed on its first run and printed the real inventory,
// which is what is transcribed below.
const CENSUS = {
  // EMPTY, AND THAT IS THE POINT RATHER THAN AN OVERSIGHT.
  //
  // All 18 classes that used to be listed here are gone. The 23 one-off nudges
  // they counted were the "landing them on 8 and 12 is the real answer" note in
  // this file's header — the look change that needed a mockup set and a pick.
  // .mockups/spacing-scale/all.html offered four directions and v2 was chosen:
  // ladder 0/4/8/16, sub-4 nudges deleted rather than rounded, 12 absent.
  //
  // An empty census makes ARBITRARY_BUDGET 0, so the ratchet below now fails on
  // the FIRST new arbitrary spacing value rather than the twenty-fourth. That is
  // a real tightening and it is meant: there is no longer a backlog for a new
  // one to hide in.
  //
  // A genuine one-off still has a way in — add its line here with its reason,
  // exactly as before. What it cannot do any more is arrive silently.
}

const ARBITRARY_BUDGET = Object.values(CENSUS).reduce((a, b) => a + b, 0)

function walk(rel, out) {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(rel, e.name), out) }
    // .js and .ts as well as .jsx, because a class string does not stop being
    // one when it moves into a helper module. Codex's finding 3: a ratchet that
    // reads only .jsx is defeated by a cut and a paste, and the scope it claims
    // is ui/src. .tsx is included for the same reason even though ui/src has
    // none today — a ratchet should not need editing to keep covering the tree.
    else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name)) && !isTestFile(e.name)) {
      out.push(path.join(rel, e.name))
    }
  }
  return out
}

// Same collector as typeScale.test.js and radiusRoles.test.js: a class name is
// always inside a string literal, prose in a comment never is. Copied rather
// than shared because those two files each carry their own for the same reason
// — a change to one scanner should not silently move the others' numbers.
function stringLiterals(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl }
    else if (c === '/' && next === '*') { const k = src.indexOf('*/', i + 2); i = k === -1 ? src.length : k + 2 }
    else if (c === '"' || c === "'" || c === '`') {
      const q = c
      const line = src.slice(0, i).split('\n').length
      let j = i + 1, buf = ''
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue }
        if (src[j] === q) break
        if (q !== '`' && src[j] === '\n') break
        buf += src[j]; j++
      }
      out.push({ line, text: buf })
      i = j + 1
    } else i++
  }
  return out
}

function matches(text) {
  return [...text.matchAll(ARBITRARY)].map((m) => m[2])
}

function scan() {
  const files = walk(ROOT, [])
  assert.ok(files.length > 20, `expected to scan >20 source files, scanned ${files.length} — ROOT may be wrong`)
  const hits = []
  const sizeHits = []
  for (const rel of files) {
    for (const { line, text } of stringLiterals(fs.readFileSync(path.join(REPO, rel), 'utf8'))) {
      for (const cls of matches(text)) hits.push({ rel, line, cls, text })
      for (const m of text.matchAll(ARBITRARY_SIZE)) sizeHits.push({ rel, cls: m[2] })
    }
  }
  return { files, hits, sizeHits }
}

// FIRST, because every number this file reports is worthless if the matcher is
// broken. A regex that matches nothing produces a count of zero, and zero passes
// a ceiling — the vacuous green that the type and radius ratchets each had to
// learn to guard against. This fixture is independent of the real tree: it fails
// when the pattern breaks, whatever the app happens to contain that week.
test('the matcher finds what it claims to, so a count of zero means zero', () => {
  const found = matches(
    'flex items-center gap-[9px] px-[11px] py-[1px] mt-[7px] inset-[2px] max-w-[720px] ' +
      'w-[420px] h-[34px] min-w-[15px] min-[561px]:px-[13px] px-[var(--sp-ledger-inset)] px-2.5 gap-3 ' +
      '-mt-[4px] mb-[-6px]',
  )
  assert.deepEqual(
    found.sort(),
    [
      'gap-[9px]', 'inset-[2px]', 'mt-[7px]', 'px-[11px]', 'px-[13px]', 'py-[1px]',
      '-mt-[4px]', 'mb-[-6px]',
    ].sort(),
    'the arbitrary-spacing matcher no longer reads the fixture correctly, so every count below is meaningless'
  )

  // Tailwind spells a negative two ways and both must count, or either spelling
  // is a way past the census.
  assert.ok(found.includes('-mt-[4px]'), 'a leading-minus negative utility was not counted')
  assert.ok(found.includes('mb-[-6px]'), 'a minus-inside-the-bracket negative was not counted')

  // Each exclusion asserted on its own, because "the list came out right" does
  // not say WHICH rule produced it, and these four are the ones a future edit
  // to the pattern is most likely to break:
  //   sizes are out of scope entirely
  assert.equal(found.filter((c) => c.startsWith('w-') || c.startsWith('h-')).length, 0,
    'a width or height was counted — sizes are deliberately out of this file\'s scope')
  assert.equal(found.filter((c) => c.startsWith('max-') || c.startsWith('min-w') || c.startsWith('min-h')).length, 0,
    'a max-/min- size was counted — sizes are deliberately out of this file\'s scope')
  //   a breakpoint variant is not a margin, however many brackets it has
  assert.ok(found.includes('px-[13px]') && !found.some((c) => c.includes('561')),
    'min-[561px]:px-[13px] must count the px-[13px] and NOT read the variant as an m-[...]')
  //   and the fixed shape is not the debt
  assert.equal(found.filter((c) => c.includes('var(')).length, 0,
    'px-[var(--token)] was counted as debt — that is the fix, not the problem')
})

test('the hand-written spacing is a debt that only shrinks', () => {
  const { files, hits, sizeHits } = scan()
  const byCls = {}
  for (const h of hits) byCls[h.cls] = (byCls[h.cls] || 0) + 1

  const inventory = Object.entries(byCls)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `  ${String(n).padStart(3)}  ${cls}${CENSUS[cls] === undefined ? '   <- NEW' : n > CENSUS[cls] ? `   <- was ${CENSUS[cls]}` : ''}`)
    .join('\n')

  // The scope boundary, printed rather than asserted, so the next person reads
  // the size figure instead of re-deriving it. This file does not police these:
  // its header says why a width is not a step on a spacing scale.
  const scopeNote =
    `In scope (padding/margin/gap/inset): ${hits.length} across ${new Set(hits.map((h) => h.rel)).size} files.\n` +
    `Out of scope (w-/h-/min-/max-/…):    ${sizeHits.length} across ${new Set(sizeHits.map((h) => h.rel)).size} files.\n` +
    `Total arbitrary pixel utilities:     ${hits.length + sizeHits.length}.`

  const grown = Object.entries(byCls)
    .filter(([cls, n]) => CENSUS[cls] === undefined || n > CENSUS[cls])
    .map(([cls, n]) => `  ${cls}: ${n}${CENSUS[cls] === undefined ? ' (not in the census at all)' : ` (census says ${CENSUS[cls]})`}`)

  assert.deepEqual(
    grown,
    [],
    `hand-written spacing grew.\n\n` +
      `This is a ratchet on EACH CLASS, not on the total — swapping one nudge for\n` +
      `another keeps the total at ${ARBITRARY_BUDGET} and is exactly what this is here to catch.\n\n` +
      `If the value you added shares a ROLE with others, give it a token in\n` +
      `ui/src/index.css at the value it already renders and use that. If it is a\n` +
      `genuine one-off nudge, add or raise its line in CENSUS in this file, in the\n` +
      `same diff, so the debt is taken on in the open.\n\n` +
      grown.join('\n') +
      `\n\n${scopeNote}\n\n${inventory}\n\n(scanned ${files.length} source files under ${ROOT})`
  )

  // The other direction, and it is NOT an assertion. Paying debt must never fail
  // a build, so a class that shrank or vanished is reported for the census to be
  // trimmed at leisure rather than made a blocker.
  const shrunk = Object.entries(CENSUS).filter(([cls, n]) => (byCls[cls] || 0) < n)
  if (shrunk.length) {
    console.log(
      `spacingRoles: ${shrunk.length} class(es) shrank since the census was written — ` +
        `trim CENSUS when convenient: ` +
        shrunk.map(([cls, n]) => `${cls} ${n}->${byCls[cls] || 0}`).join(', ')
    )
  }
})

test('--sp-ledger-inset is declared, and every ledger cell uses it', () => {
  // The extraction this file was written alongside, guarded from both ends.
  //
  // A token nothing references is dead weight, and a reference to a token
  // nothing declares is a silent no-op: `px-[var(--nope)]` is not a build error
  // and not a runtime error, it simply renders no padding. Neither half is
  // visible to the ratchet above, because both are spelled exactly like the fix.
  // Comments stripped from both files first. index.css is mostly prose — the
  // block above this token runs twenty lines — and DossierPage.jsx now carries a
  // comment naming the token by name. Either would satisfy a bare text search
  // and let a real declaration or a real call site go missing underneath it.
  const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const css = stripCss(fs.readFileSync(path.join(REPO, 'ui/src/index.css'), 'utf8'))
  // The semicolon is required: `--sp-ledger-inset: 8px-ish` would satisfy a
  // pattern that stopped at the unit, and an invalid value makes the var()
  // invalid at computed-value time, which paints no padding at all.
  //
  // 8px, not the 11px this token was extracted at. Extraction named the value
  // without moving it, because moving it is a look change docs/SCREENS.md puts
  // behind a variant set and the owner naming one. That happened:
  // .mockups/spacing-scale/all.html offered four directions and v2 was chosen,
  // whose ladder is 0/4/8/16 — every value from 6 to 11 lands on 8, and 12 does
  // not exist on it. The number is pinned here rather than left loose so that
  // the next move is also a decision rather than a drift.
  assert.match(
    css,
    /--sp-ledger-inset:\s*8px\s*;/,
    '--sp-ledger-inset is not declared as a complete `8px;` in ui/src/index.css, so every px-[var(--sp-ledger-inset)] renders no padding at all'
  )

  const dossier = stripJs(fs.readFileSync(path.join(REPO, 'ui/src/components/DossierPage.jsx'), 'utf8'))
  const used = (dossier.match(/px-\[var\(--sp-ledger-inset\)\]/g) || []).length
  // FOUR, counted: the field cell (CELL), the two ledger head cells, and the
  // threat-intel panel embedded below the last row. All four share one left
  // edge, and that alignment is the whole point of the ledger.
  assert.equal(
    used, 4,
    `expected 4 uses of --sp-ledger-inset in DossierPage.jsx, found ${used} — a ledger cell has drifted off the shared inset, which is how the four hand-written 11px values got out of step in the first place`
  )
  assert.equal(
    (dossier.match(/px-\[11px\]/g) || []).length, 0,
    'a hand-written px-[11px] came back to DossierPage.jsx alongside the token'
  )

  // THE ASSERTION THE MOVE TO 8px MADE NECESSARY.
  //
  // While the inset was 11px, a ledger cell that stopped using the token had to
  // say px-[11px], and the ratchet above caught it. Now that it is 8px, px-2
  // renders exactly the same thing — so a drifted cell is invisible to the
  // ratchet, invisible to the eye, and invisible to any test that only compares
  // rendered pixels. The four-use count above does not cover it either: a FIFTH
  // ledger cell written with px-2 leaves that count at four and still passes.
  //
  // So every element carrying `ledger-cell` is checked to also carry the token,
  // which is the only form of the check that survives the value coinciding with
  // a scale step.
  const ledgerCells = dossier.match(/className=(?:"|`|')[^"`']*\bledger-cell\b[^"`']*(?:"|`|')/g) || []
  assert.ok(
    ledgerCells.length >= 3,
    `expected to find ledger-cell class strings in DossierPage.jsx, found ${ledgerCells.length} — this check has stopped looking at anything`
  )
  const drifted = ledgerCells.filter((c) => !c.includes('px-[var(--sp-ledger-inset)]'))
  assert.deepEqual(
    drifted, [],
    `a ledger cell carries its own horizontal padding instead of --sp-ledger-inset:\n  ${drifted.join('\n  ')}\n` +
      `Since the token is 8px, px-2 renders identically and nothing else in this suite would notice the drift.`
  )

  // And the fixture that proves the check can fail, because a filter over a
  // regex match is exactly the shape that silently matches nothing.
  const FIXTURE = 'className="ledger-cell px-2 border-r"'
  const fixtureCells = [FIXTURE].filter((c) => !c.includes('px-[var(--sp-ledger-inset)]'))
  assert.equal(
    fixtureCells.length, 1,
    'the ledger-cell drift check does not flag a cell written with px-2, so it would not have caught the thing it exists for'
  )
})
