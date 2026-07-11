# Plan 017: Site-provision rollback surfaces failed DELETEs as residual objects

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 61b1e6e..HEAD -- server.py`
> If `server.py` changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition. This is actively-evolving code — if line
> numbers have drifted, re-locate by the function/class names given below
> (`SiteProvisioner._rollback`, `_rest_write`) rather than trusting the lines.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `61b1e6e`, 2026-07-11

## Why this matters

When site provisioning fails, `SiteProvisioner._rollback` deletes the hosts,
DNS zone, reverse zones, DHCP ranges, and subnets it created — but it ignores
the HTTP status of every `_rest_write("DELETE", …)` call. If any delete fails
(object locked, permission drift, transient 5xx), the object is silently left
behind while the operator is told provisioning "rolled back." The result is
orphaned DNS/IPAM objects with no signal — inconsistent state that an operator
trusts is clean. The sibling `BlockProvisioner._rollback` already checks each
delete status and emits on failure; this plan brings the site rollback up to
the same standard and additionally returns the residual (undeleted) objects so
the caller/UI can report an incomplete rollback instead of a false success.

## Current state

- `server.py` — single-file MCP server. Two `_rollback` methods:
  - `SiteProvisioner._rollback` (~lines 1748–1768) — **the buggy one**; no
    status check on any DELETE.
  - `BlockProvisioner._rollback` (~lines 1338–1346) — **the exemplar to match**;
    checks status and emits on failure.
  - `_rest_write` (~line 632) — the write helper both call.

`_rest_write` return contract (server.py:632-657) — returns a
`(parsed_json, http_status)` tuple; `status` is `None` on a network error with
no HTTP response:

```python
def _rest_write(method: str, path: str, body: dict | None = None, params: dict | None = None) -> tuple:
    """Direct Infoblox REST write (POST/PATCH/DELETE) → (parsed_json, http_status).
    ...status is None on a network error (no HTTP response at all)."""
    ...
    with urllib.request.urlopen(req, timeout=35) as r:
        raw = r.read()
        return (json.loads(raw) if raw else None), r.status
    except urllib.error.HTTPError as e:
        ...
        return err_body, e.code
    except Exception as e:
        print(f"  [warn] rest_write {method} {path}: {e}")
        return None, None
```

**Exemplar — `BlockProvisioner._rollback` (server.py:1338-1346), match this style:**

```python
def _rollback(self, result: dict) -> None:
    self.emit({"step": "Rolling back created address blocks…"})
    for block in reversed(result["blocks_created"]):
        block_id = block.get("id", "")
        if not block_id or block_id == "(dry-run)":
            continue
        _, status = _rest_write("DELETE", f"/api/ddi/v1/{block_id}")
        if not (status and 200 <= status < 300):
            self.emit({"step": f"  Rollback: failed to delete block id={block_id}"})
```

Note the success predicate: `status and 200 <= status < 300`. Reuse it verbatim.

**Buggy — `SiteProvisioner._rollback` (server.py:1748-1768), the target:**

```python
def _rollback(self, partial: dict) -> None:
    self.emit({"step": "Rolling back partial site provisioning…"})
    for h in reversed(partial["hosts"]):
        hid = h.get("id", "")
        if hid and hid != "(dry-run)":
            _rest_write("DELETE", f"/api/ddi/v1/{hid}")
    if self._zone_created and partial["dns_zone_id"] not in ("", "(dry-run)"):
        _rest_write("DELETE", f'/api/ddi/v1/{partial["dns_zone_id"]}')
    for rz in reversed(partial["reverse_zones"]):
        rid = rz.get("id", "")
        if rid and rid != "(dry-run)":
            _rest_write("DELETE", f"/api/ddi/v1/{rid}")
    for r in reversed(partial["dhcp_ranges"]):
        rid = r.get("id", "")
        if rid and rid != "(dry-run)":
            _rest_write("DELETE", f"/api/ddi/v1/{rid}")
    for s in reversed(partial["subnets"]):
        sid = s.get("id", "")
        if sid and sid != "(dry-run)":
            _rest_write("DELETE", f"/api/ddi/v1/{sid}")
    # The pool block is shared and untagged by this flow, so nothing to reset there.
