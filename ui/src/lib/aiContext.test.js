// Run with: npm test  (node --test)
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatContext } from './aiContext.js'

const turn = (q, a) => [{ role: 'user', text: q }, { role: 'assistant', text: a, question: q }]

test('an empty chat sends no context', () => {
  assert.equal(chatContext([]), '')
})

test('errors are left out and the last three answers are kept, oldest first', () => {
  const items = [
    ...turn('q1', 'a1'), ...turn('q2', 'a2'),
    { role: 'user', text: 'qx' }, { role: 'assistant', error: 'HTTP 500', question: 'qx' },
    ...turn('q3', 'a3'), ...turn('q4', 'a4'),
  ]
  const c = chatContext(items)
  assert.ok(!c.includes('q1') && !c.includes('qx'))
  assert.ok(c.indexOf('Q: q2') < c.indexOf('Q: q3') && c.indexOf('Q: q3') < c.indexOf('Q: q4'))
})

test('stays under the server cut-off however long the answers are', () => {
  const long = 'x'.repeat(5000)
  const c = chatContext([...turn('a', long), ...turn('b', long), ...turn('c', long)])
  assert.ok(c.length < 8000)
  assert.ok(c.includes('Q: c'), 'the newest turn is kept')
})
