// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { itemActions, MENU_KINDS } from './itemActions.js'

const labels = (a) => a.map((x) => x.label)
const hrefOf = (a, key) => a.find((x) => x.key === key)?.href

test('a network with an id is edited in the Editor as a subnet, searched by its address', () => {
  const a = itemActions({ kind: 'network', q: '10.1.0.0/24', id: 'ipam/subnet/n1' })
  assert.equal(hrefOf(a, 'edit'), '#editor?type=subnet&id=ipam%2Fsubnet%2Fn1&q=10.1.0.0')
  assert.deepEqual(a.find((x) => x.key === 'copy'), { key: 'copy', label: 'Copy', copy: '10.1.0.0/24' })
})

test('a zone is edited as a DNS zone, searched without its root dot', () => {
  assert.equal(
    hrefOf(itemActions({ kind: 'zone', q: 'acme.corp.', id: 'dns/auth_zone/z1' }), 'edit'),
    '#editor?type=dns_zone&id=dns%2Fauth_zone%2Fz1&q=acme.corp',
  )
})

test('each kind offers exactly the menu words, in order', () => {
  assert.deepEqual(labels(itemActions({ kind: 'space', q: 'Corp', id: 'ipam/ip_space/s1' })), ['Open', 'Add a network here', 'Build a site here', 'Show overlaps'])
  assert.deepEqual(labels(itemActions({ kind: 'block', q: '10.0.0.0/8', id: 'ipam/address_block/b1', space: 'ipam/ip_space/s1' })), ['Open', 'Add a network inside', 'Copy'])
  assert.deepEqual(labels(itemActions({ kind: 'network', q: '10.1.0.0/24', id: 'ipam/subnet/n1' })), ['Open', 'Get a free address', 'Reserve an address', 'Add a DHCP range', 'Edit', 'Copy'])
  assert.deepEqual(labels(itemActions({ kind: 'address', q: '10.1.0.5' })), ['Open', 'Reserve it', 'Copy'])
  assert.deepEqual(labels(itemActions({ kind: 'zone', q: 'acme.corp.' })), ['Open', 'Add a record', 'Edit', 'Copy'])
})

test('an IP space carries itself into each job, by id when it has one', () => {
  const a = itemActions({ kind: 'space', q: 'Corp', id: 'ipam/ip_space/s1' })
  assert.equal(hrefOf(a, 'open'), '#dossier?kind=space&q=Corp&id=ipam%2Fip_space%2Fs1')
  assert.equal(hrefOf(a, 'network'), '#automate?job=network&space=ipam%2Fip_space%2Fs1')
  assert.equal(hrefOf(a, 'site'), '#automate?job=branch&space=ipam%2Fip_space%2Fs1')
  assert.equal(hrefOf(a, 'overlaps'), '#network?overlaps=ipam%2Fip_space%2Fs1&focus=overlaps')
  // No id: the name goes instead; the jobs match either.
  assert.equal(hrefOf(itemActions({ kind: 'space', q: 'Corp' }), 'network'), '#automate?job=network&space=Corp')
})

test('an address block opens in the Editor and carries its space and id into Make a new network', () => {
  const a = itemActions({ kind: 'block', q: '10.0.0.0/8', id: 'ipam/address_block/b1', space: 'ipam/ip_space/s1' })
  assert.equal(hrefOf(a, 'open'), '#editor?type=address_block&id=ipam%2Faddress_block%2Fb1&q=10.0.0.0')
  assert.equal(hrefOf(a, 'network'), '#automate?job=network&space=ipam%2Fip_space%2Fs1&block=ipam%2Faddress_block%2Fb1')
})

test('a network carries its id, address and space into each job', () => {
  const a = itemActions({ kind: 'network', q: '10.1.0.0/24', id: 'ipam/subnet/n1', space: 'ipam/ip_space/s1' })
  assert.equal(hrefOf(a, 'ip'), '#automate?job=ip&space=ipam%2Fip_space%2Fs1&subnet=ipam%2Fsubnet%2Fn1&network=10.1.0.0%2F24')
  assert.equal(hrefOf(a, 'reserve'), '#selfservice?space=ipam%2Fip_space%2Fs1&subnet=ipam%2Fsubnet%2Fn1&network=10.1.0.0%2F24&reserve=1')
  assert.equal(hrefOf(a, 'range'), '#editor?type=dhcp_range&space=ipam%2Fip_space%2Fs1&subnet=ipam%2Fsubnet%2Fn1&network=10.1.0.0%2F24')
})

test('a DHCP range only gets a space that is an id, because the Editor sends it as is', () => {
  const a = itemActions({ kind: 'network', q: '10.1.0.0/24', id: 'ipam/subnet/n1', space: 'Corp' })
  // The network still goes, so the Editor can look its space up.
  assert.equal(hrefOf(a, 'range'), '#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fn1&network=10.1.0.0%2F24')
  assert.equal(hrefOf(itemActions({ kind: 'network', q: '10.30.0.0/24', id: 'ipam/subnet/baseline-3' }), 'range'), '#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fbaseline-3&network=10.30.0.0%2F24')
  assert.equal(hrefOf(a, 'ip'), '#automate?job=ip&space=Corp&subnet=ipam%2Fsubnet%2Fn1&network=10.1.0.0%2F24')
})

test('a network or zone without an id is still edited, by search', () => {
  assert.equal(hrefOf(itemActions({ kind: 'network', q: '10.1.0.0/24' }), 'edit'), '#editor?type=subnet&q=10.1.0.0')
  assert.equal(hrefOf(itemActions({ kind: 'zone', q: 'acme.corp.' }), 'edit'), '#editor?type=dns_zone&q=acme.corp')
})

test('an address is reserved as a host in the Editor; a host name cannot be', () => {
  assert.equal(hrefOf(itemActions({ kind: 'address', q: '10.1.0.5' }), 'reserve'), '#editor?type=host&addresses=10.1.0.5')
  assert.deepEqual(labels(itemActions({ kind: 'address', q: 'printer.acme.corp' })), ['Open', 'Copy'])
})

test('a zone record is added in Automate, with the zone named and picked by id when known', () => {
  assert.equal(
    hrefOf(itemActions({ kind: 'zone', q: 'acme.corp.', id: 'dns/auth_zone/z1' }), 'record'),
    '#automate?job=dns&zone=acme.corp&zone_id=dns%2Fauth_zone%2Fz1',
  )
})

test('a site keeps Open and Copy; nothing named gets nothing', () => {
  assert.deepEqual(labels(itemActions({ kind: 'site', q: 'dublin' })), ['Open', 'Copy'])
  assert.deepEqual(itemActions({ kind: 'network', q: '' }), [])
  assert.deepEqual(itemActions({ kind: 'network', q: '—' }), [])
})

test('the menu opens on the five kinds the brief names', () => {
  assert.deepEqual([...MENU_KINDS].sort(), ['address', 'block', 'network', 'space', 'zone'])
})
