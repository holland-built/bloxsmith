// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeStateKey, nextMergeState } from './assetColumns.js'

// The Assets table shows Provider and Vendor, which are equal on every row of
// some tenants and not others. Collapsing them into one column is a header
// change, and a header that changes shape between page 4 and page 5 is the
// exact instability DataTable's `keep` policy exists to prevent. So the
// decision is made per filter state and HELD across that state's pages, and it
// is one-way-losable: a page that proves the two columns differ can never be
// un-proved by a later page that happens to agree.

const AWS = { provider: 'AWS', vendor: 'AWS' }
const MIXED = { provider: 'AWS', vendor: 'Amazon Web Services' }
const KEY = 'q=|type=|sort=last_seen|dir=desc'

test('a page where every row has provider === vendor merges the two columns', () => {
  const s = nextMergeState(null, KEY, [AWS, AWS, AWS])
  assert.equal(s.merged, true)
  assert.equal(s.decided, true)
  assert.equal(s.stateKey, KEY)
})

test('one row that differs is enough to keep both columns', () => {
  const s = nextMergeState(null, KEY, [AWS, MIXED, AWS])
  assert.equal(s.merged, false)
  assert.equal(s.decided, true)
})

test('merging is one-way-losable: page 2 differing unmerges, and page 3 agreeing does not win it back', () => {
  // This is the whole point of the sticky decision. Recomputing per page would
  // give merged -> unmerged -> merged, i.e. the header changing twice while
  // someone pages through one filter.
  const p1 = nextMergeState(null, KEY, [AWS, AWS])
  assert.equal(p1.merged, true, 'page 1 is all-equal')

  const p2 = nextMergeState(p1, KEY, [AWS, MIXED])
  assert.equal(p2.merged, false, 'page 2 proved they differ')

  const p3 = nextMergeState(p2, KEY, [AWS, AWS])
  assert.equal(p3.merged, false, 'page 3 agreeing must NOT re-merge')

  const p4 = nextMergeState(p3, KEY, [AWS, AWS])
  assert.equal(p4.merged, false, 'and it stays lost for the rest of the filter state')
})

test('a decision already made is held while the filter state is unchanged', () => {
  const p1 = nextMergeState(null, KEY, [AWS, AWS])
  const p2 = nextMergeState(p1, KEY, [AWS, AWS])
  assert.equal(p2.merged, true)
  assert.equal(p2.decided, true)
})

test('re-rendering with the very same array is not re-read', () => {
  // Not an optimisation — it is the mechanism the stale-payload guard below is
  // built on, so it is asserted rather than assumed.
  const page = [AWS, AWS]
  const p1 = nextMergeState(null, KEY, page)
  assert.equal(nextMergeState(p1, KEY, page), p1)
})

test('an empty page merges nothing and decides nothing', () => {
  // A page with no rows has shown neither agreement nor disagreement. It must
  // not merge (there is nothing to merge) and it must not burn the decision,
  // or a first render that lands before the fetch would lock the answer in.
  const s = nextMergeState(null, KEY, [])
  assert.equal(s.merged, false)
  assert.equal(s.decided, false)

  const after = nextMergeState(s, KEY, [AWS, AWS])
  assert.equal(after.merged, true, 'the first page with rows still gets to decide')
})

test('an empty page does not disturb a decision already made', () => {
  const p1 = nextMergeState(null, KEY, [AWS, AWS])
  assert.equal(nextMergeState(p1, KEY, []).merged, true)

  const lost = nextMergeState(null, KEY, [MIXED])
  assert.equal(nextMergeState(lost, KEY, []).merged, false)
})

