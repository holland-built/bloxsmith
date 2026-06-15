# Daily Changelog

Append-only. Every code change gets an entry here before the task is marked done.
Format: markdown table under a `## YYYY-MM-DD — <title>` heading.

## 2026-06-14 — header-update-ux: inline ver-badge replaces UpdateBar strip

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~479–499 | Deleted `.upd-bar` through `@media prefers-reduced-motion upd-bar-spin` CSS (21 lines) |
| `index.html` | ~479 | Added `.ver-badge.updating`, `.ver-badge.updating .upd-spin`, `.ver-badge.upd-done`, `.ver-upd-elapsed` CSS rules |
| `index.html` | ~3114 | Added `updDone` and `updElapsed` useState after `updApplying` |
| `index.html` | ~3319 | Added `useEffect` for per-second elapsed ticker keyed on `updApplying` + `updStart` |
| `index.html` | ~3483 | `s.phase==='live'` → `setUpdDone(true); setUpdApplying(false); setTimeout(reload,3000)` |
| `index.html` | ~3504–3507 | Deleted `cancelUpdate` const and `<UpdateBar …/>` JSX |
| `index.html` | ~2984–3038 | Deleted entire `function UpdateBar(…)` component |
| `index.html` | ~3543–3547 | Replaced static ver-badge span with 3-state IIFE: `updDone` → green chip; `updApplying&&updPhase` → amber spinning chip with stepName + elapsed; idle → original clickable badge |
| `index.html` | ~3559, ~3564 | Updated popover copy: "bar at the top" → "version chip below" / "version chip" |

## 2026-06-14 — Alert rules editor (inline-edit + default rules)

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~2626 | Added `DEFAULT_ALERT_RULES` const (3 seeded rules: offline_hosts, critical_subnets, audit_failures ≥ 1) |
| `index.html` | ~3084 | Root `alertRules` useState fallback `[]` → `DEFAULT_ALERT_RULES` |
| `index.html` | ~2649 | `AlertsPanel`: added `editId`, `editVals` state; updated `del` to clear editId; added `startEdit`, `saveEdit`, `cancelEdit` helpers |
| `index.html` | ~2681 | Table row: conditional render — edit mode shows inline selects + input with teal left-border + hover bg (v2); read mode shows ✎ button before ✕ |
| `test_regression.py` | ~623 | Added 4 new tests: `test_default_alert_rules_const`, `test_default_alert_rules_seeded`, `test_alert_rules_inline_edit_state`, `test_alert_rules_edit_button` |

## 2026-06-15 — Multi-tenant switcher toolbar pill

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~294 | Added `.acct-pill`, `.acct-pill-cap`, `.acct-pill-name`, `.acct-menu.down`, `.acct-pill-prefix` CSS (8 rules) |
| `index.html` | ~1415 | Added `AcctPill` component: V4 labeled pill, two-section popover (This login / Other logins), vault/non-vault modes, hide guard |
| `index.html` | ~3679 | Inserted `<AcctPill .../>` immediately before `<MoreMenu .../>` in toolbar |
| `test_regression.py` | ~1082 | Added 8 tests: `test_acct_pill_component_exists`, `test_acct_pill_hide_guard`, `test_acct_pill_cap_label`, `test_acct_pill_this_login_section`, `test_acct_pill_other_logins_section`, `test_acct_pill_manage_keys_link`, `test_acct_pill_switch_key_api`, `test_acct_pill_in_toolbar` |

## 2026-06-14 — Keyboard shortcuts + CSV export

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~3255 | Added `SECTION_EXPORT_MAP` const mapping 9 section ids → export names |
| `index.html` | ~3270 | Added `t` key handler → theme cycle (with input-focus guard) |
| `index.html` | ~3274 | Added `e` key handler → section-aware CSV export via `data-export-section` DOM attr |
| `index.html` | ~1290 | DataTable CSV button: added `data-export-section={exportName}` attr |
| `index.html` | ~1086 | PoliciesPanel: added CSV header button with `data-export-section="security-policies"` |
| `index.html` | ~4184 | Shortcuts panel: rewrote flat list → 2-column grid (Navigation+UI left, Actions right) with `t`/`e` bindings documented |
| `test_regression.py` | ~820 | Added 6 new tests: `test_shortcuts_section_export_map`, `test_shortcuts_t_key_theme`, `test_shortcuts_e_key_export`, `test_shortcuts_data_export_attr`, `test_shortcuts_policies_csv`, `test_shortcuts_panel_grouped` |

