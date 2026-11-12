import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDomain, parseCsv, parsePasted } from './siteList.js'

test('isDomain matches the server rule', () => {
  for (const ok of ['google.com', 'a.b.example.co', 'xn--bcher-kva.de']) assert.ok(isDomain(ok), ok)
  for (const no of ['localhost', 'google', '1.2.3.4', 'a..com', '-a.com', 'a.c0m', 'has space.com']) assert.ok(!isDomain(no), no)
})

test('pasted text: lines, commas and spaces, cleaned and de-duplicated', () => {
  const r = parsePasted('Google.com.\nzoom.us, google.com  notadomain\n')
  assert.deepEqual(r.domains, ['google.com', 'zoom.us'])
  assert.deepEqual(r.bad, ['notadomain'])
})

test('csv: first cell of each row, header skipped, bad rows reported', () => {
  const r = parseCsv('domain,rank\n"gstatic.com",1\ncloudfront.net,2\n,\nnope,3\n')
  assert.deepEqual(r.domains, ['gstatic.com', 'cloudfront.net'])
  assert.deepEqual(r.bad, ['nope'])
})

test('csv with no header keeps the first row', () => {
  assert.deepEqual(parseCsv('a.com\nb.com').domains, ['a.com', 'b.com'])
})

test('csv reads only the first column', () => {
  const r = parseCsv('a.com,x\n,b.com\n')
  assert.deepEqual(r.domains, ['a.com'])
})
