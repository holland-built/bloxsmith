// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTROL_HELP } from './controlHelp.js'

// ---------------------------------------------------------------------------
// CONTROL_HELP is the header's half of the help layer, and it gets a SHAPE test
// only — deliberately, and the limit is worth writing down rather than leaving
// somebody to discover it.
//
// PANEL_HELP can be checked for completeness because every panel goes through
// one shell (`Card`), so a scanner can enumerate them. The header controls have
// no shell: they are six unrelated components sitting in one flex row. Nothing
// static can prove this dictionary still covers them after a seventh is added.
// That gap is closed by review, not by a test, and pretending otherwise with a
// scanner that greps App.jsx for component names would be a check that passes
// for the wrong reason.
//
// What IS checkable: the shape the dialog renders, and that the entry the user
// actually asked about ("I didn't know what the compact was at the top") says
// what Compact and Comfortable each do rather than merely naming them.
// ---------------------------------------------------------------------------

const LABEL_MAX = 40
const WHAT_MAX = 200
const ALLOWED_KEYS = new Set(['label', 'what'])

// The controls in the header cluster today (ui/src/App.jsx). Listed here rather
// than derived, so removing a control from the header without removing it from
// this dictionary is a red test and a decision, not a silent orphan.
const EXPECTED = [
  'connection-status',
  'updates',
  'theme',
  'density',
  'settings',
  'provision',
]

test('CONTROL_HELP is a plain object', () => {
  assert.equal(typeof CONTROL_HELP, 'object')
  assert.notEqual(CONTROL_HELP, null)
  assert.equal(Array.isArray(CONTROL_HELP), false)
})

test('it covers exactly the header controls that exist, and no others', () => {
  assert.deepEqual(Object.keys(CONTROL_HELP).sort(), [...EXPECTED].sort())
})

test('key order is the left-to-right order of the header itself', () => {
  // The dialog renders Object.keys in order, so the list a reader sees has to
  // match the row they are looking at. Alphabetical would put Provision second.
  assert.deepEqual(Object.keys(CONTROL_HELP), EXPECTED)
})

test('every key is kebab-case', () => {
  for (const id of Object.keys(CONTROL_HELP)) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `control id "${id}" is not kebab-case`)
  }
})

test('every entry is { label, what } and nothing else', () => {
  for (const [id, entry] of Object.entries(CONTROL_HELP)) {
    assert.equal(typeof entry, 'object', `${id}: entry is not an object`)
    assert.notEqual(entry, null, `${id}: entry is null`)
    assert.equal(Array.isArray(entry), false, `${id}: entry is an array`)
    for (const key of Object.keys(entry)) {
      assert.ok(ALLOWED_KEYS.has(key), `${id}: unknown key "${key}" — only label/what are rendered`)
    }
  }
})

test('label is a short non-empty string', () => {
  for (const [id, entry] of Object.entries(CONTROL_HELP)) {
    assert.equal(typeof entry.label, 'string', `${id}: label is required and must be a string`)
    assert.ok(entry.label.trim().length > 0, `${id}: label is empty`)
    assert.ok(
      entry.label.length <= LABEL_MAX,
      `${id}: label is ${entry.label.length} chars, over the ${LABEL_MAX}-char budget`,
    )
  }
})

test('what is a non-empty string within the dialog budget', () => {
  for (const [id, entry] of Object.entries(CONTROL_HELP)) {
    assert.equal(typeof entry.what, 'string', `${id}: what is required and must be a string`)
    assert.ok(entry.what.trim().length > 0, `${id}: what is empty`)
    assert.ok(
      entry.what.length <= WHAT_MAX,
      `${id}: what is ${entry.what.length} chars, over the ${WHAT_MAX}-char budget`,
    )
  }
})

test('the density entry says what each setting DOES, not just its name', () => {
  // This is the one entry with a named complaint behind it: "I didn't know what
  // the compact was at the top". The switch already labels itself Compact and
  // Comfortable — repeating the two words is what it already does and what did
  // not work. Both have to be described.
  const { what } = CONTROL_HELP.density
  assert.match(what, /Compact/, 'the density entry must name Compact')
  assert.match(what, /Comfortable/, 'the density entry must name Comfortable')
  assert.ok(
    /rows|screen|space|room/i.test(what),
    'the density entry names the two settings but never says what changes on screen',
  )
})
