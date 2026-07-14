# Plan 022 — Topbar-right declutter (Variant A, tiered)

## Goal (success criteria)
Collapse the crowded `.topbar-right` (6 groups, ~9 controls) into **5 visible slots**:
`[ Time range ▾ ] [ bell + count ] [ Ask AI (accent) ] [ ⋯ More ] [ account ]`.
Everything rare (Watches, Views, Command palette, Display/ViewOptions, Software update/UpdateBadge)
moves **inside the ⋯ More dropdown**. Nothing loses functionality. Frontend suite stays green (107).

Single file: `index.html`. No backend change.

### Already exists — do NOT recreate (edit/relocate in place):
- `TopBar` render — `index.html:9348`; the `.topbar-right` block is ~9366-9373.
- `TimeRangeControl` `1373` (5 preset pills + All), `useTimeRange`, `TIME_PRESETS`.
- `ProblemsBadge` `9047` (renders `● {total} issues`).
- `ViewsMenu` `8839`, `WatchMenu` `8910` — these **portal into `.tools-slot`** via
  `ReactDOM.createPortal(..., document.querySelector('.tools-slot'))` at ~8805-8806, and the
  portal target is looked up **once on mount** (`useEffect` ~8700). => `.tools-slot` MUST remain
  in the DOM at mount time.
- `ViewOptions` `9134` (gear popover), `UpdateBadge` `9207` (version-chip menu), `AccountSlot` `3610`.
- `.tb-group` divider CSS `index.html:176`. `.update-menu*` / `.views-*` popover CSS already exist.

## Edits

### 1. Time range → single dropdown (`TimeRangeControl`, 1373)
Replace the pill-row return with a dropdown:
- A trigger button: label = `Last {activeLabel}` when a preset is active, else `Time range`, with a ` ▾`.
  `activeLabel` = the active preset's `.label` (from `TIME_PRESETS`, matched on `token`).
- Click toggles a small `.dt-popover`/`.update-menu`-style panel listing each `TIME_PRESETS` entry
  as a menu item (aria-current on active) + an `All` item (clears, i.e. `setRange(null)`).
- Reuse `useTimeRange()` (`token`, `setRange`). Keep the existing hover `bind` on the trigger.
- Close on item click + on outside click (reuse the `.views-overlay` pattern).

### 2. Problems → bell + count (`ProblemsBadge`, 9047)
- Keep all the counting logic + `go()` unchanged.
- Change ONLY the returned markup: replace `<span className="mono">● {total}</span> issues` with an
  **inline SVG bell** (monochrome, `stroke="currentColor"`, ~14px, `aria-hidden`) followed by
  `<span className="mono">{total}</span>`. Add class `problems-badge--bell`.
  DO NOT use the 🔔 emoji — U+1F514 is banned by `test_no_emoji_in_babel_script`. SVG only.
  Bell path (Feather "bell"): `M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9` + `M13.73 21a2 2 0 0 1-3.46 0`.
- Keep the hover `bind` tooltip (it already lists the breakdown).

### 3. Ask AI → accent (in `TopBar`)
- On the existing Ask-AI `<button className={"kbd ai-trigger"...}>`, add an accent class
  `ai-trigger--accent`. Add CSS near the topbar styles:
  `.ai-trigger--accent{background:var(--accent-bg,#132a44);border-color:var(--accent,#4a9eff);color:var(--accent-text,#bcd9ff);}`
  (use existing accent tokens if present; fall back to these). Keep `onClick={onAi}` + `⌘I`.

### 4. New `MoreMenu` component (define just above `TopBar`, ~9347)
```jsx
function MoreMenu({onPalette}){
  const {bind}=useHoverDetail();
  const [open,setOpen]=useState(false);
  useEffect(()=>{ if(!open) return; const on=e=>{ if(e.key==='Escape') setOpen(false); };
    window.addEventListener('keydown',on); return ()=>window.removeEventListener('keydown',on); },[open]);
  return <span className="more-menu" style={{position:'relative',display:'inline-flex'}}>
    <button className="kbd" aria-haspopup="menu" aria-expanded={open} aria-label="More tools"
      {...bind({title:'More',rows:[['What','Watches, Views, command palette, display settings, software update']]})}
      onClick={()=>setOpen(o=>!o)}>⋯</button>
    {/* tools-slot stays mounted ALWAYS (Watches/Views portal into it on mount); just hidden when closed */}
    <div className="more-panel panel" role="menu" style={{display:open?'block':'none'}}>
      <div className="more-row"><button className="kbd" onClick={()=>{onPalette();setOpen(false);}}>Command palette <span className="mono">⌘K</span></button></div>
      <div className="more-row tools-slot"></div>            {/* Watches + Views portal here */}
      <div className="more-row"><ViewOptions/></div>
      <div className="more-row"><UpdateBadge/></div>
    </div>
  </span>;
}
```
- The `.tools-slot` MUST stay in the DOM at all times (portal target resolves on mount), so the panel
  uses `display:none` (not conditional render) to hide — DO NOT unmount it.
- Add `.more-panel{position:absolute;top:100%;right:0;margin-top:8px;min-width:220px;padding:6px;z-index:60;}`
  and `.more-row{display:flex;align-items:center;padding:2px 0;}` to the scoped styles. Ensure the
  child popovers (WatchMenu/ViewsMenu/ViewOptions/UpdateBadge) render above via their existing
  `.views-overlay` z-index (bump `.more-panel` z-index below those overlays if needed).

### 5. Rewrite `.topbar-right` (TopBar, ~9366-9373)
Replace the 6 groups with:
```jsx
    <div className="topbar-right">
      <span className="tb-group">{fresh}<TimeRangeControl/></span>
      <span className="tb-group"><ProblemsBadge/></span>
      <span className="tb-group"><button className={"kbd ai-trigger ai-trigger--accent"+(aiOpen?" ai-trigger--open":"")} onClick={onAi} aria-label="Open AI assistant" aria-expanded={aiOpen} {...bind({title:'Ask AI  ·  ⌘I',rows:[['What','Natural-language assistant over your live NOC data'],['Shortcut','⌘I / Ctrl-I']]})}><span>Ask AI</span><span className="mono">⌘I</span></button></span>
      <span className="tb-group"><MoreMenu onPalette={onPalette}/></span>
      <span className="tb-group"><AccountSlot/></span>
    </div>
```
- Removes the standalone `tools-slot` group, the standalone `⌘K`+`ViewOptions` group, and the
  standalone `UpdateBadge` group — all now live inside `MoreMenu`. The old empty
  `<span className="tb-group tools-slot"></span>` is GONE (its role moves into MoreMenu's `.tools-slot`).

## Verify
- `python3 -m unittest test_regression.FrontendStructureTests` → OK (107). If any test asserts the
  old `tools-slot` in TopBar or a specific control order, re-point it (don't weaken).
- `grep -ac "⚙\|🔔" index.html` → 0 (no emoji; gear already SVG, bell is SVG).
- Browser (main verifies): topbar-right shows exactly 5 slots; Time-range dropdown filters; bell shows
  count + navigates; Ask AI accented; ⋯ opens a panel with Watches/Views/palette/Display/Update, each
  of whose sub-menus still open; account unchanged.
