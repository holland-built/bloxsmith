# Plan 016: Self-service allocate validates DNS before reserving an IP and releases the reservation when the DNS step fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This is actively-evolving code.** `server.py` is one large file and line
> numbers drift. Re-locate every edit by **function name** (`_selfservice_allocate`),
> not by line number. Confirm the "Current state" excerpt matches before editing.
>
> **Drift check (run first)**: `git diff --stat 61b1e6e..HEAD -- server.py`
> If `server.py` changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `61b1e6e`, 2026-07-11

## Why this matters

`_selfservice_allocate` reserves an IP from a subnet (`POST .../nextavailableip`)
and then optionally creates a DNS record. Two defects make the write path
lossy:

1. **Silent subnet exhaustion.** If the DNS create fails, the code records
   `out["record"] = {"ok": False, ...}` but **never releases the IP it just
   reserved**. Every failed DNS attempt permanently orphans one (or `count`)
   addresses; repeated failures exhaust the subnet with reservations nobody
   can see or reclaim through the UI.
2. **Hidden allocation behind a bare 500.** The rdata for the DNS record is
   built by `_dns_rdata(rtype, rvalue)` with **no `try/except`** — unlike every
   other caller of `_dns_rdata`, which guards it. A malformed `dns.type` /
   `dns.value` (e.g. an MX value without a preference) raises `ValueError`
   **after the IP is already reserved**. That exception propagates to the
   generic `do_POST` handler for `/api/selfservice/allocate`, which returns
   `{"ok": False, "error": "internal error"}, 500` — the client is told nothing
   happened, but an address was consumed.

After this plan: bad DNS input is rejected with a `400` **before** anything is
reserved, and a DNS failure that occurs *after* reservation triggers a
compensating release of the reserved address(es) plus an explicit error to the
client — no orphans, no hidden allocations.

## Current state

Files:

- `server.py` — single-file stdlib HTTP server for the NOC dashboard. All the
  relevant code is here.

### The buggy allocate flow — `_selfservice_allocate` (currently ~lines 826–886)

The reservation POST (currently ~861–865):

```python
    resp, status = _rest_write(
        "POST", f"/api/ddi/v1/ipam/subnet/{subnet_id}/nextavailableip",
        body=body_extra or None, params={"count": count})
    if status not in (200, 201) or resp is None:
        return {"ok": False, "error": f"allocation failed (status {status})", "detail": resp}, status or 502

    addresses = resp.get("results") if isinstance(resp, dict) else None
    if not addresses and isinstance(resp, dict) and resp.get("result"):
        addresses = [resp["result"]]
    addresses = addresses or []
    out = {"ok": True, "addresses": [{"id": a.get("id"), "address": a.get("address")} for a in addresses]}
```

The unguarded DNS step (currently ~873–886) — note `_dns_rdata` on the
`record_body` line has **no** `try/except`, and the `else` branch does **not**
release the reserved address:

```python
    if dns and addresses:
        zone_id = str(dns.get("zone_id") or "")
        rname = str(dns.get("name") or "")
        rtype = str(dns.get("type") or "A").upper()
        rvalue = str(dns.get("value") or addresses[0].get("address") or "")
        record_body = {"name_in_zone": rname, "zone": zone_id, "type": rtype, "rdata": _dns_rdata(rtype, rvalue)}
        rresp, rstatus = _rest_write("POST", "/api/ddi/v1/dns/record", body=record_body)
        if rstatus in (200, 201) and isinstance(rresp, dict):
            rec = rresp.get("result") or (rresp.get("results") or [None])[0]
            out["record"] = {"ok": True, "id": (rec or {}).get("id"), "status": rstatus}
        else:
            out["record"] = {"ok": False, "status": rstatus, "detail": rresp}

    return out, 200
```

### Why the exception becomes a bare 500 — `do_POST` dispatch (currently ~5045–5053)

```python
        elif self.path == "/api/selfservice/allocate":
            try:
                result, status = _selfservice_allocate(body)
                self._json(result, status)
            except Exception as e:
                _log_exc("/api/selfservice/allocate", e)
                self._json({"ok": False, "error": "internal error"}, 500)
```

A `ValueError` from `_dns_rdata` lands here → generic `500`, after the IP was
reserved.

### The release path already exists (compensation target)

Two facts confirm a working delete-by-id path — **do not invent one**:

- `_rest_write` supports `DELETE` (currently ~632–657): `_rest_write("DELETE", path)`
  returns `(parsed_json, status)`; `status` is `None` on a network error.
