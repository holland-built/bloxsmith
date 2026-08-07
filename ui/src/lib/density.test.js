// Run with: npm test  (node --test, no test framework dependency)
//
// The density store is deliberately a plain .js module and not part of
// theme.jsx: `npm test` is bare `node --test`, which cannot load a .jsx
// extension, and this is the piece whose failure modes are worth pinning —
// what an unrecognised stored value does, and whether the <html> attribute and
// localStorage actually agree after a change.
//
// No jsdom. The two browser globals this module touches are stubbed by hand
// below, before the module is imported, because it reads localStorage and
// writes documentElement.dataset at import time.

import assert from 'node:assert/strict'
import test from 'node:test'

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

// One fresh module instance per test: the store is module-level state, so
// re-importing the same URL would hand every test the previous test's store.
let instance = 0
async function load(seed, { breakStorage = false } = {}) {
  globalThis.document = { documentElement: { dataset: {} } }
  globalThis.localStorage = breakStorage
    ? {
        getItem() { throw new Error('localStorage disabled (private mode)') },
        setItem() { throw new Error('localStorage disabled (private mode)') },
      }
    : makeStorage(seed)
  const mod = await import(`./density.js?case=${instance++}`)
  return { mod, doc: globalThis.document, store: globalThis.localStorage }
}

test('the two densities are comfortable and compact, and comfortable is the default', async () => {
  const { mod } = await load()
  assert.deepEqual(mod.DENSITIES, ['comfortable', 'compact'])
  assert.equal(mod.DEFAULT_DENSITY, 'comfortable')
})

test('normalizeDensity keeps the two real values and falls back to comfortable', async () => {
  const { mod } = await load()
  assert.equal(mod.normalizeDensity('comfortable'), 'comfortable')
  assert.equal(mod.normalizeDensity('compact'), 'compact')
})

test('an unrecognised stored value falls back to comfortable, never to compact', async () => {
  // The fallback direction is the whole point. Comfortable is today's spacing,
  // so a garbage value costs nothing; falling back to compact would silently
  // re-space the entire app off a typo in localStorage.
  const { mod } = await load()
  for (const bad of ['cozy', 'COMPACT', 'Compact', '', ' compact', null, undefined, 0, 1, {}, []]) {
    assert.equal(mod.normalizeDensity(bad), 'comfortable', `normalizeDensity(${JSON.stringify(bad)})`)
  }
})

test('with nothing stored, the density is comfortable and <html> says so', async () => {
  const { mod, doc } = await load({})
  assert.equal(mod.getDensity(), 'comfortable')
  assert.equal(doc.documentElement.dataset.density, 'comfortable')
})

test('a stored compact is read back and applied to <html> at import, before any click', async () => {
  const { mod, doc } = await load({ density: 'compact' })
  assert.equal(mod.getDensity(), 'compact')
  assert.equal(doc.documentElement.dataset.density, 'compact')
})

test('a stored junk value applies comfortable to <html>', async () => {
  const { mod, doc } = await load({ density: 'ultra-compact' })
  assert.equal(mod.getDensity(), 'comfortable')
  assert.equal(doc.documentElement.dataset.density, 'comfortable')
})

test('setDensity writes the attribute AND persists, so a reload keeps the choice', async () => {
  const { mod, doc, store } = await load({})
  mod.setDensity('compact')
  assert.equal(mod.getDensity(), 'compact')
  assert.equal(doc.documentElement.dataset.density, 'compact')
  assert.equal(store.getItem('density'), 'compact')
})

test('setting comfortable back restores the attribute and the stored value', async () => {
  const { mod, doc, store } = await load({ density: 'compact' })
  mod.setDensity('comfortable')
  assert.equal(mod.getDensity(), 'comfortable')
  assert.equal(doc.documentElement.dataset.density, 'comfortable')
  assert.equal(store.getItem('density'), 'comfortable')
})

test('setDensity normalizes its argument rather than writing junk to <html>', async () => {
  const { mod, doc, store } = await load({ density: 'compact' })
  mod.setDensity('cozy')
  assert.equal(mod.getDensity(), 'comfortable')
  assert.equal(doc.documentElement.dataset.density, 'comfortable')
  assert.equal(store.getItem('density'), 'comfortable')
})

test('subscribers are notified on a real change and not on a no-op', async () => {
  const { mod } = await load({})
  let calls = 0
  const unsubscribe = mod.subscribeDensity(() => { calls++ })
  mod.setDensity('compact')
  assert.equal(calls, 1)
  mod.setDensity('compact')
  assert.equal(calls, 1, 'setting the density it already has must not re-render the app')
  mod.setDensity('comfortable')
  assert.equal(calls, 2)
  unsubscribe()
  mod.setDensity('compact')
  assert.equal(calls, 2, 'an unsubscribed listener must stop being called')
})

test('an unusable localStorage costs persistence, not the switch', async () => {
  // Private mode / a sandboxed iframe throws on both getItem and setItem. The
  // density must still change on screen — it just stops surviving a reload.
  const { mod, doc } = await load({}, { breakStorage: true })
  assert.equal(mod.getDensity(), 'comfortable')
  mod.setDensity('compact')
  assert.equal(mod.getDensity(), 'compact')
  assert.equal(doc.documentElement.dataset.density, 'compact')
})