```

Caller — `SiteProvisioner.provision` (server.py:1770-1804) — calls
`self._rollback(result)` inside the `except` block, then re-raises:

```python
except Exception as exc:
    if not self.cfg.dry_run:
        self.emit({"step": f"Provisioning failed ({exc}) — initiating rollback"})
        self._rollback(result)
    raise
```

Convention: `self.emit({"step": "…"})` is the project's progress-signal channel
(same one `BlockProvisioner` uses); rollback messages are prefixed with two
leading spaces (see the exemplar). `_rest_write` return values are unpacked as
`_, status = _rest_write(...)`.

## Commands you will need

| Purpose       | Command                                                          | Expected on success |
|---------------|------------------------------------------------------------------|---------------------|
| Syntax check  | `python3 -c "import ast;ast.parse(open('server.py').read())"`    | exit 0, no output   |
| Run new test  | `python3 -m pytest tests/test_site_rollback.py -q`               | all pass            |
| Drift check   | `git diff --stat 61b1e6e..HEAD -- server.py`                     | (compare excerpts)  |

Run all commands from the repo root (`/Users/sholland/AI/Infoblox MCP`). If
`tests/` does not exist, create it (see Test plan).

## Scope

**In scope** (the only files you should modify/create):
- `server.py` — `SiteProvisioner._rollback` only.
- `tests/test_site_rollback.py` (create).

**Out of scope** (do NOT touch, even though they look related):
- The forward provisioning path (`SiteProvisioner.provision`,
  `create_subnets`, `create_dns_zone`, `provision_hosts`) — do not change how
  objects are created, only how their rollback reports failure.
- `BlockProvisioner._rollback` — it is already correct; it is the exemplar,
  not a target.
- `_rest_write` — do not change the helper or its signature.
- The pool-block reset comment behavior — leave the shared block untouched.

## Git workflow

- Branch: `advisor/017-rollback-failed-delete-checks`
- Commit style: conventional commits (repo uses `fix(...)`, `test(...)` — see
  `git log`). Example: `fix(provision): surface failed site-rollback DELETEs as residual objects`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `SiteProvisioner._rollback` check each DELETE status and accumulate residuals

Rewrite `SiteProvisioner._rollback` so that every `_rest_write("DELETE", …)`
call captures the status, and on a non-2xx (or `None`) status it (a) emits a
failure line in the `BlockProvisioner._rollback` style and (b) appends the
object to a local `residual` list. Store the residual list on `partial` so the
caller/UI can read it after `provision` re-raises.

Target shape (produce this pattern — a small helper keeps the five loops DRY):

```python
def _rollback(self, partial: dict) -> None:
    self.emit({"step": "Rolling back partial site provisioning…"})
    residual: list[dict] = []

    def _del(obj_id: str, kind: str, label: str) -> None:
        if not obj_id or obj_id == "(dry-run)":
            return
        _, status = _rest_write("DELETE", f"/api/ddi/v1/{obj_id}")
        if not (status and 200 <= status < 300):
            self.emit({"step": f"  Rollback: failed to delete {kind} id={obj_id} (status={status})"})
            residual.append({"kind": kind, "id": obj_id, "label": label, "status": status})

    for h in reversed(partial["hosts"]):
        _del(h.get("id", ""), "host", h.get("fqdn", h.get("ip", "")))
    if self._zone_created and partial["dns_zone_id"] not in ("", "(dry-run)"):
        _del(partial["dns_zone_id"], "dns_zone", partial.get("dns_zone_fqdn", ""))
    for rz in reversed(partial["reverse_zones"]):
        _del(rz.get("id", ""), "reverse_zone", rz.get("fqdn", ""))
    for r in reversed(partial["dhcp_ranges"]):
        _del(r.get("id", ""), "dhcp_range", "")
    for s in reversed(partial["subnets"]):
        _del(s.get("id", ""), "subnet", f'{s.get("address","")}/{s.get("cidr","")}')
    # The pool block is shared and untagged by this flow, so nothing to reset there.

    partial["rollback_residual"] = residual
    if residual:
        self.emit({"step": f"  Rollback incomplete: {len(residual)} object(s) could not be deleted"})
