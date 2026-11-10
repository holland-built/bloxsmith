// Run with: npm test  (node --test, no test framework dependency)
//
// ONE TIP COMPONENT.
//
// Seven pages used to carry their own copy of the hover/tap/Escape tip. A fix
// made in one copy (Escape closing a keyboard-reached tip, v3.146.0) then had
// to be copied by hand into the other six. The shared component lives in
// ui/src/components/Tip.jsx; this guard fails if a page grows its own again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// this file lives at <repo>/ui/src/lib/
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TABS = path.join(SRC, 'tabs')

test('no page under ui/src/tabs defines its own Tip', () => {
  const copies = fs.readdirSync(TABS)
    .filter((f) => f.endsWith('.jsx'))
    .filter((f) => /\bfunction Tip\s*\(|\bconst Tip\s*=/.test(fs.readFileSync(path.join(TABS, f), 'utf8')))
  assert.deepEqual(copies, [], `own Tip copy in: ${copies.join(', ')}`)
})

test('the shared Tip lives in components/Tip.jsx', () => {
  const file = path.join(SRC, 'components', 'Tip.jsx')
  assert.ok(fs.existsSync(file), 'ui/src/components/Tip.jsx is missing')
  assert.match(fs.readFileSync(file, 'utf8'), /export default function Tip\(/)
})
