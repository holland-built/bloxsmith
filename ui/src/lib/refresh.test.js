// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  }
}

// One fresh module per test: the choice is module-level state.
let instance = 0
async function load(seed, { breakStorage = false } = {}) {
  globalThis.localStorage = breakStorage
    ? {
        getItem() { throw new Error('storage disabled') },
        setItem() { throw new Error('storage disabled') },
      }
    : makeStorage(seed)
  const mod = await import(`./refresh.js?case=${instance++}`)
  return { mod, store: globalThis.localStorage }
}

test.afterEach(() => { delete globalThis.localStorage })

test('the choices are 30 sec, 1 min, 5 min, 15 min and Off, and 30 sec is the default', async () => {
  const { mod } = await load()
  assert.deepEqual(mod.REFRESH_CHOICES.map((c) => c.label), ['30 sec', '1 min', '5 min', '15 min', 'Off'])
  assert.equal(mod.getRefresh(), '30s')
  assert.equal(mod.getRefreshMs(), 30_000)
})

test('the choice is remembered in this browser', async () => {
  const first = await load()
  first.mod.setRefresh('5m')
  assert.equal(first.store.getItem('refreshEvery'), '5m')
  const again = await load({ refreshEvery: '5m' })
  assert.equal(again.mod.getRefresh(), '5m')
  assert.equal(again.mod.getRefreshMs(), 300_000)
})

test('an unrecognised stored value falls back to 30 sec', async () => {
  const { mod } = await load({ refreshEvery: 'soon' })
  assert.equal(mod.getRefresh(), '30s')
})

test('unusable storage still lets the choice change', async () => {
  const { mod } = await load(null, { breakStorage: true })
  mod.setRefresh('off')
  assert.equal(mod.getRefresh(), 'off')
  assert.equal(mod.getRefreshMs(), null)
})

test('a change tells subscribers, and setting the same value does not', async () => {
  const { mod } = await load()
  let told = 0
  const stop = mod.subscribeRefresh(() => { told += 1 })
  mod.setRefresh('1m')
  mod.setRefresh('1m')
  assert.equal(told, 1)
  stop()
})

test('30 sec leaves every interval in the app exactly as it was', async () => {
  const { mod } = await load()
  for (const poll of [30_000, 60_000, 300_000, 3_600_000]) {
    assert.equal(mod.feedIntervalMs(poll, false, 30_000), poll)
  }
})

test('a normal feed runs at the slower of its own interval and the choice', async () => {
  const { mod } = await load()
  assert.equal(mod.feedIntervalMs(30_000, false, 300_000), 300_000)
  assert.equal(mod.feedIntervalMs(3_600_000, false, 900_000), 3_600_000)
})

test('Off stops a normal feed', async () => {
  const { mod } = await load()
  assert.equal(mod.feedIntervalMs(60_000, false, null), null)
  assert.equal(mod.isFeedDue(1000, 60_000, false, null), false)
})

test('a feed under 30 sec and a live feed ignore the choice, including Off', async () => {
  const { mod } = await load()
  assert.equal(mod.feedIntervalMs(15_000, false, null), 15_000)
  assert.equal(mod.feedIntervalMs(20_000, false, 900_000), 20_000)
  assert.equal(mod.feedIntervalMs(60_000, true, null), 60_000)
  assert.equal(mod.feedIntervalMs(60_000, true, 900_000), 60_000)
})

test('a feed comes due on the tick that reaches its interval', async () => {
  const { mod } = await load()
  assert.equal(mod.isFeedDue(1, 30_000, false, 30_000), true)
  assert.equal(mod.isFeedDue(1, 30_000, false, 60_000), false)
  assert.equal(mod.isFeedDue(2, 30_000, false, 60_000), true)
})

test('connection and job progress feeds are marked live', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const conn = read('../components/ConnStatus.jsx')
  assert.match(conn, /useApi\('\/api\/vault\/status', \{[^}]*live: true/)
  assert.match(conn, /useApi\('\/api\/data', \{[^}]*live: true/)
  assert.match(read('../tabs/Infra.jsx'), /useApi\('\/api\/csp\/jobs', \{[^}]*live: true/)
  assert.match(read('../components/MadeList.jsx'), /useApi\('\/api\/desk\/runs', \{[^}]*live: true/)
})
