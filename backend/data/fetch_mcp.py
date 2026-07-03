"""MCP-native data fetch using iq-actions tools (inline responses, no parquet)."""
import asyncio
import json
import sys

from backend import mcp_client
from backend.cache import _cache_get, _cache_set


_PRIORITY_MAP = {"low": "ok", "medium": "warn", "high": "crit"}


async def fetch_incidents() -> list:
    """Fetch active incidents via iq-actions_list_actions. Returns normalized list."""
    ck = "mcp_incidents"
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    try:
        async with mcp_client._mcp_session() as session:
            r = await asyncio.wait_for(
                session.call_tool("iq-actions_list_actions", {}),
                timeout=30,
            )
            raw = mcp_client._tool_text(r)
            data = json.loads(raw)
        actions = data.get("actions", [])
        result = []
        for item in actions:
            normalized = dict(item)
            normalized["severity"] = _PRIORITY_MAP.get(
                str(item.get("priority", "")).lower(), item.get("priority", "")
            )
            result.append(normalized)
        _cache_set(ck, result)
        return result
    except Exception as e:
        print(f"  [warn] fetch_incidents: {e}", file=sys.stderr)
        return []


async def fetch_events(limit: int = 50, offset: int = 0) -> list:
    """Fetch anomaly events via iq-actions_get_events. Supports pagination."""
    ck = f"mcp_events|{limit}|{offset}"
    cached = _cache_get(ck)
    if cached is not None:
        return cached
    try:
        async with mcp_client._mcp_session() as session:
            r = await asyncio.wait_for(
                session.call_tool("iq-actions_get_events", {"limit": limit, "offset": offset}),
                timeout=30,
            )
            raw = mcp_client._tool_text(r)
            data = json.loads(raw)
        result = data.get("events", [])
        _cache_set(ck, result)
        return result
    except Exception as e:
        print(f"  [warn] fetch_events: {e}", file=sys.stderr)
        return []


async def fetch_incident_detail(incident_id: str) -> dict:
    """Fetch full incident detail via iq-actions_get_action."""
    try:
        async with mcp_client._mcp_session() as session:
            r = await asyncio.wait_for(
                session.call_tool("iq-actions_get_action", {"id": incident_id}),
                timeout=30,
            )
            raw = mcp_client._tool_text(r)
            return json.loads(raw)
    except Exception as e:
        print(f"  [warn] fetch_incident_detail({incident_id}): {e}", file=sys.stderr)
        return {}
