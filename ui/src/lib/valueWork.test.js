// Run with: npm test  (node --test, no test framework dependency)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countWork, hoursSaved, MINUTES_PER_JOB } from './valueWork.js'

const RANGE = ['2026-10-21', '2026-11-19']
const run = (extra = {}) => ({ source: 'address', status: 'built', tenant: 't1', created: '2026-11-10T12:00:00Z', objects: [{}], ...extra })

test('counts only the whole UTC days the page names', () => {
  const w = countWork({ tenant: 't1', runs: [
    run({ created: '2026-10-20T23:59:59Z' }),
    run({ created: '2026-10-21T00:00:00Z' }),
    run({ created: '2026-11-19T23:59:59Z' }),
    run({ created: '2026-11-20T00:00:00Z' }),
  ] }, RANGE)
  assert.equal(w.jobs, 2)
})

test('leaves out recorded deletes, failed runs, runs stopped part way, and removed runs', () => {
  const w = countWork({
    tenant: 't1',
    runs: [
      run({ source: 'delete' }), run({ status: 'failed' }), run({ status: 'building' }),
      // Remove also runs on a failed run and overwrites its status, so these
      // cannot prove the job ever finished.
      run({ status: 'removed' }), run({ status: 'remove-failed' }), run({ status: 'removing' }),
      run(),
    ],
  }, RANGE)
  assert.equal(w.jobs, 1)
})

test('counts jobs and objects made, by page', () => {
  const w = countWork({
    tenant: 't1',
    runs: [run({ source: '', objects: [{}, {}, {}] }), run({ source: 'lists', objects: [{}, {}] }), run({ source: 'lists' }), run({ source: 'editor', objects: [] })],
  }, RANGE)
  assert.equal(w.jobs, 4)
  assert.equal(w.objects, 6)
  assert.deepEqual(w.bySource, [['Automate', 1, 3], ['Site lists', 2, 3], ['Editor', 1, 0]])
})

test('a runs list that failed to load is null (not checked), never 0', () => {
  assert.equal(countWork(null, RANGE), null)
  assert.equal(countWork(undefined, RANGE), null)
  assert.equal(countWork({ error: 'boom' }, RANGE), null)
  assert.equal(countWork({ runs: [] }, RANGE).jobs, 0, 'a list that loaded empty is a real 0')
})

test('no usable period is not a count', () => {
  for (const range of [undefined, null, ['2026-10-21'], ['nope', 'nope'], ['2026-11-19', '2026-10-21']]) {
    assert.deepEqual(countWork({ tenant: 't1', runs: [run()] }, range), { noPeriod: true })
  }
})

test('runs with no tenant or another tenant earn no credit, and are counted apart', () => {
  const w = countWork({ tenant: 't1', runs: [run({ tenant: '', objects: [{}, {}] }), run({ tenant: undefined }), run({ tenant: 't2' }), run()] }, RANGE)
  assert.equal(w.jobs, 1)
  assert.equal(w.objects, 1)
  assert.deepEqual(w.bySource, [['Get an address: addresses', 1, 1]])
  assert.equal(w.hours, 0.2)
  assert.equal(w.older, 2)
  assert.equal(w.other, 1)
})

test('time saved is jobs x 10 minutes, in hours', () => {
  assert.equal(MINUTES_PER_JOB, 10)
  assert.equal(hoursSaved(0), 0)
  assert.equal(hoursSaved(6), 1)
  assert.equal(hoursSaved(4), 0.7)
  assert.equal(countWork({ tenant: 't1', runs: [run(), run(), run()] }, RANGE).hours, 0.5)
})
