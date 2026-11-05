// Run with: npm test  (node --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { playbookFor } from './ansible.js'

test('an IP address becomes ipam_address with next_available_id', () => {
  const p = playbookFor('ip', { space: 'ipam/ip_space/a', subnet_id: 'ipam/subnet/s2', name: 'printer-02' })
  assert.match(p, /infoblox\.universal_ddi\.ipam_address:/)
  assert.match(p, /next_available_id: "ipam\/subnet\/s2"/)
  assert.match(p, /comment: "printer-02"/)
})

test('a CNAME puts the target under rdata.cname, and @ is the zone itself', () => {
  const p = playbookFor('dns', { zone_id: 'dns/auth_zone/z1', name_in_zone: '@', type: 'CNAME', value: 'web.example.com' })
  assert.match(p, /rdata:\n {10}cname: "web\.example\.com"/)
  assert.match(p, /name_in_zone: ""/)
})

test('a quote in an answer cannot break out of the YAML string', () => {
  const p = playbookFor('dns', { zone_id: 'z', name_in_zone: 'x', type: 'TXT', value: 'a" \n- evil: yes' })
  assert.match(p, /text: "a\\" \\n- evil: yes"/)
})

test('jobs not checked against the collection get no playbook', () => {
  assert.equal(playbookFor('branch', {}), '')
  assert.equal(playbookFor('dns', { type: 'NS' }), '')
})

test('a network size that is not a whole number in range makes no playbook', () => {
  assert.equal(playbookFor('network', { space: 's', block_id: 'b', cidr: '24\n- shell: rm -rf /' }), '')
  assert.equal(playbookFor('dns', { zone_id: 'z', name_in_zone: 'x', type: 'constructor', value: 'v' }), '')
})
