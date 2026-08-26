// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// ONE RADIUS SCALE, AND IT IS NAMED BY ROLE.
//
// Seven families were in use across ui/src, and the one token the project
// actually declared was the least used of them:
//
//   rounded-lg    8px   81      rounded-full  41
//   rounded       4px   15      rounded-md    6px   12
//   rounded-sm    2px    9      rounded-card  12px   7
//   rounded-xl   12px    1
//
// Nothing chose between 6px and 8px on purpose. Two names for one intention is
// how a scale rots: the next control gets whichever the file it was copied from
// happened to use, and after enough copies the surface mixes families, which
// docs/SCREENS.md calls a defect rather than a variation.
//
// So the utilities say what a thing IS:
//
//   rounded-surface  12px  cards, dialogs, drawers, the command palette
//   rounded-control   8px  anything you click or type into
//   rounded-mark      4px  smaller than a control: inline code, swatches
//   rounded-full       —   pills, the one shape that is not on the scale
//
// This test is the guard, and it is an ALLOWLIST. A denylist of the five
// migrated names is the version that looks right and is not: rounded-none,
// rounded-xs, rounded-2xl, rounded-3xl, an arbitrary rounded-[7px] and v4's
// rounded-(--foo) all sail past it, and so does md:rounded-lg. Anything
// matching `rounded…` that is not one of the four permitted spellings fails.
//
// IT SCANS STRING LITERALS ONLY, which is the whole reason it can be strict.
// A className is always inside a '', "" or `` literal, and prose never is —
// charts/StackedDayBars.jsx says "carries the rounded cap" in a comment, which
// is English. Collecting literals is a much smaller job than stripping
// comments correctly (regex literals, `//` inside a URL, division), and it
// fails in the safe direction: a literal the collector misses is a hit not
// reported, never a false accusation against prose.
//
// SCOPE:
//   Covered:     string and template literals in ui/src/**/*.jsx
//   Not covered: ui/src/index.css, which DECLARES the scale; go/web, generated
//                from ui/dist; tests/, whose locators name rendered classes on
//                purpose (tests/selfservice-manage.spec.ts says so at the line).
//   NOT covered: a radius written straight into a style object. Those are JS
//                numbers rather than utilities, so no scan of the source can
//                see them. The later pass this used to defer happened:
//                ChartTip's `borderRadius: 8` and its 2px legend swatch are
//                `var(--radius-control)` and `var(--radius-mark)` now, and
//                tests/chart-tokens.spec.ts asserts the resolved px in a
//                browser, which is where a var() can be proved to resolve.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// this file lives at <repo>/ui/src/lib/ — three levels below the repo root
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOT = 'ui/src'
const SKIP_DIRS = new Set(['node_modules'])

// The four permitted spellings. Everything else that starts `rounded` is a
// failure, including sides and corners (rounded-t-*, rounded-ss-*) and variant
// prefixes (md:, hover:, focus-visible:), which are stripped before the check.
const ALLOWED = new Set(['rounded-surface', 'rounded-control', 'rounded-mark', 'rounded-full'])

// Any radius utility at all, with its optional side/corner segment captured so
// `rounded-t-control` is judged as `rounded-control`.
//
// Longest-first in the side alternation, and it is not cosmetic: with `s`
// listed before `ss`, `rounded-surface` matched as side `s` plus nothing and
// every dialog in the tree was reported as a violation of a rule it obeys.
const SIDE = '(?:tl|tr|br|bl|ss|se|es|ee|t|r|b|l|s|e)'
// The WHOLE token, so `rounded-t-control` and `rounded-[7px]` each come back as
// one string to judge rather than a prefix of one.
const RADIUS = /\brounded(?:-[A-Za-z0-9[\]().%_-]+)?/g

// Collect every '', "" and `` literal. A className is always in one; prose in a
// comment never is. Comments are skipped so a quote inside them ("don't") does
// not open a phantom literal and swallow the rest of the file.
function stringLiterals(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
    } else if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 2
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c
      // line number of the opening quote, for the report
      const line = src.slice(0, i).split('\n').length
      let j = i + 1
      let buf = ''
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue }
        if (src[j] === quote) break
        // An unterminated '' or "" would otherwise run to the end of the file
        // and drag every later literal into one blob.
        if (quote !== '`' && src[j] === '\n') break
        buf += src[j]
        j++
      }
      out.push({ line, text: buf })
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

function walk(rel, out) {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(rel, e.name), out)
    } else if (e.isFile() && path.extname(e.name) === '.jsx') {
      out.push(path.join(rel, e.name))
    }
  }
  return out
}

test('every radius in ui/src names a role, not a size', () => {
  const files = walk(ROOT, [])

  // A silent zero-file scan would make this pass forever if the layout moved.
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length} — ROOT may be wrong`)

  const bad = []
  for (const rel of files) {
    for (const { line, text } of stringLiterals(fs.readFileSync(path.join(REPO, rel), 'utf8'))) {
      for (const raw of text.match(RADIUS) || []) {
        // strip a `md:` / `hover:` style variant prefix before judging
        const cls = raw.slice(raw.lastIndexOf(':') + 1)
        // fold rounded-t-control down to rounded-control
        const folded = cls.replace(new RegExp(`^rounded-${SIDE}-`), 'rounded-')
        if (!ALLOWED.has(folded)) bad.push(`${rel}:${line}: ${cls} — ${text.trim().slice(0, 90)}`)
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    `legacy radius utility in ui/src.\n\n` +
      `Only four spellings are allowed. Pick the ROLE, not a size:\n` +
      `  rounded-surface  a card, dialog or drawer\n` +
      `  rounded-control  anything you click or type into  (was rounded-lg / rounded-md)\n` +
      `  rounded-mark     smaller than a control            (was rounded / rounded-sm)\n` +
      `  rounded-full     a pill\n\n` +
      bad.join('\n') +
      `\n\n(scanned ${files.length} .jsx files under ${ROOT})`
  )
})

test('the role utilities are actually used, so this test cannot pass by emptiness', () => {
  // The check above is satisfied by a tree with no radii at all. This one fails
  // if the roles stop being used, which is the other way the scale could rot.
  const files = walk(ROOT, [])
  const text = files
    .flatMap((r) => stringLiterals(fs.readFileSync(path.join(REPO, r), 'utf8')))
    .map((l) => l.text)
    .join('\n')

  for (const role of ['rounded-surface', 'rounded-control', 'rounded-mark']) {
    const n = (text.match(new RegExp(`\\b${role}\\b`, 'g')) || []).length
    assert.ok(n > 0, `${role} is declared in index.css but used nowhere in ${ROOT}`)
  }
})