## 2026-06-14 — Move auto-refresh interval picker into ⋯ menu

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~1366 | `RefreshControl`: removed `setAutoRefresh` prop, `open` state, `OPTS` array, caret button, dropdown panel |
| `index.html` | ~1395 | `RefreshControl`: added standalone ⏸/▶ pause button (shown only when `autoRefresh>0`) |
| `index.html` | ~1443 | `MoreMenu`: added `autoRefresh`, `setAutoRefresh` props; added `arOpts`, `nextAr`, `arLbl` helpers |
| `index.html` | ~1454 | `MoreMenu`: added cycling-pill "Auto-refresh · {value} ▾" row as first menu item |
| `index.html` | ~3645 | `<RefreshControl>` call: removed `setAutoRefresh` prop |
| `index.html` | ~3655 | `<MoreMenu>` call: added `autoRefresh` + `setAutoRefresh` props |
| `test_regression.py` | ~791 | Replaced `test_auto_refresh_selector` (checked removed `.auto-refresh-sel` class) with `test_auto_refresh_in_more_menu` (checks MoreMenu signature) |
| `test_regression.py` | ~796 | Added `test_auto_refresh_pill_cycles_in_more_menu` (checks `arOpts` present) |

## 2026-06-14 — Docker SDK self-update (drop Watchtower)

| File | Line(s) | Change |
|---|---|---|
| `requirements.txt` | 7 | Added `docker==7.1.0` |
| `server.py` | 66-86 | Replaced Watchtower globals with `_docker_client()`, `DOCKER_OK`, `_pull_state` dict, `_pull_lock` |
| `server.py` | 113-145 | `update_status()` — uses `DOCKER_OK`, auto-kicks `_run_prepull` when update available + phase idle |
| `server.py` | 147-213 | New `_run_prepull()` — background Docker pull with real layer progress streaming |
| `server.py` | 215-257 | New `apply_self_update()` — inspect self, return HTTP, recreate in detached thread |
| `server.py` | 1365-1367 | New `GET /api/update/status` route returning `_pull_state` |
| `server.py` | 1474-1475 | `trigger_self_update()` → `apply_self_update()` |
| `run-image.sh` | 57-65 | Replaced Watchtower block with `DOCKER_SOCK_MOUNT` gate (`NO_DOCKER_SOCKET=1` opt-out) |
| `run-image.sh` | ~90 | `SELF_UPDATE_ENV` → `DOCKER_SOCK_MOUNT` in `docker run` |
| `run-image.sh` | 94-111 | Deleted Watchtower sidecar launch block |
| `index.html` | 479-499 | Replaced flat `.upd-bar` CSS with 21-line stepper CSS (V5 variant) |
| `index.html` | 2969-3010 | Rewrote `UpdateBar` as 4-step stepper (Pull→Recreate→Health→Live), icons + spinner |
| `index.html` | ~3062 | Added `updStatus` state |
| `index.html` | 3417-3442 | `applyUpdate()` — polls `/api/update/status` for real phases, drops elapsed-time heuristics |
| `index.html` | ~3457 | `<UpdateBar>` passes `pct`, `layer_current`, `layer_total`, `stalled` from `updStatus` |
| `test_regression.py` | 302-320 | Added `test_api_update_status_shape` + `test_api_update_check_has_self_update_field` |

| File | Line(s) | Change |
|------|---------|--------|

---

## 2026-06-14 — UpdateBar 4-step stepper + /api/update/status polling

| File | Line(s) | Change |
|------|---------|--------|
| `index.html` | 479–484 | Replaced flat `.upd-bar` CSS with stepper CSS (`.upd-bar-steps`, `.upd-bar-step`, `.upd-bar-step-icon`, `.upd-bar-conn`, `.upd-bar-right`, `.upd-bar-stalled`, etc.) |
| `index.html` | 2969–2985 | Rewrote `UpdateBar` component as 4-step stepper (Pull → Recreate → Health → Live) with spinner on active step, ✓ on done steps, detail/stalled callouts |
| `index.html` | ~3062 | Added `const [updStatus, setUpdStatus] = useState({})` state |
| `index.html` | 3417–3442 | Rewrote `applyUpdate()` to poll `/api/update/status` (replaces elapsed-time heuristics), wires `setUpdStatus(s)` for pct/layer/stalled props |
| `index.html` | ~3457 | Updated `UpdateBar` render call to pass `pct`, `layer_current`, `layer_total`, `stalled` from `updStatus` |

