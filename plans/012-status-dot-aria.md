# Plan 012: Fix color-only status dots — add aria-hidden to decorative, aria-label to status-indicating

> **Executor instructions**: Follow step by step. Run every verification.
> STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 6f42354..HEAD -- index.html`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: a11y
- **Planned at**: commit `6f42354`, 2026-06-29

## Why this matters

The `.dot` CSS class (6px circle, `index.html:214`) is used two ways:

1. **Decorative** — teal/default color, used as a visual bullet in card titles. No semantic meaning. Screen readers announce these as empty elements or skip them.
2. **Status-indicating** — colored red/amber/green via inline `style={{background:'var(--red)'}}`. The color conveys severity/state with no accessible text. Fails WCAG 1.4.1 (use of color).

Fix:
- Decorative dots → add `aria-hidden="true"` (suppress from accessibility tree)
- Status-indicating dots → add `aria-label` describing the state (e.g. `aria-label="critical"`)

## Current state

**File**: `index.html`

**Decorative dots** (15 instances — add `aria-hidden="true"`):
```
2307: <div className="dot"/>Query Volume — Last 7 Days
2347: <div className="dot"/>Query Types
2371: <div className="dot"/>Top DNS Clients
2542: <div className="dot"/>Resource Contention Matrix
2598: <div className="dot"/>Device Health Scorecards
2640: <div className="dot"/>Host Status Grid
2777: <div className="dot"/>Action audit trail
2939: <div className="dot"/>  (standalone, inside status section)
3697: <div className="dot"/>Alert Rules ...
5729: <div className="dot"/>Changes since last refresh
5996: <div className="dot"/>All Subnets — DHCP Utilization
6078: <div className="dot"/>DHCP Leases
6180: <div className="dot"/>DNS Zones — Empty Records
6216: <div className="dot"/>Status Breakdown
6221: <div className="dot"/>Host List
```

**Status-indicating dots** (7 instances — add `aria-label`):
```
2430: <div className="dot" style={{background:'var(--red)'}}/>  — SOC Insights (red = critical)
2953: <div className="dot" style={{background:'var(--green)'}}/>  — green = ok/active
3512: <div className="dot" style={{background:'var(--amber)'}}/>  — Triage (amber = warning)
4180: <div className="dot" style={{background:'var(--amber)'}}/>  — (amber = warning)
6144: <div className="dot" style={{background:'var(--amber)'}}/>  — Zones with TTL Issues (amber = warning)
6294: <div className="dot" style={{background:'var(--red)'}}/>  — All Threat Feeds (red = critical)
6335: <div className="dot" style={{background:'var(--red)'}}/>  — Entity & Threat Lookup (red = critical)
```

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Count decorative fixes | `grep -c 'className="dot" aria-hidden="true"' index.html` | ≥14 |
| Count status fixes | `grep -c 'className="dot".*aria-label' index.html` | ≥7 |
| Regression | `python test_regression.py` | All pass |

## Scope

**In scope**: `index.html` — all `className="dot"` occurrences only. No CSS changes.

**Out of scope**: `s-dot`, `t-dot`, `toast-dot`, `fresh-dot`, `ov-dots` — these are different classes, skip them. `server.py` — do not touch.

## Git workflow

- Commit: `fix(a11y): aria-hidden on decorative dots, aria-label on status-indicating dots`

## Steps

### Step 1: Add aria-hidden to all decorative dots (default teal, no inline background)

For every `<div className="dot"/>` that has NO `style={{background:...}}`, change to:
```jsx
<div className="dot" aria-hidden="true"/>
```

Use a search-and-replace approach: the exact string `<div className="dot"/>` (no style prop) appears only in decorative positions. Replace ALL occurrences of this exact string.

**Verify**: `grep -c 'className="dot"/>' index.html` → 0 (all plain dots now have `aria-hidden`).

### Step 2: Add aria-label to status-indicating dots

Each colored dot needs a label describing its severity:

| Line | Background | aria-label to add |
|------|-----------|------------------|
| 2430 | `var(--red)` | `"critical"` |
| 2953 | `var(--green)` | `"ok"` |
| 3512 | `var(--amber)` | `"warning"` |
| 4180 | `var(--amber)` | `"warning"` |
| 6144 | `var(--amber)` | `"warning"` |
| 6294 | `var(--red)` | `"critical"` |
| 6335 | `var(--red)` | `"critical"` |

Example transformation for line 2430:
```jsx
// Before:
<div className="dot" style={{background:'var(--red)'}}/>
// After:
<div className="dot" aria-label="critical" style={{background:'var(--red)'}}/>
```

Apply to each of the 7 status-indicating dots. Match by the full line context (include surrounding card-title text to make the match unique).

**Verify**: `grep -c 'className="dot".*aria-label' index.html` → 7.

## Done criteria

- [ ] `grep -c 'className="dot"/>' index.html` → 0 (no bare dots without aria-hidden)
- [ ] `grep -c 'className="dot" aria-hidden="true"/>' index.html` → ≥14
- [ ] `grep -c 'className="dot".*aria-label' index.html` → 7
- [ ] Only `index.html` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Line count for `<div className="dot"/>` differs significantly from expected 15 (drift — don't bulk-replace without re-counting first).
- Any dot has both `style={{background:...}}` AND no inline style that differs from the default (check before assigning label).
- More than 25 total `.dot` matches found (unexpected, stop and recount).

## Maintenance notes

- When adding new card sections with `.dot` bullets: always add `aria-hidden="true"` for decorative, `aria-label="critical|warning|ok"` for colored status dots.
- The CSS `.dot` class itself needs no change — `aria-hidden` suppresses it from the a11y tree without affecting layout.
