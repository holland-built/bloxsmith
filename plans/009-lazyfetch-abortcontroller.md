# Plan 009: Add AbortController to lazyFetch — cancel in-flight requests on unmount

> **Executor instructions**: Follow step by step. Run every verification.
> STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 6f42354..HEAD -- index.html`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug/memory
- **Planned at**: commit `6f42354`, 2026-06-29

## Why this matters

`lazyFetch` fires `fetch(url)` with no AbortController. If the user navigates away from a section while a lazy fetch is in flight, the promise resolves after the component re-renders with a different section, calling `set(d)` (e.g. `setDnsAnalytics`) on potentially unmounted state. This triggers the React "state update on unmounted component" warning and holds the fetch connection open unnecessarily.

There are 4 lazy data keys: `dns-analytics`, `insights`, `actions`, `hostMetrics`. All go through a single `lazyFetch` callback.

## Current state

**File**: `index.html`

**Affected code at `index.html:5146-5152`**:
```jsx
const lazyFetch = useCallback((key,url,set)=>{
  setLazyErr(e=>({...e,[key]:false}));
  setLazyLoading(l=>({...l,[key]:true}));
  fetch(url).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d=>{ setLazyLoading(l=>({...l,[key]:false})); set(d); })
    .catch(()=>{ setLazyLoading(l=>({...l,[key]:false})); setLazyErr(e=>({...e,[key]:true})); });
},[]);
```

The `useEffect` that calls `lazyFetch` is at `index.html:5153-5158`:
```jsx
useEffect(()=>{
  if(section==='dns'&&!dnsAnalytics&&!lazyErr['dns-analytics']&&!lazyLoading['dns-analytics']) lazyFetch('dns-analytics','/api/dns-analytics',setDnsAnalytics);
  if(section==='security'&&!insights&&!lazyErr.insights&&!lazyLoading.insights) lazyFetch('insights','/api/insights',setInsights);
  if(section==='security'&&!actions&&!lazyErr.actions&&!lazyLoading.actions) lazyFetch('actions','/api/actions',setActions);
  if(section==='hosts'&&!hostMetrics&&!lazyErr.hostMetrics&&!lazyLoading.hostMetrics) lazyFetch('hostMetrics','/api/host-metrics',setHostMetrics);
},[section]);
```

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm abort ref | `grep -n "lazyAbort\|AbortController" index.html` | ≥1 match near lazyFetch |
| Verify no bare fetch | `grep -n "fetch(url)" index.html` | 0 matches (replaced by signal fetch) |

## Scope

**In scope**: `index.html` — `lazyFetch` useCallback and its surrounding `useEffect` only (~lines 5146-5158).

**Out of scope**: server.py, CSS, the retry buttons that call `lazyFetch` manually.

## Git workflow

- Commit: `fix: add AbortController to lazyFetch — cancel in-flight requests on section change`

## Steps

### Step 1: Add an AbortController ref above lazyFetch

Find the line just before `const lazyFetch = useCallback` at `index.html:5146`. Insert:
```jsx
const lazyAbort = useRef({});
```

### Step 2: Replace the lazyFetch body

Replace the current `lazyFetch` useCallback body:
```jsx
const lazyFetch = useCallback((key,url,set)=>{
  setLazyErr(e=>({...e,[key]:false}));
  setLazyLoading(l=>({...l,[key]:true}));
  fetch(url).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d=>{ setLazyLoading(l=>({...l,[key]:false})); set(d); })
    .catch(()=>{ setLazyLoading(l=>({...l,[key]:false})); setLazyErr(e=>({...e,[key]:true})); });
},[]);
```

With:
```jsx
const lazyFetch = useCallback((key,url,set)=>{
  if(lazyAbort.current[key]) lazyAbort.current[key].abort();
  const ctrl = new AbortController();
  lazyAbort.current[key] = ctrl;
  setLazyErr(e=>({...e,[key]:false}));
  setLazyLoading(l=>({...l,[key]:true}));
  fetch(url,{signal:ctrl.signal}).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(d=>{ setLazyLoading(l=>({...l,[key]:false})); set(d); })
    .catch(e=>{ if(e.name==='AbortError') return; setLazyLoading(l=>({...l,[key]:false})); setLazyErr(e2=>({...e2,[key]:true})); });
},[]);
```

Key changes:
- Each call aborts any previous in-flight request for the same key
- Passes `{signal:ctrl.signal}` to `fetch`
- Catch ignores `AbortError` — abort is intentional, not an error

### Step 3: Add cleanup to the section useEffect

Replace the current section useEffect at `index.html:5153-5158`:
```jsx
useEffect(()=>{
  if(section==='dns'&&!dnsAnalytics&&!lazyErr['dns-analytics']&&!lazyLoading['dns-analytics']) lazyFetch('dns-analytics','/api/dns-analytics',setDnsAnalytics);
  if(section==='security'&&!insights&&!lazyErr.insights&&!lazyLoading.insights) lazyFetch('insights','/api/insights',setInsights);
  if(section==='security'&&!actions&&!lazyErr.actions&&!lazyLoading.actions) lazyFetch('actions','/api/actions',setActions);
  if(section==='hosts'&&!hostMetrics&&!lazyErr.hostMetrics&&!lazyLoading.hostMetrics) lazyFetch('hostMetrics','/api/host-metrics',setHostMetrics);
},[section]);
```

With:
```jsx
useEffect(()=>{
  if(section==='dns'&&!dnsAnalytics&&!lazyErr['dns-analytics']&&!lazyLoading['dns-analytics']) lazyFetch('dns-analytics','/api/dns-analytics',setDnsAnalytics);
  if(section==='security'&&!insights&&!lazyErr.insights&&!lazyLoading.insights) lazyFetch('insights','/api/insights',setInsights);
  if(section==='security'&&!actions&&!lazyErr.actions&&!lazyLoading.actions) lazyFetch('actions','/api/actions',setActions);
  if(section==='hosts'&&!hostMetrics&&!lazyErr.hostMetrics&&!lazyLoading.hostMetrics) lazyFetch('hostMetrics','/api/host-metrics',setHostMetrics);
  return ()=>{ Object.values(lazyAbort.current).forEach(c=>c.abort()); };
},[section]);
```

The cleanup function aborts all in-flight lazy fetches when the section changes or the component unmounts.

## Done criteria

- [ ] `grep -n "AbortController" index.html` → 1 match in lazyFetch area
- [ ] `grep -n "AbortError" index.html` → 1 match in lazyFetch catch
- [ ] `grep -n "fetch(url)" index.html` → 0 matches (replaced by `fetch(url,{signal`)
- [ ] `grep -n "lazyAbort" index.html` → ≥2 matches (ref declaration + usage)
- [ ] Only `index.html` modified
- [ ] `plans/README.md` updated

## STOP conditions

- `lazyFetch` at line 5146 doesn't match excerpt (drift).
- `lazyLoading` is a ref, not state (check — if so, signal guard logic differs).
- More than one `useEffect` depends on `[section]` at this location (read context first).

## Maintenance notes

- If new lazy data keys are added, they automatically get abort support through `lazyAbort.current[key]`.
- The cleanup aborts ALL keys on section change — intentional, avoids stale data from wrong section.