```

Notes for the executor:
- Keep the existing `"(dry-run)"` skip semantics — the `_del` helper reproduces
  them; do not delete dry-run placeholders.
- Preserve the `reversed(...)` iteration order and the `self._zone_created`
  guard exactly as in the current code.
- The success predicate MUST be `status and 200 <= status < 300` (mirror the
  exemplar). Do not invent a different check.
- Only `.get(...)` keys you know exist on each object dict from the forward
  path; the `label` fields are best-effort and default to `""`.

**Verify**: `python3 -c "import ast;ast.parse(open('server.py').read())"` → exit 0, no output.

### Step 2: Add a characterization test

Create `tests/test_site_rollback.py`. The test must construct a
`SiteProvisioner` (or a minimal stand-in that reuses the real `_rollback`
method), monkeypatch the module-level `_rest_write` so that ONE object's DELETE
returns a non-2xx status (e.g. `(None, 500)`) and the rest return `(None, 200)`,
invoke `_rollback` with a `partial` dict containing at least one host, subnet,
and dhcp_range, and assert that `partial["rollback_residual"]` is a non-empty
list containing exactly the object whose DELETE failed. Also add a
happy-path case where every DELETE returns 200 and assert
`partial["rollback_residual"] == []`.

Because `server.py` is a single module, import it with
`import server` and monkeypatch `server._rest_write`. If `SiteProvisioner`'s
constructor requires heavy config, instantiate via
`SiteProvisioner.__new__(SiteProvisioner)`, set `self._zone_created = True` and
a no-op `self.emit = lambda *_a, **_k: None`, then call
`server.SiteProvisioner._rollback(inst, partial)` directly. Prefer the real
method over reimplementing it.

**Verify**: `python3 -m pytest tests/test_site_rollback.py -q` → all pass (2 tests).

## Test plan

- New file `tests/test_site_rollback.py`, two cases:
  - **failed-delete case**: one monkeypatched DELETE returns `(None, 500)`;
    assert `rollback_residual` contains exactly that object (correct `kind`/`id`)
    and length 1 — this is the regression this plan fixes.
  - **clean case**: all DELETEs return `(None, 200)`; assert
    `rollback_residual == []`.
- Structural pattern: if the repo already has tests under `tests/`, mirror the
  closest one for imports/monkeypatch style; otherwise this is the pattern.
- Verification: `python3 -m pytest tests/test_site_rollback.py -q` → 2 passed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `python3 -c "import ast;ast.parse(open('server.py').read())"` exits 0
- [ ] `python3 -m pytest tests/test_site_rollback.py -q` exits 0; 2 new tests pass
- [ ] `SiteProvisioner._rollback` unpacks status on every DELETE
      (`grep -n "_rest_write(\"DELETE\"" server.py` shows the site method calls
      go through the `_del` helper — no bare `_rest_write("DELETE", …)` whose
      return value is discarded inside `SiteProvisioner._rollback`)
- [ ] `partial["rollback_residual"]` is set on every `SiteProvisioner._rollback`
      call path
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `_rest_write` does not return a `(json, status)` tuple the code can branch on
  (e.g. the signature/return contract changed) — the entire fix depends on a
  branchable status. STOP and report.
- The code at the "Current state" excerpts doesn't match the live
  `SiteProvisioner._rollback` or `BlockProvisioner._rollback` (drift).
- Adding `rollback_residual` to `partial` would require changing the forward
  provisioning path or `provision`'s result schema in a way that breaks an
  existing caller — STOP and report which caller.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- A reviewer should confirm the site rollback now mirrors
  `BlockProvisioner._rollback`'s status check and that dry-run placeholders are
  still skipped (no live DELETEs during dry-run).
- Follow-up deliberately deferred: surfacing `rollback_residual` in the
  MCP/UI-facing error payload (the caller re-raises after rollback; wiring the
  residual list into the raised error or the tool response is a separate,
  larger change and is out of scope here). This plan only makes the data
  available on `partial`.
- If new object types are added to the forward provisioning path, add a
  corresponding `_del(...)` loop here so their rollback failures are also
  tracked.
