// Run with: npm test  (node --test, no test framework dependency)

import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCells, sortRows } from './sortCompare.js'

const sorted = (xs) => [...xs].sort(compareCells)

test('addresses sort by their numbers, not by their characters', () => {
  assert.deepEqual(sorted(['10.1.2.10', '10.1.2.9', '10.1.10.1', '10.1.2.100', '9.0.0.1']), ['9.0.0.1', '10.1.2.9', '10.1.2.10', '10.1.2.100', '10.1.10.1'])
})

test('numbered hosts sort in counting order', () => {
  assert.deepEqual(sorted(['host-10', 'host-2', 'host-1']), ['host-1', 'host-2', 'host-10'])
})

test('numbers compare as numbers', () => {
  assert.deepEqual(sorted([10, 9, 100, 0]), [0, 9, 10, 100])
})

test('a missing value sorts first and never throws, in either direction', () => {
  assert.deepEqual(sorted(['b', null, 'a']), [null, 'a', 'b'])
  assert.equal(compareCells(null, 'a'), -1)
  assert.equal(compareCells('a', null), 1)
  assert.equal(compareCells(null, undefined), 0)
})

test('sortRows: a row with no value does not throw in either direction, and lands at the far end', () => {
  const rows = [{ site: 'b' }, { site: null }, { site: 'a' }]
  const by = (dir) => sortRows(rows, { key: 'site', dir }, {}).map((r) => r.site)
  // Descending used to call null.localeCompare and throw.
  assert.deepEqual(by('asc'), [null, 'a', 'b'])
  assert.deepEqual(by('desc'), ['b', 'a', null])
})

test('sortRows: an accessor decides the value, and addresses come out in counting order', () => {
  const rows = [{ addr: '10.1.2.10' }, { addr: '10.1.2.9' }, { addr: '10.1.2.100' }]
  const got = sortRows(rows, { key: 'network', dir: 'asc' }, { network: (r) => r.addr }).map((r) => r.addr)
  assert.deepEqual(got, ['10.1.2.9', '10.1.2.10', '10.1.2.100'])
})

test('sortRows: no sort key hands the rows back untouched', () => {
  const rows = [{ a: 2 }, { a: 1 }]
  assert.equal(sortRows(rows, null, {}), rows)
  assert.equal(sortRows(rows, { key: '', dir: 'asc' }, {}), rows)
})

test('plain words still sort alphabetically', () => {
  assert.deepEqual(sorted(['pear', 'apple', 'fig']), ['apple', 'fig', 'pear'])
})
