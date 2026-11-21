import test from 'node:test'
import assert from 'node:assert/strict'
import { parseShell, shellHref } from './shellLook.js'

test('only a, b and c turn a look on', () => {
  assert.equal(parseShell('?shell=a'), 'a')
  assert.equal(parseShell('?x=1&shell=c'), 'c')
  for (const s of ['', '?shell=', '?shell=d', '?shell=A', '?other=a']) assert.equal(parseShell(s), null)
})

test('a look link keeps the page and other params', () => {
  assert.equal(shellHref('b', '?shell=a&x=1', '#dns'), '?shell=b&x=1#dns')
})

test("today's look drops only the shell param", () => {
  assert.equal(shellHref(null, '?shell=a&x=1', '#dns'), '?x=1#dns')
  assert.equal(shellHref(null, '?shell=a', '#dns'), '/#dns')
})
