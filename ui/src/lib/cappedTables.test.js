// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// NO TABLE MAY BE CAPPED WHERE NOTHING CAN SAY SO.
//
// DataTable prints "showing N of M — filter to narrow" when it is handed more
// rows than its rowCap. That footer is this repo's answer to a truncated table
// and it has one blind spot that is invisible from inside DataTable: IT CAN
// ONLY COUNT THE ROWS IT IS GIVEN. Cut the list before handing it over and
// DataTable sees a short list, correctly reports no truncation, and the rows
// dropped upstream leave no trace anywhere on the page.
//
// v3.67.4 fixed two panels shaped exactly like that. Measured on the live
// tenant before that release: "Which Subnets Run Out First?" ran
// `sorted.slice(0, 20)` and passed the 20 to a DataTable whose rowCap was 150,
// so 440 of 460 eligible subnets were missing with nothing on screen admitting
// it — under a filter box and a site selector whose whole purpose is to narrow
// a set the reader could not see the size of.
//
// ui/src/lib/capLabels.test.js pins those two panels by name. It says so in its
// own header: a THIRD panel with the same defect would not be caught. There are
// 27 DataTable render sites across 10 files. This file is the general rule, and
// capLabels.test.js stays as the specific one because it also covers the IPAM
// bar list, which is not a DataTable and so is invisible here.
//
// ---------------------------------------------------------------------------
// THE RULE, AND WHY IT IS NOT "NEVER SLICE".
//
// An upstream cap is perfectly correct when the panel states its own
// denominator — Overview's "top 12 of N subnets" does exactly that, and so does
// the DNSSEC panel below. A blanket ban would fire on correct code, which is
// precisely why capLabels.test.js named two panels instead of writing a rule.
//
// So the rule is: a table whose rows were cut before DataTable saw them must be
// declared here, WITH the pattern that proves its panel prints a denominator.
// The declaration is not a mute button. A panel that stops printing its label
// fails this test even though it is on the list, because the list stores the
// evidence rather than an exemption.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT CATCH. Read this before trusting a green run.
//
//   - A cap applied in the SERVER, or by the fetch, before the tab ever sees a
//     row. That is the `truncated`/`total_available` contract, and it is
//     lib/feedCount.js and lib/sampleCount.js that answer for it.
//   - A panel that is not a DataTable. Bar lists, chips, heatmaps and KPI tiles
//     all cap their own input and none of them appear here.
//   - `rows={...}` written as an inline expression rather than an identifier.
//     Those are reported as UNRESOLVED and fail loudly rather than passing
//     quietly, because a scanner that silently skips what it cannot parse is
//     the same class of bug as the one it is looking for.
//   - Whether the denominator a panel prints is the RIGHT number. The regexes
//     below prove a label exists and is wired to a count, not that the count is
//     correct.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_DIRS = ['tabs', 'components']

// ---------------------------------------------------------------------------
// DECLARED CAPS. One entry per table that legitimately cuts its rows upstream.
//
// `label` must match somewhere inside that panel's own function body, and it is
// the whole point of the entry: it is the code that puts a denominator on
// screen. Add an entry only after checking the panel actually renders one.
const DECLARED_CAPS = [
  {
    file: 'tabs/Dns.jsx',
    fn: 'DnssecHealth',
    why:
      'Ranks the worst unsigned zones and draws DNSSEC_CAP of them. It prints ' +
      'dnssecPanelLabel(unsigned.length, DNSSEC_CAP) in its Card `right` slot, ' +
      'so the count it is showing and the count it matched are both on screen. ' +
      'Its own comment records that this panel used to say "worst 150" over a ' +
      'set that was not 150.',
    label: /dnssecPanelLabel\(unsigned\.length, DNSSEC_CAP\)/,
  },
]

// ---------------------------------------------------------------------------
// Comment and string stripping.
//
// A local copy, deliberately, exactly as panelHelpTruth.test.js keeps its own:
// panelHelp.test.js is the coverage guarantee and is meant to stay
// byte-identical, so nothing may edit it to export a helper. Without this, the
// long comment in Network.jsx that QUOTES the old `sorted.slice(0, 20)` to
// record what was wrong would be read as code, and the honest fix would be to
// delete the explanation. A guard that cannot tell code from prose about code
// teaches people to delete the prose.
//
// Newlines are preserved so any line number reported stays true to the file.
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    const q = src[i]
    if (q === '"' || q === "'" || q === '`') {
      out += q
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += q
      i++
      continue
    }
    out += src[i]
    i++
  }
  return out
}

/** Every top-level `function Name(...) {` block in a file, by name. */
function functionBlocks(src) {
  const blocks = []
  const re = /^(?:export\s+default\s+|export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm
  const starts = []
  let m
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1], at: m.index })
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length
    blocks.push({ name: starts[i].name, body: src.slice(starts[i].at, end) })
  }
  return blocks
}

