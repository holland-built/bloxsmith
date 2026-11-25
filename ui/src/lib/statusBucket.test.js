// Run with: npm test  (node --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { statusBucket } from './statusBucket.js'

test('each host status lands in its bucket', () => {
  const cases = {
    online: 'active', UP: 'active', Active: 'active', ok: 'active', OK: 'active',
    degraded: 'degraded', warning: 'degraded',
    offline: 'offline', down: 'offline', error: 'offline', failed: 'offline',
    unknown: 'unknown', UNKNOWN: 'unknown',
    pending: 'other', '': 'other',
  }
  for (const [s, want] of Object.entries(cases)) assert.equal(statusBucket(s), want, s)
  assert.equal(statusBucket(undefined), 'other')
  assert.equal(statusBucket(null), 'other')
})

test('"ok" only as the whole word', () => {
  assert.equal(statusBucket('ok'), 'active')
  assert.equal(statusBucket('broken'), 'other')
})

// A word that only CONTAINS a healthy word is not health: "Setup failed"
// holds "up" and "Inactive" holds "active", and both were counted Active in
// Infra's Host Status donut and headline (GUI audit follow-up, 2026-11-25).
test('a status is never Active just because a healthy word is inside it', () => {
  const cases = {
    Inactive: 'offline', inactive: 'offline',
    'Setup failed': 'offline', 'Connection down': 'offline', 'sync error': 'offline',
    startup: 'other', constructor: 'other', toString: 'other', backup: 'other', 'not active': 'other', uptime: 'other',
  }
  for (const [s, want] of Object.entries(cases)) assert.equal(statusBucket(s), want, s)
})

test('"unknown" only as the whole word; anything else with it in falls through', () => {
  assert.equal(statusBucket('unknown-ish'), 'other')
})

// Daily, Infra and Overview each used to carry their own copy, with a comment
// asking people to keep the three in step. One copy cannot drift.
test('no tab defines its own statusBucket', () => {
  for (const f of ['Daily', 'Infra', 'Overview']) {
    const src = readFileSync(new URL(`../tabs/${f}.jsx`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /function statusBucket\b/, f)
    assert.match(src, /import \{ statusBucket \} from '\.\.\/lib\/statusBucket\.js'/, f)
  }
})
