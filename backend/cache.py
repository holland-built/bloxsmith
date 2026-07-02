"""In-memory TTL cache for MCP fetch results.

Ported verbatim from server.py's "Server-side TTL cache" section
(server.py:452-476). Zero imports from the backend package — this is a leaf
module with no dependencies, so both mcp_client.py (read/write) and vault.py
(invalidate) can import it without creating a circular import.
"""
import time

_cache: dict = {}
CACHE_TTL = 300  # seconds
CACHE_MAX = 256  # cap entries to bound memory


def _cache_key(service, endpoint, params, fetch_all):
    return f"{service}|{endpoint}|{str(sorted((params or {}).items()))}|{fetch_all}"


def _cache_get(key):
    entry = _cache.get(key)
    if entry and (time.time() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None


def _cache_set(key, value):
    # evict oldest entries when over the cap to bound memory growth
    if len(_cache) >= CACHE_MAX and key not in _cache:
        for _old in sorted(_cache, key=lambda k: _cache[k][0])[:len(_cache) - CACHE_MAX + 1]:
            _cache.pop(_old, None)
    _cache[key] = (time.time(), value)


def cache_invalidate():
    _cache.clear()
