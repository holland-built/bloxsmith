# Plan 002 — Extract `_run_async` helper (eliminate 10 asyncio.run wrappers)

**Written against commit:** a682fa7  
**Effort:** S  
**Risk:** Low — behavior-identical refactor  
**Category:** Shrink (boilerplate reduction)

---

## Why this matters

Every data-fetching endpoint in `server.py` follows this pattern:

```python
async def _fetch_actions_async() -> dict:
    async with _mcp_session() as session:
        ...

def fetch_actions() -> dict:
    return asyncio.run(_fetch_actions_async())
```

This doubles the function count (16 async + sync functions for 8 endpoints plus query/block/unblock). All sync wrappers are structurally identical. Extracting a one-line helper eliminates the wrappers entirely.

Confirmed pairs in server.py:
- `fetch_dashboard_data` / `_fetch_dashboard_async` — line 1197/1148
- `handle_query` / `_handle_query_async` — line 1459/1362
- `fetch_actions` / `_fetch_actions_async` — line 1479/1469
- `fetch_insights` / `_fetch_insights_async` — line 1502/1485
- `fetch_dns_analytics` / `_fetch_dns_analytics_async` — line 1531/1508
- `fetch_host_metrics` / `_fetch_host_metrics_async` — line 1548/1537
- `threat_lookup` / `_threat_lookup_async` — line 1558/1554
- `block_domain` / `_block_domain_async` — line 1581/1564
- `unblock_domain` / `_unblock_domain_async` — line 1599/1585
- `vault_llm_test` inner `asyncio.run(_run())` — line 825

---

## Scope

**In scope:** `server.py` only — the sync wrapper functions and their `asyncio.run()` call sites.  
**Out of scope:** The async functions themselves (`_fetch_*_async`, `_handle_query_async`, etc.) — do not touch their internals. Do not touch `index.html` or `test_regression.py`.

---

## Convention to follow

Existing helper style in `server.py` — module-level, single-underscore prefix:

```python
def _run_async(coro):
    return asyncio.run(coro)
```

Place this immediately after the import block (after line 14 where `asyncio` is imported in the `import asyncio, base64, ...` line).

---

## Steps

### Step 1 — Add the helper

Add after the import block (around line 14):

```python
def _run_async(coro):
    """Run a coroutine from a sync context; creates a fresh event loop per call."""
    return asyncio.run(coro)
```

### Step 2 — Replace 10 asyncio.run calls

Replace each `asyncio.run(...)` in the sync wrapper functions with `_run_async(...)`. The function signatures, docstrings, and surrounding logic stay unchanged.

Specific replacements:

**Line 1199** — `fetch_dashboard_data`:
```python
# before:  return asyncio.run(_fetch_dashboard_async())
# after:   return _run_async(_fetch_dashboard_async())
```

**Line 1461** — `handle_query`:
```python
# before:  raw = asyncio.run(_handle_query_async(question, trace, context))
# after:   raw = _run_async(_handle_query_async(question, trace, context))
```

**Line 1481** — `fetch_actions`:
```python
# before:  return asyncio.run(_fetch_actions_async())
# after:   return _run_async(_fetch_actions_async())
```

**Line 1504** — `fetch_insights`:
```python
# before:  return asyncio.run(_fetch_insights_async())
# after:   return _run_async(_fetch_insights_async())
```

**Line 1533** — `fetch_dns_analytics`:
```python
# before:  return asyncio.run(_fetch_dns_analytics_async())
# after:   return _run_async(_fetch_dns_analytics_async())
```

**Line 1550** — `fetch_host_metrics`:
```python
# before:  return asyncio.run(_fetch_host_metrics_async())
# after:   return _run_async(_fetch_host_metrics_async())
```

**Line 1560** — `threat_lookup`:
```python
# before:  return asyncio.run(_threat_lookup_async(query))
# after:   return _run_async(_threat_lookup_async(query))
```

**Line 1583** — `block_domain`:
```python
# before:  return asyncio.run(_block_domain_async(domain))
# after:   return _run_async(_block_domain_async(domain))
```

**Line 1601** — `unblock_domain`:
```python
# before:  return asyncio.run(_unblock_domain_async(domain))
# after:   return _run_async(_unblock_domain_async(domain))
```

**Line 825** — `vault_llm_test` inner `_run`:
```python
# before:  asyncio.run(_run()); return {"ok": True, "model": mdl}
# after:   _run_async(_run()); return {"ok": True, "model": mdl}
```

Do NOT replace the `asyncio.run` calls inside `_run_prepull` (the Docker pull background thread) — that is a different context and is not a sync wrapper.

### Step 3 — Verify

```bash
cd "/Users/sholland/AI/Infoblox MCP" && python3 -c "import server; print('ok')"
```
Expected: `ok`

```bash
cd "/Users/sholland/AI/Infoblox MCP" && python3 -m pytest test_regression.py -x -q 2>&1 | tail -5
```
Expected: same pass/fail result as before this change.

---

## Done criteria

- `grep -c "asyncio\.run(" server.py` returns a count ≤ 2 (only the helper definition line and any background-thread usage that was explicitly excluded).
- `python3 -c "import server"` exits 0.
- Regression tests pass.

---

## Escape hatch

If `test_regression.py` patches `asyncio.run` by name (e.g. `mock.patch("asyncio.run", ...)`), STOP and report — the mock target changes from `asyncio.run` to `server._run_async`. Check before committing:

```bash
grep "asyncio.run\|mock.*asyncio" test_regression.py
```

---

## Maintenance note

For any new endpoint added to `server.py`: call `_run_async(the_async_fn(...))` directly in the handler. Do not create a new sync wrapper function unless the wrapper adds logic beyond `asyncio.run`.
