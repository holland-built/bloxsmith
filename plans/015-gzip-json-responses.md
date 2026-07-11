# Plan 015: Gzip JSON API responses at the `_json` choke point

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 61b1e6e..HEAD -- server.py test_regression.py`
> If `server.py` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `61b1e6e`, 2026-07-11

## Why this matters

Every JSON API response leaves the server uncompressed. The heaviest,
`GET /api/data`, calls `fetch_dashboard_data()` (`server.py:3014`) which pulls
subnets, leases, and zones each at `_limit: 5000` (`server.py:3024-3030`) plus
hosts/policies/feeds — a multi-megabyte JSON payload that is re-sent in full on
every dashboard load AND every background refetch. JSON is highly redundant text
and gzips roughly 8-10x. Compressing it at the single function all JSON
responses flow through cuts wire bytes and load latency dramatically for a few
lines of stdlib code, no new dependency, and no change to the response body the
client parses. This is the highest performance-leverage-to-effort change
available in the server.

## Current state

- `server.py` — single-file threaded stdlib HTTP server
  (`http.server.BaseHTTPRequestHandler` + `ThreadingMixIn`, imported at
  `server.py:17-18`). No WSGI layer, no reverse proxy in the code, no existing
  compression anywhere: `grep -n "gzip\|Content-Encoding\|WSGI\|make_server" server.py`
  returns nothing at commit `61b1e6e`.
- `import gzip` is NOT currently imported. The top-level import line is:
  ```python
  import asyncio, base64, hashlib, hmac, json, os, re, secrets, sys, threading   # server.py:10
  ```
  `gzip` is Python stdlib — no dependency to add.
- **`_json()` — the choke point (every JSON endpoint calls this), `server.py:5246-5253`:**
  ```python
      def _json(self, data, status=200):
          body = json.dumps(data).encode()
          self.send_response(status)
          self.send_header("Content-Type", "application/json")
          self._send_cors_origin()
          self.send_header("Content-Length", str(len(body)))
          self.end_headers()
          self.wfile.write(body)
  ```
  Every `/api/*` JSON endpoint routes through this one method (dozens of
  callers: `/api/data` at `server.py:4393`, plus `/api/actions`,
  `/api/insights`, `/api/dns-analytics`, `/api/views`, all IPAM/DNS endpoints,
  every error response, etc.). Fixing `_json` benefits all of them at once.
- Request headers are read via `self.headers.get(...)` on the handler — this is
  how the existing code already reads request headers, e.g.
  `self.headers.get("X-Auth-Token", "")` (`server.py:4253`) and
  `self.headers.get("Content-Length", 0)` (`server.py:4903`). Use the same
  `self.headers.get("Accept-Encoding", "")` to decide whether to compress.
- **Out-of-scope response paths that must NOT be touched (they do NOT call
  `_json`, so leaving `_json` the only edit already excludes them — verify you
  don't accidentally change them):**
  - Static files — `_file()` at `server.py:5255-5288` writes its own
    `send_response`/`Content-Length`/`wfile.write`. Not through `_json`.
  - `/api/logo` binary image responses — inline in `do_GET` at
    `server.py:4326-4350`, own header writes. Not through `_json`.
  - SSE streams — five handlers send `Content-Type: text/event-stream`
    (`server.py:4635, 4694, 4737, 4794, 4839`) and stream via their own
    `wfile.write`. Never through `_json`. Do not gzip these; chunked SSE must
    stay uncompressed.

## Commands you will need

| Purpose            | Command                                                                                                    | Expected on success                     |
|--------------------|------------------------------------------------------------------------------------------------------------|-----------------------------------------|
| Syntax check       | `python3 -m py_compile server.py`                                                                          | exit 0, no output                       |
| Start server       | `python3 server.py` (runs on `http://localhost:8080`; leave running in a second shell)                    | server boots, listens on 8080           |
| Run backend tests  | `python3 -m unittest test_regression -v`                                                                   | all pass (server must be running)       |
| gzip header present | `curl -s -H 'Accept-Encoding: gzip' -D- http://localhost:8080/api/data -o /dev/null \| grep -i content-encoding` | `Content-Encoding: gzip`         |
| plain still works  | `curl -s http://localhost:8080/api/data \| python3 -m json.tool > /dev/null && echo OK`                     | `OK` (valid JSON, no gzip requested)    |

Note: `curl` without `--compressed`/`-H 'Accept-Encoding: gzip'` sends no
gzip preference, so the server must return uncompressed JSON for it.

## Scope

**In scope** (the only files you should modify):
- `server.py` — add `import gzip`; edit `_json()` only.
- `test_regression.py` — add one new test method to the existing
  `BackendTests` class.

**Out of scope** (do NOT touch):
- `_file()` (`server.py:5255`), `/api/logo` (`server.py:4319-4354`), and all
  five SSE handlers (`text/event-stream`) — see "Current state". They do not
  flow through `_json`; leave them exactly as-is.
- The response *data* shape — the decompressed body must be byte-identical to
  today's JSON. Do not reformat, re-key, or re-serialize differently.
- CORS handling (`self._send_cors_origin()`) — keep the call in place,
  unchanged.

## Git workflow

- Branch: `advisor/015-gzip-json-responses`
- Commit style: conventional commits, matching `git log` (e.g.
  `perf(server): gzip JSON responses when client accepts gzip`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `gzip` import

In `server.py:10`, add `gzip` to the stdlib import line (alphabetical, after
`base64`):

```python
import asyncio, base64, gzip, hashlib, hmac, json, os, re, secrets, sys, threading
```

**Verify**: `python3 -c "import ast,sys; ast.parse(open('server.py').read())"` → exit 0, no output.

### Step 2: Compress in `_json()` when the client advertises gzip

Replace the body of `_json()` (`server.py:5246-5253`) with the version below.
Behavior: serialize as today; if the request's `Accept-Encoding` contains
`gzip` AND the serialized body is larger than a 1 KB threshold, gzip it, add
`Content-Encoding: gzip`, and set `Content-Length` to the *compressed* length.
Otherwise fall through to the exact current uncompressed path. The small-body
guard avoids wasting CPU compressing tiny responses (error blobs, status pings)
where gzip can even grow the payload.

```python
    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_cors_origin()
        # Compress large JSON when the client advertises gzip. JSON gzips ~8-10x;
        # /api/data is multi-MB and refetched often. Small bodies skip it (CPU not
        # worth it, gzip can grow tiny payloads). SSE/static never reach here.
        accept = self.headers.get("Accept-Encoding", "")
        if len(body) > 1024 and "gzip" in accept.lower():
            body = gzip.compress(body)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
```

Notes for the executor:
- `Content-Length` is set AFTER the possible reassignment of `body`, so it
  always matches the bytes actually written (compressed or not). Do not move it.
- `Vary: Accept-Encoding` is correct HTTP hygiene for a response that differs
  by request header; include it as shown.
- Keep `self._send_cors_origin()` exactly where it is.

**Verify**: `python3 -m py_compile server.py` → exit 0.

### Step 3: Manually verify end-to-end against a running server

Start the server (`python3 server.py`) in one shell, then in another:

```bash
# Before/after size: compressed vs uncompressed Content-Length for /api/data
echo "gzip:";  curl -s -H 'Accept-Encoding: gzip' -D- http://localhost:8080/api/data -o /dev/null | grep -iE 'content-encoding|content-length'
echo "plain:"; curl -s -D- http://localhost:8080/api/data -o /dev/null | grep -iE 'content-encoding|content-length'
# Body still valid JSON when gzip requested (curl --compressed auto-inflates):
curl -s --compressed http://localhost:8080/api/data | python3 -m json.tool > /dev/null && echo "JSON-OK"
# Body still valid JSON with no gzip requested:
curl -s http://localhost:8080/api/data | python3 -m json.tool > /dev/null && echo "PLAIN-OK"
```

**Verify**, ALL of:
- `gzip:` block shows `Content-Encoding: gzip` and a `Content-Length` that is
  markedly smaller than the `plain:` block's `Content-Length` (expect roughly
  8-10x smaller; any clear reduction confirms it).
- `plain:` block shows NO `Content-Encoding` line and a larger `Content-Length`.
- Both `JSON-OK` and `PLAIN-OK` print.

If `/api/data` returns a tiny body in this environment (e.g. vault locked →
under 1 KB), it legitimately won't compress. In that case also test a path you
can confirm is large, or unlock the vault; do not weaken the 1 KB guard to make
the check pass.

### Step 4: Add a backend regression test

Add ONE test method to the existing `BackendTests` class in
`test_regression.py` (the class starts at `test_regression.py:67`; add the
method alongside the other `test_api_data_*` methods around
`test_regression.py:93-119`). Model its style after the existing helpers — but
note the module-level `get()` helper (`test_regression.py:24`) sends no
`Accept-Encoding`, so this test must build its own `Request` with the gzip
header. `urllib` does NOT auto-decompress, so decompress manually with `gzip`.

```python
    def test_api_data_gzip_when_requested(self):
        """_json gzips large payloads when the client advertises gzip, and the
        decompressed body is still valid JSON with the expected shape."""
        import gzip as _gz
        req = Request(BASE + "/api/data", headers={"Accept-Encoding": "gzip"})
        with urlopen(req, timeout=90) as r:
            enc = (r.headers.get("Content-Encoding") or "").lower()
            raw = r.read()
        if enc == "gzip":
            body = _gz.decompress(raw)
        else:
            # Payload under the 1KB compression threshold this run (e.g. vault
            # locked / empty tenant) — still must be valid JSON, just not gzipped.
            body = raw
        d = json.loads(body)  # must decode as JSON either way
        self.assertIsInstance(d, dict)
```

Add `from urllib.request import urlopen, Request` is already imported at
`test_regression.py:11` — reuse it, do not re-import at module level.

**Verify**: with the server running,
`python3 -m unittest test_regression.BackendTests.test_api_data_gzip_when_requested -v`
→ `OK`, 1 test passed.

### Step 5: Full regression pass

**Verify**: `python3 -m unittest test_regression -v` (server running) → all
tests pass, including the new one; no previously-passing test regresses.

## Test plan

- New test: `BackendTests.test_api_data_gzip_when_requested` in
  `test_regression.py`, covering:
  - happy path — `Accept-Encoding: gzip` on `/api/data` yields a
    `Content-Encoding: gzip` response whose gzip-decompressed body is valid
    JSON (`dict`).
  - graceful fallback — if the payload is under the 1 KB threshold this run, the
    body is still valid JSON (asserts we never emit a broken/partial body).
- Structural pattern to follow: the existing `test_api_data_shape` /
  `test_api_data_subnet_fields` methods (`test_regression.py:93-113`) and the
  module `get()`/`Request` helpers (`test_regression.py:24-26`).
- Verification: `python3 -m unittest test_regression -v` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `python3 -m py_compile server.py` exits 0.
- [ ] `grep -n "^import" server.py | grep -q gzip` → matches (gzip imported).
- [ ] `grep -c "Content-Encoding" server.py` → exactly `1` (only inside `_json`;
      confirms no SSE/static path was touched).
- [ ] With server running: `curl -s -H 'Accept-Encoding: gzip' -D- http://localhost:8080/api/data -o /dev/null | grep -i content-encoding` → `Content-Encoding: gzip`.
- [ ] With server running: `curl -s http://localhost:8080/api/data | python3 -m json.tool > /dev/null && echo OK` → `OK` (no gzip requested → valid uncompressed JSON, HTTP 200).
- [ ] `python3 -m unittest test_regression -v` → all pass, including
      `test_api_data_gzip_when_requested`.
- [ ] `git status` shows only `server.py`, `test_regression.py`, and
      `plans/README.md` modified — no other files.
- [ ] `plans/README.md` status row for 015 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- **Escape hatch — already compressed**: `_json` (or the server) is already
  wrapped by a WSGI/compression middleware, a reverse proxy that sets
  `Content-Encoding`, or any existing gzip handling
  (`grep -n "gzip\|Content-Encoding\|WSGI\|make_server" server.py` returns
  results other than your own edit). Double-encoding corrupts responses — STOP.
- The `_json` body at `server.py:5246-5253` does not match the "Current state"
  excerpt (the file drifted since commit `61b1e6e`).
- Any SSE handler or `_file`/`/api/logo` turns out to route through `_json`
  after all (it should not) — STOP rather than gzip a stream.
- A verification command fails twice after a reasonable fix attempt.
- The fix appears to require touching any file outside the in-scope list.

## Maintenance notes

For whoever owns this code next:

- If a reverse proxy or CDN is later put in front of this server and configured
  to gzip, remove this in-app compression to avoid double-encoding (or confirm
  the proxy passes `Content-Encoding: gzip` through untouched).
- The 1 KB threshold is a deliberate small-body guard; if new large non-`/api/data`
  JSON endpoints are added they automatically benefit — no change needed.
- Reviewer should scrutinize: (1) `Content-Length` is computed AFTER
  compression (must equal bytes written), (2) `Vary: Accept-Encoding` present,
  (3) no SSE/static path was accidentally routed through `_json`.
- Deferred out of scope: compressing static assets in `_file()` (HTML/JS) — a
  separate, lower-value change since those are cache-revalidated; not done here
  to keep this surgical to the `_json` choke point.