---

## 2026-06-13 — fix /admin 404 (SPA fallback)

| File | Line(s) | Change |
|------|---------|--------|
| `server.py` | do_GET | Added SPA fallback: non-API paths that aren't static files now serve `index.html` instead of 404 |

---

## 2026-06-13 — drill-down completeness: feed + policy rows

| File | Line(s) | Change |
|------|---------|--------|
| `index.html` | DrillSheet | Added `type:'feed'` case — name, category, threat level badge, confidence, entries, status badge |
| `index.html` | DrillSheet | Added `type:'policy'` case — name, action badge, rules count, created, status badge |
| `index.html` | FeedsTable | Added `onDrill` prop; wired `onRowClick` on DataTable |
| `index.html` | PoliciesPanel | Added `onDrill` prop; wired `onClick`+`cursor:pointer` on `renderPol` div |
| `index.html` | 4 call sites | Passed `onDrill={d=>setDrillEntity(d)}` to both PoliciesPanel and FeedsTable usages |

---

## 2026-06-12 — Sprint: wizard, update bar, severity ribbon removal

| File | Line(s) | Change |
|------|---------|--------|
| `index.html` | ~2361-2406 | Add `DashboardWizard` component — two-tab first-run setup (Overview Widgets, Nav Sections), ▲▼ reorder, Visible/Hidden toggle, stored to `localStorage` |
| `index.html` | ~2951-2967 | Add `UpdateBar` component — fixed amber bar, phase labels (triggered/pulling/offline/reconnecting), elapsed timer, cancel button |
| `index.html` | ~3399-3424 | Rewrite `applyUpdate()` — state machine with `wasOffline` flag, no timeout, polls every 2s |
| `index.html` | various | Remove severity ribbon — deleted 6 CSS rules + JSX IIFE (redundant with per-row severity badges) |

## 2026-06-13 — Project scaffolding from Wayfinder best practices

| File | Line(s) | Change |
|------|---------|--------|
| `AGENTS.md` | new | Agent operating rules adapted for single-file React + Python stack |
| `DAILY_CHANGELOG.md` | new | Append-only change log (this file) |
| `.claude/skills/diagnose/SKILL.md` | new | 6-phase systematic bug diagnosis skill |
| `.claude/skills/grill-me/SKILL.md` | new | Pre-build planning interview skill |
| `.claude/skills/prove/SKILL.md` | new | Evidence-based completion verification skill |
| `.claude/skills/tdd/SKILL.md` | new | Vertical-slice TDD skill (adapted for pytest + headless Chrome) |
| `.claude/skills/layout-stress/SKILL.md` | new | Layout-composition robustness testing skill |
| `CLAUDE.md` | all | Added lazy-read table, log-every-change rule, verify rule, drift checks, skills reference |

## 2026-06-15 — Multi-Tenant Switcher V4 two-section popover mockup

| File | Line(s) | Change |
|---|---|---|
| `mockups/multi-tenant-switcher/multi-tenant-switcher-all.html` | all | Replaced 5-variant pill comparison page with focused 3-scenario V4 + two-section popover mockup: vault multi-key (S1, with search + THIS LOGIN / OTHER LOGINS sections), vault single-key (S2, no OTHER LOGINS), non-vault env key (S3, flat list only). Added `--sev-red-t` / `--sev-green-t` tokens. Scenario cards with thin rgba dividers, independent click-to-toggle popovers. |

## 2026-06-15 — Restore /ui-ux skill

| File | Line(s) | Change |
|---|---|---|
| `.claude/skills/ui-ux/` | — | Copied from `~/.claude/skills/ui-ux-pro-max/`; renamed dir to `ui-ux` so `/ui-ux` resolves |
| `SKILLS.md` | 9, 41, 54 | Updated all `ui-ux-pro-max` references to `ui-ux` |
