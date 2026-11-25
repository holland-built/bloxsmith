// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { PANEL_HELP } from './panelHelp.js'

// GUI audit C8: the Security inventory rows were renamed to plain words, and
// the panel's help names them the same way.
test('Security inventory help uses the row names on screen', () => {
  const what = PANEL_HELP['security-inventory'].what
  assert.doesNotMatch(what, /roaming|anycast|tenant/i)
  assert.match(what, /devices with the Infoblox app/)
  assert.match(what, /servers sharing one address/)
})
