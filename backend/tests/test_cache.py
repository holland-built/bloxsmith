"""
Unit tests for backend/cache.py (in-memory TTL cache) plus a "caches-once"
integration test proving backend/mcp_client.py's `_mcp_get` actually serves
its second identical call from the cache instead of re-invoking the
underlying MCP session.

Every test clears the module-global `cache._cache` dict before running so
state never leaks between tests (the dict is process-global, not fixture-
scoped, unlike the vault tests' isolated_vault fixture).
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from backend import cache
from backend import mcp_client


@pytest.fixture(autouse=True)
def _clear_cache():
    cache._cache.clear()
    yield
    cache._cache.clear()


# ── basic get/set ───────────────────────────────────────────────────────

def test_set_then_get_within_ttl_returns_value():
    key = cache._cache_key("Svc", "/ep", {"a": 1}, False)
    cache._cache_set(key, ["row1", "row2"])
    assert cache._cache_get(key) == ["row1", "row2"]


def test_get_never_set_key_returns_none():
    key = cache._cache_key("Svc", "/never-set", {}, False)
    assert cache._cache_get(key) is None


# ── TTL expiry ──────────────────────────────────────────────────────────

def test_get_after_ttl_expiry_returns_none(monkeypatch):
    key = cache._cache_key("Svc", "/ep", {}, True)
    cache._cache_set(key, ["value"])
    # Push the stored timestamp back past CACHE_TTL (300s) so the entry
    # looks stale without needing to sleep in real time.
    stored_ts, stored_val = cache._cache[key]
    cache._cache[key] = (stored_ts - (cache.CACHE_TTL + 1), stored_val)
    assert cache._cache_get(key) is None


def test_get_just_before_ttl_expiry_still_returns_value():
    key = cache._cache_key("Svc", "/ep", {}, True)
    cache._cache_set(key, ["value"])
    stored_ts, stored_val = cache._cache[key]
    cache._cache[key] = (stored_ts - (cache.CACHE_TTL - 1), stored_val)
    assert cache._cache_get(key) == ["value"]


# ── cap / eviction ──────────────────────────────────────────────────────

def test_set_beyond_cache_max_evicts_oldest():
    for i in range(cache.CACHE_MAX + 50):
        key = cache._cache_key("Svc", f"/ep{i}", {}, False)
        cache._cache_set(key, [i])
        # Ensure strictly increasing timestamps so "oldest" ordering is
        # deterministic even when this loop runs faster than the clock's
        # resolution.
        ts, val = cache._cache[key]
        cache._cache[key] = (ts + i * 1e-6, val)

    assert len(cache._cache) <= cache.CACHE_MAX

    # The earliest-inserted keys should have been evicted; the most recent
    # ones should still be present.
    first_key = cache._cache_key("Svc", "/ep0", {}, False)
    last_key = cache._cache_key("Svc", f"/ep{cache.CACHE_MAX + 49}", {}, False)
    assert cache._cache_get(first_key) is None
    assert cache._cache_get(last_key) == [cache.CACHE_MAX + 49]


# ── invalidate ──────────────────────────────────────────────────────────

def test_cache_invalidate_clears_everything():
    for i in range(5):
        cache._cache_set(cache._cache_key("Svc", f"/ep{i}", {}, False), [i])
    assert len(cache._cache) == 5
    cache.cache_invalidate()
    assert cache._cache == {}


# ── caches-once: _mcp_get serves the second identical call from cache ───

def _make_mcp_response(table_name="ipamsvc_ipam_subnet_get.parquet", row_count=1):
    """Build the two call_tool responses `_mcp_get`/`_query_all_rows` expect.

    First call (infoblox-portal_make_get_request) returns metadata with a
    table_name matching `_TABLE_RE` and a positive row_count. Second call
    (infoblox-portal_query_stored_data) returns a columnar {columns, data}
    payload that `_columnar_to_dicts` turns into at least one row dict.
    """
    import json as _json

    class _Content:
        def __init__(self, text):
            self.text = text

    class _Result:
        def __init__(self, payload):
            self.content = [_Content(_json.dumps(payload))]

    meta_result = _Result({"table_name": table_name, "row_count": row_count})
    rows_result = _Result({"columns": ["id", "name"], "data": [[1, "subnet-a"]]})
    return meta_result, rows_result


def test_mcp_get_caches_second_identical_call():
    async def _run():
        meta_result, rows_result = _make_mcp_response()

        session = AsyncMock()
        # First call_tool invocation is the metadata fetch, second is the
        # paginated row fetch. A fresh single fetch makes exactly 2 calls.
        session.call_tool = AsyncMock(side_effect=[meta_result, rows_result])

        result1 = await mcp_client._mcp_get(session, "TestSvc", "/test", {}, fetch_all=True)
        assert result1 == [{"id": 1, "name": "subnet-a"}]
        calls_after_first = session.call_tool.call_count
        assert calls_after_first == 2

        result2 = await mcp_client._mcp_get(session, "TestSvc", "/test", {}, fetch_all=True)
        assert result2 == [{"id": 1, "name": "subnet-a"}]

        # The second identical call must be served entirely from cache — no
        # additional call_tool invocations.
        assert session.call_tool.call_count == calls_after_first

    asyncio.run(_run())