- The HTTP handler `do_DELETE` for `/api/ipam/addresses/{id}` (currently
  ~5216–5228) releases an address with exactly:

  ```python
  resp, status = _rest_write("DELETE", f"/api/ddi/v1/ipam/address/{addr_id}")
  # treats status in (200, 204, 404) as success
  ```

  The compensating release in this plan uses the **same** call, with
  `addr_id = a.get("id")` taken from the just-reserved `addresses` list.

### How `_dns_rdata` validates (the input we pre-check) — currently ~659

`_dns_rdata(rtype, value)` returns an rdata dict and raises `ValueError` on
missing/malformed fields (e.g. an MX value that is not `"<pref> <exchange>"`, a
SRV value without 4 fields, an empty value). It is pure — no network — so it is
safe to call for validation before any write. Note: for `A`/`AAAA` with an
empty `value`, the real value is later defaulted to the allocated address, so
an empty `value` for those types must **not** be treated as invalid up front
(see Step 1).

The repo convention every other `_dns_rdata` caller follows (`_dns_record_create`
~733, `_dns_record_update` ~778): wrap the call in `try/except ValueError` and
`return {"ok": False, "error": str(e)}, 400`. Match it.

## Commands you will need

| Purpose            | Command                                                                 | Expected on success |
|--------------------|-------------------------------------------------------------------------|---------------------|
| Python for tests   | `./.venv-backend-tests/bin/python`                                       | runs                |
| Pytest             | `./.venv-backend-tests/bin/pytest tests_backend/test_allocate_compensation.py -v` | all pass    |
| Byte-compile check | `./.venv-backend-tests/bin/python -m py_compile server.py`              | exit 0, no output   |
| Confirm no orphan  | `grep -n "rdata\": _dns_rdata(rtype, rvalue)" server.py`                | **no match** after Step 2 |

## Scope

**In scope** (the only files you should modify):
- `server.py` — only the `_selfservice_allocate` function (validate-before-reserve
  + compensating release).
- `tests_backend/test_allocate_compensation.py` (create) — new dry-run/monkeypatch
  unit test.

**Out of scope** (do NOT touch, even though they look related):
- The Phase-1 provisioning / block-seed / teardown flows (`provision`, the many
  other `_rest_write("DELETE", ...)` call sites ~1344–2122). This finding is
  only about `_selfservice_allocate`.
- `_dns_record_create` / `_dns_record_update` — already guard `_dns_rdata`
  correctly; leave them.
- The `do_POST` / `do_DELETE` HTTP handlers — the fix is inside
  `_selfservice_allocate`; do not change the dispatch or the response envelope
  shape used by other routes.
- The public JSON response keys already emitted (`ok`, `addresses`, `record`) —
  you may **add** keys (`released`, `error`) but do not rename existing ones.

## Git workflow

- Branch: `advisor/016-allocate-orphan-ip-compensation`
- One commit; message style is conventional commits (see `git log`, e.g.
  `fix(provision): resilient block seeding …`). Suggested:
  `fix(selfservice): validate DNS before reserving IP; release reservation on DNS failure`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Validate the DNS payload BEFORE the reservation POST

In `_selfservice_allocate`, locate the reservation block (the
`resp, status = _rest_write("POST", f"/api/ddi/v1/ipam/subnet/{subnet_id}/nextavailableip", ...)`
call). **Immediately before** that `_rest_write` call — and after the `if dry:`
early-return block — insert an up-front DNS validation guard:

```python
    # Validate the DNS payload up front so a malformed type/value fails with a
    # 400 BEFORE any IP is reserved (otherwise the reservation is orphaned and
    # the ValueError surfaces as a bare 500 after the address is consumed).
    if dns:
        _rtype = str(dns.get("type") or "A").upper()
        _rval = str(dns.get("value") or "").strip()
        # For A/AAAA an empty value is later defaulted to the allocated address,
        # so only pre-validate when a value was supplied or the type needs one.
        if _rval or _rtype not in ("A", "AAAA"):
            try:
                _dns_rdata(_rtype, _rval)
            except ValueError as e:
                return {"ok": False, "error": f"invalid dns payload: {e}"}, 400
```

Do not remove the later `dns and addresses` block yet — Step 2 rewrites it.

**Verify**: `./.venv-backend-tests/bin/python -m py_compile server.py` → exit 0.

### Step 2: Guard the post-reservation DNS create and release the IP on failure

