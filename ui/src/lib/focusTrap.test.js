// Run with: npm test  (node --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { trapTab, dialogKeyDown } from './focusTrap.js'

// A stand-in for a dialog: a panel holding controls, one document tracking focus.
function dialog(n, { hidden = [] } = {}) {
  const doc = { activeElement: null }
  const mk = (name) => ({ name, offsetParent: hidden.includes(name) ? null : {}, focus() { doc.activeElement = this } })
  const items = Array.from({ length: n }, (_, i) => mk(`c${i}`))
  const panel = { name: 'panel', ownerDocument: doc, focus() { doc.activeElement = this }, querySelectorAll: () => items }
  return { doc, panel, items }
}
function press(panel, shiftKey = false, key = 'Tab') {
  const e = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  trapTab(e, panel)
  return e
}

test('Tab on the last control wraps to the first', () => {
  const { doc, panel, items } = dialog(3)
  items[2].focus()
  const e = press(panel)
  assert.equal(e.prevented, true)
  assert.equal(doc.activeElement, items[0])
})

test('Shift+Tab on the first control wraps to the last', () => {
  const { doc, panel, items } = dialog(3)
  items[0].focus()
  const e = press(panel, true)
  assert.equal(e.prevented, true)
  assert.equal(doc.activeElement, items[2])
})

test('Shift+Tab from the panel itself goes to the last control', () => {
  const { doc, panel, items } = dialog(3)
  panel.focus()
  press(panel, true)
  assert.equal(doc.activeElement, items[2])
})

test('Tab in the middle is left to the browser', () => {
  const { doc, panel, items } = dialog(3)
  items[1].focus()
  assert.equal(press(panel).prevented, false)
  assert.equal(press(panel, true).prevented, false)
  assert.equal(doc.activeElement, items[1])
})

test('hidden controls are skipped when finding the ends', () => {
  const { doc, panel, items } = dialog(3, { hidden: ['c2'] })
  items[1].focus()
  press(panel)
  assert.equal(doc.activeElement, items[0])
})

test('with no visible control, focus stays on the panel', () => {
  const { doc, panel } = dialog(1, { hidden: ['c0'] })
  const e = press(panel)
  assert.equal(e.prevented, true)
  assert.equal(doc.activeElement, panel)
})

test('other keys and a missing panel are ignored', () => {
  const { panel } = dialog(2)
  assert.equal(press(panel, false, 'a').prevented, false)
  assert.doesNotThrow(() => trapTab({ key: 'Tab', preventDefault() {} }, null))
})

test('Escape closes and stops there', () => {
  const { panel } = dialog(2)
  let closed = 0
  const e = { key: 'Escape', stopPropagation() { this.stopped = true }, preventDefault() {} }
  dialogKeyDown(e, panel, () => { closed++ })
  assert.equal(closed, 1)
  assert.equal(e.stopped, true)
})

// The trap was once copied into eight dialogs. A new copy of the selector
// outside focusTrap.js means someone wrote a ninth instead of importing this.
test('the focusable-controls selector lives only in focusTrap.js', () => {
  const root = new URL('..', import.meta.url).pathname
  const hits = []
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.jsx?$/.test(f) && !f.endsWith('.test.js') && !p.endsWith('focusTrap.js')) {
        if (readFileSync(p, 'utf8').includes('[tabindex]:not([tabindex="-1"])')) hits.push(p.slice(root.length))
      }
    }
  }
  walk(root)
  assert.deepEqual(hits, [])
})
