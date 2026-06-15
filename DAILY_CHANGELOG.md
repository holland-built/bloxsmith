# Daily Changelog

Append-only. Every code change gets an entry here before the task is marked done.
Format: markdown table under a `## YYYY-MM-DD — <title>` heading.

## 2026-06-15 — self-update-env-strip: don't inherit APP_VERSION from old container

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~233 | Strip image-baked env vars (APP_VERSION, PATH, PYTHON_VERSION, PYTHON_SHA256, GPG_KEY) from inherited env — new container uses new image's values |

## 2026-06-15 — self-update-stale-updater: remove existing updater container before spawning

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~278–281 | Before `containers.run(updater)`: `client.containers.get(name+"-updater").remove(force=True)` — stale exited updater blocked name reuse |

## 2026-06-15 — self-update-helper-pull: updater pulls image before starting new container

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~267 | Helper script: `c.images.pull(cfg['img'])` before `containers.run()` — prepull thread dies with old container on SIGKILL; updater must re-pull to get the new image |

## 2026-06-15 — self-update-ports-tuple-fix: restore (ip,port) tuples in helper after JSON round-trip

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~243–249 | `ports_map`: store `[ip, port]` lists (JSON-safe); helper converts back to tuples via `tuple(b)` |
| `server.py` | ~267 | Helper script: `p={k:[tuple(b) if isinstance(b,list) else b ...]}` before calling `containers.run` |

## 2026-06-15 — self-update-ports-fix: ip:port string format + named helper container

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~242–248 | `ports_map`: tuple format → `"ip:port"` strings — survives JSON round-trip, docker-py parses correctly |
| `server.py` | ~278–284 | Helper container: `name=name+"-updater"`, `remove=False` — logs readable on failure |

## 2026-06-15 — self-update-helper-container: port-safe recreate via one-shot sidecar

| File | Line(s) | Change |
|---|---|---|
| `server.py` | ~240–275 | `_do_recreate`: rename self → spawn one-shot helper container (same image + Docker socket) that waits 3s, removes retired container, starts new one; kill PID 1 so port is freed before helper wakes |
| `server.py` | ~242 | `ports_map` now preserves `HostIp` via tuple `(ip, port)` — fixes `127.0.0.1` vs `0.0.0.0` binding on macOS Docker Desktop |

## 2026-06-15 — session-summary: full update pipeline fixed end-to-end

All three update bugs resolved this session:
1. GitHub API timeout → 10s + 3-attempt retry
2. Restart loop → 60s post-startup cooldown on apply
3. Stuck spinner → instance_id restart detection + 120s hard reload
4. Update button dead → rename+run+remove(force) recreate sequence

## 2026-06-15 — self-update-recreate-fix: rename+run+remove instead of stop+remove+run

| File | Line(s) | Change |
|---|---|---|
| `server.py` | 240–257 | `_do_recreate`: replace `container.stop()+remove()+run()` with `container.rename(tmp)+run()+remove(force=True)` — new container starts before old dies; error path restores name on failure |

## 2026-06-15 — stuck-spinner-fix: instance_id restart detection + 120s hard reload

| File | Line(s) | Change |
|---|---|---|
| `server.py` | 63–64 | Added `import uuid as _uuid` + `_INSTANCE_ID = str(_uuid.uuid4())[:8]` — unique per process |
| `server.py` | ~1492 | `/api/update/status` response: `{**dict(_pull_state), "instance_id": _INSTANCE_ID}` |
| `server.py` | 145 | `update_status()` result dict: added `"instance_id": _INSTANCE_ID` key |
| `index.html` | ~3540 | `applyUpdate` poll: added `let firstId=null;`; detect `instance_id` change → reload in 2s |
| `index.html` | ~3379 | Elapsed timer: capture `el`, call `setUpdElapsed(el)`, `if(el>=120) location.reload()` |
| `test_regression.py` | added | 3 new TDD tests: `test_api_update_status_has_instance_id`, `test_api_update_check_has_instance_id`, `test_api_update_instance_id_stable` — all GREEN |

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

## 2026-06-15 — Health summary banner mockups (v1–v6)

