// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THE TYPE SCALE IS A RATCHET, NOT A WALL.
//
// 18 distinct type sizes were in use and index.css declared no font-size token
// at all, so every one was an arbitrary value written at the call site:
//
//   234 text-[11px]   78 text-sm    61 text-xs      47 text-[12px]  22 text-[10px]
//    19 text-lg       19 text-[10.5px]  16 text-[13px]   9 text-2xl   4 text-xl
//     3 text-base      2 text-[30px]     2 text-[11.5px]  1 text-[9px] 1 text-[26px]
//     1 text-[16px]    1 text-[15px]     1 text-[13.5px]
//
// 394 of them moved onto five role tokens at the values they already rendered.
// Proof it changed nothing: computed font-size was histogrammed for every
// visible element under <main> on all 15 tabs, before and after — 2,957
// elements and 23 distinct font-size/line-height pairs, byte-identical
// histograms. The line-height half of that is not decoration: the first two
// attempts changed 641 and then 255 elements' leading while every font-size
// stayed put, and index.css records why.
//
// WHY THIS IS A RATCHET. The remaining 80 sites are not a mess to be tidied
// quietly; they are the sizes that CANNOT move without changing how the app
// looks, and docs/SCREENS.md puts a look change behind a variant set and the
// owner naming one. So they are listed here, by value, where they can be
// counted and decided. The list may SHRINK — that is the point — and this test
// fails if it grows, or if a size appears that is on neither list.
//
// The count is asserted as a ceiling rather than an equality so that deleting a
// panel does not fail the build; only ADDING to the debt does.
//
// SCOPE: string literals in ui/src/**/*.jsx. Not covered: font sizes written
// into style objects or passed to recharts (ChartTip's fontSize: 12, the axis
// ticks' 10 and 11, the drag ghost's 13px). Those are JS numbers, not
// utilities, and are named in index.css as still outstanding.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOT = 'ui/src'
const SKIP_DIRS = new Set(['node_modules'])

const ROLES = new Set(['text-display', 'text-title', 'text-body', 'text-dense', 'text-caption'])

// The sizes still written by hand, and why each is still here. Every one would
// change a rendered size to remove, which is the owner's call, not this test's.
const EXCEPTIONS = new Map([
  ['text-2xl', 'KPI numbers. 24px is above WCAG large-text (18.66px bold); several KPI colours pass ONLY at that size'],
  ['text-xl', 'smaller KPI numbers, same reason'],
  ['text-base', 'dialog h1 in VaultGate'],
  ['text-[26px]', 'the Changes hero number'],
  ['text-[16px]', "DossierPage's inline-edit input"],
  ['text-[15px]', "one Security stat"],
  ['text-[13.5px]', "the Card panel h2. Moving it feeds headNeed() -> publish() -> spanFor(), so panels claim different track spans on every fitted tab"],
  ['text-[13px]', 'secondary body text'],
  ['text-[12px]', 'the same SIZE as text-dense but not the same role: text-dense carries a 16px line-height (from text-xs) and these inherit theirs. Folding them together silently relayouts 47 elements'],
  ['text-[11.5px]', "the Changes feed row and DataTable's view-all link"],
  ['text-[10.5px]', "DataTable column headers and dense chips. The th and headProbeRef MUST carry the same string — see typeScaleProbes in tests/table-sizing.spec.ts"],
  ['text-[10px]', 'dense chrome'],
  ['text-[9px]', 'an aria-hidden caret glyph in App.jsx — an icon, not text'],
])

// Measured at the commit that introduced this file. A ceiling, not an equality.
const EXCEPTION_BUDGET = 127

// The trailing boundary is INSIDE the word alternative, not after the whole
// group. `\b` after `text-[26px]` asks for a word/non-word transition where
// there is none — `]` and the closing quote are both non-word — so every
// bracketed size was silently unmatched and the first test below passed by
// seeing nothing. The dead-exception check in the second test is what caught it.
const SIZE = /\btext-(?:\[[0-9.]+(?:px|rem|em)\]|(?:xs|sm|base|lg|[2-9]xl|xl|display|title|body|dense|caption)\b)/g

function walk(rel, out) {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(rel, e.name), out) }
    else if (e.isFile() && path.extname(e.name) === '.jsx') out.push(path.join(rel, e.name))
  }
  return out
}

// Same collector as radiusRoles.test.js and onFillForegrounds.test.js: a class
// name is always inside a literal, prose in a comment never is.
function stringLiterals(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i], next = src[i + 1]
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

function scan() {
  const files = walk(ROOT, [])
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length} — ROOT may be wrong`)
  const hits = []
  for (const rel of files) {
    for (const { line, text } of stringLiterals(fs.readFileSync(path.join(REPO, rel), 'utf8'))) {
      for (const cls of text.match(SIZE) || []) hits.push({ rel, line, cls, text })
    }
  }
  return { files, hits }
}

test('every type size is a role token or a listed exception', () => {
  const { files, hits } = scan()
  const bad = hits
    .filter((h) => !ROLES.has(h.cls) && !EXCEPTIONS.has(h.cls))
    .map((h) => `${h.rel}:${h.line}: ${h.cls} — ${h.text.trim().slice(0, 80)}`)

  assert.deepEqual(
    bad,
    [],
    `a type size that is neither a role nor a listed exception.\n\n` +
      `Roles: ${[...ROLES].join(', ')} — declared in ui/src/index.css.\n` +
      `If the size genuinely cannot be one of those, add it to EXCEPTIONS in\n` +
      `this file WITH THE REASON, and raise EXCEPTION_BUDGET in the same diff.\n\n` +
      bad.join('\n') +
      `\n\n(scanned ${files.length} .jsx files under ${ROOT})`
  )
})

test('the hand-written sizes are a debt that only shrinks', () => {
  const { hits } = scan()
  const used = hits.filter((h) => EXCEPTIONS.has(h.cls))
  const byCls = {}
  for (const h of used) byCls[h.cls] = (byCls[h.cls] || 0) + 1

  assert.ok(
    used.length <= EXCEPTION_BUDGET,
    `hand-written type sizes grew from ${EXCEPTION_BUDGET} to ${used.length}.\n` +
      `Use a role token, or make the case for a new exception and move the budget\n` +
      `deliberately in the same diff.\n\n` +
      Object.entries(byCls).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v.toString().padStart(3)}  ${k}`).join('\n')
  )

  // An exception nobody uses is a line of documentation pointing at nothing.
  const dead = [...EXCEPTIONS.keys()].filter((k) => !byCls[k])
  assert.deepEqual(dead, [], `EXCEPTIONS lists sizes that no longer appear — delete them and lower EXCEPTION_BUDGET:\n  ${dead.join('\n  ')}`)
})

test('the role tokens are actually used, so this cannot pass by emptiness', () => {
  const { hits } = scan()
  for (const role of ROLES) {
    assert.ok(hits.some((h) => h.cls === role), `${role} is declared in index.css but used nowhere in ${ROOT}`)
  }
})
