import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jumpToPanel } from './jumpToPanel.js'

// A fake page: one panel, and a window whose events the test fires by hand.
function page() {
  const calls = []
  const listeners = new Map()
  const el = {
    scrollIntoView: (o) => calls.push(o), focus() {},
    hasAttribute: () => true, setAttribute() {},
  }
  globalThis.document = { querySelector: () => el, querySelectorAll: () => [] }
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (t, f) => listeners.set(t, [...(listeners.get(t) || []), f]),
    removeEventListener: (t, f) => listeners.set(t, (listeners.get(t) || []).filter((g) => g !== f)),
  }
  const fire = (t) => (listeners.get(t) || []).slice().forEach((f) => f())
  return { calls, fire }
}

test('a jump settles the panel once its smooth scroll stops', () => {
  const { calls, fire } = page()
  jumpToPanel('p')
  fire('scrollend')
  fire('scrollend')
  assert.equal(calls.length, 2) // the smooth scroll, then one settle
  assert.deepEqual(calls[1], { block: 'start' })
})

test("the person's own scroll is never undone", () => {
  for (const input of ['wheel', 'touchstart', 'keydown']) {
    const { calls, fire } = page()
    jumpToPanel('p')
    fire(input)
    fire('scrollend')
    assert.equal(calls.length, 1, `${input} then a scroll stop snapped back`)
  }
})
