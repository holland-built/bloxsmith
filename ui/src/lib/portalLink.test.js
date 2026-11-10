import assert from 'node:assert/strict'
import test from 'node:test'
import LZString from 'lz-string'
import BASE from '../../../tests/chart-options.json' with { type: 'json' }
import { rawByName } from './chartBuilder.js'
import { portalLink } from './portalLink.js'

// "Open in Infoblox": the portal reads advancedFilterValue as the filter text,
// JSON-quoted and lz-string compressed. Field names were checked by hand in the
// portal on 2026-10-27.
const OPTIONS = { ...BASE, portal: 'https://csp.infoblox.com' }
const picks = (over) => ({ count: 'assets', split: 'atype', window: 'now', over: 'none', top: 10, ...over })
const filterOf = (url) => JSON.parse(LZString.decompressFromEncodedURIComponent(new URL(url.replace('/#/', '/')).searchParams.get('advancedFilterValue')))

test('a bar opens the portal filtered to its value', () => {
  const url = portalLink(OPTIONS, picks(), 'Virtual Machine')
  assert.match(url, /^https:\/\/csp\.infoblox\.com\/#\/workspace\/assets\/details\/managed-assets\?hideBreadcrumbs=true&isAdvanced=true&advancedFilterValue=/)
  assert.equal(filterOf(url), 'asset.Type IN ["Virtual Machine"]')
})

test('Found by uses CONTAINS, and Only show is joined with AND', () => {
  assert.equal(filterOf(portalLink(OPTIONS, picks({ split: 'source' }), 'AWS')), 'asset.Providers CONTAINS "AWS"')
  const p = picks({ split: 'vendor', only: 'atype', is: 'is', value: 'Smartphone' })
  assert.equal(filterOf(portalLink(OPTIONS, p, 'Apple')), 'asset.Type IN ["Smartphone"] AND asset.Vendor IN ["Apple"]')
})

test('the whole chart opens with only its Only show filter, or none', () => {
  assert.equal(portalLink(OPTIONS, picks()), 'https://csp.infoblox.com/#/workspace/assets/details/managed-assets?hideBreadcrumbs=true')
  assert.equal(filterOf(portalLink(OPTIONS, picks({ only: 'problem', is: 'is', value: 'Zombie' }))), 'asset.Classifications IN ["Zombie"]')
})

test('a quote in a value stays inside its string', () => {
  assert.equal(filterOf(portalLink(OPTIONS, picks(), 'Odd "name"')), 'asset.Type IN ["Odd \\"name\\""]')
})

test('no link when part of the chart has no portal equivalent', () => {
  assert.equal(portalLink(OPTIONS, picks({ count: 'dns', split: 'device', window: '7d' }), 'x'), null)
  assert.equal(portalLink(OPTIONS, picks({ split: 'region' }), 'us-east-1'), null)
  assert.equal(portalLink(OPTIONS, picks(), ''), null)
  assert.equal(portalLink(OPTIONS, picks({ only: 'atype', is: 'not', value: 'Laptop' })), null)
  assert.equal(portalLink({ ...OPTIONS, portal: 'javascript:alert(1)' }, picks()), null)
  assert.equal(portalLink({ ...OPTIONS, portal: undefined }, picks()), null)
})

test('each bar keeps its raw value, and the blank one gets no link', () => {
  const f = 'AssetDetails_ch_agg.vendor'
  const m = 'AssetDetails_ch_agg.assetsCount'
  const rows = [{ [f]: 'Apple', [m]: 3 }, { [f]: '', [m]: 1 }, { [f]: null, [m]: 2 }]
  const p = picks({ split: 'vendor' })
  const raws = rawByName(OPTIONS, p, rows, false)
  assert.equal(raws.get('Apple'), 'Apple')
  const blank = [...raws.entries()].find(([name]) => name !== 'Apple')
  assert.equal(blank[1], '')
  assert.equal(portalLink(OPTIONS, p, blank[1]), null)
})

test('a bar name two different raw values share gets no raw value', () => {
  // Onprem reads "On-premises"; were another raw value to read the same, the
  // bar could not say which to send.
  const f = 'AssetDetails_ch_agg.deploymentContext'
  const m = 'AssetDetails_ch_agg.assetsCount'
  const opts = { ...OPTIONS, values: { ...OPTIONS.values, [f]: { Onprem: 'On-premises', OnPrem: 'On-premises' } } }
  const raws = rawByName(opts, picks({ split: 'where' }), [{ [f]: 'Onprem', [m]: 1 }, { [f]: 'OnPrem', [m]: 1 }], false)
  assert.equal(raws.has('On-premises'), false)
})
