# Topbar Overhaul — Implementation Plan (2026-06-15)

`ui_change: true`

Single-file React SPA (`index.html`, in-browser Babel JSX, no build step). Goal: slim the topbar to three controls (RefreshControl, ⊕ Query, AcctPill) and relocate the secondary controls (theme toggle, ⌘K, PresetMenu, MoreMenu) into a compact icon strip in the sidebar footer. Remove the duplicate account name from the sidebar. Add a "Layout saved ✓" toast when widgets are reordered.

---

## 1. Target files

| File | Status | Notes |
|---|---|---|
| `/Users/sholland/AI/Infoblox MCP/index.html` | **already exists — do NOT recreate** | The ONLY file to edit. All JSX, CSS, and JS live here. ~4400 lines. |
| `DAILY_CHANGELOG.md` | already exists — append only | Add a dated table entry per CLAUDE.md "Log every change" rule. |

Components referenced (all **already defined** in `index.html` — do NOT recreate, just move/reuse the instances):
- `RefreshControl`, `PresetMenu`, `AcctPill`, `MoreMenu`, `TenantManager`, `FreshnessPill`
- State/helpers already in scope at the topbar: `theme`, `setTheme`, `THEME_CYCLE`, `THEME_LABEL`, `THEME_ICON`, `setCmdkOpen`, `section`, plus all `MoreMenu` props (`autoRefresh`, `setAutoRefresh`, `shareView`, `density`, `setDensity`, `setShowShortcuts`, `wallMode`, `setWallMode`, `demoMode`, `setDemoMode`, `resetDashboard`, `refreshFrozen`, `setRefreshFrozen`) and all `AcctPill` props.
- `toast(msg, kind='ok')` helper — **already defined** (dispatches `noc-toast` CustomEvent). Call directly.

**Scope discipline:** every change traces to a step below. No unrelated edits, no refactors.

---

## 2. Verified current state (line numbers confirmed against file)

- **Topbar `topbar-group`**: lines **3750–3763**. Order: `RefreshControl`(3751) → chat-toggle (3754) → theme-btn ◐ (3757) → `PresetMenu` (3759) → ⌘K theme-btn (3760) → `AcctPill` (3761) → `MoreMenu` (3762).
- **Sidebar footer** `sidebar-foot`: opens **3634**, `ctx-panel` opens **3685**, closes **3727**.
- **`ctx-val` duplicate**: line **3698** — `<div className="ctx-val">{(accounts.find(a=>a.id===activeAcct)||{}).name||'—'}</div>`
- **`moveWidget`**: line **3209** (one-liner).
- **`onDrop`**: lines **3227–3236**; `LS.set('noc.widgetOrder',arr)` is the last statement at line 3235.
- **CSS**: `.theme-btn` line 425 (`margin-left:6px`), `.topbar-group .theme-btn{margin-left:0}` line 430, `.topbar-group` line 429, `.sidebar-foot` line 98, `.ctx-panel` line 311. No `.sidebar-icon-strip` exists yet.

---

## 3. Ordered implementation steps

Steps are independent of one another **except** A and B share the `topbar-group` block — A removes the four nodes, B re-adds them in the sidebar. Do A then B (or one agent does A+B together). C and D are fully independent. Recommended: **one Sonnet agent does A+B** (they touch the same removed JSX, keeps it coherent), **a second agent does C+D**. Each agent gets ~300-word brief below.

---

### STEP A — Strip four controls out of the topbar

**Edit `index.html`, the `<div className="topbar-group">` block (lines 3750–3763).**

REMOVE exactly these four nodes (verbatim, including the ⌘K button which also uses `theme-btn`):

```jsx
              <button className="theme-btn" onClick={()=>setTheme(t=>THEME_CYCLE[t]||'system')}
                title={`${THEME_LABEL[theme]} (click to change)`} aria-label={THEME_LABEL[theme]}>{THEME_ICON[theme]}</button>
              <PresetMenu section={section}/>
```
```jsx
              <button className="theme-btn" onClick={()=>setCmdkOpen(true)} title="Command palette (⌘K)" aria-label="Open command palette">⌘K</button>
```
```jsx
              <MoreMenu autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} onShare={shareView} density={density} setDensity={setDensity} onShortcuts={()=>setShowShortcuts(true)} wallMode={wallMode} onWall={()=>{const v=!wallMode;setWallMode(v);LS.set('noc.wall',v);}} demoMode={demoMode} onDemo={()=>{const v=!demoMode;setDemoMode(v);LS.set('noc.demoMode',v);if(v){setSection('overview');setDemoBannerDismissed(false);}}} onReset={resetDashboard} frozen={refreshFrozen} onFreeze={()=>setRefreshFrozen(v=>!v)}/>
```

