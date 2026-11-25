// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { actionWord, plainRequest, resourceWord } from './auditWords.js'

test('Portal actions read as past-tense words', () => {
  assert.equal(actionWord('UPDATE'), 'Changed')
  assert.equal(actionWord('DELETE'), 'Deleted')
  assert.equal(actionWord('create'), 'Created')
  // A verb this map has not met is still shown, in sentence case, not hidden.
  assert.equal(actionWord('LOGIN'), 'Login')
  assert.equal(actionWord(''), '')
})

test('Portal object names read as everyday names', () => {
  assert.equal(resourceWord('dnsrecord'), 'DNS record')
  assert.equal(resourceWord('auth_zone'), 'DNS zone')
  assert.equal(resourceWord('addressservice'), 'IP address')
  assert.equal(resourceWord('subnetservice'), 'Subnet')
  // Unknown names lose their underscores and are still shown.
  assert.equal(resourceWord('forward_zone'), 'Forward zone')
  // Anything that is not an API name is shown exactly as it came.
  assert.equal(resourceWord('zone/corp.example.com'), 'zone/corp.example.com')
  assert.equal(resourceWord(''), '')
})

test('a refused request reads as a sentence about what was tried and why it stopped', () => {
  assert.equal(
    plainRequest({ method: 'PATCH', path: '/api/edit/dnsrecord', reason: 'tenant-read-only', tenant: 'baseline/-' }),
    'Tried to change a DNS record; changes are turned off',
  )
  assert.equal(
    plainRequest({ method: 'DELETE', path: '/api/edit/subnet/abc', reason: 'tenant-unknown' }),
    "Tried to delete a subnet; couldn't tell which account it would change",
  )
})

test('an allowed request reads as what it did', () => {
  assert.equal(plainRequest({ method: 'POST', path: '/api/provision/subnet' }), 'Create a subnet')
})

// Codex review (a): the verb comes from what each server route does
// (go/internal/server/edit.go, writelock.go), not from the method alone.
test('POST to the editor creates, PATCH changes, DELETE deletes', () => {
  assert.equal(plainRequest({ method: 'POST', path: '/api/edit/subnet' }), 'Create a subnet')
  assert.equal(plainRequest({ method: 'POST', path: '/api/edit/dns_zone' }), 'Create a DNS zone')
  assert.equal(plainRequest({ method: 'PATCH', path: '/api/edit/subnet/s-1' }), 'Change a subnet')
  assert.equal(plainRequest({ method: 'DELETE', path: '/api/edit/host/h-1' }), 'Delete a host')
})

test('teardown removes', () => {
  assert.equal(plainRequest({ method: 'GET', path: '/api/teardown/site/stream' }), 'Remove a site')
  assert.equal(plainRequest({ method: 'POST', path: '/api/teardown/block' }), 'Remove an address block')
})

test('the other write routes read as what they do', () => {
  assert.equal(plainRequest({ method: 'POST', path: '/api/selfservice/allocate' }), 'Reserve an IP address')
  assert.equal(plainRequest({ method: 'DELETE', path: '/api/ipam/addresses/a-1' }), 'Give back an IP address')
  assert.equal(plainRequest({ method: 'POST', path: '/api/block-domain' }), 'Block a domain')
  assert.equal(plainRequest({ method: 'DELETE', path: '/api/dns/records/r-1' }), 'Delete a DNS record')
})

test('a route this map cannot place shows the request as it was', () => {
  assert.equal(
    plainRequest({ method: 'POST', path: '/api/desk/run', reason: 'tenant-read-only' }),
    'Tried POST /api/desk/run; changes are turned off',
  )
})

// Codex review (b): facts the sentence does not cover stay on screen.
test('an unknown object keeps its real name', () => {
  assert.equal(plainRequest({ method: 'POST', path: '/api/edit/widget_pool' }), 'Create something · Object: widget_pool')
})

test('a refusal for lack of a role says which role it needed', () => {
  assert.equal(plainRequest({ required: 'admin', path: '/api/update/apply' }), 'Update the app · Needs the Admin role')
  assert.equal(plainRequest({ required: 'operator', path: '/api/edit/subnet' }), 'Edit a subnet · Needs the Operator role')
})

test('a detail with no request is left to the caller', () => {
  assert.equal(plainRequest({ from: 'v1' }), null)
  assert.equal(plainRequest(null), null)
})

test('a refusal with no method recorded says edit, and the subnet stream names a subnet', () => {
  // A role refusal records no method, so the action is not known: "edit", not a guess.
  assert.equal(plainRequest({ path: '/api/dns/records' }).startsWith('Edit a DNS record'), true)
  // /api/provision/stream is the subnet job, not an object called "stream".
  const s = plainRequest({ method: 'GET', path: '/api/provision/stream' })
  assert.equal(s.startsWith('Create a subnet'), true, s)
  assert.equal(/stream/i.test(s), false, s)
})

// GUI audit round 2, R2-C4: results and account kinds in plain words.
test('resultWord says Worked, Refused or Failed', async () => {
  const { resultWord } = await import('./auditWords.js')
  assert.equal(resultWord('success'), 'Worked')
  assert.equal(resultWord('SUCCESS'), 'Worked')
  assert.equal(resultWord('failed: denied'), 'Refused')
  assert.equal(resultWord('failed: timeout'), 'Failed')
  assert.equal(resultWord(''), '')
  assert.equal(resultWord('pending'), 'Pending')
})

test('whoKindWord names the kind of account', async () => {
  const { whoKindWord } = await import('./auditWords.js')
  assert.equal(whoKindWord('service'), 'automated account')
  assert.equal(whoKindWord('person'), 'person')
  assert.equal(whoKindWord('device'), 'device')
  assert.equal(whoKindWord(''), '')
})
