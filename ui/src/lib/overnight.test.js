import test from 'node:test'
import assert from 'node:assert/strict'
import { overnightResult, overnightSaveBody } from './overnight.js'

test('no result yet says nothing', () => {
  assert.equal(overnightResult(null), null)
})

test('an unfinished update is never shown as a success', () => {
  const r = overnightResult({ outcome: 'incomplete', message: 'The update to v9 started.' })
  assert.equal(r.tone, 'text-crit')
  assert.match(r.text, /v9/)
})

test('a failed update reads as a failure', () => {
  assert.equal(overnightResult({ outcome: 'failed', message: 'x' }).tone, 'text-crit')
})

test('an update that needs the passphrase is a warning', () => {
  assert.equal(overnightResult({ outcome: 'updated-locked', message: 'x' }).tone, 'text-warn')
})

test('a skipped night is a warning and a clean update is plain', () => {
  assert.equal(overnightResult({ outcome: 'skipped-busy', message: 'x' }).tone, 'text-warn')
  assert.equal(overnightResult({ outcome: 'blocked', message: 'x' }).tone, 'text-warn')
  assert.equal(overnightResult({ outcome: 'updated', message: 'x' }).tone, 'text-txt')
})

test('turning on confirms the passphrase notice only when it was on screen', () => {
  assert.deepEqual(overnightSaveBody(true, '03:00', 'UTC', true), {
    enabled: true, time: '03:00', zone: 'UTC', ackPassphrase: true,
  })
  assert.equal(overnightSaveBody(true, '03:00', 'UTC', false).ackPassphrase, false)
})

test('turning off sends only that', () => {
  assert.deepEqual(overnightSaveBody(false, '03:00', 'UTC', true), { enabled: false })
})

test('turned off mid-download is plain, and a refused release reads as a problem', () => {
  assert.equal(overnightResult({ outcome: 'turned-off', message: 'x' }).tone, 'text-dim')
  assert.equal(overnightResult({ outcome: 'rejected', message: 'x' }).tone, 'text-crit')
})
