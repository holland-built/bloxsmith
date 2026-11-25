import test from 'node:test'
import assert from 'node:assert/strict'
import { sortWords } from './sortWords.js'

// GUI audit R3-B1 / R3-C4: the phone Sort by picker said "Time, reversed",
// which does not say which way the list runs. Each pair is [ascending, descending].

test('times say oldest and newest first', () => {
  assert.deepEqual(sortWords({ key: 'ts', label: 'Time' }, [{ ts: 1700000000 }]), ['Time, oldest first', 'Time, newest first'])
  assert.deepEqual(sortWords({ key: 'lastSeen', label: 'Last seen' }, [{ lastSeen: '2026-11-25T10:00:00Z' }]), ['Last seen, oldest first', 'Last seen, newest first'])
})

test('numbers say lowest and highest first', () => {
  assert.deepEqual(sortWords({ key: 'used', label: 'Utilization' }, [{ used: 98 }]), ['Utilization, lowest first', 'Utilization, highest first'])
  assert.deepEqual(sortWords({ key: 'n', label: 'Issues', sortAccessor: (r) => r.list.length }, [{ list: [1] }]), ['Issues, lowest first', 'Issues, highest first'])
})

test('a ranked severity or status says most serious first', () => {
  const col = { key: 'severity', label: 'Severity', comparator: () => 0 }
  assert.deepEqual(sortWords(col, [{ severity: 'high' }]), ['Severity, most serious first', 'Severity, least serious first'])
})

test('text says A to Z, and a column with no values still gets words', () => {
  assert.deepEqual(sortWords({ key: 'actor', label: 'Actor' }, [{ actor: 'bob' }]), ['Actor, A to Z', 'Actor, Z to A'])
  assert.deepEqual(sortWords({ key: 'x', label: 'Name' }, []), ['Name, A to Z', 'Name, Z to A'])
  // An address is a number written with dots: low to high, not A to Z.
  assert.deepEqual(sortWords({ key: 'network', label: 'Network' }, [{ network: '10.30.0.0/24' }]), ['Network, lowest first', 'Network, highest first'])
  assert.deepEqual(sortWords({ key: 'ip', label: 'IP', comparator: () => 0 }, [{ ip: '10.0.0.1' }]), ['IP, lowest first', 'IP, highest first'])
})

test('a ranked severity given as an accessor, an end date and digits in text', () => {
  assert.deepEqual(sortWords({ key: 's', label: 'Severity', sortAccessor: () => 1 }, [{}]), ['Severity, most serious first', 'Severity, least serious first'])
  assert.deepEqual(sortWords({ key: 'e', label: 'Ends', comparator: () => 0 }, [{ e: 'x' }]), ['Ends, soonest first', 'Ends, latest first'])
  assert.deepEqual(sortWords({ key: 'q', label: 'Count' }, [{ q: '48211' }]), ['Count, lowest first', 'Count, highest first'])
})
