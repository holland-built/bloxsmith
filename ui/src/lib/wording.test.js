import test from 'node:test'
import assert from 'node:assert/strict'
import { NO_PERMISSION, failureText } from './api.js'
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
  const name = new Map(SOURCES)
  assert.equal(name.get('address'), 'Get an address: assigned IPs')
  assert.equal(name.get('dns'), 'Get an address: DNS names')
})
