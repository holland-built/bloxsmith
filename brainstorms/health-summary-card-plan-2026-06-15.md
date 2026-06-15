# Opus Plan: health-summary-card — 2026-06-15

ui_change: true

## Target file
`/Users/sholland/AI/Infoblox MCP/index.html` — already exists, do NOT recreate.

## Steps

### 1 — CSS (after line 162, after `.stiles` rule)
```css
.health-banner{display:flex;align-items:center;gap:8px;border-radius:6px;padding:7px 14px;margin-bottom:10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--surface-2);color:var(--gray-200)}
.health-banner.ok{background:var(--badge-green-bg);border-color:var(--border);color:var(--sev-green-t)}
.health-banner.issues-warn{background:var(--badge-amber-bg);border-color:var(--badge-amber-bd);color:var(--sev-amber-t)}
.health-banner.issues-crit{background:var(--badge-red-bg);border-color:var(--badge-red-bd);color:var(--sev-red-t)}
```

### 2 — JS derivation (insert after line 3773, before `return (`)
```jsx
const issues=tiles.filter(t=>t.sev!=='ok');
const worst=issues.some(t=>t.sev==='crit')?'crit':issues.length?'warn':'ok';
const hbCls=worst==='ok'?'ok':worst==='crit'?'issues-crit':'issues-warn';
const hbText=worst==='ok'?'✓ All systems OK'
  :`⚠ ${issues.length} issue${issues.length>1?'s':''} — ${issues.map(t=>`${t.cat} ${ST[t.sev]}`).join(' · ')}`;
```

### 3 — JSX wrap (replace `return (` + `<div className="stiles"` with fragment)
```jsx
return (
  <>
  <div className={`health-banner ${hbCls}`} role="status" aria-live="polite">{hbText}</div>
  <div className="stiles" role="group" aria-label="Tenant status by domain">
```
Close fragment after `.stiles` `</div>` → add `</>`

### 4 — Tests (7)
- `test_health_banner_class_present`
- `test_health_banner_variants` (all 3 variant classes in CSS)
- `test_health_banner_ok_text` (✓ All systems OK literal)
- `test_health_banner_issues_format` (issues template + · join)
- `test_health_banner_worst_crit_priority`
- `test_health_banner_aria_live`
- `test_fragment_wraps_stiles`

## Agents
- **Agent A (Builder):** edit index.html — CSS + JS + JSX changes
- **Agent B (Verify):** hotpatch + screenshot + add 7 tests + run pytest
