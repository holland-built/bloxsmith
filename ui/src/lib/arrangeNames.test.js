// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// THE GUARANTEE: "Arrange this page" never lists a panel by its panelId.
//
// The popup names each row with CardGrid's `nameOf(id)`, which reads the title
// registry Card fills in via registerTitle. registerTitle keeps ONLY a plain
// string, and nameOf falls back to the raw panel id when it has none. That
// fallback is honest and unreadable: on #overview it printed `dns-hero` and
// `kpi-stack` — internal code names — to a reader who has never seen this
// codebase. Card's `panelName` prop is the fix, and this file is what stops the
// next titleless panel from re-opening the hole.
//
// WHY IT IS A SOURCE SCAN AND NOT A RENDER. The same reason panelHelp.test.js
// gives: a panel that only appears when a feed errors, or only for a tenant
// that owns a particular service, is never on screen in a test run but is
// always in the source. `npm test` runs `node --test` over plain .js with no
// JSX transform, so mounting is not available on this path either. The runtime
// half of this guarantee — open every tab, press "Arrange panels", read the
// rows the browser actually painted — lives in tests/arrange-names.spec.ts.
//
// THE RULE. Every <Card and <FeedCard call site must hand up words:
//
//   panelName="…"            a literal name, drawn nowhere, always a string
//   title="…"                a literal heading, which registerTitle keeps
//   title={<provably a string>}   a template literal, or a ternary / || whose
//                            every leaf is a string or template literal
//
// The third arm exists so a heading that is COMPUTED but still text — Editor's
// `${spec.label} — Create`, Provision's 'Teardown plan' : 'Teardown result' —
// does not need a second name written next to it. Anything else (no title, a
// React node, `row.name || row.cqid`) is not provably a string at build time,
// and a scanner that guessed would be guessing about the exact case this file
// exists for.
//
// WHAT IT CANNOT DO, said plainly. It reads text, so it cannot tell whether the
// words are GOOD ones — "Panel 4" passes every assertion below. It cannot see a
// panelName built at runtime, and it does not try. And it proves the call site
// hands up a string, not that the popup rendered it; that is the browser spec's
// job, and neither file is sufficient alone.
//
// The scan helpers are this file's OWN COPY, duplicated from panelHelp.test.js
// on purpose: that file is the coverage guarantee and is meant to stay
// byte-identical, so nothing here may edit it to export a helper.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_DIRS = ['tabs', 'components']

// Both shells that end at a <Card>. FeedCard is scanned as well as Card
// because it FORWARDS its caller's title to the Card inside it (see the
// exemption below), so the call site is where the name is really decided.
const TAGS = ['Card', 'FeedCard']

// The one delegating call site in the app: DataTable's FeedCard passes
// `title={title}` straight through to its Card, so that Card can never carry a
// literal of its own. Exempting it is only safe BECAUSE `<FeedCard` is itself
// in TAGS above — every caller is checked by the same rule, one layer up. If
// this list ever grows past this single entry, the delegation has spread and
// the rule needs rethinking rather than another line here.
const DELEGATES = new Set(['ui/src/components/DataTable.jsx:FeedCard-shell'])

// Comments are stripped so a comment can never stand in as evidence — several
// of these files discuss `title=` and `panelName` in prose, and this file's own
// rule would otherwise be satisfiable by a sentence. Quotes are tracked as well
// as comments so a `//` inside a URL string is not read as the start of a
// comment. Newlines are preserved so reported line numbers stay true to the
// file on disk.
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

