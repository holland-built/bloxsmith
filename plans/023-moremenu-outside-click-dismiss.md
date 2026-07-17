# Plan 023: The ⋯ "More" menu closes when you click outside it

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report — do not improvise. When done, update this
> plan's status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 47568d3..HEAD -- src/96.chrome-topbar.jsx`
> If `src/96.chrome-topbar.jsx` changed since this plan was written, compare the
> "Current state" excerpt below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `47568d3`, 2026-07-16

## Why this matters

The topbar `⋯` ("More tools") menu opens a panel containing the command palette,
Watches/Views, display options, and the **software-update** control ("Update
now"). Unlike its two sibling popovers (`ViewOptions` gear and `UpdateBadge`),
it only closes on `Escape` or a second click of the `⋯` button — clicking
anywhere else on the page leaves it hanging open over the dashboard. Every other
popover in this file dismisses on outside-click; this one is the inconsistent
outlier and reads as a bug. Fixing it makes the menu behave like a standard
dropdown: click away → it closes.

## Current state

**File**: `src/96.chrome-topbar.jsx` — the whole topbar/chrome layer (no-build
React 19; this file is concatenated with the other `src/*.jsx` into
`app.bundle.js`, single global scope, **no imports/exports** — do not add any).

`MoreMenu` as it exists today (around lines 333–349):

```jsx
function MoreMenu({onPalette}){
  const [open,setOpen]=useState(false);
  useEffect(()=>{ if(!open) return; const on=e=>{ if(e.key==='Escape') setOpen(false); };
    window.addEventListener('keydown',on); return ()=>window.removeEventListener('keydown',on); },[open]);
  return <span className="more-menu" style={{position:'relative',display:'inline-flex'}}>
    <button className="kbd" aria-haspopup="menu" aria-expanded={open}
      aria-label="More tools — Watches, Views, command palette, display, software update"
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

Two facts that shape the fix:

1. **The panel is ALWAYS mounted** (the comment at the `tools-slot` line is
   load-bearing — `Watches`/`Views` portal into `.tools-slot` on mount, so the
   panel node must exist even when closed; it is only hidden via
   `display:none`). Therefore the overlay-`div` approach the siblings use is a
   poor fit here. Use a **ref + pointerdown-outside listener** instead.
2. `MoreMenu` contains `ViewOptions` and `UpdateBadge`, which each render their
   own `views-overlay` (`position:fixed;inset:0;z-index:60`) when their
   sub-popover is open. Those overlays are DOM-nested **inside** `.more-panel`,
   so a `ref.contains(target)` check treats a click on them as "inside"
   `MoreMenu` — the sub-popover closes via its own overlay while `MoreMenu`
   stays open. That is the desired behavior; the ref-based check preserves it.

**Reference pattern already in this file** — `ViewOptions` (around lines
115–139) shows the exact Escape-listener idiom this repo uses (`useEffect` gated
on `open`, `window.addEventListener('keydown', …)`, cleanup on return). Match its
style. `useState`, `useEffect`, `useRef` are available as globals in this file
(destructured from React at the top of the bundle — do not import them).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Type-check gate (mirrors CI) | `bash check.sh` | prints `✓ Type-check passed`, exit 0 |
| Build the bundle | `node scripts/build_ui.js` | prints `build_ui: app.bundle.js written…`, exit 0 |
| Confirm no import was added | `grep -nE "^import |require\(" src/96.chrome-topbar.jsx` | no output |

## Steps

### Step 1 — Add a ref + pointerdown-outside listener to `MoreMenu`

Edit `src/96.chrome-topbar.jsx`. Replace the `MoreMenu` function body's opening
(the `useState` line and the existing Escape `useEffect`) so it also closes on
an outside pointerdown. The result must be exactly:

```jsx
function MoreMenu({onPalette}){
  const [open,setOpen]=useState(false);
  const rootRef=useRef(null);
  useEffect(()=>{ if(!open) return;
    const onKey=e=>{ if(e.key==='Escape') setOpen(false); };
    const onDown=e=>{ if(rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('keydown',onKey);
    document.addEventListener('pointerdown',onDown,true);
    return ()=>{ window.removeEventListener('keydown',onKey); document.removeEventListener('pointerdown',onDown,true); };
  },[open]);
  return <span ref={rootRef} className="more-menu" style={{position:'relative',display:'inline-flex'}}>
```

Notes for the executor:
- The listener is registered in the **capture phase** (`true`) so it runs before
  React's synthetic click handlers; this is deliberate — leave the `true`.
- The `⋯` toggle button is *inside* `rootRef`, so clicking it never triggers the
  outside-close (its own `onClick` toggles). Do not add extra guards for it.
- Do NOT change the `.more-panel` "always mounted / display toggle" structure,
  the `tools-slot` div, or the `ViewOptions`/`UpdateBadge` children. Only the
  four lines shown above change (add `rootRef`, expand the `useEffect`, add
  `ref={rootRef}` to the `<span>`).

### Step 2 — Build and type-check

```
node scripts/build_ui.js
bash check.sh
```

Both must exit 0. `check.sh` must print `✓ Type-check passed`.

### Step 3 — Confirm the wiring landed

```
grep -nE "rootRef|pointerdown" src/96.chrome-topbar.jsx
```

Expected: the `rootRef` declaration, the `pointerdown` add/removeEventListener
lines, and `ref={rootRef}` on the `.more-menu` span — all present.

## Done criteria (machine-checkable)

- `bash check.sh` exits 0 with `✓ Type-check passed`.
- `node scripts/build_ui.js` exits 0.
- `grep -c "pointerdown" src/96.chrome-topbar.jsx` returns `2` (add + remove).
- `grep -nE "^import |require\(" src/96.chrome-topbar.jsx` prints nothing.
- The `.more-panel` still renders with `display:open?'block':'none'` (unchanged)
  and still contains the `tools-slot` div: `grep -c "tools-slot" src/96.chrome-topbar.jsx` returns `2`.

## Manual smoke (for the reviewer, not required to pass the gate)

Load the dashboard, click `⋯` to open the More menu, then click anywhere on the
page outside the menu → it closes. Press `Escape` while open → it closes. Open
the menu, click "Update now"'s **Check now** inside it → the More menu stays open
(inner interaction), and the update sub-popover behaves as before.

## Test plan

This repo's automated coverage is Playwright specs under `tests/` run via
`scripts/e2e.sh` (needs `.env` with `INFOBLOX_API_KEY`; not run here). No
existing spec targets the More menu. Optional: add `tests/more-menu-dismiss.spec.ts`
modeled on the interaction style of an existing topbar spec (e.g.
`tests/command-palette.spec.ts`) — open `.more-menu` via its `⋯` button, click
`body`, assert `.more-panel` computed `display` is `none`. Only add this if the
harness is available; do not block the plan on it.

## STOP conditions

- If `MoreMenu` no longer exists or has been substantially restructured (drift
  check shows changes) — STOP and report; do not guess a new insertion point.
- If `useRef` is not already available as a global in the bundle (i.e. adding
  `useRef(null)` makes `check.sh` fail with "useRef is not defined") — STOP and
  report; do not add an import (that breaks the no-build single-scope model).

## Maintenance note

Future review: any new topbar popover should follow one of two dismiss patterns —
the `views-overlay` div (for popovers whose panel mounts only when open) or this
ref + capture-phase pointerdown (for always-mounted panels). Reviewers should
reject a new dropdown that has neither.

## Out of scope (do not touch)

- `server.py`, any `/api/*` endpoint, `ViewOptions`, `UpdateBadge`, `AccountSlot`.
- The update flow logic, the rollback banner, any CSS.
- Any file other than `src/96.chrome-topbar.jsx`.
