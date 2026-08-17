// Run with: npm test  (node --test, no test framework dependency)
//
// THE GUARANTEE: the drift pill says what the Go side meant.
//
// driftItemKind classifies by REGEX over a sentence built in
// go/internal/provision/drift.go. Nothing else in this repo crosses a language
// boundary on prose, and until this file existed nothing checked it: the
// classifier lived inside Drift.jsx, out of node --test's reach, so rewording a
// Go message relabelled every row in the UI with no test anywhere going red.
//
// The strings below are COPIED FROM DetectDrift's fmt.Sprintf calls, not
// invented. If one stops matching, the two sides have drifted and the pill is
// lying about the finding next to it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { driftItemKind } from './driftStatus.js'

// drift.go: "Subnet '%s' exists in API but is not in the template"
test('a subnet the template does not declare reads as extra', () => {
  assert.equal(
    driftItemKind({ message: "Subnet 'voice' exists in API but is not in the template" }),
    'extra',
  )
})

// drift.go: "DNS zone '%s' exists in API but template does not specify create_zone: true"
//
// PINS A KNOWN WRONG ANSWER, deliberately, so it is written down rather than
// discovered again. This zone EXISTS and is unaccounted for — the same finding
// as the subnet above — but it words that as "template does not specify
// create_zone" instead of "is not in the template", so it misses the first
// regex and falls through to "missing". The pill therefore reads "missing"
// beside a sentence saying the zone exists.
//
// Not fixed here: this is behaviour that predates the change this file arrived
// with, and correcting it means either widening the pattern or changing the Go
// sentence, each of which is its own decision. Filed separately. If that fix
// lands, this expectation flips to 'extra' and the comment goes.
test('an undeclared DNS zone reads as missing today, which is wrong', () => {
  assert.equal(
    driftItemKind({
      message: "DNS zone 'site-a.example.com.' exists in API but template does not specify create_zone: true",
    }),
    'missing',
  )
})

// drift.go: "Tag '%s' on subnet '%s': expected '%s', live value is '%s'"
test('a tag holding the wrong value reads as changed', () => {
  assert.equal(
    driftItemKind({ message: "Tag 'Env' on subnet 'voice': expected 'prod', live value is 'dev'" }),
    'changed',
  )
})

// drift.go: "Tag '%s' missing from subnet '%s' tags (expected '%s')"
test('a tag that is absent reads as missing, not changed', () => {
  assert.equal(
    driftItemKind({ message: "Tag 'Owner' missing from subnet 'voice' tags (expected 'net-team')" }),
    'missing',
  )
})

// drift.go: "Expected subnet '%s' not found in API" / "Expected host '%s' not found in any subnet"
test('an expected object that is not there reads as missing', () => {
  assert.equal(driftItemKind({ message: "Expected subnet 'voice' not found in API" }), 'missing')
  assert.equal(
    driftItemKind({ message: "Expected host 'gw01' not found in any subnet" }),
    'missing',
  )
})

// The fallthrough has to be safe for input this function never designed for.
// An item with no message is not evidence that something merely differs.
test('an absent or unreadable message falls through to missing', () => {
  assert.equal(driftItemKind({}), 'missing')
  assert.equal(driftItemKind(null), 'missing')
  assert.equal(driftItemKind(undefined), 'missing')
  assert.equal(driftItemKind({ message: null }), 'missing')
  assert.equal(driftItemKind({ message: 42 }), 'missing')
})

// The negative half. "extra" is checked FIRST in the function, and a real
// message could hold both phrases; this pins which one wins so the order is a
// decision rather than an accident.
test('extra beats changed when a message somehow carries both phrases', () => {
  assert.equal(
    driftItemKind({ message: "Subnet 'voice' is not in the template, live value is 'x'" }),
    'extra',
  )
})
