# Plan 005: Fix Content-Length validation — DoS and thread-crash vectors in server.py

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
- **Category**: security/bug
- **Planned at**: commit `5058ed6`, 2026-06-29

## Why this matters

`do_POST` reads `Content-Length` as a raw `int` without validation. Two bugs:

1. **No lower-bound check**: `Content-Length: -1` makes `length = -1`. The guard `if length > self.MAX_BODY` passes (`-1 > 65536` is False). `self.rfile.read(-1)` reads the socket until EOF — memory DoS, thread hangs indefinitely.

2. **No try/except around `int()`**: A non-numeric `Content-Length` (e.g. `"abc"`) raises `ValueError` before any HTTP response is written. The thread crashes silently; the client receives no response and hangs.

Both are exploitable by any caller who can reach the server.

## Current state

**File**: `server.py` (~1000-line Python ThreadedHTTPServer)

**Affected code at `server.py:1756-1764`**:
```python
def do_POST(self):
    length = int(self.headers.get("Content-Length", 0))
    if length > self.MAX_BODY:
        self.send_error(413, "Request Too Large")
        return
    try:
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
    except (json.JSONDecodeError, ValueError):
        self._json({"error": "invalid JSON body"}, 400); return
```

`MAX_BODY = 64 * 1024` is a class-level constant at line 1754.
`self._json(data, status)` is an instance helper method defined elsewhere in the Handler class — use it for error responses.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Run tests | `python test_regression.py` (server running) | All pass |
| Manual DoS test | `curl -s -X POST http://localhost:8080/api/data -H "Content-Length: -1" -d "" -m 3` | Response within 3s |
| Manual crash test | `curl -s -X POST http://localhost:8080/api/data -H "Content-Length: abc" -d "" -m 3` | 400 response |

## Scope

**In scope**: `server.py` — `do_POST` method only; `test_regression.py` — new tests only.

**Out of scope**: `do_GET`, `do_OPTIONS`, `index.html`, anything else.

## Git workflow

- Commit: `fix: validate Content-Length in do_POST — reject negative and non-numeric values`

## Steps

### Step 1: Add lower-bound check and try/except around int()

Replace the current `do_POST` opening at `server.py:1756-1764`:

```python
def do_POST(self):
    length = int(self.headers.get("Content-Length", 0))
    if length > self.MAX_BODY:
        self.send_error(413, "Request Too Large")
        return
    try:
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
    except (json.JSONDecodeError, ValueError):
        self._json({"error": "invalid JSON body"}, 400); return
```

With:

```python
def do_POST(self):
    try:
        length = int(self.headers.get("Content-Length", 0))
    except (ValueError, TypeError):
        self._json({"error": "invalid Content-Length"}, 400); return
    if length < 0 or length > self.MAX_BODY:
        self.send_error(413, "Request Too Large")
        return
    try:
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
    except (json.JSONDecodeError, ValueError):
        self._json({"error": "invalid JSON body"}, 400); return
```

**Verify**: `grep -n "length < 0" server.py` → 1 match.

### Step 2: Add regression tests

Add to `test_regression.py` (model after existing POST tests):

```python
def test_content_length_negative(self):
    resp = requests.post(
        f"{BASE}/api/data",
        headers={"Content-Length": "-1", "Content-Type": "application/json"},
        data=b"", timeout=5
    )
    self.assertIn(resp.status_code, (400, 413))

def test_content_length_non_numeric(self):
    resp = requests.post(
        f"{BASE}/api/data",
        headers={"Content-Length": "abc", "Content-Type": "application/json"},
        data=b"", timeout=5
    )
    self.assertEqual(resp.status_code, 400)
```

**Verify**: `python test_regression.py` → all pass.

## Done criteria

- [ ] `grep -n "length < 0" server.py` → 1 match inside `do_POST`
- [ ] `python test_regression.py` exits 0 with 2 new tests passing
- [ ] `curl -X POST http://localhost:8080/api/data -H "Content-Length: -1" -d "" -m 3` returns within 3 seconds
- [ ] Only `server.py` and `test_regression.py` modified
- [ ] `plans/README.md` updated

## STOP conditions

- Code at `server.py:1756-1764` doesn't match the excerpt (drift).
- `_json` helper is not available in `do_POST` scope.
- More complex branching inside `do_POST` than shown.

## Maintenance notes

- If `do_GET` is ever extended to read a request body, apply the same pattern.
- `MAX_BODY` at 64KB is the right cap for this JSON-only API; if file upload is added, create a separate handler.