**KEEP** in the topbar, final order: `RefreshControl` → chat-toggle-btn (⊕ Query) → `AcctPill`. After removal the `topbar-group` contains exactly those three children. Do NOT touch RefreshControl, the chat-toggle button, or AcctPill props.

---

### STEP B — Add the compact icon strip to the sidebar footer

**Edit `index.html`.** Insert a new `.sidebar-icon-strip` row inside `sidebar-foot`, immediately **after the API-Connected `<div>` closes (after line 3653, before the `{updPop&&(` block at 3654)**. This keeps it directly under the connection/version line, above the update popup and ctx-panel.

Insert:

```jsx
          <div className="sidebar-icon-strip">
            <button className="theme-btn" onClick={()=>setTheme(t=>THEME_CYCLE[t]||'system')}
              title={`${THEME_LABEL[theme]} (click to change)`} aria-label={THEME_LABEL[theme]}>{THEME_ICON[theme]}</button>
            <button className="theme-btn" onClick={()=>setCmdkOpen(true)} title="Command palette (⌘K)" aria-label="Open command palette">⌘K</button>
            <PresetMenu section={section}/>
            <MoreMenu autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} onShare={shareView} density={density} setDensity={setDensity} onShortcuts={()=>setShowShortcuts(true)} wallMode={wallMode} onWall={()=>{const v=!wallMode;setWallMode(v);LS.set('noc.wall',v);}} demoMode={demoMode} onDemo={()=>{const v=!demoMode;setDemoMode(v);LS.set('noc.demoMode',v);if(v){setSection('overview');setDemoBannerDismissed(false);}}} onReset={resetDashboard} frozen={refreshFrozen} onFreeze={()=>setRefreshFrozen(v=>!v)}/>
          </div>
```

These are the exact nodes removed in Step A (theme toggle + ⌘K identical JSX, PresetMenu + MoreMenu identical instances/props). Icons-only, no labels — matches grill-me.

**Add CSS** near `.theme-btn` (line 425) or `.ctx-panel` (line 311). Add:

```css
.sidebar-icon-strip{display:flex;align-items:center;gap:6px;margin-top:10px}
.sidebar-icon-strip .theme-btn{margin-left:0;padding:6px 8px;font-size:13px}
```

The `margin-left:0` override is required because `.theme-btn` defaults to `margin-left:6px` (line 425) and the `.topbar-group .theme-btn{margin-left:0}` rule (line 430) does NOT apply outside the topbar. Tooltips come free via the existing `title`/`aria-label` attributes. Verify PresetMenu/MoreMenu trigger buttons sit at ~28px height alongside the two theme-btns; if their dropdown panels clip against `sidebar-foot` (`position:relative`, line 98), no change is needed since both use overlay/portal-style menus consistent with the topbar.

---

### STEP C — Remove the duplicate account name from the sidebar

**Edit `index.html`, line 3698.** Delete exactly:

```jsx
              <div className="ctx-val">{(accounts.find(a=>a.id===activeAcct)||{}).name||'—'}</div>
```

This is the non-vault `ctx-block` branch (AcctPill in the topbar is now the canonical account display). Do NOT touch the `ctx-head` (3692–3697), the `ctx-note` single-account line (3699–3704), the `showAcctMenu` menu (3705–3723), or the `TenantManager` vault branch (3686–3689) — those remain functional. Removing only the `ctx-val` line leaves the "Account" cap + swap button + (single-key note) intact; verify the resulting `ctx-block` still renders without an empty gap (it should, the cap+swap row stays).

---

### STEP D — Add "Layout saved ✓" toast on reorder

**Edit `index.html` two one-line changes.** `toast` is already defined — call it directly. Use `kind='ok'`.

1. **`moveWidget`, line 3209.** Append `toast` after the `LS.set` call:

```js
  const moveWidget = (id,dir) => { const arr=[...overviewOrder]; const i=arr.indexOf(id); const j=i+dir; if(j<0||j>=arr.length) return; [arr[i],arr[j]]=[arr[j],arr[i]]; setOverviewOrder(arr); LS.set('noc.widgetOrder',arr); toast('Layout saved ✓','ok'); };
```

2. **`onDrop`, end of body (line 3235).** Append `toast` after the final `LS.set`:

```js
    setOverviewOrder(arr); LS.set('noc.widgetOrder',arr); toast('Layout saved ✓','ok');
```

Place the toast **after** the early-return guards (the `if(j<0...)`, `if(from===id)`, `if(fi<0||ti<0)` returns) so it only fires on an actual reorder, not a no-op drop. Do NOT add it to `resetDashboard` or `cycleSpan` — grill-me scoped it to drag-reorder + arrow-move only.

---

## 4. Per-agent dispatch briefs (~300-word cap each)

### Agent 1 — Topbar + sidebar strip (Steps A + B). model: sonnet
> Edit ONLY `/Users/sholland/AI/Infoblox MCP/index.html`. `RefreshControl`, `PresetMenu`, `AcctPill`, `MoreMenu` all **already exist — do NOT recreate**. (A) In the `topbar-group` block (lines 3750–3763) remove four nodes: the theme-btn ◐ (3757–3758), `<PresetMenu section={section}/>` (3759), the ⌘K theme-btn (3760), and the `<MoreMenu .../>` (3762). Leave RefreshControl, the chat-toggle-btn, and AcctPill — final order RefreshControl → chat-toggle → AcctPill. (B) Inside `sidebar-foot`, immediately after the API-Connected div closes (after line 3653, before `{updPop&&(` at 3654), insert a `<div className="sidebar-icon-strip">` containing, in order: the theme toggle button, the ⌘K button, `<PresetMenu section={section}/>`, and the `<MoreMenu .../>` — use the exact JSX/props removed in step A. Add CSS near line 425: `.sidebar-icon-strip{display:flex;align-items:center;gap:6px;margin-top:10px}` and `.sidebar-icon-strip .theme-btn{margin-left:0;padding:6px 8px;font-size:13px}` (the margin-left:0 override is mandatory — `.theme-btn` has margin-left:6px and the topbar override does not reach the sidebar). Icons only, tooltips via existing title/aria-label. Surgical edits only. Verify: `docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`, then headless Chrome `--screenshot=_proof.png "http://localhost:8080"`. Append a `DAILY_CHANGELOG.md` table row.

### Agent 2 — Sidebar dedupe + save toast (Steps C + D). model: sonnet
> Edit ONLY `/Users/sholland/AI/Infoblox MCP/index.html`. `toast(msg,kind='ok')` **already exists — call it directly, do NOT define it**. (C) Delete line 3698 exactly: `<div className="ctx-val">{(accounts.find(a=>a.id===activeAcct)||{}).name||'—'}</div>`. Keep `ctx-head`, the `ctx-note` single-account line, the `showAcctMenu` menu, and the `TenantManager` vault branch untouched. (D) Append `toast('Layout saved ✓','ok');` at the END of `moveWidget` (line 3209, after `LS.set('noc.widgetOrder',arr);`) and at the END of `onDrop` (line 3235, after `LS.set('noc.widgetOrder',arr);`). Both must sit AFTER the early-return guards so a no-op drop/move does not fire a toast. Do NOT add toasts elsewhere. Surgical edits only. Verify: hotpatch (`docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`) + headless screenshot, or `python -m pytest test_regression.py -v`. Append a `DAILY_CHANGELOG.md` table row.

---

## 5. Verification (required before "done")

1. Hotpatch: `docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`
2. Screenshot: headless Chrome `--screenshot=_proof.png "http://localhost:8080"`
3. Confirm topbar shows only Refresh + ⊕ Query + AcctPill; sidebar footer shows the 4-icon strip; no duplicate account name; drag-reorder a widget → "Layout saved ✓" toast appears.
4. Babel parse sanity (no build step → a JSX typo blanks the page): screenshot must render the dashboard, not a blank/error page.
5. `python -m pytest test_regression.py -v` if it covers markup.
6. Append entries to `DAILY_CHANGELOG.md`.

## 6. Risks / watch-outs

- **JSX syntax fragility**: in-browser Babel means one unbalanced tag blanks the whole app. The screenshot gate catches this.
- **PresetMenu / MoreMenu dropdown positioning**: their popover may anchor differently in the narrow sidebar than in the wide topbar. If a menu opens off-screen, that is a follow-up, not part of this scoped change — note it, don't fix inline.
- **`sidebar-foot` width**: four 28–34px icon buttons must fit the sidebar width without wrapping; `gap:6px` + small padding should fit. If it wraps at narrow sidebar widths, reduce `gap` to 4px — keep within the strip's own CSS.
