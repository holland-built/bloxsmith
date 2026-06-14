# Docker SDK Self-Update — Implementation Plan — 2026-06-14

`ui_change: true`

## Files changing

| File | Change |
|---|---|
| `requirements.txt` | add `docker==7.1.0` |
| `server.py` | remove Watchtower globals/funcs; add pull-state dict + background pull thread; rewrite update funcs; add `/api/update/status` GET; rewrite `/api/update/apply` POST; auto-kick pre-pull on `available=true` |
| `run-image.sh` | delete Watchtower block; add gated `-v /var/run/docker.sock:/var/run/docker.sock`; rename env var; fix footer copy |
| `index.html` | rewrite `UpdateBar` as 4-step stepper; rewrite `applyUpdate()` to poll `/api/update/status` |
| `DAILY_CHANGELOG.md` | append table entry |

## Step order (A-D concurrent → E verify → F changelog)

- **A** `requirements.txt` — append `docker==7.1.0`
- **B** `server.py` — backend rewrite (independent of UI)
- **C** `run-image.sh` — strip Watchtower, add socket mount (independent of B)
- **D** `index.html` — UpdateBar stepper + applyUpdate() poll rewrite (independent of B/C)
- **E** Verify — build image, run, curl status, screenshot, pytest
- **F** DAILY_CHANGELOG.md — append

## Status-dict contract (all subagents must use this exact shape)

`GET /api/update/status` returns:
```json
{ "phase": "idle|prepulling|pulled|recreating|health|live|error",
  "pct": 0-100,
  "layer_current": int,
  "layer_total": int,
  "stalled": bool,
  "error": null|string }
```

`/api/update/check` keeps existing shape; `selfUpdate` field now reflects `DOCKER_OK` bool.

## Key risk

`apply_self_update()` kills the process serving its own request. Must:
1. Return HTTP response first
2. Stop/remove/run in a **detached daemon thread**
3. Copy full env + ports + volumes + restart policy + network + name from `docker inspect`

## Subagent briefs

### Subagent B — server.py
already exists — do NOT recreate: `server.py` (1640 lines). Edit only:
- L66-73: delete Watchtower globals. Add lazy `_docker_client()` helper + `DOCKER_OK` bool. Add `_pull_state` dict (init `phase="idle"`) + `_pull_lock`.
- L123-137: rename/rewrite `trigger_self_update()` → `apply_self_update()`. Uses Docker SDK: inspect self via `HOSTNAME` → pull stream → phase/pct/layer → recreate in detached thread.
- L113-121: `update_status()` — replace `SELF_UPDATE` with `DOCKER_OK`. Auto-kick background pre-pull when `available=True` and phase is `idle`.
- After `/api/update/check` GET handler: add `/api/update/status` returning `dict(_pull_state)`.
- POST handler L1474-1475: `apply_self_update()`.

### Subagent C — run-image.sh
already exists — do NOT recreate: `run-image.sh` (~130 lines). Edit only:
- L57-77: delete Watchtower block. Replace with `DOCKER_SOCK_MOUNT=()` array gated on `NO_DOCKER_SOCKET=1`.
- L90: replace Watchtower env flags with `${DOCKER_SOCK_MOUNT[@]+"${DOCKER_SOCK_MOUNT[@]}"}`.
- L94-111: delete Watchtower-launch block.
- L123-129: drop `$WT_NAME` refs, update footer copy.

### Subagent D — index.html
already exists — do NOT recreate: `index.html` (4224 lines). Edit only:
- L2969-2985 `UpdateBar`: rewrite as 4-step stepper (Pull → Recreate → Health → Live). Pull step shows `67% · layer 4/6`. `stalled` → "still working…". Add stepper CSS reusing existing tokens.
- L3416-3442 `applyUpdate()`: delete elapsed-time heuristics. Poll `/api/update/status` every 1.5s → drive phase from server truth. `phase==="live"` → `location.reload()`. Keep cancel semantics.
- L3457: pass new status props to `<UpdateBar/>`.