// Every open tag for `name`, from `<N` to the `>` that closes the tag. Same
// reader as panelHelp.test.js: the end is a `>` at BRACE DEPTH 0, because props
// hold arrow functions whose `=>` would otherwise end the tag on its first
// prop, and quotes are skipped because `note=">75%"` is a real shape here.
function openTags(src, name) {
  const tags = []
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    let depth = 0
    let quote = null
    let i = start + name.length + 1
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

// The tag's OWN props, parsed rather than regexed.
//
// A REGEX OVER THE WHOLE TAG IS WRONG, and not theoretically. A `{…}` prop
// value contains nested JSX, and nested JSX has props of its own:
// Network.jsx's exhaustion table passes a heading that holds a clear-filter
// <button title="clear filter">, and `/title="([^"]*)"/` over the tag read
// THAT as the panel's heading. The panel passed this file's rule while the
// browser listed it as `network-exhaustion` — caught by
// tests/arrange-names.spec.ts, which is the whole argument for keeping both
// halves of this guarantee.
//
// Returns name -> { kind: 'literal' | 'expr' | 'bool', value }.
function props(tagText) {
  const out = new Map()
  let i = 1
  while (i < tagText.length && /[A-Za-z0-9]/.test(tagText[i])) i++
  while (i < tagText.length) {
    while (i < tagText.length && /[\s/>]/.test(tagText[i])) i++
    const from = i
    while (i < tagText.length && /[A-Za-z0-9_:-]/.test(tagText[i])) i++
    const name = tagText.slice(from, i)
    if (name === '') {
      i++
      continue
    }
    while (i < tagText.length && /\s/.test(tagText[i])) i++
    if (tagText[i] !== '=') {
      out.set(name, { kind: 'bool', value: null })
      continue
    }
    i++
    while (i < tagText.length && /\s/.test(tagText[i])) i++
    const open = tagText[i]
    if (open === '"' || open === "'") {
      i++
      const start = i
      while (i < tagText.length && tagText[i] !== open) i++
      out.set(name, { kind: 'literal', value: tagText.slice(start, i) })
      i++
    } else if (open === '{') {
      i++
      const start = i
      let depth = 1
      let quote = null
      for (; i < tagText.length && depth > 0; i++) {
        const c = tagText[i]
        if (quote) {
          if (c === '\\') i++
          else if (c === quote) quote = null
          continue
        }
        // A backtick is treated as a quote so a template literal is consumed
        // whole; its `${…}` braces are balanced either way.
        if (c === '"' || c === "'" || c === '`') quote = c
        else if (c === '{') depth++
        else if (c === '}') depth--
      }
      out.set(name, { kind: 'expr', value: tagText.slice(start, i - 1) })
    } else {
      i++
    }
  }
  return out
}

function braceProp(tag, prop) {
  const p = props(tag).get(prop)
  return p && p.kind === 'expr' ? p.value : null
}

// A same-length shadow of the expression in which every character that is
// inside a string, a template literal, or any kind of bracket is replaced by a
// dot. Operators found in the shadow are therefore the expression's OWN, and
// their indexes still address the real source.
function mask(expr) {
  let out = ''
  let depth = 0
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (c === '"' || c === "'") {
      const q = c
      const from = i
      i++
      while (i < expr.length && expr[i] !== q) i += expr[i] === '\\' ? 2 : 1
      i++
      out += '.'.repeat(Math.min(i, expr.length) - from)
      continue
    }
    if (c === '`') {
      const from = i
      i++
      let tdepth = 0
      for (; i < expr.length; i++) {
        if (expr[i] === '\\') i++
        else if (expr[i] === '$' && expr[i + 1] === '{') { tdepth++; i++ }
        else if (expr[i] === '}' && tdepth > 0) tdepth--
        else if (expr[i] === '`' && tdepth === 0) break
      }
      i++
      out += '.'.repeat(Math.min(i, expr.length) - from)
      continue
    }
    // JSX counts as a bracket: `<span>a ? b</span>` must not offer up a
    // top-level ternary that is really the element's text.
    if ('([{<'.includes(c)) { depth++; out += '.' ; i++; continue }
    if (')]}>'.includes(c)) { depth--; out += '.' ; i++; continue }
    out += depth > 0 ? '.' : c
    i++
  }
  return out
}

// The `:` that belongs to the `?` at `qi`, skipping nested ternaries.
function matchingColon(m, qi) {
  let nest = 0
  for (let i = qi + 1; i < m.length; i++) {
    if (m[i] === '?') nest++
    else if (m[i] === ':') {
      if (nest === 0) return i
      nest--
    }
  }
  return -1
}

