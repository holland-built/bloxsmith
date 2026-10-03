// Run with: npm test  (node --test, no test framework dependency)

import assert from 'node:assert/strict'
import test from 'node:test'
import { statusTone } from './statusWord.js'

test('a healthy word inside another word is not a healthy status', () => {
  // Every one of these was green before 2026-10-03.
  assert.equal(statusTone('Setup failed'), 'crit')
  assert.equal(statusTone('Backup error'), 'crit')
  assert.equal(statusTone('Unsuccessful'), 'crit')
  assert.equal(statusTone('Not supported'), null)
  assert.equal(statusTone('Inactive'), null)
  assert.equal(statusTone('Incomplete'), null)
  assert.equal(statusTone('Setup'), null)
})

test('bad is tested before good, so a status that says both is not painted by its better half', () => {
  assert.equal(statusTone('online, degraded'), 'warn')
  assert.equal(statusTone('up (errors)'), 'crit')
  assert.equal(statusTone('active — failing over'), 'crit')
})

test('the statuses the feeds really send keep their colour', () => {
  for (const v of ['online', 'Online', 'ONLINE', 'up', 'active', 'success', 'Successful', 'completed', 'Complete']) {
    assert.equal(statusTone(v), 'ok', v)
  }
  for (const v of ['degraded', 'Degraded', 'warning', 'pending', 'running']) {
    assert.equal(statusTone(v), 'warn', v)
  }
  for (const v of ['offline', 'off', 'down', 'error', 'errored', 'failed', 'failure', 'FAIL']) {
    assert.equal(statusTone(v), 'crit', v)
  }
})

test('a separator other than a space still splits words', () => {
  assert.equal(statusTone('ONLINE_DEGRADED'), 'warn')
  assert.equal(statusTone('status:offline'), 'crit')
  assert.equal(statusTone('sync-complete'), 'ok')
})

test('a word that is negated, or counted as zero, is not that status', () => {
  assert.equal(statusTone('no errors'), null)
  assert.equal(statusTone('errors: 0'), null)
  assert.equal(statusTone('0 failed'), null)
  assert.equal(statusTone('not active'), null)
  assert.equal(statusTone('not running'), null)
  // A count that is not zero still counts.
  assert.equal(statusTone('errors: 3'), 'crit')
  assert.equal(statusTone('2 failed'), 'crit')
  // The negation covers only the word after it.
  assert.equal(statusTone('online, no errors'), 'ok')
  // A zero after a healthy word is counting something else.
  assert.equal(statusTone('up 0 days'), 'ok')
})

test('a state that was red before the rule changed is still red', () => {
  assert.equal(statusTone('shutdown'), 'crit')
  assert.equal(statusTone('Shut down'), 'crit')
})

test('nothing, or a word nobody listed, earns no colour', () => {
  assert.equal(statusTone(null), null)
  assert.equal(statusTone(undefined), null)
  assert.equal(statusTone(''), null)
  assert.equal(statusTone('—'), null)
  assert.equal(statusTone('unknown'), null)
  assert.equal(statusTone('Host'), null)
})
