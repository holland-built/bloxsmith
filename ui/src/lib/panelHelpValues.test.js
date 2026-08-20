// Run with: npm test  (node --test, no test framework dependency)
//
// ---------------------------------------------------------------------------
// PANEL_HELP — the NUMBERS, THRESHOLDS, WINDOWS and COLOURS.
//
// panelHelpTruth.test.js checks five BEHAVIOURAL claims (click, filter, export,
// sort, point-at) with a generic claim-regex matched against file-level
// evidence. Its own header names what it cannot catch, and the first four items
// on that list are values: caps, thresholds, colour meanings, time windows.
// This file is the sibling that closes those four. It is not an extension of
// that file and shares no rule engine with it, because the machine that suits a
// behavioural claim is the wrong machine for a value:
//
//   - A behavioural claim ("click a row") is answered by ANY onClick in the
//     panel's file. A value claim ("red past 92%") is answered by ONE line, and
//     it usually is not in the panel's own file — `utilStatus` lives in
//     components/ui.jsx, `ROW_CAP` in lib/changes.js, the `_limit` caps and the
//     cube `dateRange` windows in Go. A regex that follows imports could not
//     reach them, so the file is named EXPLICITLY on every row.
//   - A behavioural claim generalises across panels. A value claim does not:
//     each one binds one sentence to one line, so this is a declarative CLAIM
//     TABLE, not a set of cleverer regexes.
//
// SHAPE
//
//   { panel: 'subnet-heatmap',                    // a PANEL_HELP key
//     says:  /amber past 75% full, red past 92%/, // binds the row to the SENTENCE
//     file:  'ui/src/tabs/Overview.jsx',          // repo-root-relative
//     proofs: [{ re: /util >= 92 \? COLORS\.crit/, expect: 'red at util >= 92' }] }
//
// `says` is not decoration. If the copy is reworded or the number in it changes,
// `says` stops matching and this file goes RED rather than quietly checking a
// sentence nobody writes any more. That is the failure mode a claim table is
// most exposed to, so it is a test of its own.
//
// ---------------------------------------------------------------------------
// THE BARE-NUMBER TRAP, and the meta-lint that exists because of it.
//
// `150` is `DNSSEC_CAP` on Dns.jsx:447 — and it is also `rowCap={150}` on
// Infra.jsx:426 and a `height`/`h` prop in several other places. `200` is a
// `_limit` in SelfService.jsx and also `<Skeleton h={220}>`. `500` is `ROW_CAP`
// and also an HTTP status in a comment. A proof written as /150/ would pass on
// a file that had lost the cap entirely.
//
// So every proof anchors on a NAMED CONSTANT, an OPERATOR + VARIABLE, a CALL
// FORM or a KEY STRING — never on bare digits. `proof regexes never match on
// digits alone` enforces that mechanically: a proof's regex source must carry at
// least 4 literal non-digit characters once regex syntax is discounted, so
// /150/, /(((150)))/ and /[15][05]0/ can none of them be added.
//
// ---------------------------------------------------------------------------
// GO CLAIMS ARE CHECKED HERE, IN JS, AND HERE IS THE HONEST LIMIT OF THAT.
//
// Four help sentences are claims about what the server asks Infoblox for: the
// hub-security window and event cap (go/internal/server/data.go), the `_limit`
// caps on jobs and host-health (go/internal/dashboard/csp.go), and the cube
// `dateRange` windows (go/internal/dashboard/analytics.go, csp.go). They are
// verified as TEXT MATCHES on named literals — no Go semantics are needed, and
// a Go test would have to re-parse PANEL_HELP or hardcode the sentences, which
// is exactly the drift this file exists to stop.
//
// STATE PLAINLY WHAT THIS DOES NOT PROVE: matching `"dateRange": "last 7 days"`
// in analytics.go proves that literal is still in that function. It does NOT
// prove the panel named on the row calls that endpoint. Nothing here traces a
// fetch from a React component through the Go router to a cube query. That
// binding — panel X is fed by function Y — is ASSERTED BY THE AUTHOR OF THE
// ROW, per row, and is the weakest link in every Go claim below. If a panel is
// rewired to a different feed, this test stays green and lies.
//
// `stripComments` is applied to Go as well as to JS/JSX, so a comment can never
// stand in as evidence — which matters immediately: data.go:76 is the comment
// `// ... the route uses the defaults (1h/50).` sitting directly above the call
// the row checks. CAVEAT: `stripComments` is a JS scanner. It treats a Go
// backtick raw string as a JS template literal, which happens to work, EXCEPT
// that a backslash inside a Go raw string is literal where JS would read it as
// an escape. No Go file read here contains one today; if one appears, this
// scanner may drop the character after it. Go rune literals ('x') are read as
// single-quoted strings and survive intact.
//
// ---------------------------------------------------------------------------
// THE COLOUR DICTIONARY, and why half of it is a human's word.
//
// The copy says "red", "amber", "blue", "green", "grey", "pink". The code says
// COLORS.crit, COLORS.warn, COLORS.accent, COLORS.ok, COLORS.other,
// COLORS.sevHigh. This file pairs them with a HAND-WRITTEN dictionary:
//
//   crit    -> red     --color-crit       ui/src/index.css:40 (dark) :91 (light)
//   warn    -> amber   --color-warn       ui/src/index.css:39 (dark) :90 (light)
//   accent  -> blue    --color-accent     ui/src/index.css:36 (dark) :87 (light)
//   ok      -> green   --color-ok         ui/src/index.css:38 (dark) :89 (light)
//   other   -> grey    --color-other      ui/src/index.css:41 (dark) :92 (light)
//   sevHigh -> pink    --color-sev-high   ui/src/index.css:42 (dark) :93 (light)
//
// (Note the token is `sevHigh` in JS and `--color-sev-high` in CSS. They are
// not mechanically derivable from one another, so the mapping is written out.)
//
// `colour tokens all still exist in index.css` asserts each of those custom
// properties is still DEFINED, in both themes, with a hex value. What no test
// here does is look at the hex and decide it is "red". THAT IS A DATED HUMAN
// CHECK: the six values above were read by eye on 2026-08-07, and if
// --color-warn is changed to a shade of teal tomorrow every colour row below
// stays green while every colour sentence in the copy becomes false. The
// machine checks WHICH TOKEN a series is painted with; a person checks what the
// token looks like.
//
// ---------------------------------------------------------------------------
// EXCLUDED — claims deliberately not checked, kept visible.
//
// Some value-ish sentences are genuinely undecidable: "the fullest few hundred"
// against `CAP = 288` is a prose approximation no regex can bind, and "happens
// on the server, not this page" is a claim about a request nobody here traces.
// They are listed in EXCLUDED with a reason instead of being silently absent,
// and `every excluded phrase is still in the copy` fails when one is reworded —
// so an exclusion goes stale loudly rather than rotting into a lie about what
// this file covers.
//
// ---------------------------------------------------------------------------
// COVERAGE — telling "unverified" apart from "makes no claim".
//
// Before this section, a panel absent from CLAIMS and absent from EXCLUDED meant
// two different things at once: either nobody had checked its numbers, or it
// states no numbers to check. Silence said both, so silence said nothing — the
// same failure this file exists to kill one level up.
//
// `classifyPanels()` puts every panel in PANEL_HELP into exactly one bucket, and
// the third one is COMPUTED, never listed:
//
//   verified                  every fact-shaped sentence is bound by a CLAIMS row
//   excluded-with-reason      at least one is excused by an EXCLUDED row, rest bound
//   makes-no-factual-claim    the detector fired on nothing
//   (unclassified)            a fact-shaped sentence is neither — this is the RED
//
// A hand-kept "these panels make no claim" list would be a lie the day somebody
// adds a number to one of them. So there is no list: the bucket is the negative
// result of the FACT lexicon, recomputed from the copy on every run.
//
// WHAT THE DETECTOR CANNOT SEE — read this before trusting the bucket counts.
//
//   - It is LEXICON-BOUNDED. A claim with no digit, colour, threshold word,
//     window or count word in it is invisible: "the busiest come first",
//     "Hidden when no DHCP service is detected", "sorted low to high", "worst
//     first". Those are real factual claims about real code and they land in
//     makes-no-factual-claim. That bucket means "no NUMBER, COLOUR or WINDOW was
//     stated", not "this sentence promises nothing".
//   - "one" and "a single" are deliberately NOT count words. Including them
//     flags a third of the copy on phrasing ("One row per device", "one line per
//     thing it creates") rather than on arithmetic. The cost is that per-item
//     cardinality claims are invisible too.
//   - It inherits this file's weakest link unchanged: a proof matches a literal
//     in a named file, which never proves the panel on the row runs that code.
//     A panel can be fully "verified" here and still be fed by something else.
//   - Colour word to hex is still the dated human check described above. The
//     detector only notices that the word "red" was used.
//
// OVER-FLAGGING IS THE CORRECT FAILURE MODE. A sentence the lexicon flags
// wrongly cannot be ignored — it reds the enforcement test until somebody either
// binds it or writes it into EXCLUDED with a reason. A sentence it misses goes
// silently green. So the lexicon is tuned loose on purpose: "greyed out", "the
// red button", "two clicks" are all fact-shaped enough to answer for.
//
// Sentence splitting is `(?<=[.!?])\s+`, validated against the real copy on
// 2026-08-07: across all 158 `what`/`look` strings there are zero decimals, zero
// abbreviations ("e.g.", "etc."), zero ellipses and zero terminators followed by
// a lowercase letter, so no sentence is split mid-claim. `what` and `look` are
// split SEPARATELY, so no claim may straddle the two.
//
// ---------------------------------------------------------------------------
// There is deliberately no LLM grading here, for the same reason
// panelHelpTruth.test.js gives: a model asked whether the copy is true answers
// differently on different days, which is the opposite of what a regression
// test is for. Everything below is a literal match or it is in EXCLUDED.
//
// `stripComments` is this file's OWN COPY, duplicated from panelHelp.test.js on
// purpose: that file is the coverage guarantee, exports nothing, and is meant to
// stay byte-identical, so nothing here may edit it to export a helper.
// `scanFiles` is NOT duplicated — this file addresses source files by name
// rather than sweeping a directory, which is the whole point of the `file`
// column.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_HELP } from './panelHelp.js'

