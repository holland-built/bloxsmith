import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { removeChart, saveChart } from './savedCharts.js'
import { NO_PERMISSION, failureText } from './api.js'
import { WRITE_NO_PERMISSION, WRITE_UNKNOWN, writeFailureText } from './writeFailure.js'
import { formatDay, formatTime, formatWhen } from './dates.js'
import { SOURCES } from './valueWork.js'

test('a failed request says what failed and what to do, never a bare code', () => {
  for (const status of [400, 404, 409, 429, 500, 502, 503]) {
    const text = failureText(status, 'save the list')
    assert.match(text, /^Could not save the list\./)
    assert.match(text, /try again|Refresh|Check/i)
    assert.doesNotMatch(text, /HTTP|\b\d{3}\b/)
  }
})

test('401 and 403 read as the no-permission message', () => {
  assert.equal(failureText(401, 'save the list'), NO_PERMISSION)
  assert.equal(failureText(403, 'save the list'), NO_PERMISSION)
})

test('a Remove summary keeps its counts instead of reading as unknown', () => {
  for (const error of [
    '1 item(s) were not removed because the delete was never sent. Check them, then Remove again to retry.',
    '2 item(s) were refused by Infoblox and not removed. Check them, then Remove again to retry.',
    '1 item(s) may or may not have been removed, because Infoblox gave no clear answer. Check them, then Remove again to retry.',
  ]) assert.equal(writeFailureText(502, { error }, 'remove these items'), error)
})

test('every date helper uses the same format for one moment', () => {
  const at = new Date(2026, 10, 23, 14, 5)
  const opts = { month: 'short', day: 'numeric', year: 'numeric' }
  const time = { hour: 'numeric', minute: '2-digit' }
  assert.equal(formatDay(at), at.toLocaleDateString(undefined, opts))
  assert.equal(formatTime(at), at.toLocaleTimeString(undefined, time))
  assert.equal(formatWhen(at), at.toLocaleString(undefined, { ...opts, ...time }))
})

test('date helpers accept API values and show a dash for a bad one', () => {
  const iso = '2026-11-23T14:05:00Z'
  assert.equal(formatWhen(iso), formatWhen(new Date(iso)))
  assert.equal(formatWhen(Date.parse(iso)), formatWhen(new Date(iso)))
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.equal(formatWhen(bad), '—')
    assert.equal(formatDay(bad), '—')
    assert.equal(formatTime(bad), '—')
  }
})

test('the Value row does not repeat a word', () => {
  const row = new Map(SOURCES.map(([s, ...rest]) => [s, rest]))
  assert.deepEqual(row.get('address'), ['Get an address', 'item'])
  assert.deepEqual(row.get('dns'), ['Get an address', 'DNS name'])
  for (const [, label] of SOURCES) assert.ok(!label.includes(':'), `${label} has its own colon, so the line would have two`)
})

test('a write with no clear answer says the outcome is unknown', () => {
  assert.equal(WRITE_UNKNOWN, 'Bloxsmith did not get an answer, so this may or may not have happened. Refresh and check before trying again.')
  for (const [status, data] of [
    [0, { error: 'network error' }], [502, null], [504, {}],
    [502, { error: 'create failed (could not reach the tenant — no request completed)' }],
    [504, { error: 'update failed (status 504)' }],
    [200, null],
  ]) assert.equal(writeFailureText(status, data, 'delete this item'), WRITE_UNKNOWN)
})

test('a clear refusal keeps its own message', () => {
  assert.equal(writeFailureText(409, { error: 'Still in use' }, 'delete this item'), 'Still in use')
  assert.equal(writeFailureText(400, {}, 'delete this item'), failureText(400, 'delete this item'))
  assert.equal(writeFailureText(404, null, 'delete this item'), failureText(404, 'delete this item'))
  // The pre-delete read failed, so nothing was sent; the server says exactly that.
  assert.equal(writeFailureText(502, { error: 'could not read it from Infoblox (502)' }, 'delete this item'),
    'could not read it from Infoblox (502)')
})

test('an empty 401 or 403 on a write says nothing was changed', () => {
  assert.equal(WRITE_NO_PERMISSION, "You don't have permission to do this. Nothing was changed.")
  for (const status of [401, 403]) assert.equal(writeFailureText(status, {}, 'update the record'), WRITE_NO_PERMISSION)
  assert.equal(writeFailureText(403, { error: 'Mark this tenant writable' }, 'update the record'), 'Mark this tenant writable')
})

