import assert from 'node:assert/strict'
import { test } from 'node:test'

import { templateScanErrors } from './templateScanErrors.js'

test('a list with no scan errors renders nothing', () => {
  assert.deepEqual(templateScanErrors(undefined), [])
  assert.deepEqual(templateScanErrors([]), [])
  assert.deepEqual(templateScanErrors('nope'), [])
  assert.deepEqual(templateScanErrors([{ name: 'good.yaml', valid: true }]), [])
})

test('a template that merely failed validation is NOT a scan error', () => {
  // It parsed. It has a fixable field. It is a different problem with a
  // different fix, and lumping the two together is what this separates.
  assert.deepEqual(templateScanErrors([{ name: 'bad.yaml', valid: false }]), [])
})

test('a scan error is surfaced with its reason', () => {
  const rows = templateScanErrors([
    { name: 'good.yaml', valid: true },
    { name: 'typo.yaml', kind: 'scan-error', valid: false, error: 'is not valid YAML: line 2' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'typo.yaml')
  assert.match(rows[0].reason, /not valid YAML/)
})

test('a scan error from an older server without a reason still says so', () => {
  const [row] = templateScanErrors([{ name: 'x.yaml', kind: 'scan-error' }])
  assert.equal(row.reason, 'no reason given')
})

test('an unreadable directory is surfaced the same way as a bad file', () => {
  const [row] = templateScanErrors([
    { name: 'locked', kind: 'scan-error', valid: false, error: 'could not be searched: permission denied' },
  ])
  assert.equal(row.name, 'locked')
  assert.match(row.reason, /could not be searched/)
})

test('keys stay unique when two entries share a name', () => {
  const rows = templateScanErrors([
    { name: 'x.yaml', kind: 'scan-error' },
    { name: 'x.yaml', kind: 'scan-error' },
  ])
  assert.equal(new Set(rows.map((r) => r.key)).size, 2)
})
