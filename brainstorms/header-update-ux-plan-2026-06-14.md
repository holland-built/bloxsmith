# Implementation Plan — header-update-ux (2026-06-14)

`ui_change: true`

## Target files
- `index.html` — **the only file that changes** (single-file React SPA)
- Do NOT touch `server.py`, `test_regression.py`, or any other file.

**already exists — do NOT recreate: `index.html`.** All edits are surgical, in-place modifications to the existing file. Do not regenerate the file.

## Goal
Kill the full-width `UpdateBar` top strip. Move update progress *inline into the existing version chip* in the sidebar footer. While an update runs the chip expands to show the mapped step name + spinner + small muted elapsed timer. When phase=`live`, show "✓ Updated to vX.Y.Z" green for ~3s then `window.location.reload()`. No cancel button.

## Verified current code (read before planning)
- `UpdateBar` component def: lines **2984–3038**.
- `UpdateBar` render usage: line **3507** — `{updApplying&&updPhase&&<UpdateBar .../>}`.
- Version chip (`.ver-badge`) render: lines **3543–3548** (note: it is class `ver-badge`, in `.sidebar-foot`, NOT `ver-chip`). Popover follows at 3549+.
- `updApplying`/`updPhase`/`updStatus`/`updStart` state: declared ~3112–3114+ (`updApplying` at 3114).
- Poll loop already does `location.reload()` on `phase==='live'` at line **3483** — this needs to change to honor the 3s success-state delay.
- `cancelUpdate` helper: line **3504** — becomes unused after removal.
- `.upd-bar*` CSS: lines **479–499**. `.upd-spin` keyframe-using spinner at line **477** is shared/reused — KEEP it.

---

## Ordered steps (one Sonnet agent, one file)

### Step 1 — Add `.ver-badge` expanded-state CSS
**Where:** insert right after line 478 (`.upd-note{...}`), before the `.upd-bar` block at 479.
**What:** add `.ver-badge-upd` (or `.ver-badge.updating`) styles for the inline expanded chip: `inline-flex; align-items:center; gap:6px;` amber-tinted bg/border, tabular-nums, small reused `.upd-spin`. Add a `.ver-badge-step` (step name, weight 600) and `.ver-badge-elapsed` (10px, `var(--gray-400)`, muted, tabular-nums) and `.ver-badge-done` (green text, for the success state). Reuse existing `--green-text`/`--amber`/`--gray-400` tokens — no new color tokens (COLOR_CONTRACT: status bucket).
**Do NOT:** touch `.ver-badge`, `.ver-up-arrow`, `.upd-pop`, `.upd-actions`, `.upd-note`, `.upd-spin` (line 477), or `@keyframes spin`.

### Step 2 — Delete `.upd-bar*` CSS
**Where:** lines **479–499** (`.upd-bar` through the `@media(prefers-reduced-motion)` `.upd-bar-spin` rule).
**What:** remove `.upd-bar`, `.upd-bar-steps`, `.upd-bar-step*`, `.upd-bar-detail`, `.upd-bar-conn`, `.upd-bar-right`, `.upd-bar-elapsed`, `.upd-bar-cancel`, `.upd-bar-stalled`, and the reduced-motion `.upd-bar-spin` rule.
**Do NOT:** delete line 477 `.upd-spin` or line 478 `.upd-note` — both reused elsewhere. Keep `.panel-error` block (line 500+) intact.

### Step 3 — Phase→step-name mapping helper
**Where:** inside `App`, near the other update logic (e.g. just before `cancelUpdate` ~3504), or inline in the chip render.
**What:** add a pure function mapping phase to label:
- `prepulling` | `pulling` → `"Downloading"` (+ progress when available: ``Downloading ${pct}%`` and, if `layer_total>0`, ` · layer ${layer_current}/${layer_total}` → e.g. `Downloading 34% · layer 2/5`)
- `pulled` → `"Downloading ✓"`
- `recreating` → `"Restarting"`
- `health` → `"Checking"`
- `live` → `"Live"`
- fallback → `"Updating…"`
**Do NOT:** change phase strings the server emits; only map for display.

### Step 4 — Expand the version chip during update
**Where:** the `.ver-badge` span render, lines **3543–3548**.
**What:** when `updApplying && updPhase`, render the chip in expanded form: `[spinner] <step name> <elapsed>` + the version (`v{vault.version}`). Add an `elapsed` value driven off `updStart` (1s `setInterval`, same `fmt` logic as old `UpdateBar`: `s<60?`${s}s`:`${m}m ${r}s``). Keep the normal chip (version + up-arrow + popover toggle) when not updating. Add `aria-live="polite"` to the expanded chip for screen readers.
**Do NOT:** break the non-update chip render, the `onClick`/`onKeyDown` popover toggle, or `upd.available` arrow display. Keep the popover (3549+) working.

### Step 5 — Post-update success state + delayed reload
**Where:** the poll loop `if(s.phase==='live'){ location.reload(); return; }` at line **3483**.
**What:** instead of immediate reload, set a success flag (e.g. `setUpdPhase('live')` already happens; add an `updDone` state holding the version `upd.latest`). The chip shows `✓ Updated to v{upd.latest}` in green (`.ver-badge-done`), then `setTimeout(()=>window.location.reload(), 3000)`. Use `upd.latest` for the version (strip leading `v` consistently with existing `.replace(/^v/,'')`).
**Do NOT:** remove `error`-phase handling at line 3484. Keep the apply POST + poll bootstrap (3489–3491) intact.

### Step 6 — Remove `UpdateBar` usage and component
**Where:** render usage line **3507**; component def lines **2984–3038**.
**What:** delete the `{updApplying&&updPhase&&<UpdateBar .../>}` render at 3507, then delete the entire `UpdateBar` function (2984–3038). Remove the now-unused `cancelUpdate` helper (3504). Update the popover copy at lines **3559** and **3564** that references "see the bar at the top of the page" / "Progress shown in a bar at the top." → reword to "Progress shows on the version badge." (or similar).
**Do NOT:** remove `updApplying`/`updPhase`/`updStatus`/`updStart` state or the poll loop — they now feed the chip. Do this step LAST so Steps 1–2 CSS removal doesn't strand the component.

---

## Verify (required before done)
- Hotpatch: `docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`
- Screenshot: headless Chrome `--screenshot=_proof.png "http://localhost:8080"` (confirm chip renders normally; no top strip).
- Run: `python -m pytest test_regression.py -v` (must stay green).
- Append a `DAILY_CHANGELOG.md` entry (table: File / Line(s) / Change) under a `## 2026-06-14 — header-update-ux` heading.

## Downstream dispatch (cap ~300 words)
One `frontend-developer`/Sonnet agent does all six steps in `index.html`. Brief it with: the "already exists — do NOT recreate" note, the verified line numbers above, the keep-list (`.upd-spin` L477, `.upd-note` L478, `@keyframes spin`, all state vars, poll loop, popover), and the verify checklist. Cap its report at ~300 words.