test('blank vs blank counts as equal; blank vs non-blank does not', () => {
  // vendor is blank on ~19% of assets upstream. Two blanks are the same value
  // and merge honestly; a blank against a real provider is a genuine
  // difference and must keep both columns, or the vendor gap disappears.
  assert.equal(nextMergeState(null, KEY, [{ provider: '', vendor: '' }]).merged, true)
  assert.equal(nextMergeState(null, KEY, [{}]).merged, true, 'both fields absent')
  assert.equal(nextMergeState(null, KEY, [{ provider: 'AWS', vendor: '' }]).merged, false)
  assert.equal(nextMergeState(null, KEY, [{ provider: 'AWS' }]).merged, false, 'vendor absent')
  assert.equal(nextMergeState(null, KEY, [{ vendor: 'AWS' }]).merged, false, 'provider absent')
  assert.equal(nextMergeState(null, KEY, [{ provider: null, vendor: undefined }]).merged, true)
})

test('changing the filter state resets the decision, including a lost one', () => {
  const lost = nextMergeState(null, KEY, [MIXED])
  assert.equal(lost.merged, false)

  const OTHER = 'q=web|type=|sort=last_seen|dir=desc'
  const fresh = nextMergeState(lost, OTHER, [AWS, AWS])
  assert.equal(fresh.merged, true, 'a new filter gets a clean decision')
  assert.equal(fresh.stateKey, OTHER)
})

test('rows left on screen from the previous filter cannot decide the new one', () => {
  // Measured live on 2026-08-06: filtering to type=Storage Volume (44 rows, all
  // of them provider === vendor) rendered two columns. useApi keeps the OLD
  // payload on screen until the new one lands, so the render right after the
  // chip click still held the unfiltered page — which has 2 mismatched rows of
  // 50 — and that page permanently lost the merge for a filter it was never
  // part of. Identified by array identity: a fresh payload is a fresh array.
  const oldPage = [AWS, MIXED]
  const OTHER = 'q=|type=Storage Volume|sort=last_seen|dir=desc'

  const s1 = nextMergeState(null, KEY, oldPage)
  assert.equal(s1.merged, false, 'the old filter genuinely had a mismatched row')

  const s2 = nextMergeState(s1, OTHER, oldPage)
  assert.equal(s2.decided, false, "the old filter's rows must decide nothing for the new one")

  const s3 = nextMergeState(s2, OTHER, oldPage)
  assert.equal(s3.decided, false, 'and still nothing on the next render, same array')

  const s4 = nextMergeState(s3, OTHER, [AWS, AWS])
  assert.equal(s4.merged, true, 'the new payload is a new array, and it decides')
})

test('once the new payload has landed, later pages of that filter fold normally', () => {
  const OTHER = 'q=|type=Virtual Machine|sort=last_seen|dir=desc'
  const stale = [AWS, AWS]
  const p1 = nextMergeState(nextMergeState(null, KEY, stale), OTHER, stale)
  const p1b = nextMergeState(p1, OTHER, [AWS, AWS])
  assert.equal(p1b.merged, true)
  // Page 2 of the same filter is a different array and must still be able to
  // take the merge away — the stale guard is per filter change, not permanent.
  const p2 = nextMergeState(p1b, OTHER, [AWS, MIXED])
  assert.equal(p2.merged, false)
})

test('the state key covers search, type and sort — and deliberately not the page', () => {
  const base = { q: '', type: '', sort: { key: 'last_seen', dir: 'desc' } }
  const k = mergeStateKey(base)
  assert.equal(k, mergeStateKey({ ...base, page: 7 }), 'paging is what the decision is held ACROSS')
  assert.notEqual(k, mergeStateKey({ ...base, q: 'web' }))
  assert.notEqual(k, mergeStateKey({ ...base, type: 'Virtual Machine' }))
  assert.notEqual(k, mergeStateKey({ ...base, sort: { key: 'name', dir: 'desc' } }))
  assert.notEqual(k, mergeStateKey({ ...base, sort: { key: 'last_seen', dir: 'asc' } }))
})

test('two different filters cannot collide into one key by concatenation', () => {
  // 'ab' + '' and 'a' + 'b' must not produce the same key, or clearing a search
  // while setting a type would silently inherit the old decision.
  const sort = { key: 'name', dir: 'asc' }
  assert.notEqual(
    mergeStateKey({ q: 'ab', type: '', sort }),
    mergeStateKey({ q: 'a', type: 'b', sort }),
  )
})
