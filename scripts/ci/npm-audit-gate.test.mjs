import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocking } from './npm-audit-gate.mjs'

const adv = (id, severity) => ({ url: `https://github.com/advisories/${id}`, severity, title: id })
const audit = (...vias) => ({
  vulnerabilities: {
    picomatch: { severity: 'high', via: vias },
    vite: { severity: 'high', via: ['picomatch'] },
  },
})

test('the accepted picomatch advisory passes before its date', () => {
  assert.deepEqual(blocking(audit(adv('GHSA-fc5q-39xc-vjpf', 'high')), 'moderate', '2026-11-18'), [])
})

test('the accepted advisory blocks again after its date', () => {
  const out = blocking(audit(adv('GHSA-fc5q-39xc-vjpf', 'high')), 'moderate', '2027-01-01')
  assert.equal(out.length, 1)
  assert.match(out[0], /now expired/)
})

test('any other advisory at or above the floor blocks', () => {
  const out = blocking(audit(adv('GHSA-fc5q-39xc-vjpf', 'high'), adv('GHSA-xxxx-yyyy-zzzz', 'moderate')), 'moderate', '2026-11-18')
  assert.deepEqual(out, ['GHSA-xxxx-yyyy-zzzz moderate picomatch'])
})

test('below the floor does not block', () => {
  assert.deepEqual(blocking(audit(adv('GHSA-aaaa-bbbb-cccc', 'low')), 'moderate', '2026-11-18'), [])
})

test('an empty report passes', () => {
  assert.deepEqual(blocking({ vulnerabilities: {} }), [])
})
