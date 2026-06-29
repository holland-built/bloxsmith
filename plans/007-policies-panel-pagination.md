# Plan 007: Paginate PoliciesPanel — unbounded render causes OOM with 100+ policies

> **Executor instructions**: Follow step by step. Run every verification.
> Hit any STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 5058ed6..HEAD -- index.html`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `5058ed6`, 2026-06-29

## Why this matters

`PoliciesPanel` at `index.html:1375` calls `realPolicies.map(renderPol)` with no limit. Real Infoblox deployments can have hundreds of policies. At 1000+, the main thread locks for 3-5 seconds and can OOM the tab. The existing `AuditTable` (line 1395) already solves this with a `limit` prop and "Show more" button — apply the same pattern here.

## Current state

**Affected code at `index.html:1375-1393`**:
```jsx
  {realPolicies.map(renderPol)}          // ALL policies, no limit
  {testPolicies.length>0&&(
    <>
      {/* test collapse toggle */}
      {testExpanded&&testPolicies.map(renderPol)}   // ALL test policies when expanded
    </>
  )}
```

**Reference pattern — `AuditTable` at `index.html:1395-1415`**:
- Has `const [show, setShow] = useState(limit)` (default 10)
- Renders `filtered.slice(0, show)`
- Shows `<button className="show-more-btn" onClick={()=>setShow(s=>s+limit)}>Show more</button>`
- `.show-more-btn` CSS class already exists — do NOT add new CSS

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `python test_regression.py` (server running) | All pass |
| Verify no unbounded map | `grep -n "realPolicies.map" index.html` | 0 matches after fix |

## Scope

**In scope**: `index.html` — `PoliciesPanel` function only (~lines 1340-1393)

**Out of scope**: AuditTable, DataTable, server.py, CSS, all other components

## Git workflow

- Commit: `fix: paginate PoliciesPanel — cap initial render to 10, add Show more`

## Steps

### Step 1: Add showCount state

Inside `PoliciesPanel`, after the existing `useState` calls, add:
```jsx
const [showCount, setShowCount] = useState(10);
```

### Step 2: Slice realPolicies

Replace `{realPolicies.map(renderPol)}` with:
```jsx
{realPolicies.slice(0, showCount).map(renderPol)}
{showCount < realPolicies.length && (
  <button className="show-more-btn"
    onClick={()=>setShowCount(n=>n+10)}
    aria-label={`Show more policies (${realPolicies.length - showCount} remaining)`}>
    Show {Math.min(10, realPolicies.length - showCount)} more · {realPolicies.length - showCount} remaining
  </button>
)}
```

**Verify**: `grep -n "slice(0, showCount)" index.html` → 1 match.

### Step 3: Cap test policies when expanded

Replace `{testExpanded&&testPolicies.map(renderPol)}` with:
```jsx
{testExpanded&&testPolicies.slice(0,20).map(renderPol)}
{testExpanded&&testPolicies.length>20&&(
  <div style={{fontSize:11,color:'var(--muted)',padding:'4px 0'}}>
    {testPolicies.length-20} more test policies hidden
  </div>
)}
```

## Done criteria

- [ ] `grep -n "realPolicies.map" index.html` → 0 matches
- [ ] `grep -n "slice(0, showCount)" index.html` → 1 match
- [ ] `python test_regression.py` exits 0
- [ ] Only `index.html` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Code at lines 1375-1393 doesn't match excerpts (drift).
- `renderPol` is defined outside `PoliciesPanel` (check scope).
- `policies` prop name differs from `policies` (check the function signature).

## Maintenance notes

- If filter/search is added to PoliciesPanel, reset `showCount` to 10 on filter change.
- Keep initial cap of 10 and increment of +10 to match AuditTable.
