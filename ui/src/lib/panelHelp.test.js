// Run with: npm test  (node --test, no test framework dependency)
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_HELP } from './panelHelp.js'

// ---------------------------------------------------------------------------
// Part 1 — shape.
//
// The dictionary is copy, and copy is the one thing a test cannot judge. What
// it CAN judge is the shape that keeps the copy readable: two short lines, no
// third line smuggled in, no key nobody renders, and an id that matches the
// `panelId` convention. The length ceilings are the disclosure's real budget —
// past them the panel help stops being a glance and becomes a document.
// ---------------------------------------------------------------------------

const WHAT_MAX = 160
const LOOK_MAX = 200
const ALLOWED_KEYS = new Set(['what', 'look'])

test('PANEL_HELP is a plain object with at least one entry', () => {
  assert.equal(typeof PANEL_HELP, 'object')
  assert.notEqual(PANEL_HELP, null)
  assert.equal(Array.isArray(PANEL_HELP), false)
  assert.ok(Object.keys(PANEL_HELP).length > 0)
})

test('every key is kebab-case, the same shape a panelId has to be', () => {
  for (const id of Object.keys(PANEL_HELP)) {
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `panelId "${id}" is not kebab-case`)
  }
})

test('every entry is { what, look? } and nothing else', () => {
  for (const [id, entry] of Object.entries(PANEL_HELP)) {
    assert.equal(typeof entry, 'object', `${id}: entry is not an object`)
    assert.notEqual(entry, null, `${id}: entry is null`)
    assert.equal(Array.isArray(entry), false, `${id}: entry is an array`)
    for (const key of Object.keys(entry)) {
      assert.ok(ALLOWED_KEYS.has(key), `${id}: unknown key "${key}" — only what/look are rendered`)
    }
  }
})

test('`what` is a non-empty string within the disclosure budget', () => {
  for (const [id, entry] of Object.entries(PANEL_HELP)) {
    assert.equal(typeof entry.what, 'string', `${id}: what is required and must be a string`)
    assert.ok(entry.what.trim().length > 0, `${id}: what is empty`)
    assert.ok(
      entry.what.length <= WHAT_MAX,
      `${id}: what is ${entry.what.length} chars, over the ${WHAT_MAX}-char budget`,
    )
  }
})

test('`look`, when present, is a non-empty string within its budget', () => {
  for (const [id, entry] of Object.entries(PANEL_HELP)) {
    if (!('look' in entry)) continue
    assert.equal(typeof entry.look, 'string', `${id}: look must be a string when present`)
    assert.ok(entry.look.trim().length > 0, `${id}: look is present but empty — omit the key instead`)
    assert.ok(
      entry.look.length <= LOOK_MAX,
      `${id}: look is ${entry.look.length} chars, over the ${LOOK_MAX}-char budget`,
    )
  }
})

// ---------------------------------------------------------------------------
// Part 2 — the coverage scanner.
//
// THIS IS THE ANTI-MYOPIA GUARANTEE, and the reason it is a static scan rather
// than a runtime check. A panel that only appears when a feed errors, or only
// on a tenant that owns a particular service, is never on screen in a test run
// — but it is always in the source. Reading the JSX is the only way to see
// every panel that CAN exist, so this is the check that cannot be satisfied by
// whichever panels happened to render.
//
// Four assertions, in the order they fail usefully:
//   (a) every <Card in tabs/ + components/ carries a panelId
//   (b)/(c) the literal panelId strings and PANEL_HELP's keys are the same set,
//       in both directions — no Card without help, no help for a dead panel
//   (d) no id is used twice (Card writes id="panel-title-<id>" into the DOM,
//       so a duplicate is a duplicate DOM id)
//
// (b) collects LITERAL ids from anywhere in the file, not only from Card tags.
// That is how the wrapper pattern is covered: Overview passes
// `<DnsHero panelId="dns-hero">` and DnsHero forwards `panelId={panelId}` to
// its Card, so the literal lives on the wrapper call site and the Card's own
// value is an expression. Assertion (a) sees the expression and is satisfied;
// (c) sees the literal and demands an entry for it.
// ---------------------------------------------------------------------------

const SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_DIRS = ['tabs', 'components']

