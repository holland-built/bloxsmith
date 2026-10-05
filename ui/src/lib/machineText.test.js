// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// EVERY TEXT BOX IS ONE OF THREE THINGS, AND SAYS WHICH.
//
//   machine text   an address, a host name, an object id, a filter. Carries
//                  {...MACHINE_TEXT}: no spell-check, no autofill history, no
//                  auto-capitalising.
//   prose          a comment, a question, a display name. Left alone, because
//                  spell-check is the point. Listed below, one by one.
//   a secret       a passphrase, a token, an API key (type="password"). Says
//                  which, in ui/src/lib/secretBox.js: a passphrase tells a
//                  password manager to fill it, a key tells it to stay out.
//
// Until 2026-10-04 one input in the app said anything. A new text box now has
// to be put in one of the three, here, or this fails.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACHINE_TEXT } from './machineText.js'
import { API_KEY_BOX } from './secretBox.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) jsxFiles(p, out)
    else if (e.name.endsWith('.jsx')) out.push(p)
  }
  return out
}

// The opening tag of every <input> and <textarea>. Braces are tracked so the
// `=>` of a handler does not end the tag early, and a match on a comment line
// is not a tag.
function textTags(src) {
  const out = []
  const re = /<(input|textarea)\b/g
  let m
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    if (/\/\/|\/\*|^\s*\*/.test(src.slice(lineStart, m.index))) continue
    let i = m.index + m[0].length
    let depth = 0
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    out.push({ text: src.slice(m.index, i + 1), line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

// file -> a string found in exactly one of its text-box tags. Prose, and why.
const PROSE = [
  ['tabs/Ai.jsx', 'aria-label="Ask about your network"', 'a question to the assistant, in sentences'],
  ['tabs/Provision.jsx', 'setComment(e.target.value)', 'a comment on the new subnet'],
  ['tabs/SelfService.jsx', 'setComment(e.target.value)', 'a comment on a DNS record'],
  ['components/BrandLogo.jsx', 'brand-edit-name', 'a company display name'],
  ['components/VaultGate.jsx', 'vat-name', 'a name the operator gives a tenant'],
  ['components/TenantManager.jsx', 'tm-add-label', 'a name the operator gives a tenant'],
]

const all = jsxFiles(SRC).flatMap((f) => {
  const rel = path.relative(SRC, f)
  return textTags(fs.readFileSync(f, 'utf8')).map((t) => ({ ...t, rel }))
})
const isSecret = (t) => /type="password"/.test(t.text)
const isTick = (t) => /type="(checkbox|radio|file|hidden)"/.test(t.text)
const isMachine = (t) => t.text.includes('MACHINE_TEXT')
const proseEntry = (t) => PROSE.find(([rel, mark]) => rel === t.rel && t.text.includes(mark))

test('MACHINE_TEXT turns off the three things a browser does to prose', () => {
  assert.deepEqual(MACHINE_TEXT, { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false })
})

test('the scan sees the app', () => {
  assert.ok(all.length > 35, `expected >35 text-box tags, found ${all.length}`)
  assert.ok(all.filter(isMachine).length >= 27, `expected 27 or more machine-text boxes, found ${all.filter(isMachine).length}`)
})

test('every text box is machine text, listed prose, or a secret', () => {
  const unplaced = all
    .filter((t) => !isSecret(t) && !isTick(t) && !isMachine(t) && !proseEntry(t))
    .map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(
    unplaced,
    [],
    'spread {...MACHINE_TEXT} onto it, or add it to PROSE in this file with the reason:\n  ' + unplaced.join('\n  '),
  )
})

test('every entry in the prose list still names exactly one box, and it is not also machine text', () => {
  for (const [rel, mark, why] of PROSE) {
    const hits = all.filter((t) => t.rel === rel && t.text.includes(mark))
    assert.equal(hits.length, 1, `PROSE entry ${rel} "${mark}" (${why}) matches ${hits.length} boxes`)
    assert.ok(!isMachine(hits[0]) || /\? null : MACHINE_TEXT/.test(hits[0].text), `${rel} "${mark}" is listed as prose and also spreads MACHINE_TEXT`)
  }
})

test('a box that spreads MACHINE_TEXT does not then set one of its three attributes by hand', () => {
  // A later attribute wins over the spread, so `{...MACHINE_TEXT} spellCheck`
  // would read as machine text to the test above and behave as prose.
  const bad = all
    .filter((t) => isMachine(t) && /\b(spellCheck|autoComplete|autoCapitalize)=/.test(t.text))
    .map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(bad, [], `these set spellCheck, autoComplete or autoCapitalize beside the spread:\n  ${bad.join('\n  ')}`)
})

test('a secret is never given MACHINE_TEXT', () => {
  // autoComplete="off" on a password box is a decision about password managers.
  const bad = all.filter((t) => isSecret(t) && isMachine(t)).map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(bad, [], `a type="password" box spreads MACHINE_TEXT:\n  ${bad.join('\n  ')}`)
})

const isKeyBox = (t) => t.text.includes('API_KEY_BOX')
const passphraseKind = (t) => /autoComplete="(new|current)-password"/.exec(t.text)?.[1] ?? null

test('a key box tells password managers to stay out, with all four settings', () => {
  assert.deepEqual(API_KEY_BOX, {
    autoComplete: 'off',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
  })
})

test('every secret box says which kind it is: a passphrase to fill, or a key to leave alone', () => {
  const unsaid = all
    .filter((t) => isSecret(t) && !isKeyBox(t) && !passphraseKind(t))
    .map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(
    unsaid,
    [],
    'spread {...API_KEY_BOX} onto it, or give it autoComplete="new-password" or "current-password":\n  ' + unsaid.join('\n  '),
  )
})

test('each passphrase box has the kind its screen needs: new to create and confirm, current to unlock', () => {
  const kindOf = (id) => {
    const hits = all.filter((t) => isSecret(t) && t.text.includes(`id="${id}"`))
    assert.equal(hits.length, 1, `expected one box with id ${id}, found ${hits.length}`)
    return passphraseKind(hits[0])
  }
  assert.equal(kindOf('vs-pass'), 'new')
  assert.equal(kindOf('vs-confirm'), 'new')
  assert.equal(kindOf('vu-pass'), 'current')
})

test('the app has three passphrase boxes and seven key boxes', () => {
  const secrets = all.filter(isSecret)
  assert.equal(secrets.filter(passphraseKind).length, 3)
  assert.equal(secrets.filter(isKeyBox).length, 7)
  assert.equal(secrets.length, 10, 'a new secret box was added: say which kind it is, then update these counts')
})

test('a key box does not also set autoComplete by hand, because the later one wins', () => {
  const bad = all
    .filter((t) => isKeyBox(t) && /\bautoComplete=/.test(t.text))
    .map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(bad, [], `these spread API_KEY_BOX and set autoComplete beside it:\n  ${bad.join('\n  ')}`)
})

test('a box is not both a passphrase and a key', () => {
  const both = all.filter((t) => isKeyBox(t) && passphraseKind(t)).map((t) => `${t.rel}:${t.line}`)
  assert.deepEqual(both, [])
})