/**
 * Does `ident` trace back to a `.slice(` within this block?
 *
 * Follows the binding chain — `tableRows` -> `shown` -> `unsigned.slice(...)` —
 * because the real defect was two hops deep, not one. Depth is bounded so a
 * mutually recursive pair of bindings cannot hang the suite.
 */
function tracesToSlice(block, ident, depth = 0) {
  if (depth > 6) return false
  const b = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*([\\s\\S]{0,600}?)\\n\\s*(?:const|return|function|\\}|//)`, 'm')
  const m = block.match(b)
  if (!m) return false
  const init = m[1]
  if (/\.slice\(\s*0\s*,/.test(init)) return true
  for (const ref of init.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:map|filter|sort|concat)\(/g)) {
    if (ref[1] !== ident && tracesToSlice(block, ref[1], depth + 1)) return true
  }
  return false
}

test('no DataTable is handed rows that were already cut, unless its panel prints a denominator', () => {
  const findings = []
  const unresolved = []
  const declaredSeen = new Set()

  for (const dir of SCAN_DIRS) {
    for (const name of fs.readdirSync(path.join(SRC, dir)).filter((f) => f.endsWith('.jsx'))) {
      const rel = `${dir}/${name}`
      // DataTable.jsx is the component itself: its own `rows` prop is the input
      // being judged, not a call site.
      if (rel === 'components/DataTable.jsx') continue
      const src = stripComments(fs.readFileSync(path.join(SRC, dir, name), 'utf8'))

      for (const block of functionBlocks(src)) {
        for (const call of block.body.matchAll(/<DataTable\b[^>]*?\brows=\{([^}]*)\}/gs)) {
          const expr = call[1].trim()
          if (!/^[A-Za-z_$][\w$]*$/.test(expr)) {
            unresolved.push(`${rel} ${block.name}: rows={${expr.slice(0, 40)}}`)
            continue
          }
          if (!tracesToSlice(block.body, expr)) continue

          const declared = DECLARED_CAPS.find((d) => d.file === rel && d.fn === block.name)
          if (!declared) {
            findings.push(
              `${rel} ${block.name}: rows={${expr}} is cut before DataTable sees it, and this panel is ` +
                'not in DECLARED_CAPS. Either hand DataTable the full set and let its rowCap do the ' +
                'capping (it prints "showing N of M"), or print a denominator and declare it.',
            )
            continue
          }
          declaredSeen.add(`${rel}::${block.name}`)
          assert.match(
            block.body,
            declared.label,
            `${rel} ${block.name} is declared as capped-by-design, but the label that justifies it is gone. ` +
              `The declaration stores the evidence, not an exemption. Reason on file: ${declared.why}`,
          )
        }
      }
    }
  }

  assert.deepEqual(unresolved, [], 'a rows={...} expression could not be resolved to an identifier — this scanner must not skip what it cannot read')
  assert.deepEqual(findings, [], `capped tables with no denominator:\n${findings.join('\n')}`)

  // A declaration for a panel that no longer caps is dead weight that reads as
  // a live exemption, so it is an error in the other direction too.
  for (const d of DECLARED_CAPS) {
    assert.ok(
      declaredSeen.has(`${d.file}::${d.fn}`),
      `DECLARED_CAPS lists ${d.file} ${d.fn}, but nothing there caps its rows any more. Delete the entry.`,
    )
  }
})

// The scanner is the thing most likely to rot into a no-op, so it is checked
// against inputs whose answers are known rather than trusted because it printed
// nothing. A source-shape test that silently stops matching looks exactly like
// a clean codebase.
test('the scanner actually detects the shape it is looking for', () => {
  const direct = `
function Panel() {
  const sorted = useMemo(() => sortRows(filtered), [filtered])
  const top20 = sorted.slice(0, 20)
  return <DataTable rows={top20} columns={columns} rowCap={150} />
}`
  const twoHops = `
function Panel() {
  const shown = unsigned.slice(0, CAP)
  const tableRows = shown.map((r) => ({ ...r }))
  return <DataTable rows={tableRows} columns={columns} />
}`
  const clean = `
function Panel() {
  const sorted = useMemo(() => sortRows(filtered), [filtered])
  const tableRows = sorted.map((r) => ({ ...r }))
  return <DataTable rows={tableRows} columns={columns} rowCap={150} />
}`
  const inAComment = `
function Panel() {
  // This used to be \`sorted.slice(0, 20)\`, which was the bug.
  const tableRows = sorted.map((r) => ({ ...r }))
  return <DataTable rows={tableRows} columns={columns} rowCap={150} />
}`

  const check = (src, ident) => tracesToSlice(functionBlocks(stripComments(src))[0].body, ident)
  assert.equal(check(direct, 'top20'), true, 'a one-hop slice must be caught')
  assert.equal(check(twoHops, 'tableRows'), true, 'a two-hop slice must be caught — the real defect was two hops deep')
  assert.equal(check(clean, 'tableRows'), false, 'an uncapped table must not be flagged')
  assert.equal(check(inAComment, 'tableRows'), false, 'a slice quoted in a comment is prose, not code')
})
