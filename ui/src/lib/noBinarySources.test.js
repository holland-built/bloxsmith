// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// NO NUL BYTES IN SOURCE.
//
// A single 0x00 byte anywhere in a text file makes grep, ripgrep and every tool
// built on them classify the whole file as binary. They then report NO MATCHES
// rather than reporting that they skipped it, so "I did not find X in this
// file" becomes indistinguishable from "X is not in this file".
//
// That is exactly what happened to ui/src/components/ui.jsx: one literal NUL
// on line 612 (a sentinel prefix that should have been the two-character
// escape \0) hid all 1,547 lines from every search for two releases. Runtime
// was unaffected — a NUL is a legal character in a JS string — so the tests,
// the build and the app all stayed green while the file was invisible.
//
// This test is the guard. It is deliberately dumb: walk the source tree, read
// the bytes, fail on 0x00. It does not parse anything.
//
// SCOPE — what it does and does not cover:
//   Covered:     ui/src, tests/, go/  — extensions .js .jsx .ts .tsx .go .css .md .json
//   Not covered: go/web/ (generated from ui/dist — rebuild it, don't hand-edit),
//                node_modules, and any file type not in the list above.
//   NOT checked: other control bytes. Only 0x00 triggers the binary
//                classification that motivated this test.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// this file lives at <repo>/ui/src/lib/ — three levels below the repo root
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const ROOTS = ['ui/src', 'tests', 'go']
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.go', '.css', '.md', '.json'])
const SKIP_DIRS = new Set(['node_modules'])
const SKIP_PATHS = new Set(['go/web']) // generated build output, repo-root-relative

function walk(rel, out) {
  if (SKIP_PATHS.has(rel)) return out
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(rel, e.name), out)
    } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
      out.push(path.join(rel, e.name))
    }
  }
  return out
}

// Reports every NUL, not just the first: one bad edit often lands several.
function nulHits(rel) {
  const buf = fs.readFileSync(path.join(REPO, rel))
  const hits = []
  let line = 1
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) line++
    else if (buf[i] === 0x00) hits.push({ line, offset: i })
  }
  return hits
}

test('no source file contains a NUL byte', () => {
  const files = ROOTS.flatMap((r) => walk(r, []))

  // A silent zero-file scan would make this test pass forever if the layout moved.
  assert.ok(files.length > 50, `expected to scan >50 source files, scanned ${files.length} — ROOTS may be wrong`)

  const bad = []
  for (const rel of files) {
    for (const h of nulHits(rel)) {
      bad.push(`${rel}: NUL byte (0x00) at line ${h.line}, byte offset ${h.offset}`)
    }
  }

  assert.deepEqual(
    bad,
    [],
    `NUL byte in source — grep and ripgrep will silently return NO MATCHES for the whole file.\n` +
      `Almost always a literal NUL where the two-character escape \\0 was meant.\n\n` +
      bad.join('\n') +
      `\n\n(scanned ${files.length} files under ${ROOTS.join(', ')})`
  )
})
