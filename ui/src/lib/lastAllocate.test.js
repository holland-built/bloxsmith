// Run with: npm test  (node --test)
import assert from 'node:assert/strict'
import test from 'node:test'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
const { readLast, saveLast, stillThere } = await import('./lastAllocate.js')

test('a saved pick comes back for the same tenant only', () => {
  saveLast('t1', 'ipam/ip_space/a', 'ipam/subnet/x')
  assert.deepEqual(readLast('t1'), { tenant: 't1', space: 'ipam/ip_space/a', subnet: 'ipam/subnet/x' })
  assert.equal(readLast('t2'), null)
  assert.equal(readLast(''), null)
})

test('nothing half-known is saved', () => {
  store.clear()
  saveLast('t1', 'ipam/ip_space/a', '')
  assert.equal(readLast('t1'), null)
})

test('each tenant keeps its own pick', () => {
  store.clear()
  saveLast('t1', 's1', 'n1')
  saveLast('t2', 's2', 'n2')
  assert.equal(readLast('t1').subnet, 'n1')
  assert.equal(readLast('t2').subnet, 'n2')
})

test('a garbled store reads as nothing, never throws', () => {
  store.set('bloxsmith.allocate.last', '{not json')
  assert.equal(readLast('t1'), null)
})

test('an id is only used while the list still holds it', () => {
  assert.equal(stillThere('b', ['a', 'b']), 'b')
  assert.equal(stillThere('gone', ['a', 'b']), '')
  assert.equal(stillThere('', ['a']), '')
})