// .../ui/src/lib/panelHelpValues.test.js -> .../ui/src/lib -> src -> ui -> repo
const REPO_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))))

// Duplicated from panelHelp.test.js. See the header. Comments are stripped so a
// comment can never stand in as evidence; quotes are tracked so a `//` inside a
// URL string is not read as the start of a comment; newlines are preserved so
// reported line numbers stay true to the file on disk.
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

const SOURCES = new Map()
function sourceOf(rel) {
  if (!SOURCES.has(rel)) {
    const full = path.join(REPO_ROOT, rel)
    SOURCES.set(rel, stripComments(fs.readFileSync(full, 'utf8')))
  }
  return SOURCES.get(rel)
}

function helpText(entry) {
  return [entry.what, entry.look].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// The colour dictionary. Token as written in JS -> the word the copy uses ->
// the custom property that defines it. See the header for the honest limit.
// ---------------------------------------------------------------------------
const COLOUR_TOKENS = {
  crit: { word: 'red', cssVar: '--color-crit' },
  warn: { word: 'amber', cssVar: '--color-warn' },
  accent: { word: 'blue', cssVar: '--color-accent' },
  ok: { word: 'green', cssVar: '--color-ok' },
  other: { word: 'grey', cssVar: '--color-other' },
  sevHigh: { word: 'pink', cssVar: '--color-sev-high' },
}

const UI = 'ui/src/components/ui.jsx'
const OVERVIEW = 'ui/src/tabs/Overview.jsx'
const NETWORK = 'ui/src/tabs/Network.jsx'
const DAILY = 'ui/src/tabs/Daily.jsx'
const DNS = 'ui/src/tabs/Dns.jsx'
const SECURITY = 'ui/src/tabs/Security.jsx'
const INFRA = 'ui/src/tabs/Infra.jsx'
const ASSETS = 'ui/src/tabs/Assets.jsx'
const INCIDENTS = 'ui/src/tabs/Incidents.jsx'
const AUDIT = 'ui/src/tabs/Audit.jsx'
// Chart bodies live outside the tabs since 2026-08-10, so recharts can be
// loaded lazily. A sentence about what a chart LOOKS like is now proven partly
// at the call site (which colour) and partly here (which order, which cap).
const CHART_STACKED = 'ui/src/charts/StackedDayBars.jsx'
const CHANGES_TAB = 'ui/src/tabs/Changes.jsx'
const PROVISION = 'ui/src/tabs/Provision.jsx'
const SELFSERVICE = 'ui/src/tabs/SelfService.jsx'
const DRIFT = 'ui/src/tabs/Drift.jsx'
const EDITOR = 'ui/src/tabs/Editor.jsx'
const CHANGES_LIB = 'ui/src/lib/changes.js'
const GO_DATA = 'go/internal/server/data.go'
const GO_PROVISION = 'go/internal/server/provision.go'
const GO_CSP = 'go/internal/dashboard/csp.go'
const GO_ANALYTICS = 'go/internal/dashboard/analytics.go'
const GO_HOSTS = 'go/internal/dashboard/hosts.go'

// `utilStatus` is one function shared by three panels whose copy repeats the
// same two thresholds. Written once so a flip there reds all three rows.
const UTIL_STATUS_PROOFS = [
  {
    re: /if \(util >= 92\) return \{ label: 'Critical', color: 'var\(--color-crit\)'/,
    expect: "utilStatus() grades util >= 92 Critical / COLORS.crit (red)",
  },
  {
    re: /if \(util >= 75\) return \{ label: 'Warning', color: 'var\(--color-warn\)'/,
    expect: "utilStatus() grades util >= 75 Warning / COLORS.warn (amber)",
  },
]

// `PreviewApply` is one component behind every Provision and Editor flow, so
// the "appears only after a preview" and "red when it destroys something"
// claims are the same two lines for all of them. Written once so a flip there
// reds every row that leans on it.
const APPLY_BUTTON_PROOFS = [
  {
    re: /const showApply = status === 'previewed' && !stale && !busy/,
    expect: 'the Apply button exists only after a preview, and only while that preview has not gone stale',
  },
  {
    re: /style=\{\{ background: destructive \? COLORS\.crit : COLORS\.ok, color: '#fff' \}\}/,
    expect: 'Apply is COLORS.crit (red) on a panel that declares itself destructive, COLORS.ok (green) otherwise',
  },
]

// LogView is shared by all six provision logs. Same regex as the two log rows
// already in the colours section; repeated rather than hoisted because those
// rows name a different sentence and deleting one must not touch the other.
const LOG_ERROR_RED_PROOF = {
  re: /color: l\.error \? 'var\(--color-crit\)' : l\.done \? 'var\(--color-ok\)'/,
  expect: 'a log line is crit (red) when that step reported an error',
}

const SEV_COLOUR_PROOFS = [
  { re: /critical: COLORS\.crit/, expect: 'critical painted COLORS.crit (red)' },
  { re: /high: COLORS\.sevHigh/, expect: 'high painted COLORS.sevHigh (pink)' },
  { re: /medium: COLORS\.warn/, expect: 'medium painted COLORS.warn (amber)' },
  { re: /low: COLORS\.accent/, expect: 'low painted COLORS.accent (blue)' },
]

// ---------------------------------------------------------------------------
// THE CLAIM TABLE.
// ---------------------------------------------------------------------------
const CLAIMS = [
  // ---- caps and counts ----
  {
    panel: 'top-consumers',
    says: /The twelve subnets handing out the most addresses/,
    file: OVERVIEW,
    proofs: [{ re: /\.sort\(\(a, b\) => num\(b\.used\) - num\(a\.used\)\)\.slice\(0, 12\)/, expect: 'top 12 by addresses used' }],
  },
  {
    panel: 'network-ipam-spaces',
    says: /The twelve address spaces handing out the most addresses/,
    file: NETWORK,
    proofs: [
      { re: /const IPAM_SPACES_CAP = 12/, expect: 'IPAM_SPACES_CAP = 12' },
      { re: /\.sort\(\(a, b\) => b\.used - a\.used\)\n\s*const rows = eligible\.slice\(0, IPAM_SPACES_CAP\)/, expect: 'top 12 spaces by addresses used' },
    ],
  },
  {
    panel: 'network-exhaustion',
    says: /It draws 150 at most and says how many matched/,
    file: NETWORK,
    proofs: [
      { re: /const EXHAUSTION_CAP = 150/, expect: 'EXHAUSTION_CAP = 150' },
      { re: /rowCap=\{EXHAUSTION_CAP\}/, expect: 'the cap is applied by DataTable, which is what prints the "showing N of M" line' },
    ],
  },
  {
    panel: 'dns-dnssec-health',
    says: /lists only the unsigned zones, 150 at most/,
    file: DNS,
    proofs: [
      { re: /const DNSSEC_CAP = 150/, expect: 'DNSSEC_CAP = 150' },
      { re: /const shown = unsigned\.slice\(0, DNSSEC_CAP\)/, expect: 'the unsigned list is cut at DNSSEC_CAP' },
      { re: /rowCap=\{DNSSEC_CAP\}/, expect: 'the table is capped at DNSSEC_CAP too' },
    ],
  },
  {
    panel: 'assets-list',
    says: /One row per device, 50 to a page\./,
    file: ASSETS,
    proofs: [
      { re: /const PAGE_SIZE = 50/, expect: 'PAGE_SIZE = 50' },
      { re: /rowCap=\{PAGE_SIZE\}/, expect: 'the table draws at most PAGE_SIZE rows' },
    ],
  },
  {
    panel: 'security-exposed-surface',
    says: /Only the first 25 of each are drawn/,
    file: SECURITY,
    proofs: [
      { re: /const SAMPLE = 25/, expect: 'SAMPLE = 25' },
      { re: /rowCap=\{SAMPLE\}/, expect: 'both tables capped at SAMPLE' },
    ],
  },
  {
    panel: 'security-ctem-assets',
    says: /six per group at most/,
    file: SECURITY,
    proofs: [{ re: /function summarizeArr\(arr, n = 6\)/, expect: 'the per-group sample defaults to 6' }],
  },
  {
    panel: 'drift-result',
    says: /Six per group are shown, worst group first/,
    file: DRIFT,
    proofs: [{ re: /const shown = open \? items : items\.slice\(0, 6\)/, expect: 'a collapsed group shows 6 items' }],
  },
  {
    panel: 'infra-onprem-hosts',
    says: /Only the first five are listed\./,
    file: INFRA,
    proofs: [{ re: /panelId="infra-onprem-hosts"[\s\S]{0,240}?limit=\{5\}/, expect: 'the on-prem FeedCard is given limit={5}' }],
  },
  {
    panel: 'daily-top-capacity-risks',
    says: /anything under 16 addresses, are left out on purpose/,
    file: DAILY,
    proofs: [
      {
        re: /\.filter\(\(s\) => \(s\.addr \|\| s\.cidr\) && \(Number\(s\.cidr\) \|\| 0\) <= 28\)/,
        expect: 'prefixes longer than /28 (fewer than 16 addresses) are filtered out',
      },
    ],
  },
  {
    panel: 'selfservice-manage-records',
    says: /200 entries at most/,
    file: SELFSERVICE,
    proofs: [{ re: /\/api\/dns\/records\?zone=\$\{encodeURIComponent\(zoneId\)\}&_limit=200/, expect: 'the records request asks for _limit=200' }],
  },
  {
    panel: 'changes-changed-objects',
    says: /Portal actions from the last 24 hours, 500 at most/,
    file: CHANGES_LIB,
    proofs: [{ re: /export const ROW_CAP = 500/, expect: 'ROW_CAP = 500' }],
  },
  {
    panel: 'changes-notability',
    says: /when the 500-event limit was reached/,
    file: CHANGES_LIB,
    proofs: [
      { re: /export const ROW_CAP = 500/, expect: 'ROW_CAP = 500' },
      { re: /cap: ROW_CAP,/, expect: 'the notability summary reports ROW_CAP as its cap' },
    ],
  },
  {
    panel: 'changes-notability',
    says: /what happened between 20:00 and 08:00/,
    file: CHANGES_LIB,
    proofs: [
      { re: /export const OOH_START_HOUR = 20/, expect: 'OOH_START_HOUR = 20' },
      { re: /export const OOH_END_HOUR = 8/, expect: 'OOH_END_HOUR = 8' },
      { re: /return hour >= OOH_START_HOUR \|\| hour < OOH_END_HOUR/, expect: 'out-of-hours is at-or-after start, or before end' },
    ],
  },

  // ---- thresholds ----
  {
    panel: 'subnet-heatmap',
    says: /blue is fine, amber past 75% full, red past 92%/,
    file: OVERVIEW,
    proofs: [
      { re: /const color = util >= 92 \? COLORS\.crit/, expect: 'red (COLORS.crit) at util >= 92' },
      { re: /: util >= 75 \? COLORS\.warn/, expect: 'amber (COLORS.warn) at util >= 75' },
      { re: /util >= 75 \? COLORS\.warn : COLORS\.accent/, expect: 'blue (COLORS.accent) below 75' },
    ],
  },
  {
    panel: 'license-inventory',
    says: /Time Left turns amber under 90 days and red under 30/,
    file: OVERVIEW,
    proofs: [
      { re: /r\._days < 30 \? \{ color: COLORS\.crit \}/, expect: 'red (COLORS.crit) under 30 days' },
      { re: /r\._days < 90 \? \{ color: COLORS\.warn \}/, expect: 'amber (COLORS.warn) under 90 days' },
    ],
  },
  {
    panel: 'network-utilization-distribution',
    says: /Blue is under 70% full, amber 70–85%, red past 85%/,
    file: NETWORK,
    proofs: [
      { re: /label: '<70%', test: \(u\) => u < 70, color: COLORS\.accent/, expect: 'blue band is u < 70' },
      { re: /label: '70–85%', test: \(u\) => u >= 70 && u <= 85, color: COLORS\.warn/, expect: 'amber band is 70 <= u <= 85' },
      { re: /label: '>85%', test: \(u\) => u > 85, color: COLORS\.crit/, expect: 'red band is u > 85' },
    ],
  },
  {
    panel: 'network-ipam-spaces',
    says: /amber past 75% full, red past 92%/,
    file: UI,
    proofs: UTIL_STATUS_PROOFS,
  },
  {
    panel: 'network-exhaustion',
    says: /Amber past 75% full, red past 92%/,
    file: UI,
    proofs: UTIL_STATUS_PROOFS,
  },
  {
    panel: 'daily-top-capacity-risks',
    says: /this ranks by addresses left, not by fullness/,
    file: DAILY,
    proofs: [{ re: /\.sort\(\(a, b\) => a\.free - b\.free\)/, expect: 'rows are ordered by free addresses ascending, not by util' }],
  },
  {
    panel: 'kpi-stack',
    says: /how many of those are at least 90% full/,
    file: OVERVIEW,
    proofs: [
      { re: /const rowCritSubnets = measured\.filter\(\(s\) => num\(s\.util\) >= 90\)/, expect: 'the row-derived count is util >= 90' },
      { re: /hash: 'network\?minUtil=90'/, expect: 'the tile links to the same 90 threshold' },
    ],
  },
  {
    panel: 'daily-open-issues',
    says: /subnets 85% full or more \(tiny networks under 16 addresses left out\)/,
    file: DAILY,
    proofs: [
      { re: /\(Number\(s\.util\) \|\| 0\) >= 85\)\.length/, expect: 'the count is util >= 85, inclusive like the drill-down' },
      {
        re: /\.filter\(\(s\) => \(Number\(s\.cidr\) \|\| 0\) <= 28 &&/,
        expect: 'prefixes longer than /28 (fewer than 16 addresses) are filtered out before the util test',
      },
      { re: /hash: 'network\?minUtil=85'/, expect: 'the row links to the same 85 threshold' },
    ],
  },
  {
    panel: 'network-exhaustion',
    says: /A subnet nobody measured gets a grey Unknown badge/,
    file: NETWORK,
    proofs: [{ re: /font-medium bg-line text-muted">Unknown<\/span>/, expect: 'an unmeasured subnet gets a neutral Unknown badge, not a graded one' }],
  },

  // ---- time windows (Go) ----
  {
    // Was: "The count by the title is 50 events at most", proved by the literal
    // 50 in data.go. That sentence stopped being the whole truth on 2026-08-20
    // (issue #157): the 50 was never the point, the fact that everything on the
    // panel was counted FROM those 50 was. The claim is now about the disclosure
    // rather than the number, so it binds to the code that renders it.
    panel: 'daily-security-today',
    says: /the title says so and a line under the figures says the figures were counted from that sample/,
    file: DAILY,
    proofs: [
      { re: /const scopeNote = sampleScopeNote\(sec\.data, 'events'\)/, expect: 'the panel computes a scope note from the payload' },
      { re: /\{secDead \? '— events' : sampleCountLabel\(sec\.data, 'events'\)\}/, expect: 'the title count is the sample-aware label, not rows.length' },
      { re: /\{scopeNote && <div className="text-\[11px\] text-dim mt-2">\{scopeNote\}<\/div>\}/, expect: 'and the note is actually rendered under the figures' },
    ],
  },
  {
    panel: 'daily-security-today',
    says: /A dash means the feed could not be read/,
    file: DAILY,
    proofs: [{ re: /\{secDead \? '— events'/, expect: 'a dead feed renders a dash rather than a count' }],
  },
  {
    panel: 'daily-security-today',
    says: /Threat events seen in the last hour/,
    file: GO_DATA,
    proofs: [{ re: /FetchHubSecurity\(3600, 50\)/, expect: '/api/hub/security asks for a 3600-second window' }],
  },
  {
    panel: 'security-threat-events',
    says: /They and the bars count the events fetched; a line underneath says when that is only part of the hour/,
    file: SECURITY,
    proofs: [
      { re: /const scopeNote = sampleScopeNote\(hub\.data, 'events'\)/, expect: 'the severity panel computes a scope note' },
      { re: /right=\{unavailable \? null : <span className="text-\[11px\] text-muted">\{sampleCountLabel\(hub\.data, 'events'\)\}<\/span>\}/, expect: 'its heading count is sample-aware' },
    ],
  },
  {
    // The tile that used to read "Total Events" over a page size.
    panel: 'security-response-summary',
    says: /The last tile says Total Events only when the true count is known; otherwise it says Events Shown/,
    file: SECURITY,
    proofs: [
      { re: /const totalCell = totalEventsTile\(d, 'Total Events', 'Events Shown'\)/, expect: 'the tile label is chosen by totalEventsTile, not hardcoded' },
      { re: /\{ label: totalCell\.label, value: totalCell\.value, color: COLORS\.purple \}/, expect: 'and both its label and value come from that decision' },
    ],
  },
  {
    panel: 'security-threat-events',
    says: /an outside threat feed flagged in the last hour/,
    file: GO_DATA,
    proofs: [{ re: /FetchHubSecurity\(3600, 50\)/, expect: '/api/hub/security asks for a 3600-second window' }],
  },
  {
    panel: 'infra-jobs',
    says: /50 tasks at most\./,
    file: GO_CSP,
    proofs: [{ re: /func \(s \*Service\) CSPJobs\(\)[\s\S]{0,200}?"_limit": "50"/, expect: 'CSPJobs asks for _limit 50' }],
  },
  {
    // The limit moved out of csp.go when four readers were made to share one
    // (#85), so the proof follows it to the constant rather than to a literal
    // that no longer exists at the call site.
    panel: 'infra-host-health',
    says: /at most 1,000/,
    file: GO_HOSTS,
    proofs: [{ re: /hostsListLimit = 1000/, expect: 'hostsListLimit, the limit every host reader sends, is 1000' }],
  },
  {
    panel: 'dns-query-volume-7d',
    says: /on each of the last seven days/,
    file: GO_ANALYTICS,
    proofs: [
      {
        re: /"NstarDnsActivity\.timestamp",[\s\S]{0,40}?"dateRange": "last 7 days", "granularity": "day"/,
        expect: 'the volume cube query asks for a 7-day range at day granularity',
      },
    ],
  },
  {
    panel: 'security-threat-feed-activity',
    says: /matched the threat feed each day/,
    file: GO_CSP,
    proofs: [
      {
        re: /"PortunusAggThreat_ch\.timestamp",[\s\S]{0,40}?"dateRange": "last 7 days", "granularity": "day"/,
        expect: 'CSPThreats asks for a 7-day range at day granularity',
      },
    ],
  },
  {
    panel: 'dns-hero',
    says: /hour by hour across the last 24 hours/,
    file: GO_CSP,
    proofs: [
      {
        re: /"HostMetrics\.timestamp",[\s\S]{0,40}?"dateRange": "last 24 hours", "granularity": "hour"/,
        expect: 'CSPDNSQps asks for a 24-hour range at hour granularity',
      },
    ],
  },
  {
    panel: 'dns-query-rate',
    says: /hour by hour, across the last 24 hours/,
    file: GO_CSP,
    proofs: [
      {
        re: /"HostMetrics\.timestamp",[\s\S]{0,40}?"dateRange": "last 24 hours", "granularity": "hour"/,
        expect: 'CSPDNSQps asks for a 24-hour range at hour granularity',
      },
    ],
  },

  // ---- colours ----
  {
    panel: 'audit-activity-summary',
    says: /green created, blue updated, red deleted/,
    file: AUDIT,
    proofs: [
      { re: /CREATE: COLORS\.ok/, expect: 'CREATE painted COLORS.ok (green)' },
      { re: /UPDATE: COLORS\.accent/, expect: 'UPDATE painted COLORS.accent (blue)' },
      { re: /DELETE: COLORS\.crit/, expect: 'DELETE painted COLORS.crit (red)' },
    ],
  },
  {
    panel: 'security-threat-events',
    says: /red for critical, pink for high, amber for medium, blue for low/,
    file: SECURITY,
    proofs: SEV_COLOUR_PROOFS,
  },
  {
    panel: 'security-ctem-exposure',
    says: /Severity is red for critical, pink for high, amber for medium, blue for low/,
    file: SECURITY,
    proofs: SEV_COLOUR_PROOFS,
  },
  {
    panel: 'security-threat-feed-activity',
    says: /the red part was blocked, the blue cap on top was let through/,
    file: SECURITY,
    proofs: [
      // RE-POINTED 2026-08-10, and the copy is unchanged because the colours
      // are unchanged. The chart body moved to ui/src/charts/StackedDayBars.jsx
      // so recharts could be loaded lazily; the two series now take their fill
      // from props, and it is Security.jsx that still decides WHICH colour each
      // one gets. That decision is what this sentence is about, so this is
      // where the proof belongs. Which series sits on TOP — the other half of
      // "the blue cap on top" — is proven in the entry immediately below, in
      // the module that now owns the stacking.
      { re: /blockedColor=\{COLORS\.crit\}/, expect: 'the blocked series is COLORS.crit (red)' },
      { re: /allowedColor=\{COLORS\.accent\}/, expect: 'the allowed series is COLORS.accent (blue)' },
    ],
  },
  {
    panel: 'security-threat-feed-activity',
    says: /the red part was blocked, the blue cap on top was let through/,
    file: CHART_STACKED,
    proofs: [
      { re: /dataKey="blocked" stackId="day" fill=\{blockedColor\}/, expect: 'blocked is the lower half of the stack' },
      { re: /dataKey="allowed" stackId="day" radius=\{\[3, 3, 0, 0\]\} fill=\{allowedColor\}/, expect: 'allowed sits on top and carries the rounded cap' },
    ],
  },
  {
    panel: 'security-response-summary',
    says: /The red figure counts critical events nobody has ticked off yet/,
    file: SECURITY,
    proofs: [{ re: /label: 'Unacked Critical', value: unackedCrit, color: COLORS\.crit/, expect: 'the unacked-critical tile is COLORS.crit (red)' }],
  },
  {
    panel: 'security-lookalike-domains',
    says: /A red "yes" means it was judged suspicious/,
    file: SECURITY,
    proofs: [{ re: /color: r\.suspicious \? COLORS\.crit : COLORS\.other/, expect: 'suspicious rows are COLORS.crit (red), the rest COLORS.other (grey)' }],
  },
  {
    panel: 'changes-changed-objects',
    says: /red for a deletion or a failure, amber for out of hours, grey for routine/,
    file: CHANGES_TAB,
    proofs: [
      {
        re: /const rail = del \|\| failed \? COLORS\.crit : ooh \? COLORS\.warn : COLORS\.other/,
        expect: 'the row rail is crit (red) for delete/fail, warn (amber) out of hours, other (grey) otherwise',
      },
    ],
  },
  {
    panel: 'daily-open-issues',
    says: /A row reading "unavailable" in red means that one feed failed/,
    file: DAILY,
    proofs: [{ re: /style=\{\{ color: COLORS\.crit \}\}>unavailable</, expect: 'the "unavailable" row text is COLORS.crit (red)' }],
  },
  {
    panel: 'dns-zones',
    says: /Rows with a problem are tinted red/,
    file: DNS,
    proofs: [{ re: /rowStyle=\{\(r\) => \(r\._hasIssues \? \{ background: 'rgba\(238,68,68,0\.06\)' \}/, expect: 'rows with issues get a red wash' }],
  },
  {
    panel: 'audit-csp-portal',
    says: /Failed results are red, successful ones green/,
    file: AUDIT,
    proofs: [{ re: /\/fail\/i\.test\(v \|\| ''\) \? COLORS\.crit : COLORS\.ok/, expect: 'a failing result is COLORS.crit (red), anything else COLORS.ok (green)' }],
  },
  {
    panel: 'provision-subnet-log',
    says: /Grey is progress, red is a failure, green is the finish/,
    file: PROVISION,
    proofs: [
      {
        re: /color: l\.error \? 'var\(--color-crit\)' : l\.done \? 'var\(--color-ok\)' : 'var\(--color-muted\)'/,
        expect: 'a log line is crit (red) on error, ok (green) when done, muted (grey) while running',
      },
    ],
  },
  {
    panel: 'provision-site-log',
    says: /Red is a failure, green is the finish/,
    file: PROVISION,
    proofs: [
      {
        re: /color: l\.error \? 'var\(--color-crit\)' : l\.done \? 'var\(--color-ok\)'/,
        expect: 'a log line is crit (red) on error and ok (green) when done',
      },
    ],
  },
  {
    panel: 'provision-seed-log',
    says: /Red is a failure, green is the finish/,
    file: PROVISION,
    proofs: [
      {
        re: /color: l\.error \? 'var\(--color-crit\)' : l\.done \? 'var\(--color-ok\)'/,
        expect: 'a log line is crit (red) on error and ok (green) when done',
      },
    ],
  },
  {
    panel: 'provision-seed-progress',
    says: /the count turns red as soon as there is one/,
    file: PROVISION,
    proofs: [{ re: /color: failed \? 'var\(--color-crit\)' : 'var\(--color-muted\)'/, expect: 'the done/total line turns crit (red) once anything failed' }],
  },
  {
    panel: 'provision-site-teardown-result',
    says: /an amber line at the bottom says nothing was actually deleted/,
    file: PROVISION,
    proofs: [{ re: /color: COLORS\.warn \}\}>Preview — nothing was deleted\./, expect: 'the preview line is COLORS.warn (amber)' }],
  },
  {
    panel: 'drift-result',
    says: /A red count is how many differences were found, green means none/,
    file: DRIFT,
    proofs: [
      {
        re: /result\.drifted[\s\S]{0,80}?'var\(--pill-crit-bg\)'[\s\S]{0,80}?'var\(--pill-ok-bg\)'/,
        expect: 'a drifted result gets the crit pill (red), an in-sync one the ok pill (green)',
      },
    ],
  },
  {
    panel: 'incidents-severity',
    says: /across the four seriousness levels/,
    file: INCIDENTS,
    proofs: [
      { re: /label: 'Critical', value: counts\.critical, color: COLORS\.crit/, expect: 'Critical is COLORS.crit (red)' },
      { re: /label: 'High', value: counts\.high, color: COLORS\.sevHigh/, expect: 'High is COLORS.sevHigh (pink)' },
      { re: /label: 'Medium', value: counts\.medium, color: COLORS\.warn/, expect: 'Medium is COLORS.warn (amber)' },
      { re: /label: 'Low', value: counts\.low, color: COLORS\.accent/, expect: 'Low is COLORS.accent (blue)' },
    ],
  },
  {
    panel: 'incidents-categories',
    says: /the colour of the worst one in that group/,
    file: INCIDENTS,
    proofs: [
      { re: /return \{ key: 'critical', label: 'Critical', color: COLORS\.crit \}/, expect: 'critical maps to COLORS.crit (red)' },
      { re: /return \{ key: 'high', label: 'High', color: COLORS\.sevHigh \}/, expect: 'high maps to COLORS.sevHigh (pink)' },
      { re: /return \{ key: 'medium', label: 'Medium', color: COLORS\.warn \}/, expect: 'medium maps to COLORS.warn (amber)' },
      { re: /return \{ key: 'low', label: 'Low', color: COLORS\.accent \}/, expect: 'low maps to COLORS.accent (blue)' },
      { re: /return \{ key: 'unknown', label: v \|\| 'Unknown', color: COLORS\.other \}/, expect: 'anything else maps to COLORS.other (grey)' },
    ],
  },
  {
    panel: 'incidents-action-volume',
    says: /The three figures underneath split those items by how urgent they are/,
    file: INCIDENTS,
    proofs: [
      { re: /color: COLORS\.sevHigh \}\}>High \{byPriority\.high\}/, expect: 'the High figure is COLORS.sevHigh (pink)' },
      { re: /color: COLORS\.warn \}\}>Medium \{byPriority\.medium\}/, expect: 'the Medium figure is COLORS.warn (amber)' },
      { re: /color: COLORS\.accent \}\}>Low \{byPriority\.low\}/, expect: 'the Low figure is COLORS.accent (blue)' },
    ],
  },
  {
    panel: 'daily-security-today',
    says: /counted by how serious each one was, and how many were stopped/,
    file: DAILY,
    proofs: [
      { re: /label: 'critical', value: Number\(counts\.critical\) \|\| 0, color: COLORS\.crit/, expect: 'critical is COLORS.crit (red)' },
      { re: /label: 'blocked', value: Number\(sec\.data\?\.blocked\) \|\| 0, color: COLORS\.ok/, expect: 'blocked is COLORS.ok (green)' },
    ],
  },

  // ---- from the 2026-08-07 coverage triage ----
  // Every row below answers a sentence the FACT lexicon flagged and nothing was
  // checking. They are grouped by where they came from, not by kind, so the
  // next person can see what the detector actually bought.
  {
    panel: 'kpi-stack',
    says: /Click any of the three to open the matching list\./,
    file: OVERVIEW,
    proofs: [
      {
        re: /const cells = \[\n\s*\{ label: 'Active Leases',[\s\S]{0,400}?label: 'Subnets'[\s\S]{0,400}?label: 'Subnets ≥90%'[\s\S]{0,400}?\n\s*\]\n/,
        expect: 'the KpiStack cells array holds three entries — Active Leases, Subnets, Subnets ≥90% — and closes after the third',
      },
      { re: /onClick=\{\(\) => \{ location\.hash = c\.hash \}\}/, expect: 'each of those cells navigates to its own hash when clicked' },
    ],
  },
  {
    panel: 'daily-hosts-attention',
    says: /The count in the header shows a dash, not 0, when the machines could not be read\./,
    file: DAILY,
    proofs: [
      { re: /const feedDead = hostsStatus === 'error' && hosts\.length === 0/, expect: 'a dead hosts feed with nothing loaded is what "could not be read" means here' },
      { re: /\{feedDead \? '—' : rows\.length\} shown/, expect: 'the header count is an em dash, not 0, when the feed is dead' },
    ],
  },
  {
    panel: 'daily-dns-zone-issues',
    says: /DNS zones with at least one configuration problem recorded against them/,
    file: DAILY,
    proofs: [
      {
        re: /\.filter\(\(z\) => Array\.isArray\(z\.issues\) && z\.issues\.length > 0\)/,
        expect: 'only zones with a non-empty issues list are kept — "at least one"',
      },
    ],
  },
  {
    panel: 'daily-dns-zone-issues',
    says: /The red number is how many problems that zone has\./,
    file: DAILY,
    proofs: [
      { re: /\.map\(\(z\) => \(\{ \.\.\.z, count: z\.issues\.length/, expect: 'the number in that column is the length of the zone\'s issues list' },
      {
        re: /background: 'var\(--pill-crit-bg\)', color: 'var\(--pill-crit-fg\)'/,
        expect: 'that count is drawn in the crit (red) pill',
      },
    ],
  },
  {
    panel: 'security-lookalike-domains',
    says: /A dash instead of a count means the feed could not be reached, so nothing was checked; 0 means checked and none found\./,
    file: SECURITY,
    proofs: [
      { re: /const counted = !lookalikes\.error && !d\.unavailable/, expect: 'a count is only claimed when the fetch worked and upstream did not declare itself unavailable' },
      { re: /\{counted \? rows\.length : '—'\} detected/, expect: 'otherwise the header prints an em dash rather than 0' },
    ],
  },
  {
    panel: 'infra-host-status',
    says: /When those two numbers differ, a line under the list says so\./,
    file: INFRA,
    proofs: [
      { re: /const partial = totalHosts != null && totalHosts !== loaded/, expect: 'the two numbers are the estate total and the rows loaded' },
      {
        re: /\{partial && \([\s\S]{0,200}?breakdown of \{loaded\.toLocaleString\(\)\} loaded of \{total\.toLocaleString\(\)\} total/,
        expect: 'the extra line renders only when those two differ',
      },
    ],
  },
  {
    panel: 'assets-list',
    says: /Provider and Vendor share one column while every row agrees on both, and split back into two when they stop\./,
    file: ASSETS,
    proofs: [
      {
        re: /\.\.\.\(merged\n\s*\? \[\{ key: 'provider', label: 'Provider \/ Vendor'/,
        expect: 'a merged state contributes ONE column headed Provider / Vendor',
      },
      {
        re: /\{ key: 'provider', label: 'Provider',[\s\S]{0,200}?\{ key: 'vendor', label: 'Vendor',/,
        expect: 'the unmerged branch contributes two columns instead',
      },
    ],
  },
  {
    panel: 'assets-detail',
    says: /The five fields kept out of the table/,
    file: ASSETS,
    proofs: [
      {
        re: /const fields = \[\n\s*\['OS',[\s\S]{0,300}?\['Location', d\?\.detail\?\.location\],\n\s*\]/,
        expect: 'the detail field list runs from OS to Location and closes — five entries, matching the five the copy names',
      },
    ],
  },
  {
    panel: 'audit-activity-summary',
    says: /The "unknown" figure only appears when at least one action reported nothing back\./,
    file: AUDIT,
    proofs: [
      { re: /else if \(!r \|\| \/\^unknown\$\/i\.test\(r\)\) unknown\+\+/, expect: 'an action with no result, or a literal "unknown" one, is what the counter counts' },
      { re: /\{unknown > 0 && \(/, expect: 'the figure is rendered only when that counter is above zero' },
    ],
  },
  {
    panel: 'provision-subnet-request',
    says: /the green Provision button appears only after that, and disappears again the moment you edit a field/,
    file: UI,
    proofs: APPLY_BUTTON_PROOFS,
  },
  {
    panel: 'provision-subnet-request',
    says: /the green Provision button appears only after that, and disappears again the moment you edit a field/,
    file: PROVISION,
    proofs: [
      { re: /applyLabel="Provision"/, expect: 'the button on this panel is the one labelled Provision' },
      { re: /setSpace\(e\.target\.value\); setBlock\(''\); flow\.markStale\(\)/, expect: 'editing the Space field marks the preview stale, which is what withdraws the button' },
    ],
  },
  {
    panel: 'provision-site-teardown',
    says: /The red button needs an admin token and the site name typed in exactly/,
    file: PROVISION,
    proofs: [
      { re: /panelId="provision-site-teardown"[\s\S]{0,1400}?destructive\n/, expect: 'this panel declares its Apply destructive, which is what paints it red' },
      { re: /applyDisabled=\{!isAdmin \|\| !tdConfirm\.trim\(\)\}/, expect: 'Apply is refused without the admin role and without something typed in the confirm box' },
    ],
  },
  {
    panel: 'provision-site-teardown',
    says: /The red button needs an admin token and the site name typed in exactly/,
    file: UI,
    proofs: APPLY_BUTTON_PROOFS,
  },
  {
    // "exactly" is the whole point of this row. The browser only checks the box
    // is non-empty; it is the server that compares it to the site name, so a
    // client-side proof alone would be weaker than the sentence it answers.
    panel: 'provision-site-teardown',
    says: /the site name typed in exactly/,
    file: GO_PROVISION,
    proofs: [
      {
        re: /if !cfg\.DryRun && provision\.PyStr\(qp\["confirm"\]\) != cfg\.Site \{/,
        expect: 'a live teardown is refused unless the typed confirmation equals the site name',
      },
    ],
  },
  {
    panel: 'provision-site-teardown-log',
    says: /Red lines are objects it could not delete\./,
    file: PROVISION,
    proofs: [LOG_ERROR_RED_PROOF],
  },
  {
    panel: 'provision-seed-request',
    says: /Which of the three regions to build demo sites for/,
    file: PROVISION,
    proofs: [{ re: /\{\['amer', 'emea', 'apac'\]\.map\(\(r\) => \(/, expect: 'exactly three regions are offered as tick boxes' }],
  },
  {
    panel: 'provision-seed-teardown',
    says: /The red button needs an admin token and the word DELETE typed in/,
    file: PROVISION,
    proofs: [
      { re: /panelId="provision-seed-teardown"[\s\S]{0,1400}?destructive\n/, expect: 'this panel declares its Apply destructive, which is what paints it red' },
      { re: /applyDisabled=\{!isAdmin \|\| tdConfirm\.trim\(\) !== 'DELETE'\}/, expect: 'Apply is refused without the admin role and without the exact word DELETE' },
    ],
  },
  {
    panel: 'provision-seed-teardown',
    says: /The red button needs an admin token and the word DELETE typed in/,
    file: UI,
    proofs: APPLY_BUTTON_PROOFS,
  },
  {
    panel: 'provision-seed-teardown-log',
    says: /Red lines are objects it could not delete\./,
    file: PROVISION,
    proofs: [LOG_ERROR_RED_PROOF],
  },
  {
    panel: 'selfservice-manage-records',
    says: /Delete takes two clicks\./,
    file: SELFSERVICE,
    proofs: [
      { re: /function handleDeleteClick\(row\) \{\n\s*if \(armedId !== row\.id\) \{/, expect: 'the first click on an unarmed row does not delete' },
      { re: /setArmLabel\(`Click again to delete \$\{fresh\.type\}/, expect: 'it arms the row and asks for a second click instead' },
    ],
  },
  {
    panel: 'selfservice-manage-addresses',
    says: /It takes two clicks to confirm and then happens immediately — there is no preview and no undo\./,
    file: SELFSERVICE,
    proofs: [
      { re: /function handleRelease\(row\) \{\n\s*if \(armedId !== row\.id\) \{/, expect: 'the first click on an unarmed row does not release the address' },
      { re: /setArmLabel\(`Click again to release \$\{fresh\.address\}/, expect: 'it arms the row and asks for a second click instead' },
    ],
  },
  {
    panel: 'editor-object-form',
    says: /Delete takes two clicks and is final\./,
    file: EDITOR,
    proofs: [
      { re: /if \(!delArmed\) \{\n\s*setDelArmed\(true\)/, expect: 'the first click only arms the delete' },
      { re: /\{delArmed \? 'Click again to permanently delete' :/, expect: 'the armed button asks for the second click' },
    ],
  },
]

// ---------------------------------------------------------------------------
// EXCLUDED — value-ish sentences deliberately NOT checked, with the reason.
// `phrase` must still appear verbatim in that panel's copy; see the test below.
// ---------------------------------------------------------------------------
const EXCLUDED = [
  {
    panel: 'subnet-heatmap',
    phrase: 'Only the fullest few hundred are drawn',
    why: 'The code is `const CAP = 288 // 24 x 12`. 288 IS a few hundred, but "a few hundred" has no boundary a regex can bind — 150 and 450 would both satisfy an English reader. Checking it would mean asserting a number the copy deliberately does not state.',
  },
  {
    panel: 'assets-list',
    phrase: 'Searching, sorting and paging all happen on the server',
    why: 'A claim about WHERE work happens, not about a value. Proving it means tracing the fetch through the Go handler to the upstream query params and showing no client-side sort exists on any path. Nothing here reads request flow.',
  },
  {
    panel: 'audit-log',
    phrase: 'but not downloadable',
    why: 'A NEGATED claim. Every rule in this file and in panelHelpTruth.js reads a match as a promise that something EXISTS; there is no sound way to assert the absence of a download path from a text match, because absence in one file is not absence in the app.',
  },
  {
    panel: 'incidents-severity',
    phrase: 'When the list is capped these count only what is on screen',
    why: 'Conditional on a cap that is applied elsewhere (DataTable rowCap) and only sometimes. The sentence is about which SET was counted, which needs the data flow, not a literal.',
  },
  {
    panel: 'dns-zone-kpis',
    phrase: 'A zone that publishes no cache time is never examined',
    why: 'The exclusion is a null-TTL guard several call sites deep in the zone normaliser. A text match on any one of them would be evidence for a rule, not for the claim; the claim is that NO path examines such a zone.',
  },
  {
    panel: 'security-exposures',
    phrase: 'or that the total itself is unknown',
    why: 'Depends on whether the upstream feed reported a total at all — a runtime property of a payload this test never sees. There is no literal in any file that is true only when the total is unknown.',
  },
  {
    // The first entry here that exists because the FACT lexicon was WRONG, and
    // it is kept rather than tuned away on purpose: this is what over-flagging
    // is supposed to look like — loud, in the table, with a reason.
    panel: 'infra-dfp-services',
    phrase: 'so the two never look the same',
    why: 'A FALSE FLAG. "the two" is a pronoun for the two states the same sentence just named, not a count of anything, so there is no value to bind. What is left underneath is a rendering-branch claim (Empty for a configured-none, FeedUnavailable for a failed read, both inside a shared FeedCard) — a behavioural shape of rule, which is the sibling file\'s machine, not this one\'s.',
  },
]

// ---------------------------------------------------------------------------
// THE FACT LEXICON. See the COVERAGE section of the header for what it cannot
// see, and why it is tuned to over-flag.
//
// `under \d` / `past \d` / `over \d` are already caught by `digits`; they are
// written out anyway so the report names WHICH shape of claim fired, which is
// what a triager needs in order to write the proof.
// ---------------------------------------------------------------------------
const FACT_LEXICON = [
  { kind: 'number', re: /\d/ },
  { kind: 'percentage', re: /%/ },
  { kind: 'colour', re: /\b(red|amber|blue|green|grey|gray|pink)\b/i },
  {
    kind: 'threshold',
    re: /\b(at most|at least|no more than|fewer than|more than|up to|or more|or fewer|under \d|past \d|over \d)\b/i,
  },
  {
    kind: 'window',
    re: /\b(last hour|last 24 hours|24 hours|7 days|seven days|each day|per day|hour by hour|day by day|each of the last)\b/i,
  },
  {
    kind: 'count word',
    // "one" and "a single" are deliberately absent — see the header.
    re: /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|dozen)\b/i,
  },
]

// Validated against the real copy — see the header. Terminal punctuation is
// kept, because several `says` regexes end in an escaped full stop.
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function sentencesOf(entry) {
  return [...splitSentences(entry.what), ...splitSentences(entry.look)]
}

function factKinds(sentence) {
  return FACT_LEXICON.filter((l) => l.re.test(sentence)).map((l) => l.kind)
}

// One panel -> its bucket, plus the working the report and the guard both need.
function classifyPanel(panelId) {
  const entry = PANEL_HELP[panelId]
  const flagged = sentencesOf(entry)
    .map((sentence) => ({ sentence, kinds: factKinds(sentence) }))
    .filter((s) => s.kinds.length > 0)

  const claims = CLAIMS.filter((c) => c.panel === panelId)
  const excluded = EXCLUDED.filter((e) => e.panel === panelId)

  const claimed = []
  const excused = []
  const unclassified = []
  for (const f of flagged) {
    if (claims.some((c) => c.says.test(f.sentence))) claimed.push(f)
    else if (excluded.some((e) => f.sentence.includes(e.phrase))) excused.push(f)
    else unclassified.push(f)
  }

  let bucket
  if (unclassified.length) bucket = 'unclassified'
  else if (excused.length) bucket = 'excluded-with-reason'
  else if (flagged.length) bucket = 'verified'
  else bucket = 'makes-no-factual-claim'

  return { panel: panelId, bucket, flagged, claimed, excused, unclassified }
}

function classifyPanels() {
  return Object.keys(PANEL_HELP).map(classifyPanel)
}

// ---------------------------------------------------------------------------
// Helpers for the failure message the plan specifies:
//   <panel>: help says "<sentence>" — expected <expect> in <file>; /<re>/ not found
// ---------------------------------------------------------------------------
function sentenceFor(claim) {
  const entry = PANEL_HELP[claim.panel]
  if (!entry) return '(no such panel)'
  const m = claim.says.exec(helpText(entry))
  return m ? m[0] : '(says did not match)'
}

// ---------------------------------------------------------------------------
// Meta-lint. Discount regex syntax, then count what a human would call a
// literal character. See the header for why this exists.
// ---------------------------------------------------------------------------
function literalNonDigitChars(source) {
  return (
    source
      // \s \d \w and friends are classes, not literals
      .replace(/\\[sSdDwWbBnrtvf0]/g, '')
      // an escaped literal (\. \( \{) counts as the character itself
      .replace(/\\(.)/g, '$1')
      // regex metacharacters and whitespace are not literal content
      .replace(/[\d()[\]{}|?*+^$.\s]/g, '').length
  )
}

const MIN_LITERAL_CHARS = 4

// ---------------------------------------------------------------------------

test('the claim table is still worth running', () => {
  assert.ok(CLAIMS.length >= 40, `only ${CLAIMS.length} claims in the table — rows have been deleted rather than fixed`)
  const panels = new Set(CLAIMS.map((c) => c.panel))
  assert.ok(panels.size >= 30, `only ${panels.size} distinct panels covered — the table has narrowed`)
  const areas = new Set(CLAIMS.map((c) => c.file.replace(/\/[^/]+$/, '')))
  for (const area of ['ui/src/tabs', 'ui/src/components', 'ui/src/lib', 'go/internal/server', 'go/internal/dashboard']) {
    assert.ok(areas.has(area), `no claim resolves through ${area} any more — that source area has stopped being checked`)
  }
  assert.ok(EXCLUDED.length > 0, 'EXCLUDED is empty: either every claim is now checkable (say so) or the list was quietly dropped')
})

test('every claim names a panel that still has help copy', () => {
  const missing = CLAIMS.filter((c) => !PANEL_HELP[c.panel]).map((c) => c.panel)
  assert.deepEqual(
    missing,
    [],
    `${missing.length} claim row(s) name a panel PANEL_HELP has never heard of: ${missing.join(', ')}. ` +
      'The panel was renamed or removed; the row has to follow it or go.',
  )
})

test('every claim still binds to the sentence it was written for', () => {
  const stale = []
  for (const claim of CLAIMS) {
    const entry = PANEL_HELP[claim.panel]
    if (!entry) continue
    if (claim.says.test(helpText(entry))) continue
    stale.push(
      `${claim.panel}: /${claim.says.source}/ matches nothing in the copy any more\n` +
        `      copy now reads: ${helpText(entry)}`,
    )
  }
  assert.deepEqual(
    stale,
    [],
    `${stale.length} claim row(s) are checking a sentence that is no longer written. This is NOT a pass — ` +
      'the row is now proving something about the code that nobody claims in the help text. Either the copy ' +
      'was reworded (update `says`) or the claim was dropped (delete the row):\n  ' +
      stale.join('\n  '),
  )
})

test('proof regexes never match on digits alone', () => {
  const thin = []
  for (const claim of CLAIMS) {
    for (const proof of claim.proofs) {
      const n = literalNonDigitChars(proof.re.source)
      if (n >= MIN_LITERAL_CHARS) continue
      thin.push(`${claim.panel} (${claim.file}): /${proof.re.source}/ has ${n} literal non-digit character(s)`)
    }
  }
  assert.deepEqual(
    thin,
    [],
    `${thin.length} proof(s) anchor on bare digits. 150 is DNSSEC_CAP and also rowCap={150} in eight unrelated ` +
      `places; 200 is a _limit and also <Skeleton h={220}>. A proof must name a constant, an operator and a ` +
      `variable, a call form or a key string — at least ${MIN_LITERAL_CHARS} literal non-digit characters:\n  ` +
      thin.join('\n  '),
  )
})

test('the numbers, thresholds, windows and colours the copy states are the ones in the code', () => {
  const broken = []
  for (const claim of CLAIMS) {
    const src = sourceOf(claim.file)
    const sentence = sentenceFor(claim)
    for (const proof of claim.proofs) {
      if (proof.re.test(src)) continue
      broken.push(
        `${claim.panel}: help says "${sentence}" — expected ${proof.expect} in ${claim.file}; ` +
          `/${proof.re.source}/ not found`,
      )
    }
  }
  assert.deepEqual(
    broken,
    [],
    `${broken.length} value claim(s) in the help copy are not backed by the code. Either the code changed and the ` +
      'sentence is now false, or the line moved and the proof needs re-pointing — do NOT edit the copy to match ' +
      'the code without checking which of the two is wrong:\n  ' +
      broken.join('\n  '),
  )
})

test('colour tokens all still exist in index.css, in both themes', () => {
  const css = fs.readFileSync(path.join(REPO_ROOT, 'ui/src/index.css'), 'utf8')
  const missing = []
  for (const [token, { word, cssVar }] of Object.entries(COLOUR_TOKENS)) {
    const defs = css.match(new RegExp(`${cssVar}:\\s*#[0-9a-fA-F]{3,8}`, 'g')) || []
    if (defs.length < 2) {
      missing.push(`${token} -> "${word}" -> ${cssVar}: ${defs.length} hex definition(s), expected one per theme`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `${missing.length} colour token(s) in this file's dictionary no longer resolve to a defined custom property ` +
      'in ui/src/index.css. Every colour row above pairs a JS token with an English word through that dictionary, ' +
      'so a token that has stopped existing makes those rows meaningless:\n  ' +
      missing.join('\n  '),
  )
})

test('every colour token used in a proof is one the dictionary defines', () => {
  const known = new Set(Object.keys(COLOUR_TOKENS))
  const unknown = new Set()
  for (const claim of CLAIMS) {
    for (const proof of claim.proofs) {
      for (const m of proof.re.source.matchAll(/COLORS\\?\.([A-Za-z]+)/g)) {
        if (!known.has(m[1]) && m[1] !== 'purple') unknown.add(`${claim.panel}: COLORS.${m[1]}`)
      }
    }
  }
  assert.deepEqual(
    [...unknown],
    [],
    `a proof paints a series with a colour token this file has no English word for, so the row cannot say whether ` +
      'the copy is telling the truth. Add it to COLOUR_TOKENS with its --color-* property, or stop citing it:\n  ' +
      [...unknown].join('\n  '),
  )
})

test('every excluded phrase is still in the copy it excuses', () => {
  const rotten = []
  for (const ex of EXCLUDED) {
    const entry = PANEL_HELP[ex.panel]
    if (!entry) {
      rotten.push(`${ex.panel}: PANEL_HELP has no such panel any more`)
      continue
    }
    if (helpText(entry).includes(ex.phrase)) continue
    rotten.push(`${ex.panel}: "${ex.phrase}" is no longer in the copy\n      copy now reads: ${helpText(entry)}`)
  }
  assert.deepEqual(
    rotten,
    [],
    `${rotten.length} EXCLUDED row(s) excuse a sentence nobody writes any more. An exclusion that has gone stale is ` +
      'worse than no exclusion: it tells the next reader this file deliberately skipped something, when what it ' +
      'actually skipped is gone. Delete the row, or re-point it:\n  ' +
      rotten.join('\n  '),
  )
})

test('no claim is also excluded', () => {
  const claimed = new Set(CLAIMS.map((c) => c.panel))
  const both = EXCLUDED.filter((ex) => {
    if (!claimed.has(ex.panel)) return false
    const entry = PANEL_HELP[ex.panel]
    if (!entry) return false
    return CLAIMS.some((c) => c.panel === ex.panel && c.says.test(ex.phrase))
  }).map((ex) => `${ex.panel}: "${ex.phrase}"`)
  assert.deepEqual(
    both,
    [],
    'a phrase is listed as undecidable in EXCLUDED and also checked by a claim row. One of the two is wrong:\n  ' +
      both.join('\n  '),
  )
})

test('coverage report: every panel in exactly one bucket', (t) => {
  const rows = classifyPanels()
  const by = (b) => rows.filter((r) => r.bucket === b)
  const verified = by('verified')
  const excused = by('excluded-with-reason')
  const silent = by('makes-no-factual-claim')
  const open = by('unclassified')

  t.diagnostic(`PANEL_HELP coverage — ${rows.length} panels, ${rows.reduce((n, r) => n + r.flagged.length, 0)} fact-shaped sentences`)
  t.diagnostic(`  verified               ${verified.length}`)
  t.diagnostic(`  excluded-with-reason   ${excused.length}`)
  t.diagnostic(`  makes-no-factual-claim ${silent.length}  (computed: the detector fired on nothing)`)
  t.diagnostic(`  UNCLASSIFIED           ${open.length}  <- fact-shaped copy nobody has bound or excused`)
  for (const r of open) {
    for (const f of r.unclassified) t.diagnostic(`    ${r.panel} [${f.kinds.join(', ')}]: ${f.sentence}`)
  }

  // An EXCLUDED row whose phrase sits in no flagged sentence is excusing
  // something the detector never asked about. Not a failure — the staleness test
  // above already keeps it honest — but it is worth saying out loud, because it
  // means the row is doing no coverage work.
  const idle = EXCLUDED.filter((ex) => {
    const entry = PANEL_HELP[ex.panel]
    if (!entry) return false
    return !sentencesOf(entry).some((s) => s.includes(ex.phrase) && factKinds(s).length > 0)
  })
  if (idle.length) t.diagnostic(`  EXCLUDED rows the detector never flags: ${idle.map((e) => e.panel).join(', ')}`)

  assert.equal(rows.length, Object.keys(PANEL_HELP).length, 'a panel fell out of the classification entirely')
})

test('every fact-shaped sentence is either claimed or excluded', () => {
  const open = []
  for (const r of classifyPanels()) {
    for (const f of r.unclassified) open.push(`${r.panel} [${f.kinds.join(', ')}]: "${f.sentence}"`)
  }
  assert.deepEqual(
    open,
    [],
    `${open.length} sentence(s) state a number, a colour, a threshold, a window or a count that nothing in this ` +
      'file answers for. This is the gap the coverage buckets exist to make visible: until one of these is bound ' +
      'to code by a CLAIMS row or written into EXCLUDED with a reason, a reader cannot tell whether it was ' +
      'checked and passed or never looked at. A false flag is fine — put it in EXCLUDED and say why:\n  ' +
      open.join('\n  '),
  )
})