// Comments are stripped before anything else because a doc comment in
// DataTable.jsx contains the literal text `<Card>` ("The <Card> shell stays in
// the caller"), and ui.jsx's own comments mention `<Card>` too. Counting those
// as call sites would demand a panelId on a sentence.
//
// Quotes are tracked as well as comments, and that is not over-engineering: the
// codebase holds `'https://github.com/holland-built/bloxsmith/...'`, whose `//`
// a naive line-comment strip would treat as the start of a comment and delete
// the rest of the line. Newlines are preserved so reported line numbers stay
// true to the file on disk.
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i]
          i++
          if (i < src.length) {
            out += src[i]
            i++
          }
          continue
        }
        out += src[i]
        i++
      }
      if (i < src.length) {
        out += src[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// Every `<Card` open tag, from `<C` to the `>` that closes the tag.
//
// The lookahead excludes `<CardGrid`, which shares the prefix. The end of the
// tag is found by scanning for a `>` at BRACE DEPTH 0: props hold arrow
// functions (`onSort={(next) => ...}`, `onClick={() => { ... }}`) whose `=>`
// would otherwise end the tag on its first prop, and those all sit inside `{}`.
// Quotes are skipped for the same reason as above — `note=">75%"` is a real
// shape in this codebase.
function cardTags(src) {
  const tags = []
  const re = /<Card(?=[\s/>])/g
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    let depth = 0
    let quote = null
    let i = start + '<Card'.length
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    tags.push({ start, text: src.slice(start, i + 1) })
    re.lastIndex = i
  }
  return tags
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++
  return line
}

// The most identifying thing about a Card, for a failure message somebody has
// to act on: its title if it has one, otherwise its first prop, otherwise the
// fact that it is bare.
function describe(tag) {
  const literal = /title="([^"]*)"/.exec(tag)
  if (literal) return literal[1]
  const expr = /title=\{/.exec(tag)
  if (expr) {
    const from = tag.slice(expr.index + 'title='.length).replace(/\s+/g, ' ')
    return `title={…} ${from.slice(0, 70)}${from.length > 70 ? '…' : ''}`
  }
  const firstProp = /<Card\s+([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
  if (firstProp) return `(no title, first prop: ${firstProp[1]})`
  return '(no title, no props)'
}

function scanFiles() {
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(SRC_DIR, dir)
    for (const name of fs.readdirSync(full).sort()) {
      if (!name.endsWith('.jsx')) continue
      const file = path.join(full, name)
      files.push({ rel: path.join('ui/src', dir, name), src: stripComments(fs.readFileSync(file, 'utf8')) })
    }
  }
  return files
}

const FILES = scanFiles()

test('scanner sanity: it found source files and Card call sites at all', () => {
  // Without this, a bad path or a broken strip would make every assertion
  // below pass on an empty set — the failure mode that would quietly retire
  // the whole guarantee.
  assert.ok(FILES.length > 10, `expected to scan the tabs and components dirs, found ${FILES.length} files`)
  const total = FILES.reduce((n, f) => n + cardTags(f.src).length, 0)
  assert.ok(total > 50, `expected to find the app's Card call sites, found ${total}`)
})

test('(a) every <Card call site carries a panelId', () => {
  const missing = []
  for (const { rel, src } of FILES) {
    for (const tag of cardTags(src)) {
      if (/\bpanelId\b/.test(tag.text)) continue
      missing.push(`${rel}:${lineOf(src, tag.start)} — ${describe(tag.text)}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `${missing.length} <Card call sites have no panelId, so no help can be attached to them:\n` +
      missing.map((m) => `  ${m}`).join('\n'),
  )
})

// Literal ids, app-wide. Expression-valued panelIds are deliberately NOT
// resolved: a scanner that guessed at `panelId={panelId}` would be guessing.
// The literal on the wrapper call site is the real declaration, and this finds
// it wherever it is written.
function literalIds() {
  const found = []
  for (const { rel, src } of FILES) {
    const re = /panelId="([^"]*)"/g
    let m
    while ((m = re.exec(src)) !== null) found.push({ id: m[1], rel, line: lineOf(src, m.index) })
  }
  return found
}

test('(b)/(c) the panelIds in the app and the keys of PANEL_HELP are the same set', () => {
  const inApp = new Set(literalIds().map((e) => e.id))
  const inDict = new Set(Object.keys(PANEL_HELP))

  const noHelp = [...inApp].filter((id) => !inDict.has(id)).sort()
  const orphaned = [...inDict].filter((id) => !inApp.has(id)).sort()

  assert.deepEqual(
    noHelp,
    [],
    `${noHelp.length} panels exist in the app with no PANEL_HELP entry: ${noHelp.join(', ')}`,
  )
  assert.deepEqual(
    orphaned,
    [],
    `${orphaned.length} PANEL_HELP entries name a panel that no longer exists: ${orphaned.join(', ')}. ` +
      'Either the panel was deleted (drop the entry) or its id was renamed — and renaming an id ' +
      'detaches every saved layout that refers to it.',
  )
})

test('(d) no panelId is used twice', () => {
  const seen = new Map()
  const dupes = []
  for (const entry of literalIds()) {
    const prev = seen.get(entry.id)
    if (prev) dupes.push(`"${entry.id}" at ${entry.rel}:${entry.line} and ${prev.rel}:${prev.line}`)
    else seen.set(entry.id, entry)
  }
  assert.deepEqual(
    dupes,
    [],
    'panelId must be unique app-wide — Card writes it into the DOM as id="panel-title-<id>", ' +
      `so a repeat is a duplicate DOM id:\n  ${dupes.join('\n  ')}`,
  )
})
