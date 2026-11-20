// Run with: npm test  (node --test, no test framework dependency)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countWork, hoursSaved, MINUTES_PER_JOB } from './valueWork.js'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(NOW - days * DAY).toISOString()
const run = (extra = {}) => ({ source: 'address', status: 'built', tenant: 't1', created: ago(1), objects: [{}], ...extra })

test('counts only the last 30 days', () => {
  const w = countWork({ tenant: 't1', runs: [run({ created: ago(29.9) }), run({ created: ago(30.1) }), run({ created: ago(400) })] }, NOW)
  assert.equal(w.jobs, 1)
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
  }, NOW)
  assert.equal(w.jobs, 1)
})

test('counts jobs and objects made, by page', () => {
  const w = countWork({
    tenant: 't1',
    runs: [run({ source: '', objects: [{}, {}, {}] }), run({ source: 'lists', objects: [{}, {}] }), run({ source: 'lists' }), run({ source: 'editor', objects: [] })],
  }, NOW)
  assert.equal(w.jobs, 4)
  assert.equal(w.objects, 6)
  assert.deepEqual(w.bySource, [['Automate', 1, 3], ['Site lists', 2, 3], ['Editor', 1, 0]])
})

test('a runs list that failed to load is null (not checked), never 0', () => {
  assert.equal(countWork(null, NOW), null)
  assert.equal(countWork(undefined, NOW), null)
  assert.equal(countWork({ error: 'boom' }, NOW), null)
  assert.equal(countWork({ runs: [] }, NOW).jobs, 0, 'a list that loaded empty is a real 0')
})

test('counts older runs with no tenant, and says how many; leaves out other tenants', () => {
  const w = countWork({ tenant: 't1', runs: [run({ tenant: '' }), run({ tenant: undefined }), run({ tenant: 't2' }), run()] }, NOW)
  assert.equal(w.jobs, 3)
  assert.equal(w.older, 2)
  assert.equal(w.other, 1, 'jobs on another tenant are counted apart, so the panel can say why they are missing')
})

test('time saved is jobs x 10 minutes, in hours', () => {
  assert.equal(MINUTES_PER_JOB, 10)
  assert.equal(hoursSaved(0), 0)
  assert.equal(hoursSaved(6), 1)
  assert.equal(hoursSaved(4), 0.7)
  assert.equal(countWork({ tenant: 't1', runs: [run(), run(), run()] }, NOW).hours, 0.5)
})
