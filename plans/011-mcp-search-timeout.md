# Plan 011: Add asyncio timeout to _mcp_search — unbounded MCP tool call can hang forever

> **Executor instructions**: Follow step by step. Run every verification.
> STOP condition → stop and report, do not improvise.
>
> **Drift check**: `git diff --stat 6f42354..HEAD -- server.py`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: reliability
- **Planned at**: commit `6f42354`, 2026-06-29

## Why this matters

`_mcp_search` calls `await session.call_tool(...)` with no timeout. If the MCP backend (Infoblox portal) is slow or unresponsive, the coroutine hangs indefinitely. This blocks the async task handling that request — in a ThreadedHTTPServer with a limited async event loop, a hung MCP call can starve all other async operations.

Fix: wrap the `session.call_tool` call with `asyncio.wait_for(..., timeout=10.0)`. On timeout, return `[]` (empty results) so the caller degrades gracefully.

## Current state

**File**: `server.py`

**Affected code at `server.py:994-1003`**:
```python
async def _mcp_search(session, query: str) -> list:
    query = (query or "")[:256]  # cap length of user-controlled filter
    result = await session.call_tool(
        "infoblox-portal_network_entity_search", {"query": query}
    )
    try:
        data = json.loads(_tool_text(result))
        return data if isinstance(data, list) else _results(data)
    except json.JSONDecodeError:
        return []
```

**Callers** (both already handle empty list gracefully):
- `server.py:1287` — `hits = await _mcp_search(session, args.get("query", ""))`
- `server.py:1556` — `hits = await _mcp_search(session, query)`

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Verify timeout | `grep -n "wait_for\|asyncio.wait_for" server.py` | 1 match inside `_mcp_search` |
| Compile check | `python3 -m py_compile server.py && echo OK` | `OK` |

## Scope

**In scope**: `server.py` — `_mcp_search` function only (lines 994-1003).

**Out of scope**: `index.html`, callers of `_mcp_search`, `_tool_text`, any other function.

## Git workflow

- Commit: `fix: add asyncio.wait_for timeout to _mcp_search — prevent hung MCP tool call`

## Steps

### Step 1: Wrap session.call_tool with asyncio.wait_for

Replace the `await session.call_tool(...)` block at `server.py:996-998`:
```python
    result = await session.call_tool(
        "infoblox-portal_network_entity_search", {"query": query}
    )
```

With:
```python
    try:
        result = await asyncio.wait_for(
            session.call_tool("infoblox-portal_network_entity_search", {"query": query}),
            timeout=10.0
        )
    except asyncio.TimeoutError:
        return []
```

`asyncio` is already imported at the top of `server.py` (confirm with `grep -n "^import asyncio" server.py`).

**Verify**: `grep -n "wait_for" server.py` → 1 match inside `_mcp_search`.

### Step 2: Compile check

```bash
python3 -m py_compile server.py && echo OK
```

Expected: `OK`.

## Done criteria

- [ ] `grep -n "asyncio.wait_for" server.py` → 1 match inside `_mcp_search`
- [ ] `grep -n "TimeoutError" server.py` → 1 match in the new except block
- [ ] `python3 -m py_compile server.py` exits 0
- [ ] Only `server.py` modified
- [ ] `plans/README.md` updated

## STOP conditions

- `asyncio` is NOT imported at the top of `server.py` — add `import asyncio` first if missing.
- Code at `server.py:994-1003` doesn't match excerpt (drift).
- `session.call_tool` returns a coroutine that is NOT directly awaitable (e.g. it already wraps a future with its own timeout) — stop and report.

## Maintenance notes

- 10 seconds is generous for a network search. If search latency is consistently fast (<1s), lower to 5.0.
- If `_mcp_search` is extended to call additional tools, each `call_tool` call needs its own `wait_for`.