Replace the existing `if dns and addresses:` block (the one shown in "Current
state", ending `else: out["record"] = {"ok": False, ...}` followed by
`return out, 200`) with the version below. Two changes: (a) wrap `_dns_rdata`
in `try/except` (defensive — Step 1 already validates, but the value can be the
allocated address); (b) on **any** DNS failure, issue a compensating DELETE for
every reserved address, and surface explicit partial-failure state instead of a
`200`.

```python
    if dns and addresses:
        zone_id = str(dns.get("zone_id") or "")
        rname = str(dns.get("name") or "")
        rtype = str(dns.get("type") or "A").upper()
        rvalue = str(dns.get("value") or addresses[0].get("address") or "")
        try:
            rdata = _dns_rdata(rtype, rvalue)
        except ValueError as e:
            rresp, rstatus = {"error": str(e)}, 400
        else:
            record_body = {"name_in_zone": rname, "zone": zone_id, "type": rtype, "rdata": rdata}
            rresp, rstatus = _rest_write("POST", "/api/ddi/v1/dns/record", body=record_body)

        if rstatus in (200, 201) and isinstance(rresp, dict):
            rec = rresp.get("result") or (rresp.get("results") or [None])[0]
            out["record"] = {"ok": True, "id": (rec or {}).get("id"), "status": rstatus}
        else:
            # Compensating release: the DNS step failed, so roll back the
            # reservation(s) we just made — otherwise they are orphaned and
            # will exhaust the subnet. Same delete-by-id path as the
            # /api/ipam/addresses/{id} DELETE handler.
            released, orphaned = [], []
            for a in addresses:
                aid = a.get("id")
                if not aid:
                    continue
                _, dstatus = _rest_write("DELETE", f"/api/ddi/v1/ipam/address/{aid}")
                (released if dstatus in (200, 204, 404) else orphaned).append(aid)
            out["ok"] = False
            out["record"] = {"ok": False, "status": rstatus, "detail": rresp}
            out["released"] = released
            if orphaned:
                # Could not roll back — report the ids explicitly so an operator
                # can reclaim them manually. Do NOT retry blindly.
                out["orphaned"] = orphaned
            out["error"] = "dns record creation failed; reserved address(es) released"
            return out, 502

    return out, 200
```

**Verify**:
- `./.venv-backend-tests/bin/python -m py_compile server.py` → exit 0.
- `grep -n 'rdata": _dns_rdata(rtype, rvalue)' server.py` → **no match** (the
  unguarded call is gone).

### Step 3: Add a dry-run / monkeypatch unit test

Create `tests_backend/test_allocate_compensation.py`. It imports `server` and
monkeypatches `server._rest_write` to record calls, so it needs **no** running
server and **no** tenant. Cover three cases:

1. **Bad DNS input → 400, nothing reserved.** Call with `dns.type="MX"`,
   `dns.value="mail.example.com."` (no preference), `dry` falsy. Assert result
   status `400` and that `_rest_write` was **never** called (no
   `nextavailableip` POST) → proves validate-before-mutate.
2. **DNS failure after reserve → address released + explicit error.** Make the
   fake `_rest_write` return a successful `nextavailableip` result (one address
   with an `id`), then a failing DNS `POST` (status `500`), then a successful
   `DELETE`. Assert: a `DELETE` to `/api/ddi/v1/ipam/address/<id>` was issued,
   result `status == 502`, `result["ok"] is False`,
   `result["released"] == [<id>]`.
3. **Happy path unchanged.** Successful reserve + successful DNS → `status 200`,
   `result["record"]["ok"] is True`, and **no** `DELETE` issued.

Target shape (adapt names to what `server` actually exposes — module-level
`_selfservice_allocate` and `_rest_write`):

```python
import importlib, server

def _fake_rest(calls, script):
    def _rw(method, path, body=None, params=None):
        calls.append((method, path))
        return script(method, path, body, params)
    return _rw

def test_bad_dns_reserves_nothing(monkeypatch):
    calls = []
    def script(m, p, b, q):  # should never be reached for the reserve/DNS
        return {"results": [{"id": "x", "address": "10.0.0.5"}]}, 200
    monkeypatch.setattr(server, "_rest_write", _fake_rest(calls, script))
    res, status = server._selfservice_allocate(
        {"subnet_id": "s1", "dry": False,
         "dns": {"zone_id": "z1", "name": "h", "type": "MX", "value": "mail.example.com."}})
    assert status == 400
    assert calls == []            # no nextavailableip POST happened

def test_dns_failure_releases_reservation(monkeypatch):
    calls = []
    def script(m, p, b, q):
        if p.endswith("/nextavailableip"):
            return {"results": [{"id": "addr-1", "address": "10.0.0.5"}]}, 200
        if p == "/api/ddi/v1/dns/record":
            return {"error": "boom"}, 500
        if m == "DELETE":
            return None, 204
        return None, 200
    monkeypatch.setattr(server, "_rest_write", _fake_rest(calls, script))
    res, status = server._selfservice_allocate(
        {"subnet_id": "s1", "dry": False,
         "dns": {"zone_id": "z1", "name": "h", "type": "A"}})
    assert status == 502
    assert res["ok"] is False
    assert res["released"] == ["addr-1"]
    assert ("DELETE", "/api/ddi/v1/ipam/address/addr-1") in calls
```

