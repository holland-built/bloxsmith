# Plan 014: Escape every CSP `_filter`/`_tfilter` value so user input can't rewrite Infoblox queries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Written against commit `61b1e6e`.**
>
> **Drift check (run first)**: `git diff --stat 61b1e6e..HEAD -- server.py`
> If `server.py` changed since this plan was written, the line numbers below
> have almost certainly moved — this file is an actively-evolving provision
> module. Do NOT trust the line numbers; re-locate every site by the
> `_filter`/`_tfilter` / `field=="{...}"` pattern (see the grep in "Done
> criteria"). Compare each "Current state" excerpt against the live code
> before editing; on a structural mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `61b1e6e`, 2026-07-11

## Why this matters

`server.py` builds Infoblox CSP (BloxOne) `_filter` / `_tfilter` query strings by
f-string-interpolating user-controlled values straight into double-quoted
clauses — `field=="{value}"` — with **zero escaping** at ~38 call sites. Values
arrive from SSE query params (`qp[...]` parsed from the raw URL) and JSON request
bodies. A value containing a `"` breaks out of its intended clause; adding
` or field=="..."` / `and`/`or` operators lets a caller **rewrite the query the
server sends to Infoblox**. Because these queries scope destructive and mutating
operations — subnet/DNS teardown, block retag, IP allocation — an injected value
can widen a lookup to match objects **outside the caller's intended site/space**,
turning a scoped teardown or retag into wrong-object deletion or letting an
attacker steer allocation into an arbitrary subnet. This is the
highest-severity finding in this batch: input injection leading to
wrong-tenant object mutation. The fix is one shared escaping helper applied at
every filter-build site so no user value can alter query structure.

## Current state

- `server.py` (5335 lines) — single-file MCP/SSE server. All CSP filter strings
  are built inline with f-strings. Numeric fields are already `int()`-cast
  (e.g. `cidr=={int(cidr)}`) and are **not** part of this fix.
- Private helpers live together as top-level `def _name(...)` functions
  (see `_csp_json` at line 548, `_rest_get` at 596, `_rest_get_ex` at 613,
  `_rest_write` at 632). New helper goes in this cluster.
- Error convention differs by caller:
  - **Write/allocate paths** already map `ValueError` → HTTP 400
    (e.g. `_selfservice_allocate` and the `except ValueError as e:
    return {"ok": False, "error": str(e)}, 400` pattern at lines 735, 780, 836).
  - **SSE GET handlers** wrap the body in `try: ... except Exception as e:
    _log_exc(...); self._json({"error": "internal error"}, 500)` — a raised
    `ValueError` there would surface as a **500**, not a 400. Those handlers set
    query params via `qp = {k: v[0] for k, v in parse_qs(qs).items()}`
    (lines 4505, 4525, 4540, 4562, 4578, 4606).

### The value-interpolation sites (verify each against live code)

Every one of these interpolates a string value into a quoted CSP clause. The
executor must wrap the interpolated **value** with `_cspq(...)` (Step 2). Line
numbers are at commit `61b1e6e`; re-locate by pattern if drifted.

| Line | Interpolated value(s) | Source |
|------|-----------------------|--------|
| 845  | `tag_value` (and `tag_key` as field name — see Step 3) | JSON body |
| 1297 | `bdef["address"]` (also `space_id`) | config/body |
| 1355 | `self.cfg.ip_space` | config |
| 1539 | `self.cfg.ip_space` | config |
| 1547 | `self._space_id`, `self.cfg.site` | config |
| 1551–1552 | `self._space_id`, `self.cfg.region`, `self.cfg.environment` | config |
| 1559–1560 | `self._space_id`, `self.cfg.region` | config |
| 1567 | `self.cfg.dns_view` | config |
| 1644 | `fqdn`, `self._view_id` | config/derived |
| 1674 | `fqdn`, `self._view_id` | config/derived |
| 1905 | `space_id` | derived |
| 1907 | `template` | config |
| 1909 | `site` | config |
| 1911 | `address` (cidr stays `int()` — leave it) | config |
| 1955 | `self._space_id`, `self.name` | config |
| 1974 | `self.ip_space` | config |
| 2021 | `self.cfg.ip_space` | config |
| 2028 | `self.cfg.dns_view` | config |
| 2036 | `self._space_id`, `self.cfg.site` | config |
| 2046 | `fqdn`, `self._view_id` | config/derived |
| 2060 | `self._space_id`, `self.cfg.site` | config |
| 2082 | `fqdn`, `self._view_id` | config/derived |
| 2161 | `cfg.ip_space` | config |
| 2165 | `cfg.dns_view` | config |
| 2171 | `space_id`, `cfg.site` | config/derived |
| 2199 | `cfg.dns_zone`, `view_id` | config/derived |
| 4510 | `qp["space"]` | **SSE query param** |
| 4514 | `qp["tag_value"]` (and `qp["tag_key"]` as field name — Step 3) | **SSE query param** |
| 4529 | `view` (from `qp`) | **SSE query param** |
| 4546 | `zone` (from `qp`) | **SSE query param** |
| 4548 | `qp["type"].strip().upper()` | **SSE query param** |
| 4550 | `qp["name"]` | **SSE query param** |
| 4568 | `subnet` (from `qp`) | **SSE query param** |
| 4610 | `qp["space"]` | **SSE query param** |
| 4612 | `qp["block"]` | **SSE query param** |
| 5127 | `ip_space` | config |

Representative excerpts as they exist today:

```python
# 845
subnets = _rest_get("/api/ddi/v1/ipam/subnet", {"_tfilter": f'{tag_key}=="{tag_value}"'})
# 1547
"_filter": f'space=="{self._space_id}"', "_tfilter": f'Site=="{self.cfg.site}"'})
# 1644
existing = _rest_get("/api/ddi/v1/dns/auth_zone", {"_filter": f'fqdn=="{fqdn}." and view=="{self._view_id}"'})
# 4510 / 4514
if qp.get("space"):
    filt.append(f'space=="{qp["space"]}"')
...
if qp.get("tag_key") and qp.get("tag_value"):
    rest_params["_tfilter"] = f'{qp["tag_key"]}=="{qp["tag_value"]}"'
# 4546-4550
filt = [f'zone=="{zone}"']
if qp.get("type"):
    filt.append(f'type=="{qp["type"].strip().upper()}"')
if qp.get("name"):
    filt.append(f'name_in_zone=="{qp["name"]}"')
```

**Design note — why escape, not allowlist:** several of these values are
Infoblox object IDs (`space`, `subnet`, `parent`/`block`, `view`/`_view_id`)
that legitimately contain `/`, and FQDNs / region names legitimately contain
`.`, `-`, and spaces. A strict alphanumeric allowlist would reject valid input.
The robust, low-breakage fix is to **backslash-escape** the CSP metacharacters
(`\` and `"`) and reject control characters, which neutralizes the injection
while passing IDs and FQDNs through unchanged. The field-**name** position
(left of `==`, unquoted) is the exception — it takes an identifier allowlist
(Step 3).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax check | `python3 -c "import ast; ast.parse(open('server.py').read())"` | exit 0, no output |
| Enumerate sites | `python3 -c "import re;[print(i) for i,l in enumerate(open('server.py'),1) if re.search(r'==\"\{',l) and not l.strip().startswith('#')]"` | prints the site line numbers |
| Unit test | `python3 -m pytest test_cspq.py -q` (or `python3 test_cspq.py`) | all pass |

(Python is the runtime; there is no `pnpm`/typecheck step for `server.py`.)

## Scope

**In scope** (the only files you may modify):
- `server.py` — add the helper(s); wrap every value-interpolation site listed
  above; add `except ValueError` → 400 arms to the affected SSE GET handlers.
- `test_cspq.py` (create) — new unit test for the helper.
- `plans/README.md` — status row (if the index exists).

**Out of scope** (do NOT touch):
- Any `cidr=={int(...)}` / numeric interpolation — already safe; leave exactly
  as-is.
- The write/mutation logic itself (`_rest_write`, `nextavailableip`, record
  create/update, teardown ordering) — you are **only sanitizing the values that
  flow into filter strings**, not changing behavior for valid input.
- The `Status=="available"` and similar **literal** clauses — no interpolation,
  nothing to escape.
- Any file other than the three above.

## Git workflow

- Branch: `advisor/014-csp-filter-injection-escaper`.
- Commit style: conventional commits (repo uses e.g. `fix(power): ...`,
  `test(power): ...`). Suggested: `fix(security): escape CSP filter values to
  prevent query injection`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the escaping helpers

In `server.py`, directly **above `def _rest_get(` (≈line 596)**, add:

```python
import re as _re_cspq  # if `re` is not already imported at module top; prefer the existing `re`
_CSP_CTRL = re.compile(r'[\x00-\x1f\x7f]')
_CSP_FIELD = re.compile(r'^[A-Za-z0-9_.\-]+$')

def _cspq(v) -> str:
    """Escape a value for safe interpolation into a CSP _filter/_tfilter
    double-quoted clause: f'field=="{_cspq(value)}"'. Backslash-escapes \\ and "
    so a user value can't break out of its clause and rewrite the query.
    Rejects control characters (raises ValueError -> map to HTTP 400).
    Preserves /, ., -, and spaces, so Infoblox object IDs and FQDNs pass
    through unchanged."""
    s = "" if v is None else str(v)
    if _CSP_CTRL.search(s):
        raise ValueError("invalid character in filter value")
    return s.replace("\\", "\\\\").replace('"', '\\"')

def _cspq_field(v) -> str:
    """Validate an unquoted CSP field name (left of ==). Tag keys are the only
    user-supplied field names; they must be identifier-safe. Raises ValueError
    (-> HTTP 400) on anything outside [A-Za-z0-9_.-]."""
    s = "" if v is None else str(v)
    if not _CSP_FIELD.match(s):
        raise ValueError("invalid filter field name")
    return s
```

First check whether `re` is already imported at the top of `server.py`
(`grep -n "^import re" server.py`). It is used elsewhere — reuse it; do **not**
add a second import. Delete the `import re as _re_cspq` line above; it is only a
reminder.

**Verify**: `python3 -c "import ast; ast.parse(open('server.py').read())"` → exit 0.

### Step 2: Wrap every value-interpolation site with `_cspq(...)`

For each line in the table under "Current state", change the interpolated
**value** from `{expr}` to `{_cspq(expr)}`. The per-site pattern:

```python
# before
filt.append(f'space=="{qp["space"]}"')
# after
filt.append(f'space=="{_cspq(qp["space"])}"')
```

```python
# before
{"_filter": f'fqdn=="{fqdn}." and view=="{self._view_id}"'}
# after
{"_filter": f'fqdn=="{_cspq(fqdn)}." and view=="{_cspq(self._view_id)}"'}
```

Notes:
- Wrap **only** the value inside the quotes. Keep the trailing `.` in
  `fqdn=="{fqdn}."` OUTSIDE the call: `f'fqdn=="{_cspq(fqdn)}."'`.
- At 4548 the expression is `qp["type"].strip().upper()` — wrap the whole
  expression: `_cspq(qp["type"].strip().upper())`.
- Do NOT wrap `cidr=={int(cidr)}` or any `=={int(...)}` — leave numeric casts
  untouched.
- Leave literal clauses (`Status=="available"`) untouched.

**Verify**: the enumerate command should now show **zero** un-wrapped sites:
`python3 -c "import re;[print(i,l.strip()) for i,l in enumerate(open('server.py'),1) if re.search(r'==\"\{(?!_cspq)',l) and not l.strip().startswith('#')]"`
→ prints nothing (every `=="{` is immediately followed by `_cspq`).
Then `python3 -c "import ast; ast.parse(open('server.py').read())"` → exit 0.

### Step 3: Sanitize the two user-supplied field-NAME positions

Lines 845 and 4514 interpolate a **field name** (`tag_key` / `qp["tag_key"]`) to
the left of `==`, which is unquoted — escaping the value does not protect it.
Wrap the key with `_cspq_field`:

```python
# 845 — after
subnets = _rest_get("/api/ddi/v1/ipam/subnet",
                    {"_tfilter": f'{_cspq_field(tag_key)}=="{_cspq(tag_value)}"'})
# 4514 — after
rest_params["_tfilter"] = f'{_cspq_field(qp["tag_key"])}=="{_cspq(qp["tag_value"])}"'
```

**Verify**: `python3 -c "import ast; ast.parse(open('server.py').read())"` → exit 0.

### Step 4: Map `_cspq`/`_cspq_field` ValueError to HTTP 400 in SSE GET handlers

The SSE GET handlers catch only `except Exception -> 500`. Add a `ValueError`
arm **before** the generic `except` so a bad filter value returns 400, not 500,
in each handler that now calls `_cspq`:

- `/api/ipam/blocks` (generic except ≈4520)
- `/api/dns/zones` (≈4535)
- `/api/dns/records` (≈4557)
- `/api/ipam/addresses` (≈4573)
- `/api/ipam/subnets` (≈4619)

Pattern (insert immediately above each existing `except Exception as e:`):

```python
except ValueError as e:
    self._json({"error": str(e)}, 400)
```

For the JSON body / write path (`_selfservice_allocate`, line 845), the
surrounding caller already maps `ValueError` → 400 for other validation (see
lines 735, 780, 836). Confirm the `_cspq`/`_cspq_field` call at 845 is inside a
`try` whose `except (ValueError, ...)` returns 400; if it is **not** wrapped,
wrap just that lookup so a malformed `tag_key`/`tag_value` returns
`{"ok": False, "error": str(e)}, 400` rather than a 500. Do not restructure the
function beyond that.

**Verify**: `python3 -c "import ast; ast.parse(open('server.py').read())"` → exit 0.

### Step 5: Add the unit test

Create `test_cspq.py` (import the helpers from `server`). It must exercise the
injection payloads and the pass-through cases:

```python
from server import _cspq, _cspq_field
import pytest

def test_quote_is_escaped_not_passed_through():
    # a value trying to break out of its clause must be neutralized
    out = _cspq('acme" or space=="other')
    assert '"' not in out.replace('\\"', '')      # every " is backslash-escaped
    assert out == 'acme\\" or space==\\"other'

def test_backslash_escaped():
    assert _cspq('a\\b') == 'a\\\\b'

def test_ids_and_fqdns_pass_through():
    assert _cspq('ipam/subnet/abc-123') == 'ipam/subnet/abc-123'
    assert _cspq('host.example.com') == 'host.example.com'
    assert _cspq('US East 1') == 'US East 1'

def test_control_chars_rejected():
    with pytest.raises(ValueError):
        _cspq('a\nb')
    with pytest.raises(ValueError):
        _cspq('a\x00b')

def test_field_name_allowlist():
    assert _cspq_field('Site') == 'Site'
    with pytest.raises(ValueError):
        _cspq_field('Site" or "1')
    with pytest.raises(ValueError):
        _cspq_field('has space')
```

**Verify**: `python3 -m pytest test_cspq.py -q` → all pass. (If `pytest` isn't
available, run `python3 test_cspq.py` after adding an `if __name__ ...` runner,
or use `unittest`.)

## Test plan

- New file `test_cspq.py` covering: quote-injection payload is escaped;
  backslash is escaped; object IDs / FQDNs / spaced region names pass through
  unchanged; control chars raise `ValueError`; field-name allowlist accepts
  `Site` and rejects a `"`-injection and a space.
- Structural pattern: plain `pytest`/`unittest` — this repo's Python tests are
  script-style (`test_regression.py`); match whichever runner exists.
- Verification: `python3 -m pytest test_cspq.py -q` → all pass (6 cases).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `python3 -c "import ast; ast.parse(open('server.py').read())"` exits 0.
- [ ] `python3 -c "import re;print([i for i,l in enumerate(open('server.py'),1) if re.search(r'==\"\{(?!_cspq)',l) and not l.strip().startswith('#')])"` prints `[]` — no un-escaped `field=="{uservalue}"` remains.
- [ ] Both field-name sites use `_cspq_field`: `grep -n '_cspq_field' server.py` returns 2 matches (lines ~845, ~4514).
- [ ] `_cspq` appears at every value site: `grep -c '_cspq(' server.py` is ≥ the number of interpolated values (≥40).
- [ ] `test_cspq.py` exists and `python3 -m pytest test_cspq.py -q` passes (6 tests).
- [ ] `git status` shows only `server.py`, `test_cspq.py`, and `plans/README.md` modified.
- [ ] `plans/README.md` status row updated (if the index exists).

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match live code — `server.py` has drifted.
  Re-run the enumerate command; if the site set differs materially from the
  table, STOP.
- A value is **legitimately expected to contain a `"`** (e.g. a free-text
  description or comment being placed inside a filter clause). Escaping it is
  still correct, but if escaping breaks a real query, STOP and report rather
  than blanket-rejecting or removing the escape.
- Wrapping a site would require changing the mutation/write logic itself
  (out of scope) — STOP.
- A verification command fails twice after a reasonable fix attempt.
- You find a `_filter`/`_tfilter` build site NOT in the table (new code since
  `61b1e6e`) — apply the same `_cspq` treatment and note it in your report.

## Maintenance notes

- **Rule for future code:** any new `_filter`/`_tfilter` f-string MUST wrap
  every interpolated value with `_cspq(...)` and any user-supplied field name
  with `_cspq_field(...)`. Numeric fields keep the `int()` cast. Consider a
  lightweight CI grep (`==\"\{(?!_cspq)`) to catch regressions.
- A reviewer should scrutinize: that no `cidr`/numeric cast was accidentally
  wrapped; that trailing literals like the `.` in `fqdn=="{...}."` stayed
  outside `_cspq`; and that the SSE `ValueError` arms sit **before** the generic
  `except Exception`.
- Deferred (not in this plan): defense-in-depth allowlist validation of
  tag/site/region/environment values, and moving filter construction into a
  single query-builder. Escaping fully closes the injection; those are hygiene.
