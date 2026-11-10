import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { anyUrl, findSets, firstSentence, settleAny } from './chartAnyData.js'

const SET = {
  name: 'C',
  measures: [{ name: 'C.count', type: 'number' }],
  dimensions: [
    { name: 'C.created', type: 'time' },
    { name: 'C.timestamp', type: 'time' },
    { name: 'C.host', type: 'string' },
  ],
}

describe('settleAny', () => {
  it('fills the first count, the timestamp field and the last 7 days', () => {
    assert.deepEqual(settleAny(SET, { cube: 'C' }, [5, 10, 25]), {
      cube: 'C', measure: 'C.count', split: '', time: 'C.timestamp', window: '7d', top: 0,
    })
  })
  it('drops picks the data set does not have, and a date as a split', () => {
    const p = settleAny(SET, { cube: 'C', measure: 'X.y', split: 'C.created', time: 'C.host', top: 7 }, [5, 10, 25])
    assert.deepEqual([p.measure, p.split, p.time, p.top], ['C.count', '', 'C.timestamp', 0])
  })
  it('a data set with no dates has no window', () => {
    const p = settleAny({ ...SET, dimensions: [{ name: 'C.host', type: 'string' }] }, { cube: 'C', split: 'C.host' }, [5, 10, 25])
    assert.deepEqual([p.time, p.window, p.top], ['', 'all', 10])
    assert.equal(anyUrl(p), '/api/chart/any?cube=C&measure=C.count&split=C.host&top=10')
  })
})

describe('findSets', () => {
  const cubes = [
    { name: 'DnsActivityV1', title: 'DNS Activity', description: 'queries' },
    { name: 'Threats', title: 'Threats', description: 'security hits on DNS' },
  ]
  it('matches every word in name, title or description', () => {
    assert.deepEqual(findSets(cubes, 'dns').map((c) => c.name), ['DnsActivityV1', 'Threats'])
    assert.deepEqual(findSets(cubes, 'dns hits').map((c) => c.name), ['Threats'])
    assert.equal(findSets(cubes, '  '), cubes)
  })
})

it('a description is cut to its first sentence', () => {
  assert.equal(firstSentence('DNS logs, one row per query. Use rcode equals 0 for successes.'), 'DNS logs, one row per query.')
  assert.equal(firstSentence(undefined), '')
})
