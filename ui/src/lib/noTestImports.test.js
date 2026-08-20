// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// NOTHING THAT SHIPS MAY IMPORT A TEST FILE.
//
// This test is the thing scripts/needs-tag.sh leans on, and it should be read
// together with the `ui/src/*.test.js` arm of that script's exempt() list.
//
// needs-tag.sh decides whether a push gets released. It exempts *_test.go
// because `go build` cannot compile one at all — that exemption rests on the Go
// toolchain and is true regardless of how this repo is wired. The UI arm added
// beside it in #154 has no such backing. A .test.js is left out of the bundle
// because vite builds from ui/index.html and tree-shakes whatever the entry
// graph does not reach, so these files are dropped for being UNREACHABLE, not
// for being named test. Import one from app code and it ships: into
// ui/dist, from there into go/web, and go/web is //go:embed'd into the binary
// every customer runs.
//
// So the claim "a UI test file cannot reach a customer" is enforced here rather
// than assumed there. Without this test, that exemption would be exactly the
// "when unsure, leave it off" case needs-tag.sh's own header warns about, and
// it would not belong on the list.
//
// WHAT THIS CANNOT CATCH. A dynamic `import(someVariable)` resolving to a test
// file at runtime, and anything reached through a vite alias or plugin rather
// than a literal specifier. Both would be strange things to write; neither is
// visible to a text scan.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Every .js/.jsx under ui/src, recursively. */
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.jsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const IS_TEST = /\.test\.jsx?$/

// Static `import … from '…'`, bare `import '…'`, and `import('…')` with a
// literal specifier. A variable specifier is not matched and is named in the
// header as a known blind spot rather than passed over in silence.
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g

test('no shipped module imports a .test.js — the needs-tag.sh UI exemption depends on this', () => {
  const offenders = []
  const shipped = walk(SRC).filter((f) => !IS_TEST.test(path.basename(f)))
  assert.ok(shipped.length > 20, `expected to scan the UI source tree, found ${shipped.length} files — this scan is not looking where it thinks it is`)

  for (const file of shipped) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(SPECIFIERS)) {
      if (IS_TEST.test(m[1])) {
        offenders.push(`${path.relative(SRC, file)} imports ${m[1]}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a test file is reachable from the app entry graph, so it would be bundled into go/web and shipped ' +
      'inside the binary. Either move the shared code into a normal module, or remove the ' +
      'ui/src/*.test.js arm from scripts/needs-tag.sh, because its premise no longer holds.\n' +
      offenders.join('\n'),
  )
})

// The scanner is the part most likely to rot into a no-op: it reports nothing
// today, and a clean tree and a broken scan look identical from the outside.
test('the scanner recognises the import forms it claims to', () => {
  const found = (src) => [...src.matchAll(SPECIFIERS)].map((m) => m[1]).filter((s) => IS_TEST.test(s))

  assert.deepEqual(found(`import { helper } from './thing.test.js'`), ['./thing.test.js'], 'named import')
  assert.deepEqual(found(`import './setup.test.jsx'`), ['./setup.test.jsx'], 'bare side-effect import')
  assert.deepEqual(found(`const m = await import('./lazy.test.js')`), ['./lazy.test.js'], 'dynamic import with a literal')
  assert.deepEqual(found(`import { api } from './api.js'`), [], 'an ordinary module is not flagged')
  // "test" appearing in a name is not the rule; the .test.js suffix is.
  assert.deepEqual(found(`import { t } from './testing.js'`), [], 'a shipped module with test in its name is fine')
  assert.deepEqual(found(`import x from './latest.js'`), [], 'nor a name that merely ends in test')
})
