// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THREE SIZES, AND THE LIST OF EXCEPTIONS IS DOWN TO ONE.
//
// The app had 18 hand-written type sizes and no font-size token. #189 moved 394
// call sites onto five roles WITHOUT changing a pixel, and left 127 that could
// not move because moving them changes how the app looks — a decision
// docs/SCREENS.md puts behind a variant set and the owner naming one.
//
// The owner named v1 from .mockups/type-scale/all.html on 2026-08-25. So the
// five roles are three, the 127 are gone, and 520 call sites now carry one of:
//
//   text-figure  24px  the number a panel exists to show
//   text-copy    14px  a sentence or a heading
//   text-note    11px  a label
//
// ONE EXCEPTION REMAINS, and it is not a size that lost an argument. App.jsx's
// 9px caret is an aria-hidden glyph standing in for an icon; putting it on a
// TEXT scale would be filing it under the wrong thing, not tidying it.
//
// This stays a ratchet. Anything that is neither a role nor the listed
// exception fails; the exception count may shrink but not grow; and an
// exception nobody uses is reported as dead so the list cannot rot.
//
// SCOPE: string literals in ui/src/**/*.jsx. Not covered: font sizes written
// into style objects or passed to recharts (ChartTip's fontSize: 12, the axis
// ticks' 10 and 11, the drag ghost's 13px). Those are JS numbers, not
// utilities, and index.css names them as still outstanding.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOT = 'ui/src'
const SKIP_DIRS = new Set(['node_modules'])

const ROLES = new Set(['text-figure', 'text-copy', 'text-note'])

// The one size still written by hand, and why it is not a defeat.
const EXCEPTIONS = new Map([
  ['text-[9px]', "App.jsx's caret. An aria-hidden glyph standing in for an icon, so a TEXT scale is the wrong place to file it"],
])

// A ceiling, not an equality: deleting the caret should not fail the build,
// only adding to the debt should.
const EXCEPTION_BUDGET = 1

// The trailing boundary is INSIDE the word alternative, not after the whole
// group. `\b` after `text-[26px]` asks for a word/non-word transition where
// there is none — `]` and the closing quote are both non-word — so every
// bracketed size was silently unmatched and the first test below passed by
// seeing nothing. The dead-exception check in the second test is what caught it.
const SIZE = /\btext-(?:\[[0-9.]+(?:px|rem|em)\]|(?:xs|sm|base|lg|[2-9]xl|xl|figure|copy|note)\b)/g

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