test('any 5xx on a write is unknown, even with an error message', () => {
  for (const [status, data] of [
    [502, { error: 'update failed (status 502)' }],
    [504, { error: 'update failed' }],
    [500, null],
    [500, {}],
    [500, { error: 'create failed (status 500)' }],
    [503, { error: 'internal error' }],
    [502, { error: 'block request rejected: EOF' }],
  ]) assert.equal(writeFailureText(status, data, 'save this'), WRITE_UNKNOWN, JSON.stringify([status, data]))
})

test('a 5xx keeps its message only when the code knows what happened', () => {
  for (const error of [
    'could not read it from Infoblox (502)',
    'could not read the never-add list, so nothing was sent',
    'could not record the change, so it was not made: disk full',
    'the reservation was made, but the DNS record may or may not exist. Check it in Infoblox.',
    'Infoblox answered yes, but a.com is still in the list',
    'the tenant did not confirm this subnet (no answer from the tenant): the subnet MAY EXIST.',
  ]) assert.equal(writeFailureText(502, { error }, 'save this'), error)
})

test('a generic 401 or 403 from the server reads as no permission', () => {
  for (const status of [401, 403]) {
    assert.equal(writeFailureText(status, { error: `delete failed (status ${status})` }, 'delete this'), WRITE_NO_PERMISSION)
  }
})

test('saved charts word a write with no answer as unknown', async () => {
  const chart = { id: 'k3x9q2m7ab12', title: 'x', tab: 'dns', picks: { source: 'dns', metric: 'count', group: 'none' } }
  const bad = async () => ({ ok: false, status: 502, json: async () => { throw new Error('html') } })
  const dead = async () => { throw new TypeError('Failed to fetch') }
  await assert.rejects(removeChart(chart.id, bad), { message: WRITE_UNKNOWN })
  await assert.rejects(removeChart(chart.id, dead), { message: WRITE_UNKNOWN })
  await assert.rejects(saveChart(chart, dead), { message: WRITE_UNKNOWN })
})

// These screens need a whole page of setup each; the helper's rule is tested
// above, and this holds each write to it.
test('every write failure goes through the shared helper', () => {
  const uses = {
    '../components/ReadOnlySwitch.jsx': "'change the write permission'",
    '../components/SavedChart.jsx': "'save the layout'",
    '../components/DemoSettingsForm.jsx': "'save the demo settings'",
    '../components/TenantManager.jsx': "'switch account'",
    '../tabs/Security.jsx': "'apply this change'",
    '../tabs/SiteLists.jsx': "'save the watch setting'",
    '../tabs/Ai.jsx': "'apply this action'",
    '../tabs/Incidents.jsx': "'update this action'",
    '../tabs/Automate.jsx': "'remove these items'",
    '../tabs/Editor.jsx': "'complete this change'",
  }
  for (const [file, what] of Object.entries(uses)) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, new RegExp(`writeFailureText\\([^\\n]*${what}`), file)
  }
  assert.ok(readFileSync(new URL('../tabs/Provision.jsx', import.meta.url), 'utf8').includes(`const WRITE_UNKNOWN = '${WRITE_UNKNOWN}'`))
  const lists = readFileSync(new URL('../tabs/SiteLists.jsx', import.meta.url), 'utf8')
  assert.match(lists, /writeFailureText\([^\n]*'save the never-add list'/)
})

test('a reply the server marks as refused or not sent keeps its message, even on a 5xx', () => {
  for (const outcome of ['refused', 'not-sent']) {
    const error = 'Infoblox did not take the change (HTTP 403). Check the policy in Infoblox before trying again'
    assert.equal(writeFailureText(502, { outcome, error }, 'save this'), error)
    assert.equal(writeFailureText(502, { outcome }, 'save this'), WRITE_UNKNOWN)
  }
  assert.equal(writeFailureText(502, { outcome: 'partial', error: 'Infoblox stopped taking domains' }, 'save this'), WRITE_UNKNOWN)
})

test('a refusal after part of a list went in keeps the server message', () => {
  const error = 'Infoblox stopped taking domains (HTTP 403) after about 500 of 900.'
  assert.equal(writeFailureText(502, { outcome: 'partial', refused: true, error }, 'add the domains'), error)
  assert.equal(writeFailureText(502, { outcome: 'partial', error }, 'add the domains'), WRITE_UNKNOWN)
})

test('a failure shown beside a Try again button does not also say "try again in a moment" (GUI audit R3-C7)', () => {
  assert.equal(failureText(503, 'search the portal audit log', { retryShown: true }), 'Could not search the portal audit log.')
  assert.equal(failureText(403, 'search the portal audit log', { retryShown: true }), NO_PERMISSION)
})
