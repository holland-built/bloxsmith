// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { itemHref, parseItem } from './itemHref.js'

test('itemHref carries kind, value and scope, and id only when given', () => {
  assert.equal(itemHref({ kind: 'network', value: '10.1.0.0/24', space: 'Corp' }), '#dossier?kind=network&q=10.1.0.0%2F24&space=Corp')
  assert.equal(
    itemHref({ kind: 'zone', value: 'acme.corp.', view: 'default', id: 'dns/auth_zone/z1' }),
    '#dossier?kind=zone&q=acme.corp.&view=default&id=dns%2Fauth_zone%2Fz1',
  )
  assert.equal(itemHref({ kind: 'address', value: ' 10.1.0.5 ' }), '#dossier?kind=address&q=10.1.0.5')
  assert.equal(itemHref({ kind: 'site', value: 'dublin', space: '' }), '#dossier?kind=site&q=dublin')
})

test('itemHref links nothing for a blank value or an unknown kind', () => {
  assert.equal(itemHref({ kind: 'network', value: '—' }), null)
  assert.equal(itemHref({ kind: 'site', value: '–' }), null)
  assert.equal(itemHref({ kind: 'network', value: '' }), null)
  assert.equal(itemHref({ kind: 'network', value: null }), null)
  assert.equal(itemHref({ kind: 'printer', value: 'x' }), null)
  assert.equal(itemHref(), null)
})

test('parseItem reads the new hash and keeps old #dossier?q= links working', () => {
  assert.deepEqual(parseItem({ kind: 'space', q: 'Corp' }), { kind: 'space', q: 'Corp', space: '', view: '', id: '' })
  assert.deepEqual(parseItem({ kind: 'network', q: '10.1.0.0/24', space: 'Corp', id: 'ipam/subnet/n1' }), {
    kind: 'network', q: '10.1.0.0/24', space: 'Corp', view: '', id: 'ipam/subnet/n1',
  })
  // Old links: no kind.
  assert.equal(parseItem({ q: '10.1.0.5' }).kind, 'address')
  assert.equal(parseItem({ q: 'app.acme.corp' }).kind, 'address')
  assert.equal(parseItem({ q: '10.1.0.0/24' }).kind, 'network')
  assert.equal(parseItem({}).kind, 'address')
  // An unknown kind falls back the same way.
  assert.equal(parseItem({ kind: 'nope', q: 'x' }).kind, 'address')
})
