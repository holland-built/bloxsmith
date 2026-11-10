// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { changeText, vsYesterday } from './dnsCompare.js'

const H = 3600000
const at = (h) => new Date(Date.UTC(2026, 10, 10, 0) + h * H).toISOString()
const series = (n, v = (i) => 10 + i) => Array.from({ length: n }, (_, i) => ({ hour: at(i), avg_value: v(i) }))

test('24 hourly rows: compares the latest hour with the one 23 hours before it', () => {
  const c = vsYesterday(series(24))
  assert.equal(c.was, 10)
  assert.equal(c.now, 33)
  assert.equal(c.wasHour, at(0))
})

test('25 hourly rows: the hour exactly 24 hours back wins over 23', () => {
  const c = vsYesterday(series(25))
  assert.equal(c.wasHour, at(0))
  assert.equal(c.was, 10)
})

test('a short series has no hour from yesterday, so no comparison at all', () => {
  // The old panel compared 125 with the first of three hours and said "▲ 25%".
  assert.equal(vsYesterday(series(3)), null)
  assert.equal(vsYesterday([]), null)
  assert.equal(vsYesterday(null), null)
})

test('a zero or unreadable base gives no percentage', () => {
  assert.equal(vsYesterday(series(24, (i) => (i === 0 ? 0 : 5))), null)
  assert.equal(vsYesterday([{ hour: 'x', avg_value: 1 }, { hour: 'y', avg_value: 2 }]), null)
})

test('change text: arrows, flat, and a tiny base', () => {
  assert.equal(changeText({ was: 10, pct: 39.4 }), '▲ 39%')
  assert.equal(changeText({ was: 10, pct: -12.6 }), '▼ 13%')
  assert.equal(changeText({ was: 10, pct: 0.2 }), '±0%')
  assert.equal(changeText({ was: 0.4, pct: 400 }), 'was 0.4')
  assert.equal(changeText(null), null)
})
