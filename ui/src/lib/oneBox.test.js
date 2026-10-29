// Run with: npm test  (node --test)
import assert from 'node:assert/strict'
import test from 'node:test'
import { oneBoxTarget, questionFromHash } from './oneBox.js'

test('an IP, a CIDR and a host name are looked up', () => {
  assert.equal(oneBoxTarget('10.103.145.88').hash, 'dossier?q=10.103.145.88')
  assert.equal(oneBoxTarget(' 10.103.145.0/24 ').hash, 'dossier?q=10.103.145.0%2F24')
  assert.equal(oneBoxTarget('mail.example.com').hash, 'dossier?q=mail.example.com')
  assert.equal(oneBoxTarget('2001:db8::1').hash, 'dossier?q=2001%3Adb8%3A%3A1')
})

test('asking for an address opens the address form', () => {
  assert.equal(oneBoxTarget('Give me an address in default-Cummings').hash, 'selfservice')
  assert.equal(oneBoxTarget('I need 2 addresses').hash, 'selfservice')
})

test('asking for a chart opens the chart builder', () => {
  assert.equal(oneBoxTarget('chart of DNS queries').hash, 'chart')
})

test('anything else is a question for the AI, carried in the link', () => {
  const t = oneBoxTarget('Which hosts are offline?')
  assert.equal(t.hash, 'ai?q=Which%20hosts%20are%20offline%3F')
  assert.equal(t.says, 'Ask the AI')
  assert.equal(questionFromHash('#' + t.hash), 'Which hosts are offline?')
})

test('a question that mentions an address but asks nothing of it goes to the AI', () => {
  assert.equal(oneBoxTarget('which address is 10.0.0.1 in').hash.startsWith('ai?'), true)
})

test('nothing typed goes nowhere', () => {
  assert.equal(oneBoxTarget('   '), null)
  assert.equal(questionFromHash('#ai'), '')
})
