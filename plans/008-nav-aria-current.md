# Plan 008: Add aria-current="page" to nav tabs + keyboard for topbar clickable divs

> **Executor instructions**: Follow step by step. Run every verification.
> STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 5058ed6..HEAD -- index.html`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: a11y
- **Planned at**: commit `5058ed6`, 2026-06-29

## Why this matters

Two WCAG failures:

1. **WCAG 2.4.8 — Location**: Navigation tabs use CSS class `.active` only to indicate the current page. Screen readers cannot detect this. Fix: add `aria-current="page"` to the active tab button.

2. **WCAG 4.1.2 + Keyboard**: The Tactical Overview Bar (OVB) segments that navigate to sections are `<div onClick>` — no `role="button"`, no `tabIndex`, no `onKeyDown`. Keyboard-only users cannot activate them.

Both are S-effort HTML attribute additions.

## Current state

**File**: `index.html`

**Finding 1 — Nav tabs at `index.html:5459-5463`**:
```jsx
<button key={s.id} className={`topbar-tab${section===s.id?' active':''}`}
  onClick={()=>{setSection(s.id);setSidebarOpen(false);}}>
  {s.label}{badge}
</button>
```
No `aria-current`. Screen readers see an ordinary button with no indication it is the current page.

**Finding 2 — OVB segments (search for `ov-seg` or clickable divs in the overview section)**:
```jsx
<div className="ov-seg" onClick={()=>setSection('ipam')}>
  {/* subnet summary content */}
</div>
```
No `role`, no `tabIndex`, no keyboard handler.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm nav tab fix | `grep -n 'aria-current' index.html` | ≥1 match in topbar nav |
| Confirm OVB fix | `grep -n 'role="button"' index.html` | match in OVB segments |
| Tests | `python test_regression.py` | All pass |

## Scope

**In scope**: `index.html` — two targeted locations only: topbar nav buttons + OVB segment divs.

**Out of scope**: server.py, CSS, sidebar nav, any other interactive element.

## Git workflow

- Commit: `fix(a11y): aria-current on active nav tab, role+keyboard on OVB segments`

## Steps

### Step 1: Add aria-current to nav tabs

Find the nav tab button at `index.html:5459`:
```jsx
<button key={s.id} className={`topbar-tab${section===s.id?' active':''}`}
  onClick={()=>{setSection(s.id);setSidebarOpen(false);}}>
```

Add `aria-current`:
```jsx
<button key={s.id} className={`topbar-tab${section===s.id?' active':''}`}
  aria-current={section===s.id?'page':undefined}
  onClick={()=>{setSection(s.id);setSidebarOpen(false);}}>
```

Using `undefined` (not `false`) so React omits the attribute entirely for non-active tabs.

**Verify**: `grep -n "aria-current" index.html` → at least 1 match in the topbar nav block.

### Step 2: Add keyboard support to OVB segments

Search for the OVB segment pattern:
```bash
grep -n "ov-seg\|className.*ov-" index.html | head -10
```

For each `<div className="ov-seg" onClick={...}>`, add:
```jsx
<div className="ov-seg"
  role="button"
  tabIndex={0}
  onClick={()=>setSection('ipam')}
  onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSection('ipam');}}}
  aria-label="Go to IPAM subnets section">
```

Replace `'ipam'` with actual section ID per segment. Set `aria-label` to human-readable description.

**Verify**: `grep -n 'role="button"' index.html` → matches in OVB segments.

## Test plan

Manual accessibility check:
1. Tab through topbar — confirm active tab announces "current page" in Chrome DevTools → Accessibility panel → inspect active tab → `aria-current: page`.
2. Tab to OVB segment — confirm focus visible. Press Enter or Space — confirm navigates to correct section.

## Done criteria

- [ ] `grep -n 'aria-current' index.html` → present in topbar nav button render
- [ ] `grep -n 'role="button"' index.html` → present in OVB segments
- [ ] `grep -n 'onKeyDown' index.html` → new entries in OVB segments
- [ ] `python test_regression.py` exits 0
- [ ] Only `index.html` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Can't find OVB segments with `grep -n "ov-seg" index.html` — search for `setSection` inside `onClick` on a div in the overview section instead.
- OVB segments are already `<button>` elements — adding `role="button"` to a button is invalid, skip that attribute.
- More than 10 OVB segments found — unexpected, stop and report.

## Maintenance notes

- `aria-current` handled automatically by `section===s.id` — no update needed when adding new nav sections.
- If OVB segments convert to `<button>`, remove `role="button"` and `tabIndex` (buttons have these implicitly).
