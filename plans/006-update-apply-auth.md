# Plan 006: Guard /api/update/apply and /api/update/rollback-clear with auth

> **Executor instructions**: Follow step by step. Run every verification before
> moving on. Hit any STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 5058ed6..HEAD -- server.py`
> Compare "Current state" excerpts against live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `5058ed6`, 2026-06-29

## Why this matters

`/api/update/apply` triggers a Docker container self-update. Its guard is `if VAULT_MODE and not MCP_HEADERS.get("Authorization")` — in **single-key mode** (`VAULT_MODE=False` when `INFOBLOX_API_KEY` env var is set), the check is skipped entirely. Any caller who can reach the server can trigger a container restart.

`/api/update/rollback-clear` has **no guard at all**.

The correct pattern for destructive endpoints in this codebase is `if not MCP_HEADERS.get("Authorization") and not self._authed()` — used by `/api/vault/reset` at line 1814. Apply this same pattern to both update endpoints.

## Current state

**Affected code at `server.py:1817-1824`**:
```python
if self.path == "/api/update/rollback-clear":
    with _pull_lock:
        _pull_state.update(rolledback=False, rollback_from=None, rollback_to=None)
    self._json({"ok": True}); return
if self.path == "/api/update/apply":
    if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
        self._json({"error": "vault locked", "locked": True}, 503); return
    self._json(apply_self_update()); return
```

**Reference pattern at `server.py:1813-1816`** — use this exact guard:
```python
if not MCP_HEADERS.get("Authorization") and not self._authed():
    self._json({"ok": False, "error": "unauthorized"}, 401); return
```

`_authed()` at line 1612: checks `DASHBOARD_TOKEN` env var via constant-time compare. Returns `False` if `DASHBOARD_TOKEN` not set (single-key/vault deployments without a token still work — they rely on `MCP_HEADERS["Authorization"]` being non-empty).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Run tests | `python test_regression.py` (server running) | All pass |
| Confirm guard | `grep -A3 "update/apply" server.py` | Shows `_authed` guard |

## Scope

**In scope**: `server.py` lines 1817-1824 only. `test_regression.py` — new tests.

**Out of scope**: `index.html`, `_authed`, `apply_self_update`, all other endpoints.

## Git workflow

- Commit: `fix: guard update/apply and rollback-clear with vault/DASHBOARD_TOKEN auth`

## Steps

### Step 1: Replace the update endpoint guards

Replace block at `server.py:1817-1824`:

```python
if self.path == "/api/update/rollback-clear":
    with _pull_lock:
        _pull_state.update(rolledback=False, rollback_from=None, rollback_to=None)
    self._json({"ok": True}); return
if self.path == "/api/update/apply":
    if VAULT_MODE and not MCP_HEADERS.get("Authorization"):
        self._json({"error": "vault locked", "locked": True}, 503); return
    self._json(apply_self_update()); return
```

With:

```python
if self.path == "/api/update/rollback-clear":
    if not MCP_HEADERS.get("Authorization") and not self._authed():
        self._json({"ok": False, "error": "unauthorized"}, 401); return
    with _pull_lock:
        _pull_state.update(rolledback=False, rollback_from=None, rollback_to=None)
    self._json({"ok": True}); return
if self.path == "/api/update/apply":
    if not MCP_HEADERS.get("Authorization") and not self._authed():
        self._json({"ok": False, "error": "vault locked", "locked": True}, 401); return
    self._json(apply_self_update()); return
```

`"locked": True` is preserved in the update/apply response for frontend backward compatibility.

**Verify**: `grep -A2 '"update/apply"' server.py` → shows `_authed` check before `apply_self_update()`.

## Test plan

Add to `test_regression.py`:
```python
def test_update_apply_requires_auth(self):
    """update/apply must reject unauthenticated callers (vault locked, no DASHBOARD_TOKEN)."""
    resp = requests.post(f"{BASE}/api/update/apply", json={}, timeout=5)
    self.assertNotEqual(resp.status_code, 200)
```

## Done criteria

- [ ] `grep -A2 '"update/rollback-clear"' server.py` → `_authed` guard before `_pull_lock`
- [ ] `grep -A2 '"update/apply"' server.py` → `_authed` guard before `apply_self_update`
- [ ] No `VAULT_MODE` reference in update/apply handler
- [ ] `python test_regression.py` exits 0
- [ ] Only `server.py` and `test_regression.py` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Code at 1817-1824 doesn't match excerpts (drift).
- Frontend update button fetch call breaks (it may need `X-Auth-Token` header added — stop and report).
- `_authed()` is not accessible in `do_POST` scope.

## Maintenance notes

- If `DASHBOARD_TOKEN` is set in a LAN deployment, the frontend must send `X-Auth-Token` with update requests.
- In vault mode (default Docker), vault unlock populates `MCP_HEADERS["Authorization"]` — no frontend change needed.
