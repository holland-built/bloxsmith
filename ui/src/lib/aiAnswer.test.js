// Run with: npm test  (node --test, no test framework dependency)
//
// The chat box used to print the answer as plain text, so the bold and the
// table the model now writes (rule 12, go/internal/ai/schema.go) showed up as
// ** and | characters. These pin how the answer is read into blocks.
import assert from 'node:assert/strict'
import test from 'node:test'
import { answerBlocks } from './aiAnswer.js'

const ANSWER = [
  '**Found 1 network list and 5 hosts.**',
  '| Item | Answer |',
  '|---|---|',
  '| Network list | **example-home** |',
  '| Hosts | **fi, uddi** |',
  '- Subnets not checked',
  '- Policy not checked',
].join('\n')

test('a bold line, a table and bullets come out as three blocks', () => {
  const b = answerBlocks(ANSWER)
  assert.deepEqual(b.map((x) => x.type), ['para', 'table', 'ul'])
  assert.equal(b[0].text, '**Found 1 network list and 5 hosts.**')
  assert.deepEqual(b[1].head, ['Item', 'Answer'])
  assert.deepEqual(b[1].body, [['Network list', '**example-home**'], ['Hosts', '**fi, uddi**']])
  assert.deepEqual(b[2].items, ['Subnets not checked', 'Policy not checked'])
})

test('single line breaks stay separate lines, not one run-on paragraph', () => {
  const b = answerBlocks('First line.\nSecond line.')
  assert.deepEqual(b.map((x) => x.text), ['First line.', 'Second line.'])
})

test('old-style • bullets still show as a list', () => {
  const b = answerBlocks('Hosts:\n• fi\n• uddi')
  assert.deepEqual(b.map((x) => x.type), ['para', 'ul'])
  assert.deepEqual(b[1].items, ['fi', 'uddi'])
})
