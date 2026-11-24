import assert from 'node:assert/strict'
import test from 'node:test'
import { categoryWord, countOf, issueWord, noun, plainMessage, subjectName } from './plainWords.js'

test('known categories read as words, unknown ones are de-dashed', () => {
  assert.equal(categoryWord('dns-ttl-anomaly'), 'DNS zone timing')
  assert.equal(categoryWord('subnet-utilization'), 'Subnet filling up')
  assert.equal(categoryWord('some-new_thing'), 'Some new thing')
  assert.equal(categoryWord(''), '')
  assert.equal(categoryWord('dns'), 'DNS')
  assert.equal(categoryWord('ipam-thing'), 'IPAM thing')
})

test('zone issues read as words', () => {
  assert.equal(issueWord('High Neg-TTL'), 'remembers "not found" too long')
  assert.equal(issueWord('Something else'), 'Something else')
})

test('server sentences lose their engineering words', () => {
  assert.equal(plainMessage('aws.private.: High Neg-TTL'), 'aws.private.: remembers "not found" too long')
  assert.equal(plainMessage('a.: TTL Too Low, High Neg-TTL'), 'a.: cache time too short, remembers "not found" too long')
  assert.equal(plainMessage('11 dns ttl anomaly'), '11 zones have DNS timing problems')
  assert.equal(plainMessage('1 dns ttl anomaly'), '1 zone has a DNS timing problem')
  assert.equal(plainMessage('Windows Wireless at 80% utilization'), 'Windows Wireless is 80% full')
  assert.equal(plainMessage('602 of 602 DNS zones unsigned (DNSSEC)'), '602 of 602 DNS zones not signed (DNSSEC)')
  assert.equal(plainMessage('2 subnet utilization'), '2 subnets are 70% full or more')
  assert.equal(plainMessage(undefined), '')
})

test('audit event kinds read as words, failures say so', async () => {
  const { eventWord } = await import('./plainWords.js')
  assert.equal(eventWord('write-refused-read-only'), 'Change blocked (read-only)')
  assert.equal(eventWord('provision-subnet-error'), "Couldn't create a subnet")
  assert.equal(eventWord('selfservice-allocate-orphaned'), 'Address taken (left behind)')
  assert.equal(eventWord('dns-record-create-unreadable'), "DNS record added (couldn't read it back)")
  assert.equal(eventWord('brand-new-kind'), 'Brand new kind')
})

test('a count of 1 takes the singular, anything else the plural', () => {
  assert.equal(countOf(1, 'service'), '1 service')
  assert.equal(countOf(2, 'zone'), '2 zones')
  assert.equal(countOf(0, 'name'), '0 names')
  assert.equal(countOf(1200, 'zone'), '1,200 zones')
  assert.equal(countOf(1, 'address', 'addresses'), '1 address')
  assert.equal(countOf(3, 'address', 'addresses'), '3 addresses')
  assert.equal(noun(1, 'lease'), 'lease')
  assert.equal(noun(null, 'subnet'), 'subnets')
})

test('an incident names its subject, not its id', () => {
  assert.equal(subjectName({ entity_type: 'subnet', entity_id: 'ipam/subnet/abc', message: 'Windows Wireless at 80% utilization' }), 'Windows Wireless')
  assert.equal(subjectName({ entity_type: 'zone', entity_id: 'dns/auth_zone/abc', message: 'aws.private.: High Neg-TTL' }), 'aws.private.')
  assert.equal(subjectName({ entity_type: 'lease', entity_id: 'dhcp/lease/abc', message: 'Lease 10.0.0.5 (printer) expired' }), '10.0.0.5')
  assert.equal(subjectName({ entity_type: 'posture', entity_id: 'x', message: '2 of 3 DNS zones with public names unsigned (DNSSEC)' }), 'All DNS zones')
})
