// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// PANEL_HELP — TRUTH, as far as a machine can check it.
//
// panelHelp.test.js proves SHAPE and COVERAGE: every panel has an entry, every
// entry is two short strings, no entry names a panel that no longer exists. What
// it cannot prove is that a single word of the 90 entries is TRUE. A `look` line
// reading "click a row to open that subnet" passes every assertion in that file
// on a panel whose rows have not been clickable since 2024.
//
// This file closes the narrow part of that gap that a machine can actually
// close. For a handful of claims, the sentence implies a specific thing the code
// must contain, so the claim can be checked against the code:
//
//   "click/tap a row | bar | square | slice"  =>  onClick / onRowClick exists
//   "type in the box" / "search by" / "narrow to|by"  =>  an <input> or <select>
//   "export" / "spreadsheet" / "CSV"         =>  a download path exists
//   "sort"                                   =>  sort handling exists
//   "point at a square"                      =>  a pointer handler exists
//
// Evidence is looked for in THE FILE WHERE THAT panelId LITERAL APPEARS, which
// panelHelp.test.js (d) guarantees is exactly one file per id.
//
// ---------------------------------------------------------------------------
// WHAT THIS TEST CANNOT CATCH. Read this before trusting a green run.
//
//   - NUMBERS, THRESHOLDS, COLOUR MEANINGS and TIME WINDOWS are now CHECKED IN
//     panelHelpValues.test.js, not here. "150 at most", "top twelve", "the first
//     25 of each"; "amber past 75% full", "red under 30 days", "over 85% full";
//     "green created, blue updated, red deleted"; "the last hour", "the last
//     seven days". That file is a declarative claim table binding one sentence
//     to one line in one named file — including ui.jsx, lib/ and Go, which the
//     file-level scan below cannot reach. THIS file still cannot catch any of
//     them: a cap changed from 150 to 50, or every comparison operator flipped,
//     leaves everything here green. Read that file's header for what its own
//     coverage does and does not prove — in particular, it matches a literal in
//     a Go file without proving the panel calls that endpoint, and it pairs a
//     colour token with an English word by a hand-written dictionary.
//   - DATA-SOURCE CLAIMS. "from the server, not this page", "counted by the day
//     each was last touched", "the split is never guessed". These are claims
//     about where work happens and what a payload contained; nothing in either
//     file reads a request or a response. panelHelpValues.test.js lists the ones
//     it deliberately declined in its own EXCLUDED table.
//   - ANY SENTENCE OUTSIDE THE FIVE RULES ABOVE. That is most of the file.
//     "Click the heading", "click a chip", "click a label", "Preview creates
//     nothing", "Delete takes two clicks", "hidden when no DNS service is
//     found" — all unchecked. The rules were chosen because they are decidable,
//     not because they are the most important claims.
//   - NEGATED CLAIMS. The rules read a keyword as a promise that the feature
//     exists. A future entry phrased "this list cannot be exported" would match
//     the export rule and demand an export path. No current entry is phrased
//     that way (checked when this file was written); if you write one, this
//     comment is why the test went red.
//   - WHICH PANEL THE EVIDENCE BELONGS TO. Evidence is file-level, not
//     panel-level, because a tab file holds several panels and its JSX cannot be
//     split by panel without parsing it. So a claim on one panel can be
//     satisfied by an <input> or an onClick belonging to a different panel in
//     the same file. This test proves the file has the machinery, not that this
//     panel wired it up.
//
// There is deliberately no LLM grading here. A test that asks a model whether
// the copy is true gives a different answer on different days, which is the
// opposite of what a regression test is for. The claims above are checkable;
// everything else stays a human review job.
//
// The scan helpers below are this file's OWN COPY, duplicated from
// panelHelp.test.js on purpose: that file is the coverage guarantee and is meant
// to stay byte-identical, so nothing here may edit it to export a helper.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_HELP } from './panelHelp.js'

const SRC_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_DIRS = ['tabs', 'components']

// Comments are stripped so a comment can never stand in as evidence: several of
// these files discuss `onClick` and `<input>` in prose, and a doc comment
// describing a control that was removed is exactly the rot this test exists to
// find. Quotes are tracked as well as comments so a `//` inside a URL string is
// not read as the start of a comment. Newlines are preserved so reported line
// numbers stay true to the file on disk.
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

function scanFiles() {
  const files = []
  for (const dir of SCAN_DIRS) {
    const full = path.join(SRC_DIR, dir)
    for (const name of fs.readdirSync(full).sort()) {
      if (!name.endsWith('.jsx')) continue
      const file = path.join(full, name)
      files.push({
        rel: path.join('ui/src', dir, name),
        src: stripComments(fs.readFileSync(file, 'utf8')),
      })
    }
  }
  return files
}

// panelId -> the one file its literal is written in.
function panelHomes(files) {
  const home = new Map()
  for (const f of files) {
    const re = /panelId="([^"]*)"/g
    let m
    while ((m = re.exec(f.src)) !== null) if (!home.has(m[1])) home.set(m[1], f)
  }
  return home
}

const FILES = scanFiles()
const HOMES = panelHomes(FILES)

