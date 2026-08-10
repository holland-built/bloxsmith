import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseBlocks, parseInline, sectionFor, slugify } from './markdown.js'

// The real document is the test fixture. A parser that passes on invented
// snippets and fails on the one file it exists to read would be worthless, and
// this is cheap: the file is 303 lines and sits two directories up.
const TABS = readFileSync(new URL('../../../docs/TABS.md', import.meta.url), 'utf8')

// Every anchor a `Docs →` link can be written with today. If a tab is added,
// add it here — a missing section is silently rendered as the whole document,
// which is a fine fallback for a reader and a terrible one for a test.
const ANCHORS = ['overview', 'provision', 'ai', 'self-service', 'drift', 'assets', 'editor']

test('slugify matches the anchors the docs links are already written against', () => {
  assert.equal(slugify('Overview'), 'overview')
  assert.equal(slugify('Self-Service'), 'self-service')
  assert.equal(slugify('DNS'), 'dns')
  assert.equal(slugify('The write flow'), 'the-write-flow')
  assert.equal(slugify('Security posture'), 'security-posture')
})

test('every tab that links to the docs has a section to land on', () => {
  const missing = ANCHORS.filter((a) => sectionFor(TABS, a) === null)
  assert.deepEqual(
    missing,
    [],
    `these anchors name no "## " heading in docs/TABS.md, so their Docs button would open ` +
      `the whole document instead of the tab's own section: ${missing.join(', ')}`,
  )
})

test('a section stops at the next tab, and keeps its own subsections', () => {
  const provision = sectionFor(TABS, 'provision')
  assert.equal(provision[0].text, 'Provision')
  // Provision owns ### Subnet / ### Full site / ### Seed demo.
  assert.ok(
    provision.some((b) => b.type === 'heading' && b.level === 3),
    'the level-3 subsections under Provision were cut off with it',
  )
  assert.ok(
    !provision.some((b) => b.type === 'heading' && b.level === 2 && b.slug !== 'provision'),
    'the section ran on into the next tab',
  )
})

test('an unknown anchor returns null rather than throwing or guessing', () => {
  assert.equal(sectionFor(TABS, 'no-such-tab'), null)
  assert.equal(sectionFor(TABS, ''), null)
  assert.equal(sectionFor(TABS, undefined), null)
})

test('the whole document parses into blocks with nothing left as a stray', () => {
  const blocks = parseBlocks(TABS)
  assert.ok(blocks.length > 50, `expected a document's worth of blocks, got ${blocks.length}`)
  const kinds = new Set(blocks.map((b) => b.type))
  // Counted from the real file — if any of these stops appearing, either the
  // doc changed shape or the parser stopped recognising it.
  for (const kind of ['heading', 'para', 'ul', 'ol', 'table', 'hr', 'quote']) {
    assert.ok(kinds.has(kind), `no ${kind} block was produced from docs/TABS.md`)
  }
})

test('headings, rules and table dividers are told apart, though all are dashes', () => {
  const b = parseBlocks('## Title\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  assert.equal(b[0].type, 'heading')
  assert.equal(b[1].type, 'hr')
  assert.equal(b[2].type, 'table')
  assert.deepEqual(b[2].head, ['a', 'b'])
  assert.deepEqual(b[2].body, [['1', '2']])
})

test('a table renders its rows whether or not the pipes are bookended', () => {
  const b = parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |\n')
  assert.deepEqual(b[0].body, [['1', '2']])
})

test('lists keep wrapped continuation lines on the item they belong to', () => {
  const b = parseBlocks('- first item\n  wrapped onto a second line\n- second item\n')
  assert.equal(b[0].type, 'ul')
  assert.deepEqual(b[0].items, ['first item wrapped onto a second line', 'second item'])
})

test('numbered and bulleted lists are different blocks', () => {
  const b = parseBlocks('1. one\n2. two\n\n- bullet\n')
  assert.equal(b[0].type, 'ol')
  assert.equal(b[1].type, 'ul')
})

test('inline spans are recognised, and code wins over everything inside it', () => {
  assert.deepEqual(parseInline('plain'), [{ type: 'text', text: 'plain' }])
  assert.deepEqual(parseInline('**bold**'), [{ type: 'strong', text: 'bold' }])
  assert.deepEqual(parseInline('*em*'), [{ type: 'em', text: 'em' }])
  assert.deepEqual(parseInline('`a`'), [{ type: 'code', text: 'a' }])
  assert.deepEqual(parseInline('[t](u)'), [{ type: 'link', text: 't', href: 'u' }])
  // The point of backticks: what is inside them is shown, not interpreted.
  assert.deepEqual(parseInline('`**not bold**`'), [{ type: 'code', text: '**not bold**' }])
})

test('a line the parser does not understand survives as text, it is not dropped', () => {
  // Fenced code does not appear in docs/TABS.md and is not supported. The rule
  // that matters is that unsupported syntax degrades to something readable
  // rather than vanishing.
  const b = parseBlocks('```\nsome code\n```\n')
  const shown = b.map((x) => x.text || (x.items || []).join(' ')).join(' ')
  assert.ok(shown.includes('some code'), 'unsupported syntax swallowed its own content')
})

test('markup in a doc arrives as data, never as HTML to be trusted', () => {
  // The whole safety argument: every parser output is a string in a field that
  // React will escape. Nothing here produces an html/raw key for a caller to
  // pass to dangerouslySetInnerHTML.
  const b = parseBlocks('A <script>alert(1)</script> line\n')
  assert.equal(b[0].type, 'para')
  assert.ok(b[0].text.includes('<script>'), 'the text was altered rather than left to React')
  const keys = new Set(Object.keys(b[0]))
  assert.ok(!keys.has('html') && !keys.has('raw'), 'the parser handed back raw markup')
})
