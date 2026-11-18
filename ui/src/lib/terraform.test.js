// Run with: npm test  (node --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { terraformFor } from './terraform.js'

const PROVIDER = /required_providers \{\n {4}bloxone = \{\n {6}source {2}= "infobloxopen\/bloxone"/

test('an IP address becomes bloxone_ipam_address with next_available_id', () => {
  const t = terraformFor('ip', { space: 'ipam/ip_space/a', subnet_id: 'ipam/subnet/s2', name: 'printer-02' })
  assert.match(t, PROVIDER)
  assert.match(t, /provider "bloxone" \{\}/)
  assert.match(t, /INFOBLOX_PORTAL_KEY/)
  assert.match(t, /resource "bloxone_ipam_address" "this" \{/)
  assert.match(t, /  space {13}= "ipam\/ip_space\/a"/)
  assert.match(t, /  next_available_id = "ipam\/subnet\/s2"/)
  assert.match(t, /  comment {11}= "printer-02"/)
})

test('an IP address with no name has no comment line', () => {
  const t = terraformFor('ip', { space: 's', subnet_id: 'ipam/subnet/s2' })
  assert.doesNotMatch(t, /comment/)
})

test('each DNS type gets its own resource and rdata key', () => {
  for (const [type, res, key] of [['A', 'bloxone_dns_a_record', 'address'], ['AAAA', 'bloxone_dns_aaaa_record', 'address'],
    ['CNAME', 'bloxone_dns_cname_record', 'cname'], ['TXT', 'bloxone_dns_txt_record', 'text']]) {
    const t = terraformFor('dns', { zone_id: 'dns/auth_zone/z1', name_in_zone: 'web', type, value: 'v1' })
    assert.match(t, new RegExp(`resource "${res}" "this" \\{`), type)
    assert.match(t, /  zone {9}= "dns\/auth_zone\/z1"/, type)
    assert.match(t, /  name_in_zone = "web"/, type)
    assert.match(t, new RegExp(`  rdata = \\{\\n    ${key} = "v1"\\n  \\}`), type)
  }
})

test('@ is the zone itself', () => {
  assert.match(terraformFor('dns', { zone_id: 'z', name_in_zone: '@', type: 'A', value: '10.0.0.5' }), /name_in_zone = ""/)
})

test('a network is the next free subnet of that size in the block', () => {
  const t = terraformFor('network', { space: 'ipam/ip_space/a', block_id: 'ipam/address_block/b1', cidr: '24', name: 'office-b' })
  assert.match(t, /resource "bloxone_ipam_subnet" "this" \{/)
  assert.match(t, /  next_available_id = "ipam\/address_block\/b1"/)
  assert.match(t, /  cidr {14}= 24\n/)
  assert.match(t, /  name {14}= "office-b"/)
  assert.match(t, /  tags = \{\n    Name = "office-b"\n  \}/)
})

test('a quote or ${ in an answer cannot break out of the HCL string', () => {
  const t = terraformFor('dns', { zone_id: 'z', name_in_zone: 'x', type: 'TXT', value: 'a" ${file("/etc/passwd")} %{if true}\n}' })
  assert.match(t, /text = "a\\" \$\$\{file\(\\"\/etc\/passwd\\"\)\} %%\{if true\}\\n\}"/)
})

test('jobs with no clean Terraform resource get nothing', () => {
  assert.equal(terraformFor('branch', {}), '')
  assert.equal(terraformFor('demo', {}), '')
  assert.equal(terraformFor('dns', { type: 'NS', zone_id: 'z', value: 'x' }), '')
  assert.equal(terraformFor('network', { space: 's', block_id: 'b', cidr: '24\n}' }), '')
  assert.equal(terraformFor('network', { space: 's', block_id: 'b', cidr: '4' }), '')
})
