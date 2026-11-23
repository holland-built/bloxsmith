import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inboxRows } from './inboxRows.js'

test('a waiting site-list proposal is a Security note linking to Site lists', () => {
  const rows = inboxRows({ sitelists: [
    { list_id: 9, list_name: 'top-sites', proposal: { add: ['a.com', 'b.com'], drop: ['c.com'] } },
    { list_id: 10, list_name: 'other', proposal: { add: [], drop: [], error: 'could not read the list' } },
  ] })
  assert.deepEqual(rows.map((r) => [r.key, r.sev, r.title, r.href]), [
    ['security-sitelist-9', 'note', 'Site list top-sites: 2 to add, 1 to drop', '#lists'],
    ['security-sitelist-10', 'note', "Site list other: could not work out today's changes", '#lists'],
  ])
  assert.equal(rows[1].sub, 'could not read the list')
})

test('every attention row links to its failing items', () => {
  const incidents = ['subnet-utilization', 'dns-ttl-anomaly', 'dnssec-unsigned'].map((category) => ({ category, count: 1, severity: 'warn' }))
  const rows = inboxRows({ hosts: [{ status: 'offline' }], incidents, sec: { critical: 1, high: 0 } })
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.href])), {
    'hosts-offline': '#infra?status=offline',
    security: '#security?severity=high',
    'subnet-utilization': '#network?minUtil=70&links=1',
    'dns-ttl-anomaly': '#dns?issues=1',
    'dnssec-unsigned': '#dns?issues=dnssec',
  })
})
