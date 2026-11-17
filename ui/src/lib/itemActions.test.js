// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { itemActions } from './itemActions.js'

test('a network with an id opens in the Editor as a subnet, searched by its address', () => {
  assert.deepEqual(itemActions({ kind: 'network', q: '10.1.0.0/24', id: 'ipam/subnet/n1' }), [
    { key: 'editor', label: 'Open in Editor', href: '#editor?type=subnet&id=ipam%2Fsubnet%2Fn1&q=10.1.0.0' },
    { key: 'copy', label: 'Copy', copy: '10.1.0.0/24' },
  ])
})

test('a zone opens as a DNS zone, searched without its root dot', () => {
  assert.equal(
    itemActions({ kind: 'zone', q: 'acme.corp.', id: 'dns/auth_zone/z1' })[0].href,
    '#editor?type=dns_zone&id=dns%2Fauth_zone%2Fz1&q=acme.corp',
  )
})

test('no id, or a kind the Editor cannot open, leaves only Copy', () => {
  assert.deepEqual(itemActions({ kind: 'network', q: '10.1.0.0/24' }).map((a) => a.key), ['copy'])
  assert.deepEqual(itemActions({ kind: 'space', q: 'Corp', id: 'ipam/ip_space/s1' }).map((a) => a.key), ['copy'])
  assert.deepEqual(itemActions({ kind: 'site', q: 'dublin' }).map((a) => a.key), ['copy'])
  assert.deepEqual(itemActions({ kind: 'network', q: '' }), [])
})