// ---------------------------------------------------------------------------
// The rules. `claim` is read against the entry's `what` + `look`; when it
// matches, `evidence` must appear in that panel's file.
//
// `claim` is written to fire on the READER'S ACTION, not on the bare noun. The
// first draft of the filter rule triggered on the word "filter" anywhere, and
// two entries proved that wrong: daily-dns-zone-issues says "open the DNS tab
// filtered to just these zones" (a sentence about a DIFFERENT tab) and
// infra-dfp-services says relays "forward your DNS queries to Infoblox for
// filtering" (a sentence about DNS, not about a control). Both would have
// demanded a filter box on a panel that correctly has none. A rule that has to
// be argued with is not a rule, so it now matches only the phrasings that
// describe something the reader does here.
// ---------------------------------------------------------------------------
const RULES = [
  {
    name: 'click a row/bar/square/slice',
    claim: /\b(?:click|tap)(?:s|ing)?\b[^.]{0,45}?\b(?:rows?|bars?|squares?|slices?)\b/i,
    evidence: /onClick|onRowClick/,
    needs: 'onClick or onRowClick handler',
  },
  {
    name: 'a box you type in',
    claim: /type in the box|search by\b|narrow (?:to|by)\b/i,
    evidence: /<input\b|<select\b/,
    needs: '<input> or <select> to type in or pick from',
  },
  {
    name: 'the list can be taken away as a file',
    claim: /\bexports?\b|spreadsheet|\bCSV\b/i,
    evidence: /exportCsv|new Blob|\bdownload\b/,
    needs: 'download path (exportCsv / new Blob / a.download)',
  },
  {
    name: 'the table can be re-sorted',
    claim: /\bsort(?:s|ed|ing)?\b/i,
    evidence: /onSort|sortable|sortRows|sortAccessor/,
    needs: 'sort handling (onSort / sortable / sortRows / sortAccessor)',
  },
  {
    name: 'pointing at a square reads it out',
    // Enter/Move only, and NOT onPointerDown. Measured: with `onPointerDown` in
    // the pattern this rule stayed green after the heatmap's readout handlers
    // were deleted, because Overview.jsx also holds `onPointerDownCapture` for
    // the tap-then-drill hook — an unrelated feature standing in as evidence.
    // "Point at" is answered by enter and move; a down is a press, not a point.
    claim: /point at a square/i,
    evidence: /onPointer(?:Enter|Move)\b/,
    needs: 'pointer handler (onPointerEnter / onPointerMove)',
  },
]

function helpText(entry) {
  return [entry.what, entry.look].filter(Boolean).join(' ')
}

// Which (rule, panel) pairs a run actually examined. Without this, a claim
// regex that stops matching anything — a copy edit, a tightened pattern —
// retires its rule silently and the file keeps passing on nothing at all.
function firings() {
  const hits = []
  for (const [id, entry] of Object.entries(PANEL_HELP)) {
    const text = helpText(entry)
    for (const rule of RULES) if (rule.claim.test(text)) hits.push({ id, rule, text })
  }
  return hits
}

const FIRED = firings()

test('scanner sanity: the files, the panel homes and the rules all found something', () => {
  assert.ok(FILES.length > 10, `expected to scan tabs and components, found ${FILES.length} files`)
  assert.ok(HOMES.size > 50, `expected to locate the app's panelIds, found ${HOMES.size}`)
  assert.ok(
    FIRED.length >= 15,
    `only ${FIRED.length} claim/panel pairs matched — a rule has stopped firing, so it is ` +
      'no longer checking anything. Fix the rule rather than deleting it.',
  )
})

test('every rule still matches at least one entry', () => {
  const dead = RULES.filter((r) => !FIRED.some((f) => f.rule === r)).map((r) => r.name)
  assert.deepEqual(
    dead,
    [],
    `${dead.length} rule(s) match no help text at all, so they silently check nothing: ` +
      `${dead.join('; ')}. Either the copy they were written for is gone (delete the rule) ` +
      'or the claim pattern drifted (fix it).',
  )
})

test('every panel a rule fires on has a file to look in', () => {
  const homeless = FIRED.filter((f) => !HOMES.has(f.id)).map((f) => f.id)
  assert.deepEqual(
    homeless,
    [],
    `no source file declares panelId="${homeless.join('", "')}" — panelHelp.test.js (b)/(c) ` +
      'should have caught this first; if it is green and this is red, the scanners disagree.',
  )
})

test('a help claim the code has to back up is backed up by the code', () => {
  const broken = []
  for (const { id, rule, text } of FIRED) {
    const file = HOMES.get(id)
    if (!file) continue
    if (rule.evidence.test(file.src)) continue
    broken.push(
      `${id} (${file.rel}) promises "${rule.name}" but the file has no ${rule.needs}\n` +
        `      help says: ${text}`,
    )
  }
  assert.deepEqual(
    broken,
    [],
    `${broken.length} help entr${broken.length === 1 ? 'y makes a promise' : 'ies make promises'} ` +
      'the code does not keep. Either the feature was removed and the sentence has to go, or ' +
      'the sentence was always aspirational:\n  ' +
      broken.join('\n  '),
  )
})
