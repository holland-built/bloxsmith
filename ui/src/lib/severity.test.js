// Run with: npm test  (node --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROBLEM_SEV, SEV_WORD } from './severity.js'

test('every problem has a severity with a word', () => {
  for (const [k, sev] of Object.entries(PROBLEM_SEV)) assert.ok(SEV_WORD[sev], k)
})

// Each page used to grade its own copy of the same problem, and three of them
// disagreed. A page that writes the word or the grade itself can drift again.
test('no tile writes its own severity word or grade', () => {
  const read = (f) => readFileSync(new URL(`../tabs/${f}.jsx`, import.meta.url), 'utf8')
  const daily = read('Daily')
  assert.doesNotMatch(daily, /sev: '(crit|warn)'/)
  assert.doesNotMatch(daily, /'Needs action'|'Review'/)
  const dns = read('Dns')
  assert.doesNotMatch(dns, /\['Needs action'|\['Review'/)
  const changes = read('Changes')
  assert.doesNotMatch(changes, /alarm \? 'Review'/)
  for (const f of ['Daily', 'Dns', 'Changes', 'Network']) {
    assert.match(read(f), /from '\.\.\/lib\/severity\.js'/, f)
  }
})
