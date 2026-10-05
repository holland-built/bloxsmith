import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { chartA11y, describePoints } from './chartSummary.js'

test('a few points are read out one by one, with the unit first', () => {
  const parts = [
    { label: 'Active', value: 10 },
    { label: 'Degraded', value: 2 },
    { label: 'Offline', value: 1 },
  ]
  assert.equal(describePoints(parts, 'hosts'), 'Hosts: Active 10, Degraded 2, Offline 1.')
  assert.equal(describePoints(parts), 'Active 10, Degraded 2, Offline 1.')
})

test('a long run gives its count, its ends, and where it is lowest and highest', () => {
  const run = [3, 9, 4, 1, 7, 7, 2, 5].map((value, i) => ({ label: `0${i}:00`, value }))
  assert.equal(
    describePoints(run, 'queries per second'),
    'Queries per second: 8 values, 00:00 to 07:00. Lowest 1 at 03:00, highest 9 at 01:00.',
  )
})

test('six points are still a list, and seven are a run', () => {
  const pts = (n) => Array.from({ length: n }, (_, i) => ({ label: `p${i + 1}`, value: i + 1 }))
  assert.equal(describePoints(pts(6)), 'p1 1, p2 2, p3 3, p4 4, p5 5, p6 6.')
  assert.equal(describePoints(pts(7)), '7 values, p1 to p7. Lowest 1 at p1, highest 7 at p7.')
})

test('a flat run says so, instead of naming one point as both lowest and highest', () => {
  const flat = Array.from({ length: 8 }, (_, i) => ({ label: `d${i}`, value: 5 }))
  assert.equal(describePoints(flat, 'events'), 'Events: 8 values, d0 to d7. Every value is 5.')
})

test('values that are written the same are not called lowest and highest', () => {
  const near = [1.01, 1.02, 1.04, 1.03, 1.02, 1.01, 1.04].map((value, i) => ({ label: `d${i}`, value }))
  assert.equal(describePoints(near), '7 values, d0 to d6. Every value is 1.')
})

test('a run that starts and ends on the same label says where it ends, and places a repeated label', () => {
  // 25 hourly points: 10 PM yesterday to 10 PM today.
  const hours = ['10 PM', '11 PM', '12 AM', '1 AM', '2 AM', '3 AM', '4 AM', '10 PM']
  const day = hours.map((label, i) => ({ label, value: [9, 5, 4, 3, 6, 7, 8, 2][i] }))
  assert.equal(
    describePoints(day),
    '8 values, ending 10 PM. Lowest 2 at 10 PM, value 8 of 8, highest 9 at 10 PM, value 1 of 8.',
  )
})

test('numbers are written the way the tooltips write them', () => {
  const pts = [{ label: 'Mon', value: 438914 }, { label: 'Tue', value: 274.715 }]
  assert.equal(describePoints(pts), 'Mon 438,914, Tue 274.7.')
})

test('a point with no number is left out, and nothing left is "No data."', () => {
  assert.equal(describePoints([{ label: 'a', value: null }, { label: 'b', value: 'x' }, { label: 'c', value: 4 }]), 'c 4.')
  assert.equal(describePoints([{ label: 'a', value: null }]), 'No data.')
  assert.equal(describePoints([]), 'No data.')
  assert.equal(describePoints(undefined), 'No data.')
})

test('a point with no label is named by its place', () => {
  assert.equal(describePoints([{ value: 4 }, { label: '', value: 6 }]), '#1 4, #2 6.')
})

test('the name goes in aria-label, never in an SVG title', () => {
  assert.deepEqual(chartA11y('Host Status', 'Hosts: Active 1.'), {
    'aria-label': 'Host Status chart',
    desc: 'Hosts: Active 1.',
  })
})

// Every place a chart is used has to say what the chart is called. A chart
// with no label would be announced as "undefined chart".
test('every chart on every page is given a label', () => {
  const dir = new URL('../tabs/', import.meta.url)
  const opening = /<(GradientArea|CategoryBars|StackedDayBars|StatusDonut|SubnetUsageBars)\b/g
  // The tag ends at the first "/>" outside any {…}. A plain "[^>]*" stops
  // early at the ">" of an arrow function in a prop, which two charts have.
  const tagFrom = (src, start) => {
    let depth = 0
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      else if (depth === 0 && src[i] === '/' && src[i + 1] === '>') return src.slice(start, i + 2)
    }
    return src.slice(start)
  }
  let seen = 0
  const missing = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsx'))) {
    const src = readFileSync(new URL(f, dir), 'utf8')
    for (const m of src.matchAll(opening)) {
      seen++
      if (!/\blabel="[^"]+"/.test(tagFrom(src, m.index))) missing.push(`${f}: <${m[1]}>`)
    }
  }
  assert.equal(seen, 10, 'the number of charts in ui/src/tabs changed; check each new one has a label')
  assert.deepEqual(missing, [])
})
