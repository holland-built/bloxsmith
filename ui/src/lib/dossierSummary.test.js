import assert from 'node:assert/strict'
import test from 'node:test'
import { dossierSummary, subnetName } from './dossierSummary.js'

const net = [{ address: '10.80.0.0', cidr: 22, name: 'dub-wired' }]

test('a free address names the subnet that holds it', () => {
  const s = dossierSummary('10.80.0.5', { assets: 'none', dns: 'none', ipam: 'none' }, net)
  assert.equal(s, "10.80.0.5 looks free. It's inside subnet 10.80.0.0/22 (dub-wired). No IPAM record, DNS record or asset uses it.")
})

test('an address something uses says what uses it', () => {
  const s = dossierSummary('10.80.0.5', { assets: 'none', dns: 'ok', ipam: 'ok' }, net)
  assert.match(s, /^10\.80\.0\.5 is in use: an IPAM record, a DNS record mention it\./)
})

test('a source that failed is never read as free', () => {
  const s = dossierSummary('10.80.0.5', { assets: 'error', dns: 'none', ipam: 'none' }, net)
  assert.match(s, /could not be checked, so it may still be in use/)
  assert.doesNotMatch(s, /looks free/)
})

test('nothing is said until every source has answered', () => {
  assert.equal(dossierSummary('10.80.0.5', { assets: 'loading', dns: 'none', ipam: 'none' }, net), null)
  assert.equal(dossierSummary('', {}, net), null)
  // Before any source reports, nothing is claimed.
  assert.equal(dossierSummary('10.80.0.5', {}, net), null)
  assert.equal(dossierSummary('10.80.0.5', { dns: 'none' }, net), null)
})

test('a hostname, where IPAM does not apply, is not called free', () => {
  const s = dossierSummary('app.example.com', { assets: 'none', dns: 'none', ipam: 'na' }, null)
  assert.equal(s, 'Nothing in Infoblox uses app.example.com. No DNS record or asset uses it.')
})

test('a subnet with no name is its network alone', () => {
  assert.equal(subnetName({ address: '10.0.0.0', cidr: 8 }), '10.0.0.0/8')
  assert.equal(subnetName({}), null)
})

test('an address in several IP spaces names each subnet', () => {
  const two = [{ address: '10.80.0.0', cidr: 24, name: 'a' }, { address: '10.80.0.0', cidr: 22, name: 'b' }]
  const s = dossierSummary('10.80.0.5', { assets: 'none', dns: 'none', ipam: 'none' }, two)
  assert.match(s, /It's inside 2 subnets, one per IP space: 10\.80\.0\.0\/24 \(a\); 10\.80\.0\.0\/22 \(b\)\./)
})
