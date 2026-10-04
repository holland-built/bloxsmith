// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THE SECOND MENU IS CALLED "INVENTORY", AND NOTHING ON SCREEN SAYS "ESTATE".
//
// The menu that answers "What do we have?" shipped as "Estate", a British IT
// word for everything an organisation runs. The owner's words on 2026-10-04:
// "estate make no sense please fix". Asked whether they meant the word, they
// chose "Inventory" for the menu and plain words for every sentence that used
// it ("765 in estate" became "765 in total", "Search the estate" became
// "Search everything").
//
// A word like that comes back one sentence at a time, so this reads everything
// a person can see: the strings and JSX text in ui/src, and docs/TABS.md, which
// the Docs panel shows inside the app.
//
// The group's id moved with its label ('inventory', so `data-group` still
// equals the label in lower case, which tests/nav-groups.spec.ts relies on).
// NOT renamed, on purpose: names inside the code such as estateTotal. Nobody
// reads those on screen.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.resolve(SRC, '..', '..', 'docs', 'TABS.md')

// The word itself, singular or plural, in any case: not useState, not
// estateTotal.
const WORD = /(?<![A-Za-z])estates?(?![A-Za-z])/i

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(jsx|js)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(p)
  }
  return out
}

// The lines of a file a person could end up reading, with the comments taken
// OUT of them rather than the lines that hold a comment thrown away:
// `{/* note */}Estate` is one line, and the word after the comment is on
// screen. A block comment is blanked in place, so line numbers hold; it only
// counts as one where a comment can start (the start of a line, or after a
// space or a brace), which keeps a glob such as 'src/**/*.js' from opening one.
function readableLines(src) {
  const blanked = src.replace(/(^|[\s{(,])\/\*[\s\S]*?\*\//gm, (m, lead) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '))
  return blanked.split('\n').flatMap((line, i) => {
    if (line.trim().startsWith('//')) return []
    return [{ n: i + 1, text: line.replace(/\s\/\/.*$/, '') }] // minus a trailing comment
  })
}

test('the scan reads what follows a comment on the same line, and nothing inside one', () => {
  const lines = readableLines([
    '{/* the estate, in a comment */}Estate',
    '/* opens',
    '   estate, still inside',
    '*/ const label = \'estate\'',
    '// estate, a whole-line comment',
    'const total = estateTotal // estate, trailing',
  ].join('\n'))
  const hits = lines.filter((l) => WORD.test(l.text)).map((l) => l.n)
  assert.deepEqual(hits, [1, 4], 'the word after a comment on lines 1 and 4 must be seen, and no comment text')
})

test('the menu groups are Status, Inventory, Risk, Change, Ask', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8')
  const block = /const GROUPS = \[([\s\S]*?)\n\]/.exec(app)
  assert.ok(block, 'App.jsx no longer declares the menu as `const GROUPS = [`')
  const labels = [...block[1].matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(labels, ['Status', 'Inventory', 'Risk', 'Change', 'Ask'])
})

test('no sentence, label or message in the app says "estate"', () => {
  const files = sourceFiles(SRC)
  assert.ok(files.length > 40, `expected to scan >40 source files, scanned ${files.length}`)
  const found = []
  for (const f of files) {
    for (const { n, text } of readableLines(fs.readFileSync(f, 'utf8'))) {
      if (WORD.test(text)) found.push(`${path.relative(SRC, f)}:${n}  ${text.trim().slice(0, 90)}`)
    }
  }
  assert.deepEqual(found, [], `say it in plain words ("in total", "everything", "your network"):\n  ${found.join('\n  ')}`)
})

test('the in-app help does not say "estate" either', () => {
  const doc = fs.readFileSync(DOCS, 'utf8')
  const found = doc.split('\n').flatMap((line, i) => (WORD.test(line) ? [`docs/TABS.md:${i + 1}  ${line.trim().slice(0, 90)}`] : []))
  assert.deepEqual(found, [], `docs/TABS.md is shown inside the app:\n  ${found.join('\n  ')}`)
})