// The expression with one layer of wrapping parentheses removed, if it has one.
function unwrap(expr) {
  const e = expr.trim()
  if (!e.startsWith('(')) return e
  let depth = 0
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++
    else if (e[i] === ')') {
      depth--
      if (depth === 0) return i === e.length - 1 ? unwrap(e.slice(1, -1)) : e
    }
  }
  return e
}

// A quoted string or a template literal, and nothing else. A template literal
// is text whatever its substitutions evaluate to, which is why it counts.
function isStringLiteral(expr) {
  const e = expr.trim()
  if (e === '') return false
  return mask(e) === '.'.repeat(e.length) && /^["'`]/.test(e)
}

// True when the expression is text no matter what the data does.
//
//   `${spec.label} — Create`        template literal: always text
//   cond ? 'Plan' : 'Result'        a ternary is text when BOTH BRANCHES are;
//                                   the condition can be anything
//   row.name || row.cqid            NOT provable — either operand may be
//                                   undefined, which registers as no name at all
//   flag && 'Name'                  NOT provable — `false` is not a name
//
// Anything it cannot prove needs a `panelName`, which is the safe direction to
// be wrong in: the cost is one honest line of copy, and the alternative is
// guessing about the exact case this file exists for.
function provablyString(expr) {
  if (expr == null) return false
  const e = unwrap(expr)
  if (e === '') return false
  const m = mask(e)
  // A top-level `?` that is not `??` and not `?.` — the neighbours are read
  // from the SOURCE, because a dot in the mask could be either.
  const qi = [...m].findIndex((c, i) => c === '?' && e[i + 1] !== '?' && e[i + 1] !== '.' && e[i - 1] !== '?')
  if (qi !== -1) {
    const ci = matchingColon(m, qi)
    if (ci === -1) return false
    return provablyString(e.slice(qi + 1, ci)) && provablyString(e.slice(ci + 1))
  }
  return isStringLiteral(e)
}

function literalProp(tag, prop) {
  const p = props(tag).get(prop)
  return p && p.kind === 'literal' ? p.value : null
}

function scanFiles() {
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(SRC_DIR, dir)
    for (const name of fs.readdirSync(full).sort()) {
      if (!name.endsWith('.jsx')) continue
      files.push({
        rel: path.join('ui/src', dir, name),
        src: stripComments(fs.readFileSync(path.join(full, name), 'utf8')),
      })
    }
  }
  return files
}

const FILES = scanFiles()

// One entry per call site, with the verdict already computed.
function callSites() {
  const out = []
  for (const { rel, src } of FILES) {
    for (const name of TAGS) {
      for (const tag of openTags(src, name)) {
        const panelName = literalProp(tag.text, 'panelName')
        const title = literalProp(tag.text, 'title')
        const titleExpr = braceProp(tag.text, 'title')
        // The delegating shell, keyed by what it actually is rather than by a
        // line number that moves every time this file's neighbours change.
        const delegated = titleExpr != null && titleExpr.trim() === 'title'
        out.push({
          rel,
          name,
          line: lineOf(src, tag.start),
          text: tag.text,
          named:
            (panelName != null && panelName.trim() !== '') ||
            (title != null && title.trim() !== '') ||
            provablyString(titleExpr),
          delegated,
        })
      }
    }
  }
  return out
}

const SITES = callSites()

// The most identifying thing about a call site, for a message somebody has to
// act on: its panelId if it has a literal one, otherwise its first prop.
function describe(site) {
  const id = literalProp(site.text, 'panelId')
  if (id) return `panelId="${id}"`
  const idExpr = braceProp(site.text, 'panelId')
  if (idExpr) return `panelId={${idExpr.trim()}}`
  const firstProp = /<\w+\s+([a-zA-Z][a-zA-Z0-9]*)/.exec(site.text)
  return firstProp ? `(no panelId, first prop: ${firstProp[1]})` : '(no props)'
}

test('scanner sanity: it found source files and Card call sites at all', () => {
  // Without this, a bad path or a broken strip would make every assertion
  // below pass on an empty set — the failure mode that would quietly retire
  // the whole guarantee.
  assert.ok(FILES.length > 10, `expected to scan the tabs and components dirs, found ${FILES.length} files`)
  assert.ok(SITES.length > 50, `expected to find the app's Card call sites, found ${SITES.length}`)
  assert.ok(
    SITES.some((s) => s.name === 'FeedCard'),
    'no <FeedCard call sites found — either they are gone (drop it from TAGS) or the reader broke',
  )
})

