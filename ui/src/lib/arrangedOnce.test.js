// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS.
//
// arrangedOnce.js exported `resetArrangedForTests`, commented "Tests only", and
// a repo-wide grep for that name returned exactly one line: its own definition.
// No test called it, and the module had no unit test file at all. It was the
// leftover of tests that were never written.
//
// Deleting the function was the other option and was rejected, because there is
// a real gap under it. `tests/docs-and-intro.spec.ts` covers the BEHAVIOUR in a
// browser — the onboarding sentence disappears once a panel has been
// rearranged — but it cannot cheaply force the one branch that actually needs
// covering: localStorage THROWING. Private-browsing and storage-disabled builds
// throw on access rather than returning null, and the module is written to fail
// closed there. Nothing had ever run that path.
//
// WHAT IS AND IS NOT REACHABLE FROM HERE. `subscribe` is private and reachable
// only through `useHasArranged`, which is a React hook, so subscriber
// notification is not tested here — there is no renderer in this suite and
// adding one to prove a Set gets iterated would be a worse trade. What IS
// tested is every branch reachable through the module's plain exports, which is
// where the storage failures live.
//
// Each case imports the module under a DIFFERENT query string. Node caches ESM
// by specifier, and this module reads localStorage once at import time to seed
// its snapshot — so a shared instance would carry the previous case's state and
// the import-time read could only ever be exercised once.

import assert from 'node:assert/strict'
import test from 'node:test'

/** An in-memory Storage, or one that throws the way a locked-down browser does. */
function fakeStorage({ throwOn = null, seed = null } = {}) {
  const map = new Map()
  // Call counts, not just final state. The idempotence test below was written
  // asserting state alone and a mutation run proved it could not fail: deleting
  // `if (snapshot) return` from markArranged leaves the stored value and
  // hasArranged() identical, because writing '1' over '1' is invisible. What
  // the early return actually prevents is the SECOND write and the second
  // notification, so the second write is what has to be counted.
  const calls = { getItem: 0, setItem: 0, removeItem: 0 }
  if (seed !== null) map.set('bx:arranged-once', seed)
  const guard = (op) => {
    if (throwOn === op || throwOn === 'all') throw new DOMExceptionLike(`${op} refused`)
  }
  return {
    getItem(k) {
      calls.getItem++
      guard('getItem')
      return map.has(k) ? map.get(k) : null
    },
    setItem(k, v) {
      calls.setItem++
      guard('setItem')
      map.set(k, String(v))
    },
    removeItem(k) {
      calls.removeItem++
      guard('removeItem')
      map.delete(k)
    },
    _dump: () => Object.fromEntries(map),
    _calls: () => ({ ...calls }),
  }
}

class DOMExceptionLike extends Error {}

async function load(tag, storage) {
  globalThis.localStorage = storage
  return import(`./arrangedOnce.js?case=${tag}`)
}

test('a reader who has never rearranged anything starts at false', async () => {
  const store = fakeStorage()
  const m = await load('fresh', store)
  assert.equal(m.hasArranged(), false)
  assert.deepEqual(store._dump(), {}, 'merely asking must not write anything')
})

test('a reader who already rearranged is remembered across a reload', async () => {
  // The import-time read is the whole mechanism for "across a reload", and it
  // only runs once per module instance, which is why every case here gets its
  // own.
  const m = await load('seeded', fakeStorage({ seed: '1' }))
  assert.equal(m.hasArranged(), true)
})

test('any value other than the exact flag is not a yes', async () => {
  const m = await load('junk', fakeStorage({ seed: 'true' }))
  assert.equal(m.hasArranged(), false, "the stored value is compared to '1', not coerced")
})

test('marking it is remembered, and marking it again changes nothing', async () => {
  const store = fakeStorage()
  const m = await load('mark', store)

  m.markArranged()
  assert.equal(m.hasArranged(), true)
  assert.deepEqual(store._dump(), { 'bx:arranged-once': '1' })

  // Idempotent by an early return, and it matters: this is called from the
  // resolved arm of every successful layout save, so it runs on every drag for
  // the rest of that reader's life.
  assert.equal(store._calls().setItem, 1)
  m.markArranged()
  assert.equal(m.hasArranged(), true)
  assert.deepEqual(store._dump(), { 'bx:arranged-once': '1' })
  assert.equal(store._calls().setItem, 1, 'the second call must return before touching storage')
})

test('storage that refuses to be READ fails closed — the tip keeps showing', async () => {
  // The branch nothing had ever run. Failing closed is the safe direction: a
  // reader sees a sentence they have already read, rather than losing the only
  // place the app explains its own arranging. Failing OPEN would hide the
  // onboarding from every private-browsing visitor permanently.
  const m = await load('read-throws', fakeStorage({ throwOn: 'getItem' }))
  assert.equal(m.hasArranged(), false)
})

test('storage that refuses to be WRITTEN still stops the tip repeating this session', async () => {
  const m = await load('write-throws', fakeStorage({ throwOn: 'setItem' }))
  assert.equal(m.hasArranged(), false)

  // The write throws and is swallowed; the in-memory flag flips anyway. So the
  // tip stops repeating while the reader is here and returns on their next
  // visit, which is the documented behaviour and the best available one when
  // the browser will not remember anything.
  assert.doesNotThrow(() => m.markArranged())
  assert.equal(m.hasArranged(), true)
})

test('resetArrangedForTests clears both the store and the cached snapshot', async () => {
  // The function this file was written for. It exists because the snapshot is
  // module state that outlives a single test, so clearing storage alone would
  // leave hasArranged() still answering true.
  const store = fakeStorage({ seed: '1' })
  const m = await load('reset', store)
  assert.equal(m.hasArranged(), true)

  m.resetArrangedForTests()
  assert.equal(m.hasArranged(), false, 'the cached snapshot must be cleared, not just the store')
  assert.deepEqual(store._dump(), {}, 'and the stored flag must be gone')
})

test('resetArrangedForTests survives storage that refuses to be cleared', async () => {
  const m = await load('reset-throws', fakeStorage({ throwOn: 'removeItem', seed: '1' }))
  assert.equal(m.hasArranged(), true)
  assert.doesNotThrow(() => m.resetArrangedForTests())
  assert.equal(m.hasArranged(), false, 'the snapshot resets even when the store will not')
})
