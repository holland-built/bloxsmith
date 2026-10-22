// Run with: npm test  (node --test, no test framework dependency)
//
// The "Show cube names" switch on the Build a chart tab. Same shape as
// density.test.js: the module reads localStorage at import, so the global is
// stubbed before each fresh import.

import assert from 'node:assert/strict'
import test from 'node:test'

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

let instance = 0
async function load(seed, { breakStorage = false } = {}) {
  globalThis.localStorage = breakStorage
    ? {
        getItem() { throw new Error('localStorage disabled (private mode)') },
        setItem() { throw new Error('localStorage disabled (private mode)') },
      }
    : makeStorage(seed)
  const mod = await import(`./cubeNames.js?case=${instance++}`)
  return { mod, store: globalThis.localStorage }
}

test('off by default', async () => {
  const { mod } = await load()
  assert.equal(mod.getCubeNames(), false)
})

test('a stored "on" is read back at import', async () => {
  const { mod } = await load({ cubeNames: 'on' })
  assert.equal(mod.getCubeNames(), true)
})

test('anything other than "on" is off', async () => {
  for (const bad of ['true', 'ON', '1', '', 'off']) {
    const { mod } = await load({ cubeNames: bad })
    assert.equal(mod.getCubeNames(), false, `stored ${JSON.stringify(bad)}`)
  }
})

test('setting it saves it and tells subscribers', async () => {
  const { mod, store } = await load()
  let calls = 0
  const off = mod.subscribeCubeNames(() => calls++)
  mod.setCubeNames(true)
  assert.equal(mod.getCubeNames(), true)
  assert.equal(store.map.get('cubeNames'), 'on')
  mod.setCubeNames(true)
  assert.equal(calls, 1, 'no second notice when nothing changed')
  mod.setCubeNames(false)
  assert.equal(store.map.get('cubeNames'), 'off')
  assert.equal(calls, 2)
  off()
  mod.setCubeNames(true)
  assert.equal(calls, 2, 'unsubscribed listeners hear nothing')
})

test('unusable storage still flips the switch, it just is not kept', async () => {
  const { mod } = await load(undefined, { breakStorage: true })
  assert.equal(mod.getCubeNames(), false)
  mod.setCubeNames(true)
  assert.equal(mod.getCubeNames(), true)
})
