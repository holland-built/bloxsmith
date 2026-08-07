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
const CHANGES_TAB = 'ui/src/tabs/Changes.jsx'
const PROVISION = 'ui/src/tabs/Provision.jsx'
const SELFSERVICE = 'ui/src/tabs/SelfService.jsx'
const DRIFT = 'ui/src/tabs/Drift.jsx'
const CHANGES_LIB = 'ui/src/lib/changes.js'
const GO_DATA = 'go/internal/server/data.go'
const GO_CSP = 'go/internal/dashboard/csp.go'
const GO_ANALYTICS = 'go/internal/dashboard/analytics.go'

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
    proofs: [{ re: /\.sort\(\(a, b\) => b\.used - a\.used\)\n\s*\.slice\(0, 12\)/, expect: 'top 12 spaces by addresses used' }],
  },
  {
    panel: 'network-exhaustion',
    says: /The twenty subnets closest to running out of addresses/,
    file: NETWORK,
    proofs: [{ re: /const top20 = sorted\.slice\(0, 20\)/, expect: 'top 20 after sorting' }],
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
    says: /subnets over 85% full/,
    file: DAILY,
    proofs: [
      { re: /\(Number\(s\.util\) \|\| 0\) > 85\)\.length/, expect: 'the count is util > 85' },
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
    panel: 'daily-security-today',
    says: /The count by the title is 50 events at most/,
    file: GO_DATA,
    proofs: [{ re: /FetchHubSecurity\(3600, 50\)/, expect: '/api/hub/security asks for 50 events' }],
  },
  {
    panel: 'daily-security-today',
    says: /Threat events seen in the last hour/,
    file: GO_DATA,
    proofs: [{ re: /FetchHubSecurity\(3600, 50\)/, expect: '/api/hub/security asks for a 3600-second window' }],
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
    panel: 'infra-host-health',
    says: /it reads at most 500/,
    file: GO_CSP,
    proofs: [{ re: /func \(s \*Service\) CSPHostHealth\(\)[\s\S]{0,200}?"_limit":\s+"500"/, expect: 'CSPHostHealth asks for _limit 500' }],
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
      { re: /dataKey="blocked" stackId="day" fill=\{COLORS\.crit\}/, expect: 'the blocked series is COLORS.crit (red)' },
      { re: /dataKey="allowed" stackId="day" radius=\{\[3, 3, 0, 0\]\} fill=\{COLORS\.accent\}/, expect: 'the allowed series is COLORS.accent (blue), capping the stack' },
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
]

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