| File | Line(s) | Change |
|---|---|---|
| `mockups/health-summary-card/health-summary-card-v1.html` | 1–54 | New — thin flat strip, green/red tint, single text line |
| `mockups/health-summary-card/health-summary-card-v2.html` | 1–68 | New — strip + domain pills, flex justify-content:space-between |
| `mockups/health-summary-card/health-summary-card-v3.html` | 1–57 | New — left-border accent, 4px severity-colored border, no tint |
| `mockups/health-summary-card/health-summary-card-v4.html` | 1–72 | New — inline dot indicators per domain, colored circles |
| `mockups/health-summary-card/health-summary-card-v5.html` | 1–62 | New — two-zone: 48px icon block + body text block |
| `mockups/health-summary-card/health-summary-card-v6.html` | 1–65 | New — segmented bar, 5-column chip grid, chips ARE the banner |

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

## 2026-06-15 — Health summary banner

| File | Line(s) | Change |
|---|---|---|
| `index.html` | 162–169 | Added `.health-banner`, `.hb-label`, `.hb-pills`, `.hb-pill` CSS with ok/warn/crit variants |
| `index.html` | 3781–3797 | Added v2-style banner above stiles — verdict left, severity pills right; wrapped stile IIFE return in `<>` fragment |
| `test_regression.py` | 1108–1128 | Added 7 health banner tests (css, ok/warn/crit variants, text, pills, aria) |

## 2026-06-15 — Drill-down for Audit + DHCP sections

| File | Line(s) | Change |
|---|---|---|
| `index.html` | 1133 | `AuditTable` — added `onDrill` prop |
| `index.html` | 1166 | `AuditTable` DataTable — wired `onRowClick` to `onDrill` |
| `index.html` | 1171 | `DhcpTable` — added `onDrill` prop |
| `index.html` | 1178 | `DhcpTable` DataTable — wired `onRowClick` to `onDrill` |
| `index.html` | 2570–2594 | `DrillSheet` — added `lease` and `audit` entity branches |
| `index.html` | 4110 | DHCP section — pass `onDrill={setDrillEntity}` to `DhcpTable` |
| `index.html` | 4233 | Audit section — pass `onDrill={setDrillEntity}` to `AuditTable` |
| `test_regression.py` | 1131–1145 | 5 drill-down tests (AuditTable prop, DhcpTable prop, lease branch, audit branch, call site) |

## 2026-06-15 — a11y + polish pass (8 fixes from /ui-ux audit)

| File | Line(s) | Change |
|---|---|---|
| `index.html` | 41 | `--fs-2xs` bumped 9px → 10px (below-readable threshold on wall display) |
| `index.html` | 179 | `.stile-desc` color `--gray-500` → `--gray-400` (contrast just below WCAG AA) |
| `index.html` | 393 | `prefers-reduced-motion` block — added `*,*::before,*::after{transition-duration:.01ms!important}` |
| `index.html` | ~1317 | `DataTable <th>` — added `aria-sort` attribute (ascending/descending/none) |
| `index.html` | ~1325 | `DataTable <tr>` — added `tabIndex={0}` + `onKeyDown` Enter/Space for keyboard drill-down |
| `index.html` | ~2484 | `DrillSheet` — added `panelRef`, focus trap (Tab/Shift-Tab), auto-focus first element, restore focus on close |
| `index.html` | ~2613 | `DrillSheet` div — added `aria-modal="true"` and `ref={panelRef}` |
| `index.html` | ~1598 | Toast — added `<span class="sr-only">` severity label (OK/Error/Warning/Info) before message |

## 2026-06-15 — LOW polish: emoji, monospace, token, aria-label

| File | Line(s) | Change |
|---|---|---|
| `index.html` | ~3828 | Health banner warning: `⚠` emoji → `!` text (no emoji icons) |
| `index.html` | ~2509 | DrillSheet `kv`: `fontFamily:'monospace'` → `fontVariantNumeric:'tabular-nums'` (one font vocabulary) |
| `index.html` | ~3845 | Stile delta chip: `rgba(239,68,68,.18)` / `rgba(34,197,94,.18)` → `--badge-red-bg` / `--badge-green-bg` tokens |
| `index.html` | ~3841 | Stile `<button>`: added `aria-label` with clean "{cat}: {sev}, {n} of {tot} — {desc}" string |