If `server` cannot be imported at module top (it may execute setup on import),
import it inside the test with `import server` and reload if needed, or set any
env guard the file checks — inspect the top of `server.py` and adapt. If import
has an unavoidable side effect (binds a socket / needs credentials), STOP and
report rather than forcing it.

**Verify**: `./.venv-backend-tests/bin/pytest tests_backend/test_allocate_compensation.py -v`
→ all 3 pass.

## Test plan

- New file `tests_backend/test_allocate_compensation.py` with the three cases
  above (bad-DNS-no-mutation, DNS-failure-releases, happy-path-unchanged).
- These are pure unit tests via `monkeypatch` of `server._rest_write`; they do
  **not** require a live tenant or a running server, so they are safe in CI.
- **Live-mode note (do not automate):** actually exercising a real reservation +
  compensating DELETE against the Infoblox API requires an authenticated tenant
  and a real subnet. Do NOT attempt it here — the monkeypatched test fully
  covers the control flow. If someone later wants a live smoke test, it must be
  gated behind an explicit tenant/opt-in env var.
- Verification: `./.venv-backend-tests/bin/pytest tests_backend/test_allocate_compensation.py -v`
  → all pass; `./.venv-backend-tests/bin/python -m py_compile server.py` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `./.venv-backend-tests/bin/python -m py_compile server.py` exits 0.
- [ ] Bad DNS input (malformed `dns.type`/`dns.value`) → `_selfservice_allocate`
      returns HTTP `400` and issues **zero** `_rest_write` calls (no reservation).
- [ ] A DNS failure after a successful reservation → a `DELETE
      /api/ddi/v1/ipam/address/{id}` is issued for each reserved id, the result
      is HTTP `502` with `ok: False`, `error` set, and `released` listing the ids.
- [ ] `grep -n 'rdata": _dns_rdata(rtype, rvalue)' server.py` returns no matches
      (the unguarded `_dns_rdata` call is gone).
- [ ] `./.venv-backend-tests/bin/pytest tests_backend/test_allocate_compensation.py -v`
      → all 3 new tests pass.
- [ ] `git status` shows only `server.py`, the new test file, and
      `plans/README.md` modified — nothing else.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `server.py` at `_selfservice_allocate` doesn't match the "Current state"
  excerpts (the code drifted since commit `61b1e6e` — re-locate by function
  name, and if the flow was already refactored, report rather than guess).
- **No address-release endpoint exists.** This plan assumes the delete-by-id
  path `_rest_write("DELETE", "/api/ddi/v1/ipam/address/{id}")` (used by the
  `/api/ipam/addresses/{id}` `do_DELETE` handler) is present. If that handler or
  that `_rest_write` DELETE usage is gone, **STOP and report — do not invent a
  release path** or call an endpoint that isn't already used elsewhere.
- Importing `server` in the test has an unavoidable side effect (binds a port,
  requires live credentials) that you cannot neutralize with env/monkeypatch.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching any file outside the In-scope list.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Pattern to enforce going forward:** any new multi-step write that reserves
  or creates a resource and then performs a second dependent write must
  (1) **validate all inputs before the first mutation**, and (2) **compensate
  (release/delete) on a later-step failure**. `_selfservice_allocate` is now the
  reference example; apply the same validate-before-mutate + compensate-on-failure
  shape to future allocate/provision flows.
- A reviewer should scrutinize: that the compensating `DELETE` targets every
  reserved id (not just `addresses[0]`), that a failed release is surfaced as
  `orphaned` rather than swallowed, and that the response envelope adds keys
  without renaming `ok`/`addresses`/`record` (frontend depends on them).
- Deferred out of this plan (intentionally): a live end-to-end smoke test
  against a real tenant, and any retry/backoff on the compensating DELETE — a
  failed release is reported (`orphaned`) for manual reclaim, not retried, to
  avoid compounding a bad state.
