# Plan 010: Guard _csp_json return type — json.loads can return list, callers call .get()

> **Executor instructions**: Follow step by step. Run every verification.
> STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 6f42354..HEAD -- server.py`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug/correctness
- **Planned at**: commit `6f42354`, 2026-06-29

## Why this matters

`_csp_json` returns `json.loads(r.read())` with return type annotation `-> dict`. But `json.loads` can return any JSON type — list, string, int, null — depending on what the API sends. All three callers immediately call `.get()` on the result:

- `server.py:512` — `_csp_json("/v2/current_user/accounts").get("results", [])`
- `server.py:518` — `_csp_json("/v2/current_user").get("result", {}).get("account_id", "")`
- `server.py:535` — `resp = _csp_json(...)` (then `.get()` downstream)

If the API returns a list (e.g. on auth failure or unexpected schema change), calling `.get()` on a list raises `AttributeError`, crashing the thread with no HTTP response to the caller.

Fix: add a type guard inside `_csp_json` itself — if the parsed result is not a dict, return `{}`. Callers get an empty dict and follow their existing fallback paths (`get("results", [])` → empty list, etc.).

## Current state

**File**: `server.py`

**Affected code at `server.py:498-507`**:
```python
def _csp_json(path: str, body: dict | None = None) -> dict:
    """Small sync helper for CSP identity endpoints. Always authenticates with
    the original long-lived key so an expired account JWT can't lock us out."""
    from urllib.request import urlopen, Request
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{BASE_URL}{path}", data=data,
                  headers={"Authorization": API_KEY,
                           "Content-Type": "application/json"})
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())
```

**Callers**:
```python
# server.py:511-512
accounts = [{"id": a.get("id", ""), "name": a.get("name", "")}
            for a in _csp_json("/v2/current_user/accounts").get("results", [])

# server.py:518
home = _csp_json("/v2/current_user").get("result", {}).get("account_id", "")

# server.py:535
resp = _csp_json("/v2/session/account_switch", {"id": account_id})
```

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Verify guard | `grep -n "isinstance.*dict" server.py` | 1 match inside `_csp_json` |
| Compile check | `python3 -m py_compile server.py && echo OK` | `OK` |

## Scope

**In scope**: `server.py` — `_csp_json` function only (lines 498-507). Do NOT touch callers.

**Out of scope**: `index.html`, callers of `_csp_json`, any other function.

## Git workflow

- Commit: `fix: _csp_json type guard — return {} if API returns non-dict (prevents AttributeError)`

## Steps

### Step 1: Add isinstance guard before returning

Replace the last line of `_csp_json` at `server.py:507`:
```python
    with urlopen(req, timeout=15) as r:
        return json.loads(r.read())
```

With:
```python
    with urlopen(req, timeout=15) as r:
        result = json.loads(r.read())
        return result if isinstance(result, dict) else {}
```

**Verify**: `grep -n "isinstance.*dict" server.py` → 1 match inside `_csp_json`.

### Step 2: Compile check

```bash
python3 -m py_compile server.py && echo OK
```

Expected: `OK` with no output.

## Done criteria

- [ ] `grep -n "isinstance.*dict" server.py` → 1 match on the return line of `_csp_json`
- [ ] `python3 -m py_compile server.py` exits 0
- [ ] Only `server.py` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Code at `server.py:498-507` doesn't match excerpt (drift).
- `_csp_json` already has a type guard (check before editing).
- Callers of `_csp_json` wrap in try/except that already handles AttributeError — in that case the guard is still good to add (defense in depth), proceed.

## Maintenance notes

- If `_csp_json` is ever extended to support list-returning endpoints, the `isinstance` guard would need to change to a union check or be removed. The current callers only expect dicts, so `{}` fallback is correct for all three.