test('the expression reader can tell text from a React node', () => {
  // The rule's one piece of judgement, checked against the shapes actually in
  // this codebase — otherwise a regression here would silently widen or
  // narrow every verdict above without failing anything.
  assert.equal(provablyString('`${spec.label}${isUpdate ? " — Update" : " — Create"}`'), true)
  assert.equal(provablyString("teardown.status === 'previewed' ? 'Teardown plan' : 'Teardown result'"), true)
  assert.equal(provablyString("a ? 'One' : b ? 'Two' : 'Three'"), true)
  assert.equal(provablyString('row.name || row.cqid'), false)
  assert.equal(provablyString("row.name || 'Fallback'"), false)
  assert.equal(provablyString('<span>Heading</span>'), false)
  assert.equal(provablyString("cond ? <span>a ? b</span> : 'Heading'"), false)
  assert.equal(provablyString("flag && 'Name'"), false)
  assert.equal(provablyString('title'), false)
  assert.equal(provablyString('obj?.name'), false)
  assert.equal(provablyString("obj ?? 'Name'"), false)
})

test("a tag's props are its own, not those of the JSX nested inside them", () => {
  // THE REGRESSION THIS LOCKS. The first draft read props with a regex over
  // the whole tag, so the clear-filter <button title="clear filter"> inside
  // Network.jsx's exhaustion heading was read as the PANEL's heading. That one
  // panel passed this file and was listed as "network-exhaustion" in the
  // browser — found by tests/arrange-names.spec.ts, not by this file.
  const tag = '<Card panelId={panelId} title={<>Heading{f && <button title="clear filter" />}</>} note="x">'
  const p = props(tag)
  assert.equal(p.get('title').kind, 'expr')
  assert.equal(p.get('note').value, 'x')
  assert.equal(literalProp(tag, 'title'), null, 'a nested element’s title was read as the Card’s')
  assert.equal(provablyString(braceProp(tag, 'title')), false)
})

test('the delegating shell is the one it is documented to be, and no more', () => {
  const delegating = SITES.filter((s) => s.delegated).map((s) => `${s.rel}:${s.line} <${s.name}`)
  assert.deepEqual(
    delegating,
    ['ui/src/components/DataTable.jsx:689 <Card'],
    'the set of call sites that forward `title={title}` has changed. Exempting one is only safe ' +
      'because its own wrapper is scanned too (see TAGS); a new one means the rule below is now ' +
      `blind to whoever calls it. Found: ${delegating.join(', ')}`,
  )
  assert.equal(DELEGATES.size, 1, 'DELEGATES documents one exemption; keep it that way or rewrite the rule')
})

test('every panel hands up words, so "Arrange this page" can never list a panelId', () => {
  const nameless = SITES.filter((s) => !s.named && !s.delegated).map(
    (s) => `${s.rel}:${s.line} <${s.name} ${describe(s)}`,
  )
  assert.deepEqual(
    nameless,
    [],
    `${nameless.length} panel${nameless.length === 1 ? '' : 's'} would be listed in "Arrange this page" ` +
      'by their raw panelId, which is an internal code name no reader of this dashboard has seen. ' +
      'Add `panelName="Some Words"` to the call site — it renders nothing and changes no layout:\n  ' +
      nameless.join('\n  '),
  )
})

test('a name that is handed up is a name a person can read', () => {
  // The narrow half of "are the words good" that a machine can decide: a
  // panelName that is itself kebab-case is the panelId typed out by hand, which
  // passes the rule above while defeating its entire purpose.
  const bad = []
  for (const site of SITES) {
    const name = literalProp(site.text, 'panelName')
    if (name == null) continue
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) {
      bad.push(`${site.rel}:${site.line} panelName="${name}" is kebab-case — that is an id, not a name`)
    }
    if (name.trim() === '') bad.push(`${site.rel}:${site.line} panelName is blank`)
  }
  assert.deepEqual(bad, [], bad.join('\n  '))
})
