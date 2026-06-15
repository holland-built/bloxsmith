# Topbar Overhaul — Grill-me Transcript
Date: 2026-06-15
Slug: topbar-overhaul

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Topbar controls | Keep only 3: RefreshControl + ⊕ Query + AcctPill | Max signal-to-noise; account already in sidebar |
| Removed from topbar | theme-btn, PresetMenu(★), ⌘K button, MoreMenu | Move to sidebar footer icon strip |
| Sidebar footer | Compact icon strip: theme toggle + ⌘K trigger + PresetMenu + MoreMenu | Adaptive nav — utilities live near config |
| Account duplicate | Remove `ctx-val` line 3698 from sidebar | AcctPill in topbar is the canonical account display |
| Save indicator | Toast: `toast('Layout saved ✓','ok')` auto-dismiss 2s | Uses existing toast system, no persistent UI clutter |
| Save trigger | Both `onDrop` (drag reorder) AND `moveWidget` (keyboard reorder) | Both paths mutate widgetOrder in LS |

## Open Flags
None — all branches resolved.

## Q&A Log

Q1: Direction for topbar — (A) strip to bare essentials, (B) reorganize same controls, (C) hybrid strip + move?
A: C — hybrid: strip topbar to 3, move utilities to sidebar footer

Q2: Scope — (A) topbar only, (B) topbar + sidebar footer icon strip, (C) full sidebar restructure?
A: B — topbar + sidebar footer icon strip

Q3: Save indicator after widget reorder — (A) Toast auto-dismiss 2s, (B) Persistent "saved" badge, (C) None?
A: A — Toast using existing `toast()` at line 1628

## Key Code Locations

- Topbar JSX: lines 3737–3765
- `onDrop` save: line 3226 after `LS.set('noc.widgetOrder',arr)`
- `moveWidget` save: line 3209 after `LS.set('noc.widgetOrder',arr)`
- Account duplicate to remove: line 3698 `{(accounts.find(a=>a.id===activeAcct)||{}).name||'—'}`
- Sidebar footer: line 3634+
- Toast: `toast(msg, kind)` at line 1628
- AcctPill component: existing, already in topbar
- theme-btn: `<button className="theme-btn">` in topbar JSX
- PresetMenu: `<PresetMenu/>` in topbar JSX
- MoreMenu: `<MoreMenu/>` in topbar JSX
- ⌘K button: `<button>⌘K</button>` in topbar JSX (remove button, keep keyboard shortcut handler)
