// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// ONE PAIR OF NUMBERS DECIDES AMBER AND RED, AND NO PAGE KEEPS ITS OWN.
//
// lib/utilBands.js says why there is one pair and why it is 70 and 90. This
// file holds the two halves of keeping it that way: the rule itself, at its
// edges, and a read of the source for any page that has gone back to comparing
// a utilisation against a number of its own.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UTIL_CRIT, UTIL_WARN, utilBand } from './utilBands.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('amber starts at 70 and red at 90, the pair the server counts with', () => {
  assert.equal(UTIL_WARN, 70)
  assert.equal(UTIL_CRIT, 90)
  // The server's half of the same pair. If either file stops saying it, the
  // pages and the server's whole-network counts no longer mean the same thing.
  const go = (rel) => fs.readFileSync(path.resolve(SRC, '..', '..', 'go', 'internal', 'dashboard', rel), 'utf8')
  assert.match(go('signals.go'), /if util >= 90 \{/, 'signals.go no longer grades a subnet critical from 90')
  assert.match(go('signals.go'), /\} else if util >= 70 \{/, 'signals.go no longer grades a subnet a warning from 70')
  assert.match(go('dashboard.go'), /"_filter": +"utilization\.utilization>=90"/, 'dashboard.go no longer counts critical subnets from 90')
  assert.match(go('dashboard.go'), /"_filter": +"utilization\.utilization>=70"/, 'dashboard.go no longer loads at-risk subnets from 70')
})

test('a subnet\'s utilisation is a whole number, so "70–89%" names the whole amber band', () => {
  // If the server ever sent 89.5, it would be amber under a label that stops
  // at 89. It cannot today: norm.go rounds used/total to an integer.
  const norm = fs.readFileSync(path.resolve(SRC, '..', '..', 'go', 'internal', 'dashboard', 'norm.go'), 'utf8')
  assert.match(norm, /pct = int\(math\.RoundToEven\(float64\(used\) \/ float64\(total\) \* 100\)\)/, 'norm.go no longer rounds utilisation to an integer')
})

test('utilBand is inclusive at both edges', () => {
  assert.equal(utilBand(0), 'ok')
  assert.equal(utilBand(69.9), 'ok')
  assert.equal(utilBand(70), 'warn')
  assert.equal(utilBand(88), 'warn') // red on Network and counted by Daily, before this
  assert.equal(utilBand(89.9), 'warn')
  assert.equal(utilBand(90), 'crit')
  assert.equal(utilBand(91), 'crit') // amber in every table, before this
  assert.equal(utilBand(100), 'crit')
})

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) jsxFiles(p, out)
    else if (e.name.endsWith('.jsx')) out.push(p)
  }
  return out
}

// A utilisation compared against a two- or three-digit number written in
// place. The left side is anything that names one (`util`, `s.util`, `pct`, or
// the bare `u` of a band test), with whatever sits between it and the operator:
// `util >= 92`, `u > 85`, `(Number(s.util) || 0) >= 85`,
// `Number(s.util ?? 0) >= 85`, `r.pct >= 75`.
//
// Run over a file's whole text with its comments taken out, not line by line,
// so a comparison broken across two lines is one comparison here too.
const OWN_NUMBER = /(?:\b\w*[uU]til\w*|\bpct\b|\bu\b)[^;=<>]{0,30}?(>=|<=|>|<)\s*\d{2,3}\b/g

// The source with comments blanked in place, so offsets still give line numbers.
function withoutComments(src) {
  return src
    .replace(/(^|[\s{(,])\/\*[\s\S]*?\*\//gm, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

// Every place in `src` a utilisation meets a number of its own, as line numbers.
function ownNumbers(src) {
  const code = withoutComments(src)
  return [...code.matchAll(OWN_NUMBER)].map((m) => code.slice(0, m.index).split('\n').length)
}

test('the scan sees every way a page has written its own number', () => {
  for (const line of [
    'if (util >= 92) return',
    'const over = band((u) => u > 85)',
    'x.filter((s) => (Number(s.util) || 0) >= 85)',
    'x.filter((s) => Number(s.util ?? 0) >= 85)',
    'const hot = r.pct >= 75',
    'measured.filter((s) => num(s.util) >= 90)',
    'const critical = s.util >=\n  90',
    'const critical = s.util\n  >= 90',
  ]) assert.equal(ownNumbers(line).length, 1, `not caught: ${line}`)
  for (const line of [
    "const band = utilBand(util)",
    'const opacity = Math.max(0.15, Math.min(1, util / 100))',
    "utilBand(Number(s.util) || 0) === 'crit'",
    'r._days < 90 ? { color: COLORS.warn } : undefined',
    '<span>{fmtValue(tip.util)}% used</span>',
    '// the old rule was util >= 92',
    '{/* util >= 75 was amber */}',
  ]) assert.deepEqual(ownNumbers(line), [], `wrongly caught: ${line}`)
})

test('no page grades fullness against a number of its own', () => {
  const files = jsxFiles(SRC)
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length}`)
  const found = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    for (const n of ownNumbers(src)) found.push(`${path.relative(SRC, f)}:${n}  ${lines[n - 1].trim().slice(0, 90)}`)
  }
  assert.deepEqual(found, [], `use utilBand(), UTIL_WARN or UTIL_CRIT from lib/utilBands.js:\n  ${found.join('\n  ')}`)
})
