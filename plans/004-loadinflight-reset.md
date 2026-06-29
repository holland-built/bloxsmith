# Plan 004: Fix loadInFlight.current never reset — auto-refresh broken after first load

> **Executor instructions**: Follow step by step. Run every verification before
> moving on. Hit any STOP condition → stop and report, do not improvise.
>
> **Drift check (run first)**: `git diff --stat 5058ed6..HEAD -- index.html`
> If index.html changed since this plan was written, compare "Current state" excerpts
> against live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5058ed6`, 2026-06-29

## Why this matters

`loadInFlight.current` is set to `true` when a data fetch starts but is **never reset to `false`**. After the first fetch completes, every subsequent call to `load()` without `bustCache=true` hits the in-flight guard and returns immediately. The auto-refresh timer and any non-busting `load()` invocation silently do nothing. The Refresh button works because it passes `bustCache=true`, masking the bug.

This was introduced when the in-flight guard was added to prevent concurrent fetches — the matching reset was omitted.

## Current state

**File**: `index.html` (single-file 6500-line React 18 + Babel app, no build step)

**Affected code at `index.html:4860-4903`**:
```js
const loadInFlight = useRef(false);
const load = useCallback(async (bustCache=false)=>{
  if(loadInFlight.current && !bustCache) return;   // guard
  loadInFlight.current = true;                      // ← set true, NEVER reset
  // ...
  setLastUpd(new Date());
  setLoading(false);
  setRefreshing(false);
},[]);
```

After first fetch, `loadInFlight.current` stays `true` forever.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Run regression tests | `python test_regression.py` (with server running) | All pass |
| Confirm fix | `grep -n "loadInFlight.current = false" index.html` | 1 match |

## Scope

**In scope**: `index.html` — the `load` useCallback only (~lines 4861-4903)

**Out of scope**: everything else. Do NOT touch server.py, CSS, or any other React component.

## Git workflow

- Commit message: `fix: loadInFlight.current never reset after fetch — auto-refresh silently broken`
- Do NOT push unless instructed.

## Steps

### Step 1: Add finally block resetting the flag

Find in `index.html` (around line 4900):

```js
    setLastUpd(new Date());
    setLoading(false);
    setRefreshing(false);
  },[]);
```

The `load` function body has a top-level `try { ... } catch(e) { ... }` block. Wrap it with `finally`:

```js
    setLastUpd(new Date());
    setLoading(false);
    setRefreshing(false);
  } finally {
    loadInFlight.current = false;
  }
},[]);
```

The `finally` ensures the flag resets whether the fetch succeeded, threw a network error, or was caught by the existing catch block.

**Verify**: `grep -n "loadInFlight.current = false" index.html` → 1 match.

### Step 2: Confirm the guard is still correct

The guard `if(loadInFlight.current && !bustCache) return` uses `bustCache=true` as the override for the Refresh button. No change needed — just confirm it's still present:

`grep -n "loadInFlight.current && !bustCache" index.html` → 1 match.

## Test plan

No automated frontend test is feasible without a browser harness. Manual check:
1. Open `http://localhost:8080`, watch Network tab.
2. After initial load, observe future auto-refresh requests to `/api/data` firing on schedule.
3. Before fix: no subsequent `/api/data` requests after first. After fix: they fire.

## Done criteria

- [ ] `grep -n "loadInFlight.current = false" index.html` → exactly 1 match
- [ ] `grep -n "loadInFlight.current = true" index.html` → exactly 1 match (unchanged)
- [ ] `python test_regression.py` exits 0
- [ ] Only `index.html` modified (`git status`)
- [ ] `plans/README.md` status updated to DONE

## STOP conditions

- Code at lines 4860-4903 doesn't match excerpts (drift — stop and report).
- `loadInFlight.current = false` already exists somewhere in `load` — stop and report.
- The try/catch structure is more complex than a single block — stop and report actual structure.

## Maintenance notes

- If a periodic auto-refresh interval is added later, this guard + reset ensures no overlapping fetches.
- If `load` is refactored to use AbortController, the `loadInFlight` ref may become redundant.
