// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// NO HARD-CODED WHITE ON A SEMANTIC FILL.
//
// Fifteen places put a label on an accent, crit or ok fill and spelled the
// foreground themselves: four as `color: '#fff'` in a style object, eleven as
// the `text-white` utility. Measuring the six fill/theme pairs against WCAG AA
// 1.4.3 (4.5:1; these labels are 13-14px, i.e. normal text) said white is wrong
// on three of them:
//
//   fill                  white   #050505
//   dark  accent #0070f3   4.55     4.48   -> white
//   dark  crit  #ee4444    3.79     5.38   -> near-black   white FAILED
//   dark  ok    #4ade80    1.74    11.70   -> near-black   white FAILED badly
//   light accent #0070f3   4.55     4.48   -> white
//   light crit  #dc2626    4.83     4.22   -> white
//   light ok    #16a34a    3.30     6.18   -> near-black   white FAILED
//
// So the answer is per fill and per theme, which is what --color-on-accent,
// --color-on-crit and --color-on-ok are for. tests/contrast.spec.ts measures
// those three TOKENS against their fills and fails if either side moves
// somewhere white cannot follow.
//
// WHY THIS FILE EXISTS ON TOP OF THAT. A token pair proves the palette; it says
// nothing about whether the call sites use it. Every one of the fifteen could
// go back to `text-white` tomorrow and the contrast spec would still be green,
// because it never looks at a real button. This is the other half: the palette
// is measured there, and the spelling is guarded here.
//
// SCOPE:
//   Covered:     string and template literals in ui/src/**/*.jsx
//   Not covered: white on a NEUTRAL surface. `#fff` over --color-card is a
//                different question with a different answer, and banning it
//                outright would be a rule nobody could follow.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROOT = 'ui/src'
const SKIP_DIRS = new Set(['node_modules'])

// The three fills whose foreground is a measured decision rather than a taste.
const FILLS = ['accent', 'crit', 'ok']

// A literal white, however it is spelled.
const WHITE = /(?:#fff\b|#ffffff\b|\btext-white\b|\bwhite\b)/i

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

// Same collector as radiusRoles.test.js, and for the same reason: a class name
// and a style value are always inside a literal, and prose in a comment never
// is. Duplicated rather than shared because one 40-line helper in two guards is
// cheaper to read than a lib/ module that exists only for tests.
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
      const line = src.slice(0, i).split('\n').length
      let j = i + 1
      let buf = ''
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue }
        if (src[j] === quote) break
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

test('no literal white sits on an accent, crit or ok fill', () => {
  const files = walk(ROOT, [])
  assert.ok(files.length > 20, `expected to scan >20 .jsx files, scanned ${files.length} — ROOT may be wrong`)

  const bad = []
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')

    // The utility form: a literal carrying both `bg-<fill>` and `text-white`.
    for (const { line, text } of stringLiterals(src)) {
      const fill = FILLS.find((f) => new RegExp(`\\bbg-${f}\\b`).test(text))
      if (fill && /\btext-white\b/.test(text)) {
        bad.push(`${rel}:${line}: text-white on bg-${fill} — use text-on-${fill} — ${text.trim().slice(0, 80)}`)
      }
    }

    // The style-object form: `background: COLORS.<fill>` and a white `color:`
    // in the same object. Matched over the raw source because a style object
    // spans several literals and the pairing is what matters.
    const objects = src.match(/\{[^{}]*background:[^{}]*COLORS\.(?:accent|crit|ok)[^{}]*\}/g) || []
    for (const obj of objects) {
      const m = obj.match(/color:\s*('[^']*'|"[^"]*")/)
      if (m && WHITE.test(m[1])) {
        const line = src.slice(0, src.indexOf(obj)).split('\n').length
        bad.push(`${rel}:${line}: white color on a COLORS fill — use COLORS.onAccent/onCrit/onOk — ${obj.slice(0, 80)}`)
      }
    }
  }

  assert.deepEqual(
    bad,
    [],
    `hard-coded white on a semantic fill. White measures 3.79:1 on dark crit,\n` +
      `1.74:1 on dark ok and 3.30:1 on light ok — all below WCAG AA's 4.5:1.\n` +
      `Use text-on-accent / text-on-crit / text-on-ok, or COLORS.onAccent /\n` +
      `onCrit / onOk in a style object. index.css carries the measurements.\n\n` +
      bad.join('\n') +
      `\n\n(scanned ${files.length} .jsx files under ${ROOT})`
  )
})

test('the on-fill tokens are actually used, so this cannot pass by emptiness', () => {
  const files = walk(ROOT, [])
  const src = files.map((r) => fs.readFileSync(path.join(REPO, r), 'utf8')).join('\n')

  for (const spelling of ['text-on-accent', 'COLORS.onAccent', 'COLORS.onCrit', 'COLORS.onOk']) {
    assert.ok(
      src.includes(spelling),
      `${spelling} is declared but used nowhere in ${ROOT} — either the fills lost their labels, or someone spelled the foreground by hand again`
    )
  }
})
